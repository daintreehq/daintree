import { app, BrowserWindow } from "electron";
import type { CliAvailabilityService } from "../services/CliAvailabilityService.js";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import { handleDirectoryOpen } from "../menu.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { setSignalShutdown } from "./signalShutdownState.js";
import { isWindowRecreating } from "./windowRecreationState.js";
import { CLEANUP_TIMEOUT_MS } from "./shutdownConfig.js";

let pendingCliPath: string | null = null;

export function getPendingCliPath(): string | null {
  return pendingCliPath;
}

export function setPendingCliPath(p: string | null): void {
  pendingCliPath = p;
}

export function extractCliPath(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cli-path" && argv[i + 1]) {
      return argv[i + 1];
    }
    if (argv[i].startsWith("--cli-path=")) {
      return argv[i].slice("--cli-path=".length);
    }
  }
  return null;
}

export interface AppLifecycleOptions {
  onCreateWindow: () => void | Promise<void>;
  onCreateWindowForPath?: (cliPath: string) => void | Promise<void>;
  getMainWindow: () => BrowserWindow | null;
  getCliAvailabilityService: () => CliAvailabilityService | null;
  windowRegistry?: WindowRegistry;
}

export function registerAppLifecycleHandlers(opts: AppLifecycleOptions): void {
  // Initialize crash recovery only in the winning instance
  getCrashRecoveryService();

  // Graceful shutdown on OS signals (macOS/Linux SIGTERM/SIGINT, Windows Ctrl+C,
  // plus SIGUSR2 — nodemon's restart signal in dev, and SIGHUP — terminal-close
  // in dev). Triggers `before-quit` via `app.quit()` so the shutdown handler
  // runs the full cleanup chain, including `CrashLoopGuard.markCleanExit()`.
  // Without the SIGUSR2 entry, every nodemon restart bypassed `before-quit` and
  // CrashLoopGuard counted it as a crash — after three rebuilds in a minute the
  // dev app booted into safe mode for no reason. SIGHUP gets the same treatment
  // for the same reason: closing the dev terminal sends SIGHUP and would
  // otherwise terminate the process without the markCleanExit call.
  //
  // The safety-belt timer must outlast `CLEANUP_TIMEOUT_MS` so it doesn't fire
  // mid-cleanup; the 3000ms buffer covers `closeTelemetry()` which can take up
  // to ~2500ms in the worst case (Sentry init-wait cap 500ms + close timeout
  // 2000ms — see TelemetryService.ts) and runs after the cleanup race resolves.
  // A second signal within 2000ms force-exits with status 1 — escape hatch
  // when shutdown stalls. After that window, repeat signals are ignored
  // (cleanup is already in progress).
  //
  // SIGHUP is dev-only: packaged builds are TTY-detached, and process managers
  // (launchd/systemd) conventionally use SIGHUP to mean "reload config" — we
  // shouldn't intercept that. On Windows, `taskkill /F` (TerminateProcess)
  // bypasses all Node.js shutdown hooks; that case is handled by
  // CrashRecoveryService on next startup.
  let firstSignalTime: number | null = null;
  const signalHandler = () => {
    if (firstSignalTime !== null) {
      if (Date.now() - firstSignalTime < 2000) {
        process.exit(1);
      }
      return;
    }
    firstSignalTime = Date.now();
    setSignalShutdown();
    setTimeout(() => process.exit(0), CLEANUP_TIMEOUT_MS + 3000).unref();
    app.quit();
  };
  process.on("SIGTERM", signalHandler);
  process.on("SIGINT", signalHandler);
  process.on("SIGUSR2", signalHandler);
  if (!app.isPackaged) {
    process.on("SIGHUP", signalHandler);
  }

  app.on("second-instance", (_event, commandLine, _workingDirectory) => {
    console.log("[MAIN] Second instance detected");
    const mainWindow = opts.windowRegistry?.getPrimary()?.browserWindow ?? opts.getMainWindow();
    const cliPath = extractCliPath(commandLine);

    if (cliPath) {
      if (mainWindow && !mainWindow.isDestroyed() && opts.onCreateWindowForPath) {
        console.log("[MAIN] Creating new window for CLI path:", cliPath);
        opts.onCreateWindowForPath(cliPath);
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        console.log("[MAIN] Opening CLI path in existing window:", cliPath);
        handleDirectoryOpen(
          cliPath,
          mainWindow,
          opts.getCliAvailabilityService() ?? undefined
        ).catch((err) => console.error("[MAIN] Failed to open CLI path:", err));
      } else {
        pendingCliPath = cliPath;
        console.log("[MAIN] Queuing CLI path for when window is ready:", cliPath);
      }
    } else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on("window-all-closed", () => {
    // `BrowserWindow.destroy()` in the OOM recreate path synchronously emits
    // `window-all-closed` before the replacement window registers. On
    // non-darwin this would call `app.quit()` mid-recreate; the flag suppresses
    // that until the recreation settles. See `windowRecreationState.ts`.
    if (isWindowRecreating()) return;
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    const hasWindows = opts.windowRegistry
      ? opts.windowRegistry.size > 0
      : BrowserWindow.getAllWindows().length > 0;
    if (!hasWindows) {
      opts.onCreateWindow();
    }
  });
}

// Windows-only: route `WM_ENDSESSION` (planned shutdown, logoff, restart,
// Windows Update reboot, Fast Startup) through the same `before-quit` cleanup
// chain as the signal path. Without this, Windows tears the process down
// directly and `running.lock` stays on disk — the next launch then thinks we
// crashed. Best-effort: the OS `HungAppTimeout` is 5s by default and the
// full cleanup chain (`CLEANUP_TIMEOUT_MS` + safety belt) exceeds that, so
// cleanup may be truncated mid-flight. The dirty-marker fallback in
// `CrashRecoveryService` covers truncation. `TerminateProcess`/`taskkill /F`
// bypass `WM_ENDSESSION` entirely; that case is also handled by the marker
// fallback. See `docs/architecture/fatal-error-spine.md`.
export function registerWindowSessionEndHandler(win: BrowserWindow): void {
  if (process.platform !== "win32") return;
  win.on("session-end", () => {
    setSignalShutdown();
    app.quit();
  });
}
