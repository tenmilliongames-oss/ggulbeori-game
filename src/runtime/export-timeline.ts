import type { ExportTimeline, OfflineExportOptions, SceneDurationEntry } from "./export-shared";
import { BOOK_TRANSITION_TOTAL_SEC } from "./export-shared";

export async function collectSceneDurations(options: OfflineExportOptions): Promise<SceneDurationEntry[]> {
  const durations: SceneDurationEntry[] = [];

  for (const scene of options.project.scenes) {
    if (options.isCancelled()) {
      break;
    }

    options.onStatus({ message: `Preparing scene duration: ${scene.sceneId}` });
    await options.applyScene(scene.sceneId, 0, { useBookTransition: false });
    const prepared = options.getActiveScene();
    durations.push({
      scene: prepared,
      durationSec: prepared.durationSec,
    });
  }

  return durations;
}

export function buildTimeline(
  scenes: SceneDurationEntry[],
  shouldUseBookTransition: OfflineExportOptions["shouldUseBookTransition"],
): ExportTimeline {
  const timeline: ExportTimeline = {
    scenes: [],
    transitions: [],
    totalDurationSec: 0,
  };
  let cursorSec = 0;

  for (let index = 0; index < scenes.length; index += 1) {
    const current = scenes[index];
    timeline.scenes.push({
      scene: current.scene,
      durationSec: current.durationSec,
      startSec: cursorSec,
    });

    cursorSec += current.durationSec;

    const next = scenes[index + 1];
    if (next && shouldUseBookTransition(current.scene, next.scene)) {
      timeline.transitions.push({
        fromScene: current.scene,
        toScene: next.scene,
        startSec: cursorSec,
        durationSec: BOOK_TRANSITION_TOTAL_SEC,
      });
      cursorSec += BOOK_TRANSITION_TOTAL_SEC;
    }
  }

  timeline.totalDurationSec = cursorSec;
  return timeline;
}
