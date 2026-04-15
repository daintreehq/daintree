// Silence EPIPE errors on stdout/stderr. When the parent terminal is closed
// (e.g. user quits Terminal.app while Canopy runs), writes to the broken pipe
// throw an uncaught EPIPE that would crash the main process. These are harmless.
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === "function") {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") return;
      throw err;
    });
  }
}

import nodeV8 from "node:v8";
import vm from "node:vm";
import { execFile } from "child_process";
import { app } from "electron";
import path from "path";
import fs from "fs";
import { existsSync } from "fs";
import os from "os";
import fixPath from "fix-path";

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
  app.setPath("userData", path.join(app.getPath("appData"), "canopy-app-dev"));
}

// GPU crash fallback: disable hardware acceleration before app.whenReady()
// This flag is written by GpuCrashMonitorService after repeated GPU crashes.
const gpuFlagPath = path.join(app.getPath("userData"), "gpu-disabled.flag");
export const gpuHardwareAccelerationDisabled = fs.existsSync(gpuFlagPath);
if (gpuHardwareAccelerationDisabled) {
  app.disableHardwareAcceleration();
  console.log("[GPU] Hardware acceleration disabled by crash fallback flag");
}

// Handle --reset-data: wipe userData before Chromium acquires file locks
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

// Chromium feature flags: memory reclamation + platform-specific features
const enabledFeatures = ["PartitionAllocMemoryReclaimer"];

// Enable native Wayland support on Linux (Electron < 38)
// Electron 38+ auto-detects via XDG_SESSION_TYPE; this flag is ignored.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  if (process.env.XDG_SESSION_TYPE === "wayland") {
    enabledFeatures.push("WaylandWindowDecorations");
    app.commandLine.appendSwitch("enable-wayland-ime");
  }
}

app.commandLine.appendSwitch("enable-features", enabledFeatures.join(","));

// Cap GPU tile memory budget and disable MSAA to reduce VRAM usage
app.commandLine.appendSwitch("force-gpu-mem-available-mb", "512");
app.commandLine.appendSwitch("gpu-rasterization-msaa-sample-count", "0");

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

const REFRESH_TIMEOUT_MS = 5_000;

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

function expandWindowsEnvVars(str: string): string {
  return str.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match);
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

export async function refreshPath(): Promise<void> {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      (async () => {
        if (process.platform === "win32") {
          const registryPath = await readWindowsRegistryPath();
          if (!registryPath) return;
          const withExtras = applyWindowsExtraPaths(registryPath);
          process.env.PATH = deduplicatePath(withExtras, true);
        } else {
          const { shellEnv } = (await import("shell-env")) as {
            shellEnv: () => Promise<Record<string, string>>;
          };
          const env = await shellEnv();
          if (env.PATH) {
            process.env.PATH = deduplicatePath(env.PATH, false);
          }
        }
      })(),
      new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), REFRESH_TIMEOUT_MS);
      }),
    ]);

    if (result === "timeout") {
      console.warn("[refreshPath] Timed out after", REFRESH_TIMEOUT_MS, "ms — using existing PATH");
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

// Prevent macOS keychain prompt ("canopy-app Safe Storage").
// Chromium encrypts cookies/network state via the OS keychain by default.
// We don't rely on Chromium cookie encryption — all secrets are in electron-store.
app.commandLine.appendSwitch("use-mock-keychain");
