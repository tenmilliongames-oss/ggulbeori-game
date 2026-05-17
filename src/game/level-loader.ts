import { buildProjectModel } from "../runtime/build-project-model";
import { loadProjectWorkbook } from "../runtime/load-project-workbook";
import type { ProjectModel, ResolvedMarker, ResourceIndex, ResolvedScene, StyleResource } from "../runtime/project-types";
import { resolveProjectResource } from "../runtime/resource-path";
import type { GameBanner, GameData, GameLevel, GameStyle, SpotPoint } from "./types";

const WORKBOOK_PATH = "/projects/sample/scene-flow.xlsx";
const INDEX_PATH = "/projects/sample/project-index.json";
const BANNERS_PATH = "/projects/sample/resources/banners/banners.json";
const DEFAULT_TIME_LIMIT_SEC = 90;

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}`);
  }

  return (await response.json()) as T;
}

async function fetchOptionalJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(path);
    if (!response.ok) {
      return fallback;
    }

    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBanners(raw: unknown): GameBanner[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const record = item as Record<string, unknown>;
      const title = asString(record.title);
      const url = asString(record.url);
      if (!title || !url || record.enabled === false) {
        return null;
      }

      const banner: GameBanner = {
        id: asString(record.id) || `banner-${index + 1}`,
        title,
        url,
        enabled: true,
      };

      const subtitle = asString(record.subtitle);
      const disclosure = asString(record.disclosure);
      const image = asString(record.image);
      const layout = asString(record.layout);
      const background = asString(record.background);
      const foreground = asString(record.foreground);
      const accent = asString(record.accent);

      if (subtitle) {
        banner.subtitle = subtitle;
      }
      if (disclosure) {
        banner.disclosure = disclosure;
      }
      if (image) {
        banner.image = image;
      }
      if (layout === "image" || layout === "text") {
        banner.layout = layout;
      }
      if (background) {
        banner.background = background;
      }
      if (foreground) {
        banner.foreground = foreground;
      }
      if (accent) {
        banner.accent = accent;
      }

      return banner;
    })
    .filter((banner): banner is GameBanner => banner !== null);
}

function markerKey(marker: ResolvedMarker): string {
  return [
    marker.cx.toFixed(4),
    marker.cy.toFixed(4),
    marker.radius.toFixed(4),
  ].join(":");
}

function collectLevelSpots(step: number, project: ProjectModel): SpotPoint[] {
  const answerMarkers = project.scenes
    .filter((scene) => scene.step === step && scene.sceneType === "answer_reveal")
    .flatMap((scene) => scene.markers);
  const fallbackMarkers = project.scenes
    .filter((scene) => scene.step === step)
    .flatMap((scene) => scene.markers);
  const markers = answerMarkers.length ? answerMarkers : fallbackMarkers;
  const seen = new Set<string>();
  const spots: SpotPoint[] = [];

  for (const marker of markers) {
    const key = markerKey(marker);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    spots.push({
      id: `level-${step}-spot-${spots.length + 1}`,
      cx: marker.cx,
      cy: marker.cy,
      radius: marker.radius,
    });
  }

  return spots;
}

function findPuzzleScene(step: number, scenes: ResolvedScene[]): ResolvedScene | null {
  return scenes.find((scene) => scene.step === step && scene.sceneType === "puzzle_scene") ?? null;
}

function fallbackStyles(resourceIndex: ResourceIndex): StyleResource[] {
  return [
    {
      id: "default",
      name: "기본 스타일",
      coverImage: resourceIndex.steps[0]?.leftImage ?? "",
      stepCount: resourceIndex.steps.length,
      steps: resourceIndex.steps,
    },
  ];
}

function buildGameLevels(project: ProjectModel, style: StyleResource): GameLevel[] {
  return style.steps
    .filter((step) => step.leftImage && step.rightImage)
    .map((step) => {
      const puzzleScene = findPuzzleScene(step.step, project.scenes);
      const timeLimitSec =
        puzzleScene?.countdownFrom ||
        puzzleScene?.durationSec ||
        DEFAULT_TIME_LIMIT_SEC;

      return {
        styleId: style.id,
        level: step.step,
        leftImage: step.leftImage,
        rightImage: step.rightImage,
        thumbnailImage: step.thumbnailImage ?? step.leftImage,
        bgmTrack: resolveProjectResource(project.projectName, `resources/audio/bgm/${step.step}.mp3`),
        spots: collectLevelSpots(step.step, project),
        timeLimitSec,
      };
    })
    .filter((level) => level.spots.length > 0);
}

function buildGameStyles(project: ProjectModel): GameStyle[] {
  const styleResources = project.resourceIndex.styles?.length
    ? project.resourceIndex.styles
    : fallbackStyles(project.resourceIndex);

  return styleResources
    .map((style) => {
      const levels = buildGameLevels(project, style);
      return {
        id: style.id,
        name: style.name,
        coverImage: style.coverImage || levels[0]?.thumbnailImage || levels[0]?.leftImage || "",
        levels,
      };
    })
    .filter((style) => style.levels.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function collectLevelBgmTracks(resourceIndex: ResourceIndex): string[] {
  const bgmTracks = uniqueStrings(resourceIndex.resources.bgm ?? []);
  const numberedBgmTracks = bgmTracks.filter((track) => /\/\d+\.(mp3|wav|ogg)$/i.test(track));
  return numberedBgmTracks.length ? numberedBgmTracks : bgmTracks;
}

export async function loadGameData(): Promise<GameData> {
  const [workbook, resourceIndex, rawBanners] = await Promise.all([
    loadProjectWorkbook(WORKBOOK_PATH),
    fetchJson<ResourceIndex>(INDEX_PATH),
    fetchOptionalJson<unknown>(BANNERS_PATH, []),
  ]);
  const project = buildProjectModel(workbook, resourceIndex);
  const projectName = project.projectName || resourceIndex.projectName;

  return {
    projectName,
    logoImage: resolveProjectResource(projectName, "resources/images/ui/hud/logo-game.png"),
    beeImage: resolveProjectResource(projectName, "resources/images/ui/hud/bee.png"),
    beeFrames: [
      resolveProjectResource(projectName, "resources/images/ui/hud/bee-flap-1.png"),
      resolveProjectResource(projectName, "resources/images/ui/hud/bee-flap-2.png"),
      resolveProjectResource(projectName, "resources/images/ui/hud/bee-flap-3.png"),
      resolveProjectResource(projectName, "resources/images/ui/hud/bee-flap-4.png"),
    ],
    hiveImage: resolveProjectResource(projectName, "resources/images/ui/hud/beehouse.png"),
    markerImage: project.uiResources.answerMarker,
    successSound: resolveProjectResource(projectName, "resources/audio/sfx/ok.mp3"),
    failSound: resolveProjectResource(projectName, "resources/audio/sfx/countdown-hit.wav"),
    bgmTracks: collectLevelBgmTracks(resourceIndex),
    banners: normalizeBanners(rawBanners),
    styles: buildGameStyles(project),
  };
}
