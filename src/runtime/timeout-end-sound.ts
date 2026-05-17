import type { AudioRow, ProjectModel } from "./project-types";
import { resolveProjectResource } from "./resource-path";

const TIMEOUT_END_SOUND_RESOURCE = "resources/audio/bgm/end-sound.wav";

function isLandscapeProject(project: ProjectModel): boolean {
  return project.width >= project.height;
}

async function readAudioDurationSec(projectName: string, resourcePath: string): Promise<number | null> {
  const audio = new Audio(resolveProjectResource(projectName, resourcePath));
  audio.preload = "metadata";

  return await new Promise<number | null>((resolve) => {
    let settled = false;
    let timeoutId = 0;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      audio.removeEventListener("loadedmetadata", handleLoaded);
      audio.removeEventListener("error", handleError);
      audio.src = "";
    };

    const finish = (durationSec: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(durationSec);
    };

    const handleLoaded = () => {
      finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
    };

    const handleError = () => {
      finish(null);
    };

    audio.addEventListener("loadedmetadata", handleLoaded, { once: true });
    audio.addEventListener("error", handleError, { once: true });
    timeoutId = window.setTimeout(() => finish(null), 5000);
    audio.load();
  });
}

export async function applyLandscapeTimeoutEndSound(project: ProjectModel): Promise<ProjectModel> {
  if (!isLandscapeProject(project)) {
    return project;
  }

  const durationSec = await readAudioDurationSec(project.projectName, TIMEOUT_END_SOUND_RESOURCE);
  if (!durationSec) {
    return project;
  }

  const timeoutBgm: AudioRow = {
    sceneId: "",
    trackType: "bgm",
    resourcePath: TIMEOUT_END_SOUND_RESOURCE,
    startSec: 0,
    volume: 1,
    loop: false,
  };
  let changed = false;

  const scenes = project.scenes.map((scene) => {
    if (scene.sceneType !== "timeout_card") {
      return scene;
    }

    changed = true;
    return {
      ...scene,
      durationSec,
      audio: [
        {
          ...timeoutBgm,
          sceneId: scene.sceneId,
        },
        ...scene.audio.filter((row) => row.trackType !== "bgm"),
      ],
    };
  });

  return changed ? { ...project, scenes } : project;
}
