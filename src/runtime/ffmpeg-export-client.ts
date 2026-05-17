import type {
  FfmpegExportServiceConfig,
  FfmpegMp4ExportOptions,
  FfmpegSegmentConcatOptions,
  FfmpegServiceHealthCheckResult,
  OfflineAudioRenderResult,
  OfflineMp4ExportResult,
  OfflineWebmRenderResult,
} from "./export-shared";

const DEFAULT_SERVICE_ORIGIN = "http://127.0.0.1:43123";
const DEFAULT_HEALTH_PATH = "/health";
const DEFAULT_TRANSCODE_PATH = "/transcode";
const DEFAULT_CONCAT_PATH = "/concat";
const DEFAULT_UPLOAD_AUDIO_PATH = "/uploads/audio-temp";
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

type EnvLookup = {
  VITE_FFMPEG_EXPORT_BASE_URL?: string;
  VITE_FFMPEG_EXPORT_HEALTH_PATH?: string;
  VITE_FFMPEG_EXPORT_TRANSCODE_PATH?: string;
  VITE_FFMPEG_EXPORT_CONCAT_PATH?: string;
};

function getImportMetaEnv(): EnvLookup {
  const meta = import.meta as ImportMeta & { env?: EnvLookup };
  return meta.env ?? {};
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function ensureLeadingSlash(value: string): string {
  if (!value) {
    return "/";
  }

  return value.startsWith("/") ? value : `/${value}`;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlashes(baseUrl)}${ensureLeadingSlash(path)}`;
}

function resolveBaseUrl(baseUrlOverride?: string): string {
  const env = getImportMetaEnv();
  const configuredBaseUrl = baseUrlOverride ?? env.VITE_FFMPEG_EXPORT_BASE_URL;
  if (configuredBaseUrl) {
    return trimTrailingSlashes(configuredBaseUrl);
  }

  return DEFAULT_SERVICE_ORIGIN;
}

function resolveHealthUrl(config: FfmpegExportServiceConfig): string {
  const env = getImportMetaEnv();
  return joinUrl(
    resolveBaseUrl(config.baseUrl),
    config.healthPath ?? env.VITE_FFMPEG_EXPORT_HEALTH_PATH ?? DEFAULT_HEALTH_PATH,
  );
}

function resolveTranscodeUrl(config: FfmpegExportServiceConfig): string {
  const env = getImportMetaEnv();
  return joinUrl(
    resolveBaseUrl(config.baseUrl),
    config.transcodePath ?? env.VITE_FFMPEG_EXPORT_TRANSCODE_PATH ?? DEFAULT_TRANSCODE_PATH,
  );
}

function resolveConcatUrl(config: FfmpegSegmentConcatOptions): string {
  const env = getImportMetaEnv();
  return joinUrl(
    resolveBaseUrl(config.baseUrl),
    config.concatPath ?? env.VITE_FFMPEG_EXPORT_CONCAT_PATH ?? DEFAULT_CONCAT_PATH,
  );
}

function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeoutHandle = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  return run(controller.signal).finally(() => globalThis.clearTimeout(timeoutHandle));
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  return payload as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
}

function basenameFromPath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1) ?? pathValue;
}

function looksLikeFilePath(pathValue: string): boolean {
  return /\.[^./\\]+$/u.test(basenameFromPath(pathValue));
}

function replaceFileExtension(fileName: string, extension: string): string {
  const sanitizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const baseName = fileName.replace(/\.[^.]+$/u, "");
  return `${baseName}${sanitizedExtension}`;
}

function deriveRequestedFileName(webm: OfflineWebmRenderResult, options: FfmpegMp4ExportOptions): string {
  if (options.fileName) {
    return options.fileName;
  }

  if (options.outputPath && looksLikeFilePath(options.outputPath)) {
    return basenameFromPath(options.outputPath);
  }

  return replaceFileExtension(webm.fileName, ".mp4");
}

function joinPathish(dirPath: string, fileName: string): string {
  if (dirPath.endsWith("\\") || dirPath.endsWith("/")) {
    return `${dirPath}${fileName}`;
  }

  return `${dirPath}/${fileName}`;
}

function normalizeOutputPath(
  payload: unknown,
  requestedOutputPath: string | undefined,
  fileName: string,
): string {
  if (requestedOutputPath) {
    return looksLikeFilePath(requestedOutputPath) ? requestedOutputPath : joinPathish(requestedOutputPath, fileName);
  }

  const record = asRecord(payload);
  if (!record) {
    if (typeof payload === "string" && payload.trim()) {
      return payload;
    }

    return fileName;
  }

  const directOutputPath = readString(record, ["outputPath", "path", "filePath", "outputFile"]);
  if (directOutputPath) {
    return directOutputPath;
  }

  const outputDir = readString(record, ["outputDir", "directory", "dir"]);
  if (outputDir) {
    return joinPathish(outputDir, fileName);
  }

  return fileName;
}

function normalizeFileName(
  payload: unknown,
  requestedFileName: string,
  fallbackOutputPath: string | undefined,
): string {
  const record = asRecord(payload);
  if (!record) {
    if (fallbackOutputPath && looksLikeFilePath(fallbackOutputPath)) {
      return basenameFromPath(fallbackOutputPath);
    }

    return requestedFileName;
  }

  return (
    readString(record, ["fileName", "filename", "name"]) ??
    (fallbackOutputPath && looksLikeFilePath(fallbackOutputPath) ? basenameFromPath(fallbackOutputPath) : null) ??
    requestedFileName
  );
}

function normalizeDownloadUrl(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  return readString(record, ["downloadUrl", "url"]);
}

function normalizeJobId(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  return readString(record, ["jobId", "id"]);
}

function createTranscodeUrl(
  baseUrl: string,
  path: string,
  sourceFileName: string,
  outputFileName: string,
  fps?: number,
): string {
  const url = new URL(joinUrl(baseUrl, path));
  url.searchParams.set("filename", sourceFileName);
  url.searchParams.set("outputFileName", outputFileName);
  if (typeof fps === "number" && Number.isFinite(fps) && fps > 0) {
    url.searchParams.set("fps", String(fps));
  }
  return url.toString();
}

function resolveUploadAudioUrl(config: FfmpegExportServiceConfig): string {
  return joinUrl(
    resolveBaseUrl(config.baseUrl),
    DEFAULT_UPLOAD_AUDIO_PATH,
  );
}

async function uploadAudioForTranscode(
  audio: OfflineAudioRenderResult,
  options: FfmpegExportServiceConfig,
): Promise<string> {
  const url = resolveUploadAudioUrl(options);
  const response = await withTimeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, async (signal) =>
    fetch(url, {
      method: "POST",
      headers: {
        ...options.headers,
        "Content-Type": audio.mimeType,
        "X-File-Name": audio.fileName,
      },
      body: audio.blob,
      signal,
    }),
  );
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    const errorMessage =
      typeof payload === "string" && payload.trim()
        ? payload
        : `Audio upload failed with status ${response.status}.`;
    throw new Error(errorMessage);
  }

  const record = asRecord(payload);
  const token = record ? readString(record, ["audioToken", "token", "id"]) : null;
  if (!token) {
    throw new Error("Audio upload response is missing an audio token.");
  }

  return token;
}

function deriveRequestedConcatFileName(options: FfmpegSegmentConcatOptions): string {
  if (options.fileName) {
    return options.fileName;
  }

  if (options.outputPath && looksLikeFilePath(options.outputPath)) {
    return basenameFromPath(options.outputPath);
  }

  return "segmented-export.mp4";
}

export async function checkFfmpegExportServiceHealth(
  config: FfmpegExportServiceConfig = {},
): Promise<FfmpegServiceHealthCheckResult> {
  const url = resolveHealthUrl(config);
  const response = await withTimeout(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, async (signal) =>
    fetch(url, {
      method: "GET",
      headers: config.headers,
      signal,
    }),
  );

  const payload = await readResponsePayload(response);
  return {
    ok: response.ok,
    status: response.status,
    url,
    payload,
  };
}

export async function exportWebmToMp4(
  webm: OfflineWebmRenderResult,
  options: FfmpegMp4ExportOptions = {},
): Promise<OfflineMp4ExportResult> {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const transcodePath = options.transcodePath ?? getImportMetaEnv().VITE_FFMPEG_EXPORT_TRANSCODE_PATH ?? DEFAULT_TRANSCODE_PATH;
  const requestedFileName = deriveRequestedFileName(webm, options);
  const audioToken = options.audio ? await uploadAudioForTranscode(options.audio, options) : null;
  const url = new URL(createTranscodeUrl(baseUrl, transcodePath, webm.fileName, requestedFileName, options.fps));
  if (audioToken) {
    url.searchParams.set("audioToken", audioToken);
  }
  const response = await withTimeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, async (signal) =>
    fetch(url.toString(), {
      method: "POST",
      headers: {
        ...options.headers,
        "Content-Type": webm.mimeType,
        "X-File-Name": webm.fileName,
      },
      body: webm.blob,
      signal,
    }),
  );
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    const errorMessage =
      typeof payload === "string" && payload.trim()
        ? payload
        : `ffmpeg export service request failed with status ${response.status}.`;
    throw new Error(errorMessage);
  }

  const fileName = normalizeFileName(payload, requestedFileName, options.outputPath);
  return {
    fileName,
    outputPath: normalizeOutputPath(payload, options.outputPath, fileName),
    serviceUrl: url.toString(),
    responseStatus: response.status,
    downloadUrl: normalizeDownloadUrl(payload),
    jobId: normalizeJobId(payload),
    wasCancelled: webm.wasCancelled,
    payload,
  };
}

export async function concatMp4Segments(
  segments: OfflineMp4ExportResult[],
  options: FfmpegSegmentConcatOptions = {},
): Promise<OfflineMp4ExportResult> {
  const segmentPaths = segments.map((segment) => segment.outputPath).filter(Boolean);
  if (!segmentPaths.length) {
    throw new Error("No MP4 segments are available to concatenate.");
  }

  const url = resolveConcatUrl(options);
  const requestedFileName = deriveRequestedConcatFileName(options);
  const audioToken = options.audio ? await uploadAudioForTranscode(options.audio, options) : null;
  const response = await withTimeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, async (signal) =>
    fetch(url, {
      method: "POST",
      headers: {
        ...options.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        segmentPaths,
        outputFileName: requestedFileName,
        fps: options.fps,
        audioToken,
        cleanupSegments: options.cleanupSegments ?? true,
      }),
      signal,
    }),
  );
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    const errorMessage =
      typeof payload === "string" && payload.trim()
        ? payload
        : `ffmpeg concat request failed with status ${response.status}.`;
    throw new Error(errorMessage);
  }

  const fileName = normalizeFileName(payload, requestedFileName, options.outputPath);
  return {
    fileName,
    outputPath: normalizeOutputPath(payload, options.outputPath, fileName),
    serviceUrl: url,
    responseStatus: response.status,
    downloadUrl: normalizeDownloadUrl(payload),
    jobId: normalizeJobId(payload),
    wasCancelled: segments.some((segment) => segment.wasCancelled),
    payload,
  };
}
