import "./styles.css";

import type { ProjectModel, ResourceIndex, ResolvedScene, WorkbookData } from "./runtime/project-types";
import { AdminAuthoringPanel } from "./runtime/admin-authoring-panel";
import { AudioPreviewController } from "./runtime/audio-preview-controller";
import { buildProjectModel } from "./runtime/build-project-model";
import { loadProjectWorkbook } from "./runtime/load-project-workbook";
import { PixiPreviewApp } from "./runtime/pixi-preview-app";
import { PreviewSession } from "./runtime/preview-session";
import { shouldUseBookTransition } from "./runtime/scene-flow-policy";
import { applyLandscapeTimeoutEndSound } from "./runtime/timeout-end-sound";
import { checkOfflineMp4ExportHealth } from "./runtime/video-exporter";
import { WorkbookPersistence } from "./runtime/workbook-persistence";
import {
  cancelOfflineExportJob,
  getOfflineExportJob,
  openOfflineExportFolder,
  startOfflineExportJob,
} from "./runtime/offline-export-job-client";
import type { OfflineExportJobCreateOptions, OfflineExportJobSummary } from "./runtime/offline-export-job-client";

const WORKBOOK_PATH = "/projects/sample/scene-flow.xlsx";
const INDEX_PATH = "/projects/sample/project-index.json";
const SHORTS_WIDTH = 720;
const SHORTS_HEIGHT = 1280;
const STEP_GROUP_EXPORT_SIZE = 10;
type ExportLayout = "landscape" | "shorts";
type ExportScope = "all" | "current-scene" | "current-step" | "step-groups-10";

interface StepGroupExportPart {
  partIndex: number;
  totalParts: number;
  stepStart: number;
  stepEnd: number;
  sceneIds: string[];
  fileName: string;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}`);
  }

  return (await response.json()) as T;
}

function renderSummary(project: ProjectModel): void {
  const summary = document.querySelector<HTMLDListElement>("#project-summary");
  if (!summary) return;

  summary.innerHTML = "";
  const items: Array<[string, string]> = [
    ["Project", project.projectName],
    ["Resolution", `${project.width} x ${project.height}`],
    ["FPS", String(project.fps)],
    ["Detected Steps", String(project.detectedStepCount)],
    ["Scenes", String(project.scenes.length)],
    ["Workbook", WORKBOOK_PATH],
  ];

  for (const [term, detail] of items) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = detail;
    summary.append(dt, dd);
  }
}

function renderDiagnostics(project: ProjectModel): void {
  const list = document.querySelector<HTMLUListElement>("#diagnostics");
  if (!list) return;

  list.innerHTML = "";
  const entries = project.diagnostics.length
    ? project.diagnostics
    : [
        "Workbook rows and folder scan are synced successfully.",
        "Puzzle step count is detected from images/puzzles file names.",
      ];

  for (const item of entries) {
    const li = document.createElement("li");
    li.textContent = item;
    list.append(li);
  }
}

function updateTimeReadout(current: number, total: number): void {
  const readout = document.querySelector<HTMLParagraphElement>("#time-readout");
  if (readout) {
    readout.textContent = `${current.toFixed(2)}s / ${total.toFixed(2)}s`;
  }
}

function updateExportStatus(message: string): void {
  const readout = document.querySelector<HTMLParagraphElement>("#export-status");
  if (readout) {
    readout.textContent = message;
  }
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

function buildExportStatusLine(job: {
  message: string;
  progress: number;
  etaSec: number | null;
}): string {
  if (job.progress > 0 && job.progress < 1) {
    return `${Math.round(job.progress * 100)}% · ETA ${formatEta(job.etaSec)} · ${job.message}`;
  }

  return job.message;
}

function readSelectedExportScale(select: HTMLSelectElement): number {
  const parsed = Number.parseFloat(select.value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function readSelectedExportLayout(select: HTMLSelectElement): ExportLayout {
  return select.value === "shorts" ? "shorts" : "landscape";
}

function readSelectedExportScope(select: HTMLSelectElement): ExportScope {
  if (select.value === "current-scene" || select.value === "current-step" || select.value === "step-groups-10") {
    return select.value;
  }

  return "all";
}

function updateExportResolutionLabels(select: HTMLSelectElement, layout: ExportLayout): void {
  const labels = layout === "shorts"
    ? new Map([
        ["1", "Shorts 720 x 1280"],
        ["1.5", "Shorts 1080 x 1920"],
        ["2", "Shorts 1440 x 2560"],
      ])
    : new Map([
        ["1", "720p - 1280 x 720"],
        ["1.5", "1080p - 1920 x 1080"],
        ["2", "1440p - 2560 x 1440"],
      ]);

  for (const option of Array.from(select.options)) {
    option.textContent = labels.get(option.value) ?? option.textContent;
  }
}

function getExportSceneIds(scope: ExportScope, project: ProjectModel, activeScene: ResolvedScene | null): string[] | undefined {
  if (scope === "current-scene") {
    return activeScene ? [activeScene.sceneId] : undefined;
  }

  if (scope === "current-step" && activeScene?.step != null) {
    const sceneIds = project.scenes
      .filter((scene) => scene.step === activeScene.step)
      .map((scene) => scene.sceneId);
    return sceneIds.length ? sceneIds : undefined;
  }

  return undefined;
}

function sanitizeExportFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function dedupeSceneIds(sceneIds: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const sceneId of sceneIds) {
    if (seen.has(sceneId)) {
      continue;
    }

    seen.add(sceneId);
    result.push(sceneId);
  }

  return result;
}

function collectOrderedPuzzleSteps(project: ProjectModel): number[] {
  const seen = new Set<number>();
  const steps: number[] = [];
  for (const scene of project.scenes) {
    if (scene.sceneType !== "puzzle_scene" || scene.step == null || seen.has(scene.step)) {
      continue;
    }

    seen.add(scene.step);
    steps.push(scene.step);
  }

  return steps;
}

function createStepGroupExportParts(project: ProjectModel, groupSize: number): StepGroupExportPart[] {
  const steps = collectOrderedPuzzleSteps(project);
  if (!steps.length) {
    return [];
  }

  const firstStepSceneIndex = project.scenes.findIndex((scene) => scene.step != null);
  const lastStepSceneIndex = project.scenes.reduce(
    (lastIndex, scene, index) => (scene.step == null ? lastIndex : index),
    -1,
  );
  const introSceneIds = project.scenes
    .filter((scene, index) => scene.sceneType === "title_card" && index < firstStepSceneIndex)
    .map((scene) => scene.sceneId);
  const endingSceneIds = project.scenes
    .filter((scene, index) => scene.sceneType === "timeout_card" && index > lastStepSceneIndex)
    .map((scene) => scene.sceneId);
  const totalParts = Math.ceil(steps.length / groupSize);
  const projectFilePart = sanitizeExportFilePart(project.projectName);

  return Array.from({ length: totalParts }, (_, partIndex) => {
    const partSteps = steps.slice(partIndex * groupSize, (partIndex + 1) * groupSize);
    const partStepSet = new Set(partSteps);
    const stepSceneIds = project.scenes
      .filter((scene) => scene.step != null && partStepSet.has(scene.step))
      .map((scene) => scene.sceneId);
    const partNumber = String(partIndex + 1).padStart(2, "0");
    const totalPartNumber = String(totalParts).padStart(2, "0");

    return {
      partIndex,
      totalParts,
      stepStart: partSteps[0] ?? 0,
      stepEnd: partSteps[partSteps.length - 1] ?? 0,
      sceneIds: dedupeSceneIds([...introSceneIds, ...stepSceneIds, ...endingSceneIds]),
      fileName: `${projectFilePart}-part-${partNumber}-of-${totalPartNumber}-end.mp4`,
    };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function applyExportLayoutToProject(project: ProjectModel, layout: ExportLayout): ProjectModel {
  if (layout !== "shorts") {
    return project;
  }

  return {
    ...project,
    width: SHORTS_WIDTH,
    height: SHORTS_HEIGHT,
  };
}

async function prepareLayoutProject(project: ProjectModel, layout: ExportLayout): Promise<ProjectModel> {
  return await applyLandscapeTimeoutEndSound(applyExportLayoutToProject(project, layout));
}

function fillSceneSelect(select: HTMLSelectElement, scenes: ResolvedScene[], activeSceneId: string): void {
  select.innerHTML = "";
  for (const scene of scenes) {
    const option = document.createElement("option");
    option.value = scene.sceneId;
    option.textContent = `${scene.sceneId} - ${scene.sceneType}`;
    option.selected = scene.sceneId === activeSceneId;
    select.append(option);
  }
}

async function bootstrap(): Promise<void> {
  const [resourceIndex, initialWorkbook] = await Promise.all([
    fetchJson<ResourceIndex>(INDEX_PATH),
    loadProjectWorkbook(WORKBOOK_PATH),
  ]);

  const stageHost = document.querySelector<HTMLElement>("#pixi-stage");
  const sceneSelect = document.querySelector<HTMLSelectElement>("#scene-select");
  const timeSlider = document.querySelector<HTMLInputElement>("#time-slider");
  const playToggle = document.querySelector<HTMLButtonElement>("#play-toggle");
  const resetButton = document.querySelector<HTMLButtonElement>("#reset-button");
  const exportVideoButton = document.querySelector<HTMLButtonElement>("#export-video-button");
  const exportStopButton = document.querySelector<HTMLButtonElement>("#export-stop-button");
  const exportOpenFolderButton = document.querySelector<HTMLButtonElement>("#export-open-folder-button");
  const exportResolutionSelect = document.querySelector<HTMLSelectElement>("#export-resolution-select");
  const exportLayoutSelect = document.querySelector<HTMLSelectElement>("#export-layout-select");
  const exportScopeSelect = document.querySelector<HTMLSelectElement>("#export-scope-select");

  if (
    !stageHost ||
    !sceneSelect ||
    !timeSlider ||
    !playToggle ||
    !resetButton ||
    !exportVideoButton ||
    !exportStopButton ||
    !exportOpenFolderButton ||
    !exportResolutionSelect ||
    !exportLayoutSelect ||
    !exportScopeSelect
  ) {
    throw new Error("UI bootstrap failed");
  }

  let workbookData: WorkbookData = initialWorkbook;
  let sourceProject = buildProjectModel(workbookData, resourceIndex);
  let project = await prepareLayoutProject(sourceProject, readSelectedExportLayout(exportLayoutSelect));
  let audioPreview = new AudioPreviewController(project);
  const preview = new PixiPreviewApp(stageHost);
  const workbookPersistence = new WorkbookPersistence(WORKBOOK_PATH);
  let adminPanel: AdminAuthoringPanel | null = null;

  const syncStageLayout = (): void => {
    stageHost.classList.toggle("stage-frame-shorts", readSelectedExportLayout(exportLayoutSelect) === "shorts");
  };

  syncStageLayout();
  await preview.init(project.width, project.height);
  let previewSession = new PreviewSession(preview, audioPreview, {
    transitionResolver: shouldUseBookTransition,
  });
  let sessionState = await previewSession.loadProject(project, {
    sceneId: project.scenes[0]?.sceneId,
  });
  let exportInProgress = false;
  let exportJobId: string | null = null;
  let exportPollTimer = 0;
  let lastExportOutputPath: string | null = null;
  let exportStopRequested = false;
  let previewReloadInProgress = false;

  const syncProjectViews = (): void => {
    renderSummary(project);
    renderDiagnostics(project);
    fillSceneSelect(sceneSelect, project.scenes, sessionState.activeScene?.sceneId ?? project.scenes[0]?.sceneId ?? "");
  };

  const syncControlLocks = (): void => {
    exportVideoButton.disabled = exportInProgress;
    exportStopButton.disabled = !exportInProgress;
    exportOpenFolderButton.disabled = exportInProgress || !lastExportOutputPath;
    exportResolutionSelect.disabled = exportInProgress;
    exportLayoutSelect.disabled = exportInProgress;
    exportScopeSelect.disabled = exportInProgress;
    sceneSelect.disabled = previewReloadInProgress;
    timeSlider.disabled = previewReloadInProgress;
    playToggle.disabled = previewReloadInProgress;
    resetButton.disabled = previewReloadInProgress;
  };

  const syncSessionUi = (nextState = previewSession.getSnapshot()): void => {
    sessionState = nextState;
    const activeScene = sessionState.activeScene;
    const durationSec = sessionState.durationSec || activeScene?.durationSec || 0;

    timeSlider.max = String(durationSec || 1);
    timeSlider.value = String(sessionState.currentTimeSec);
    updateTimeReadout(sessionState.currentTimeSec, durationSec);
    playToggle.textContent = sessionState.isPlaying ? "Pause" : "Play";

    if (activeScene && !nextState.sceneTransitioning) {
      sceneSelect.value = activeScene.sceneId;
    }
  };

  const reloadPreviewProject = async (keepSceneId: string, keepTime: number): Promise<void> => {
    previewReloadInProgress = true;
    syncControlLocks();

    try {
      project = await prepareLayoutProject(sourceProject, readSelectedExportLayout(exportLayoutSelect));
      syncStageLayout();
      preview.resize(project.width, project.height);
      audioPreview.dispose();
      audioPreview = new AudioPreviewController(project);
      previewSession = new PreviewSession(preview, audioPreview, {
        transitionResolver: shouldUseBookTransition,
      });
      sessionState = await previewSession.loadProject(project, {
        sceneId: keepSceneId || project.scenes[0]?.sceneId,
        startAt: keepTime,
      });
      syncProjectViews();
      syncSessionUi(sessionState);
      adminPanel?.setData(project, workbookData);
    } finally {
      previewReloadInProgress = false;
      syncControlLocks();
    }
  };

  const rebuildProject = async (nextWorkbook: WorkbookData): Promise<void> => {
    const keepSceneId = sessionState.activeScene?.sceneId ?? "";
    const keepTime = sessionState.currentTimeSec;
    workbookData = nextWorkbook;
    sourceProject = buildProjectModel(workbookData, resourceIndex);
    await reloadPreviewProject(keepSceneId, keepTime);
  };

  adminPanel = new AdminAuthoringPanel({
    project,
    workbook: workbookData,
    persistence: workbookPersistence,
    onWorkbookChange: async (nextWorkbook) => {
      await rebuildProject(nextWorkbook);
    },
  });

  syncProjectViews();
  syncSessionUi(sessionState);

  sceneSelect.addEventListener("change", async () => {
    if (previewReloadInProgress) {
      return;
    }

    const requestedSceneId = sceneSelect.value;
    syncSessionUi(
      await previewSession.applyScene(requestedSceneId, 0, {
        transition: "auto",
      }),
    );
  });

  timeSlider.addEventListener("input", () => {
    syncSessionUi(previewSession.seek(Number(timeSlider.value)));
  });

  playToggle.addEventListener("click", () => {
    syncSessionUi(previewSession.setPlaying(!sessionState.isPlaying));
  });

  resetButton.addEventListener("click", () => {
    syncSessionUi(previewSession.reset());
  });

  exportLayoutSelect.addEventListener("change", () => {
    updateExportResolutionLabels(exportResolutionSelect, readSelectedExportLayout(exportLayoutSelect));
    void reloadPreviewProject(sceneSelect.value || sessionState.activeScene?.sceneId || "", sessionState.currentTimeSec).catch((error) => {
      updateExportStatus(error instanceof Error ? `Layout preview failed: ${error.message}` : "Layout preview failed.");
    });
  });

  const stopExportPolling = (): void => {
    if (exportPollTimer) {
      window.clearInterval(exportPollTimer);
      exportPollTimer = 0;
    }
  };

  const finishExportJob = (): void => {
    exportInProgress = false;
    exportJobId = null;
    exportStopRequested = false;
    stopExportPolling();
    syncControlLocks();
  };

  const pollExportJob = async (): Promise<void> => {
    if (!exportJobId) {
      stopExportPolling();
      return;
    }

    try {
      const job = await getOfflineExportJob(exportJobId);
      updateExportStatus(buildExportStatusLine(job));

      if (job.status === "completed") {
        lastExportOutputPath = job.outputPath;
        updateExportStatus(job.outputPath ? `MP4 saved: ${job.outputPath}` : job.message);
        finishExportJob();
        return;
      }

      if (job.status === "cancelled") {
        lastExportOutputPath = job.outputPath;
        updateExportStatus(job.outputPath ? `Partial MP4 saved: ${job.outputPath}` : "Offline export cancelled.");
        finishExportJob();
        return;
      }

      if (job.status === "failed") {
        updateExportStatus(job.error ? `Export failed: ${job.error}` : "Offline export failed.");
        finishExportJob();
      }
    } catch (error) {
      updateExportStatus(error instanceof Error ? `Export job status failed: ${error.message}` : "Export job status failed.");
      finishExportJob();
    }
  };

  const buildCommonExportOptions = (): OfflineExportJobCreateOptions => ({
    workbookPath: WORKBOOK_PATH,
    workbookData,
    indexPath: INDEX_PATH,
    appBaseUrl: globalThis.location.origin,
    exportScale: readSelectedExportScale(exportResolutionSelect),
    exportLayout: readSelectedExportLayout(exportLayoutSelect),
  });

  const waitForExportJob = async (
    jobId: string,
    statusPrefix: string,
  ): Promise<OfflineExportJobSummary> => {
    let cancelSent = false;
    while (true) {
      const job = await getOfflineExportJob(jobId);
      updateExportStatus(`${statusPrefix}${buildExportStatusLine(job)}`);

      if (job.status === "completed" || job.status === "cancelled" || job.status === "failed") {
        return job;
      }

      if (exportStopRequested && !cancelSent) {
        cancelSent = true;
        await cancelOfflineExportJob(jobId);
      }

      await sleep(1000);
    }
  };

  const exportProjectStepGroups = async (): Promise<void> => {
    const parts = createStepGroupExportParts(project, STEP_GROUP_EXPORT_SIZE);
    if (!parts.length) {
      throw new Error("No puzzle steps are available for grouped export.");
    }

    const savedPaths: string[] = [];
    const commonOptions = buildCommonExportOptions();

    for (const part of parts) {
      if (exportStopRequested) {
        updateExportStatus(`Grouped export cancelled before part ${part.partIndex + 1}/${part.totalParts}.`);
        return;
      }

      updateExportStatus(
        `Starting part ${part.partIndex + 1}/${part.totalParts} · steps ${part.stepStart}-${part.stepEnd}...`,
      );
      const job = await startOfflineExportJob({
        ...commonOptions,
        sceneIds: part.sceneIds,
        fileName: part.fileName,
      });
      exportJobId = job.id;

      const completedJob = await waitForExportJob(
        job.id,
        `Part ${part.partIndex + 1}/${part.totalParts} · steps ${part.stepStart}-${part.stepEnd} · `,
      );
      exportJobId = null;

      if (completedJob.outputPath) {
        lastExportOutputPath = completedJob.outputPath;
        savedPaths.push(completedJob.outputPath);
      }

      if (completedJob.status === "failed") {
        throw new Error(completedJob.error ?? completedJob.message);
      }

      if (completedJob.status === "cancelled") {
        updateExportStatus(
          completedJob.outputPath
            ? `Grouped export cancelled. Partial MP4 saved: ${completedJob.outputPath}`
            : "Grouped export cancelled.",
        );
        return;
      }
    }

    updateExportStatus(
      savedPaths.length
        ? `Grouped export completed: ${savedPaths.length}/${parts.length} files. Last MP4: ${savedPaths[savedPaths.length - 1]}`
        : "Grouped export completed, but no output path was returned.",
    );
  };

  const exportProjectVideo = async (): Promise<void> => {
    if (exportInProgress) {
      return;
    }

    exportInProgress = true;
    lastExportOutputPath = null;
    exportStopRequested = false;
    syncControlLocks();
    updateExportStatus("Checking ffmpeg export service...");

    try {
      const health = await checkOfflineMp4ExportHealth();
      if (!health.ok) {
        throw new Error(
          `ffmpeg export service is unavailable (status ${health.status}). Start it with "npm run dev:mp4" or "npm run export:service".`,
        );
      }

      const exportScope = readSelectedExportScope(exportScopeSelect);
      if (exportScope === "step-groups-10") {
        stopExportPolling();
        await exportProjectStepGroups();
        exportInProgress = false;
        exportStopRequested = false;
        syncControlLocks();
        return;
      }

      const job = await startOfflineExportJob({
        ...buildCommonExportOptions(),
        sceneIds: getExportSceneIds(
          exportScope,
          project,
          project.scenes.find((scene) => scene.sceneId === sceneSelect.value) ?? sessionState.activeScene,
        ),
      });
      exportJobId = job.id;
      updateExportStatus(job.message);
      exportPollTimer = window.setInterval(() => {
        void pollExportJob();
      }, 1000);
      void pollExportJob();
    } catch (error) {
      updateExportStatus(error instanceof Error ? `Export failed: ${error.message}` : "Export failed.");
      exportInProgress = false;
      exportJobId = null;
      exportStopRequested = false;
      syncControlLocks();
    }
  };

  exportVideoButton.addEventListener("click", () => {
    void exportProjectVideo();
  });

  exportStopButton.addEventListener("click", () => {
    exportStopRequested = true;
    if (!exportJobId) {
      updateExportStatus("Export stop requested. Waiting for current part to settle...");
      return;
    }

    updateExportStatus("Requesting offline export cancellation...");
    void cancelOfflineExportJob(exportJobId).catch((error) => {
      updateExportStatus(error instanceof Error ? `Cancel failed: ${error.message}` : "Cancel failed.");
      finishExportJob();
    });
  });

  exportOpenFolderButton.addEventListener("click", () => {
    if (!lastExportOutputPath || exportInProgress) {
      return;
    }

    updateExportStatus("Opening export folder...");
    void openOfflineExportFolder(lastExportOutputPath)
      .then((result) => {
        updateExportStatus(`Opened export folder: ${result.folderPath}`);
      })
      .catch((error) => {
        updateExportStatus(error instanceof Error ? `Open folder failed: ${error.message}` : "Open folder failed.");
      });
  });

  const tick = async (nowMs: number): Promise<void> => {
    if (!exportInProgress) {
      syncSessionUi((await previewSession.tick(nowMs)).state);
    }

    requestAnimationFrame((nextMs) => {
      void tick(nextMs);
    });
  };

  adminPanel.setData(project, workbookData);
  updateExportResolutionLabels(exportResolutionSelect, readSelectedExportLayout(exportLayoutSelect));
  syncControlLocks();
  updateExportStatus('Ready to export MP4 timeline. Start the service with "npm run dev:mp4" or "npm run export:service".');
  requestAnimationFrame((nowMs) => {
    void tick(nowMs);
  });
}

bootstrap().catch((error) => {
  console.error(error);
  const list = document.querySelector<HTMLUListElement>("#diagnostics");
  if (list) {
    const li = document.createElement("li");
    li.textContent = error instanceof Error ? error.message : "Unknown bootstrap error";
    list.append(li);
  }
});
