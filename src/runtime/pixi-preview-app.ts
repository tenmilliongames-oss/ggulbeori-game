import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  Texture,
} from "pixi.js";

import type { ProjectModel, ResolvedMarker, ResolvedScene } from "./project-types";
import { getMarkerRevealTimes, getOrderedAnswerMarkers } from "./marker-reveal-timing";
import { resolveProjectResource } from "./resource-path";
import { BOOK_TRANSITION_COVER_SEC, BOOK_TRANSITION_TOTAL_SEC } from "./scene-flow-policy";

type PromptAnimationState =
  | {
      kind: "step";
      target: Container;
    }
  | {
      kind: "timeout";
      target: Sprite;
    };

interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MarkerDisplayEntry {
  marker: ResolvedMarker;
  revealAtSec: number;
  display: Sprite | Graphics;
  particles: Graphics[];
  revealed: boolean;
  playSoundOnReveal: boolean;
  hiddenScale: number;
}

type HudTimerConfig =
  | {
      orientation: "horizontal";
      startX: number;
      endX: number;
      beeY: number;
      trackY: number;
      durationSec: number;
    }
  | {
      orientation: "vertical";
      startY: number;
      endY: number;
      beeX: number;
      trackX: number;
      durationSec: number;
    };

const STEP_PROMPT_SCALE_FACTOR = 0.5;
const TIMEOUT_PROMPT_SCALE_FACTOR = 0.5;
const MARKER_INTRO_SEC = 0.24;
const MARKER_FADE_SEC = 0.16;

interface PixiPreviewInitOptions {
  resolution?: number;
}

export interface BookTransitionOverlay {
  overlay: Container;
  pageMask: Graphics;
  pageFill: Graphics;
  pageShadow: Graphics;
  pageEdge: Graphics;
  pageBack: Graphics;
  pageSprite: Sprite | null;
}

export type PreviewSceneTransition = "none" | "book";

export interface PreviewSceneRenderer {
  loadProject(project: ProjectModel): Promise<void>;
  getCurrentSceneDuration(): number;
  getCanvas(): HTMLCanvasElement;
  getProjectSize(): { width: number; height: number } | null;
  resize(width: number, height: number): void;
  renderNow(): void;
  prepareFrame(timeSec: number): Promise<void>;
  getPreferredSceneDuration(fallbackDurationSec: number): number;
  setPlaying(nextPlaying: boolean): void;
  setScene(scene: ResolvedScene, options?: { transition?: PreviewSceneTransition }): Promise<void>;
  createBookTransitionOverlay(): Promise<BookTransitionOverlay | null>;
  drawBookTransitionOverlay(
    transition: BookTransitionOverlay,
    progress: number,
    direction: "cover" | "reveal",
  ): void;
  clearBookTransitionOverlay(transition?: BookTransitionOverlay | null): void;
  renderAt(timeSec: number): void;
}

function containRect(targetWidth: number, targetHeight: number, sourceWidth: number, sourceHeight: number): DisplayRect {
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;

  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
}

function coverRect(targetWidth: number, targetHeight: number, sourceWidth: number, sourceHeight: number): DisplayRect {
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;

  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
}

function hexColor(color: string, fallback: number): number {
  const normalized = color.trim();
  if (/^#?[0-9a-f]{6}$/i.test(normalized)) {
    return Number.parseInt(normalized.replace("#", ""), 16);
  }

  return fallback;
}

export class PixiPreviewApp implements PreviewSceneRenderer {
  private readonly container: HTMLElement;
  private readonly app = new Application();
  private readonly root = new Container();
  private readonly transitionLayer = new Container();
  private sceneLayer: Container = this.root;
  private project: ProjectModel | null = null;
  private currentScene: ResolvedScene | null = null;
  private currentTimeSec = 0;
  private countdownBadge: Container | Sprite | null = null;
  private countdownNumber: Text | null = null;
  private hudBee: Sprite | null = null;
  private hudBeeFrames: Texture[] = [];
  private hudHive: Sprite | null = null;
  private hudTrackRemaining: Graphics | null = null;
  private hudTimerConfig: HudTimerConfig | null = null;
  private markerDisplays: MarkerDisplayEntry[] = [];
  private sceneVideos: HTMLVideoElement[] = [];
  private playing = false;
  private sceneVideoDurationSec: number | null = null;
  private backgroundVideoAudioEnabled = false;
  private bookPageAudio: HTMLAudioElement | null = null;
  private markerRevealAudio: HTMLAudioElement | null = null;
  private activeMarkerRevealAudios: HTMLAudioElement[] = [];
  private promptAnimation: PromptAnimationState | null = null;
  private sceneVideoSeekPending = false;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async init(width: number, height: number, options: PixiPreviewInitOptions = {}): Promise<void> {
    const resolution = Math.max(1, options.resolution ?? window.devicePixelRatio ?? 1);
    await this.app.init({
      width,
      height,
      antialias: true,
      background: "#091220",
      autoDensity: true,
      resolution,
    });

    this.container.replaceChildren(this.app.canvas);
    this.app.stage.addChild(this.root);
    this.app.stage.addChild(this.transitionLayer);
  }

  async loadProject(project: ProjectModel): Promise<void> {
    this.project = project;
    this.root.removeChildren();
    this.transitionLayer.removeChildren();
    this.sceneLayer = this.root;
    this.currentScene = null;
    this.currentTimeSec = 0;
    this.sceneVideoDurationSec = null;
    this.backgroundVideoAudioEnabled = false;
    this.markerDisplays = [];
    this.disposeSceneVideos();
    this.prepareProjectCueAudio();
    this.disposeMarkerRevealAudio();
    this.promptAnimation = null;
  }

  getCurrentSceneDuration(): number {
    return this.currentScene?.durationSec ?? 0;
  }

  getCanvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  getProjectSize(): { width: number; height: number } | null {
    if (!this.project) {
      return null;
    }

    return {
      width: this.app.canvas.width,
      height: this.app.canvas.height,
    };
  }

  resize(width: number, height: number): void {
    this.app.renderer.resize(width, height);
    if (this.project) {
      this.project = {
        ...this.project,
        width,
        height,
      };
    }
  }

  renderNow(): void {
    this.app.renderer.render({ container: this.app.stage, clear: true });
  }

  async prepareFrame(timeSec: number): Promise<void> {
    this.renderAt(timeSec);
    if (this.sceneVideoSeekPending) {
      await this.settleSceneVideos();
      this.renderAt(timeSec);
    }
    this.renderNow();
  }

  getPreferredSceneDuration(fallbackDurationSec: number): number {
    const shouldUseBackgroundVideoDuration =
      this.currentScene?.sceneType === "title_card" ||
      (this.currentScene?.sceneType === "timeout_card" && this.currentScene.audio.length === 0);

    if (
      this.currentScene &&
      this.sceneVideoDurationSec &&
      this.currentScene.backgroundVideoUrl &&
      shouldUseBackgroundVideoDuration
    ) {
      return this.sceneVideoDurationSec;
    }

    return fallbackDurationSec;
  }

  setPlaying(nextPlaying: boolean): void {
    this.playing = nextPlaying;
    this.syncSceneVideos();
  }

  async setScene(scene: ResolvedScene, options?: { transition?: PreviewSceneTransition }): Promise<void> {
    const transition = options?.transition ?? "none";
    const canTransition = transition === "book" && this.currentScene !== null;

    if (canTransition) {
      await this.playBookPageTransition(async () => {
        await this.prepareScene(scene);
      });
      return;
    }

    await this.prepareScene(scene);
  }

  private async prepareScene(scene: ResolvedScene): Promise<void> {
    const nextSceneLayer = new Container();

    this.resetSceneRenderState(scene);
    this.sceneLayer = nextSceneLayer;
    await this.drawScene(scene);
    this.root.removeChildren();
    this.root.addChild(nextSceneLayer);
    this.sceneLayer = nextSceneLayer;
    this.renderAt(0);
  }

  private getTransitionPageUrl(): string | null {
    if (!this.project) {
      return null;
    }

    return resolveProjectResource(this.project.projectName, "resources/images/ui/transitions/book-page.png");
  }

  private resetSceneRenderState(scene: ResolvedScene): void {
    this.currentScene = scene;
    this.currentTimeSec = 0;
    this.countdownBadge = null;
    this.countdownNumber = null;
    this.hudBee = null;
    this.hudBeeFrames = [];
    this.hudHive = null;
    this.hudTrackRemaining = null;
    this.hudTimerConfig = null;
    this.markerDisplays = [];
    this.sceneVideoDurationSec = null;
    this.backgroundVideoAudioEnabled = this.shouldEnableBackgroundVideoAudio(scene);
    this.disposeSceneVideos();
    this.prepareSceneCueAudio(scene);
    this.promptAnimation = null;
    this.sceneVideoSeekPending = false;
  }

  private shouldEnableBackgroundVideoAudio(scene: ResolvedScene): boolean {
    return scene.audio.length === 0 && scene.sceneType === "title_card";
  }

  private prepareProjectCueAudio(): void {
    this.disposeBookPageAudio();
    this.prepareBookPageAudio();
  }

  private prepareSceneCueAudio(scene: ResolvedScene): void {
    this.disposeMarkerRevealAudio();
    this.prepareMarkerRevealAudio(scene);
  }

  private async playBookPageTransition(swapScene: () => Promise<void>): Promise<void> {
    if (!this.project) {
      return;
    }

    const transition = await this.createBookTransitionOverlay();
    if (!transition) {
      await swapScene();
      return;
    }

    this.playBookPageSound();

    const animatePhase = (durationMs: number, direction: "cover" | "reveal"): Promise<void> =>
      new Promise((resolve) => {
        const startedAt = performance.now();

        const tick = (now: number) => {
          const progress = Math.min(1, (now - startedAt) / durationMs);
          this.drawBookTransitionOverlay(transition, progress, direction);

          if (progress < 1) {
            requestAnimationFrame(tick);
            return;
          }

          resolve();
        };

        requestAnimationFrame(tick);
      });

    await animatePhase(BOOK_TRANSITION_COVER_SEC * 1000, "cover");
    await swapScene();
    this.transitionLayer.addChild(transition.overlay);
    await animatePhase((BOOK_TRANSITION_TOTAL_SEC - BOOK_TRANSITION_COVER_SEC) * 1000, "reveal");

    this.clearBookTransitionOverlay(transition);
  }

  async createBookTransitionOverlay(): Promise<BookTransitionOverlay | null> {
    if (!this.project) {
      return null;
    }

    const stageWidth = this.project.width;
    const stageHeight = this.project.height;
    const overlay = new Container();
    const pageMask = new Graphics();
    const pageFill = new Graphics();
    const pageShadow = new Graphics();
    const pageEdge = new Graphics();
    const pageBack = new Graphics();
    const pageTexture = await this.loadTexture(this.getTransitionPageUrl());
    const pageSprite = pageTexture ? new Sprite(pageTexture) : null;

    if (pageSprite) {
      pageSprite.x = 0;
      pageSprite.y = 0;
      pageSprite.width = stageWidth;
      pageSprite.height = stageHeight;
      pageSprite.alpha = 0.98;
      pageSprite.mask = pageMask;
    }

    overlay.addChild(pageBack);
    if (pageSprite) {
      overlay.addChild(pageSprite);
    } else {
      overlay.addChild(pageFill);
    }
    overlay.addChild(pageShadow);
    overlay.addChild(pageEdge);
    overlay.addChild(pageMask);
    this.transitionLayer.removeChildren();
    this.transitionLayer.addChild(overlay);

    return {
      overlay,
      pageMask,
      pageFill,
      pageShadow,
      pageEdge,
      pageBack,
      pageSprite,
    };
  }

  drawBookTransitionOverlay(transition: BookTransitionOverlay, progress: number, direction: "cover" | "reveal"): void {
    if (!this.project) {
      return;
    }

    const stageWidth = this.project.width;
    const stageHeight = this.project.height;
    const eased = 1 - Math.pow(1 - progress, 2.2);
    const foldX = direction === "cover" ? stageWidth * (1 - eased) : stageWidth * eased;
    const foldDepth = Math.max(26, 110 * Math.sin(progress * Math.PI));
    const foldPeak = Math.max(0, foldX - foldDepth);

    transition.pageMask.clear();
    transition.pageMask
      .moveTo(foldX, 0)
      .lineTo(stageWidth, 0)
      .lineTo(stageWidth, stageHeight)
      .lineTo(foldX, stageHeight)
      .lineTo(foldPeak, stageHeight * 0.5)
      .closePath()
      .fill(0xffffff);

    if (!transition.pageSprite) {
      transition.pageFill.clear();
      transition.pageFill
        .moveTo(foldX, 0)
        .lineTo(stageWidth, 0)
        .lineTo(stageWidth, stageHeight)
        .lineTo(foldX, stageHeight)
        .lineTo(foldPeak, stageHeight * 0.5)
        .closePath()
        .fill({ color: 0xf8e7be, alpha: 0.98 });
    }

    transition.pageBack.clear();
    transition.pageBack
      .moveTo(foldPeak, 0)
      .lineTo(foldX, 0)
      .lineTo(foldX, stageHeight)
      .lineTo(foldPeak, stageHeight)
      .closePath()
      .fill({ color: 0xe3c791, alpha: 0.7 });

    transition.pageShadow.clear();
    transition.pageShadow
      .rect(Math.max(0, foldPeak - 30), 0, Math.min(stageWidth, foldDepth + 36), stageHeight)
      .fill({ color: 0x140a03, alpha: 0.26 * (1 - Math.abs(progress - 0.5)) });

    transition.pageEdge.clear();
    transition.pageEdge
      .moveTo(Math.max(0, foldX - 4), 0)
      .lineTo(foldX, 0)
      .lineTo(foldX, stageHeight)
      .lineTo(Math.max(0, foldX - 4), stageHeight)
      .closePath()
      .fill({ color: 0xfff8e6, alpha: 0.96 });
  }

  clearBookTransitionOverlay(transition?: BookTransitionOverlay | null): void {
    transition?.overlay.removeFromParent();
    this.transitionLayer.removeChildren();
  }

  renderAt(timeSec: number): void {
    this.currentTimeSec = timeSec;
    this.sceneVideoSeekPending = false;

    if (!this.currentScene) {
      return;
    }

    if (this.countdownNumber) {
      const countdownFrom =
        this.hudTimerConfig?.durationSec ?? (this.currentScene.countdownFrom || this.currentScene.durationSec);
      const remaining = Math.max(0, Math.ceil(countdownFrom - timeSec));
      void this.updateCountdownNumber(remaining);
    }

    if (this.hudBee && this.hudTimerConfig) {
      const { durationSec } = this.hudTimerConfig;
      const progress = durationSec > 0 ? Math.min(1, Math.max(0, timeSec / durationSec)) : 0;
      if (this.hudTimerConfig.orientation === "vertical") {
        const { startY, endY, beeX } = this.hudTimerConfig;
        this.hudBee.x = beeX;
        this.hudBee.y = startY + (endY - startY) * progress;
      } else {
        const { startX, endX, beeY } = this.hudTimerConfig;
        this.hudBee.x = startX + (endX - startX) * progress;
        this.hudBee.y = beeY;
      }
      if (this.hudBeeFrames.length > 1) {
        const frameIndex = Math.floor(timeSec * 10) % this.hudBeeFrames.length;
        this.hudBee.texture = this.hudBeeFrames[frameIndex];
      }
      this.updateHudTrackRemaining();
    }

    this.syncSceneVideos();
    this.updateAnimatedPrompt(timeSec);

    for (const entry of this.markerDisplays) {
      const elapsed = timeSec - entry.revealAtSec;
      const isVisible = elapsed >= 0;
      entry.display.visible = isVisible;

      if (isVisible) {
        const introProgress = Math.min(1, elapsed / MARKER_INTRO_SEC);
        const eased = 1 - Math.pow(1 - introProgress, 3);
        const overshoot = elapsed < MARKER_INTRO_SEC ? entry.hiddenScale - (entry.hiddenScale - 1) * eased : 1;
        entry.display.scale.set(overshoot);
        entry.display.alpha = elapsed < MARKER_FADE_SEC ? Math.min(1, elapsed / MARKER_FADE_SEC) : 1;
      } else {
        entry.display.scale.set(entry.hiddenScale);
        entry.display.alpha = 0;
      }

      this.updateMarkerParticles(entry, elapsed);

      if (isVisible && !entry.revealed) {
        entry.revealed = true;
        if (entry.playSoundOnReveal) {
          this.playMarkerRevealSound();
        }
      } else if (!isVisible && entry.revealed) {
        entry.revealed = false;
      }
    }
  }

  private updateAnimatedPrompt(timeSec: number): void {
    if (!this.promptAnimation) {
      return;
    }

    if (this.promptAnimation.kind === "step") {
      const prompt = this.promptAnimation.target;
      if (timeSec < 0) {
        prompt.alpha = 0;
        prompt.scale.set(0.62 * STEP_PROMPT_SCALE_FACTOR);
        return;
      }

      if (timeSec <= 0.26) {
        const progress = timeSec / 0.26;
        const eased = 1 - Math.pow(1 - progress, 3);
        const scale = (0.62 + (1.2 - 0.62) * eased) * STEP_PROMPT_SCALE_FACTOR;
        prompt.alpha = progress;
        prompt.scale.set(scale);
        return;
      }

      if (timeSec <= 0.86) {
        prompt.alpha = 1;
        prompt.scale.set(1.2 * STEP_PROMPT_SCALE_FACTOR);
        return;
      }

      if (timeSec <= 1.18) {
        const progress = (timeSec - 0.86) / 0.32;
        const eased = progress * progress;
        const scale = (1.2 + (1.36 - 1.2) * eased) * STEP_PROMPT_SCALE_FACTOR;
        prompt.alpha = 1 - progress;
        prompt.scale.set(scale);
        return;
      }

      prompt.alpha = 0;
      prompt.scale.set(1.36 * STEP_PROMPT_SCALE_FACTOR);
      return;
    }

    const prompt = this.promptAnimation.target;
    if (timeSec < 0.08) {
      prompt.alpha = 0;
      prompt.scale.set(0.42 * TIMEOUT_PROMPT_SCALE_FACTOR);
      return;
    }

    if (timeSec <= 0.36) {
      const progress = (timeSec - 0.08) / 0.28;
      const eased = 1 - Math.pow(1 - progress, 3);
      const scale = (0.42 + (0.9 - 0.42) * eased) * TIMEOUT_PROMPT_SCALE_FACTOR;
      prompt.alpha = progress;
      prompt.scale.set(scale);
      return;
    }

    prompt.alpha = 1;
    prompt.scale.set(0.9 * TIMEOUT_PROMPT_SCALE_FACTOR);
  }

  private async drawScene(scene: ResolvedScene): Promise<void> {
    if (!this.project) {
      return;
    }

    const stageWidth = this.project.width;
    const stageHeight = this.project.height;

    const background = await this.createBackground(scene, stageWidth, stageHeight);
    this.sceneLayer.addChild(background);

    if (scene.sceneType === "title_card" || scene.sceneType === "timeout_card") {
      await this.drawTitleCard(scene, stageWidth, stageHeight);
      await this.drawAnimatedHudPrompt(scene, stageWidth, stageHeight);
      return;
    }

    await this.drawPuzzleScene(scene, stageWidth, stageHeight);
    await this.drawAnimatedHudPrompt(scene, stageWidth, stageHeight);
  }

  private async loadTexture(url: string | null): Promise<Texture | null> {
    if (!url) {
      return null;
    }

    try {
      return await Assets.load<Texture>(url);
    } catch {
      return null;
    }
  }

  private async createBackground(scene: ResolvedScene, width: number, height: number): Promise<Container> {
    const layer = new Container();
    const isPortraitPuzzle =
      height > width && (scene.sceneType === "puzzle_scene" || scene.sceneType === "answer_reveal");
    const fallback = new Graphics().rect(0, 0, width, height).fill(isPortraitPuzzle ? 0x000000 : 0x08131f);
    layer.addChild(fallback);

    if (isPortraitPuzzle) {
      return layer;
    }

    const videoSprite = await this.createVideoSprite(scene, scene.backgroundVideoUrl, width, height);
    if (videoSprite) {
      const useFullVideo =
        (scene.sceneType === "title_card" || scene.sceneType === "timeout_card") && !scene.backgroundImageUrl;
      videoSprite.alpha = useFullVideo ? 1 : 0.52;
      layer.addChild(videoSprite);
    }

    const texture = await this.loadTexture(scene.backgroundImageUrl);
    if (!texture) {
      if (videoSprite) {
        const overlayAlpha =
          (scene.sceneType === "title_card" || scene.sceneType === "timeout_card") && !scene.backgroundImageUrl
            ? 0.08
            : 0.22;
        layer.addChild(
          new Graphics().rect(0, 0, width, height).fill({
            color: 0x050b13,
            alpha: overlayAlpha,
          }),
        );
      }
      return layer;
    }

    const sprite = new Sprite(texture);
    const rect = containRect(width, height, texture.width, texture.height);

    sprite.x = rect.x;
    sprite.y = rect.y;
    sprite.width = rect.width;
    sprite.height = rect.height;
    sprite.alpha = scene.sceneType === "title_card" || scene.sceneType === "timeout_card" ? 0.95 : 0.82;

    const overlay = new Graphics().rect(0, 0, width, height).fill({
      color: 0x050b13,
      alpha: scene.sceneType === "title_card" || scene.sceneType === "timeout_card" ? 0.18 : 0.34,
    });

    layer.addChild(sprite, overlay);
    return layer;
  }

  private async createVideoSprite(scene: ResolvedScene, url: string | null, width: number, height: number): Promise<Sprite | null> {
    if (!url) {
      return null;
    }

    try {
      const video = document.createElement("video");
      video.src = url;
      video.autoplay = false;
      video.loop = scene.sceneType === "puzzle_scene" || scene.sceneType === "answer_reveal";
      video.muted = !this.backgroundVideoAudioEnabled;
      video.playsInline = true;
      video.crossOrigin = "anonymous";
      video.preload = "auto";

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          video.removeEventListener("loadeddata", onLoad);
          video.removeEventListener("error", onError);
        };
        const onLoad = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error(`Failed to load video: ${url}`));
        };
        video.addEventListener("loadeddata", onLoad);
        video.addEventListener("error", onError);
      });

      if (Number.isFinite(video.duration) && video.duration > 0) {
        this.sceneVideoDurationSec = video.duration;
      }
      this.sceneVideos.push(video);

      const sprite = Sprite.from(video);
      const rect = containRect(width, height, video.videoWidth || width, video.videoHeight || height);
      sprite.x = rect.x;
      sprite.y = rect.y;
      sprite.width = rect.width;
      sprite.height = rect.height;
      return sprite;
    } catch {
      return null;
    }
  }

  private disposeSceneVideos(): void {
    for (const video of this.sceneVideos) {
      video.pause();
      video.src = "";
      video.load();
    }
    this.sceneVideos = [];
  }

  private prepareMarkerRevealAudio(scene: ResolvedScene): void {
    if (!this.project || scene.sceneType !== "answer_reveal") {
      return;
    }

    this.markerRevealAudio = new Audio(resolveProjectResource(this.project.projectName, "resources/audio/sfx/ok.mp3"));
    this.markerRevealAudio.preload = "auto";
    this.markerRevealAudio.volume = 1;
  }

  private prepareBookPageAudio(): void {
    if (!this.project) {
      return;
    }

    this.bookPageAudio = new Audio(resolveProjectResource(this.project.projectName, "resources/audio/sfx/bookpage.wav"));
    this.bookPageAudio.preload = "auto";
    this.bookPageAudio.volume = 1;
  }

  private disposeBookPageAudio(): void {
    if (!this.bookPageAudio) {
      return;
    }

    this.bookPageAudio.pause();
    this.bookPageAudio.src = "";
    this.bookPageAudio = null;
  }

  private playBookPageSound(): void {
    if (!this.bookPageAudio) {
      return;
    }

    try {
      this.bookPageAudio.currentTime = 0;
      void this.bookPageAudio.play().catch(() => undefined);
    } catch {
      // Ignore playback failures when browser gesture policy blocks autoplay.
    }
  }

  private disposeMarkerRevealAudio(): void {
    for (const audio of this.activeMarkerRevealAudios) {
      audio.pause();
      audio.src = "";
    }
    this.activeMarkerRevealAudios = [];

    if (this.markerRevealAudio) {
      this.markerRevealAudio.pause();
      this.markerRevealAudio.src = "";
    }
    this.markerRevealAudio = null;
  }

  private playMarkerRevealSound(): void {
    if (!this.playing || !this.markerRevealAudio) {
      return;
    }

    try {
      const audio = this.markerRevealAudio.cloneNode(true) as HTMLAudioElement;
      audio.currentTime = 0;
      audio.volume = this.markerRevealAudio.volume;
      this.activeMarkerRevealAudios.push(audio);
      const cleanup = () => {
        const index = this.activeMarkerRevealAudios.indexOf(audio);
        if (index >= 0) {
          this.activeMarkerRevealAudios.splice(index, 1);
        }
        audio.src = "";
      };
      audio.addEventListener("ended", cleanup, { once: true });
      audio.addEventListener("error", cleanup, { once: true });
      void audio.play().catch(cleanup);
    } catch {
      // Ignore playback failures when browser gesture policy blocks autoplay.
    }
  }

  private syncSceneVideos(): void {
    for (const video of this.sceneVideos) {
      video.muted = !this.backgroundVideoAudioEnabled;
      const targetTime = this.getTargetVideoTime(video);
      const syncThreshold = this.playing ? 0.25 : 1 / 120;

      if (Math.abs(video.currentTime - targetTime) > syncThreshold) {
        try {
          video.currentTime = targetTime;
          this.sceneVideoSeekPending = true;
        } catch {
          // Ignore seek failures while the video is not buffered enough yet.
        }
      }

      if (this.playing) {
        void video.play().catch(() => undefined);
      } else {
        video.pause();
      }
    }
  }

  private getTargetVideoTime(video: HTMLVideoElement): number {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
    if (!duration) {
      return Math.max(0, this.currentTimeSec);
    }

    if (video.loop) {
      const normalized = this.currentTimeSec % duration;
      return normalized >= 0 ? normalized : normalized + duration;
    }

    return Math.max(0, Math.min(this.currentTimeSec, Math.max(0, duration - 1 / 240)));
  }

  private async settleSceneVideos(): Promise<void> {
    if (!this.sceneVideos.length) {
      return;
    }

    await Promise.all(
      this.sceneVideos.map(
        (video) =>
          new Promise<void>((resolve) => {
            let settled = false;
            let timeoutId = 0;
            let animationId = 0;
            let callbackId = 0;

            const cleanup = () => {
              if (settled) {
                return;
              }
              settled = true;
              window.clearTimeout(timeoutId);
              if (animationId) {
                cancelAnimationFrame(animationId);
              }
              if (callbackId && "cancelVideoFrameCallback" in video) {
                (video as HTMLVideoElement & { cancelVideoFrameCallback(id: number): void }).cancelVideoFrameCallback(callbackId);
              }
              video.removeEventListener("seeked", finish);
              resolve();
            };

            const finish = () => cleanup();

            video.addEventListener("seeked", finish, { once: true });
            timeoutId = window.setTimeout(finish, 120);

            if ("requestVideoFrameCallback" in video) {
              callbackId = (
                video as HTMLVideoElement & {
                  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number;
                }
              ).requestVideoFrameCallback(() => finish());
            } else {
              animationId = requestAnimationFrame(() => finish());
            }
          }),
      ),
    );
  }

  private async drawTitleCard(scene: ResolvedScene, width: number, height: number): Promise<void> {
    const texture = await this.loadTexture(scene.foregroundImageUrl);

    if (texture) {
      const sprite = new Sprite(texture);
      const rect = containRect(width - 60, height - 60, texture.width, texture.height);
      sprite.x = 30 + rect.x;
      sprite.y = 30 + rect.y;
      sprite.width = rect.width;
      sprite.height = rect.height;
      this.sceneLayer.addChild(sprite);
      return;
    }
  }

  private async drawAnimatedHudPrompt(scene: ResolvedScene, width: number, height: number): Promise<void> {
    if (!this.project) {
      return;
    }

    const promptLayer = new Container();
    this.sceneLayer.addChild(promptLayer);

    if (scene.sceneType === "puzzle_scene") {
      return;
    }

    if (scene.sceneType === "timeout_card") {
      const texture =
        (await this.loadTexture(`/projects/${this.project.projectName}/resources/images/ui/hud/ending.png`)) ??
        (await this.loadTexture(`/projects/${this.project.projectName}/resources/images/ui/hud/timeover.png`));
      if (!texture) {
        return;
      }

      const promptSprite = new Sprite(texture);
      const promptRect = containRect(Math.min(width * 0.05, 64), 18, texture.width, texture.height);
      promptSprite.anchor.set(0.5);
      promptSprite.x = width / 2;
      promptSprite.y = height * 0.5;
      promptSprite.width = promptRect.width;
      promptSprite.height = promptRect.height;
      promptSprite.alpha = 0;
      promptSprite.scale.set(0.42 * TIMEOUT_PROMPT_SCALE_FACTOR);
      promptLayer.addChild(promptSprite);
      this.promptAnimation = { kind: "timeout", target: promptSprite };
    }
  }

  private async drawPuzzleScene(scene: ResolvedScene, width: number, height: number): Promise<void> {
    if (!this.project) {
      return;
    }

    const layer = new Container();
    const isPortrait = height > width;
    if (isPortrait) {
      await this.drawShortsPuzzleScene(scene, width, height);
      return;
    }

    const hudHeight = 96;
    const outerMarginX = 10;
    const dividerWidth = 4;
    const panelWidth = (width - outerMarginX * 2 - dividerWidth) / 2;
    const panelHeight = height - hudHeight;
    const leftPanelRect = {
      x: outerMarginX,
      y: hudHeight,
      width: panelWidth,
      height: panelHeight,
    };
    const rightPanelRect = {
      x: outerMarginX + panelWidth + dividerWidth,
      y: hudHeight,
      width: panelWidth,
      height: panelHeight,
    };

    await this.drawHud(scene, layer, width, hudHeight);
    await this.drawPanels(scene, layer, leftPanelRect, rightPanelRect);

    if (scene.stepImages) {
      const leftTexture = await this.loadTexture(scene.stepImages.leftImage);
      const rightTexture = await this.loadTexture(scene.stepImages.rightImage);

      if (leftTexture && rightTexture) {
        const borderInset = 2;
        const fitImageRect = isPortrait ? containRect : coverRect;
        const leftImageRect = fitImageRect(
          leftPanelRect.width - borderInset * 2,
          leftPanelRect.height - borderInset * 2,
          leftTexture.width,
          leftTexture.height,
        );
        const rightImageRect = fitImageRect(
          rightPanelRect.width - borderInset * 2,
          rightPanelRect.height - borderInset * 2,
          rightTexture.width,
          rightTexture.height,
        );

        const leftSprite = new Sprite(leftTexture);
        leftSprite.x = leftPanelRect.x + borderInset + leftImageRect.x;
        leftSprite.y = leftPanelRect.y + borderInset + leftImageRect.y;
        leftSprite.width = leftImageRect.width;
        leftSprite.height = leftImageRect.height;
        const leftMask = new Graphics().rect(
          leftPanelRect.x + borderInset,
          leftPanelRect.y + borderInset,
          leftPanelRect.width - borderInset * 2,
          leftPanelRect.height - borderInset * 2,
        ).fill(0xffffff);
        leftSprite.mask = leftMask;

        const rightSprite = new Sprite(rightTexture);
        rightSprite.x = rightPanelRect.x + borderInset + rightImageRect.x;
        rightSprite.y = rightPanelRect.y + borderInset + rightImageRect.y;
        rightSprite.width = rightImageRect.width;
        rightSprite.height = rightImageRect.height;
        const rightMask = new Graphics().rect(
          rightPanelRect.x + borderInset,
          rightPanelRect.y + borderInset,
          rightPanelRect.width - borderInset * 2,
          rightPanelRect.height - borderInset * 2,
        ).fill(0xffffff);
        rightSprite.mask = rightMask;

        layer.addChild(leftMask, rightMask, leftSprite, rightSprite);

        await this.drawMarkers(scene, layer, {
          left: {
            x: leftSprite.x,
            y: leftSprite.y,
            width: leftSprite.width,
            height: leftSprite.height,
          },
          right: {
            x: rightSprite.x,
            y: rightSprite.y,
            width: rightSprite.width,
            height: rightSprite.height,
          },
        });
      }
    }

    this.sceneLayer.addChild(layer);
  }

  private async drawShortsPuzzleScene(scene: ResolvedScene, width: number, height: number): Promise<void> {
    if (!this.project) {
      return;
    }

    const layer = new Container();
    const imageX = Math.round(width * 0.078);
    const imageWidth = Math.round(width * 0.665);
    const imageGap = Math.max(6, Math.round(height * 0.006));
    const imageTopY = Math.round(height * 0.072);
    const bottomClearance = Math.round(height * 0.17);
    const imageHeight = Math.round(
      Math.min(imageWidth, (height - imageTopY - imageGap - bottomClearance) / 2),
    );
    const topImagePanel: DisplayRect = {
      x: imageX,
      y: imageTopY,
      width: imageWidth,
      height: imageHeight,
    };
    const bottomImagePanel: DisplayRect = {
      x: imageX,
      y: topImagePanel.y + topImagePanel.height + imageGap,
      width: imageWidth,
      height: imageHeight,
    };

    if (scene.stepImages) {
      const leftTexture = await this.loadTexture(scene.stepImages.leftImage);
      const rightTexture = await this.loadTexture(scene.stepImages.rightImage);

      if (leftTexture && rightTexture) {
        const leftImageRect = this.addShortsPuzzleImage(layer, leftTexture, topImagePanel);
        const rightImageRect = this.addShortsPuzzleImage(layer, rightTexture, bottomImagePanel);

        await this.drawMarkers(scene, layer, {
          left: leftImageRect,
          right: rightImageRect,
        });
      }
    }

    this.drawShortsPromptText(scene, layer, topImagePanel);
    await this.drawShortsSideTimer(scene, layer, width, topImagePanel, bottomImagePanel);

    this.sceneLayer.addChild(layer);
  }

  private drawShortsPromptText(scene: ResolvedScene, layer: Container, imagePanel: DisplayRect): void {
    const centerText = this.getShortsPromptText(scene);
    if (!centerText) {
      return;
    }

    const fontSize = Math.round(Math.min(64, Math.max(34, imagePanel.width * 0.082)));
    const promptText = new Text({
      text: centerText,
      style: new TextStyle({
        fontFamily: "Georgia",
        fontSize,
        fontWeight: "900",
        fill: "#ffffff",
        stroke: { color: "#000000", width: 3, join: "round" },
        align: "center",
        wordWrap: true,
        wordWrapWidth: imagePanel.width + imagePanel.x * 1.9,
      }),
    });
    promptText.anchor.set(0.5, 0);
    promptText.x = imagePanel.x + imagePanel.width / 2;
    promptText.y = Math.max(18, Math.round(imagePanel.y * 0.22));
    layer.addChild(promptText);
  }

  private getShortsPromptText(scene: ResolvedScene): string {
    const markerPrompt = this.getPuzzleMarkerPromptText(scene, "shorts");
    if (markerPrompt && (!scene.bannerText || this.isAutoMarkerPromptBanner(scene.bannerText))) {
      return markerPrompt;
    }

    if (scene.bannerText) {
      return scene.bannerText;
    }

    return this.getHudCenterText(scene);
  }

  private async drawShortsSideTimer(
    scene: ResolvedScene,
    layer: Container,
    width: number,
    topImagePanel: DisplayRect,
    bottomImagePanel: DisplayRect,
  ): Promise<void> {
    if (!this.project) {
      return;
    }

    const beeAnimationCandidates = [
      `/projects/${this.project.projectName}/resources/images/ui/hud/bee-flap-1.png`,
      `/projects/${this.project.projectName}/resources/images/ui/hud/bee-flap-2.png`,
      `/projects/${this.project.projectName}/resources/images/ui/hud/bee-flap-3.png`,
      `/projects/${this.project.projectName}/resources/images/ui/hud/bee-flap-4.png`,
    ];
    const beeFrameResults = await Promise.all(beeAnimationCandidates.map((path) => this.loadTexture(path)));
    const beeFrames = beeFrameResults.filter((texture): texture is Texture => texture != null);
    const beeTexture = beeFrames[0] ?? (await this.loadTexture(`/projects/${this.project.projectName}/resources/images/ui/hud/bee.png`));
    const hiveTexture = await this.loadTexture(`/projects/${this.project.projectName}/resources/images/ui/hud/beehouse.png`);
    const uiCenterX = Math.min(width - Math.round(width * 0.08), topImagePanel.x + topImagePanel.width + width * 0.13);
    const scoreY = topImagePanel.y - Math.round(width * 0.008);
    const hiveSize = Math.round(width * 0.13);
    const beeSize = Math.round(width * 0.145);
    const hiveY = topImagePanel.y + Math.round(topImagePanel.height * 0.21);
    const trackTopY = hiveY + hiveSize * 0.52;
    const trackBottomY = bottomImagePanel.y + beeSize * 0.08;
    const isAnswerReveal = scene.sceneType === "answer_reveal";
    const initialCountdown = isAnswerReveal ? 0 : scene.countdownFrom || scene.durationSec;

    this.countdownNumber = new Text({
      text: "0",
      style: new TextStyle({
        fontFamily: "Georgia",
        fontSize: Math.round(Math.min(76, Math.max(48, width * 0.082))),
        fontWeight: "900",
        fill: "#ffffff",
        stroke: { color: "#000000", width: 3, join: "round" },
      }),
    });
    this.countdownNumber.anchor.set(0.5, 0);
    this.countdownNumber.x = uiCenterX;
    this.countdownNumber.y = scoreY;
    layer.addChild(this.countdownNumber);

    if (hiveTexture) {
      const hiveSprite = new Sprite(hiveTexture);
      hiveSprite.anchor.set(0.5);
      hiveSprite.width = hiveSize;
      hiveSprite.height = hiveSize;
      hiveSprite.x = uiCenterX;
      hiveSprite.y = hiveY;
      this.hudHive = hiveSprite;
      layer.addChild(hiveSprite);
    }

    this.hudTrackRemaining = new Graphics();
    layer.addChild(this.hudTrackRemaining);

    if (beeTexture) {
      this.hudBeeFrames = beeFrames.length ? beeFrames : [beeTexture];
      const beeSprite = new Sprite(beeTexture);
      beeSprite.anchor.set(0.5);
      beeSprite.width = beeSize;
      beeSprite.height = beeSize;
      beeSprite.x = uiCenterX;
      beeSprite.y = isAnswerReveal ? trackTopY : trackBottomY;
      this.hudBee = beeSprite;
      layer.addChild(beeSprite);
    }

    this.hudTimerConfig = {
      orientation: "vertical",
      startY: isAnswerReveal ? trackTopY : trackBottomY,
      endY: trackTopY,
      beeX: uiCenterX,
      trackX: uiCenterX,
      durationSec: initialCountdown,
    };
    await this.updateCountdownNumber(initialCountdown);
    this.updateHudTrackRemaining();
  }

  private addShortsPuzzleImage(layer: Container, texture: Texture, panelRect: DisplayRect): DisplayRect {
    const imageRect = containRect(panelRect.width, panelRect.height, texture.width, texture.height);
    const sprite = new Sprite(texture);
    sprite.x = panelRect.x + imageRect.x;
    sprite.y = panelRect.y + imageRect.y;
    sprite.width = imageRect.width;
    sprite.height = imageRect.height;

    const mask = new Graphics()
      .rect(panelRect.x, panelRect.y, panelRect.width, panelRect.height)
      .fill(0xffffff);
    sprite.mask = mask;
    layer.addChild(mask, sprite);

    return {
      x: sprite.x,
      y: sprite.y,
      width: sprite.width,
      height: sprite.height,
    };
  }

  private async drawHud(scene: ResolvedScene, layer: Container, width: number, hudHeight: number): Promise<void> {
    if (!this.project) {
      return;
    }

    const hudTexture = await this.loadTexture(this.project.uiResources.hudBar);

    if (hudTexture) {
      const hudSprite = new Sprite(hudTexture);
      hudSprite.x = 0;
      hudSprite.y = 0;
      hudSprite.width = width;
      hudSprite.height = hudHeight;
      layer.addChild(hudSprite);
    } else {
      const hudFill = hexColor(scene.bannerFill || "#1d4ed8", 0x1d4ed8);
      layer.addChild(new Graphics().rect(0, 0, width, hudHeight).fill(hudFill));
    }

    this.drawHudText(scene, layer, width, hudHeight);

    if (scene.sceneType === "puzzle_scene" || scene.sceneType === "answer_reveal") {
      await this.drawBeeTimer(scene, layer, width, hudHeight);
    }
  }

  private drawHudText(scene: ResolvedScene, layer: Container, width: number, hudHeight: number): void {
    if (!this.project) {
      return;
    }

    const textColor = scene.textColor || "#ffffff";
    const leftPrimary = scene.titleText || (scene.step != null ? `STEP ${scene.step}` : "");
    const leftSecondary = scene.step != null ? `${scene.step}/${this.project.detectedStepCount}` : "";
    const centerText = this.getHudCenterText(scene);
    const isPortrait = hudHeight > 100;
    const centerFontSize = scene.sceneType === "answer_reveal"
      ? (isPortrait ? 40 : 34)
      : (isPortrait ? 34 : 28);

    const primaryStyle = new TextStyle({
      fontFamily: "Arial",
      fontSize: isPortrait ? 30 : 22,
      fontWeight: "800",
      fill: "#ffc000",
      stroke: { color: "#120b05", width: 4, join: "round" },
    });
    const secondaryStyle = new TextStyle({
      fontFamily: "Arial",
      fontSize: isPortrait ? 22 : 17,
      fontWeight: "800",
      fill: "#ffffff",
      stroke: { color: "#120b05", width: 4, join: "round" },
    });
    const centerStyle = new TextStyle({
      fontFamily: "Arial",
      fontSize: centerFontSize,
      fontWeight: "900",
      fill: textColor,
      stroke: { color: "#120b05", width: 5, join: "round" },
      align: "left",
      wordWrap: true,
      wordWrapWidth: isPortrait ? width - 48 : Math.max(280, width - 760),
    });

    if (leftPrimary) {
      const primaryText = new Text({
        text: leftPrimary,
        style: primaryStyle,
      });
      primaryText.x = isPortrait ? 24 : 20;
      primaryText.y = isPortrait ? 16 : 9;
      layer.addChild(primaryText);
    }

    if (leftSecondary) {
      const secondaryText = new Text({
        text: leftSecondary,
        style: secondaryStyle,
      });
      secondaryText.x = isPortrait ? 28 : 24;
      secondaryText.y = isPortrait ? 55 : 36;
      layer.addChild(secondaryText);
    }

    if (centerText) {
      const bannerText = new Text({
        text: centerText,
        style: centerStyle,
      });
      bannerText.anchor.set(0, isPortrait ? 0 : 0.5);
      bannerText.x = isPortrait ? 24 : 168;
      bannerText.y = isPortrait ? 100 : 48;
      layer.addChild(bannerText);
    }
  }

  private getHudCenterText(scene: ResolvedScene): string {
    const markerPrompt = this.getPuzzleMarkerPromptText(scene, "landscape");
    if (markerPrompt && (!scene.bannerText || this.isAutoMarkerPromptBanner(scene.bannerText))) {
      return markerPrompt;
    }

    if (scene.bannerText) {
      return scene.bannerText;
    }

    return scene.titleText;
  }

  private getPuzzleMarkerPromptText(scene: ResolvedScene, layout: "landscape" | "shorts"): string {
    if (scene.sceneType !== "puzzle_scene" || scene.step == null) {
      return "";
    }

    const markerCount = this.getStepAnswerMarkerCount(scene.step);
    if (markerCount <= 0) {
      return "";
    }

    return layout === "shorts"
      ? `다른곳 ${markerCount}곳을 찾아보세요`
      : `다른 곳을 ${markerCount}개 찾아보세요`;
  }

  private isAutoMarkerPromptBanner(value: string): boolean {
    return /^\s*다른\s*곳(?:을)?\s*\d+\s*(?:개|곳)(?:을)?\s*찾아보세요\s*$/u.test(value);
  }

  private getStepAnswerMarkerCount(step: number): number {
    if (!this.project) {
      return 0;
    }

    const answerMarkers = this.project.scenes
      .filter((scene) => scene.step === step && scene.sceneType === "answer_reveal")
      .flatMap((scene) => scene.markers);
    const markers = answerMarkers.length
      ? answerMarkers
      : this.project.scenes.filter((scene) => scene.step === step).flatMap((scene) => scene.markers);
    const uniqueMarkers = new Set(
      markers.map((marker) => [
        marker.side,
        marker.cx.toFixed(4),
        marker.cy.toFixed(4),
        marker.radius.toFixed(4),
        marker.revealAtSec.toFixed(2),
      ].join(":")),
    );

    return uniqueMarkers.size;
  }

  private async drawBeeTimer(scene: ResolvedScene, layer: Container, width: number, hudHeight: number): Promise<void> {
    if (!this.project) {
      return;
    }

    const beeAnimationCandidates = [
      `/projects/${this.project.projectName}/resources/images/ui/hud/bee-flap-1.png`,
      `/projects/${this.project.projectName}/resources/images/ui/hud/bee-flap-2.png`,
      `/projects/${this.project.projectName}/resources/images/ui/hud/bee-flap-3.png`,
      `/projects/${this.project.projectName}/resources/images/ui/hud/bee-flap-4.png`,
    ];
    const beeFrameResults = await Promise.all(beeAnimationCandidates.map((path) => this.loadTexture(path)));
    const beeFrames = beeFrameResults.filter((texture): texture is Texture => texture != null);
    const beeTexture = beeFrames[0] ?? (await this.loadTexture(`/projects/${this.project.projectName}/resources/images/ui/hud/bee.png`));
    const hiveTexture = await this.loadTexture(`/projects/${this.project.projectName}/resources/images/ui/hud/beehouse.png`);

    const isPortrait = width < 900;
    const trackY = isPortrait ? 58 : 59;
    const numberX = isPortrait ? width - 24 : 1270;
    const hiveX = isPortrait ? width - 116 : 1174;
    const trackStartX = isPortrait ? Math.max(300, width * 0.46) : 718;
    const trackEndX = hiveX - 44;

    const isAnswerReveal = scene.sceneType === "answer_reveal";

    const trackRemaining = new Graphics();
    this.hudTrackRemaining = trackRemaining;
    layer.addChild(trackRemaining);

    if (hiveTexture) {
      const hiveSprite = new Sprite(hiveTexture);
      hiveSprite.anchor.set(0.5);
      hiveSprite.width = isPortrait ? 56 : 62;
      hiveSprite.height = isPortrait ? 56 : 62;
      hiveSprite.x = hiveX;
      hiveSprite.y = trackY;
      this.hudHive = hiveSprite;
      layer.addChild(hiveSprite);
    }

    if (beeTexture) {
      this.hudBeeFrames = beeFrames.length ? beeFrames : [beeTexture];
      const beeSprite = new Sprite(beeTexture);
      beeSprite.anchor.set(0.5);
      beeSprite.width = isPortrait ? 62 : 74;
      beeSprite.height = isPortrait ? 62 : 74;
      beeSprite.x = isAnswerReveal ? trackEndX : trackStartX;
      beeSprite.y = trackY - 10;
      this.hudBee = beeSprite;
      layer.addChild(beeSprite);
    }

    this.countdownNumber = new Text({
      text: "0",
      style: new TextStyle({
        fontFamily: "Arial",
        fontSize: isPortrait ? 38 : 42,
        fontWeight: "900",
        fill: "#ffffff",
        stroke: { color: "#120b05", width: 8, join: "round" },
      }),
    });
    this.countdownNumber.anchor.set(1, 0.5);
    this.countdownNumber.x = numberX;
    this.countdownNumber.y = trackY + 1;
    layer.addChild(this.countdownNumber);

    const initialCountdown = isAnswerReveal ? 0 : scene.countdownFrom || scene.durationSec;
    this.hudTimerConfig = {
      orientation: "horizontal",
      startX: isAnswerReveal ? trackEndX : trackStartX,
      endX: trackEndX,
      beeY: trackY - 9,
      trackY,
      durationSec: isAnswerReveal ? 0 : initialCountdown,
    };
    await this.updateCountdownNumber(initialCountdown);
    this.updateHudTrackRemaining();
  }

  private async drawPanels(
    scene: ResolvedScene,
    layer: Container,
    leftPanelRect: DisplayRect,
    rightPanelRect: DisplayRect,
  ): Promise<void> {
    const addFrame = (rect: DisplayRect): void => {
      layer.addChild(
        new Graphics()
          .rect(rect.x, rect.y, rect.width, rect.height)
          .fill(0x000000)
          .stroke({ color: 0x000000, width: 4 }),
      );
    };

    addFrame(leftPanelRect);
    addFrame(rightPanelRect);
  }

  private async createMarkerDisplay(
    marker: ResolvedMarker,
    diameter: number,
    options: { compact?: boolean } = {},
  ): Promise<Sprite | Graphics> {
    if (!this.project) {
      return new Graphics();
    }

    const texture = await this.loadTexture(marker.textureUrl ?? this.project.uiResources.answerMarker);
    if (texture) {
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.width = diameter;
      sprite.height = diameter;
      return sprite;
    }

    return new Graphics().circle(0, 0, diameter / 2).stroke({
      color: hexColor(marker.strokeColor, 0xff4fd8),
      width: options.compact ? Math.max(3, Math.min(6, diameter * 0.075)) : marker.lineWidth,
    });
  }

  private async updateCountdownNumber(value: number): Promise<void> {
    if (!this.countdownNumber) {
      return;
    }

    const clamped = Math.max(0, Math.min(120, Math.round(value)));
    this.countdownNumber.visible = true;
    this.countdownNumber.text = String(clamped);
  }

  private updateHudTrackRemaining(): void {
    if (!this.hudTrackRemaining || !this.hudTimerConfig || !this.hudBee) {
      return;
    }

    this.hudTrackRemaining.clear();

    if (this.hudTimerConfig.orientation === "vertical") {
      const { endY, trackX } = this.hudTimerConfig;
      const trackBottomY = Math.max(endY, this.hudBee.y - this.hudBee.height * 0.42);
      if (trackBottomY <= endY) {
        return;
      }

      this.hudTrackRemaining
        .roundRect(trackX - 3, endY, 6, trackBottomY - endY, 999)
        .fill({ color: 0xffc000, alpha: 1 });
      return;
    }

    const { endX, trackY } = this.hudTimerConfig;
    const startX = Math.min(endX, this.hudBee.x + 22);
    if (endX <= startX) {
      return;
    }

    this.hudTrackRemaining
      .roundRect(startX, trackY - 3, endX - startX, 6, 999)
      .fill({ color: 0xffc000, alpha: 1 });
  }

  private async drawMarkers(
    scene: ResolvedScene,
    layer: Container,
    imageRects: { left: DisplayRect; right: DisplayRect },
  ): Promise<void> {
    const isPortraitAnswer = Boolean(this.project && this.project.height > this.project.width && scene.sceneType === "answer_reveal");
    const revealTimes = getMarkerRevealTimes(scene);
    const markers = scene.sceneType === "answer_reveal" ? getOrderedAnswerMarkers(scene.markers) : scene.markers;

    const addMarkerDisplay = async (
      marker: ResolvedMarker,
      rect: DisplayRect,
      playSoundOnReveal: boolean,
      revealAtSec: number,
    ): Promise<void> => {
      const sizeMultiplier = isPortraitAnswer ? 1.56 : 0.8;
      const minDiameter = isPortraitAnswer ? rect.width * 0.21 : 0;
      const maxDiameter = isPortraitAnswer ? rect.width * 0.375 : Number.POSITIVE_INFINITY;
      const diameter = Math.max(
        minDiameter,
        Math.min(maxDiameter, rect.width * marker.radius * 2 * sizeMultiplier),
      );
      const display = await this.createMarkerDisplay(marker, diameter, { compact: isPortraitAnswer });
      display.x = rect.x + rect.width * marker.cx;
      display.y = rect.y + rect.height * marker.cy;
      display.visible = false;
      display.alpha = 0;
      const hiddenScale = isPortraitAnswer ? 1.14 : 1.34;
      display.scale.set(hiddenScale);
      layer.addChild(display);
      const particles = this.createMarkerParticles(layer, display.x, display.y, diameter, isPortraitAnswer);
      this.markerDisplays.push({ marker, revealAtSec, display, particles, revealed: false, playSoundOnReveal, hiddenScale });
    };

    await Promise.all(
      markers.flatMap((marker) => {
        const primaryRect = marker.side === "left" ? imageRects.left : imageRects.right;
        const oppositeRect = marker.side === "left" ? imageRects.right : imageRects.left;
        const revealAtSec = revealTimes.get(marker) ?? marker.revealAtSec;

        if (scene.sceneType === "answer_reveal") {
          return [
            addMarkerDisplay(marker, primaryRect, true, revealAtSec),
            addMarkerDisplay(marker, oppositeRect, false, revealAtSec),
          ];
        }

        return [addMarkerDisplay(marker, primaryRect, true, revealAtSec)];
      }),
    );
  }

  private createMarkerParticles(layer: Container, x: number, y: number, diameter: number, compact = false): Graphics[] {
    const palette = [0xfff4a8, 0xffd27a, 0xffffff, 0xff92d8, 0xa5f3fc];
    const particleCount = compact ? 8 : 18;
    return Array.from({ length: particleCount }, (_, index) => {
      const particle = new Graphics()
        .circle(0, 0, compact ? 2 + (index % 3) : 3 + (index % 4))
        .fill(palette[index % palette.length]);
      particle.visible = false;
      particle.alpha = 0;
      particle.x = x;
      particle.y = y;
      layer.addChild(particle);
      return particle;
    });
  }

  private updateMarkerParticles(
    entry: { marker: ResolvedMarker; display: Sprite | Graphics; particles: Graphics[] },
    elapsed: number,
  ): void {
    for (const [index, particle] of entry.particles.entries()) {
      const delay = (index % 6) * 0.02;
      const particleElapsed = elapsed - delay;
      if (particleElapsed < 0 || particleElapsed > 0.9) {
        particle.visible = false;
        particle.alpha = 0;
        continue;
      }

      const progress = particleElapsed / 0.9;
      const angle = (-Math.PI * 0.95) + index * 0.34;
      const radius = 20 + index * 2.8 + progress * (28 + (index % 5) * 8);
      const lift = progress * 26;
      particle.visible = true;
      particle.alpha = Math.max(0, 1 - progress * 0.9);
      particle.x = entry.display.x + Math.cos(angle) * radius;
      particle.y = entry.display.y + Math.sin(angle) * radius - lift;
      particle.scale.set(1.25 - progress * 0.7);
    }
  }
}
