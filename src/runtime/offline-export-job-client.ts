import type { WorkbookData } from "./project-types";

interface EnvLookup {
  VITE_FFMPEG_EXPORT_BASE_URL?: string;
}

export interface OfflineExportJobSummary {
  id: string;
  status: "queued" | "booting" | "running" | "completed" | "failed" | "cancelled";
  message: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  outputPath: string | null;
  fileName: string | null;
  error: string | null;
  appBaseUrl: string | null;
  runnerUrl: string | null;
  cancelRequested: boolean;
  progress: number;
  elapsedSec: number;
  etaSec: number | null;
}

export interface OfflineExportJobCreateOptions {
  workbookPath?: string;
  workbookData?: WorkbookData;
  indexPath?: string;
  fileName?: string;
  outputPath?: string;
  appBaseUrl?: string;
  exportScale?: number;
  exportLayout?: "landscape" | "shorts";
  sceneIds?: string[];
}

export interface OpenOutputFolderResult {
  ok: boolean;
  openedPath: string;
  folderPath: string;
}

const DEFAULT_SERVICE_BASE_URL = "http://127.0.0.1:43123";

function getImportMetaEnv(): EnvLookup {
  const meta = import.meta as ImportMeta & { env?: EnvLookup };
  return meta.env ?? {};
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveServiceBaseUrl(baseUrlOverride?: string): string {
  const env = getImportMetaEnv();
  return trimTrailingSlashes(baseUrlOverride ?? env.VITE_FFMPEG_EXPORT_BASE_URL ?? DEFAULT_SERVICE_BASE_URL);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const payload = (await response.json()) as Record<string, unknown>;
  return payload;
}

function readJob(payload: Record<string, unknown>): OfflineExportJobSummary {
  const job = payload.job;
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new Error("Export service response is missing job data.");
  }

  return job as OfflineExportJobSummary;
}

export async function startOfflineExportJob(
  options: OfflineExportJobCreateOptions = {},
  serviceBaseUrl?: string,
): Promise<OfflineExportJobSummary> {
  const response = await fetch(`${resolveServiceBaseUrl(serviceBaseUrl)}/jobs/offline-export`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(options),
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(String(payload.error ?? "Failed to start offline export job."));
  }

  return readJob(payload);
}

export async function getOfflineExportJob(
  jobId: string,
  serviceBaseUrl?: string,
): Promise<OfflineExportJobSummary> {
  const response = await fetch(`${resolveServiceBaseUrl(serviceBaseUrl)}/jobs/${jobId}`);
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(String(payload.error ?? `Failed to load offline export job ${jobId}.`));
  }

  return readJob(payload);
}

export async function cancelOfflineExportJob(
  jobId: string,
  serviceBaseUrl?: string,
): Promise<OfflineExportJobSummary> {
  const response = await fetch(`${resolveServiceBaseUrl(serviceBaseUrl)}/jobs/${jobId}/cancel`, {
    method: "POST",
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(String(payload.error ?? `Failed to cancel offline export job ${jobId}.`));
  }

  return readJob(payload);
}

export async function openOfflineExportFolder(
  outputPath: string,
  serviceBaseUrl?: string,
): Promise<OpenOutputFolderResult> {
  const response = await fetch(`${resolveServiceBaseUrl(serviceBaseUrl)}/open-output-folder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ outputPath }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(String(payload.error ?? "Failed to open export folder."));
  }

  return payload as unknown as OpenOutputFolderResult;
}
