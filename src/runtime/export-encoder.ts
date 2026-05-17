import type { ArrayBufferTarget, Muxer } from "webm-muxer";

import type { BookTransitionOverlay } from "./pixi-preview-app";

import type { OfflineExportOptions, TimelineScene, TimelineTransition, VideoCodecChoice } from "./export-shared";
import { BOOK_TRANSITION_COVER_SEC } from "./export-shared";

export async function pickVideoCodec(width: number, height: number, fps: number): Promise<VideoCodecChoice> {
  const candidates: VideoCodecChoice[] = [
    { encoderCodec: "vp09.00.10.08", muxerCodec: "V_VP9" },
    { encoderCodec: "vp8", muxerCodec: "V_VP8" },
  ];

  for (const candidate of candidates) {
    const support = await VideoEncoder.isConfigSupported({
      codec: candidate.encoderCodec,
      width,
      height,
      bitrate: 10_000_000,
      framerate: fps,
      latencyMode: "quality",
    });

    if (support.supported) {
      return candidate;
    }
  }

  throw new Error("This browser does not support VP8/VP9 WebCodecs export.");
}

async function ensureAudioEncoderSupported(sampleRate: number, numberOfChannels: number): Promise<void> {
  const support = await AudioEncoder.isConfigSupported({
    codec: "opus",
    sampleRate,
    numberOfChannels,
    bitrate: 192_000,
  });

  if (!support.supported) {
    throw new Error("This browser does not support Opus audio encoding.");
  }
}

export async function encodeAudioTrack(
  muxer: Muxer<ArrayBufferTarget>,
  audioBuffer: AudioBuffer,
): Promise<void> {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  await ensureAudioEncoderSupported(sampleRate, numberOfChannels);

  // Opus supports up to 60 ms packet durations. Using larger chunks dramatically
  // reduces encoder call overhead during offline exports without changing the mix.
  const frameSize = Math.max(960, Math.round(sampleRate * 0.06));
  const totalFrames = audioBuffer.length;

  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (error) => {
      throw error;
    },
  });

  audioEncoder.configure({
    codec: "opus",
    sampleRate,
    numberOfChannels,
    bitrate: 192_000,
  });

  for (let frameStart = 0; frameStart < totalFrames; frameStart += frameSize) {
    const framesInChunk = Math.min(frameSize, totalFrames - frameStart);
    const planar = new Float32Array(framesInChunk * numberOfChannels);

    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      const channelData = audioBuffer.getChannelData(channel).subarray(frameStart, frameStart + framesInChunk);
      planar.set(channelData, channel * framesInChunk);
    }

    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: framesInChunk,
      numberOfChannels,
      timestamp: Math.round((frameStart / sampleRate) * 1_000_000),
      data: planar,
    });

    audioEncoder.encode(audioData);
    audioData.close();
  }

  await audioEncoder.flush();
  audioEncoder.close();
}

export async function encodeVideoTrack(
  muxer: Muxer<ArrayBufferTarget>,
  options: OfflineExportOptions,
  timelineScenes: TimelineScene[],
  transitions: TimelineTransition[],
  videoCodec: VideoCodecChoice,
): Promise<void> {
  const projectSize = options.preview.getProjectSize();
  if (!projectSize) {
    throw new Error("Project size is unavailable.");
  }

  let currentSceneId: string | null = null;
  let activeTransition: BookTransitionOverlay | null = null;

  const transitionByFromScene = new Map<string, TimelineTransition>(
    transitions.map((transition) => [transition.fromScene.sceneId, transition]),
  );

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

  let frameIndex = 0;
  const totalFrames =
    timelineScenes.reduce((sum, timelineScene) => sum + Math.max(1, Math.round(timelineScene.durationSec * options.fps)), 0)
    + transitions.reduce((sum, transition) => sum + Math.max(1, Math.round(transition.durationSec * options.fps)), 0);
  let lastReportedFrameIndex = -1;

  const reportProgress = (currentSceneIdForProgress: string | null, message: string) => {
    if (!options.onProgress) {
      return;
    }

    if (frameIndex === lastReportedFrameIndex && frameIndex !== totalFrames) {
      return;
    }

    lastReportedFrameIndex = frameIndex;
    options.onProgress({
      progress: totalFrames > 0 ? Math.min(1, frameIndex / totalFrames) : 0,
      encodedFrames: frameIndex,
      totalFrames,
      currentSceneId: currentSceneIdForProgress,
      message,
    });
  };

  for (const timelineScene of timelineScenes) {
    if (options.isCancelled()) {
      break;
    }

    if (currentSceneId !== timelineScene.scene.sceneId) {
      await options.applyScene(timelineScene.scene.sceneId, 0, { useBookTransition: false });
      currentSceneId = options.getActiveScene().sceneId;
    }

    const frameCount = Math.max(1, Math.round(timelineScene.durationSec * options.fps));
    options.onStatus({
      message: `Encoding scene ${timelineScene.scene.sceneId} (${frameCount} frames)`,
    });
    reportProgress(
      timelineScene.scene.sceneId,
      `Encoding scene ${timelineScene.scene.sceneId} (${frameCount} frames)`,
    );

    for (let frameOffset = 0; frameOffset < frameCount; frameOffset += 1) {
      if (options.isCancelled()) {
        break;
      }

      const sceneTimeSec = Math.min(timelineScene.durationSec, frameOffset / options.fps);
      await options.preview.prepareFrame(sceneTimeSec);

      const frame = new VideoFrame(options.preview.getCanvas(), {
        timestamp: Math.round((frameIndex / options.fps) * 1_000_000),
        duration: Math.round((1 / options.fps) * 1_000_000),
      });
      videoEncoder.encode(frame, { keyFrame: frameIndex % options.fps === 0 });
      frame.close();
      frameIndex += 1;
      reportProgress(timelineScene.scene.sceneId, `Encoding scene ${timelineScene.scene.sceneId}`);
    }

    const transition = transitionByFromScene.get(timelineScene.scene.sceneId);
    if (!transition || options.isCancelled()) {
      continue;
    }

    activeTransition = await options.preview.createBookTransitionOverlay();
    if (!activeTransition) {
      continue;
    }

    const transitionFrameCount = Math.max(1, Math.round(transition.durationSec * options.fps));
    reportProgress(
      transition.fromScene.sceneId,
      `Encoding transition ${transition.fromScene.sceneId} -> ${transition.toScene.sceneId}`,
    );

    for (let transitionFrame = 0; transitionFrame < transitionFrameCount; transitionFrame += 1) {
      if (options.isCancelled()) {
        break;
      }

      const transitionTimeSec = transitionFrame / options.fps;
      const isCoverPhase = transitionTimeSec < BOOK_TRANSITION_COVER_SEC;

      if (isCoverPhase) {
        await options.preview.prepareFrame(timelineScene.durationSec);
        const coverProgress = Math.min(1, transitionTimeSec / BOOK_TRANSITION_COVER_SEC);
        options.preview.drawBookTransitionOverlay(activeTransition, coverProgress, "cover");
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
        options.preview.drawBookTransitionOverlay(activeTransition, revealProgress, "reveal");
      }

      options.preview.renderNow();
      const frame = new VideoFrame(options.preview.getCanvas(), {
        timestamp: Math.round((frameIndex / options.fps) * 1_000_000),
        duration: Math.round((1 / options.fps) * 1_000_000),
      });
      videoEncoder.encode(frame, { keyFrame: transitionFrame === 0 });
      frame.close();
      frameIndex += 1;
      reportProgress(
        transition.toScene.sceneId,
        `Encoding transition ${transition.fromScene.sceneId} -> ${transition.toScene.sceneId}`,
      );
    }

    options.preview.clearBookTransitionOverlay(activeTransition);
    activeTransition = null;
  }

  options.preview.clearBookTransitionOverlay(activeTransition);
  await videoEncoder.flush();
  videoEncoder.close();
  reportProgress(currentSceneId, "Video encoding complete");
}
