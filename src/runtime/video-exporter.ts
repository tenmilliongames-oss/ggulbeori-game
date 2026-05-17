import { ArrayBufferTarget, Muxer } from "webm-muxer";

import { renderMixedAudio } from "./export-audio-mix";
import { encodeAudioTrack, encodeVideoTrack, pickVideoCodec } from "./export-encoder";
import { checkFfmpegExportServiceHealth, concatMp4Segments, exportWebmToMp4 } from "./ffmpeg-export-client";
import type { BookTransitionOverlay } from "./pixi-preview-app";
import type {
  FfmpegExportServiceConfig,
  FfmpegMp4ExportOptions,
  OfflineAudioRenderResult,
  FfmpegServiceHealthCheckResult,
  OfflineExportOptions,
  OfflineMp4ExportResult,
  OfflineWebmRenderResult,
  VideoCodecChoice,
} from "./export-shared";
import { BOOK_TRANSITION_COVER_SEC } from "./export-shared";
import { buildTimeline, collectSceneDurations } from "./export-timeline";

interface VideoSegmentWebmRenderResult extends OfflineWebmRenderResult {
  encodedFrameCount: number;
  label: string;
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function buildOfflineExportTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildOfflineWebmFileName(options: OfflineExportOptions, wasCancelled: boolean, timestamp: string): string {
  const suffix = wasCancelled ? "partial" : "full";
  return `${options.project.projectName}-${suffix}-${timestamp}.webm`;
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "segment";
}

function replaceFileExtension(fileName: string, extension: string): string {
  const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
  return `${fileName.replace(/\.[^.]+$/u, "")}${normalizedExtension}`;
}

function ensureEndMp4FileName(fileName: string): string {
  const extension = fileName.match(/\.[^.]+$/u)?.[0] ?? ".mp4";
  const baseName = fileName.replace(/\.[^.]+$/u, "");
  if (/(^|[-_.])end($|[-_.])/iu.test(baseName)) {
    return `${baseName}${extension}`;
  }

  return `${baseName}-end${extension}`;
}

function buildFinalMp4FileName(options: OfflineExportOptions, timestamp: string, wasCancelled: boolean): string {
  const resultLabel = wasCancelled ? "partial-end" : "end";
  return `${sanitizeFilePart(options.project.projectName)}-${timestamp}-${resultLabel}.mp4`;
}

function getTotalTimelineFrames(
  sceneDurations: Array<{ durationSec: number }>,
  transitionDurations: Array<{ durationSec: number }>,
  fps: number,
): number {
  return (
    sceneDurations.reduce((sum, scene) => sum + Math.max(1, Math.round(scene.durationSec * fps)), 0)
    + transitionDurations.reduce((sum, transition) => sum + Math.max(1, Math.round(transition.durationSec * fps)), 0)
  );
}

function shouldUseSegmentedMp4Export(options: OfflineExportOptions): boolean {
  const projectSize = options.preview.getProjectSize();
  if (!projectSize) {
    return false;
  }

  return (
    options.project.height > options.project.width ||
    projectSize.width > options.project.width ||
    projectSize.height > options.project.height
  );
}

function encodeAudioBufferToWav(audioBuffer: AudioBuffer, fileName: string): OfflineAudioRenderResult {
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const frameCount = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channelData = Array.from({ length: channelCount }, (_, channel) => audioBuffer.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return {
    blob: new Blob([buffer], { type: "audio/wav" }),
    fileName,
    mimeType: "audio/wav",
  };
}

async function renderVideoOnlyWebmSegment(
  options: OfflineExportOptions,
  videoCodec: VideoCodecChoice,
  params: {
    fileName: string;
    label: string;
    frameCount: number;
    timestamp: string;
    renderFrame: (frameOffset: number) => Promise<void>;
    onFrameEncoded: () => void;
  },
): Promise<VideoSegmentWebmRenderResult> {
  const projectSize = options.preview.getProjectSize();
  if (!projectSize) {
    throw new Error("Project size is unavailable.");
  }

  const muxerTarget = new ArrayBufferTarget();
  const muxer = new Muxer({
    target: muxerTarget,
    type: "webm",
    video: {
      codec: videoCodec.muxerCodec,
      width: projectSize.width,
      height: projectSize.height,
      frameRate: options.fps,
    },
    firstTimestampBehavior: "offset",
  });

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      throw error;
    },
  });

  videoEncoder.configure({
    codec: videoCodec.encoderCodec,
    width: projectSize.width,
    height: projectSize.height,
    bitrate: 10_000_000,
    framerate: options.fps,
    latencyMode: "quality",
  });

  let encodedFrameCount = 0;
  for (let frameOffset = 0; frameOffset < params.frameCount; frameOffset += 1) {
    if (options.isCancelled()) {
      break;
    }

    await params.renderFrame(frameOffset);
    const frame = new VideoFrame(options.preview.getCanvas(), {
      timestamp: Math.round((frameOffset / options.fps) * 1_000_000),
      duration: Math.round((1 / options.fps) * 1_000_000),
    });
    videoEncoder.encode(frame, { keyFrame: frameOffset === 0 || frameOffset % options.fps === 0 });
    frame.close();
    encodedFrameCount += 1;
    params.onFrameEncoded();
  }

  await videoEncoder.flush();
  videoEncoder.close();

  if (encodedFrameCount <= 0) {
    return {
      blob: new Blob([], { type: "video/webm" }),
      fileName: params.fileName,
      mimeType: "video/webm",
      timestamp: params.timestamp,
      wasCancelled: true,
      encodedFrameCount,
      label: params.label,
    };
  }

  muxer.finalize();
  return {
    blob: new Blob([muxerTarget.buffer], { type: "video/webm" }),
    fileName: params.fileName,
    mimeType: "video/webm",
    timestamp: params.timestamp,
    wasCancelled: options.isCancelled(),
    encodedFrameCount,
    label: params.label,
  };
}

export async function renderProjectOfflineWebm(options: OfflineExportOptions): Promise<OfflineWebmRenderResult> {
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined" || typeof VideoFrame === "undefined") {
    throw new Error("This browser does not support WebCodecs offline export.");
  }

  const sceneDurations = await collectSceneDurations(options);
  if (!sceneDurations.length) {
    throw new Error("No scenes available for export.");
  }

  const timeline = buildTimeline(sceneDurations, options.shouldUseBookTransition);
  const projectSize = options.preview.getProjectSize();
  if (!projectSize) {
    throw new Error("Project size is unavailable.");
  }

  options.onStatus({ message: "Mixing audio..." });
  const mixedAudio = await renderMixedAudio(
    options.project,
    timeline.scenes,
    timeline.transitions,
    timeline.totalDurationSec,
  );

  const videoCodec = await pickVideoCodec(projectSize.width, projectSize.height, options.fps);
  const muxerTarget = new ArrayBufferTarget();
  const muxer = new Muxer({
    target: muxerTarget,
    type: "webm",
    video: {
      codec: videoCodec.muxerCodec,
      width: projectSize.width,
      height: projectSize.height,
      frameRate: options.fps,
    },
    audio: {
      codec: "A_OPUS",
      numberOfChannels: mixedAudio.numberOfChannels,
      sampleRate: mixedAudio.sampleRate,
    },
    firstTimestampBehavior: "offset",
  });

  options.onStatus({ message: "Encoding audio and video..." });
  const audioEncoding = encodeAudioTrack(muxer, mixedAudio);
  const videoEncoding = encodeVideoTrack(muxer, options, timeline.scenes, timeline.transitions, videoCodec);
  await Promise.all([audioEncoding, videoEncoding]);
  muxer.finalize();

  const buffer = muxerTarget.buffer;
  const timestamp = buildOfflineExportTimestamp();
  const wasCancelled = options.isCancelled();
  return {
    blob: new Blob([buffer], { type: "video/webm" }),
    fileName: buildOfflineWebmFileName(options, wasCancelled, timestamp),
    mimeType: "video/webm",
    timestamp,
    wasCancelled,
  };
}

export async function exportProjectOfflineVideo(options: OfflineExportOptions): Promise<void> {
  const webm = await renderProjectOfflineWebm(options);
  downloadBlob(webm.blob, webm.fileName);
}

export async function checkOfflineMp4ExportHealth(
  config: FfmpegExportServiceConfig = {},
): Promise<FfmpegServiceHealthCheckResult> {
  return await checkFfmpegExportServiceHealth(config);
}

async function exportProjectSegmentedMp4(
  options: OfflineExportOptions,
  serviceOptions: FfmpegMp4ExportOptions = {},
): Promise<OfflineMp4ExportResult> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
    throw new Error("This browser does not support WebCodecs segmented export.");
  }

  const sceneDurations = await collectSceneDurations(options);
  if (!sceneDurations.length) {
    throw new Error("No scenes available for export.");
  }

  const timeline = buildTimeline(sceneDurations, options.shouldUseBookTransition);
  const projectSize = options.preview.getProjectSize();
  if (!projectSize) {
    throw new Error("Project size is unavailable.");
  }

  const timestamp = buildOfflineExportTimestamp();
  const videoCodec = await pickVideoCodec(projectSize.width, projectSize.height, options.fps);
  const totalFrames = getTotalTimelineFrames(timeline.scenes, timeline.transitions, options.fps);
  const segmentResults: OfflineMp4ExportResult[] = [];
  const transitionByFromScene = new Map(
    timeline.transitions.map((transition) => [transition.fromScene.sceneId, transition]),
  );

  let currentSceneId: string | null = null;
  let activeTransition: BookTransitionOverlay | null = null;
  let encodedFrames = 0;
  let segmentIndex = 0;

  const reportProgress = (currentSceneIdForProgress: string | null, message: string) => {
    options.onProgress?.({
      progress: totalFrames > 0 ? Math.min(1, encodedFrames / totalFrames) : 0,
      encodedFrames,
      totalFrames,
      currentSceneId: currentSceneIdForProgress,
      message,
    });
  };

  const transcodeSegment = async (segment: VideoSegmentWebmRenderResult): Promise<void> => {
    if (segment.encodedFrameCount <= 0 || segment.blob.size <= 0) {
      return;
    }

    const segmentMp4FileName = replaceFileExtension(segment.fileName, ".mp4");
    options.onStatus({ message: `Transcoding segment ${segment.label}...` });
    const result = await exportWebmToMp4(segment, {
      baseUrl: serviceOptions.baseUrl,
      healthPath: serviceOptions.healthPath,
      transcodePath: serviceOptions.transcodePath,
      requestTimeoutMs: serviceOptions.requestTimeoutMs,
      headers: serviceOptions.headers,
      fileName: segmentMp4FileName,
      fps: serviceOptions.fps ?? options.fps,
    });
    segmentResults.push(result);
  };

  reportProgress(null, "Preparing segmented export...");

  try {
    for (const timelineScene of timeline.scenes) {
      if (options.isCancelled()) {
        break;
      }

      if (currentSceneId !== timelineScene.scene.sceneId) {
        await options.applyScene(timelineScene.scene.sceneId, 0, { useBookTransition: false });
        currentSceneId = options.getActiveScene().sceneId;
      }

      segmentIndex += 1;
      const frameCount = Math.max(1, Math.round(timelineScene.durationSec * options.fps));
      const label = `${String(segmentIndex).padStart(3, "0")}-${timelineScene.scene.sceneId}`;
      const fileName = `${sanitizeFilePart(options.project.projectName)}-${sanitizeFilePart(label)}-${timestamp}.webm`;
      const message = `Encoding segment ${label} (${frameCount} frames)`;
      options.onStatus({ message });
      reportProgress(timelineScene.scene.sceneId, message);

      const sceneSegment = await renderVideoOnlyWebmSegment(options, videoCodec, {
        fileName,
        label,
        frameCount,
        timestamp,
        renderFrame: async (frameOffset) => {
          const sceneTimeSec = Math.min(timelineScene.durationSec, frameOffset / options.fps);
          await options.preview.prepareFrame(sceneTimeSec);
        },
        onFrameEncoded: () => {
          encodedFrames += 1;
          reportProgress(timelineScene.scene.sceneId, `Encoding segment ${label}`);
        },
      });
      await transcodeSegment(sceneSegment);

      const transition = transitionByFromScene.get(timelineScene.scene.sceneId);
      if (!transition || options.isCancelled()) {
        continue;
      }

      activeTransition = await options.preview.createBookTransitionOverlay();
      if (!activeTransition) {
        continue;
      }
      const transitionOverlay = activeTransition;

      segmentIndex += 1;
      const transitionFrameCount = Math.max(1, Math.round(transition.durationSec * options.fps));
      const transitionLabel = `${String(segmentIndex).padStart(3, "0")}-${transition.fromScene.sceneId}-to-${transition.toScene.sceneId}`;
      const transitionFileName = `${sanitizeFilePart(options.project.projectName)}-${sanitizeFilePart(transitionLabel)}-${timestamp}.webm`;
      const transitionMessage = `Encoding segment ${transitionLabel} (${transitionFrameCount} frames)`;
      options.onStatus({ message: transitionMessage });
      reportProgress(transition.toScene.sceneId, transitionMessage);

      const transitionSegment = await renderVideoOnlyWebmSegment(options, videoCodec, {
        fileName: transitionFileName,
        label: transitionLabel,
        frameCount: transitionFrameCount,
        timestamp,
        renderFrame: async (transitionFrame) => {
          const transitionTimeSec = transitionFrame / options.fps;
          const isCoverPhase = transitionTimeSec < BOOK_TRANSITION_COVER_SEC;

          if (isCoverPhase) {
            await options.preview.prepareFrame(timelineScene.durationSec);
            const coverProgress = Math.min(1, transitionTimeSec / BOOK_TRANSITION_COVER_SEC);
            options.preview.drawBookTransitionOverlay(transitionOverlay, coverProgress, "cover");
          } else {
            if (currentSceneId !== transition.toScene.sceneId) {
              await options.applyScene(transition.toScene.sceneId, 0, { useBookTransition: false });
              currentSceneId = options.getActiveScene().sceneId;
            }

            await options.preview.prepareFrame(0);
            const revealProgress = Math.min(
              1,
              (transitionTimeSec - BOOK_TRANSITION_COVER_SEC) / (transition.durationSec - BOOK_TRANSITION_COVER_SEC),
            );
            options.preview.drawBookTransitionOverlay(transitionOverlay, revealProgress, "reveal");
          }

          options.preview.renderNow();
        },
        onFrameEncoded: () => {
          encodedFrames += 1;
          reportProgress(
            transition.toScene.sceneId,
            `Encoding segment ${transitionLabel}`,
          );
        },
      });

      options.preview.clearBookTransitionOverlay(transitionOverlay);
      activeTransition = null;
      await transcodeSegment(transitionSegment);
    }
  } finally {
    options.preview.clearBookTransitionOverlay(activeTransition);
  }

  if (!segmentResults.length) {
    throw new Error("No video segments were exported.");
  }

  options.onStatus({ message: "Mixing final audio..." });
  const mixedAudio = await renderMixedAudio(
    options.project,
    timeline.scenes,
    timeline.transitions,
    timeline.totalDurationSec,
  );
  const audio = encodeAudioBufferToWav(
    mixedAudio,
    `${sanitizeFilePart(options.project.projectName)}-mixed-audio-${timestamp}.wav`,
  );

  options.onStatus({ message: "Combining MP4 segments..." });
  const finalFileName = serviceOptions.fileName
    ? ensureEndMp4FileName(serviceOptions.fileName)
    : buildFinalMp4FileName(options, timestamp, options.isCancelled());
  const result = await concatMp4Segments(segmentResults, {
    baseUrl: serviceOptions.baseUrl,
    healthPath: serviceOptions.healthPath,
    requestTimeoutMs: serviceOptions.requestTimeoutMs,
    headers: serviceOptions.headers,
    fileName: finalFileName,
    outputPath: serviceOptions.outputPath,
    fps: serviceOptions.fps ?? options.fps,
    audio,
    cleanupSegments: true,
  });

  options.onStatus({ message: `MP4 ready: ${result.fileName}` });
  return result;
}

export async function exportProjectOfflineMp4(
  options: OfflineExportOptions,
  serviceOptions: FfmpegMp4ExportOptions = {},
): Promise<OfflineMp4ExportResult> {
  if (shouldUseSegmentedMp4Export(options)) {
    return await exportProjectSegmentedMp4(options, serviceOptions);
  }

  const webm = await renderProjectOfflineWebm(options);
  options.onStatus({ message: "Sending WebM to ffmpeg service..." });
  const finalFileName = serviceOptions.fileName
    ? ensureEndMp4FileName(serviceOptions.fileName)
    : buildFinalMp4FileName(options, webm.timestamp, webm.wasCancelled);
  const result = await exportWebmToMp4(webm, {
    ...serviceOptions,
    fileName: finalFileName,
  });
  options.onStatus({ message: `MP4 ready: ${result.fileName}` });
  return result;
}
