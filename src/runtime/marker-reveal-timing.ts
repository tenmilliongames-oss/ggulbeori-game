type MarkerTimingInput = {
  revealAtSec: number;
  side: string;
  cx: number;
  cy: number;
};

type MarkerTimingScene<T extends MarkerTimingInput> = {
  sceneType: string;
  durationSec: number;
  markers: readonly T[];
};

export const ANSWER_MARKER_REVEAL_START_SEC = 0.5;
export const ANSWER_MARKER_REVEAL_GAP_SEC = 1;
export const ANSWER_MARKER_REVEAL_TAIL_SEC = 1.2;

export function getOrderedAnswerMarkers<T extends MarkerTimingInput>(markers: readonly T[]): T[] {
  return [...markers];
}

export function getMinimumAnswerRevealDurationSec(markerCount: number): number {
  if (markerCount <= 0) {
    return 0;
  }

  return ANSWER_MARKER_REVEAL_START_SEC
    + (markerCount - 1) * ANSWER_MARKER_REVEAL_GAP_SEC
    + ANSWER_MARKER_REVEAL_TAIL_SEC;
}

export function getMarkerRevealTimes<T extends MarkerTimingInput>(scene: MarkerTimingScene<T>): Map<T, number> {
  const revealTimes = new Map<T, number>();
  if (scene.sceneType !== "answer_reveal") {
    for (const marker of scene.markers) {
      revealTimes.set(marker, Math.max(0, marker.revealAtSec));
    }
    return revealTimes;
  }

  const markers = getOrderedAnswerMarkers(scene.markers);
  markers.forEach((marker, index) => {
    revealTimes.set(marker, ANSWER_MARKER_REVEAL_START_SEC + index * ANSWER_MARKER_REVEAL_GAP_SEC);
  });

  return revealTimes;
}
