import type {
  ProjectModel,
  ResolvedScene,
  ResourceIndex,
  WorkbookData,
} from "./project-types";
import { getMinimumAnswerRevealDurationSec } from "./marker-reveal-timing";
import { resolveProjectModelData } from "./project-model-resolution";

function applyAnswerRevealDurationPolicy(scenes: ResolvedScene[]): ResolvedScene[] {
  return scenes.map((scene) => {
    if (scene.sceneType !== "answer_reveal") {
      return scene;
    }

    const minimumDurationSec = getMinimumAnswerRevealDurationSec(scene.markers.length);
    return {
      ...scene,
      durationSec: Math.max(scene.durationSec, minimumDurationSec),
    };
  });
}

export function buildProjectModel(workbook: WorkbookData, resourceIndex: ResourceIndex): ProjectModel {
  const { diagnostics, scenes, uiResources } = resolveProjectModelData(workbook, resourceIndex);

  return {
    projectName: workbook.project.projectName || resourceIndex.projectName,
    width: workbook.project.width,
    height: workbook.project.height,
    fps: workbook.project.fps,
    detectedStepCount: resourceIndex.stepCount,
    scenes: applyAnswerRevealDurationPolicy(scenes),
    diagnostics,
    resourceIndex,
    uiResources,
  };
}
