import type { AudioRow, ProjectModel, ResolvedScene } from "./project-types";
import { resolveProjectResource } from "./resource-path";

export interface PreviewAudioTransport {
  loadScene(scene: ResolvedScene): void;
  setPlaying(nextPlaying: boolean): void;
  setTime(timeSec: number): void;
  reset(): void;
}

interface TrackState {
  row: AudioRow;
  audio: HTMLAudioElement;
  triggered: boolean;
}

function getSceneTrackRows(scene: ResolvedScene): AudioRow[] {
  return scene.sceneType === "answer_reveal" ? scene.audio.filter((row) => row.trackType === "bgm") : scene.audio;
}

export class AudioPreviewController implements PreviewAudioTransport {
  private readonly projectName: string;
  private tracks: TrackState[] = [];
  private currentTimeSec = 0;
  private playing = false;

  constructor(project: ProjectModel) {
    this.projectName = project.projectName;
  }

  loadScene(scene: ResolvedScene): void {
    this.disposeTracks();
    this.currentTimeSec = 0;
    this.tracks = getSceneTrackRows(scene).map((row) => this.createTrackState(row));

    this.syncTracks();
  }

  setPlaying(nextPlaying: boolean): void {
    this.playing = nextPlaying;
    this.syncTracks();
  }

  setTime(timeSec: number): void {
    this.currentTimeSec = timeSec;
    this.syncTracks();
  }

  reset(): void {
    this.currentTimeSec = 0;
    for (const track of this.tracks) {
      this.resetTrackPlayback(track);
    }
    this.syncTracks();
  }

  dispose(): void {
    this.disposeTracks();
  }

  private syncTracks(): void {
    for (const track of this.tracks) {
      if (track.row.trackType === "bgm") {
        this.syncBgmTrack(track);
      } else {
        this.syncSfxTrack(track);
      }
    }
  }

  private createTrackState(row: AudioRow): TrackState {
    const audio = new Audio(resolveProjectResource(this.projectName, row.resourcePath));
    audio.loop = row.loop;
    audio.volume = row.volume;
    audio.preload = "auto";
    audio.load();

    return { row, audio, triggered: false };
  }

  private resetTrackPlayback(track: TrackState): void {
    track.triggered = false;
    track.audio.pause();
    track.audio.currentTime = 0;
  }

  private syncBgmTrack(track: TrackState): void {
    const offset = this.currentTimeSec - track.row.startSec;
    if (offset < 0) {
      this.resetTrackPlayback(track);
      return;
    }

    const duration =
      Number.isFinite(track.audio.duration) && track.audio.duration > 0 ? track.audio.duration : null;
    const normalizedOffset = track.row.loop && duration ? offset % duration : offset;

    if (Math.abs(track.audio.currentTime - normalizedOffset) > 0.35) {
      try {
        track.audio.currentTime = Math.max(0, normalizedOffset);
      } catch {
        // Ignore seek failures while audio is not buffered yet.
      }
    }

    if (this.playing) {
      void track.audio.play().catch(() => undefined);
    } else {
      track.audio.pause();
    }
  }

  private syncSfxTrack(track: TrackState): void {
    if (this.currentTimeSec < track.row.startSec) {
      if (track.triggered) {
        this.resetTrackPlayback(track);
      }
      return;
    }

    if (!this.playing) {
      track.audio.pause();
      return;
    }

    if (!track.triggered) {
      track.triggered = true;
      track.audio.currentTime = 0;
      void track.audio.play().catch(() => undefined);
    }
  }

  private disposeTracks(): void {
    for (const track of this.tracks) {
      track.audio.pause();
      track.audio.src = "";
    }
    this.tracks = [];
  }
}
