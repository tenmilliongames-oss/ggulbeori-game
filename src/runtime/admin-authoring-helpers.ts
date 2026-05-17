import type { MarkerRow, ResolvedScene } from "./project-types";

interface SurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MarkerDraftInput {
  sceneId: string;
  step: number;
  side: MarkerRow["side"];
  localX: number;
  localY: number;
  surfaceWidth: number;
  surfaceHeight: number;
  imageWidth: number;
  imageHeight: number;
  radius: number;
  revealAtSec: number;
  strokeColor: string;
  lineWidth: number;
  texturePath: string;
}

export interface SurfaceMarkerOverlay {
  diameterPx: number;
  label: string;
  leftPx: number;
  topPx: number;
}

function containRect(targetWidth: number, targetHeight: number, sourceWidth: number, sourceHeight: number): SurfaceRect {
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatMarker(marker: MarkerRow, index: number): string {
  return `${index + 1}. ${marker.side.toUpperCase()}  x:${marker.cx.toFixed(3)}  y:${marker.cy.toFixed(3)}  r:${marker.radius.toFixed(3)}  t:${marker.revealAtSec.toFixed(1)}s`;
}

export function compareScenesForAuthoring(a: ResolvedScene, b: ResolvedScene): number {
  const rank = (scene: ResolvedScene) => {
    if (scene.sceneType === "answer_reveal") return 0;
    if (scene.sceneType === "puzzle_scene") return 1;
    return 2;
  };

  return rank(a) - rank(b);
}

export function createMarkerDraftFromSurfaceClick(input: MarkerDraftInput): MarkerRow | null {
  const displayed = containRect(input.surfaceWidth, input.surfaceHeight, input.imageWidth, input.imageHeight);

  if (
    input.localX < displayed.x ||
    input.localX > displayed.x + displayed.width ||
    input.localY < displayed.y ||
    input.localY > displayed.y + displayed.height
  ) {
    return null;
  }

  return {
    sceneId: input.sceneId,
    step: input.step,
    side: input.side,
    cx: clamp((input.localX - displayed.x) / displayed.width, 0, 1),
    cy: clamp((input.localY - displayed.y) / displayed.height, 0, 1),
    radius: clamp(input.radius, 0.01, 0.25),
    revealAtSec: Math.max(0, input.revealAtSec),
    strokeColor: input.strokeColor,
    lineWidth: input.lineWidth,
    texturePath: input.texturePath,
  };
}

export function getSurfaceMarkerOverlays(
  side: MarkerRow["side"],
  markers: MarkerRow[],
  surfaceWidth: number,
  surfaceHeight: number,
  imageWidth: number,
  imageHeight: number,
): SurfaceMarkerOverlay[] {
  const displayed = containRect(surfaceWidth, surfaceHeight, imageWidth, imageHeight);

  return markers.map((marker, index) => ({
    diameterPx: marker.radius * displayed.width * 2,
    label: `${side.toUpperCase()} ${index + 1}`,
    leftPx: displayed.x + marker.cx * displayed.width,
    topPx: displayed.y + marker.cy * displayed.height,
  }));
}
