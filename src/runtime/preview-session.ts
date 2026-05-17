import type { PreviewAudioTransport } from "./audio-preview-controller";
import type { ProjectModel, ResolvedScene } from "./project-types";
import type { PreviewSceneRenderer, PreviewSceneTransition } from "./pixi-preview-app";

export type PreviewSceneTransitionMode = PreviewSceneTransition | "auto";

export interface PreviewSessionSnapshot {
  activeScene: ResolvedScene | null;
  currentTimeSec: number;
  isPlaying: boolean;
  sceneTransitioning: boolean;
  durationSec: number;
  hasNextScene: boolean;
}

export interface PreviewTickResult {
  state: PreviewSessionSnapshot;
  advancedToNextScene: boolean;
  reachedProjectEnd: boolean;
}

export interface PreviewSessionOptions {
  transitionResolver?: (fromScene: ResolvedScene | null, toScene: ResolvedScene | null) => boolean;
}

export class PreviewSession {
  private project: ProjectModel | null = null;
  private activeScene: ResolvedScene | null = null;
  private currentTimeSec = 0;
  private isPlaying = false;
  private lastFrameMs = 0;
  private sceneTransitioning = false;

  constructor(
    private readonly renderer: PreviewSceneRenderer,
    private readonly audio: PreviewAudioTransport,
    private readonly options: PreviewSessionOptions = {},
  ) {}

  getProject(): ProjectModel | null {
    return this.project;
  }

  getActiveScene(): ResolvedScene | null {
    return this.activeScene;
  }

  getSnapshot(): PreviewSessionSnapshot {
    const activeScene = this.activeScene;
    const sceneIndex = this.getSceneIndex(activeScene);

    return {
      activeScene,
      currentTimeSec: this.currentTimeSec,
      isPlaying: this.isPlaying,
      sceneTransitioning: this.sceneTransitioning,
      durationSec: activeScene?.durationSec ?? 0,
      hasNextScene: sceneIndex >= 0 && this.project != null ? sceneIndex < this.project.scenes.length - 1 : false,
    };
  }

  async loadProject(
    project: ProjectModel,
    options?: { sceneId?: string; startAt?: number },
  ): Promise<PreviewSessionSnapshot> {
    this.project = project;
    this.activeScene = null;
    this.currentTimeSec = 0;
    this.isPlaying = false;
    this.lastFrameMs = 0;
    this.sceneTransitioning = false;

    await this.renderer.loadProject(project);
    this.renderer.setPlaying(false);
    this.audio.reset();
    this.audio.setPlaying(false);

    const initialScene = this.findScene(options?.sceneId) ?? project.scenes[0] ?? null;
    if (!initialScene) {
      return this.getSnapshot();
    }

    return this.applyScene(initialScene.sceneId, options?.startAt ?? 0, {
      transition: "none",
    });
  }

  async applyScene(
    sceneId: string,
    startAt = 0,
    options?: { transition?: PreviewSceneTransitionMode },
  ): Promise<PreviewSessionSnapshot> {
    const nextScene = this.findScene(sceneId);
    if (!this.project || !nextScene) {
      throw new Error(`Preview scene not found: ${sceneId}`);
    }

    this.sceneTransitioning = true;

    try {
      await this.renderer.setScene(nextScene, {
        transition: this.resolveTransition(this.activeScene, nextScene, options?.transition),
      });

      this.activeScene = this.createActiveScene(nextScene);
      this.currentTimeSec = Math.min(Math.max(0, startAt), this.activeScene.durationSec);

      this.renderer.renderAt(this.currentTimeSec);
      this.renderer.setPlaying(this.isPlaying);
      this.audio.loadScene(this.activeScene);
      this.audio.setTime(this.currentTimeSec);
      this.audio.setPlaying(this.isPlaying);
      this.lastFrameMs = 0;
    } finally {
      this.sceneTransitioning = false;
    }

    return this.getSnapshot();
  }

  seek(timeSec: number): PreviewSessionSnapshot {
    if (!this.activeScene) {
      return this.getSnapshot();
    }

    this.currentTimeSec = Math.min(Math.max(0, timeSec), this.activeScene.durationSec);
    this.renderer.renderAt(this.currentTimeSec);
    this.audio.setTime(this.currentTimeSec);

    return this.getSnapshot();
  }

  setPlaying(nextPlaying: boolean): PreviewSessionSnapshot {
    this.isPlaying = nextPlaying;
    this.renderer.setPlaying(nextPlaying);
    this.audio.setPlaying(nextPlaying);
    this.lastFrameMs = 0;

    return this.getSnapshot();
  }

  reset(): PreviewSessionSnapshot {
    this.currentTimeSec = 0;
    this.isPlaying = false;
    this.sceneTransitioning = false;
    this.lastFrameMs = 0;

    this.renderer.renderAt(0);
    this.renderer.setPlaying(false);
    this.audio.reset();
    this.audio.setPlaying(false);

    return this.getSnapshot();
  }

  async advanceToNextScene(options?: {
    transition?: PreviewSceneTransitionMode;
  }): Promise<PreviewTickResult> {
    if (!this.project || !this.activeScene) {
      return this.finishTick(false, false);
    }

    const currentIndex = this.getSceneIndex(this.activeScene);
    const nextScene = currentIndex >= 0 ? this.project.scenes[currentIndex + 1] ?? null : null;

    if (!nextScene) {
      this.setPlaying(false);
      this.sceneTransitioning = false;
      return this.finishTick(false, true);
    }

    await this.applyScene(nextScene.sceneId, 0, {
      transition: options?.transition ?? "auto",
    });

    return this.finishTick(true, false);
  }

  async tick(nowMs: number): Promise<PreviewTickResult> {
    if (!this.activeScene) {
      this.lastFrameMs = nowMs;
      return this.finishTick(false, false);
    }

    if (this.isPlaying && !this.sceneTransitioning && this.activeScene.durationSec > 0) {
      if (!this.lastFrameMs) {
        this.lastFrameMs = nowMs;
      }

      const deltaSec = (nowMs - this.lastFrameMs) / 1000;
      this.currentTimeSec = Math.min(this.activeScene.durationSec, this.currentTimeSec + deltaSec);
      this.renderer.renderAt(this.currentTimeSec);
      this.audio.setTime(this.currentTimeSec);

      if (this.currentTimeSec >= this.activeScene.durationSec) {
        this.lastFrameMs = nowMs;
        this.sceneTransitioning = true;
        return this.advanceToNextScene();
      }
    }

    this.lastFrameMs = nowMs;
    return this.finishTick(false, false);
  }

  private createActiveScene(scene: ResolvedScene): ResolvedScene {
    return {
      ...scene,
      durationSec: this.renderer.getPreferredSceneDuration(scene.durationSec),
    };
  }

  private resolveTransition(
    fromScene: ResolvedScene | null,
    toScene: ResolvedScene,
    requestedMode: PreviewSceneTransitionMode = "auto",
  ): PreviewSceneTransition {
    if (requestedMode === "none" || requestedMode === "book") {
      return requestedMode;
    }

    return this.options.transitionResolver?.(fromScene, toScene) ? "book" : "none";
  }

  private findScene(sceneId: string | undefined): ResolvedScene | null {
    if (!this.project || !sceneId) {
      return null;
    }

    return this.project.scenes.find((scene) => scene.sceneId === sceneId) ?? null;
  }

  private getSceneIndex(scene: ResolvedScene | null): number {
    if (!this.project || !scene) {
      return -1;
    }

    return this.project.scenes.findIndex((entry) => entry.sceneId === scene.sceneId);
  }

  private finishTick(advancedToNextScene: boolean, reachedProjectEnd: boolean): PreviewTickResult {
    return {
      state: this.getSnapshot(),
      advancedToNextScene,
      reachedProjectEnd,
    };
  }
}
