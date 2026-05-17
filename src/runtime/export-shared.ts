import type { ProjectModel, ResolvedScene } from "./project-types";
import type { PreviewSceneRenderer } from "./pixi-preview-app";
export { BOOK_TRANSITION_COVER_SEC, BOOK_TRANSITION_TOTAL_SEC } from "./scene-flow-policy";

export interface SceneDurationEntry {
  scene: ResolvedScene;
  durationSec: number;
}

export interface TimelineScene {
  scene: ResolvedScene;
  durationSec: number;
  startSec: number;
}

export interface TimelineTransition {
  fromScene: ResolvedScene;
  toScene: ResolvedScene;
  startSec: number;
  durationSec: number;
}

export interface ExportTimeline {
  scenes: TimelineScene[];
  transitions: TimelineTransition[];
  totalDurationSec: number;
}

export interface ExportStatus {
  message: string;
}

export interface ExportProgress {
  progress: number;
  encodedFrames: number;
  totalFrames: number;
  currentSceneId: string | null;
  message: string;
}

export interface OfflineExportOptions {
  project: ProjectModel;
  preview: PreviewSceneRenderer;
  applyScene: (sceneId: string, startAt?: number, options?: { useBookTransition?: boolean }) => Promise<void>;
  getActiveScene: () => ResolvedScene;
  shouldUseBookTransition: (fromScene: ResolvedScene | null, toScene: ResolvedScene | null) => boolean;
  onStatus: (status: ExportStatus) => void;
  onProgress?: (progress: ExportProgress) => void;
  isCancelled: () => boolean;
  fps: number;
}

export interface VideoCodecChoice {
  encoderCodec: string;
  muxerCodec: "V_VP9" | "V_VP8";
}

export interface OfflineWebmRenderResult {
  blob: Blob;
  fileName: string;
  mimeType: "video/webm";
  timestamp: string;
  wasCancelled: boolean;
}

export interface OfflineAudioRenderResult {
  blob: Blob;
  fileName: string;
  mimeType: "audio/wav";
}

export interface FfmpegExportServiceConfig {
  baseUrl?: string;
  healthPath?: string;
  transcodePath?: string;
  requestTimeoutMs?: number;
  headers?: Record<string, string>;
}

export interface FfmpegMp4ExportOptions extends FfmpegExportServiceConfig {
  fileName?: string;
  outputPath?: string;
  fps?: number;
  audio?: OfflineAudioRenderResult;
}

export interface FfmpegSegmentConcatOptions extends FfmpegExportServiceConfig {
  concatPath?: string;
  fileName?: string;
  outputPath?: string;
  fps?: number;
  audio?: OfflineAudioRenderResult;
  cleanupSegments?: boolean;
}

export interface FfmpegServiceHealthCheckResult {
  ok: boolean;
  status: number;
  url: string;
  payload: unknown;
}

export interface OfflineMp4ExportResult {
  fileName: string;
  outputPath: string;
  serviceUrl: string;
  responseStatus: number;
  downloadUrl: string | null;
  jobId: string | null;
  wasCancelled: boolean;
  payload: unknown;
}

export const DEFAULT_AUDIO_SAMPLE_RATE = 48_000;
