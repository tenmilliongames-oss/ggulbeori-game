import * as XLSX from "xlsx";

import type { MarkerRow } from "./project-types";

const MARKER_HEADERS: Array<keyof MarkerRow> = [
  "sceneId",
  "step",
  "side",
  "cx",
  "cy",
  "radius",
  "revealAtSec",
  "strokeColor",
  "lineWidth",
  "texturePath",
];

function createMarkersSheet(markers: MarkerRow[]): XLSX.WorkSheet {
  const sheet = XLSX.utils.aoa_to_sheet([MARKER_HEADERS]);
  const rows = markers.map((marker) => ({
    sceneId: marker.sceneId,
    step: marker.step,
    side: marker.side,
    cx: marker.cx,
    cy: marker.cy,
    radius: marker.radius,
    revealAtSec: marker.revealAtSec,
    strokeColor: marker.strokeColor,
    lineWidth: marker.lineWidth,
    texturePath: marker.texturePath,
  }));

  XLSX.utils.sheet_add_json(sheet, rows, {
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

export function applyMarkersSheet(workbook: XLSX.WorkBook, markers: MarkerRow[]): void {
  workbook.Sheets.Markers = createMarkersSheet(markers);
  ensureWorksheetName(workbook, "Markers");
}
