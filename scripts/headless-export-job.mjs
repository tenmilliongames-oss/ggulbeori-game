import { randomUUID } from "node:crypto";

import { chromium } from "playwright";

function trimTrailingSlashes(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function toExportScale(value) {
  const parsed = Number.parseFloat(value ?? "");
  if (!Number.isFinite(parsed)) {
    return 1;
  }

  return Math.min(2, Math.max(1, parsed));
}

function toExportLayout(value) {
  return value === "shorts" ? "shorts" : "landscape";
}

function toSceneIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function summarizeRunnerState(runnerState) {
  return {
    phase: runnerState?.phase ?? "booting",
    message: runnerState?.message ?? "Booting export runner...",
    outputPath: runnerState?.outputPath ?? null,
    fileName: runnerState?.fileName ?? null,
    error: runnerState?.error ?? null,
    wasCancelled: Boolean(runnerState?.wasCancelled),
    progress: typeof runnerState?.progress === "number" ? runnerState.progress : 0,
    elapsedSec: typeof runnerState?.elapsedSec === "number" ? runnerState.elapsedSec : 0,
    etaSec: typeof runnerState?.etaSec === "number" ? runnerState.etaSec : null,
  };
}

function isTerminalRunnerPhase(phase) {
  return phase === "completed" || phase === "cancelled" || phase === "failed";
}

function isPageClosedError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Target page, context or browser has been closed/u.test(message);
}

function applyRunnerStateToJob(job, runnerState, wallStartMs) {
  if (!runnerState) {
    return;
  }

  job.message = runnerState.message;
  job.outputPath = runnerState.outputPath;
  job.fileName = runnerState.fileName || job.fileName;
  job.error = runnerState.error;
  job.progress = runnerState.progress;
  job.elapsedSec = runnerState.elapsedSec || (Date.now() - wallStartMs) / 1000;
  job.etaSec = runnerState.etaSec;
}

async function evaluateRunnerState(page) {
  const runnerState = await page.evaluate(() => {
    return window.__spotExportRunner?.getState?.() ?? null;
  });
  return summarizeRunnerState(runnerState);
}

async function requestRunnerCancel(page) {
  await page.evaluate(() => {
    window.__spotExportRunner?.cancelExport?.();
  });
}

function attachWindowLifecycleFlags(browser, context, page, flags) {
  const markClosed = () => {
    flags.windowClosed = true;
  };

  page.on("close", markClosed);
  context.on("close", markClosed);
  browser.on("disconnected", markClosed);
}

function buildWindowClosedError(lastRunnerState) {
  if (lastRunnerState?.message) {
    return new Error(
      `Dedicated export window was closed before export finished. Last state: ${lastRunnerState.message}`,
    );
  }

  return new Error(
    "Dedicated export window was closed before export finished. Keep the export window open while exporting.",
  );
}

export async function startHeadlessExportJob(payload, serviceContext) {
  const appBaseUrl = trimTrailingSlashes(
    payload.appBaseUrl ||
    serviceContext.appBaseUrl ||
    process.env.SPOT_EXPORT_APP_BASE_URL ||
    "http://127.0.0.1:5173",
  );
  const workbookPath = payload.workbookPath || "/projects/sample/scene-flow.xlsx";
  const indexPath = payload.indexPath || "/projects/sample/project-index.json";
  const exportScale = toExportScale(payload.exportScale);
  const exportLayout = toExportLayout(payload.exportLayout);
  const sceneIds = toSceneIds(payload.sceneIds);
  const serviceBaseUrl = trimTrailingSlashes(serviceContext.serviceBaseUrl);
  const runnerParams = new URLSearchParams({
    workbook: workbookPath,
    index: indexPath,
    exportScale: String(exportScale),
    layout: exportLayout,
  });
  if (sceneIds.length) {
    runnerParams.set("scenes", sceneIds.join(","));
  }
  const runnerUrl = `${appBaseUrl}/export-runner.html?${runnerParams.toString()}`;

  const job = {
    id: randomUUID(),
    status: "queued",
    message: "Queued for dedicated export window capture.",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    outputPath: null,
    fileName: payload.fileName || null,
    error: null,
    cancelRequested: false,
    progress: 0,
    elapsedSec: 0,
    etaSec: null,
    appBaseUrl,
    runnerUrl,
    currentController: null,
  };

  void (async () => {
    const wallStartMs = Date.now();
    let browser = null;
    let context = null;
    let page = null;
    let cancelSent = false;
    let retriesRemaining = 1;
    let exportStarted = false;
    let lastRunnerState = summarizeRunnerState(null);
    let windowFlags = { windowClosed: false };

    const closeCurrentController = async () => {
      job.currentController = null;
      if (context) {
        await context.close().catch(() => {});
      }
      if (browser) {
        await browser.close().catch(() => {});
      }
      browser = null;
      context = null;
      page = null;
      cancelSent = false;
      windowFlags = { windowClosed: false };
    };

    try {
      while (true) {
        try {
          job.status = "booting";
          if (!job.startedAt) {
            job.startedAt = new Date().toISOString();
          }
          job.message = exportStarted
            ? "Re-launching dedicated export window..."
            : "Launching dedicated export window...";

          browser = await chromium.launch({
            headless: false,
            args: [
              "--disable-background-timer-throttling",
              "--disable-backgrounding-occluded-windows",
              "--disable-renderer-backgrounding",
              "--autoplay-policy=no-user-gesture-required",
            ],
          });
          context = await browser.newContext({
            viewport: exportLayout === "shorts"
              ? { width: 720, height: 1280 }
              : { width: 1280, height: 720 },
            deviceScaleFactor: 1,
          });
          if (payload.workbookData && typeof payload.workbookData === "object") {
            await context.addInitScript((workbookData) => {
              window.__spotExportWorkbookData = workbookData;
            }, payload.workbookData);
          }
          page = await context.newPage();
          attachWindowLifecycleFlags(browser, context, page, windowFlags);
          job.currentController = { browser, context, page };

          await page.goto(runnerUrl, {
            waitUntil: "networkidle",
            timeout: 120_000,
          });
          await page.waitForFunction(() => Boolean(window.__spotExportRunner), undefined, {
            timeout: 120_000,
          });
          await page.evaluate(async () => {
            await window.__spotExportRunner.ensureReady();
          });

          lastRunnerState = await evaluateRunnerState(page).catch(() => lastRunnerState);
          applyRunnerStateToJob(job, lastRunnerState, wallStartMs);

          job.status = "running";
          job.message = "Dedicated export window ready.";

          await page.evaluate((options) => {
            globalThis.__spotExportPromise = window.__spotExportRunner.beginExport(options).catch(() => undefined);
          }, {
            ffmpegServiceBaseUrl: serviceBaseUrl,
            fileName: payload.fileName,
            outputPath: payload.outputPath,
          });
          exportStarted = true;

          while (true) {
            if (job.cancelRequested && !cancelSent && page && !page.isClosed()) {
              cancelSent = true;
              job.message = "Cancellation requested...";
              await requestRunnerCancel(page).catch(() => {});
            }

            if (!page || page.isClosed() || windowFlags.windowClosed) {
              if (isTerminalRunnerPhase(lastRunnerState.phase)) {
                applyRunnerStateToJob(job, lastRunnerState, wallStartMs);
                if (lastRunnerState.phase === "completed") {
                  job.status = "completed";
                  job.progress = 1;
                  return;
                }
                if (lastRunnerState.phase === "cancelled") {
                  job.status = "cancelled";
                  job.progress = 1;
                  return;
                }
                job.status = job.cancelRequested ? "cancelled" : "failed";
                return;
              }

              throw buildWindowClosedError(lastRunnerState);
            }

            let runnerState;
            try {
              runnerState = await evaluateRunnerState(page);
            } catch (error) {
              if (isPageClosedError(error) || windowFlags.windowClosed || page.isClosed()) {
                if (isTerminalRunnerPhase(lastRunnerState.phase)) {
                  applyRunnerStateToJob(job, lastRunnerState, wallStartMs);
                  if (lastRunnerState.phase === "completed") {
                    job.status = "completed";
                    job.progress = 1;
                    return;
                  }
                  if (lastRunnerState.phase === "cancelled") {
                    job.status = "cancelled";
                    job.progress = 1;
                    return;
                  }
                  job.status = job.cancelRequested ? "cancelled" : "failed";
                  return;
                }

                throw buildWindowClosedError(lastRunnerState);
              }

              throw error;
            }

            lastRunnerState = runnerState;
            applyRunnerStateToJob(job, runnerState, wallStartMs);

            if (runnerState.phase === "completed") {
              job.status = "completed";
              job.progress = 1;
              return;
            }

            if (runnerState.phase === "cancelled") {
              job.status = "cancelled";
              job.progress = 1;
              return;
            }

            if (runnerState.phase === "failed") {
              job.status = job.cancelRequested ? "cancelled" : "failed";
              return;
            }

            await delay(1000);
          }
        } catch (error) {
          const pageClosed = (
            isPageClosedError(error) ||
            windowFlags.windowClosed ||
            (page != null && page.isClosed())
          );
          await closeCurrentController();

          if (job.cancelRequested) {
            job.status = "cancelled";
            job.message = "Export cancelled.";
            return;
          }

          if (pageClosed && retriesRemaining > 0 && !isTerminalRunnerPhase(lastRunnerState.phase)) {
            retriesRemaining -= 1;
            exportStarted = false;
            job.message = "Export window closed unexpectedly. Retrying once...";
            await delay(1000);
            continue;
          }

          throw pageClosed ? buildWindowClosedError(lastRunnerState) : error;
        }
      }
    } catch (error) {
      job.status = job.cancelRequested ? "cancelled" : "failed";
      job.error = error instanceof Error ? error.message : "Headless export failed.";
      job.message = job.error;
    } finally {
      job.finishedAt = new Date().toISOString();
      await closeCurrentController();
    }
  })();

  return job;
}

export async function cancelHeadlessExportJob(job) {
  job.cancelRequested = true;
  const page = job.currentController?.page ?? null;
  if (page && !page.isClosed()) {
    await requestRunnerCancel(page).catch(() => {});
  }
}
