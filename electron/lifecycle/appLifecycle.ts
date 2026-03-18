import { app, BrowserWindow } from "electron";
import type { CliAvailabilityService } from "../services/CliAvailabilityService.js";
import type { ProjectSwitchService } from "../services/ProjectSwitchService.js";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import { handleDirectoryOpen } from "../menu.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { setSignalShutdown } from "./signalShutdownState.js";

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
  getMainWindow: () => BrowserWindow | null;
  getCliAvailabilityService: () => CliAvailabilityService | null;
  getProjectSwitchService: () => ProjectSwitchService | null;
  windowRegistry?: WindowRegistry;
}

export function registerAppLifecycleHandlers(opts: AppLifecycleOptions): void {
  // Initialize crash recovery only in the winning instance
  getCrashRecoveryService();

  // Graceful shutdown on OS signals (macOS/Linux SIGTERM/SIGINT, Windows Ctrl+C).
  // Triggers `before-quit` via `app.quit()` so the shutdown handler runs the full
  // cleanup chain. A hard timeout ensures the process exits even if cleanup stalls.
  // On Windows, `taskkill /F` (TerminateProcess) bypasses all Node.js shutdown hooks —
  // that case is handled by CrashRecoveryService on next startup.
  let signalHandled = false;
  const signalHandler = () => {
    if (signalHandled) return;
    signalHandled = true;
    setSignalShutdown();
    setTimeout(() => process.exit(0), 5000).unref();
    app.quit();
  };
  process.on("SIGTERM", signalHandler);
  process.on("SIGINT", signalHandler);

  app.on("second-instance", (_event, commandLine, _workingDirectory) => {
    console.log("[MAIN] Second instance detected, focusing main window");
    const mainWindow =
      opts.windowRegistry?.getPrimary()?.browserWindow ?? opts.getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const cliPath = extractCliPath(commandLine);
    if (cliPath) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log("[MAIN] Opening CLI path from second instance:", cliPath);
        handleDirectoryOpen(
          cliPath,
          mainWindow,
          opts.getCliAvailabilityService() ?? undefined,
          opts.getProjectSwitchService() ?? undefined
        ).catch((err) => console.error("[MAIN] Failed to open CLI path:", err));
      } else {
        pendingCliPath = cliPath;
        console.log("[MAIN] Queuing CLI path for when window is ready:", cliPath);
      }
    }
  });

  app.on("window-all-closed", () => {
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
