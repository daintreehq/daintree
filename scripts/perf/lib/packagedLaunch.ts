import { spawn, type ChildProcess } from "node:child_process";
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
  // "cold" (fresh profile, the default) or "warm" (caller supplied a persisted
  // userDataDir that was pre-populated, so the compile cache should hit).
  cacheKind: "cold" | "warm";
  // Number of files in the compile-cache dir at the end of this launch. >0 on a
  // warm run confirms enableCompileCache() populated the dir; the cold/warm
  // bucketing in the aggregator uses cacheKind, this is a corroborating signal.
  cacheFileCount?: number;
}

interface MarkRecord {
  mark: string;
  timestamp: string;
  elapsedMs: number;
  meta?: Record<string, unknown>;
}

const PRODUCT_NAME = "Daintree";
const VARIANT = "daintree";

// A candidate only counts when it is a regular file — existsSync alone would
// accept a directory or dangling placeholder at the executable path and turn
// a clear "binary not found" into a cryptic Playwright launch error.
function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function getPackagedExecutablePath(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform
): string {
  const releaseDir = path.resolve(projectRoot, "release");

  switch (platform) {
    case "darwin": {
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const appBinary = path.join(`${PRODUCT_NAME}.app`, "Contents", "MacOS", PRODUCT_NAME);
      // electron-builder `--dir` default layouts first, then the legacy
      // daintree-{arch} layout as a fallback.
      const candidates = [
        path.join(releaseDir, `mac-${arch}`, appBinary),
        path.join(releaseDir, "mac", appBinary),
        path.join(releaseDir, "mac-universal", appBinary),
        path.join(releaseDir, `${VARIANT}-${arch}`, appBinary),
      ];
      for (const candidate of candidates) {
        if (isRegularFile(candidate)) return candidate;
      }
      return candidates[0];
    }
    case "win32": {
      const arch = "x64";
      const candidates = [
        path.join(releaseDir, "win-unpacked", `${PRODUCT_NAME}.exe`),
        path.join(releaseDir, `${VARIANT}-${arch}`, `${PRODUCT_NAME}.exe`),
      ];
      for (const candidate of candidates) {
        if (isRegularFile(candidate)) return candidate;
      }
      return candidates[0];
    }
    case "linux":
    default: {
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      // electron-builder `--linux --dir` outputs straight to
      // release/linux-unpacked/ with no daintree-{arch} prefix — this is
      // what the perf-nightly CI job builds (#10068).
      const candidates = [
        path.join(releaseDir, "linux-unpacked", PRODUCT_NAME.toLowerCase()),
        path.join(releaseDir, `${VARIANT}-${arch}`, "linux-unpacked", PRODUCT_NAME.toLowerCase()),
      ];
      for (const candidate of candidates) {
        if (isRegularFile(candidate)) return candidate;
      }
      return path.join(releaseDir, `${VARIANT}-${arch}`, `${PRODUCT_NAME}-${arch}.AppImage`);
    }
  }
}

export function findPackagedExecutable(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const primary = getPackagedExecutablePath(projectRoot, platform);
  if (isRegularFile(primary)) return primary;

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

      if (platform === "darwin") {
        const appPath = path.join(
          entryPath,
          `${PRODUCT_NAME}.app`,
          "Contents",
          "MacOS",
          PRODUCT_NAME
        );
        if (isRegularFile(appPath)) return appPath;
      } else if (platform === "win32") {
        const exePath = path.join(entryPath, `${PRODUCT_NAME}.exe`);
        if (isRegularFile(exePath)) return exePath;
      } else {
        const unpacked = path.join(entryPath, "linux-unpacked", PRODUCT_NAME.toLowerCase());
        if (isRegularFile(unpacked)) return unpacked;
      }
    }
  } catch {
    // Best effort scan
  }

  return null;
}

async function waitForNdjsonMark(
  ndjsonPath: string,
  targetMark: string,
  timeoutMs: number,
  getProcessError?: () => Error | null
): Promise<MarkRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const processError = getProcessError?.();
    if (processError) throw processError;

    if (!fs.existsSync(ndjsonPath)) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(ndjsonPath, "utf-8").trim().split("\n");
    } catch {
      // File read raced with a write — try again on the next poll.
    }
    // Per-line try/catch so a single malformed line (e.g. a truncated
    // mid-write) doesn't cause us to skip the rest of the buffer for this
    // poll tick.
    for (const line of lines) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as MarkRecord;
        if (record.mark === targetMark) {
          return record;
        }
      } catch {
        // Skip malformed line
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }

    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopProcess(child: ChildProcess, traceEnabled: boolean): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  const exited = await waitForExit(child, traceEnabled ? 15_000 : 5_000);
  if (exited) return;

  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await waitForExit(child, 2_000);
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
      // First-wins matches the aggregate() policy in coldStartAggregate.ts.
      // Marks are append-only in NDJSON; the first occurrence is the
      // canonical one. Later duplicates (idempotency-guard breakage,
      // re-emission during teardown) should not silently shift the value.
      if (!marks.has(record.mark)) {
        marks.set(record.mark, record);
      }
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

// Count V8 cache files under a userData dir's compile-cache. The dir is created
// lazily by enableCompileCache(), so a missing dir is a legitimate 0 count.
// Node nests the actual cache files one level down in a versioned subdirectory
// (e.g. `compile-cache/v22.x.x-arch-<hash>/`), so we sum the entries inside each
// subdir rather than counting the base dir — which would only ever be 0 or 1.
// The files use opaque content-hash names, so a count is all we can get; there's
// no programmatic cache hit/miss API in Node 22+.
export function countCompileCacheFiles(userDataDir: string): number {
  const base = path.join(userDataDir, "compile-cache");
  let total = 0;
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        total += 1;
        continue;
      }
      try {
        total += fs.readdirSync(path.join(base, entry.name)).length;
      } catch {
        // Subdir vanished mid-read — skip it.
      }
    }
  } catch {
    return 0;
  }
  return total;
}

export async function launchPackagedAndMeasure(
  executablePath: string,
  iteration: number,
  options: {
    projectRoot?: string;
    timeoutMs?: number;
    captureCdpMetrics?: boolean;
    // When provided, reuse this directory instead of a fresh mkdtemp profile and
    // skip the post-run cleanup (the caller owns the dir's lifecycle). This is
    // how warm-cache runs reuse a populated compile cache across launches.
    userDataDir?: string;
    // Absolute path for the GPU/compositor trace. When set, the packaged app
    // self-starts `contentTracing` (DAINTREE_PERF_TRACE) and writes the trace
    // here on quit. Lives outside userDataDir so it survives the cleanup below.
    traceFile?: string;
  } = {}
): Promise<PackagedLaunchResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const isWarm = Boolean(options.userDataDir);
  const cacheKind: "cold" | "warm" = isWarm ? "warm" : "cold";
  const userDataDir =
    options.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `daintree-perf-${iteration}-`));
  const ndjsonPath = path.join(userDataDir, "perf-metrics.ndjson");

  // Marks are append-only. When reusing a warm userDataDir across launches the
  // NDJSON would accumulate, and parseBootDuration's first-wins policy would
  // read the warmup boot's marks instead of this run's. Clear it so each launch
  // produces a clean timeline. Harmless on cold runs (file doesn't exist yet).
  if (isWarm) {
    try {
      fs.rmSync(ndjsonPath, { force: true });
    } catch {
      // Best effort — a stale file just means parseBootDuration sees old marks.
    }
  }

  // Wall-clock anchor captured immediately before spawn() so the
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

  if (options.traceFile) {
    env.DAINTREE_PERF_TRACE = "1";
    env.DAINTREE_PERF_TRACE_FILE = options.traceFile;
  }

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

  // Build the child env from the parent, then strip Node's compile-cache env
  // vars. If NODE_COMPILE_CACHE is inherited (the agent shell / a dev machine
  // may set it), Node enables the cache against that shared directory before the
  // app's own enableCompileCache(userDataDir/compile-cache) runs — so a "cold"
  // run would silently hit the inherited warm cache and report bogus baselines.
  // Deleting both keys forces the app to own its compile cache inside userDataDir.
  const launchEnv: Record<string, string | undefined> = { ...process.env, ...env };
  delete launchEnv.NODE_COMPILE_CACHE;
  delete launchEnv.NODE_DISABLE_COMPILE_CACHE;
  delete launchEnv.ELECTRON_RUN_AS_NODE;

  let child: ChildProcess | null = null;
  let childError: Error | null = null;
  let result: PackagedLaunchResult;
  const startMs = performance.now();

  try {
    child = spawn(executablePath, args, {
      env: launchEnv,
      stdio: "ignore",
      detached: false,
    });
    child.once("error", (error) => {
      childError = error;
    });

    const getProcessError = (): Error | null => {
      if (childError) return childError;
      if (child?.exitCode !== null && child?.exitCode !== undefined) {
        return new Error(`Packaged app exited before startup marks (code ${child.exitCode})`);
      }
      if (child?.signalCode) {
        return new Error(`Packaged app exited before startup marks (signal ${child.signalCode})`);
      }
      return null;
    };

    await waitForNdjsonMark(ndjsonPath, PERF_MARKS.RENDERER_READY, timeoutMs, getProcessError);

    // After RENDERER_READY arrives, wait for RENDERER_FIRST_INTERACTIVE — the
    // post-hydration interactive signal. It typically arrives within 100ms of
    // RENDERER_READY (2x rAF + IPC round-trip) but CI runners under CPU
    // contention can push it past 500ms, so a deterministic mark wait is
    // safer than a fixed sleep. 5s is generous; if it doesn't arrive,
    // parseBootDuration falls back to RENDERER_READY with a degraded note.
    await waitForNdjsonMark(
      ndjsonPath,
      PERF_MARKS.RENDERER_FIRST_INTERACTIVE,
      5_000,
      getProcessError
    );

    const { durationMs, metrics, degraded } = parseBootDuration(ndjsonPath);
    const wallClockMs = performance.now() - startMs;
    const cacheFileCount = countCompileCacheFiles(userDataDir);

    if (durationMs < 0) {
      metrics.wallClockMs = wallClockMs;
      result = {
        durationMs: wallClockMs,
        metrics,
        ndjsonPath,
        notes: "RENDERER_READY mark not captured — using wall-clock fallback",
        degraded: true,
        cacheKind,
        cacheFileCount,
      };
    } else {
      result = { durationMs, metrics, ndjsonPath, notes: degraded, cacheKind, cacheFileCount };
    }
  } finally {
    if (child) await stopProcess(child, Boolean(options.traceFile));

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

    // Clean up userDataDir after a brief delay (allow process shutdown). Skip
    // for caller-supplied warm dirs — the caller owns that dir's lifecycle and
    // needs it to persist across the run loop to keep the compile cache warm.
    if (!isWarm) {
      setTimeout(() => {
        try {
          fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch {
          // Best effort
        }
      }, 1000);
    }
  }

  return result;
}
