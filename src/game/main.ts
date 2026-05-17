import "./game.css";

import { GameAudioController } from "./audio-controller";
import { SpotGameState } from "./game-state";
import { loadGameData } from "./level-loader";
import { LocalProgressStore } from "./progress-store";
import type { GameBanner, GameData, GameLevel, GameSide, GameStyle, SpotPoint } from "./types";

const REFERENCE_WIDTH = 1080;
const REFERENCE_HEIGHT = 1912;
const IMAGE_LOAD_TIMEOUT_MS = 15000;
const IMAGE_DECODE_TIMEOUT_MS = 2500;
const LEVELS_PER_PAGE = 10;
const LEVEL_PAGE_PRELOAD_TIMEOUT_MS = 1400;
const TIME_WARNING_SEC = 10;

type ModalMode = "clear" | "failed";
type BannerAdvance = () => void;

interface GameDom {
  root: HTMLElement;
  phone: HTMLElement;
  stage: HTMLElement;
  levelLabel: HTMLElement;
  prompt: HTMLElement;
  missionCount: HTMLElement;
  timerNumber: HTMLElement;
  timerColumn: HTMLElement;
  timerTrack: HTMLElement;
  bee: HTMLImageElement;
  mistakeCount: HTMLElement;
  leftPanel: HTMLElement;
  rightPanel: HTMLElement;
  leftImage: HTMLImageElement;
  rightImage: HTMLImageElement;
  leftMarkers: HTMLElement;
  rightMarkers: HTMLElement;
  leftFeedback: HTMLElement;
  rightFeedback: HTMLElement;
  celebrationLayer: HTMLElement;
  styleSelect: HTMLElement;
  styleGrid: HTMLElement;
  levelSelect: HTMLElement;
  levelGrid: HTMLElement;
  levelSelectStyleName: HTMLElement;
  backToStylesButton: HTMLButtonElement;
  levelPageLabel: HTMLElement;
  prevLevelPageButton: HTMLButtonElement;
  nextLevelPageButton: HTMLButtonElement;
  loadingOverlay: HTMLElement;
  bannerSlot: HTMLElement;
  modal: HTMLElement;
  modalTitle: HTMLElement;
  modalMessage: HTMLElement;
  primaryButton: HTMLButtonElement;
  secondaryButton: HTMLButtonElement;
}

function requireElement<T extends Element>(parent: ParentNode, selector: string): T {
  const element = parent.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing game element: ${selector}`);
  }

  return element;
}

function setGameScale(phone: HTMLElement): void {
  const scale = Math.min(
    window.innerWidth / REFERENCE_WIDTH,
    window.innerHeight / REFERENCE_HEIGHT,
    1,
  );
  phone.style.setProperty("--game-scale", String(scale));
}

function safeBannerUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url, window.location.href);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null;
    }

    return parsedUrl.href;
  } catch {
    return null;
  }
}

function setBannerColor(link: HTMLAnchorElement, name: string, value: string | undefined): void {
  if (value) {
    link.style.setProperty(name, value);
  }
}

function createBannerLink(banner: GameBanner, href: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "rolling-banner";
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer sponsored";
  link.setAttribute("aria-label", `${banner.title} 열기`);
  setBannerColor(link, "--banner-bg", banner.background);
  setBannerColor(link, "--banner-fg", banner.foreground);
  setBannerColor(link, "--banner-accent", banner.accent);

  if (banner.image && (banner.layout === "image" || (!banner.subtitle && !banner.disclosure))) {
    link.classList.add("rolling-banner-image-only");
    const image = document.createElement("img");
    image.className = "banner-image";
    image.src = banner.image;
    image.alt = banner.title;
    image.loading = "lazy";
    image.decoding = "async";
    link.append(image);
    return link;
  }

  if (banner.image) {
    const image = document.createElement("img");
    image.className = "banner-image";
    image.src = banner.image;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    link.append(image);
  } else {
    const emblem = document.createElement("span");
    emblem.className = "banner-emblem";
    emblem.textContent = "AD";
    link.append(emblem);
  }

  const copy = document.createElement("span");
  copy.className = "banner-copy";

  const title = document.createElement("strong");
  title.textContent = banner.title;
  copy.append(title);

  if (banner.subtitle) {
    const subtitle = document.createElement("span");
    subtitle.textContent = banner.subtitle;
    copy.append(subtitle);
  }

  link.append(copy);

  const action = document.createElement("span");
  action.className = "banner-action";
  action.textContent = "바로가기";
  link.append(action);

  if (banner.disclosure) {
    const disclosure = document.createElement("span");
    disclosure.className = "banner-disclosure";
    disclosure.textContent = banner.disclosure;
    link.append(disclosure);
  }

  return link;
}

function bindRollingBanners(dom: GameDom, banners: GameBanner[]): BannerAdvance {
  const activeBanners: Array<{ banner: GameBanner; href: string }> = [];
  for (const banner of banners) {
    const href = safeBannerUrl(banner.url);
    if (href) {
      activeBanners.push({ banner, href });
    }
  }

  if (!activeBanners.length) {
    dom.bannerSlot.hidden = true;
    dom.bannerSlot.setAttribute("aria-hidden", "true");
    return () => undefined;
  }

  let index = 0;
  const render = (): void => {
    const activeBanner = activeBanners[index];
    dom.bannerSlot.hidden = false;
    dom.bannerSlot.removeAttribute("aria-hidden");
    dom.bannerSlot.replaceChildren(createBannerLink(activeBanner.banner, activeBanner.href));
  };

  render();
  return () => {
    if (activeBanners.length <= 1) {
      return;
    }

    index = (index + 1) % activeBanners.length;
    render();
  };
}

function renderStyleSelectButtons(data: GameData): string {
  return data.styles
    .map((style, index) => `
      <button class="style-card" type="button" data-style-index="${index}" aria-label="${style.name} 선택">
        <img src="${style.coverImage}" alt="" loading="eager" decoding="async" />
        <span>${style.name}</span>
        <strong>${style.levels.length} levels</strong>
      </button>
    `)
    .join("");
}

function levelPageCount(style: GameStyle): number {
  return Math.max(1, Math.ceil(style.levels.length / LEVELS_PER_PAGE));
}

function clampLevelPage(style: GameStyle, pageIndex: number): number {
  return Math.max(0, Math.min(pageIndex, levelPageCount(style) - 1));
}

function levelsForPage(style: GameStyle, pageIndex: number): GameLevel[] {
  const startIndex = clampLevelPage(style, pageIndex) * LEVELS_PER_PAGE;
  return style.levels.slice(startIndex, startIndex + LEVELS_PER_PAGE);
}

function levelPageThumbnailSources(style: GameStyle, pageIndex: number): string[] {
  return levelsForPage(style, pageIndex).map((level) => level.thumbnailImage).filter(Boolean);
}

function renderLevelSelectButtons(style: GameStyle, pageIndex: number, progressStore: LocalProgressStore): string {
  const startIndex = clampLevelPage(style, pageIndex) * LEVELS_PER_PAGE;
  return style.levels
    .slice(startIndex, startIndex + LEVELS_PER_PAGE)
    .map((level, index) => {
      const levelIndex = startIndex + index;
      const isCleared = progressStore.isLevelCleared(style.id, level.level);
      const isUnlocked = progressStore.isLevelUnlocked(style, levelIndex);
      const classes = [
        "level-card",
        isCleared ? "level-card-cleared" : "",
        isUnlocked ? "" : "level-card-locked",
      ].filter(Boolean).join(" ");
      const statusLabel = isCleared ? "완료" : "잠김";
      const statusBadge = isCleared || !isUnlocked
        ? `<strong class="level-status-badge">${statusLabel}</strong>`
        : "";
      const disabledAttribute = isUnlocked ? "" : " disabled";
      const ariaLabel = isUnlocked
        ? `level ${level.level} 선택`
        : `level ${level.level} 잠김`;

      return `
        <button class="${classes}" type="button" data-level-index="${levelIndex}" aria-label="${ariaLabel}"${disabledAttribute}>
          <img src="${level.thumbnailImage}" alt="" loading="eager" decoding="async" />
          <span>level ${level.level}</span>
          ${statusBadge}
        </button>
      `;
    })
    .join("");
}

function createGameMarkup(root: HTMLElement, data: GameData): GameDom {
  root.innerHTML = `
    <div class="game-viewport">
      <div class="game-phone">
        <section class="game-stage" aria-label="꿀버리 다른그림찾기">
          <button class="exit-button" type="button">나가기</button>
          <div class="level-pill" id="level-label">level 1</div>
          <img class="brand-logo" src="${data.logoImage}" alt="꿀버리 다른그림찾기" />
          <h1 class="game-prompt" id="game-prompt">다른곳 3곳을 찾아보세요</h1>
          <div class="mission-card" aria-label="미션 개수">
            <span>mission</span>
            <strong id="mission-count">3</strong>
          </div>

          <div class="spot-panel spot-panel-top" data-side="left">
            <img id="left-image" alt="위쪽 그림" draggable="false" />
            <div id="left-markers" class="marker-layer"></div>
            <div id="left-feedback" class="feedback-layer"></div>
          </div>

          <div class="spot-panel spot-panel-bottom" data-side="right">
            <img id="right-image" alt="아래쪽 그림" draggable="false" />
            <div id="right-markers" class="marker-layer"></div>
            <div id="right-feedback" class="feedback-layer"></div>
          </div>

          <div class="timer-column">
            <div id="timer-number" class="timer-number">90</div>
            <img class="hive-image" src="${data.hiveImage}" alt="" />
            <div class="timer-track">
              <div class="timer-line" aria-hidden="true"></div>
              <img id="bee-image" class="bee-image" src="${data.beeImage}" alt="" />
            </div>
          </div>

          <div class="mistake-card" aria-live="polite">
            <span>남은기회</span>
            <strong id="mistake-count">10</strong>
          </div>

          <div id="celebration-layer" class="celebration-layer" hidden aria-hidden="true"></div>
        </section>

        <section id="style-select" class="style-select-screen" hidden aria-label="스타일 선택">
          <img class="style-select-logo" src="${data.logoImage}" alt="꿀버리 다른그림찾기" />
          <h1 class="style-select-title">스타일 선택</h1>
          <div id="style-grid" class="style-grid">
            ${renderStyleSelectButtons(data)}
          </div>
        </section>

        <section id="level-select" class="level-select-screen" hidden aria-label="레벨 선택">
          <img class="level-select-logo" src="${data.logoImage}" alt="꿀버리 다른그림찾기" />
          <button id="back-to-styles" class="style-back-button" type="button">스타일</button>
          <h1 class="level-select-title">레벨 선택</h1>
          <div id="level-select-style-name" class="level-select-style-name"></div>
          <div id="level-grid" class="level-grid">
          </div>
          <div class="level-pagination" aria-label="레벨 페이지">
            <button id="prev-level-page" class="level-page-button" type="button">이전</button>
            <span id="level-page-label">1 / 1</span>
            <button id="next-level-page" class="level-page-button" type="button">다음</button>
          </div>
        </section>

        <div id="level-loading" class="level-loading" hidden>
          <div>이미지를 불러오는 중...</div>
        </div>

        <aside class="banner-slot" aria-label="광고 배너"></aside>

        <div id="game-modal" class="game-modal" hidden>
          <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <h2 id="modal-title" class="modal-title">CLEAR!</h2>
            <p id="modal-message" class="modal-message"></p>
            <div class="modal-actions">
              <button id="modal-secondary" class="modal-button" type="button">다시하기</button>
              <button id="modal-primary" class="modal-button modal-button-primary" type="button">다음 단계</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const phone = requireElement<HTMLElement>(root, ".game-phone");
  const dom: GameDom = {
    root,
    phone,
    stage: requireElement(root, ".game-stage"),
    levelLabel: requireElement(root, "#level-label"),
    prompt: requireElement(root, "#game-prompt"),
    missionCount: requireElement(root, "#mission-count"),
    timerNumber: requireElement(root, "#timer-number"),
    timerColumn: requireElement(root, ".timer-column"),
    timerTrack: requireElement(root, ".timer-track"),
    bee: requireElement(root, "#bee-image"),
    mistakeCount: requireElement(root, "#mistake-count"),
    leftPanel: requireElement(root, ".spot-panel-top"),
    rightPanel: requireElement(root, ".spot-panel-bottom"),
    leftImage: requireElement(root, "#left-image"),
    rightImage: requireElement(root, "#right-image"),
    leftMarkers: requireElement(root, "#left-markers"),
    rightMarkers: requireElement(root, "#right-markers"),
    leftFeedback: requireElement(root, "#left-feedback"),
    rightFeedback: requireElement(root, "#right-feedback"),
    celebrationLayer: requireElement(root, "#celebration-layer"),
    styleSelect: requireElement(root, "#style-select"),
    styleGrid: requireElement(root, "#style-grid"),
    levelSelect: requireElement(root, "#level-select"),
    levelGrid: requireElement(root, "#level-grid"),
    levelSelectStyleName: requireElement(root, "#level-select-style-name"),
    backToStylesButton: requireElement(root, "#back-to-styles"),
    levelPageLabel: requireElement(root, "#level-page-label"),
    prevLevelPageButton: requireElement(root, "#prev-level-page"),
    nextLevelPageButton: requireElement(root, "#next-level-page"),
    loadingOverlay: requireElement(root, "#level-loading"),
    bannerSlot: requireElement(root, ".banner-slot"),
    modal: requireElement(root, "#game-modal"),
    modalTitle: requireElement(root, "#modal-title"),
    modalMessage: requireElement(root, "#modal-message"),
    primaryButton: requireElement(root, "#modal-primary"),
    secondaryButton: requireElement(root, "#modal-secondary"),
  };

  setGameScale(phone);
  window.addEventListener("resize", () => setGameScale(phone));

  return dom;
}

function markerSizePercent(spot: SpotPoint): string {
  return `${Math.max(12, Math.min(18, spot.radius * 180))}%`;
}

function createMarker(spot: SpotPoint): HTMLElement {
  const marker = document.createElement("div");
  marker.className = "spot-marker";
  marker.textContent = "✓";
  marker.style.left = `${spot.cx * 100}%`;
  marker.style.top = `${spot.cy * 100}%`;
  marker.style.setProperty("--marker-size", markerSizePercent(spot));
  return marker;
}

function renderMarkers(dom: GameDom, level: GameLevel, foundIds: Set<string>): void {
  dom.leftMarkers.innerHTML = "";
  dom.rightMarkers.innerHTML = "";

  for (const spot of level.spots) {
    if (!foundIds.has(spot.id)) {
      continue;
    }

    dom.leftMarkers.append(createMarker(spot));
    dom.rightMarkers.append(createMarker(spot));
  }
}

function showMiss(feedbackLayer: HTMLElement, xPercent: number, yPercent: number): void {
  const mark = document.createElement("div");
  mark.className = "miss-mark";
  mark.textContent = "x";
  mark.style.left = `${xPercent * 100}%`;
  mark.style.top = `${yPercent * 100}%`;
  feedbackLayer.append(mark);
  window.setTimeout(() => mark.remove(), 700);
}

function renderLevel(dom: GameDom, data: GameData, state: SpotGameState): void {
  const level = state.currentLevel;
  dom.levelLabel.textContent = `level ${level.level}`;
  dom.prompt.textContent = `다른곳 ${level.spots.length}곳을 찾아보세요`;
  dom.leftImage.src = level.leftImage;
  dom.rightImage.src = level.rightImage;
  dom.leftFeedback.innerHTML = "";
  dom.rightFeedback.innerHTML = "";
  renderMarkers(dom, level, state.foundIds);
}

function renderHud(dom: GameDom, state: SpotGameState): void {
  const level = state.currentLevel;
  const timeLimit = Math.max(1, level.timeLimitSec);
  const remainingRatio = Math.max(0, Math.min(1, state.remainingTimeSec / timeLimit));
  const remainingMissionCount = Math.max(0, level.spots.length - state.foundCount);
  dom.missionCount.textContent = String(remainingMissionCount);
  dom.timerNumber.textContent = String(Math.ceil(state.remainingTimeSec));
  dom.timerTrack.style.setProperty("--timer-progress", `${remainingRatio * 100}%`);
  dom.bee.style.top = `${remainingRatio * 100}%`;
  dom.timerColumn.classList.toggle(
    "timer-warning",
    state.gameStatus === "playing" && state.remainingTimeSec > 0 && state.remainingTimeSec <= TIME_WARNING_SEC,
  );
  dom.mistakeCount.textContent = String(state.remainingMistakes);
}

function clearCelebration(dom: GameDom): void {
  dom.celebrationLayer.hidden = true;
  dom.celebrationLayer.innerHTML = "";
}

function showClearCelebration(dom: GameDom): number {
  const colors = ["#ffb900", "#ffffff", "#00d8c8", "#ff7a45", "#ffe66d"];
  dom.celebrationLayer.innerHTML = "";
  dom.celebrationLayer.hidden = false;

  for (let index = 0; index < 58; index += 1) {
    const particle = document.createElement("span");
    const angle = Math.random() * Math.PI * 2;
    const distance = 210 + Math.random() * 440;
    const size = 10 + Math.random() * 20;
    const x = 50 + (Math.random() - 0.5) * 26;
    const y = 48 + (Math.random() - 0.5) * 18;

    particle.className = "celebration-particle";
    particle.style.left = `${x}%`;
    particle.style.top = `${y}%`;
    particle.style.width = `${size}px`;
    particle.style.height = `${Math.max(10, size * 0.56)}px`;
    particle.style.background = colors[index % colors.length];
    particle.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
    particle.style.setProperty("--dy", `${Math.sin(angle) * distance + 90}px`);
    particle.style.setProperty("--spin", `${Math.round(Math.random() * 760 - 380)}deg`);
    particle.style.setProperty("--delay", `${Math.random() * 120}ms`);
    dom.celebrationLayer.append(particle);
  }

  return window.setTimeout(() => clearCelebration(dom), 1600);
}

function preloadImage(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let isSettled = false;
    let loadTimerId: number | undefined;

    const settle = (callback: () => void): void => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      if (loadTimerId !== undefined) {
        window.clearTimeout(loadTimerId);
      }

      callback();
    };

    image.decoding = "async";
    image.onload = () => {
      const decode = image.decode?.();
      if (decode) {
        const decodeTimeout = new Promise<void>((timeoutResolve) => {
          window.setTimeout(timeoutResolve, IMAGE_DECODE_TIMEOUT_MS);
        });
        Promise.race([decode, decodeTimeout])
          .then(() => settle(resolve))
          .catch(() => settle(resolve));
        return;
      }

      settle(resolve);
    };
    image.onerror = () => settle(() => reject(new Error(`Image load failed: ${src}`)));
    loadTimerId = window.setTimeout(() => {
      settle(() => reject(new Error(`Image load timed out: ${src}`)));
    }, IMAGE_LOAD_TIMEOUT_MS);
    image.src = src;
  });
}

function createLevelImagePreloader(): (level: GameLevel) => Promise<void> {
  const cache = new Map<string, Promise<void>>();

  const preloadCached = (src: string): Promise<void> => {
    const cached = cache.get(src);
    if (cached) {
      return cached;
    }

    const load = preloadImage(src);
    cache.set(src, load);
    return load;
  };

  return async (level: GameLevel): Promise<void> => {
    await Promise.all([
      preloadCached(level.leftImage),
      preloadCached(level.rightImage),
    ]);
  };
}

function createImageListPreloader(): (sources: string[]) => Promise<void> {
  const cache = new Map<string, Promise<void>>();

  const preloadCached = (src: string): Promise<void> => {
    const cached = cache.get(src);
    if (cached) {
      return cached;
    }

    const load = preloadImage(src);
    cache.set(src, load);
    return load;
  };

  return async (sources: string[]): Promise<void> => {
    await Promise.all(sources.map(preloadCached));
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function createBeeAnimator(dom: GameDom, data: GameData): (nowMs: number) => void {
  const frames = data.beeFrames.length ? data.beeFrames : [data.beeImage];
  let currentFrameIndex = -1;

  return (nowMs: number): void => {
    const frameIndex = Math.floor(nowMs / 110) % frames.length;
    if (frameIndex === currentFrameIndex) {
      return;
    }

    currentFrameIndex = frameIndex;
    dom.bee.src = frames[frameIndex];
  };
}

function panelPoint(event: PointerEvent, panel: HTMLElement): { cx: number; cy: number } {
  const rect = panel.getBoundingClientRect();
  return {
    cx: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    cy: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  };
}

function hideModal(dom: GameDom): void {
  dom.modal.hidden = true;
}

function showLevelLoading(dom: GameDom): void {
  dom.loadingOverlay.hidden = false;
}

function hideLevelLoading(dom: GameDom): void {
  dom.loadingOverlay.hidden = true;
}

function hideLevelSelect(dom: GameDom): void {
  dom.levelSelect.hidden = true;
}

function hideStyleSelect(dom: GameDom): void {
  dom.styleSelect.hidden = true;
}

function renderLevelSelect(dom: GameDom, style: GameStyle, pageIndex: number, progressStore: LocalProgressStore): void {
  const clampedPage = clampLevelPage(style, pageIndex);
  const totalPages = levelPageCount(style);
  dom.levelSelectStyleName.textContent = style.name;
  dom.levelGrid.innerHTML = renderLevelSelectButtons(style, clampedPage, progressStore);
  dom.levelPageLabel.textContent = `${clampedPage + 1} / ${totalPages}`;
  dom.prevLevelPageButton.disabled = clampedPage <= 0;
  dom.nextLevelPageButton.disabled = clampedPage >= totalPages - 1;
}

function showStyleSelect(dom: GameDom): void {
  hideModal(dom);
  hideLevelSelect(dom);
  dom.styleSelect.hidden = false;
}

function showLevelSelect(dom: GameDom, style: GameStyle, pageIndex: number, progressStore: LocalProgressStore): void {
  hideModal(dom);
  hideStyleSelect(dom);
  renderLevelSelect(dom, style, pageIndex, progressStore);
  dom.levelSelect.hidden = false;
}

function showModal(dom: GameDom, state: SpotGameState, mode: ModalMode): void {
  if (mode === "clear") {
    dom.modalTitle.textContent = state.isLastLevel ? "ALL CLEAR!" : "CLEAR!";
    dom.modalMessage.textContent = state.isLastLevel
      ? "모든 레벨을 클리어했어요"
      : `level ${state.currentLevel.level} 클리어`;
    dom.primaryButton.textContent = state.isLastLevel ? "처음부터" : "다음 단계";
    dom.secondaryButton.textContent = "다시하기";
  }

  if (mode === "failed") {
    dom.modalTitle.textContent = "FAIL";
    dom.modalMessage.textContent = state.remainingMistakes <= 0 ? "남은기회를 모두 썼어요" : "시간이 끝났어요";
    dom.primaryButton.textContent = "다시하기";
    dom.secondaryButton.textContent = "처음으로";
  }

  dom.modal.dataset.mode = mode;
  dom.modal.hidden = false;
}

function flashStage(dom: GameDom): void {
  dom.stage.classList.remove("stage-flash");
  void dom.stage.offsetWidth;
  dom.stage.classList.add("stage-flash");
}

function bindGame(dom: GameDom, data: GameData, state: SpotGameState): void {
  const advanceBanner = bindRollingBanners(dom, data.banners);

  const audio = new GameAudioController(data.successSound, data.failSound, data.bgmTracks);
  const progressStore = new LocalProgressStore();
  const updateBeeAnimation = createBeeAnimator(dom, data);
  const preloadLevelImages = createLevelImagePreloader();
  const preloadImages = createImageListPreloader();
  let levelLoadId = 0;
  let levelPageLoadId = 0;
  let currentLevelPage = 0;
  const updateAll = (): void => {
    renderLevel(dom, data, state);
    renderHud(dom, state);
  };
  let clearModalTimerId: number | undefined;
  let celebrationClearTimerId: number | undefined;

  const cancelClearSequence = (): void => {
    if (clearModalTimerId !== undefined) {
      window.clearTimeout(clearModalTimerId);
      clearModalTimerId = undefined;
    }

    if (celebrationClearTimerId !== undefined) {
      window.clearTimeout(celebrationClearTimerId);
      celebrationClearTimerId = undefined;
    }

    clearCelebration(dom);
  };

  const showClearAfterCelebration = (): void => {
    cancelClearSequence();
    audio.stopBgm();
    audio.playFanfare();
    celebrationClearTimerId = showClearCelebration(dom);
    clearModalTimerId = window.setTimeout(() => {
      clearModalTimerId = undefined;
      celebrationClearTimerId = undefined;
      clearCelebration(dom);
      showModal(dom, state, "clear");
    }, 1450);
  };

  const preloadLevelPage = async (style: GameStyle, pageIndex: number): Promise<void> => {
    const sources = levelPageThumbnailSources(style, pageIndex);
    if (!sources.length) {
      return;
    }

    await Promise.race([
      preloadImages(sources),
      delay(LEVEL_PAGE_PRELOAD_TIMEOUT_MS),
    ]).catch((error: unknown) => {
      console.warn(error instanceof Error ? error.message : "Level page thumbnail preload failed.");
    });
  };

  const preloadNearLevelPages = (style: GameStyle, pageIndex: number): void => {
    const totalPages = levelPageCount(style);
    if (pageIndex + 1 < totalPages) {
      void preloadLevelPage(style, pageIndex + 1);
    }
    if (pageIndex > 0) {
      void preloadLevelPage(style, pageIndex - 1);
    }
  };

  const openLevelSelectPage = async (style: GameStyle, pageIndex: number, showLoading: boolean): Promise<void> => {
    const clampedPage = clampLevelPage(style, pageIndex);
    const loadId = ++levelPageLoadId;
    if (showLoading) {
      showLevelLoading(dom);
    }

    try {
      await preloadLevelPage(style, clampedPage);
      if (loadId !== levelPageLoadId) {
        return;
      }

      currentLevelPage = clampedPage;
      showLevelSelect(dom, style, currentLevelPage, progressStore);
      advanceBanner();
      preloadNearLevelPages(style, currentLevelPage);
    } finally {
      if (showLoading && loadId === levelPageLoadId) {
        hideLevelLoading(dom);
      }
    }
  };

  const startLevelAfterImagesReady = async (levelIndex: number): Promise<void> => {
    const level = state.currentStyle.levels[levelIndex];
    if (!level) {
      return;
    }

    const loadId = ++levelLoadId;
    cancelClearSequence();
    showLevelLoading(dom);
    void audio.startLevel(level);

    try {
      await preloadLevelImages(level).catch((error: unknown) => {
        console.warn(error instanceof Error ? error.message : "Level image preload failed.");
      });
      if (loadId !== levelLoadId) {
        return;
      }

      state.startLevel(levelIndex);
      hideModal(dom);
      hideStyleSelect(dom);
      hideLevelSelect(dom);
      updateAll();
      advanceBanner();
    } finally {
      if (loadId === levelLoadId) {
        hideLevelLoading(dom);
      }
    }
  };

  const handleGuess = (event: PointerEvent, side: GameSide, panel: HTMLElement, feedback: HTMLElement): void => {
    const point = panelPoint(event, panel);
    const result = state.guess(side, point.cx, point.cy);

    if (result.kind === "correct") {
      audio.playSuccess();
      renderMarkers(dom, state.currentLevel, state.foundIds);
      renderHud(dom, state);
      if (state.gameStatus === "clear") {
        progressStore.markLevelCleared(state.currentStyle.id, state.currentLevel.level);
        showClearAfterCelebration();
      }
      return;
    }

    if (result.kind === "wrong") {
      audio.playFail();
      showMiss(feedback, point.cx, point.cy);
      flashStage(dom);
      renderHud(dom, state);
      if (state.gameStatus === "failed") {
        audio.stopBgm();
        showModal(dom, state, "failed");
      }
    }
  };

  dom.leftPanel.addEventListener("pointerdown", (event) => {
    handleGuess(event, "left", dom.leftPanel, dom.leftFeedback);
  });

  dom.rightPanel.addEventListener("pointerdown", (event) => {
    handleGuess(event, "right", dom.rightPanel, dom.rightFeedback);
  });

  requireElement<HTMLButtonElement>(dom.root, ".exit-button").addEventListener("click", () => {
    cancelClearSequence();
    state.pause();
    audio.stopBgm();
    currentLevelPage = Math.floor(state.currentLevelIndex / LEVELS_PER_PAGE);
    void openLevelSelectPage(state.currentStyle, currentLevelPage, false);
  });

  dom.styleGrid.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(".style-card");
    if (!button) {
      return;
    }

    const styleIndex = Number(button.dataset.styleIndex);
    if (!Number.isInteger(styleIndex)) {
      return;
    }

    state.selectStyle(styleIndex);
    state.pause();
    currentLevelPage = 0;
    void openLevelSelectPage(state.currentStyle, currentLevelPage, true);
  });

  dom.backToStylesButton.addEventListener("click", () => {
    cancelClearSequence();
    state.pause();
    audio.stopBgm();
    showStyleSelect(dom);
    advanceBanner();
  });

  dom.prevLevelPageButton.addEventListener("click", () => {
    void openLevelSelectPage(state.currentStyle, currentLevelPage - 1, true);
  });

  dom.nextLevelPageButton.addEventListener("click", () => {
    void openLevelSelectPage(state.currentStyle, currentLevelPage + 1, true);
  });

  dom.levelGrid.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(".level-card");
    if (!button) {
      return;
    }

    const levelIndex = Number(button.dataset.levelIndex);
    if (!Number.isInteger(levelIndex)) {
      return;
    }

    if (!progressStore.isLevelUnlocked(state.currentStyle, levelIndex)) {
      return;
    }

    void startLevelAfterImagesReady(levelIndex);
  });

  dom.primaryButton.addEventListener("click", () => {
    const mode = dom.modal.dataset.mode as ModalMode | undefined;
    cancelClearSequence();

    if (mode === "clear") {
      const nextLevelIndex = state.isLastLevel ? 0 : state.currentLevelIndex + 1;
      void startLevelAfterImagesReady(nextLevelIndex);
      return;
    }

    if (mode === "failed") {
      void startLevelAfterImagesReady(state.currentLevelIndex);
      return;
    }

    void startLevelAfterImagesReady(0);
  });

  dom.secondaryButton.addEventListener("click", () => {
    const mode = dom.modal.dataset.mode as ModalMode | undefined;
    cancelClearSequence();
    hideModal(dom);

    if (mode === "failed") {
      state.pause();
      audio.stopBgm();
      currentLevelPage = Math.floor(state.currentLevelIndex / LEVELS_PER_PAGE);
      void openLevelSelectPage(state.currentStyle, currentLevelPage, false);
      return;
    }

    state.restartLevel();
    updateAll();
  });

  let lastTick = performance.now();
  const tick = (now: number): void => {
    const deltaSec = (now - lastTick) / 1000;
    lastTick = now;
    const beforeStatus = state.gameStatus;
    state.tick(deltaSec);
    renderHud(dom, state);
    updateBeeAnimation(now);

    if (beforeStatus === "playing" && state.gameStatus === "failed") {
      audio.stopBgm();
      showModal(dom, state, "failed");
    }

    requestAnimationFrame(tick);
  };

  state.pause();
  renderHud(dom, state);
  showStyleSelect(dom);
  requestAnimationFrame(tick);
}

function renderLoading(root: HTMLElement): HTMLElement {
  root.innerHTML = `
    <div class="game-viewport">
      <div class="game-phone">
        <div class="loading-state">게임을 불러오는 중...</div>
      </div>
    </div>
  `;
  const phone = requireElement<HTMLElement>(root, ".game-phone");
  setGameScale(phone);
  window.addEventListener("resize", () => setGameScale(phone));
  return phone;
}

function renderError(root: HTMLElement, message: string): void {
  root.innerHTML = `
    <div class="game-viewport">
      <div class="game-phone">
        <div class="loading-state">${message}</div>
      </div>
    </div>
  `;
  const phone = requireElement<HTMLElement>(root, ".game-phone");
  setGameScale(phone);
}

async function bootstrap(): Promise<void> {
  const root = document.querySelector<HTMLElement>("#game-root");
  if (!root) {
    throw new Error("Game root not found.");
  }

  renderLoading(root);

  try {
    const data = await loadGameData();
    if (!data.styles.some((style) => style.levels.length > 0)) {
      throw new Error("No playable levels were found.");
    }

    const dom = createGameMarkup(root, data);
    const state = new SpotGameState(data);
    bindGame(dom, data, state);
  } catch (error) {
    renderError(root, error instanceof Error ? error.message : "게임을 불러오지 못했어요");
  }
}

void bootstrap();
