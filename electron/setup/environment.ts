// eager-import-allow: performs sync fs and SQLite setup while preparing the runtime environment
// Dead-fd errnos that must not propagate on GUI launch (AppImage/Wayland, no
// terminal). EPIPE is a closed pipe (e.g. user quits Terminal.app while
// Daintree runs); EIO is a disconnected pty (the primary errno for AppImage
// desktop launches where fd 2 points to an orphaned pty slave); EBADF is a
// closed fd; ECONNRESET is a socket-backed stdio reset. ENOSPC is
// intentionally NOT swallowed — it's a real error condition.
const STDIO_DEAD_CODES = new Set(["EPIPE", "EIO", "EBADF", "ECONNRESET"]);
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === "function") {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code && STDIO_DEAD_CODES.has(err.code)) return;
      throw err;
    });
  }
}

import nodeV8 from "node:v8";
import vm from "node:vm";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { app } from "electron";
import path from "path";
import fs from "fs";
import { existsSync } from "fs";
import os from "os";
import {
  applyWindowsExtraPaths,
  deduplicatePath,
  resolveWindowsRegistryPath,
} from "./windowsPath.js";
import { isLinuxWaylandHybridGpu } from "../utils/gpuDetection.js";
import { getMaxWebGLContextCeiling } from "../utils/webglContextBudget.js";
// Deliberately the tiny pure-fs module, NOT GpuCrashMonitorService — importing
// the service here would evaluate its logger/telemetry/store import chain at
// module load, before this file's body re-paths userData for dev instances.
import {
  GPU_DISABLED_FLAG_FILENAME,
  readGpuDisabledFlagData,
  shouldRetryGpuAfterUpdate,
} from "../services/gpuDisabledFlag.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import {
  e2eCrashDumpsDir,
  isDemoMode,
  isE2EMode,
  isSmokeTest,
  smokeTestStart,
} from "./runtimeFlags.js";
// Side-effect import: registers the macOS `daintree://` `open-url` listener on
// the early-load path (#9559). environment.ts is imported first in main.ts, so
// the listener is live before `app.whenReady()` resolves — see deepLinkUrlQueue.
import "./deepLinkUrlQueue.js";

export let exposeGc: (() => void) | undefined;
try {
  nodeV8.setFlagsFromString("--expose_gc");
  exposeGc = vm.runInNewContext("gc") as () => void;
  (globalThis as Record<string, unknown>).__daintree_gc = exposeGc;
} catch {
  // GC exposure not available — non-critical
}

// In development, use a separate userData directory so the dev instance
// doesn't conflict with the production app's single-instance lock or storage.
// Skip when --user-data-dir is explicitly set (e.g. E2E tests) so that
// each test run gets its own isolated data directory.
const hasExplicitUserDataDir = process.argv.some((a) => a.startsWith("--user-data-dir"));
if (!app.isPackaged && !hasExplicitUserDataDir) {
  const devUserDataDir = process.env.DAINTREE_DEV_USER_DATA_DIR?.trim();
  app.setPath(
    "userData",
    devUserDataDir && path.isAbsolute(devUserDataDir)
      ? devUserDataDir
      : path.join(app.getPath("appData"), "daintree-dev")
  );
}

// E2E: redirect crash dumps to workspace-relative path so CI artifact upload
// captures them. Runs before crashReporter.start() (main.ts:158) because
// environment.ts is imported synchronously at the top of main.ts.
if (isE2EMode && e2eCrashDumpsDir && path.isAbsolute(e2eCrashDumpsDir)) {
  app.setPath("crashDumps", e2eCrashDumpsDir);
}

// Handle --reset-data: wipe userData before Chromium acquires file locks
// AND before reading any flag files below — otherwise a reset-while-disabled
// launch would carry the stale GPU flag forward by one cycle.
const shouldResetData =
  process.argv.includes("--reset-data") || process.env.DAINTREE_RESET_DATA === "1";
if (shouldResetData) {
  const userDataPath = app.getPath("userData");
  if (fs.existsSync(userDataPath)) {
    for (const entry of fs.readdirSync(userDataPath)) {
      try {
        fs.rmSync(path.join(userDataPath, entry), { recursive: true, force: true });
      } catch {
        // Skip locked files
      }
    }
  }
}

// GPU crash fallback: disable hardware acceleration before app.whenReady().
// The flag is written by GpuCrashMonitorService after repeated GPU crashes or
// by the Settings > Troubleshooting toggle (reason "user"). Crash-written
// flags are retried once per app version — if the crashes came from an
// Electron or driver bug, the fix would otherwise never reach affected users
// because the flag outlives the update. User-written flags never auto-retry.
const gpuFlagPath = path.join(app.getPath("userData"), GPU_DISABLED_FLAG_FILENAME);
const gpuDisabledFlagData = readGpuDisabledFlagData(app.getPath("userData"));
let gpuFlagClearedForRetry = false;
// The null check short-circuits before app.getVersion() — the common no-flag
// boot skips the call entirely.
if (
  gpuDisabledFlagData !== null &&
  shouldRetryGpuAfterUpdate(gpuDisabledFlagData, app.getVersion())
) {
  try {
    fs.unlinkSync(gpuFlagPath);
    gpuFlagClearedForRetry = true;
    console.log(
      `[GPU] Retrying hardware acceleration after update (flag written by version ${gpuDisabledFlagData!.version}, now ${app.getVersion()})`
    );
    // Retry from a clean slate: drop the ANGLE/Vulkan fallback flag too so the
    // post-update session starts on the default GPU path. Best-effort — the
    // crash monitor rewrites it if the first post-update crash recurs.
    try {
      fs.unlinkSync(path.join(app.getPath("userData"), "gpu-angle-fallback.flag"));
    } catch {
      // Usually ENOENT — the nuclear-disable path already cleared it.
    }
  } catch (err) {
    // Couldn't clear the flag (read-only fs, permissions). Keep acceleration
    // off for this session — never let a failed cleanup write flip behavior
    // the persisted state can't back up (lesson #6350).
    console.warn("[GPU] Failed to clear gpu-disabled flag for version retry:", err);
  }
}
export const gpuHardwareAccelerationDisabled =
  gpuDisabledFlagData !== null && !gpuFlagClearedForRetry;
if (gpuHardwareAccelerationDisabled) {
  app.disableHardwareAcceleration();
  console.log("[GPU] Hardware acceleration disabled by crash fallback flag");
}

// Soft GPU fallback: ANGLE/Vulkan flags for Linux Wayland multi-GPU systems.
// Triggered proactively when a hybrid NVIDIA+Intel/AMD configuration is
// detected, or reactively after the first GPU crash (flag written by
// GpuCrashMonitorService). Skipped entirely when hardware acceleration has
// already been nuked.
const gpuAngleFallbackFlagPath = path.join(app.getPath("userData"), "gpu-angle-fallback.flag");
export const gpuAngleFallbackActive = fs.existsSync(gpuAngleFallbackFlagPath);

// Chromium feature flags: memory reclamation + platform-specific features
const enabledFeatures = ["PartitionAllocMemoryReclaimer"];

// Enable native Wayland support on Linux (Electron < 38)
// Electron 38+ auto-detects via XDG_SESSION_TYPE; this flag is ignored.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  if (process.env.XDG_SESSION_TYPE === "wayland") {
    enabledFeatures.push("WaylandWindowDecorations");
    app.commandLine.appendSwitch("enable-wayland-ime");

    // Apply ANGLE/Vulkan fallback when hardware acceleration is still on and
    // either (a) the user has crashed once already, or (b) the system has a
    // hybrid GPU configuration that historically picks the wrong driver. The
    // existing `ozone-platform-hint=auto` is sufficient — no explicit
    // `ozone-platform=wayland` switch is needed.
    if (!gpuHardwareAccelerationDisabled) {
      const shouldApplyAngleFallback = gpuAngleFallbackActive || isLinuxWaylandHybridGpu();
      if (shouldApplyAngleFallback) {
        app.commandLine.appendSwitch("use-angle", "vulkan");
        app.commandLine.appendSwitch("use-cmd-decoder", "passthrough");
        app.commandLine.appendSwitch("ignore-gpu-blocklist");
        console.log(
          `[GPU] Applied ANGLE/Vulkan fallback (reason=${
            gpuAngleFallbackActive ? "crash-flag" : "hybrid-detected"
          })`
        );
      }
    }
  }
}

app.commandLine.appendSwitch("enable-features", enabledFeatures.join(","));

// Raise GPU tile memory budget to keep Retina/multi-panel rendering from exhausting Chromium's default cap.
// Scales with system RAM: ≤8 GiB → 768 MB, >8 and ≤16 GiB → 1024 MB, >16 GiB → 2048 MB.
// Must run before app.whenReady(), so only synchronous APIs are available.
function getGpuTileMemoryCapMb(): string {
  const totalMem = os.totalmem();
  if (totalMem <= 8 * 1024 ** 3) return "768";
  if (totalMem <= 16 * 1024 ** 3) return "1024";
  return "2048";
}

app.commandLine.appendSwitch("force-gpu-mem-available-mb", getGpuTileMemoryCapMb());

// Lift Chromium's default 16-active-WebGL-context per-renderer ceiling so the
// terminal pool can keep more xterm panes on the WebGL renderer before the
// whole-fleet flip drops them to DOM. Scales with system RAM on the same tiers
// as the tile-memory budget above (24/28/32). Each xterm WebGL context is small
// (no 3D geometry, no MSAA) so this headroom is safe within the raised tile
// budget. Memory-pressure context loss is still possible at the OS/GPU-budget
// level (Chromium 465176577) — the existing TerminalWebGLManager circuit breaker
// handles that path independently.
//
// getMaxWebGLContextCeiling is the single source of truth: the resource-profile
// fleet-flip thresholds derive from the same function so the raised cap and the
// thresholds guarding it can never drift apart (#11192).
app.commandLine.appendSwitch("max-active-webgl-contexts", String(getMaxWebGLContextCeiling()));

if (process.platform === "win32") {
  const current = process.env.PATH || "";
  const augmented = applyWindowsExtraPaths(current);
  if (augmented !== current) {
    process.env.PATH = augmented;
  }
}

// Bumped from 8s to 10s to match the markered shell-probe budget specified
// in #6063. The common case is ~50ms; the timeout exists purely to bound
// worst-case hangs. If the shell call still times out, refreshPath()
// falls back to getUnixFallbackPaths() so CLIs installed via
// mise/asdf/Volta are still discoverable.
const REFRESH_TIMEOUT_MS = 10_000;
const SHELL_PROBE_KILL_GRACE_MS = 500;

// Module-level singleton: caches the in-flight or successful probe Promise
// so concurrent refreshPath() calls don't spawn duplicate shells. On a null
// (failed) result we clear the cache to allow a future retry — caching a
// transient failure for the entire session is worse than the bounded cost
// of one extra probe.
let shellProbePromise: Promise<string | null> | null = null;

function mergePath(preferred: string, inherited: string | undefined): string {
  return deduplicatePath(
    inherited ? `${preferred}${path.delimiter}${inherited}` : preferred,
    false
  );
}
/**
 * Fallback shim/bin directories to add to PATH on macOS/Linux when the
 * shell-env probe fails or times out. Each candidate is gated by
 * `existsSync` so we never prepend nonexistent directories.
 *
 * Rationale: Electron apps launched from Finder/dock inherit a minimal
 * PATH that excludes user-level version managers (mise/asdf/Volta) and the
 * native Claude installer bin dir. The shell-env probe covers the common
 * case, but corporate `.zshrc` files can hang shell-env past the timeout.
 * Without this fallback those users would see every CLI as "missing".
 */
export function getUnixFallbackPaths(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];

  // mise — env var override, then the standard location.
  const miseData = process.env["MISE_DATA_DIR"];
  candidates.push(
    miseData ? path.join(miseData, "shims") : path.join(home, ".local/share/mise/shims")
  );

  // asdf — env var override, then the standard location.
  const asdfData = process.env["ASDF_DATA_DIR"];
  candidates.push(asdfData ? path.join(asdfData, "shims") : path.join(home, ".asdf/shims"));

  // Volta — env var override, then the standard location.
  const voltaHome = process.env["VOLTA_HOME"];
  candidates.push(voltaHome ? path.join(voltaHome, "bin") : path.join(home, ".volta/bin"));

  // pnpm — env var override, then the platform-default bin dir. pnpm's
  // installer writes the bin dir path directly (no `bin/` suffix).
  const pnpmHome = process.env["PNPM_HOME"];
  if (pnpmHome) {
    candidates.push(pnpmHome);
  } else {
    candidates.push(
      process.platform === "darwin"
        ? path.join(home, "Library/pnpm")
        : path.join(home, ".local/share/pnpm")
    );
  }

  // Nix — user profile (single-user + home-manager) and system default profile.
  candidates.push(path.join(home, ".nix-profile/bin"));
  candidates.push("/nix/var/nix/profiles/default/bin");

  // Homebrew — Apple Silicon (ARM64) default prefix. Intel Homebrew lives
  // at /usr/local/bin which is usually already on PATH.
  candidates.push("/opt/homebrew/bin");

  // User-local bin — catches Anthropic's native installer for Claude
  // (~/.local/bin/claude) and other user-level installs.
  candidates.push(path.join(home, ".local/bin"));

  return candidates.filter((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
}

function applyUnixFallbackPaths(currentPath: string): string {
  const extraPaths = getUnixFallbackPaths();
  const existingEntries = currentPath.split(path.delimiter);
  const missing = extraPaths.filter((p) => !existingEntries.includes(p));
  return missing.length ? [...missing, currentPath].join(path.delimiter) : currentPath;
}

function parseMarkeredPath(stdout: string, marker: string): string | null {
  // Non-greedy quantifier so the first balanced marker pair wins. With a
  // 32-hex-char random marker a collision is astronomically improbable,
  // but the lazy match is structurally clearer than relying on uniqueness.
  const regex = new RegExp(marker + "([\\s\\S]+?)" + marker);
  const match = regex.exec(stdout);
  if (!match) return null;
  try {
    const env = JSON.parse(match[1]) as Record<string, unknown>;
    if (typeof env.PATH === "string" && env.PATH.trim().length > 0) {
      return env.PATH;
    }
    return null;
  } catch {
    return null;
  }
}

// Spawn $SHELL -i -l -c '<probe>' where <probe> brackets a JSON dump of
// process.env between random hex markers. Parsing only what's between the
// markers ignores prompt-tool noise (Powerlevel10k instant prompt,
// oh-my-zsh update messages, fortune banners, motd output). Sets
// DAINTREE_RESOLVING_ENVIRONMENT=1 in the child env so users can guard
// slow .zshrc sections. Mirrors VS Code's getUnixShellEnvironment.
function runShellProbe(): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let termTimer: NodeJS.Timeout | undefined = undefined;
    let killTimer: NodeJS.Timeout | undefined = undefined;

    const settle = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      if (termTimer !== undefined) clearTimeout(termTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(value);
    };

    const shell = process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    const marker = randomBytes(16).toString("hex");
    // process.execPath is the Electron binary; ELECTRON_RUN_AS_NODE=1 in the
    // child env makes it act as plain Node so we don't depend on `node`
    // being on the user's PATH.
    const probeCmd = `printf '%s' "${marker}"; "${process.execPath}" -e 'process.stdout.write(JSON.stringify(process.env))'; printf '%s' "${marker}"`;

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DAINTREE_RESOLVING_ENVIRONMENT: "1",
      ELECTRON_RUN_AS_NODE: "1",
    };

    let child: ReturnType<typeof spawn>;
    try {
      // stderr is intentionally ignored: a noisy oh-my-zsh/.zshrc can write
      // tens of KB to stderr (update banners, compliance scripts), and a
      // piped-but-undrained stderr would block the child once the OS pipe
      // buffer fills — preventing the marker probe from ever reaching its
      // closing printf and forcing a guaranteed timeout. Mirrors VS Code's
      // getUnixShellEnvironment.
      child = spawn(shell, ["-i", "-l", "-c", probeCmd], {
        stdio: ["ignore", "pipe", "ignore"],
        env: childEnv,
      });
    } catch (err) {
      console.warn(
        "[refreshPath] shell probe spawn failed:",
        // eslint-disable-next-line no-restricted-syntax -- diagnostic console.warn passes the raw error if not an Error; not a user-visible string.
        err instanceof Error ? err.message : err
      );
      settle(null);
      return;
    }

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString();
    });
    child.on("error", (err: Error) => {
      console.warn("[refreshPath] shell probe error:", err.message);
      settle(null);
    });
    child.on("close", () => {
      settle(parseMarkeredPath(stdout, marker));
    });

    termTimer = setTimeout(() => {
      console.warn(
        "[refreshPath] Shell probe timed out after",
        REFRESH_TIMEOUT_MS,
        "ms — sending SIGTERM"
      );
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore kill errors — the close handler or kill timer below will settle
      }
    }, REFRESH_TIMEOUT_MS);

    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore — process may already be gone
      }
      settle(null);
    }, REFRESH_TIMEOUT_MS + SHELL_PROBE_KILL_GRACE_MS);
  });
}

function resolvePathViaShellProbe(): Promise<string | null> {
  if (shellProbePromise) return shellProbePromise;

  const probe = runShellProbe();
  shellProbePromise = probe;

  // Clear the singleton on null/rejection so a subsequent refreshPath() can retry.
  probe
    .then((result) => {
      if (result === null && shellProbePromise === probe) {
        shellProbePromise = null;
      }
    })
    .catch(() => {
      if (shellProbePromise === probe) {
        shellProbePromise = null;
      }
    });

  return probe;
}

// Module-level singleton for the outer refreshPath() Promise. Concurrent
// callers (the early kick-off, CliAvailabilityService, SystemHealthCheck)
// all share one in-flight refresh — without this the inner shellProbePromise
// dedup helps but Promise.race + timeout state is still per-call. Cleared on
// settlement so a subsequent caller can retry after a transient failure.
let pathRefreshPromise: Promise<void> | null = null;

export async function refreshPath(): Promise<void> {
  if (pathRefreshPromise) return pathRefreshPromise;

  const promise = runRefreshPath();
  pathRefreshPromise = promise;
  promise.finally(() => {
    if (pathRefreshPromise === promise) {
      pathRefreshPromise = null;
    }
  });
  return promise;
}

async function runRefreshPath(): Promise<void> {
  let timeoutId: NodeJS.Timeout | undefined;
  let shellEnvFailed = false;
  // Guards against late inner-IIFE writes to process.env.PATH after the
  // outer race has already resolved with "timeout". Without this guard a
  // shell that closes during the SIGTERM→SIGKILL grace window can clobber
  // the fallback-augmented PATH that the post-race block has already set.
  let timedOut = false;
  try {
    const result = await Promise.race([
      (async () => {
        if (process.platform === "win32") {
          // Registry read + shim-dir merge live in the dependency-free
          // `windowsPath.ts` leaf so the terminal spawn path can re-run them
          // per pane without importing this module's startup machinery
          // (#11773). Its single-flight is shared, so a spawn refresh landing
          // mid-startup joins this read instead of racing a second `reg.exe`.
          const resolved = await resolveWindowsRegistryPath();
          if (!resolved || timedOut) return;
          process.env.PATH = resolved;
        } else if (process.env.DAINTREE_SHELL_PROBE === "1") {
          // Opt-in markered shell-probe path (#6063). Replaces shell-env
          // with a real `$SHELL -i -l -c` invocation so lazy-loaded version
          // managers (mise/asdf), eval-based activations (pyenv/rbenv,
          // `eval "$(tool init)"`), and non-bashrc layouts (fnm, pnpm)
          // are visible. Gated behind the flag so we can dogfood for one
          // release before flipping the default.
          const probedPath = await resolvePathViaShellProbe();
          if (timedOut) return;
          if (probedPath) {
            process.env.PATH = mergePath(probedPath, process.env.PATH);
          } else {
            shellEnvFailed = true;
          }
        } else {
          try {
            const { shellEnv } = (await import("shell-env")) as {
              shellEnv: () => Promise<Record<string, string>>;
            };
            const env = await shellEnv();
            if (timedOut) return;
            if (env.PATH) {
              process.env.PATH = mergePath(env.PATH, process.env.PATH);
            }
          } catch (err) {
            // shell-env can throw when the user's shell profile errors out
            // (e.g. broken .zshrc, missing sourced file). Previously this
            // was swallowed silently, leaving the Electron process with an
            // unexpanded PATH and no diagnostic. Log the failure so the
            // fallback path below is correlated with the root cause.
            shellEnvFailed = true;
            console.warn(
              "[refreshPath] shell-env failed:",
              // eslint-disable-next-line no-restricted-syntax -- diagnostic console.warn passes the raw error if not an Error; not a user-visible string.
              err instanceof Error ? err.message : err
            );
          }
        }
      })(),
      new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          resolve("timeout");
        }, REFRESH_TIMEOUT_MS);
      }),
    ]);

    if (result === "timeout") {
      console.warn("[refreshPath] Timed out after", REFRESH_TIMEOUT_MS, "ms — using existing PATH");
    }

    // On macOS/Linux, when shell-env fails or times out we still want the
    // native installer bin dir (~/.local/bin) and common version-manager
    // shims (mise/asdf/Volta) on PATH so downstream CLI probes can find
    // binaries installed via those tools. The common case (shell-env
    // succeeded) also benefits — shell profile may have been activated
    // but the user's version manager shim dirs may not be in the PATH
    // it exported.
    if (
      process.platform !== "win32" &&
      (result === "timeout" || shellEnvFailed || process.env.PATH)
    ) {
      const current = process.env.PATH || "";
      const augmented = applyUnixFallbackPaths(current);
      if (augmented !== current) {
        process.env.PATH = deduplicatePath(augmented, false);
      }
    }
  } catch {
    // Fallback to current PATH silently
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// One-shot startup gate: kicked off as the first async work in
// app.whenReady() so the shell probe runs concurrently with the rest of
// startup. The PtyClient creation site awaits this before spawning the PTY
// host so node-pty sees the user's full PATH. Unlike `pathRefreshPromise`,
// this stays set after settlement — awaiting a settled Promise is a no-op,
// and second-window startup must not trigger a fresh shell probe.
let earlyPathRefreshPromise: Promise<void> | null = null;

export function kickOffEarlyPathRefresh(): Promise<void> {
  if (earlyPathRefreshPromise) return earlyPathRefreshPromise;
  earlyPathRefreshPromise = refreshPath();
  return earlyPathRefreshPromise;
}

export function getEarlyPathRefreshPromise(): Promise<void> | null {
  return earlyPathRefreshPromise;
}

// Re-exported from the lightweight runtimeFlags module so existing importers
// keep working; consumers that don't need the rest of environment.ts (e.g.
// ProjectViewManager) should import from ./runtimeFlags.js directly. Imported
// as local bindings (not a bare `export ... from`) because environment.ts uses
// isSmokeTest internally below.
export { isDemoMode, isSmokeTest, smokeTestStart };

// Same deal for the Windows PATH helpers, which moved to ./windowsPath.js so
// the terminal spawn path can reach them without this module's `app.*` and
// SQLite module-scope work. A bare re-export because nothing here uses it.
export { expandWindowsEnvVars } from "./windowsPath.js";

if (isSmokeTest) {
  console.error("[SMOKE] Smoke test mode enabled");
  console.error("[SMOKE] Platform:", process.platform, process.arch);
  console.error("[SMOKE] Electron:", process.versions.electron);
  console.error("[SMOKE] Node:", process.versions.node);
  console.error("[SMOKE] Chrome:", process.versions.chrome);

  // Fail fast on renderer or child process crashes
  app.on("render-process-gone", (_event, _wc, details) => {
    if (details.reason !== "clean-exit") {
      console.error(
        `[SMOKE] FAILED — renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`
      );
      app.exit(1);
    }
  });
  app.on("child-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") {
      console.error(
        `[SMOKE] FAILED — child process gone: type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}`
      );
      if (details.type === "GPU" || details.type === "Utility") {
        app.exit(1);
      }
    }
  });

  // Verify native module (node-pty) loads and bindings work
  try {
    const pty = await import("node-pty");
    const testProc = pty.spawn(process.platform === "win32" ? "cmd.exe" : "echo", ["smoke"], {
      cols: 80,
      rows: 24,
    });
    testProc.kill();
    console.error("[SMOKE] CHECK: node-pty native module — OK");
  } catch (err) {
    console.error("[SMOKE] FAILED — node-pty native module:", (err as Error).message);
    app.exit(1);
  }

  // Verify better-sqlite3 loads and can execute queries
  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    const row = db.prepare("SELECT 1 AS n").get() as { n: number };
    db.close();
    if (row?.n !== 1) throw new Error("unexpected query result");
    console.error("[SMOKE] CHECK: better-sqlite3 native module — OK");
  } catch (err) {
    console.error("[SMOKE] FAILED — better-sqlite3 native module:", (err as Error).message);
    app.exit(1);
  }

  // Surface the help-session crash-safe reaping native modules (#7526 Windows /
  // #8769 POSIX). Neither is required for app start — a load failure only
  // disables crash-safe PTY tree reaping — so these are WARN-level, never a
  // fatal exit. require() (not await import) mirrors HelpSessionJobService's
  // load path exactly and avoids a missing-type-declaration error for these
  // untyped vendored addons. This is a runtime presence check (isAvailable);
  // the deeper build-time exec/dlopen probe that catches a present-but-broken
  // binary (missing DLL, wrong arch) lives in scripts/afterPack.cjs.
  if (process.platform === "win32") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const winJobObject = require("win-job-object") as {
        isAvailable: () => boolean;
        getLoadError: () => unknown;
      };
      if (winJobObject.isAvailable()) {
        console.error("[SMOKE] CHECK: win-job-object native module — OK");
      } else {
        const msg = formatErrorMessage(winJobObject.getLoadError(), "unknown error");
        console.error(`[SMOKE] WARN — win-job-object unavailable: ${msg}`);
      }
    } catch (err) {
      console.error("[SMOKE] WARN — win-job-object load failed:", (err as Error).message);
    }
  } else {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const posixReaper = require("posix-pty-reaper") as {
        isAvailable: () => boolean;
        getSupervisorPath: () => string | null;
      };
      if (posixReaper.isAvailable()) {
        console.error("[SMOKE] CHECK: posix-pty-reaper supervisor — OK");
      } else {
        console.error(
          "[SMOKE] WARN — posix-pty-reaper supervisor binary not found or not executable"
        );
      }
    } catch (err) {
      console.error("[SMOKE] WARN — posix-pty-reaper load failed:", (err as Error).message);
    }
  }
}

// macOS `open-file` handler (#9293) — fires when the user double-clicks a
// `.dntr` plugin archive in Finder or picks "Open With → Daintree". This file
// is imported on the first line of main.ts, so the listener is registered
// synchronously at module load — before `app.whenReady()` resolves. That
// timing matters: on a cold launch the OS delivers `open-file` during early
// startup, and a listener registered later (e.g. inside the whenReady chain)
// would miss it. Paths that arrive before PluginService exists are queued;
// `activateOpenFileInstaller` (./openFileInstall.ts) drains the queue and
// takes over live events once the service is ready. macOS-only — `open-file`
// never fires on Windows/Linux.
const _pendingOpenFilePaths: string[] = [];
let _openFileConsumer: ((filePath: string) => void) | null = null;

// Directories dropped on the Dock icon / picked via "Open With" open as
// projects (#10976), not as `.dntr` plugin archives. They need a live window
// for `handleDirectoryOpen`, so they get a separate queue + consumer drained
// at window-creation time (mirroring `pendingCliPath`), independent of the
// `.dntr` plugin drain in `activateOpenFileInstaller`.
const _pendingOpenDirPaths: string[] = [];
let _openDirConsumer: ((dirPath: string) => void) | null = null;

/** Snapshot (copy) of paths queued before the installer was activated. */
export function getPendingOpenFilePaths(): string[] {
  return [..._pendingOpenFilePaths];
}

export function clearPendingOpenFilePaths(): void {
  _pendingOpenFilePaths.length = 0;
}

/**
 * Install the live `open-file` consumer. Once set, incoming paths route
 * directly to it instead of the pre-ready queue. Pass `null` to detach.
 */
export function setOpenFileConsumer(consumer: ((filePath: string) => void) | null): void {
  _openFileConsumer = consumer;
}

/** Snapshot (copy) of directories queued before a window existed to open them. */
export function getPendingOpenDirPaths(): string[] {
  return [..._pendingOpenDirPaths];
}

export function clearPendingOpenDirPaths(): void {
  _pendingOpenDirPaths.length = 0;
}

/**
 * Install the live directory consumer for `open-file` folder drops. Once set,
 * incoming folders route to it instead of the pre-window queue. Pass `null` to
 * detach.
 */
export function setOpenDirConsumer(consumer: ((dirPath: string) => void) | null): void {
  _openDirConsumer = consumer;
}

/** Re-queue a directory the live consumer had no window for; dedupes bursts. */
export function queuePendingOpenDirPath(dirPath: string): void {
  if (!_pendingOpenDirPaths.includes(dirPath)) {
    _pendingOpenDirPaths.push(dirPath);
  }
}

if (process.platform === "darwin") {
  app.on("open-file", (event, filePath) => {
    // Required: without preventDefault, Chromium's default handling may try to
    // navigate the focused window to the file path.
    event.preventDefault();
    // Folders branch off before any consumer sees the path so the plugin
    // installer never receives a directory (#10976). A stat failure (missing
    // path) leaves isDirectory false → file route, preserving `.dntr` error surfacing.
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(filePath).isDirectory();
    } catch {
      // Missing path or stat failure — isDirectory stays false.
    }
    if (isDirectory) {
      if (_openDirConsumer) {
        _openDirConsumer(filePath);
      } else {
        queuePendingOpenDirPath(filePath);
      }
    } else if (_openFileConsumer) {
      _openFileConsumer(filePath);
    } else if (!_pendingOpenFilePaths.includes(filePath)) {
      // Dedup: a burst of `open -a Daintree same.dntr` before activation
      // shouldn't queue N copies and trigger N redundant reinstalls.
      _pendingOpenFilePaths.push(filePath);
    }
  });
}

app.enableSandbox();

// Prevent macOS keychain prompt ("Daintree Safe Storage").
// Chromium encrypts cookies/network state via the OS keychain by default.
// We don't rely on Chromium cookie encryption — all secrets are in electron-store.
app.commandLine.appendSwitch("use-mock-keychain");
