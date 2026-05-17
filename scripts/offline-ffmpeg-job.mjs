import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import xlsx from "xlsx";

const XLSX = xlsx;

const BOOK_TRANSITION_TOTAL_SEC = 0.94;
const VIDEO_GROUP_SEC = 12;
const FONT_BOLD = "C\\:/Windows/Fonts/malgunbd.ttf";
const FONT_REGULAR = "C\\:/Windows/Fonts/malgun.ttf";
const AUDIO_SAMPLE_RATE = 48_000;

function toText(value) {
  return String(value ?? "").trim();
}

function toNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value) {
  const normalized = toText(value).toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function parseRows(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return [];
  }

  return XLSX.utils.sheet_to_json(sheet, {
    defval: "",
    raw: false,
  });
}

function parseWorkbookData(workbook) {
  const projectRows = parseRows(workbook, "Project");
  const scenesRows = parseRows(workbook, "Scenes");
  const audioRows = parseRows(workbook, "Audio");
  const markerRows = parseRows(workbook, "Markers");

  const project = {
    projectName: "sample",
    width: 1280,
    height: 720,
    fps: 30,
  };

  for (const row of projectRows) {
    const key = toText(row.key);
    if (!key) {
      continue;
    }

    if (key === "projectName") project.projectName = toText(row.value) || project.projectName;
    if (key === "width") project.width = toNumber(row.value, project.width);
    if (key === "height") project.height = toNumber(row.value, project.height);
    if (key === "fps") project.fps = toNumber(row.value, project.fps);
  }

  const scenes = scenesRows
    .map((row) => ({
      sceneId: toText(row.sceneId),
      sceneType: toText(row.sceneType),
      step: toText(row.step) ? toNumber(row.step) : null,
      durationSec: toNumber(row.durationSec, 5),
      titleText: toText(row.titleText),
      backgroundImage: toText(row.backgroundImage),
      backgroundVideo: toText(row.backgroundVideo),
      foregroundImage: toText(row.foregroundImage),
      countdownFrom: toNumber(row.countdownFrom, 0),
      bannerText: toText(row.bannerText),
      textColor: toText(row.textColor) || "#ffffff",
      bannerImage: toText(row.bannerImage),
      badgeImage: toText(row.badgeImage),
      panelFrameImage: toText(row.panelFrameImage),
    }))
    .filter((row) => row.sceneId);

  const audio = audioRows
    .map((row) => ({
      sceneId: toText(row.sceneId),
      trackType: toText(row.trackType) || "bgm",
      resourcePath: toText(row.resourcePath),
      startSec: toNumber(row.startSec),
      volume: toNumber(row.volume, 1),
      loop: toBoolean(row.loop),
    }))
    .filter((row) => row.sceneId && row.resourcePath);

  const markers = markerRows
    .map((row) => ({
      sceneId: toText(row.sceneId),
      step: toNumber(row.step),
      side: toText(row.side) || "left",
      cx: toNumber(row.cx),
      cy: toNumber(row.cy),
      radius: toNumber(row.radius, 0.04),
      revealAtSec: toNumber(row.revealAtSec),
      texturePath: toText(row.texturePath),
    }))
    .filter((row) => row.sceneId);

  return {
    project,
    scenes,
    audio,
    markers,
  };
}

function publicPathToFsPath(projectRoot, publicPath) {
  if (!publicPath) {
    return "";
  }

  const normalized = publicPath.replace(/^\/+/, "").replace(/\//g, path.sep);
  return path.join(projectRoot, "public", normalized);
}

function relativeResourceToFsPath(projectRoot, projectName, resourcePath) {
  if (!resourcePath) {
    return "";
  }

  const normalized = resourcePath.replace(/^\/+/, "").replace(/\//g, path.sep);
  return path.join(projectRoot, "public", "projects", projectName, normalized);
}

function escapeFilterValue(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function escapeConcatPath(value) {
  return value.replace(/'/g, "'\\''");
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "--:--";
  }

  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function shouldUseBookTransition(fromScene, toScene) {
  if (!fromScene || !toScene || fromScene.sceneId === toScene.sceneId) {
    return false;
  }

  return (
    (fromScene.sceneType === "title_card" && toScene.sceneType === "puzzle_scene") ||
    (fromScene.sceneType === "answer_reveal" && toScene.sceneType === "puzzle_scene") ||
    (fromScene.sceneType === "answer_reveal" && toScene.sceneType === "timeout_card")
  );
}

function ensureAutoStepAudio(scene, audioRows, projectName, projectRoot) {
  const sceneAudio = audioRows.filter((row) => row.sceneId === scene.sceneId);
  const hasBgm = sceneAudio.some((row) => row.trackType === "bgm");
  if (hasBgm || scene.step == null) {
    return sceneAudio;
  }

  const autoCandidates = [
    `resources/audio/bgm/${scene.step}.mp3`,
    `resources/audio/bgm/${scene.step}.wav`,
  ];
  for (const candidate of autoCandidates) {
    const filePath = relativeResourceToFsPath(projectRoot, projectName, candidate);
    sceneAudio.push({
      sceneId: scene.sceneId,
      trackType: "bgm",
      resourcePath: candidate,
      filePath,
      startSec: 0,
      volume: 0.8,
      loop: true,
      autoInserted: true,
    });
    return sceneAudio;
  }

  return sceneAudio;
}

async function fileExists(filePath) {
  if (!filePath) {
    return false;
  }

  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function createJobProgressUpdater(job) {
  if (!job.wallStartMs) {
    job.wallStartMs = Date.now();
  }
  return (completedSec, currentSec, totalSec, label) => {
    const safeCurrent = Number.isFinite(currentSec) ? currentSec : 0;
    const normalizedCurrent = Math.max(0, Math.min(safeCurrent, totalSec));
    const progress = Math.max(0, Math.min(1, (completedSec + normalizedCurrent) / Math.max(totalSec, 0.001)));
    const elapsedSec = (Date.now() - job.wallStartMs) / 1000;
    const etaSec = progress > 0 ? (elapsedSec / progress) - elapsedSec : null;

    job.progress = progress;
    job.elapsedSec = elapsedSec;
    job.etaSec = etaSec;
    job.message = `${(progress * 100).toFixed(1)}% · ETA ${formatEta(etaSec ?? 0)} · ${label}`;
  };
}

function runFfmpegWithProgress(ffmpegCommand, args, onProgress, childHolder, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegCommand, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...envOverrides,
      },
    });

    childHolder.current = child;

    let stdoutBuffer = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const [key, rawValue] = line.split("=");
        if (key === "out_time_ms") {
          const currentSec = Number(rawValue) / 1_000_000;
          onProgress?.(currentSec);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      childHolder.current = null;
      reject(error);
    });

    child.on("close", (code) => {
      childHolder.current = null;
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}.`));
    });
  });
}

function buildTextFilters(scene, width) {
  const filters = [];
  const centerText = scene.bannerText || scene.titleText;

  if (scene.step != null) {
    filters.push(
      `drawtext=fontfile='${FONT_BOLD}':text='${escapeFilterValue(`STEP ${scene.step}`)}':fontcolor=0xffc000:fontsize=24:borderw=6:bordercolor=0x120b05:x=20:y=10`,
    );
    filters.push(
      `drawtext=fontfile='${FONT_BOLD}':text='${escapeFilterValue(`${scene.step}`)}/${escapeFilterValue(String(scene.detectedStepCount ?? scene.step))}':fontcolor=white:fontsize=22:borderw=6:bordercolor=0x120b05:x=24:y=46`,
    );
  }

  if (centerText) {
    filters.push(
      `drawtext=fontfile='${FONT_BOLD}':text='${escapeFilterValue(centerText)}':fontcolor=${escapeFilterValue(scene.textColor || "#ffffff")}:fontsize=20:borderw=6:bordercolor=0x120b05:x=170:y=42`,
    );
  }

  return filters;
}

function createSceneInputs(scene, context) {
  const inputs = [];
  const { projectRoot, projectName } = context;

  const pushImage = (filePath) => {
    inputs.push({ kind: "image", filePath });
    return inputs.length; // input 0 is the base color source
  };

  const pushVideo = (filePath) => {
    inputs.push({ kind: "video", filePath });
    return inputs.length;
  };

  const resolved = {
    backgroundVideoIndex: null,
    backgroundImageIndex: null,
    foregroundIndex: null,
    hudBarIndex: null,
    leftPuzzleIndex: null,
    rightPuzzleIndex: null,
    beeIndex: null,
    hiveIndex: null,
    stepOverlayIndex: null,
    timeoutOverlayIndex: null,
    markerInputs: [],
  };

  const bgVideoPath = relativeResourceToFsPath(projectRoot, projectName, scene.backgroundVideo);
  const bgImagePath = relativeResourceToFsPath(projectRoot, projectName, scene.backgroundImage);
  const fgPath = relativeResourceToFsPath(projectRoot, projectName, scene.foregroundImage);
  const hudPath = relativeResourceToFsPath(projectRoot, projectName, scene.bannerImage || "resources/images/ui/hud/hud-bar.png");
  const beePath = path.join(projectRoot, "public", "projects", projectName, "resources", "images", "ui", "hud", "bee.png");
  const hivePath = path.join(projectRoot, "public", "projects", projectName, "resources", "images", "ui", "hud", "beehouse.png");
  const stepPath = path.join(projectRoot, "public", "projects", projectName, "resources", "images", "ui", "hud", "step.png");
  const endingPath = path.join(projectRoot, "public", "projects", projectName, "resources", "images", "ui", "hud", "ending.png");

  if (scene.backgroundVideo && scene.backgroundVideoExists) {
    resolved.backgroundVideoIndex = pushVideo(bgVideoPath);
  }
  if (scene.backgroundImage && scene.backgroundImageExists) {
    resolved.backgroundImageIndex = pushImage(bgImagePath);
  }
  if (scene.foregroundImage && scene.foregroundImageExists) {
    resolved.foregroundIndex = pushImage(fgPath);
  }
  if (scene.sceneType === "puzzle_scene" || scene.sceneType === "answer_reveal") {
    if (scene.hudBarExists) {
      resolved.hudBarIndex = pushImage(hudPath);
    }
    if (scene.stepImages?.leftExists) {
      resolved.leftPuzzleIndex = pushImage(scene.stepImages.leftFilePath);
    }
    if (scene.stepImages?.rightExists) {
      resolved.rightPuzzleIndex = pushImage(scene.stepImages.rightFilePath);
    }
    if (scene.beeExists) {
      resolved.beeIndex = pushImage(beePath);
    }
    if (scene.hiveExists) {
      resolved.hiveIndex = pushImage(hivePath);
    }
    if (scene.sceneType === "puzzle_scene" && scene.stepOverlayExists) {
      resolved.stepOverlayIndex = pushImage(stepPath);
    }
    for (const marker of scene.markers) {
      if (marker.filePath) {
        resolved.markerInputs.push({
          marker,
          inputIndex: pushImage(marker.filePath),
        });
      }
    }
  }
  if (scene.sceneType === "timeout_card" && scene.timeoutOverlayExists) {
    resolved.timeoutOverlayIndex = pushImage(endingPath);
  }

  return {
    inputs,
    resolved,
  };
}

function buildSceneVideoFilter(scene, context, inputs, chunkStartSec, segmentDurationSec) {
  const { width, height } = context;
  const filters = [];
  let current = "vbase0";
  filters.push(`[0:v]format=rgba[${current}]`);

  let labelIndex = 1;
  const nextLabel = () => `vbase${labelIndex++}`;
  const overlayAt = (overlayLabel, x, y, extra = "") => {
    const next = nextLabel();
    filters.push(`[${current}][${overlayLabel}]overlay=x=${x}:y=${y}${extra}[${next}]`);
    current = next;
  };

  if (inputs.resolved.backgroundVideoIndex != null) {
    filters.push(
      `[${inputs.resolved.backgroundVideoIndex}:v]trim=start=${chunkStartSec}:duration=${segmentDurationSec},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}[bgvideo]`,
    );
    overlayAt("bgvideo", "0", "0");
  }

  if (inputs.resolved.backgroundImageIndex != null) {
    filters.push(
      `[${inputs.resolved.backgroundImageIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}[bgimage]`,
    );
    overlayAt("bgimage", "0", "0");
  }

  if (scene.sceneType === "title_card" || scene.sceneType === "timeout_card") {
    if (inputs.resolved.foregroundIndex != null) {
      filters.push(
        `[${inputs.resolved.foregroundIndex}:v]scale=${width - 60}:${height - 60}:force_original_aspect_ratio=decrease[fgcard]`,
      );
      overlayAt("fgcard", "(W-w)/2", "(H-h)/2");
    }

    if (inputs.resolved.timeoutOverlayIndex != null) {
      filters.push(
        `[${inputs.resolved.timeoutOverlayIndex}:v]scale=${Math.floor(width * 0.78)}:-1:force_original_aspect_ratio=decrease[timeoutoverlay]`,
      );
      overlayAt("timeoutoverlay", "(W-w)/2", "(H-h)/2");
    }

    return { filters, outputLabel: current };
  }

  if (inputs.resolved.hudBarIndex != null) {
    filters.push(`[${inputs.resolved.hudBarIndex}:v]scale=${width}:96[hudbar]`);
    overlayAt("hudbar", "0", "0");
  }

  if (inputs.resolved.leftPuzzleIndex != null) {
    filters.push(`[${inputs.resolved.leftPuzzleIndex}:v]scale=624:620:force_original_aspect_ratio=increase,crop=624:620[leftpuzzle]`);
    overlayAt("leftpuzzle", "12", "98");
  }

  if (inputs.resolved.rightPuzzleIndex != null) {
    filters.push(`[${inputs.resolved.rightPuzzleIndex}:v]scale=624:620:force_original_aspect_ratio=increase,crop=624:620[rightpuzzle]`);
    overlayAt("rightpuzzle", "644", "98");
  }

  let next = nextLabel();
  filters.push(
    `[${current}]drawbox=x=10:y=96:w=628:h=624:color=black:t=4,drawbox=x=642:y=96:w=628:h=624:color=black:t=4,drawbox=x=638:y=96:w=4:h=624:color=black:t=fill[${next}]`,
  );
  current = next;

  const textFilters = buildTextFilters(scene, width);
  if (textFilters.length) {
    next = nextLabel();
    filters.push(`[${current}]${textFilters.join(",")}[${next}]`);
    current = next;
  }

  if (inputs.resolved.hiveIndex != null) {
    filters.push(`[${inputs.resolved.hiveIndex}:v]scale=62:62[hive]`);
    overlayAt("hive", "1143", "28");
  }

  if (inputs.resolved.beeIndex != null) {
    filters.push(`[${inputs.resolved.beeIndex}:v]scale=74:74[bee]`);
    const timerDuration = Math.max(scene.countdownFrom || scene.durationSec, 1);
    const beeX =
      scene.sceneType === "answer_reveal"
        ? "1089"
        : `'694+436*min((t+${chunkStartSec})/${timerDuration},1)'`;
    overlayAt("bee", beeX, "22");
  }

  next = nextLabel();
  if (scene.sceneType === "answer_reveal") {
    filters.push(
      `[${current}]drawbox=x=1111:y=56:w=19:h=6:color=0xffc000:t=fill,drawtext=fontfile='${FONT_BOLD}':text='0':fontcolor=white:fontsize=42:borderw=8:bordercolor=0x120b05:x=1270-tw:y=39[${next}]`,
    );
  } else {
    const duration = Math.max(scene.countdownFrom || scene.durationSec, 1);
    filters.push(
      `[${current}]drawbox=x='(694+436*min((t+${chunkStartSec})/${duration},1))+22':y=56:w='max(0,1130-((694+436*min((t+${chunkStartSec})/${duration},1))+22))':h=6:color=0xffc000:t=fill,drawtext=fontfile='${FONT_BOLD}':text='%{eif\\\\:max(0\\,ceil(${duration}-(t+${chunkStartSec})))\\\\:d}':fontcolor=white:fontsize=42:borderw=8:bordercolor=0x120b05:x=1270-tw:y=39[${next}]`,
    );
  }
  current = next;

  if (scene.sceneType === "puzzle_scene" && inputs.resolved.stepOverlayIndex != null) {
    const startWindow = Math.max(0, 0 - chunkStartSec);
    const endWindow = Math.max(0, 1.2 - chunkStartSec);
    if (endWindow > startWindow) {
      filters.push(
        `[${inputs.resolved.stepOverlayIndex}:v]scale=${Math.floor(width * 0.85)}:-1:force_original_aspect_ratio=decrease[stepoverlay]`,
      );
      overlayAt("stepoverlay", "(W-w)/2", "(H-h)/2", `:enable='between(t,${startWindow},${endWindow})'`);
    }
  }

  if (scene.sceneType === "answer_reveal") {
    for (const markerInput of inputs.resolved.markerInputs) {
      const marker = markerInput.marker;
      const rect = marker.side === "left"
        ? { x: 12, y: 98, width: 624, height: 620 }
        : { x: 644, y: 98, width: 624, height: 620 };
      const diameter = rect.width * marker.radius * 2 * 0.8;
      const markerX = rect.x + rect.width * marker.cx - diameter / 2;
      const markerY = rect.y + rect.height * marker.cy - diameter / 2;
      const markerLabelA = `marker${markerInput.inputIndex}a`;
      const markerLabelB = `marker${markerInput.inputIndex}b`;
      const markerSize = `${Math.max(4, Math.round(diameter))}:${Math.max(4, Math.round(diameter))}`;
      filters.push(`[${markerInput.inputIndex}:v]scale=${markerSize}[${markerLabelA}]`);
      overlayAt(markerLabelA, `${markerX}`, `${markerY}`, `:enable='gte(t+${chunkStartSec},${marker.revealAtSec})'`);

      const oppositeRect = marker.side === "left"
        ? { x: 644, y: 98, width: 624, height: 620 }
        : { x: 12, y: 98, width: 624, height: 620 };
      const markerX2 = oppositeRect.x + oppositeRect.width * marker.cx - diameter / 2;
      const markerY2 = oppositeRect.y + oppositeRect.height * marker.cy - diameter / 2;
      filters.push(`[${markerInput.inputIndex}:v]scale=${markerSize}[${markerLabelB}]`);
      overlayAt(markerLabelB, `${markerX2}`, `${markerY2}`, `:enable='gte(t+${chunkStartSec},${marker.revealAtSec})'`);
    }
  }

  return { filters, outputLabel: current };
}

function buildSceneAudioFilter(scene, context, inputs, chunkStartSec, segmentDurationSec) {
  const filters = [];
  const labels = ["abase"];
  filters.push(`[1:a]atrim=0:${segmentDurationSec},asetpts=PTS-STARTPTS[abase]`);

  let inputIndex = inputs.inputs.length + 2;
  const audioInputs = [];
  for (const track of scene.audioTracks) {
    if (!track.exists) {
      continue;
    }

    audioInputs.push({
      inputIndex,
      track,
    });
    inputIndex += 1;
  }

  if (scene.sceneType === "answer_reveal" && scene.okSfxPath && scene.markers.length) {
    for (const marker of scene.markers) {
      audioInputs.push({
        inputIndex,
        track: {
          trackType: "sfx",
          startSec: marker.revealAtSec,
          volume: 1,
          loop: false,
          filePath: scene.okSfxPath,
          exists: true,
        },
      });
      inputIndex += 1;
    }
  }

  for (const entry of audioInputs) {
    const label = `a${labels.length}`;
    if (entry.track.trackType === "bgm") {
      const bgmStart = Math.max(0, chunkStartSec - entry.track.startSec);
      filters.push(
        `[${entry.inputIndex}:a]atrim=start=${bgmStart}:duration=${segmentDurationSec},volume=${entry.track.volume},asetpts=PTS-STARTPTS[${label}]`,
      );
    } else {
      const relativeStart = entry.track.startSec - chunkStartSec;
      const delayMs = Math.max(0, Math.round(relativeStart * 1000));
      const trimStart = Math.max(0, -relativeStart);
      filters.push(
        `[${entry.inputIndex}:a]volume=${entry.track.volume},atrim=start=${trimStart}:duration=${segmentDurationSec},adelay=${delayMs}|${delayMs},asetpts=PTS-STARTPTS[${label}]`,
      );
    }
    labels.push(label);
  }

  const outputLabel = "aout";
  filters.push(`${labels.map((label) => `[${label}]`).join("")}amix=inputs=${labels.length}:normalize=0:duration=longest[${outputLabel}]`);
  return { filters, outputLabel, audioInputs };
}

async function renderSceneSegment(
  job,
  context,
  scene,
  segmentPath,
  chunkStartSec,
  segmentDurationSec,
  progressBaseSec,
  totalDurationSec,
  childHolder,
) {
  const colorInput = `color=c=black:s=${context.width}x${context.height}:r=${context.fps}:d=${segmentDurationSec}`;
  const { inputs, resolved } = createSceneInputs(scene, context);
  const videoFilter = buildSceneVideoFilter(scene, context, { inputs, resolved }, chunkStartSec, segmentDurationSec);
  const filterScriptPath = path.join(context.tempRoot, `${scene.sceneId}-${chunkStartSec}-${randomUUID()}.fcs`);

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-progress",
    "pipe:1",
    "-nostats",
    "-f",
    "lavfi",
    "-i",
    colorInput,
  ];

  for (const input of inputs) {
    if (input.kind === "image") {
      args.push("-loop", "1", "-i", input.filePath);
    } else {
      args.push("-stream_loop", "-1", "-i", input.filePath);
    }
  }

  const filterScript = `${videoFilter.filters.join(";\n")}\n`;
  await fs.writeFile(filterScriptPath, filterScript, "utf8");

  args.push(
    "-filter_complex_script",
    filterScriptPath,
    "-map",
    `[${videoFilter.outputLabel}]`,
    "-t",
    String(segmentDurationSec),
    "-r",
    String(context.fps),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-movflags",
    "+faststart",
    segmentPath,
  );

  const update = createJobProgressUpdater(job);
  await runFfmpegWithProgress(
    context.ffmpegCommand,
    args,
    (currentSec) => update(progressBaseSec, currentSec, totalDurationSec, `Rendering scene ${scene.sceneId}`),
    childHolder,
    context.ffmpegEnv,
  );

  await fs.rm(filterScriptPath, { force: true }).catch(() => {});
}

async function renderTransitionSegment(job, context, fromSegmentPath, toSegmentPath, outputPath, progressBaseSec, totalDurationSec, childHolder) {
  const filterScriptPath = path.join(context.tempRoot, `transition-${randomUUID()}.fcs`);
  const filterScript = [
    `[0:v]trim=duration=${BOOK_TRANSITION_TOTAL_SEC},setpts=PTS-STARTPTS[v0]`,
    `[1:v]trim=duration=${BOOK_TRANSITION_TOTAL_SEC},setpts=PTS-STARTPTS[v1]`,
    `[v0][v1]xfade=transition=wipeleft:duration=${BOOK_TRANSITION_TOTAL_SEC}:offset=0[vout]`,
  ].join(";\n");

  await fs.writeFile(filterScriptPath, filterScript, "utf8");

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-progress",
    "pipe:1",
    "-nostats",
    "-stream_loop",
    "-1",
    "-i",
    fromSegmentPath,
    "-stream_loop",
    "-1",
    "-i",
    toSegmentPath,
    "-filter_complex_script",
    filterScriptPath,
    "-map",
    "[vout]",
    "-t",
    String(BOOK_TRANSITION_TOTAL_SEC),
    "-r",
    String(context.fps),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  const update = createJobProgressUpdater(job);
  await runFfmpegWithProgress(
    context.ffmpegCommand,
    args,
    (currentSec) => update(progressBaseSec, currentSec, totalDurationSec, "Rendering transition"),
    childHolder,
    context.ffmpegEnv,
  );

  await fs.rm(filterScriptPath, { force: true }).catch(() => {});
}

async function concatSegments(job, context, segmentPaths, outputPath, childHolder) {
  const listPath = path.join(context.tempRoot, `concat-${randomUUID()}.txt`);
  const listContent = segmentPaths.map((segmentPath) => `file '${escapeConcatPath(segmentPath)}'`).join("\n");
  await fs.writeFile(listPath, `${listContent}\n`, "utf8");

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-progress",
    "pipe:1",
    "-nostats",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    outputPath,
  ];

  const update = createJobProgressUpdater(job);
  await runFfmpegWithProgress(
    context.ffmpegCommand,
    args,
    () => update(context.totalDurationSec, 0, context.totalDurationSec, "Finalizing MP4"),
    childHolder,
    context.ffmpegEnv,
  );

  await fs.rm(listPath, { force: true }).catch(() => {});
}

function buildGlobalAudioItems(scenes, transitions, context, maxDurationSec) {
  const items = [];
  const bookPagePath = path.join(context.projectRoot, "public", "projects", context.projectName, "resources", "audio", "sfx", "bookpage.wav");
  let currentStartSec = 0;

  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index];
    if (currentStartSec >= maxDurationSec) {
      break;
    }

    const scenePlayableDurationSec = Math.min(scene.durationSec, Math.max(0, maxDurationSec - currentStartSec));
    if (scenePlayableDurationSec <= 0) {
      break;
    }

    const explicitAudioTracks = scene.audioTracks.filter((track) => track.exists);
    if (explicitAudioTracks.length === 0 && scene.backgroundVideoExists) {
      items.push({
        filePath: relativeResourceToFsPath(context.projectRoot, context.projectName, scene.backgroundVideo),
        startSec: currentStartSec,
        durationSec: scenePlayableDurationSec,
        volume: 1,
        loop: true,
      });
    }

    for (const track of explicitAudioTracks) {
      const absoluteStartSec = currentStartSec + track.startSec;
      const playableDurationSec = Math.min(
        Math.max(0, scene.durationSec - track.startSec),
        Math.max(0, maxDurationSec - absoluteStartSec),
      );
      if (playableDurationSec <= 0) {
        continue;
      }

      items.push({
        filePath: track.filePath,
        startSec: absoluteStartSec,
        durationSec: playableDurationSec,
        volume: track.volume,
        loop: Boolean(track.loop),
      });
    }

    if (scene.sceneType === "answer_reveal" && scene.okSfxPath && scene.okSfxExists && scene.markers.length) {
      for (const marker of scene.markers) {
        const absoluteStartSec = currentStartSec + marker.revealAtSec;
        const playableDurationSec = Math.max(0, maxDurationSec - absoluteStartSec);
        if (playableDurationSec <= 0) {
          continue;
        }

        items.push({
          filePath: scene.okSfxPath,
          startSec: absoluteStartSec,
          durationSec: playableDurationSec,
          volume: 1,
          loop: false,
        });
      }
    }

    currentStartSec += scene.durationSec;

    if (transitions.includes(index) && context.bookPageExists && currentStartSec < maxDurationSec) {
      items.push({
        filePath: bookPagePath,
        startSec: currentStartSec,
        durationSec: Math.min(BOOK_TRANSITION_TOTAL_SEC, maxDurationSec - currentStartSec),
        volume: 1,
        loop: false,
      });
      currentStartSec += BOOK_TRANSITION_TOTAL_SEC;
    }
  }

  return items;
}

async function renderGlobalAudio(job, context, scenes, transitions, outputPath, maxDurationSec, childHolder) {
  const audioItems = buildGlobalAudioItems(scenes, transitions, context, maxDurationSec).filter((item) => item.filePath);
  const filterScriptPath = path.join(context.tempRoot, `audio-${randomUUID()}.fcs`);
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-progress",
    "pipe:1",
    "-nostats",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo:d=${Math.max(maxDurationSec, 0.01)}`,
  ];

  for (const item of audioItems) {
    args.push("-stream_loop", item.loop ? "-1" : "0", "-i", item.filePath);
  }

  const filters = [`[0:a]atrim=0:${Math.max(maxDurationSec, 0.01)},asetpts=PTS-STARTPTS[a0]`];
  const labels = ["a0"];

  for (let index = 0; index < audioItems.length; index += 1) {
    const item = audioItems[index];
    const label = `a${index + 1}`;
    const delayMs = Math.max(0, Math.round(item.startSec * 1000));
    filters.push(
      `[${index + 1}:a]atrim=start=0:duration=${Math.max(item.durationSec, 0.01)},volume=${item.volume},adelay=${delayMs}|${delayMs},asetpts=PTS-STARTPTS[${label}]`,
    );
    labels.push(label);
  }

  filters.push(`${labels.map((label) => `[${label}]`).join("")}amix=inputs=${labels.length}:normalize=0:duration=longest[aout]`);
  await fs.writeFile(filterScriptPath, `${filters.join(";\n")}\n`, "utf8");

  args.push(
    "-filter_complex_script",
    filterScriptPath,
    "-map",
    "[aout]",
    "-t",
    String(Math.max(maxDurationSec, 0.01)),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outputPath,
  );

  const update = createJobProgressUpdater(job);
  await runFfmpegWithProgress(
    context.ffmpegCommand,
    args,
    (currentSec) => update(0, currentSec, context.totalDurationSec, "Mixing final audio"),
    childHolder,
    context.ffmpegEnv,
  );

  await fs.rm(filterScriptPath, { force: true }).catch(() => {});
}

async function muxVideoAndAudio(job, context, rawVideoPath, audioPath, outputPath, childHolder) {
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-progress",
    "pipe:1",
    "-nostats",
    "-i",
    rawVideoPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    "-shortest",
    outputPath,
  ];

  const update = createJobProgressUpdater(job);
  await runFfmpegWithProgress(
    context.ffmpegCommand,
    args,
    () => update(context.totalDurationSec, 0, context.totalDurationSec, "Muxing final MP4"),
    childHolder,
    context.ffmpegEnv,
  );
}

export async function startOfflineExportJob(payload, serviceContext) {
  const workbookPath = payload.workbookPath || "/projects/sample/scene-flow.xlsx";
  const indexPath = payload.indexPath || "/projects/sample/project-index.json";
  const projectRoot = serviceContext.projectRoot;
  const workbookFsPath = publicPathToFsPath(projectRoot, workbookPath);
  const indexFsPath = publicPathToFsPath(projectRoot, indexPath);
  const workbook = XLSX.readFile(workbookFsPath);
  const workbookData = parseWorkbookData(workbook);
  const resourceIndex = JSON.parse(await fs.readFile(indexFsPath, "utf8"));
  const projectName = workbookData.project.projectName || resourceIndex.projectName || "sample";
  const projectPublicRoot = path.join(projectRoot, "public", "projects", projectName);
  const tempRoot = path.join(serviceContext.tempRoot, randomUUID());
  const token = `${Date.now()}-${randomUUID()}`;
  const requestedBaseName = payload.fileName ? path.basename(payload.fileName, path.extname(payload.fileName)) : `${projectName}-full`;
  const outputPath = path.join(serviceContext.exportsRoot, `${requestedBaseName}-${token}.mp4`);

  await fs.mkdir(tempRoot, { recursive: true });
  await fs.mkdir(serviceContext.exportsRoot, { recursive: true });
  const fontConfigPath = path.join(tempRoot, "fonts.conf");
  const fontCacheDir = path.join(tempRoot, "font-cache");
  await fs.mkdir(fontCacheDir, { recursive: true });
  await fs.writeFile(
    fontConfigPath,
    [
      "<?xml version=\"1.0\"?>",
      "<!DOCTYPE fontconfig SYSTEM \"fonts.dtd\">",
      "<fontconfig>",
      "  <dir>C:/Windows/Fonts</dir>",
      `  <cachedir>${fontCacheDir.replace(/\\/g, "/")}</cachedir>`,
      "</fontconfig>",
      "",
    ].join("\n"),
    "utf8",
  );

  const ui = resourceIndex.resources?.ui ?? {};
  const beePath = path.join(projectRoot, "public", "projects", projectName, "resources", "images", "ui", "hud", "bee.png");
  const hivePath = path.join(projectRoot, "public", "projects", projectName, "resources", "images", "ui", "hud", "beehouse.png");
  const stepOverlayPath = path.join(projectRoot, "public", "projects", projectName, "resources", "images", "ui", "hud", "step.png");
  const timeoutOverlayPath = path.join(projectRoot, "public", "projects", projectName, "resources", "images", "ui", "hud", "ending.png");
  const okSfxPath = relativeResourceToFsPath(projectRoot, projectName, "resources/audio/sfx/ok.mp3");
  const bookPagePath = relativeResourceToFsPath(projectRoot, projectName, "resources/audio/sfx/bookpage.wav");
  const [beeExists, hiveExists, stepOverlayExists, timeoutOverlayExists, okSfxExists, bookPageExists] = await Promise.all([
    fileExists(beePath),
    fileExists(hivePath),
    fileExists(stepOverlayPath),
    fileExists(timeoutOverlayPath),
    fileExists(okSfxPath),
    fileExists(bookPagePath),
  ]);

  const scenes = [];
  for (const scene of workbookData.scenes) {
    const stepResource = scene.step == null
      ? null
      : resourceIndex.steps.find((entry) => entry.step === scene.step) ?? null;

    const sceneAudio = [];
    for (const track of ensureAutoStepAudio(scene, workbookData.audio, projectName, projectRoot)) {
      const filePath = relativeResourceToFsPath(projectRoot, projectName, track.resourcePath);
      sceneAudio.push({
        ...track,
        filePath,
        exists: await fileExists(filePath),
      });
    }

    const backgroundImagePath = relativeResourceToFsPath(projectRoot, projectName, scene.backgroundImage);
    const backgroundVideoPath = relativeResourceToFsPath(projectRoot, projectName, scene.backgroundVideo);
    const foregroundImagePath = relativeResourceToFsPath(projectRoot, projectName, scene.foregroundImage);
    const hudBarPath = relativeResourceToFsPath(
      projectRoot,
      projectName,
      scene.bannerImage || (ui.hudBar ? ui.hudBar.replace(/^\/projects\/[^/]+\//, "") : "resources/images/ui/hud/hud-bar.png"),
    );

    const markers = [];
    for (const marker of workbookData.markers.filter((entry) => entry.sceneId === scene.sceneId)) {
      const markerFilePath = relativeResourceToFsPath(
        projectRoot,
        projectName,
        marker.texturePath || "resources/images/ui/markers/answer-marker.png",
      );
      markers.push({
        ...marker,
        filePath: markerFilePath,
        exists: await fileExists(markerFilePath),
      });
    }

    let stepImages = null;
    if (stepResource) {
      const leftFilePath = publicPathToFsPath(projectRoot, stepResource.leftImage);
      const rightFilePath = publicPathToFsPath(projectRoot, stepResource.rightImage);
      stepImages = {
        leftFilePath,
        rightFilePath,
        leftExists: await fileExists(leftFilePath),
        rightExists: await fileExists(rightFilePath),
      };
    }

    scenes.push({
      ...scene,
      detectedStepCount: resourceIndex.stepCount,
      backgroundImageExists: await fileExists(backgroundImagePath),
      backgroundVideoExists: await fileExists(backgroundVideoPath),
      foregroundImageExists: await fileExists(foregroundImagePath),
      hudBarExists: await fileExists(hudBarPath),
      beeExists,
      hiveExists,
      stepOverlayExists,
      timeoutOverlayExists,
      bannerImage: scene.bannerImage || (ui.hudBar ? ui.hudBar.replace(/^\/projects\/[^/]+\//, "") : "resources/images/ui/hud/hud-bar.png"),
      stepImages,
      audioTracks: sceneAudio,
      markers,
      okSfxPath,
      okSfxExists,
    });
  }

  const transitions = [];
  let totalDurationSec = 0;
  for (let index = 0; index < scenes.length; index += 1) {
    totalDurationSec += scenes[index].durationSec;
    if (shouldUseBookTransition(scenes[index], scenes[index + 1] ?? null)) {
      transitions.push(index);
      totalDurationSec += BOOK_TRANSITION_TOTAL_SEC;
    }
  }

  const job = {
    id: randomUUID(),
    status: "queued",
    message: "Queued for ffmpeg offline export.",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    outputPath: null,
    fileName: path.basename(outputPath),
    error: null,
    cancelRequested: false,
    progress: 0,
    elapsedSec: 0,
    etaSec: null,
    currentChild: { current: null },
    tempRoot,
  };

  const context = {
    projectRoot,
    projectName,
    width: workbookData.project.width,
    height: workbookData.project.height,
    fps: workbookData.project.fps,
    ffmpegCommand: serviceContext.ffmpegCommand,
    ffmpegEnv: {
      FONTCONFIG_FILE: fontConfigPath,
      FONTCONFIG_PATH: tempRoot,
    },
    exportsRoot: serviceContext.exportsRoot,
    tempRoot,
    totalDurationSec,
    bookPageExists,
  };

  void (async () => {
    const segmentPaths = [];
    const renderedSceneSegments = new Map();
    let completedSec = 0;
    let renderedTimelineSec = 0;

    try {
      job.status = "running";
      job.startedAt = new Date().toISOString();

      for (let index = 0; index < scenes.length; index += 1) {
        if (job.cancelRequested) {
          break;
        }

        const scene = scenes[index];
        let sceneChunkPaths = renderedSceneSegments.get(scene.sceneId);
        if (!sceneChunkPaths) {
          sceneChunkPaths = [];
          for (let chunkStartSec = 0; chunkStartSec < scene.durationSec; chunkStartSec += VIDEO_GROUP_SEC) {
            if (job.cancelRequested) {
              break;
            }

            const segmentDurationSec = Math.min(VIDEO_GROUP_SEC, scene.durationSec - chunkStartSec);
            const segmentPath = path.join(
              tempRoot,
              `${String(index).padStart(3, "0")}-${scene.sceneId}-${String(chunkStartSec).padStart(4, "0")}.mp4`,
            );
            try {
              await renderSceneSegment(
                job,
                context,
                scene,
                segmentPath,
                chunkStartSec,
                segmentDurationSec,
                completedSec + chunkStartSec,
                totalDurationSec,
                job.currentChild,
              );
            } catch (error) {
              if (job.cancelRequested) {
                break;
              }
              throw error;
            }
            sceneChunkPaths.push(segmentPath);
          }
          renderedSceneSegments.set(scene.sceneId, sceneChunkPaths);
        }
        const renderedSceneDurationSec = sceneChunkPaths.length
          ? sceneChunkPaths.reduce((sum, _, chunkIndex) => {
              const chunkStartSec = chunkIndex * VIDEO_GROUP_SEC;
              return sum + Math.min(VIDEO_GROUP_SEC, Math.max(0, scene.durationSec - chunkStartSec));
            }, 0)
          : 0;
        segmentPaths.push(...sceneChunkPaths);
        renderedTimelineSec += renderedSceneDurationSec;
        completedSec += renderedSceneDurationSec;

        if (!job.cancelRequested && transitions.includes(index) && scenes[index + 1]) {
          const nextScene = scenes[index + 1];
          let nextSceneChunkPaths = renderedSceneSegments.get(nextScene.sceneId);
          if (!nextSceneChunkPaths) {
            nextSceneChunkPaths = [];
            for (let chunkStartSec = 0; chunkStartSec < nextScene.durationSec; chunkStartSec += VIDEO_GROUP_SEC) {
              if (job.cancelRequested) {
                break;
              }
              const segmentDurationSec = Math.min(VIDEO_GROUP_SEC, nextScene.durationSec - chunkStartSec);
              const segmentPath = path.join(
                tempRoot,
                `${String(index + 1).padStart(3, "0")}-${nextScene.sceneId}-${String(chunkStartSec).padStart(4, "0")}.mp4`,
              );
              try {
                await renderSceneSegment(
                  job,
                  context,
                  nextScene,
                  segmentPath,
                  chunkStartSec,
                  segmentDurationSec,
                  completedSec + chunkStartSec,
                  totalDurationSec,
                  job.currentChild,
                );
              } catch (error) {
                if (job.cancelRequested) {
                  break;
                }
                throw error;
              }
              nextSceneChunkPaths.push(segmentPath);
            }
            renderedSceneSegments.set(nextScene.sceneId, nextSceneChunkPaths);
          }
          const fromSegmentPath = sceneChunkPaths.at(-1);
          const nextSegmentPath = nextSceneChunkPaths[0];
          if (fromSegmentPath && nextSegmentPath) {
            const transitionPath = path.join(tempRoot, `${String(index).padStart(3, "0")}-transition.mp4`);
            try {
              await renderTransitionSegment(job, context, fromSegmentPath, nextSegmentPath, transitionPath, completedSec, totalDurationSec, job.currentChild);
            } catch (error) {
              if (!job.cancelRequested) {
                throw error;
              }
            }
            if (await fileExists(transitionPath)) {
              segmentPaths.push(transitionPath);
              renderedTimelineSec += BOOK_TRANSITION_TOTAL_SEC;
            }
            completedSec += BOOK_TRANSITION_TOTAL_SEC;
          }
        }
      }

      if (segmentPaths.length === 0) {
        throw new Error("No segments were rendered.");
      }

      const rawVideoPath = path.join(tempRoot, `${requestedBaseName}-${token}.raw.mp4`);
      await concatSegments(job, context, segmentPaths, rawVideoPath, job.currentChild);

      const finalOutputPath = job.cancelRequested
        ? outputPath.replace(/\.mp4$/u, "-partial.mp4")
        : outputPath;
      const audioOutputPath = path.join(tempRoot, `${requestedBaseName}-${token}.audio.m4a`);
      const audioDurationSec = job.cancelRequested ? renderedTimelineSec : totalDurationSec;
      await renderGlobalAudio(job, context, scenes, transitions, audioOutputPath, audioDurationSec, job.currentChild);
      await muxVideoAndAudio(job, context, rawVideoPath, audioOutputPath, finalOutputPath, job.currentChild);
      job.outputPath = finalOutputPath;
      job.status = job.cancelRequested ? "cancelled" : "completed";
      job.progress = 1;
      job.message = job.cancelRequested ? `Partial MP4 saved: ${finalOutputPath}` : `MP4 saved: ${finalOutputPath}`;
    } catch (error) {
      job.status = job.cancelRequested ? "cancelled" : "failed";
      job.error = error instanceof Error ? error.message : "Offline ffmpeg export failed.";
      job.message = job.error;
    } finally {
      job.finishedAt = new Date().toISOString();
      job.currentChild.current = null;
    }
  })();

  return job;
}

export async function cancelOfflineExportJob(job) {
  job.cancelRequested = true;
  if (job.currentChild.current && !job.currentChild.current.killed) {
    job.currentChild.current.kill("SIGTERM");
  }
}
