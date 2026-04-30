import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PERF_MARKS } from "../../../shared/perf/marks";

export interface PackagedLaunchResult {
  durationMs: number;
  metrics: Record<string, number>;
  ndjsonPath: string;
  notes?: string;
}

interface MarkRecord {
  mark: string;
  timestamp: string;
  elapsedMs: number;
  meta?: Record<string, unknown>;
}

const PRODUCT_NAME = "Daintree";

export function getPackagedExecutablePath(projectRoot: string): string {
  const variant = process.env.BUILD_VARIANT ?? "daintree";
  const productName = variant === "canopy" ? "Canopy" : PRODUCT_NAME;
  const releaseDir = path.resolve(projectRoot, "release");

  switch (process.platform) {
    case "darwin": {
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      return path.join(
        releaseDir,
        `${variant}-${arch}`,
        `${productName}.app`,
        "Contents",
        "MacOS",
        productName
      );
    }
    case "win32": {
      const arch = "x64";
      return path.join(releaseDir, `${variant}-${arch}`, `${productName}.exe`);
    }
    case "linux":
    default: {
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const unpackedDir = path.join(
        releaseDir,
        `${variant}-${arch}`,
        "linux-unpacked",
        productName.toLowerCase()
      );
      if (fs.existsSync(unpackedDir)) return unpackedDir;
      return path.join(releaseDir, `${variant}-${arch}`, `${productName}-${arch}.AppImage`);
    }
  }
}

export function findPackagedExecutable(projectRoot: string): string | null {
  const primary = getPackagedExecutablePath(projectRoot);
  if (fs.existsSync(primary)) return primary;

  // Fallback: scan release/ for any matching executable
  const releaseDir = path.resolve(projectRoot, "release");
  if (!fs.existsSync(releaseDir)) return null;

  const variant = process.env.BUILD_VARIANT ?? "daintree";
  const productName = variant === "canopy" ? "Canopy" : PRODUCT_NAME;

  try {
    const entries = fs.readdirSync(releaseDir);
    for (const entry of entries) {
      if (!entry.startsWith(variant)) continue;
      const entryPath = path.join(releaseDir, entry);
      const stat = fs.statSync(entryPath);
      if (!stat.isDirectory()) continue;

      if (process.platform === "darwin") {
        const appPath = path.join(
          entryPath,
          `${productName}.app`,
          "Contents",
          "MacOS",
          productName
        );
        if (fs.existsSync(appPath)) return appPath;
      } else if (process.platform === "win32") {
        const exePath = path.join(entryPath, `${productName}.exe`);
        if (fs.existsSync(exePath)) return exePath;
      } else {
        const unpacked = path.join(entryPath, "linux-unpacked", productName.toLowerCase());
        if (fs.existsSync(unpacked)) return unpacked;
      }
    }
  } catch {
    // Best effort scan
  }

  return null;
}

async function pollForWindow(app: ElectronApplication, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      const url = w.url();
      if (url.startsWith("app://") || url.includes("localhost")) {
        return w;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out waiting for app window");
}

async function waitForNdjsonMark(
  ndjsonPath: string,
  targetMark: string,
  timeoutMs: number
): Promise<MarkRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (!fs.existsSync(ndjsonPath)) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      const lines = fs.readFileSync(ndjsonPath, "utf-8").trim().split("\n");
      for (const line of lines) {
        if (!line) continue;
        const record = JSON.parse(line) as MarkRecord;
        if (record.mark === targetMark) {
          return record;
        }
      }
    } catch {
      // File may be mid-write
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

function parseBootDuration(ndjsonPath: string): {
  durationMs: number;
  metrics: Record<string, number>;
} {
  if (!fs.existsSync(ndjsonPath)) {
    return { durationMs: -1, metrics: {} };
  }

  const lines = fs.readFileSync(ndjsonPath, "utf-8").trim().split("\n");
  const marks = new Map<string, MarkRecord>();

  for (const line of lines) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as MarkRecord;
      marks.set(record.mark, record);
    } catch {
      // Skip malformed lines
    }
  }

  const bootStart = marks.get(PERF_MARKS.APP_BOOT_START);
  const rendererReady = marks.get(PERF_MARKS.RENDERER_READY);

  if (!bootStart || !rendererReady) {
    return { durationMs: -1, metrics: {} };
  }

  const durationMs = rendererReady.elapsedMs - bootStart.elapsedMs;
  const metrics: Record<string, number> = {};

  // Extract key phase durations
  const serviceInitStart = marks.get(PERF_MARKS.SERVICE_INIT_START);
  const serviceInitComplete = marks.get(PERF_MARKS.SERVICE_INIT_COMPLETE);
  if (serviceInitStart && serviceInitComplete) {
    metrics.serviceInitMs = serviceInitComplete.elapsedMs - serviceInitStart.elapsedMs;
  }

  const hydrateStart = marks.get(PERF_MARKS.HYDRATE_START);
  const hydrateComplete = marks.get(PERF_MARKS.HYDRATE_COMPLETE);
  if (hydrateStart && hydrateComplete) {
    metrics.hydrateMs = hydrateComplete.elapsedMs - hydrateStart.elapsedMs;
  }

  return { durationMs, metrics };
}

export async function launchPackagedAndMeasure(
  executablePath: string,
  iteration: number,
  options: {
    projectRoot?: string;
    timeoutMs?: number;
    captureCdpMetrics?: boolean;
  } = {}
): Promise<PackagedLaunchResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `daintree-perf-${iteration}-`));
  const ndjsonPath = path.join(userDataDir, "perf-metrics.ndjson");

  const env: Record<string, string> = {
    DAINTREE_PERF_CAPTURE: "1",
    DAINTREE_PERF_METRICS_FILE: ndjsonPath,
    DAINTREE_E2E_MODE: "1",
    DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS: "1",
    NODE_ENV: "production",
  };

  if (process.env.CI) {
    env.DAINTREE_DISABLE_WEBGL = "1";
  }

  const args = [`--user-data-dir=${userDataDir}`];

  if (process.env.CI) {
    args.unshift("--disable-gpu", "--disable-software-rasterizer", "--noerrdialogs");
    if (process.platform === "linux") {
      args.unshift("--no-sandbox", "--disable-dev-shm-usage");
    }
  }

  let app: ElectronApplication | null = null;
  const startMs = performance.now();

  try {
    app = await electron.launch({
      executablePath,
      args,
      env: { ...process.env, ...env },
      timeout: timeoutMs,
    });

    await pollForWindow(app, timeoutMs);

    await waitForNdjsonMark(ndjsonPath, PERF_MARKS.RENDERER_READY, timeoutMs);

    // Allow a brief settling period for any remaining marks to flush
    await new Promise((r) => setTimeout(r, 500));

    const { durationMs, metrics } = parseBootDuration(ndjsonPath);
    const wallClockMs = performance.now() - startMs;

    if (durationMs < 0) {
      metrics.wallClockMs = wallClockMs;
      return {
        durationMs: wallClockMs,
        metrics,
        ndjsonPath,
        notes: "RENDERER_READY mark not captured — using wall-clock fallback",
      };
    }

    return { durationMs, metrics, ndjsonPath };
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {
        // Force cleanup
      }
    }

    // Kill any lingering processes
    try {
      const entries = fs.readdirSync(userDataDir);
      for (const entry of entries) {
        if (entry.startsWith("Singleton")) {
          try {
            fs.unlinkSync(path.join(userDataDir, entry));
          } catch {
            // Best effort
          }
        }
      }
    } catch {
      // Directory may not exist
    }

    // Clean up userDataDir after a brief delay (allow process shutdown)
    setTimeout(() => {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Best effort
      }
    }, 1000);
  }
}
