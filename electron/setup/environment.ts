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
import { execFile, spawn } from "child_process";
import { randomBytes } from "crypto";
import { app } from "electron";
import path from "path";
import fs from "fs";
import { existsSync } from "fs";
import os from "os";
import fixPath from "fix-path";
import { isLinuxWaylandHybridGpu } from "../utils/gpuDetection.js";

export let exposeGc: (() => void) | undefined;
try {
  nodeV8.setFlagsFromString("--expose_gc");
  exposeGc = vm.runInNewContext("gc") as () => void;
  (globalThis as Record<string, unknown>).__daintree_gc = exposeGc;
} catch {
  // GC exposure not available — non-critical
}

if (app.isPackaged) {
  fixPath();
}

// In development, use a separate userData directory so the dev instance
// doesn't conflict with the production app's single-instance lock or storage.
// Skip when --user-data-dir is explicitly set (e.g. E2E tests) so that
// each test run gets its own isolated data directory.
const hasExplicitUserDataDir = process.argv.some((a) => a.startsWith("--user-data-dir"));
if (!app.isPackaged && !hasExplicitUserDataDir) {
  // Keep dev data separate per variant so `BUILD_VARIANT=canopy npm run dev`
  // doesn't collide with the default Daintree dev instance.
  const devDirName = process.env.BUILD_VARIANT === "canopy" ? "canopy-app-dev" : "daintree-dev";
  app.setPath("userData", path.join(app.getPath("appData"), devDirName));
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

// GPU crash fallback: disable hardware acceleration before app.whenReady()
// This flag is written by GpuCrashMonitorService after repeated GPU crashes.
const gpuFlagPath = path.join(app.getPath("userData"), "gpu-disabled.flag");
export const gpuHardwareAccelerationDisabled = fs.existsSync(gpuFlagPath);
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

if (process.platform === "win32") {
  const extraPaths = getWindowsExtraPaths();
  const current = process.env.PATH || "";
  const existingEntries = current.split(path.delimiter).map((e) => e.toLowerCase());
  const missing = extraPaths.filter(
    (p) => !existingEntries.includes(p.toLowerCase()) && existsSync(p)
  );
  if (missing.length) {
    process.env.PATH = [...missing, current].join(path.delimiter);
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

function deduplicatePath(pathStr: string, caseInsensitive: boolean): string {
  const entries = pathStr.split(path.delimiter).filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entry of entries) {
    const key = caseInsensitive ? entry.toLowerCase() : entry;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(entry);
    }
  }
  return unique.join(path.delimiter);
}

export function expandWindowsEnvVars(str: string): string {
  return str.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match);
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

function getWindowsExtraPaths(): string[] {
  const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const chocoInstall = process.env["ChocolateyInstall"] || "C:\\ProgramData\\chocolatey";
  const home = os.homedir();

  const paths = [
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, "AppData", "Local", "Programs", "Git", "cmd"),
    path.join(programFiles, "Git", "cmd"),
    path.join(programFilesX86, "Git", "cmd"),
    path.join(home, "scoop", "shims"),
    path.join(chocoInstall, "bin"),
  ];

  // Volta: env var first, hardcoded fallback
  if (process.env["VOLTA_HOME"]) {
    paths.push(path.join(process.env["VOLTA_HOME"], "bin"));
  } else {
    paths.push(path.join(home, "AppData", "Local", "Volta", "bin"));
  }

  // pnpm: env var only
  if (process.env["PNPM_HOME"]) {
    paths.push(process.env["PNPM_HOME"]);
  }

  // fnm: env var only (dynamic per session)
  if (process.env["FNM_MULTISHELL_PATH"]) {
    paths.push(process.env["FNM_MULTISHELL_PATH"]);
  }

  // nvm-windows: env var only
  if (process.env["NVM_SYMLINK"]) {
    paths.push(process.env["NVM_SYMLINK"]);
  }

  return paths;
}

function readWindowsRegistryPath(): Promise<string> {
  const keys = [
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    "HKCU\\Environment",
  ];

  return Promise.all(
    keys.map(
      (key) =>
        new Promise<string>((resolve) => {
          execFile("reg", ["query", key, "/v", "Path"], { timeout: 3_000 }, (err, stdout) => {
            if (err || !stdout) return resolve("");
            const match = stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
            resolve(expandWindowsEnvVars(match?.[1]?.trim() ?? ""));
          });
        })
    )
  ).then((paths) => paths.filter(Boolean).join(path.delimiter));
}

function applyWindowsExtraPaths(currentPath: string): string {
  const extraPaths = getWindowsExtraPaths();
  const existingEntries = currentPath.split(path.delimiter).map((e) => e.toLowerCase());
  const missing = extraPaths.filter(
    (p) => !existingEntries.includes(p.toLowerCase()) && existsSync(p)
  );

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

export async function refreshPath(): Promise<void> {
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
          const registryPath = await readWindowsRegistryPath();
          if (!registryPath || timedOut) return;
          const withExtras = applyWindowsExtraPaths(registryPath);
          process.env.PATH = deduplicatePath(withExtras, true);
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
            process.env.PATH = deduplicatePath(probedPath, false);
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
              process.env.PATH = deduplicatePath(env.PATH, false);
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

export const isDemoMode = !app.isPackaged && process.argv.includes("--demo-mode");
export const isSmokeTest = process.argv.includes("--smoke-test");
export const smokeTestStart = isSmokeTest ? Date.now() : 0;

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
}

app.enableSandbox();

// Prevent macOS keychain prompt ("Daintree Safe Storage").
// Chromium encrypts cookies/network state via the OS keychain by default.
// We don't rely on Chromium cookie encryption — all secrets are in electron-store.
app.commandLine.appendSwitch("use-mock-keychain");
