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
  // True only when the headline durationMs came from a wall-clock fallback
  // (RENDERER_READY mark missing entirely). An RR-fallback (FI missing but
  // RR present) is annotated via `notes` but the marks are still aggregatable
  // and `degraded` stays false.
  degraded?: boolean;
}

interface MarkRecord {
  mark: string;
  timestamp: string;
  elapsedMs: number;
  meta?: Record<string, unknown>;
}

const PRODUCT_NAME = "Daintree";
const VARIANT = "daintree";

export function getPackagedExecutablePath(projectRoot: string): string {
  const releaseDir = path.resolve(projectRoot, "release");

  switch (process.platform) {
    case "darwin": {
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      return path.join(
        releaseDir,
        `${VARIANT}-${arch}`,
        `${PRODUCT_NAME}.app`,
        "Contents",
        "MacOS",
        PRODUCT_NAME
      );
    }
    case "win32": {
      const arch = "x64";
      return path.join(releaseDir, `${VARIANT}-${arch}`, `${PRODUCT_NAME}.exe`);
    }
    case "linux":
    default: {
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const unpackedDir = path.join(
        releaseDir,
        `${VARIANT}-${arch}`,
        "linux-unpacked",
        PRODUCT_NAME.toLowerCase()
      );
      if (fs.existsSync(unpackedDir)) return unpackedDir;
      return path.join(releaseDir, `${VARIANT}-${arch}`, `${PRODUCT_NAME}-${arch}.AppImage`);
    }
  }
}

export function findPackagedExecutable(projectRoot: string): string | null {
  const primary = getPackagedExecutablePath(projectRoot);
  if (fs.existsSync(primary)) return primary;

  // Fallback: scan release/ for any matching executable
  const releaseDir = path.resolve(projectRoot, "release");
  if (!fs.existsSync(releaseDir)) return null;

  try {
    const entries = fs.readdirSync(releaseDir);
    for (const entry of entries) {
      if (!entry.startsWith(VARIANT)) continue;
      const entryPath = path.join(releaseDir, entry);
      const stat = fs.statSync(entryPath);
      if (!stat.isDirectory()) continue;

      if (process.platform === "darwin") {
        const appPath = path.join(
          entryPath,
          `${PRODUCT_NAME}.app`,
          "Contents",
          "MacOS",
          PRODUCT_NAME
        );
        if (fs.existsSync(appPath)) return appPath;
      } else if (process.platform === "win32") {
        const exePath = path.join(entryPath, `${PRODUCT_NAME}.exe`);
        if (fs.existsSync(exePath)) return exePath;
      } else {
        const unpacked = path.join(entryPath, "linux-unpacked", PRODUCT_NAME.toLowerCase());
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

export function parseBootDuration(ndjsonPath: string): {
  durationMs: number;
  metrics: Record<string, number>;
  degraded?: string;
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
  if (!bootStart) {
    return { durationMs: -1, metrics: {} };
  }

  // RENDERER_FIRST_INTERACTIVE fires post-hydration after 2x rAF + the
  // notifyFirstInteractive IPC round-trip. That is what users perceive as
  // "interactive". RENDERER_READY only signals did-finish-load (DOM ready,
  // pre-hydration) and is reserved as a degraded fallback. See #8612.
  const firstInteractive = marks.get(PERF_MARKS.RENDERER_FIRST_INTERACTIVE);
  const rendererReady = marks.get(PERF_MARKS.RENDERER_READY);

  const metrics: Record<string, number> = {};

  // Extract key phase durations regardless of which terminal mark we use.
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

  if (rendererReady) {
    metrics.rendererReadyMs = rendererReady.elapsedMs - bootStart.elapsedMs;
  }

  if (firstInteractive) {
    return { durationMs: firstInteractive.elapsedMs - bootStart.elapsedMs, metrics };
  }

  if (rendererReady) {
    return {
      durationMs: rendererReady.elapsedMs - bootStart.elapsedMs,
      metrics,
      degraded:
        "RENDERER_FIRST_INTERACTIVE mark not captured — falling back to RENDERER_READY (pre-hydration)",
    };
  }

  return { durationMs: -1, metrics };
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

  // Wall-clock anchor captured immediately before electron.launch() so the
  // Electron main process can compute `os_to_app_boot_ms` against a Unix-epoch
  // reference. Cannot use performance.now() across processes — different time
  // origins. Date.now() aligns to the Unix epoch on both sides.
  const spawnWallMs = Date.now();

  const env: Record<string, string> = {
    DAINTREE_PERF_CAPTURE: "1",
    DAINTREE_PERF_METRICS_FILE: ndjsonPath,
    DAINTREE_PERF_SPAWN_WALL_MS: String(spawnWallMs),
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

    // After RENDERER_READY arrives, wait for RENDERER_FIRST_INTERACTIVE — the
    // post-hydration interactive signal. It typically arrives within 100ms of
    // RENDERER_READY (2x rAF + IPC round-trip) but CI runners under CPU
    // contention can push it past 500ms, so a deterministic mark wait is
    // safer than a fixed sleep. 5s is generous; if it doesn't arrive,
    // parseBootDuration falls back to RENDERER_READY with a degraded note.
    await waitForNdjsonMark(ndjsonPath, PERF_MARKS.RENDERER_FIRST_INTERACTIVE, 5_000);

    const { durationMs, metrics, degraded } = parseBootDuration(ndjsonPath);
    const wallClockMs = performance.now() - startMs;

    if (durationMs < 0) {
      metrics.wallClockMs = wallClockMs;
      return {
        durationMs: wallClockMs,
        metrics,
        ndjsonPath,
        notes: "RENDERER_READY mark not captured — using wall-clock fallback",
        degraded: true,
      };
    }

    return { durationMs, metrics, ndjsonPath, notes: degraded };
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
