import * as XLSX from "xlsx";

import type { SceneRow, WorkbookData } from "./project-types";
import { applyMarkersSheet } from "./markers-sheet";

const SCENE_HEADERS: Array<keyof SceneRow> = [
  "sceneId",
  "sceneType",
  "step",
  "durationSec",
  "titleText",
  "backgroundImage",
  "backgroundVideo",
  "foregroundImage",
  "countdownFrom",
  "theme",
  "bannerText",
  "bannerFill",
  "textColor",
  "badgeFill",
  "bannerImage",
  "badgeImage",
  "panelFrameImage",
];

interface MinimalFile {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface MinimalFileWriter {
  write(data: BlobPart): Promise<void>;
  close(): Promise<void>;
}

interface MinimalFileHandle {
  getFile(): Promise<MinimalFile>;
  createWritable(): Promise<MinimalFileWriter>;
}

interface FsAccessWindow extends Window {
  showOpenFilePicker?: (options?: unknown) => Promise<MinimalFileHandle[]>;
}

export interface WorkbookSaveResult {
  mode: "connected" | "saved" | "exported" | "idle";
  message: string;
}

function toArrayBuffer(data: unknown): ArrayBuffer {
  if (data instanceof ArrayBuffer) {
    return data;
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
  }

  throw new Error("Workbook write returned unsupported buffer type.");
}

function createScenesSheet(scenes: SceneRow[]): XLSX.WorkSheet {
  const sheet = XLSX.utils.aoa_to_sheet([SCENE_HEADERS]);
  XLSX.utils.sheet_add_json(sheet, scenes, {
    header: SCENE_HEADERS,
    origin: "A2",
    skipHeader: true,
  });
  return sheet;
}

function ensureWorksheetName(workbook: XLSX.WorkBook, sheetName: string): void {
  if (!workbook.SheetNames.includes(sheetName)) {
    workbook.SheetNames.push(sheetName);
  }
}

function applyScenesSheet(workbook: XLSX.WorkBook, scenes: SceneRow[]): void {
  workbook.Sheets.Scenes = createScenesSheet(scenes);
  ensureWorksheetName(workbook, "Scenes");
}

export class WorkbookPersistence {
  private readonly workbookPath: string;
  private sourceBuffer: ArrayBuffer | null = null;
  private fileHandle: MinimalFileHandle | null = null;

  constructor(workbookPath: string) {
    this.workbookPath = workbookPath;
  }

  get isConnected(): boolean {
    return this.fileHandle !== null;
  }

  async connect(): Promise<WorkbookSaveResult> {
    const pickerWindow = window as FsAccessWindow;
    if (!pickerWindow.showOpenFilePicker) {
      return {
        mode: "idle",
        message: "This browser does not support workbook auto-save connection. Use Save Copy instead.",
      };
    }

    const [handle] = await pickerWindow.showOpenFilePicker({
      multiple: false,
      excludeAcceptAllOption: true,
      types: [
        {
          description: "Excel Workbook",
          accept: {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
          },
        },
      ],
    });

    if (!handle) {
      return {
        mode: "idle",
        message: "Workbook connection was canceled.",
      };
    }

    const file = await handle.getFile();
    this.fileHandle = handle;
    this.sourceBuffer = await file.arrayBuffer();

    return {
      mode: "connected",
      message: `${file.name} connected. Each click will now auto-save the Markers sheet.`,
    };
  }

  async save(workbookData: WorkbookData): Promise<WorkbookSaveResult> {
    if (!this.fileHandle) {
      return {
        mode: "idle",
        message: "Workbook is not connected yet. Use Save Copy to download the updated file.",
      };
    }

    const buffer = await this.buildWorkbookBuffer(workbookData);
    const writable = await this.fileHandle.createWritable();
    await writable.write(buffer);
    await writable.close();
    this.sourceBuffer = buffer;

    return {
      mode: "saved",
      message: `Markers sheet auto-saved (${workbookData.markers.length} rows).`,
    };
  }

  async export(workbookData: WorkbookData): Promise<WorkbookSaveResult> {
    const buffer = await this.buildWorkbookBuffer(workbookData);
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "scene-flow-markers.xlsx";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.sourceBuffer = buffer;

    return {
      mode: "exported",
      message: "Started downloading the updated workbook.",
    };
  }

  private async buildWorkbookBuffer(workbookData: WorkbookData): Promise<ArrayBuffer> {
    const source = await this.loadSourceBuffer();
    const workbook = XLSX.read(source, { type: "array" });
    applyScenesSheet(workbook, workbookData.scenes);
    applyMarkersSheet(workbook, workbookData.markers);

    return toArrayBuffer(
      XLSX.write(workbook, {
        bookType: "xlsx",
        type: "array",
      }),
    );
  }

  private async loadSourceBuffer(): Promise<ArrayBuffer> {
    if (this.fileHandle) {
      const file = await this.fileHandle.getFile();
      this.sourceBuffer = await file.arrayBuffer();
      return this.sourceBuffer;
    }

    if (this.sourceBuffer) {
      return this.sourceBuffer;
    }

    const response = await fetch(this.workbookPath);
    if (!response.ok) {
      throw new Error(`Workbook template load failed: ${this.workbookPath}`);
    }

    this.sourceBuffer = await response.arrayBuffer();
    return this.sourceBuffer;
  }
}
