import * as XLSX from "xlsx";

import type {
  AudioRow,
  EffectRow,
  HudRow,
  MarkerRow,
  ResourceSlotRow,
  SceneRow,
  WorkbookData,
  WorkbookProjectMetadata,
} from "./project-types";

type SheetRecord = Record<string, unknown>;

const DEFAULT_PROJECT: WorkbookProjectMetadata = {
  projectName: "sample",
  width: 1280,
  height: 720,
  fps: 30,
  authoringMode: "excel-driven",
};

function parseRows(workbook: XLSX.WorkBook, sheetName: string): SheetRecord[] {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return [];
  }

  return XLSX.utils.sheet_to_json<SheetRecord>(sheet, {
    defval: "",
    raw: false,
  });
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toText(value: unknown): string {
  return String(value ?? "").trim();
}

function toBoolean(value: unknown): boolean {
  const normalized = toText(value).toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function parseProjectMetadata(rows: SheetRecord[]): WorkbookProjectMetadata {
  const metadata = { ...DEFAULT_PROJECT };

  for (const row of rows) {
    const key = toText(row.key);
    const value = row.value;

    if (!key) {
      continue;
    }

    if (key === "projectName") metadata.projectName = toText(value) || metadata.projectName;
    if (key === "width") metadata.width = toNumber(value, metadata.width);
    if (key === "height") metadata.height = toNumber(value, metadata.height);
    if (key === "fps") metadata.fps = toNumber(value, metadata.fps);
    if (key === "authoringMode") metadata.authoringMode = toText(value) || metadata.authoringMode;
  }

  return metadata;
}

function parseScenes(rows: SheetRecord[]): SceneRow[] {
  return rows
    .map((row) => ({
      sceneId: toText(row.sceneId),
      sceneType: (toText(row.sceneType) || "puzzle_scene") as SceneRow["sceneType"],
      step: toText(row.step) ? toNumber(row.step) : null,
      durationSec: toNumber(row.durationSec, 5),
      titleText: toText(row.titleText),
      backgroundImage: toText(row.backgroundImage),
      backgroundVideo: toText(row.backgroundVideo),
      foregroundImage: toText(row.foregroundImage),
      countdownFrom: toNumber(row.countdownFrom, 0),
      theme: toText(row.theme) || "default",
      bannerText: toText(row.bannerText),
      bannerFill: toText(row.bannerFill) || "#1d4ed8",
      textColor: toText(row.textColor) || "#ffffff",
      badgeFill: toText(row.badgeFill) || "#fb923c",
      bannerImage: toText(row.bannerImage),
      badgeImage: toText(row.badgeImage),
      panelFrameImage: toText(row.panelFrameImage),
    }))
    .filter((row) => row.sceneId);
}

function parseHud(rows: SheetRecord[]): HudRow[] {
  return rows
    .map((row) => ({
      sceneId: toText(row.sceneId),
      theme: toText(row.theme) || "default",
      bannerText: toText(row.bannerText),
      bannerFill: toText(row.bannerFill) || "#1d4ed8",
      textColor: toText(row.textColor) || "#ffffff",
      badgeFill: toText(row.badgeFill) || "#fb923c",
      bannerImage: toText(row.bannerImage),
      badgeImage: toText(row.badgeImage),
      panelFrameImage: toText(row.panelFrameImage),
    }))
    .filter((row) => row.sceneId);
}

function parseEffects(rows: SheetRecord[]): EffectRow[] {
  return rows
    .map((row) => ({
      sceneId: toText(row.sceneId),
      target: toText(row.target),
      effectType: toText(row.effectType),
      resourcePath: toText(row.resourcePath),
      startSec: toNumber(row.startSec),
      durationSec: toNumber(row.durationSec, 1),
      magnitude: toNumber(row.magnitude, 1),
      ease: toText(row.ease) || "sine.inOut",
    }))
    .filter((row) => row.sceneId && row.effectType);
}

function parseAudio(rows: SheetRecord[]): AudioRow[] {
  return rows
    .map((row) => ({
      sceneId: toText(row.sceneId),
      trackType: (toText(row.trackType) || "bgm") as AudioRow["trackType"],
      resourcePath: toText(row.resourcePath),
      startSec: toNumber(row.startSec),
      volume: toNumber(row.volume, 1),
      loop: toBoolean(row.loop),
    }))
    .filter((row) => row.sceneId && row.resourcePath);
}

function parseMarkers(rows: SheetRecord[]): MarkerRow[] {
  return rows
    .map((row) => ({
      sceneId: toText(row.sceneId),
      step: toNumber(row.step),
      side: (toText(row.side) || "left") as MarkerRow["side"],
      cx: toNumber(row.cx),
      cy: toNumber(row.cy),
      radius: toNumber(row.radius, 0.04),
      revealAtSec: toNumber(row.revealAtSec),
      strokeColor: toText(row.strokeColor) || "#ff4fd8",
      lineWidth: toNumber(row.lineWidth, 6),
      texturePath: toText(row.texturePath),
    }))
    .filter((row) => row.sceneId);
}

function parseResources(rows: SheetRecord[]): ResourceSlotRow[] {
  return rows
    .map((row) => ({
      category: toText(row.category),
      resourcePath: toText(row.resourcePath),
      replaceHint: toText(row.replaceHint),
    }))
    .filter((row) => row.resourcePath);
}

function mergeLegacyHudRows(scenes: SceneRow[], hudRows: HudRow[]): SceneRow[] {
  if (!hudRows.length) {
    return scenes;
  }

  return scenes.map((scene) => {
    const legacyHud = hudRows.find((row) => row.sceneId === scene.sceneId);
    if (!legacyHud) {
      return scene;
    }

    return {
      ...scene,
      theme: scene.theme || legacyHud.theme,
      bannerText: scene.bannerText || legacyHud.bannerText,
      bannerFill: scene.bannerFill || legacyHud.bannerFill,
      textColor: scene.textColor || legacyHud.textColor,
      badgeFill: scene.badgeFill || legacyHud.badgeFill,
      bannerImage: scene.bannerImage || legacyHud.bannerImage,
      badgeImage: scene.badgeImage || legacyHud.badgeImage,
      panelFrameImage: scene.panelFrameImage || legacyHud.panelFrameImage,
    };
  });
}

export function parseWorkbookData(workbook: XLSX.WorkBook): WorkbookData {
  const scenes = parseScenes(parseRows(workbook, "Scenes"));
  const hud = parseHud(parseRows(workbook, "Hud"));

  return {
    project: parseProjectMetadata(parseRows(workbook, "Project")),
    scenes: mergeLegacyHudRows(scenes, hud),
    hud,
    effects: parseEffects(parseRows(workbook, "Effects")),
    audio: parseAudio(parseRows(workbook, "Audio")),
    markers: parseMarkers(parseRows(workbook, "Markers")),
    resources: parseResources(parseRows(workbook, "Resources")),
  };
}
