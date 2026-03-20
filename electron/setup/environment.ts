import nodeV8 from "node:v8";
import vm from "node:vm";
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
  (globalThis as Record<string, unknown>).__canopy_gc = exposeGc;
} catch {
  // GC exposure not available — non-critical
}

// Prefer compact code over raw speed — main process is I/O-bound
try {
  nodeV8.setFlagsFromString("--optimize_for_size");
} catch {
  // Non-critical — app works without this optimization
}

fixPath();

// In development, use a separate userData directory so the dev instance
// doesn't conflict with the production app's single-instance lock or storage.
// Skip when --user-data-dir is explicitly set (e.g. E2E tests) so that
// each test run gets its own isolated data directory.
const hasExplicitUserDataDir = process.argv.some((a) => a.startsWith("--user-data-dir"));
if (!app.isPackaged && !hasExplicitUserDataDir) {
  app.setPath("userData", path.join(app.getPath("appData"), `${app.name}-dev`));
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
  process.argv.includes("--reset-data") || process.env.CANOPY_RESET_DATA === "1";
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

// Enable native Wayland support on Linux (Electron < 38)
// Electron 38+ auto-detects via XDG_SESSION_TYPE; this flag is ignored.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  if (process.env.XDG_SESSION_TYPE === "wayland") {
    app.commandLine.appendSwitch("enable-features", "WaylandWindowDecorations");
    app.commandLine.appendSwitch("enable-wayland-ime");
  }
}

if (process.platform === "win32") {
  const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const chocoInstall = process.env["ChocolateyInstall"] || "C:\\ProgramData\\chocolatey";

  const extraPaths = [
    path.join(os.homedir(), "AppData", "Local", "Programs", "Git", "cmd"),
    path.join(programFiles, "Git", "cmd"),
    path.join(programFilesX86, "Git", "cmd"),
    path.join(os.homedir(), "scoop", "shims"),
    path.join(chocoInstall, "bin"),
  ];
  const current = process.env.PATH || "";
  const existingEntries = current.split(path.delimiter).map((e) => e.toLowerCase());
  const missing = extraPaths.filter(
    (p) => !existingEntries.includes(p.toLowerCase()) && existsSync(p)
  );
  if (missing.length) {
    process.env.PATH = [...missing, current].join(path.delimiter);
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
}

app.enableSandbox();

// Prevent macOS keychain prompt ("canopy-app Safe Storage").
// Chromium encrypts cookies/network state via the OS keychain by default.
// We don't rely on Chromium cookie encryption — all secrets are in electron-store.
app.commandLine.appendSwitch("use-mock-keychain");
