import type { AudioRow, ProjectModel } from "./project-types";

import type { TimelineScene, TimelineTransition } from "./export-shared";
import { DEFAULT_AUDIO_SAMPLE_RATE } from "./export-shared";
import { getMarkerRevealTimes } from "./marker-reveal-timing";
import { resolveProjectResource } from "./resource-path";

const MARKER_REVEAL_AUDIO_OFFSET_SEC = 0;

function getSceneTrackRowsForExport(scene: TimelineScene["scene"]): AudioRow[] {
  return scene.sceneType === "answer_reveal"
    ? scene.audio.filter((row) => row.trackType === "bgm")
    : scene.audio;
}

async function fetchDecodedAudioBuffer(
  cache: Map<string, AudioBuffer>,
  projectName: string,
  resourcePath: string,
  sampleRate: number,
): Promise<AudioBuffer | null> {
  const resolvedPath = resolveProjectResource(projectName, resourcePath);
  const existing = cache.get(resolvedPath);
  if (existing) {
    return existing;
  }

  try {
    const response = await fetch(resolvedPath);
    if (!response.ok) {
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const context = new AudioContext({ sampleRate });
    try {
      const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
      cache.set(resolvedPath, decoded);
      return decoded;
    } finally {
      await context.close();
    }
  } catch {
    return null;
  }
}

export async function renderMixedAudio(
  project: ProjectModel,
  timelineScenes: TimelineScene[],
  transitions: TimelineTransition[],
  totalDurationSec: number,
): Promise<AudioBuffer> {
  const sampleRate = DEFAULT_AUDIO_SAMPLE_RATE;
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    sampleRate,
    length: Math.ceil(totalDurationSec * sampleRate),
  });
  const audioCache = new Map<string, AudioBuffer>();

  const scheduleAudioRow = async (
    row: AudioRow,
    sceneStartSec: number,
    sceneDurationSec: number,
  ): Promise<void> => {
    const decoded = await fetchDecodedAudioBuffer(audioCache, project.projectName, row.resourcePath, sampleRate);
    if (!decoded) {
      return;
    }

    const source = context.createBufferSource();
    source.buffer = decoded;
    source.loop = row.loop;
    if (row.loop) {
      source.loopStart = 0;
      source.loopEnd = decoded.duration;
    }

    const gain = context.createGain();
    gain.gain.value = row.volume;
    source.connect(gain);
    gain.connect(context.destination);

    const startSec = sceneStartSec + row.startSec;
    if (row.loop) {
      source.start(startSec);
      source.stop(sceneStartSec + sceneDurationSec);
    } else {
      source.start(startSec);
    }
  };

  for (const timelineScene of timelineScenes) {
    const scene = timelineScene.scene;
    for (const row of getSceneTrackRowsForExport(scene)) {
      await scheduleAudioRow(row, timelineScene.startSec, timelineScene.durationSec);
    }

    if (scene.sceneType === "answer_reveal") {
      const revealTimes = getMarkerRevealTimes(scene);
      for (const marker of scene.markers) {
        const okRow: AudioRow = {
          sceneId: scene.sceneId,
          trackType: "sfx",
          resourcePath: "resources/audio/sfx/ok.mp3",
          startSec: (revealTimes.get(marker) ?? marker.revealAtSec) + MARKER_REVEAL_AUDIO_OFFSET_SEC,
          volume: 1,
          loop: false,
        };
        await scheduleAudioRow(okRow, timelineScene.startSec, timelineScene.durationSec);
      }
    }

    if (scene.sceneType === "title_card" && scene.audio.length === 0 && scene.backgroundVideo) {
      const embeddedAudioRow: AudioRow = {
        sceneId: scene.sceneId,
        trackType: "bgm",
        resourcePath: scene.backgroundVideo,
        startSec: 0,
        volume: 1,
        loop: false,
      };
      await scheduleAudioRow(embeddedAudioRow, timelineScene.startSec, timelineScene.durationSec);
    }
  }

  for (const transition of transitions) {
    const decoded = await fetchDecodedAudioBuffer(
      audioCache,
      project.projectName,
      "resources/audio/sfx/bookpage.wav",
      sampleRate,
    );
    if (!decoded) {
      continue;
    }

    const source = context.createBufferSource();
    source.buffer = decoded;
    const gain = context.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(context.destination);
    source.start(transition.startSec);
  }

  return await context.startRendering();
}
