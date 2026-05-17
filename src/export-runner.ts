import type { ProjectModel, ResourceIndex, ResolvedScene, WorkbookData } from "./runtime/project-types";
import { buildProjectModel } from "./runtime/build-project-model";
import { loadProjectWorkbook } from "./runtime/load-project-workbook";
import { PixiPreviewApp } from "./runtime/pixi-preview-app";
import { PreviewSession } from "./runtime/preview-session";
import { shouldUseBookTransition } from "./runtime/scene-flow-policy";
import { applyLandscapeTimeoutEndSound } from "./runtime/timeout-end-sound";
import { buildTimeline, collectSceneDurations } from "./runtime/export-timeline";
import type { ExportTimeline, ExportProgress, OfflineExportOptions } from "./runtime/export-shared";
import { exportProjectOfflineMp4 } from "./runtime/video-exporter";

const params = new URLSearchParams(globalThis.location.search);
const WORKBOOK_PATH = params.get("workbook") ?? "/projects/sample/scene-flow.xlsx";
const INDEX_PATH = params.get("index") ?? "/projects/sample/project-index.json";
const EXPORT_SCALE = parseExportScale(params.get("exportScale"));
const EXPORT_LAYOUT = parseExportLayout(params.get("layout"));
const EXPORT_SCENE_IDS = parseSceneIds(params.get("scenes"));
type ExportLayout = "landscape" | "shorts";

interface RunnerExportOptions {
  ffmpegServiceBaseUrl?: string;
  fileName?: string;
  outputPath?: string;
}

interface RunnerState {
  phase: "booting" | "ready" | "running" | "completed" | "failed" | "cancelled";
  message: string;
  outputPath: string | null;
  fileName: string | null;
  error: string | null;
  wasCancelled: boolean;
  progress: number;
  elapsedSec: number;
  etaSec: number | null;
}

interface SpotExportRunnerApi {
  ensureReady(): Promise<RunnerState>;
  beginExport(options?: RunnerExportOptions): Promise<void>;
  cancelExport(): void;
  getState(): RunnerState;
}

interface PreparedRunnerState {
  project: Awaited<ReturnType<typeof buildProjectModel>>;
  preview: PixiPreviewApp;
  previewSession: PreviewSession;
  timeline: ExportTimeline;
}

declare global {
  interface Window {
    __spotExportRunner?: SpotExportRunnerApi;
    __spotExportWorkbookData?: WorkbookData;
  }
}

function createSilentAudioTransport() {
  return {
    loadScene(): void {
      // Export renders audio offline from the same timeline.
    },
    setPlaying(): void {
      // no-op
    },
    setTime(): void {
      // no-op
    },
    reset(): void {
      // no-op
    },
  };
}

function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return "--:--";
  }

  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function parseExportScale(value: string | null): number {
  const parsed = Number.parseFloat(value ?? "");
  if (!Number.isFinite(parsed)) {
    return 1;
  }

  return Math.min(2, Math.max(1, parsed));
}

function parseExportLayout(value: string | null): ExportLayout {
  return value === "shorts" ? "shorts" : "landscape";
}

function parseSceneIds(value: string | null): string[] {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function collectPuzzleResultSceneIds(project: ProjectModel, puzzleScene: ResolvedScene): string[] {
  const startIndex = project.scenes.findIndex((scene) => scene.sceneId === puzzleScene.sceneId);
  if (startIndex < 0 || puzzleScene.step == null) {
    return [puzzleScene.sceneId];
  }

  const sceneIds: string[] = [];
  for (let index = startIndex; index < project.scenes.length; index += 1) {
    const scene = project.scenes[index];
    if (index > startIndex && scene.sceneType === "puzzle_scene" && scene.step !== puzzleScene.step) {
      break;
    }

    if (index > startIndex && scene.sceneType === "title_card") {
      break;
    }

    if (
      scene.sceneId === puzzleScene.sceneId ||
      scene.step === puzzleScene.step ||
      scene.sceneType === "answer_reveal" ||
      scene.sceneType === "timeout_card"
    ) {
      sceneIds.push(scene.sceneId);
    }
  }

  return sceneIds.length ? sceneIds : [puzzleScene.sceneId];
}

function expandRequestedSceneIds(project: ProjectModel, sceneIds: string[]): string[] {
  const requestedSceneIds = new Set(sceneIds);
  for (const sceneId of sceneIds) {
    const scene = project.scenes.find((entry) => entry.sceneId === sceneId);
    if (scene?.sceneType !== "puzzle_scene") {
      continue;
    }

    for (const resultSceneId of collectPuzzleResultSceneIds(project, scene)) {
      requestedSceneIds.add(resultSceneId);
    }
  }

  return project.scenes
    .filter((scene) => requestedSceneIds.has(scene.sceneId))
    .map((scene) => scene.sceneId);
}

function filterProjectScenes(project: ProjectModel, sceneIds: string[]): ProjectModel {
  if (!sceneIds.length) {
    return project;
  }

  const requestedSceneIds = new Set(expandRequestedSceneIds(project, sceneIds));
  const scenes = project.scenes.filter((scene) => requestedSceneIds.has(scene.sceneId));
  if (!scenes.length) {
    throw new Error(`No export scenes matched: ${sceneIds.join(", ")}`);
  }

  return {
    ...project,
    scenes,
  };
}

function applyExportLayout(project: ProjectModel, layout: ExportLayout): ProjectModel {
  if (layout !== "shorts") {
    return project;
  }

  return {
    ...project,
    width: 720,
    height: 1280,
  };
}

async function prepareExportProject(project: ProjectModel, layout: ExportLayout): Promise<ProjectModel> {
  return await applyLandscapeTimeoutEndSound(applyExportLayout(project, layout));
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}`);
  }

  return (await response.json()) as T;
}

let bootPromise: Promise<RunnerState> | null = null;
let exportPromise: Promise<void> | null = null;
let cancelRequested = false;
let preparedState: PreparedRunnerState | null = null;

const state: RunnerState = {
  phase: "booting",
  message: "Booting export runner...",
  outputPath: null,
  fileName: null,
  error: null,
  wasCancelled: false,
  progress: 0,
  elapsedSec: 0,
  etaSec: null,
};

function updateProgress(elapsedSec: number, totalDurationSec: number, sceneId: string): void {
  state.elapsedSec = elapsedSec;
  if (totalDurationSec > 0) {
    const ratio = Math.min(1, elapsedSec / totalDurationSec);
    state.progress = ratio;
    state.etaSec = ratio > 0 ? Math.max(0, totalDurationSec - elapsedSec) : totalDurationSec;
    state.message = `${Math.round(ratio * 100)}% · ETA ${formatEta(state.etaSec)} · Capturing scene ${sceneId}`;
    return;
  }

  state.progress = 0;
  state.etaSec = null;
  state.message = `Capturing scene ${sceneId}`;
}

async function ensureReady(): Promise<RunnerState> {
  if (bootPromise) {
    return bootPromise;
  }

  bootPromise = (async () => {
    const [resourceIndex, workbookData] = await Promise.all([
      fetchJson<ResourceIndex>(INDEX_PATH),
      window.__spotExportWorkbookData
        ? Promise.resolve(window.__spotExportWorkbookData)
        : loadProjectWorkbook(WORKBOOK_PATH),
    ]);

    const project = await prepareExportProject(
      filterProjectScenes(buildProjectModel(workbookData as WorkbookData, resourceIndex), EXPORT_SCENE_IDS),
      EXPORT_LAYOUT,
    );
    if (!project.scenes.length) {
      throw new Error("No scenes are available for export.");
    }
    const stageHost = document.querySelector<HTMLElement>("#export-stage");
    if (!stageHost) {
      throw new Error("Export stage host is missing.");
    }

    const preview = new PixiPreviewApp(stageHost);
    await preview.init(project.width, project.height, {
      resolution: EXPORT_SCALE,
    });

    const previewSession = new PreviewSession(preview, createSilentAudioTransport(), {
      transitionResolver: shouldUseBookTransition,
    });

    await previewSession.loadProject(project, {
      sceneId: project.scenes[0]?.sceneId,
    });

    const offlineOptions = {
      project,
      preview,
      fps: project.fps,
      applyScene: async (sceneId: string, startAt = 0, applyOptions?: { useBookTransition?: boolean }) => {
        await previewSession.applyScene(sceneId, startAt, {
          transition: applyOptions?.useBookTransition ? "book" : "none",
        });
      },
      getActiveScene: (): ResolvedScene => {
        const scene = previewSession.getActiveScene();
        if (!scene) {
          throw new Error("No active scene is available.");
        }

        return scene;
      },
      shouldUseBookTransition,
      onStatus: ({ message }: { message: string }) => {
        state.message = message;
      },
      isCancelled: () => cancelRequested,
    };

    const sceneDurations = await collectSceneDurations(offlineOptions);
    const timeline = buildTimeline(sceneDurations, shouldUseBookTransition);

    await previewSession.loadProject(project, {
      sceneId: project.scenes[0]?.sceneId,
    });

    preparedState = {
      project,
      preview,
      previewSession,
      timeline,
    };

    state.phase = "ready";
    const outputSize = preview.getProjectSize();
    const layoutLabel = EXPORT_LAYOUT === "shorts" ? "shorts" : "landscape";
    state.message = outputSize
      ? `Export runner ready. ${layoutLabel} timeline ${timeline.totalDurationSec.toFixed(2)}s · ${outputSize.width} x ${outputSize.height}`
      : `Export runner ready. ${layoutLabel} timeline ${timeline.totalDurationSec.toFixed(2)}s`;
    return { ...state };
  })().catch((error) => {
    state.phase = "failed";
    state.error = error instanceof Error ? error.message : "Unknown export bootstrap error.";
    state.message = state.error;
    throw error;
  });

  return bootPromise;
}

async function beginExport(options: RunnerExportOptions = {}): Promise<void> {
  await ensureReady();
  if (!preparedState) {
    throw new Error("Export runner is not initialized.");
  }

  if (exportPromise) {
    return exportPromise;
  }

  cancelRequested = false;
  state.phase = "running";
  state.message = "Preparing capture stream...";
  state.outputPath = null;
  state.fileName = null;
  state.error = null;
  state.wasCancelled = false;
  state.progress = 0;
  state.elapsedSec = 0;
  state.etaSec = null;

  exportPromise = (async () => {
    const { project, preview, previewSession, timeline } = preparedState!;
    const wallStartedAt = performance.now();
    const updateDeterministicProgress = (progressInfo: ExportProgress): void => {
      const rawProgress = Math.max(0, Math.min(1, progressInfo.progress));
      const smoothedProgress = Math.min(0.96, rawProgress * 0.96);
      const elapsedSec = Math.max(0, (performance.now() - wallStartedAt) / 1000);
      state.progress = smoothedProgress;
      state.elapsedSec = Math.min(timeline.totalDurationSec, rawProgress * timeline.totalDurationSec);
      state.etaSec = rawProgress > 0 ? Math.max(0, (elapsedSec / rawProgress) - elapsedSec) : null;
      state.message = `${Math.round(rawProgress * 100)}% · ETA ${formatEta(state.etaSec)} · ${progressInfo.message}`;
    };

    const offlineOptions: OfflineExportOptions = {
      project,
      preview,
      fps: project.fps,
      applyScene: async (sceneId, startAt = 0, applyOptions) => {
        await previewSession.applyScene(sceneId, startAt, {
          transition: applyOptions?.useBookTransition ? "book" : "none",
        });
      },
      getActiveScene: (): ResolvedScene => {
        const scene = previewSession.getActiveScene();
        if (!scene) {
          throw new Error("No active scene is available.");
        }

        return scene;
      },
      shouldUseBookTransition,
      onStatus: ({ message }) => {
        state.message = message;
      },
      onProgress: updateDeterministicProgress,
      isCancelled: () => cancelRequested,
    };

    await previewSession.loadProject(project, {
      sceneId: project.scenes[0]?.sceneId,
      startAt: 0,
    });

    const result = await exportProjectOfflineMp4(offlineOptions, {
      baseUrl: options.ffmpegServiceBaseUrl,
      fileName: options.fileName,
      outputPath: options.outputPath,
      fps: project.fps,
      requestTimeoutMs: 60 * 60 * 1000,
    });

    state.outputPath = result.outputPath;
    state.fileName = result.fileName;
    state.wasCancelled = result.wasCancelled;
    state.progress = 1;
    state.elapsedSec = timeline.totalDurationSec;
    state.etaSec = 0;
    state.phase = result.wasCancelled ? "cancelled" : "completed";
    state.message = result.wasCancelled
      ? `Partial MP4 saved: ${result.outputPath}`
      : `MP4 saved: ${result.outputPath}`;
  })().catch((error) => {
    const message = error instanceof Error ? error.message : "Capture export failed.";
    state.phase = cancelRequested ? "cancelled" : "failed";
    state.error = message;
    state.message = cancelRequested ? `Export cancelled: ${message}` : message;
  }).finally(() => {
    exportPromise = null;
  });

  return exportPromise;
}

function cancelExport(): void {
  cancelRequested = true;
  if (state.phase === "running") {
    state.message = "Cancellation requested...";
  }
}

function getState(): RunnerState {
  return { ...state };
}

window.__spotExportRunner = {
  ensureReady,
  beginExport,
  cancelExport,
  getState,
};

void ensureReady();
