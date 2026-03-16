import { app, BrowserWindow } from "electron";
import type { CliAvailabilityService } from "../services/CliAvailabilityService.js";
import { handleDirectoryOpen } from "../menu.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";

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
}

export function registerAppLifecycleHandlers(opts: AppLifecycleOptions): void {
  // Initialize crash recovery only in the winning instance
  getCrashRecoveryService();

  // Best-effort cleanup for dev-mode signal delivery (macOS/Linux SIGTERM/SIGINT,
  // Windows Ctrl+C). On Windows, nodemon uses `taskkill /F` (TerminateProcess) which
  // bypasses all Node.js shutdown hooks — that case is handled by CrashRecoveryService
  // discarding orphaned dev-mode markers on next startup.
  if (!app.isPackaged) {
    const devSignalHandler = () => {
      getCrashRecoveryService().cleanupOnExit();
      setTimeout(() => process.exit(0), 3000).unref();
      app.quit();
    };
    process.on("SIGTERM", devSignalHandler);
    process.on("SIGINT", devSignalHandler);
  }

  app.on("second-instance", (_event, commandLine, _workingDirectory) => {
    console.log("[MAIN] Second instance detected, focusing main window");
    const mainWindow = opts.getMainWindow();
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
          opts.getCliAvailabilityService() ?? undefined
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
    if (BrowserWindow.getAllWindows().length === 0) {
      opts.onCreateWindow();
    }
  });
}
