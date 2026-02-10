import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateInfo, ProgressInfo } from "electron-updater";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

class AutoUpdaterService {
  private checkInterval: NodeJS.Timeout | null = null;
  private initialized = false;
  private checkingHandler: (() => void) | null = null;
  private availableHandler: ((info: UpdateInfo) => void) | null = null;
  private notAvailableHandler: ((info: UpdateInfo) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;
  private progressHandler: ((progress: ProgressInfo) => void) | null = null;
  private downloadedHandler: ((info: UpdateInfo) => void) | null = null;

  private runUpdateCheck(context: "Initial" | "Periodic"): void {
    try {
      const result = autoUpdater.checkForUpdatesAndNotify();
      Promise.resolve(result).catch((err) => {
        console.error(`[MAIN] ${context} update check failed:`, err);
      });
    } catch (err) {
      console.error(`[MAIN] ${context} update check failed:`, err);
    }
  }

  initialize(): void {
    if (this.initialized) {
      console.log("[MAIN] Auto-updater already initialized, skipping");
      return;
    }

    if (!app.isPackaged) {
      console.log("[MAIN] Auto-updater disabled in non-packaged mode");
      return;
    }

    if (process.platform === "win32" && process.env.PORTABLE_EXECUTABLE_FILE) {
      console.log("[MAIN] Auto-updater disabled for Windows portable builds");
      return;
    }

    try {
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;

      this.checkingHandler = () => {
        console.log("[MAIN] Checking for update...");
      };
      autoUpdater.on("checking-for-update", this.checkingHandler);

      this.availableHandler = (info: UpdateInfo) => {
        console.log("[MAIN] Update available:", info.version);
      };
      autoUpdater.on("update-available", this.availableHandler);

      this.notAvailableHandler = (_info: UpdateInfo) => {
        console.log("[MAIN] Update not available");
      };
      autoUpdater.on("update-not-available", this.notAvailableHandler);

      this.errorHandler = (err: Error) => {
        console.error("[MAIN] Auto-updater error:", err);
      };
      autoUpdater.on("error", this.errorHandler);

      this.progressHandler = (progress: ProgressInfo) => {
        console.log(`[MAIN] Download progress: ${Math.round(progress.percent)}%`);
      };
      autoUpdater.on("download-progress", this.progressHandler);

      this.downloadedHandler = (info: UpdateInfo) => {
        console.log("[MAIN] Update downloaded:", info.version);
      };
      autoUpdater.on("update-downloaded", this.downloadedHandler);

      this.runUpdateCheck("Initial");

      this.checkInterval = setInterval(() => {
        this.runUpdateCheck("Periodic");
      }, CHECK_INTERVAL_MS);

      this.initialized = true;
      console.log("[MAIN] Auto-updater initialized");
    } catch (err) {
      console.error("[MAIN] Auto-updater initialization failed:", err);
      this.dispose();
    }
  }

  dispose(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    if (this.checkingHandler) {
      autoUpdater.off("checking-for-update", this.checkingHandler);
      this.checkingHandler = null;
    }
    if (this.availableHandler) {
      autoUpdater.off("update-available", this.availableHandler);
      this.availableHandler = null;
    }
    if (this.notAvailableHandler) {
      autoUpdater.off("update-not-available", this.notAvailableHandler);
      this.notAvailableHandler = null;
    }
    if (this.errorHandler) {
      autoUpdater.off("error", this.errorHandler);
      this.errorHandler = null;
    }
    if (this.progressHandler) {
      autoUpdater.off("download-progress", this.progressHandler);
      this.progressHandler = null;
    }
    if (this.downloadedHandler) {
      autoUpdater.off("update-downloaded", this.downloadedHandler);
      this.downloadedHandler = null;
    }

    this.initialized = false;
  }
}

export const autoUpdaterService = new AutoUpdaterService();
