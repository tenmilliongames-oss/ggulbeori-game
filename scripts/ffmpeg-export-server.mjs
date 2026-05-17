import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cancelHeadlessExportJob, startHeadlessExportJob } from "./headless-export-job.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const exportsRoot = path.join(projectRoot, "output", "exports");
const tempRoot = path.join(exportsRoot, ".tmp");
const uploadedAudioFiles = new Map();
const host = process.env.FFMPEG_EXPORT_HOST ?? "127.0.0.1";
const port = toPort(process.env.FFMPEG_EXPORT_PORT, 43123);
const maxBodyBytes = toPositiveInt(process.env.FFMPEG_EXPORT_MAX_BODY_BYTES, 2 * 1024 * 1024 * 1024);
const ffmpegCommand = (process.env.FFMPEG_BIN ?? "ffmpeg").trim() || "ffmpeg";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Content-Length,X-File-Name",
  "Access-Control-Max-Age": "86400",
};

const exportJobs = new Map();
let ffmpegProbeCache = null;

function toPort(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
    return parsed;
  }

  return fallback;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
}

function getContentType(request) {
  return (request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
}

function sanitizeBaseName(input) {
  const normalized = path.basename(input ?? "", path.extname(input ?? ""));
  const safe = normalized.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "export";
}

function buildMp4OutputPath(outputStem, token) {
  if (/(^|[-_.])end$/iu.test(outputStem)) {
    const stemWithoutEnd = outputStem.replace(/[-_.]?end$/iu, "").replace(/[-_.]+$/u, "") || "export";
    return path.join(exportsRoot, `${stemWithoutEnd}-${token}-end.mp4`);
  }

  return path.join(exportsRoot, `${outputStem}-${token}.mp4`);
}

function isPathInside(parentPath, childPath) {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relativePath === "" || (!!relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function escapeConcatPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    ...corsHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    ...corsHeaders,
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${message}\n`);
}

function readRequestBody(request, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    function finish(error, value) {
      if (settled) {
        return;
      }

      settled = true;
      if (error) {
        reject(error);
        return;
      }

      resolve(value);
    }

    request.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > limitBytes) {
        const error = new Error(`Request body exceeds ${limitBytes} bytes.`);
        error.statusCode = 413;
        request.pause();
        request.removeAllListeners("data");
        request.resume();
        finish(error);
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => finish(null, Buffer.concat(chunks)));
    request.on("error", (error) => finish(error));
    request.on("close", () => {
      if (!settled && !request.complete) {
        const error = new Error("Request terminated before the body was fully received.");
        error.statusCode = 499;
        finish(error);
      }
    });
  });
}

async function readJsonBody(request) {
  const body = await readRequestBody(request, maxBodyBytes);
  if (!body.length) {
    return {};
  }

  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON body.");
    error.statusCode = 400;
    throw error;
  }
}

function streamRequestToFile(request, filePath, limitBytes) {
  return new Promise((resolve, reject) => {
    const writeStream = fsSync.createWriteStream(filePath);
    let totalBytes = 0;
    let settled = false;

    function finish(error) {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        writeStream.destroy();
        reject(error);
        return;
      }
      resolve(totalBytes);
    }

    request.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > limitBytes) {
        const error = new Error(`Request body exceeds ${limitBytes} bytes.`);
        error.statusCode = 413;
        request.destroy(error);
        finish(error);
        return;
      }
    });

    request.on("error", (error) => finish(error));
    request.on("close", () => {
      if (!settled && !request.complete) {
        const error = new Error("Request terminated before the body was fully received.");
        error.statusCode = 499;
        finish(error);
      }
    });

    writeStream.on("error", (error) => finish(error));
    writeStream.on("finish", () => finish(null));

    request.pipe(writeStream);
  });
}

function runProcess(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr,
        error,
      });
    });

    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        error: null,
      });
    });
  });
}

async function resolveCommandPath(command) {
  if (path.isAbsolute(command)) {
    return command;
  }

  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const lookup = await runProcess(lookupCommand, [command]);
  if (!lookup.ok) {
    return command;
  }

  const firstLine = lookup.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return firstLine || command;
}

async function probeFfmpeg(forceRefresh = false) {
  if (!forceRefresh && ffmpegProbeCache) {
    return ffmpegProbeCache;
  }

  const version = await runProcess(ffmpegCommand, ["-version"]);
  const resolvedPath = await resolveCommandPath(ffmpegCommand);
  const versionLine = version.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";

  const details = {
    available: version.ok,
    command: ffmpegCommand,
    resolvedPath,
    version: versionLine,
    error: version.error ? version.error.message : null,
    stderr: version.stderr.trim() || null,
  };

  if (!version.ok && !details.error) {
    details.error = version.code === null
      ? `Unable to start ffmpeg using "${ffmpegCommand}".`
      : `ffmpeg exited with code ${version.code}.`;
  }

  ffmpegProbeCache = details;
  return details;
}

async function parseTranscodeRequest(request, bodyBuffer, requestUrl) {
  const contentType = getContentType(request);
  const filenameFromQuery = requestUrl.searchParams.get("filename") || requestUrl.searchParams.get("fileName") || "";
  const headerFileName = request.headers["x-file-name"];

  if (contentType === "application/json") {
    let payload;

    try {
      payload = JSON.parse(bodyBuffer.toString("utf8"));
    } catch {
      const error = new Error("Invalid JSON body.");
      error.statusCode = 400;
      throw error;
    }

    if (typeof payload?.webmBase64 !== "string" || payload.webmBase64.trim() === "") {
      const error = new Error("JSON body must include a non-empty \"webmBase64\" string.");
      error.statusCode = 400;
      throw error;
    }

    const inputBuffer = Buffer.from(payload.webmBase64, "base64");
    if (inputBuffer.length === 0) {
      const error = new Error("\"webmBase64\" did not decode to any bytes.");
      error.statusCode = 400;
      throw error;
    }

    let audioBuffer = null;
    if (typeof payload?.audioBase64 === "string" && payload.audioBase64.trim() !== "") {
      audioBuffer = Buffer.from(payload.audioBase64, "base64");
      if (audioBuffer.length === 0) {
        const error = new Error("\"audioBase64\" did not decode to any bytes.");
        error.statusCode = 400;
        throw error;
      }
    }

    return {
      inputBuffer,
      sourceFileName: payload.fileName || filenameFromQuery || headerFileName || "upload.webm",
      outputFileName: payload.outputFileName || requestUrl.searchParams.get("outputFileName") || "",
      audioBuffer,
      audioFileName: payload.audioFileName || "mixed-audio.wav",
    };
  }

  if (bodyBuffer.length === 0) {
    const error = new Error("Request body is empty.");
    error.statusCode = 400;
    throw error;
  }

  return {
    inputBuffer: bodyBuffer,
    sourceFileName: filenameFromQuery || headerFileName || "upload.webm",
    outputFileName: requestUrl.searchParams.get("outputFileName") || "",
    audioBuffer: null,
    audioFileName: "mixed-audio.wav",
  };
}

async function transcodeWebmToMp4(inputPath, outputPath, fps, audioPath = null) {
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
  ];

  if (audioPath) {
    args.push(
      "-i",
      audioPath,
    );
  }

  if (Number.isFinite(fps) && fps > 0) {
    args.push(
      "-vf",
      `fps=${fps}`,
    );
  }

  args.push(
    ...(audioPath ? [
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-af",
      "aresample=async=1:first_pts=0",
    ] : [
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
    ]),
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-c:a",
    "aac",
    "-b:a",
    "256k",
    ...(audioPath ? ["-shortest"] : []),
    outputPath,
  );

  return runProcess(ffmpegCommand, args);
}

async function concatMp4Segments(segmentPaths, outputPath, audioPath = null, cleanupSegments = true) {
  const token = `${Date.now()}-${randomUUID()}`;
  const listPath = path.join(tempRoot, `concat-${token}.txt`);
  const listContent = segmentPaths.map((segmentPath) => `file '${escapeConcatPath(segmentPath)}'`).join("\n");
  await fs.writeFile(listPath, `${listContent}\n`, "utf8");

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
  ];

  if (audioPath) {
    args.push(
      "-i",
      audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "256k",
      "-af",
      "aresample=async=1:first_pts=0",
      "-shortest",
      "-movflags",
      "+faststart",
      outputPath,
    );
  } else {
    args.push(
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    );
  }

  const result = await runProcess(ffmpegCommand, args);
  await fs.rm(listPath, { force: true }).catch(() => {});

  if (result.ok && cleanupSegments) {
    await Promise.all(segmentPaths.map((segmentPath) => fs.rm(segmentPath, { force: true }).catch(() => {})));
  }

  return result;
}

async function handleAudioTempUpload(request, response) {
  let tempAudioPath = "";

  try {
    const audioBuffer = await readRequestBody(request, maxBodyBytes);
    if (audioBuffer.length === 0) {
      const error = new Error("Uploaded audio body is empty.");
      error.statusCode = 400;
      throw error;
    }

    await fs.mkdir(tempRoot, { recursive: true });
    const headerFileName = request.headers["x-file-name"];
    const audioStem = sanitizeBaseName(
      typeof headerFileName === "string" && headerFileName.trim()
        ? headerFileName
        : "mixed-audio.wav",
    );
    const token = randomUUID();
    tempAudioPath = path.join(tempRoot, `${audioStem}-${token}.wav`);
    await fs.writeFile(tempAudioPath, audioBuffer);
    uploadedAudioFiles.set(token, tempAudioPath);

    sendJson(response, 202, {
      ok: true,
      audioToken: token,
    });
  } catch (error) {
    if (tempAudioPath) {
      await fs.rm(tempAudioPath, { force: true }).catch(() => {});
    }

    sendJson(response, error.statusCode || 500, {
      ok: false,
      error: error.message || "Unexpected audio upload error.",
    });
  }
}

function summarizeJob(job) {
  return {
    id: job.id,
    status: job.status,
    message: job.message,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    outputPath: job.outputPath,
    fileName: job.fileName,
    error: job.error,
    cancelRequested: job.cancelRequested,
    progress: job.progress ?? 0,
    elapsedSec: job.elapsedSec ?? 0,
    etaSec: job.etaSec ?? null,
    appBaseUrl: job.appBaseUrl ?? null,
    runnerUrl: job.runnerUrl ?? null,
  };
}

async function handleHealth(response) {
  const ffmpeg = await probeFfmpeg();
  sendJson(response, 200, {
    ok: true,
    service: "ffmpeg-export-server",
    ffmpeg,
    exportsRoot,
    tempRoot,
    jobs: Array.from(exportJobs.values()).map((job) => summarizeJob(job)),
    now: new Date().toISOString(),
  });
}

async function handleTranscode(request, response, requestUrl) {
  const ffmpeg = await probeFfmpeg();
  if (!ffmpeg.available) {
    sendJson(response, 503, {
      ok: false,
      error: "ffmpeg is not available.",
      message: ffmpeg.error || "Install ffmpeg or set FFMPEG_BIN to a valid executable.",
      ffmpeg,
    });
    return;
  }

  let tempInputPath = "";
  let tempAudioPath = "";
  let outputPath = "";
  const startedAt = Date.now();

  try {
    const contentType = getContentType(request);
    const filenameFromQuery = requestUrl.searchParams.get("filename") || requestUrl.searchParams.get("fileName") || "";
    const headerFileName = request.headers["x-file-name"];
    let sourceFileName = filenameFromQuery || headerFileName || "upload.webm";
    let outputFileName = requestUrl.searchParams.get("outputFileName") || "";
    let audioBuffer = null;
    let audioFileName = "mixed-audio.wav";
    const audioToken = requestUrl.searchParams.get("audioToken") ?? "";
    const requestedFps = Number.parseFloat(requestUrl.searchParams.get("fps") ?? "");
    const targetFps = Number.isFinite(requestedFps) && requestedFps > 0 ? requestedFps : null;

    await fs.mkdir(tempRoot, { recursive: true });
    await fs.mkdir(exportsRoot, { recursive: true });

    const sourceStem = sanitizeBaseName(sourceFileName);
    const outputStem = sanitizeBaseName(outputFileName || sourceStem);
    const token = `${Date.now()}-${randomUUID()}`;

    tempInputPath = path.join(tempRoot, `${sourceStem}-${token}.webm`);
    outputPath = buildMp4OutputPath(outputStem, token);

    if (contentType === "application/json") {
      const requestBody = await readRequestBody(request, maxBodyBytes);
      const parsed = await parseTranscodeRequest(request, requestBody, requestUrl);
      sourceFileName = parsed.sourceFileName;
      outputFileName = parsed.outputFileName;
      audioBuffer = parsed.audioBuffer;
      audioFileName = parsed.audioFileName;

      const parsedSourceStem = sanitizeBaseName(sourceFileName);
      const parsedOutputStem = sanitizeBaseName(outputFileName || sourceFileName);
      tempInputPath = path.join(tempRoot, `${parsedSourceStem}-${token}.webm`);
      outputPath = buildMp4OutputPath(parsedOutputStem, token);
      await fs.writeFile(tempInputPath, parsed.inputBuffer);
    } else {
      await streamRequestToFile(request, tempInputPath, maxBodyBytes);
    }

    if (audioToken) {
      const uploadedAudioPath = uploadedAudioFiles.get(audioToken);
      if (!uploadedAudioPath) {
        const error = new Error(`Uploaded audio token not found: ${audioToken}`);
        error.statusCode = 400;
        throw error;
      }
      tempAudioPath = uploadedAudioPath;
      uploadedAudioFiles.delete(audioToken);
    } else if (audioBuffer) {
      const audioStem = sanitizeBaseName(audioFileName || "mixed-audio.wav");
      tempAudioPath = path.join(tempRoot, `${audioStem}-${token}.wav`);
      await fs.writeFile(tempAudioPath, audioBuffer);
    }

    const ffmpegRun = await transcodeWebmToMp4(
      tempInputPath,
      outputPath,
      targetFps,
      tempAudioPath || null,
    );
    if (!ffmpegRun.ok) {
      await fs.rm(outputPath, { force: true });
      sendJson(response, 500, {
        ok: false,
        error: "ffmpeg transcode failed.",
        message: ffmpegRun.error?.message || `ffmpeg exited with code ${ffmpegRun.code}.`,
        ffmpeg: {
          ...ffmpeg,
          stderr: ffmpegRun.stderr.trim() || ffmpeg.stderr,
        },
      });
      return;
    }

    const outputStat = await fs.stat(outputPath);
    sendJson(response, 200, {
      ok: true,
      outputPath,
      outputFileName: path.basename(outputPath),
      bytes: outputStat.size,
      durationMs: Date.now() - startedAt,
      ffmpeg: {
        command: ffmpeg.command,
        resolvedPath: ffmpeg.resolvedPath,
        version: ffmpeg.version,
      },
    });
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      ok: false,
      error: error.message || "Unexpected server error.",
    });
  } finally {
    if (tempInputPath) {
      await fs.rm(tempInputPath, { force: true }).catch(() => {});
    }
    if (tempAudioPath) {
      await fs.rm(tempAudioPath, { force: true }).catch(() => {});
    }
  }
}

async function handleConcat(request, response) {
  const ffmpeg = await probeFfmpeg();
  if (!ffmpeg.available) {
    sendJson(response, 503, {
      ok: false,
      error: "ffmpeg is not available.",
      message: ffmpeg.error || "Install ffmpeg or set FFMPEG_BIN to a valid executable.",
      ffmpeg,
    });
    return;
  }

  let tempAudioPath = "";
  let outputPath = "";
  const startedAt = Date.now();

  try {
    const payload = await readJsonBody(request);
    if (!Array.isArray(payload.segmentPaths) || payload.segmentPaths.length === 0) {
      const error = new Error("JSON body must include a non-empty segmentPaths array.");
      error.statusCode = 400;
      throw error;
    }

    const segmentPaths = payload.segmentPaths.map((segmentPath) => {
      if (typeof segmentPath !== "string" || !segmentPath.trim()) {
        const error = new Error("segmentPaths must contain only non-empty strings.");
        error.statusCode = 400;
        throw error;
      }

      const resolvedPath = path.resolve(segmentPath);
      if (!isPathInside(exportsRoot, resolvedPath)) {
        const error = new Error(`Segment path is outside the exports directory: ${segmentPath}`);
        error.statusCode = 400;
        throw error;
      }

      if (!fsSync.existsSync(resolvedPath)) {
        const error = new Error(`Segment file does not exist: ${segmentPath}`);
        error.statusCode = 400;
        throw error;
      }

      return resolvedPath;
    });

    const audioToken = typeof payload.audioToken === "string" ? payload.audioToken : "";
    if (audioToken) {
      const uploadedAudioPath = uploadedAudioFiles.get(audioToken);
      if (!uploadedAudioPath) {
        const error = new Error(`Uploaded audio token not found: ${audioToken}`);
        error.statusCode = 400;
        throw error;
      }
      tempAudioPath = uploadedAudioPath;
      uploadedAudioFiles.delete(audioToken);
    }

    await fs.mkdir(exportsRoot, { recursive: true });
    await fs.mkdir(tempRoot, { recursive: true });

    const outputStem = sanitizeBaseName(payload.outputFileName || "segmented-export.mp4");
    const token = `${Date.now()}-${randomUUID()}`;
    outputPath = buildMp4OutputPath(outputStem, token);
    const cleanupSegments = payload.cleanupSegments !== false;
    const ffmpegRun = await concatMp4Segments(segmentPaths, outputPath, tempAudioPath || null, cleanupSegments);

    if (!ffmpegRun.ok) {
      await fs.rm(outputPath, { force: true }).catch(() => {});
      sendJson(response, 500, {
        ok: false,
        error: "ffmpeg concat failed.",
        message: ffmpegRun.error?.message || `ffmpeg exited with code ${ffmpegRun.code}.`,
        ffmpeg: {
          ...ffmpeg,
          stderr: ffmpegRun.stderr.trim() || ffmpeg.stderr,
        },
      });
      return;
    }

    const outputStat = await fs.stat(outputPath);
    sendJson(response, 200, {
      ok: true,
      outputPath,
      outputFileName: path.basename(outputPath),
      bytes: outputStat.size,
      segmentCount: segmentPaths.length,
      durationMs: Date.now() - startedAt,
      ffmpeg: {
        command: ffmpeg.command,
        resolvedPath: ffmpeg.resolvedPath,
        version: ffmpeg.version,
      },
    });
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      ok: false,
      error: error.message || "Unexpected server error.",
    });
  } finally {
    if (tempAudioPath) {
      await fs.rm(tempAudioPath, { force: true }).catch(() => {});
    }
  }
}

async function handleOfflineExportCreate(request, response) {
  const ffmpeg = await probeFfmpeg();
  if (!ffmpeg.available) {
    sendJson(response, 503, {
      ok: false,
      error: "ffmpeg is not available.",
      message: ffmpeg.error || "Install ffmpeg or set FFMPEG_BIN to a valid executable.",
      ffmpeg,
    });
    return;
  }

  const payload = await readJsonBody(request);
  const job = await startHeadlessExportJob(payload, {
    appBaseUrl: payload.appBaseUrl || request.headers.origin || "",
    serviceBaseUrl: `http://${host}:${port}`,
  });
  exportJobs.set(job.id, job);
  sendJson(response, 202, {
    ok: true,
    job: summarizeJob(job),
  });
}

async function handleOfflineExportGet(response, jobId) {
  const job = exportJobs.get(jobId);
  if (!job) {
    sendJson(response, 404, {
      ok: false,
      error: `Job not found: ${jobId}`,
    });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    job: summarizeJob(job),
  });
}

async function handleOfflineExportCancel(response, jobId) {
  const job = exportJobs.get(jobId);
  if (!job) {
    sendJson(response, 404, {
      ok: false,
      error: `Job not found: ${jobId}`,
    });
    return;
  }

  await cancelHeadlessExportJob(job);
  sendJson(response, 202, {
    ok: true,
    job: summarizeJob(job),
  });
}

async function handleOpenOutputFolder(request, response) {
  try {
    const payload = await readJsonBody(request);
    if (typeof payload.outputPath !== "string" || !payload.outputPath.trim()) {
      sendJson(response, 400, {
        ok: false,
        error: "JSON body must include a non-empty outputPath string.",
      });
      return;
    }

    const requestedPath = path.resolve(payload.outputPath);
    if (!isPathInside(exportsRoot, requestedPath)) {
      sendJson(response, 400, {
        ok: false,
        error: "Output path must be inside the exports directory.",
      });
      return;
    }

    const outputStat = await fs.stat(requestedPath).catch(() => null);
    if (!outputStat) {
      sendJson(response, 404, {
        ok: false,
        error: `Output path does not exist: ${payload.outputPath}`,
      });
      return;
    }

    const folderPath = outputStat.isDirectory() ? requestedPath : path.dirname(requestedPath);
    if (process.platform === "win32") {
      const args = outputStat.isDirectory() ? [folderPath] : [`/select,${requestedPath}`];
      const explorer = spawn("explorer.exe", args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      explorer.on("error", () => {});
      explorer.unref();
    } else {
      const command = process.platform === "darwin" ? "open" : "xdg-open";
      const opener = spawn(command, [folderPath], {
        detached: true,
        stdio: "ignore",
      });
      opener.on("error", () => {});
      opener.unref();
    }

    sendJson(response, 200, {
      ok: true,
      openedPath: requestedPath,
      folderPath,
    });
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      ok: false,
      error: error.message || "Unexpected folder open error.",
    });
  }
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    sendJson(response, 400, {
      ok: false,
      error: "Missing request URL.",
    });
    return;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders);
    response.end();
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    await handleHealth(response);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/") {
    sendJson(response, 200, {
      ok: true,
      service: "ffmpeg-export-server",
      endpoints: {
        health: "GET /health",
        transcode: "POST /transcode?filename=input.webm&outputFileName=output-name",
        concat: "POST /concat",
        exportJobCreate: "POST /jobs/offline-export",
        exportJobGet: "GET /jobs/{jobId}",
        exportJobCancel: "POST /jobs/{jobId}/cancel",
        openOutputFolder: "POST /open-output-folder",
      },
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/transcode") {
    await handleTranscode(request, response, requestUrl);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/concat") {
    await handleConcat(request, response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/uploads/audio-temp") {
    await handleAudioTempUpload(request, response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/jobs/offline-export") {
    await handleOfflineExportCreate(request, response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/open-output-folder") {
    await handleOpenOutputFolder(request, response);
    return;
  }

  const jobMatch = requestUrl.pathname.match(/^\/jobs\/([^/]+)(?:\/cancel)?$/u);
  if (jobMatch) {
    const [, jobId] = jobMatch;

    if (request.method === "GET" && requestUrl.pathname === `/jobs/${jobId}`) {
      await handleOfflineExportGet(response, jobId);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === `/jobs/${jobId}/cancel`) {
      await handleOfflineExportCancel(response, jobId);
      return;
    }
  }

  sendText(response, 404, "Not found.");
});

server.listen(port, host, async () => {
  const ffmpeg = await probeFfmpeg();
  console.log(`ffmpeg export server listening on http://${host}:${port}`);
  console.log(`exports directory: ${exportsRoot}`);
  if (ffmpeg.available) {
    console.log(`ffmpeg ready: ${ffmpeg.resolvedPath}`);
  } else {
    console.warn(`ffmpeg unavailable: ${ffmpeg.error}`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close(() => {
      process.exit(0);
    });

    await Promise.all(Array.from(exportJobs.values()).map((job) => cancelHeadlessExportJob(job)));
    await Promise.all(Array.from(uploadedAudioFiles.values()).map((audioPath) => fs.rm(audioPath, { force: true }).catch(() => {})));
  });
}
