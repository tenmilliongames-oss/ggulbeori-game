import type {
  ProjectModel,
  ResolvedMarker,
  ResolvedScene,
  ResourceIndex,
  StepResource,
  UiResourceUrls,
  WorkbookData,
} from "./project-types";
import { resolveOptionalProjectResource, resolveProjectResource } from "./resource-path";

function normalizeResourcePath(projectName: string, resourcePath: string): string | null {
  return resolveOptionalProjectResource(projectName, resourcePath);
}

function findStepResource(stepResources: StepResource[], step: number | null): StepResource | null {
  if (step == null) {
    return null;
  }

  return stepResources.find((entry) => entry.step === step) ?? null;
}

function collectAvailableResources(resourceIndex: ResourceIndex): Set<string> {
  return new Set([
    ...resourceIndex.steps.flatMap((step) => step.variants),
    ...resourceIndex.resources.backgroundImages,
    ...resourceIndex.resources.uiImages,
    ...resourceIndex.resources.effectImages,
    ...resourceIndex.resources.backgroundVideos,
    ...resourceIndex.resources.bgm,
    ...resourceIndex.resources.sfx,
  ]);
}

function findExistingPath(projectName: string, available: Set<string>, candidates: string[]): string {
  for (const candidate of candidates) {
    const normalized = normalizeResourcePath(projectName, candidate);
    if (normalized && available.has(normalized)) {
      return normalized;
    }
  }

  return resolveProjectResource(projectName, candidates[0]);
}

function findExistingDirectory(
  projectName: string,
  available: Set<string>,
  candidateFilePaths: string[],
  fallbackDir: string,
): string {
  for (const candidate of candidateFilePaths) {
    const normalized = normalizeResourcePath(projectName, candidate);
    if (normalized && available.has(normalized)) {
      return normalized.replace(/\/[^/]+$/, "");
    }
  }

  return resolveProjectResource(projectName, fallbackDir);
}

function resolveUiResources(resourceIndex: ResourceIndex, available: Set<string>): UiResourceUrls {
  return {
    hudBar: findExistingPath(resourceIndex.projectName, available, [
      "resources/images/ui/hud/hud-bar.png",
      "resources/images/ui/hud-blue.png",
      "resources/images/ui/hud/hud-blue.png",
    ]),
    timerBadge: findExistingPath(resourceIndex.projectName, available, [
      "resources/images/ui/timer-badge.png",
      "resources/images/ui/hud/timer-badge.png",
    ]),
    countdownDigitsDir: findExistingDirectory(
      resourceIndex.projectName,
      available,
      [
        "resources/images/ui/countdown/0.png",
        "resources/images/ui/countdown/00.png",
      ],
      "resources/images/ui/countdown",
    ),
    puzzlePanelFrame: findExistingPath(resourceIndex.projectName, available, [
      "resources/images/ui/puzzle-frame.png",
      "resources/images/ui/panels/puzzle-panel-frame.png",
    ]),
    titleCardFrame: findExistingPath(resourceIndex.projectName, available, [
      "resources/images/ui/intro-card.png",
      "resources/images/ui/cards/title-card-frame.png",
    ]),
    timeoutCardFrame: findExistingPath(resourceIndex.projectName, available, [
      "resources/images/ui/timeout-card.png",
      "resources/images/ui/cards/timeout-card-frame.png",
    ]),
    answerMarker: findExistingPath(resourceIndex.projectName, available, [
      "resources/images/effects/answer-marker-ring.png",
      "resources/images/ui/markers/answer-marker.png",
    ]),
  };
}

function pushMissingResourceDiagnostic(
  diagnostics: string[],
  available: Set<string>,
  projectName: string,
  label: string,
  resourcePath: string,
): void {
  const normalized = normalizeResourcePath(projectName, resourcePath);
  if (normalized && !available.has(normalized)) {
    diagnostics.push(`${label} references missing resource: ${resourcePath}`);
  }
}

function resolveMarkers(projectName: string, markers: WorkbookData["markers"]): ResolvedMarker[] {
  return markers.map((marker) => ({
    ...marker,
    textureUrl: normalizeResourcePath(projectName, marker.texturePath),
  }));
}

function resolveSceneAudio(
  scene: WorkbookData["scenes"][number],
  audioRows: WorkbookData["audio"],
  available: Set<string>,
  projectName: string,
): WorkbookData["audio"] {
  const sceneAudio = audioRows.filter((entry) => entry.sceneId === scene.sceneId);
  const filteredSceneAudio = scene.sceneType === "answer_reveal"
    ? sceneAudio.filter((entry) => entry.trackType === "bgm")
    : sceneAudio;

  if (scene.step == null || (scene.sceneType !== "puzzle_scene" && scene.sceneType !== "answer_reveal")) {
    return filteredSceneAudio;
  }

  const bgmCandidates = [
    `resources/audio/bgm/${scene.step}.mp3`,
    `resources/audio/bgm/${scene.step}.wav`,
  ];
  const matchedBgmPath = bgmCandidates.find((candidate) => {
    const normalized = normalizeResourcePath(projectName, candidate);
    return normalized ? available.has(normalized) : false;
  });

  if (!matchedBgmPath) {
    return filteredSceneAudio;
  }

  return [
    {
      sceneId: scene.sceneId,
      trackType: "bgm",
      resourcePath: matchedBgmPath,
      startSec: 0,
      volume: 0.8,
      loop: true,
    },
    ...filteredSceneAudio.filter((entry) => entry.trackType !== "bgm"),
  ];
}

function resolveScene(
  scene: WorkbookData["scenes"][number],
  workbook: WorkbookData,
  resourceIndex: ResourceIndex,
  available: Set<string>,
  diagnostics: string[],
): ResolvedScene {
  const stepImages = findStepResource(resourceIndex.steps, scene.step);
  const effects = workbook.effects.filter((entry) => entry.sceneId === scene.sceneId);
  const audio = resolveSceneAudio(scene, workbook.audio, available, resourceIndex.projectName);
  const markers = resolveMarkers(
    resourceIndex.projectName,
    workbook.markers.filter((entry) => entry.sceneId === scene.sceneId),
  );

  if (scene.step != null && !stepImages) {
    diagnostics.push(`Scene ${scene.sceneId} references step ${scene.step}, but no matching puzzle files were found.`);
  }

  if (scene.backgroundImage) {
    pushMissingResourceDiagnostic(diagnostics, available, resourceIndex.projectName, `Scene ${scene.sceneId}`, scene.backgroundImage);
  }
  if (scene.backgroundVideo) {
    pushMissingResourceDiagnostic(diagnostics, available, resourceIndex.projectName, `Scene ${scene.sceneId}`, scene.backgroundVideo);
  }
  if (scene.foregroundImage) {
    pushMissingResourceDiagnostic(diagnostics, available, resourceIndex.projectName, `Scene ${scene.sceneId}`, scene.foregroundImage);
  }
  if (scene.bannerImage) {
    pushMissingResourceDiagnostic(diagnostics, available, resourceIndex.projectName, `Scene ${scene.sceneId}`, scene.bannerImage);
  }
  if (scene.badgeImage) {
    pushMissingResourceDiagnostic(diagnostics, available, resourceIndex.projectName, `Scene ${scene.sceneId}`, scene.badgeImage);
  }
  if (scene.panelFrameImage) {
    pushMissingResourceDiagnostic(diagnostics, available, resourceIndex.projectName, `Scene ${scene.sceneId}`, scene.panelFrameImage);
  }

  for (const effect of effects) {
    if (effect.resourcePath) {
      pushMissingResourceDiagnostic(diagnostics, available, resourceIndex.projectName, `Effect ${scene.sceneId}`, effect.resourcePath);
    }
  }

  for (const track of audio) {
    pushMissingResourceDiagnostic(diagnostics, available, resourceIndex.projectName, `Audio ${scene.sceneId}`, track.resourcePath);
  }

  for (const marker of markers) {
    if (marker.texturePath) {
      pushMissingResourceDiagnostic(diagnostics, available, resourceIndex.projectName, `Marker ${scene.sceneId}`, marker.texturePath);
    }
  }

  return {
    ...scene,
    stepImages,
    effects,
    audio,
    markers,
    backgroundImageUrl: normalizeResourcePath(resourceIndex.projectName, scene.backgroundImage),
    backgroundVideoUrl: normalizeResourcePath(resourceIndex.projectName, scene.backgroundVideo),
    foregroundImageUrl: normalizeResourcePath(resourceIndex.projectName, scene.foregroundImage),
  };
}

function collectWorkbookCoverageDiagnostics(
  workbook: WorkbookData,
  resourceIndex: ResourceIndex,
  available: Set<string>,
  diagnostics: string[],
): void {
  const workbookStepSet = new Set(
    workbook.scenes
      .filter((scene) => scene.sceneType === "puzzle_scene" && scene.step != null)
      .map((scene) => scene.step as number),
  );

  for (const step of resourceIndex.steps) {
    if (!workbookStepSet.has(step.step)) {
      diagnostics.push(`Detected puzzle step ${step.step} from folder scan, but workbook does not define a puzzle_scene row for it.`);
    }
  }

  for (const resource of workbook.resources) {
    pushMissingResourceDiagnostic(diagnostics, available, resourceIndex.projectName, `Resources sheet`, resource.resourcePath);
  }

  if (!workbook.scenes.length) {
    diagnostics.push("Workbook has no scenes. Add rows to the Scenes sheet.");
  }
}

export function resolveProjectModelData(
  workbook: WorkbookData,
  resourceIndex: ResourceIndex,
): Pick<ProjectModel, "diagnostics" | "scenes" | "uiResources"> {
  const diagnostics: string[] = [];
  const availableResources = collectAvailableResources(resourceIndex);
  const uiResources = resolveUiResources(resourceIndex, availableResources);
  const scenes = workbook.scenes.map((scene) =>
    resolveScene(scene, workbook, resourceIndex, availableResources, diagnostics),
  );

  collectWorkbookCoverageDiagnostics(workbook, resourceIndex, availableResources, diagnostics);

  return {
    diagnostics,
    scenes,
    uiResources,
  };
}
