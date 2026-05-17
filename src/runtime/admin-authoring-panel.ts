import type {
  MarkerRow,
  ProjectModel,
  ResolvedScene,
  StepResource,
  WorkbookData,
} from "./project-types";
import type { WorkbookPersistence } from "./workbook-persistence";
import {
  compareScenesForAuthoring,
  createMarkerDraftFromSurfaceClick,
  formatMarker,
  getSurfaceMarkerOverlays,
} from "./admin-authoring-helpers";

interface AdminAuthoringPanelOptions {
  project: ProjectModel;
  workbook: WorkbookData;
  persistence: WorkbookPersistence;
  onWorkbookChange: (workbook: WorkbookData) => Promise<void>;
}

interface SurfaceElements {
  root: HTMLElement;
  side: MarkerRow["side"];
}

export class AdminAuthoringPanel {
  private project: ProjectModel;
  private workbook: WorkbookData;
  private readonly persistence: WorkbookPersistence;
  private readonly onWorkbookChange: (workbook: WorkbookData) => Promise<void>;
  private readonly stepSelect: HTMLSelectElement;
  private readonly sceneSelect: HTMLSelectElement;
  private readonly radiusInput: HTMLInputElement;
  private readonly revealInput: HTMLInputElement;
  private readonly connectButton: HTMLButtonElement;
  private readonly exportButton: HTMLButtonElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly summary: HTMLElement;
  private readonly status: HTMLElement;
  private readonly markerList: HTMLUListElement;
  private readonly surfaces: SurfaceElements[];
  private selectedStep = 0;
  private selectedSceneId = "";

  constructor(options: AdminAuthoringPanelOptions) {
    this.project = options.project;
    this.workbook = options.workbook;
    this.persistence = options.persistence;
    this.onWorkbookChange = options.onWorkbookChange;
    this.stepSelect = this.requireElement("#admin-step-select");
    this.sceneSelect = this.requireElement("#admin-scene-select");
    this.radiusInput = this.requireElement("#admin-radius-input");
    this.revealInput = this.requireElement("#admin-reveal-input");
    this.connectButton = this.requireElement("#admin-connect-button");
    this.exportButton = this.requireElement("#admin-export-button");
    this.undoButton = this.requireElement("#admin-undo-button");
    this.clearButton = this.requireElement("#admin-clear-button");
    this.summary = this.requireElement("#admin-step-summary");
    this.status = this.requireElement("#admin-save-status");
    this.markerList = this.requireElement("#admin-marker-list");
    this.surfaces = [
      { root: this.requireElement("#admin-left-surface"), side: "left" },
      { root: this.requireElement("#admin-right-surface"), side: "right" },
    ];

    this.bindEvents();
    this.setData(this.project, this.workbook);
  }

  setData(project: ProjectModel, workbook: WorkbookData): void {
    const previousStep = this.selectedStep;
    const previousSceneId = this.selectedSceneId;
    this.project = project;
    this.workbook = workbook;

    this.renderStepOptions();
    this.selectedStep = this.resolveSelectedStep(previousStep);
    this.stepSelect.value = String(this.selectedStep);

    this.renderSceneOptions(previousSceneId);
    this.renderMarkerState();
  }

  private bindEvents(): void {
    this.stepSelect.addEventListener("change", () => {
      this.selectedStep = Number(this.stepSelect.value);
      this.renderSceneOptions(this.selectedSceneId);
      this.renderMarkerState();
    });

    this.sceneSelect.addEventListener("change", () => {
      this.selectedSceneId = this.sceneSelect.value;
      this.renderMarkerState();
    });

    this.connectButton.addEventListener("click", async () => {
      try {
        const connectResult = await this.persistence.connect();
        this.setStatus(connectResult.message);
        if (this.persistence.isConnected) {
          const saveResult = await this.persistence.save(this.workbook);
          this.setStatus(saveResult.message);
        }
      } catch (error) {
        this.setStatus(error instanceof Error ? error.message : "Workbook connection failed.");
      }
    });

    this.exportButton.addEventListener("click", async () => {
      try {
        const result = await this.persistence.export(this.workbook);
        this.setStatus(result.message);
      } catch (error) {
        this.setStatus(error instanceof Error ? error.message : "Workbook export failed.");
      }
    });

    this.undoButton.addEventListener("click", async () => {
      const nextMarkers = [...this.workbook.markers];
      const index = this.findLastMarkerIndex();
      if (index < 0) {
        this.setStatus("There is no marker to remove for the current step.");
        return;
      }

      nextMarkers.splice(index, 1);
      await this.commitWorkbook({ ...this.workbook, markers: nextMarkers });
    });

    this.clearButton.addEventListener("click", async () => {
      const nextMarkers = this.workbook.markers.filter(
        (marker) => !(marker.step === this.selectedStep && marker.sceneId === this.selectedSceneId),
      );

      if (nextMarkers.length === this.workbook.markers.length) {
        this.setStatus("There are no saved markers for the current step.");
        return;
      }

      await this.commitWorkbook({ ...this.workbook, markers: nextMarkers });
    });

    for (const surface of this.surfaces) {
      surface.root.addEventListener("click", async (event) => {
        await this.handleSurfaceClick(surface, event);
      });
    }
  }

  private async handleSurfaceClick(surface: SurfaceElements, event: MouseEvent): Promise<void> {
    const stepResource = this.getStepResource();
    if (!stepResource || !this.selectedSceneId) {
      this.setStatus("No step or target scene is selected.");
      return;
    }

    const image = surface.root.querySelector<HTMLImageElement>("img");
    if (!image || !image.naturalWidth || !image.naturalHeight) {
      this.setStatus("Image is not ready yet.");
      return;
    }

    const bounds = surface.root.getBoundingClientRect();
    const localX = event.clientX - bounds.left;
    const localY = event.clientY - bounds.top;
    const draft = createMarkerDraftFromSurfaceClick({
      sceneId: this.selectedSceneId,
      step: this.selectedStep,
      side: surface.side,
      localX,
      localY,
      surfaceWidth: bounds.width,
      surfaceHeight: bounds.height,
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      radius: Number(this.radiusInput.value) || 0.08,
      revealAtSec: Number(this.revealInput.value) || 0,
      strokeColor: "#ff4fd8",
      lineWidth: 8,
      texturePath: "resources/images/ui/markers/answer-marker.png",
    });

    if (!draft) {
      this.setStatus("Click inside the image bounds to save coordinates.");
      return;
    }

    await this.commitWorkbook({
      ...this.workbook,
      markers: [...this.workbook.markers, draft],
    });

    this.revealInput.value = String((draft.revealAtSec + 0.5).toFixed(1));
  }

  private async commitWorkbook(workbook: WorkbookData): Promise<void> {
    this.workbook = workbook;
    await this.onWorkbookChange(workbook);

    if (this.persistence.isConnected) {
      const result = await this.persistence.save(workbook);
      this.setStatus(result.message);
      return;
    }

    this.setStatus("Coordinates are updated in memory. Connect a workbook or use Save Copy to write them to file.");
  }

  private renderStepOptions(): void {
    this.stepSelect.innerHTML = "";
    for (const step of this.project.resourceIndex.steps) {
      const option = document.createElement("option");
      option.value = String(step.step);
      option.textContent = `STEP ${step.step}`;
      this.stepSelect.append(option);
    }
  }

  private renderSceneOptions(preferredSceneId: string): void {
    const scenes = this.getSceneCandidates();
    this.sceneSelect.innerHTML = "";

    for (const scene of scenes) {
      const option = document.createElement("option");
      option.value = scene.sceneId;
      option.textContent = `${scene.sceneId} (${scene.sceneType})`;
      this.sceneSelect.append(option);
    }

    this.selectedSceneId =
      scenes.find((scene) => scene.sceneId === preferredSceneId)?.sceneId ??
      scenes[0]?.sceneId ??
      "";

    this.sceneSelect.value = this.selectedSceneId;
  }

  private renderMarkerState(): void {
    const stepResource = this.getStepResource();
    const markers = this.getCurrentMarkers();
    this.summary.textContent = this.selectedSceneId
      ? `STEP ${this.selectedStep} / ${this.selectedSceneId} / ${markers.length} markers`
      : `STEP ${this.selectedStep} / no target scene`;

    this.renderSurface(this.surfaces[0], stepResource?.leftImage ?? "", markers.filter((marker) => marker.side === "left"));
    this.renderSurface(this.surfaces[1], stepResource?.rightImage ?? "", markers.filter((marker) => marker.side === "right"));

    this.markerList.innerHTML = "";
    if (!markers.length) {
      const empty = document.createElement("li");
      empty.textContent = "No saved coordinates yet.";
      this.markerList.append(empty);
      return;
    }

    markers.forEach((marker, index) => {
      const item = document.createElement("li");
      item.textContent = formatMarker(marker, index);
      this.markerList.append(item);
    });
  }

  private renderSurface(surface: SurfaceElements, imageUrl: string, markers: MarkerRow[]): void {
    surface.root.innerHTML = "";

    if (!imageUrl) {
      const placeholder = document.createElement("p");
      placeholder.className = "muted";
      placeholder.textContent = "No image available.";
      surface.root.append(placeholder);
      return;
    }

    const image = document.createElement("img");
    image.src = imageUrl;
    image.alt = `${surface.side} step ${this.selectedStep}`;
    surface.root.append(image);

    const drawMarkers = () => {
      const bounds = surface.root.getBoundingClientRect();
      if (!bounds.width || !bounds.height || !image.naturalWidth || !image.naturalHeight) {
        return;
      }

      const overlays = getSurfaceMarkerOverlays(
        surface.side,
        markers,
        bounds.width,
        bounds.height,
        image.naturalWidth,
        image.naturalHeight,
      );

      for (const overlay of overlays) {
        const dot = document.createElement("span");
        dot.className = "admin-marker-dot";
        dot.style.left = `${overlay.leftPx}px`;
        dot.style.top = `${overlay.topPx}px`;
        dot.style.width = `${overlay.diameterPx}px`;
        dot.style.height = `${overlay.diameterPx}px`;

        const label = document.createElement("span");
        label.className = "admin-marker-label";
        label.style.left = dot.style.left;
        label.style.top = dot.style.top;
        label.textContent = overlay.label;
        surface.root.append(dot, label);
      }
    };

    if (image.complete) {
      drawMarkers();
    } else {
      image.addEventListener("load", drawMarkers, { once: true });
    }
  }

  private getSceneCandidates(): ResolvedScene[] {
    return this.project.scenes
      .filter((scene) => scene.step === this.selectedStep)
      .slice()
      .sort(compareScenesForAuthoring);
  }

  private getStepResource(): StepResource | null {
    return this.project.resourceIndex.steps.find((step) => step.step === this.selectedStep) ?? null;
  }

  private getCurrentMarkers(): MarkerRow[] {
    return this.workbook.markers
      .filter((marker) => marker.step === this.selectedStep && marker.sceneId === this.selectedSceneId)
      .slice()
      .sort((a, b) => a.revealAtSec - b.revealAtSec || a.side.localeCompare(b.side));
  }

  private findLastMarkerIndex(): number {
    for (let index = this.workbook.markers.length - 1; index >= 0; index -= 1) {
      const marker = this.workbook.markers[index];
      if (marker.step === this.selectedStep && marker.sceneId === this.selectedSceneId) {
        return index;
      }
    }

    return -1;
  }

  private resolveSelectedStep(preferredStep: number): number {
    const hasPreferred = this.project.resourceIndex.steps.some((step) => step.step === preferredStep);
    if (hasPreferred) {
      return preferredStep;
    }

    return this.project.resourceIndex.steps[0]?.step ?? 0;
  }

  private setStatus(message: string): void {
    this.status.textContent = message;
  }

  private requireElement<T extends HTMLElement>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) {
      throw new Error(`Admin UI element not found: ${selector}`);
    }

    return element;
  }
}
