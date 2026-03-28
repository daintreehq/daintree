import { existsSync, readFileSync } from "fs";
import path from "path";
import { app, BrowserWindow, ipcMain } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateInfo, ProgressInfo } from "electron-updater";
import { CHANNELS } from "../ipc/channels.js";
import { getCrashRecoveryService } from "./CrashRecoveryService.js";
import { store } from "../store.js";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const STABLE_FEED_URL = "https://updates.canopyide.com/releases/";
const NIGHTLY_FEED_URL = "https://updates.canopyide.com/nightly/";
const { autoUpdater } = electronUpdater;

class AutoUpdaterService {
  private checkInterval: NodeJS.Timeout | null = null;
  private initialized = false;
  private window: BrowserWindow | null = null;
  private updateDownloaded = false;
  private isManualCheck = false;
  private checkingHandler: (() => void) | null = null;
  private availableHandler: ((info: UpdateInfo) => void) | null = null;
  private notAvailableHandler: ((info: UpdateInfo) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;
  private progressHandler: ((progress: ProgressInfo) => void) | null = null;
  private downloadedHandler: ((info: UpdateInfo) => void) | null = null;

  private configureFeedForChannel(channel: "stable" | "nightly"): void {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: channel === "nightly" ? NIGHTLY_FEED_URL : STABLE_FEED_URL,
      channel: channel === "nightly" ? "nightly" : "latest",
    });
    autoUpdater.allowDowngrade = true;
  }

  private sendToWindow(channel: string, payload: unknown): void {
    if (this.window && !this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      try {
        this.window.webContents.send(channel, payload);
      } catch {
        // Silently ignore send failures during window disposal.
      }
    }
  }

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

  checkForUpdatesManually(): void {
    if (!this.initialized) {
      console.log("[MAIN] Auto-updater not active, skipping manual check");
      return;
    }
    this.isManualCheck = true;
    try {
      const result = autoUpdater.checkForUpdates();
      Promise.resolve(result).catch((err) => {
        console.error("[MAIN] Manual update check failed:", err);
        this.isManualCheck = false;
      });
    } catch (err) {
      console.error("[MAIN] Manual update check failed:", err);
      this.isManualCheck = false;
    }
  }

  initialize(window?: BrowserWindow): void {
    if (this.initialized) {
      console.log("[MAIN] Auto-updater already initialized, skipping");
      return;
    }

    if (!window) {
      console.warn("[MAIN] Auto-updater requires a window, skipping initialization");
      return;
    }

    this.window = window;

    if (!app.isPackaged) {
      console.log("[MAIN] Auto-updater disabled in non-packaged mode");
      return;
    }

    if (process.platform === "win32" && process.env.PORTABLE_EXECUTABLE_FILE) {
      console.log("[MAIN] Auto-updater disabled for Windows portable builds");
      return;
    }

    if (process.platform === "linux" && !process.env.APPIMAGE) {
      let hasPackageType = false;
      try {
        const packageTypePath = path.join(process.resourcesPath, "package-type");
        hasPackageType =
          existsSync(packageTypePath) && readFileSync(packageTypePath, "utf-8").trim().length > 0;
      } catch {
        // Filesystem error reading package-type marker
      }
      if (!hasPackageType) {
        console.log(
          "[MAIN] Auto-updater disabled: Linux build without APPIMAGE or package-type marker"
        );
        return;
      }
    }

    try {
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;

      const initialChannel = store.get("updateChannel") ?? "stable";
      this.configureFeedForChannel(initialChannel);

      this.checkingHandler = () => {
        console.log("[MAIN] Checking for update...");
      };
      autoUpdater.on("checking-for-update", this.checkingHandler);

      this.availableHandler = (info: UpdateInfo) => {
        console.log("[MAIN] Update available:", info.version);
        this.isManualCheck = false;
        this.sendToWindow(CHANNELS.UPDATE_AVAILABLE, { version: info.version });
      };
      autoUpdater.on("update-available", this.availableHandler);

      this.notAvailableHandler = (_info: UpdateInfo) => {
        console.log("[MAIN] Update not available");
        if (this.isManualCheck) {
          this.isManualCheck = false;
          this.sendToWindow(CHANNELS.NOTIFICATION_SHOW_TOAST, {
            type: "info",
            title: "No Updates Available",
            message: `Canopy ${app.getVersion()} is the latest version.`,
          });
        }
      };
      autoUpdater.on("update-not-available", this.notAvailableHandler);

      this.errorHandler = (err: Error) => {
        console.error("[MAIN] Auto-updater error:", err);
        const wasManual = this.isManualCheck;
        this.isManualCheck = false;
        if (wasManual) {
          this.sendToWindow(CHANNELS.NOTIFICATION_SHOW_TOAST, {
            type: "error",
            title: "Update Failed",
            message: err.message,
            action: {
              label: "Retry",
              ipcChannel: CHANNELS.UPDATE_CHECK_FOR_UPDATES,
            },
          });
        }
      };
      autoUpdater.on("error", this.errorHandler);

      this.progressHandler = (progress: ProgressInfo) => {
        console.log(`[MAIN] Download progress: ${Math.round(progress.percent)}%`);
        this.sendToWindow(CHANNELS.UPDATE_DOWNLOAD_PROGRESS, { percent: progress.percent });
      };
      autoUpdater.on("download-progress", this.progressHandler);

      this.downloadedHandler = (info: UpdateInfo) => {
        console.log("[MAIN] Update downloaded:", info.version);
        this.updateDownloaded = true;
        this.sendToWindow(CHANNELS.UPDATE_DOWNLOADED, { version: info.version });
      };
      autoUpdater.on("update-downloaded", this.downloadedHandler);

      // Handle quit-and-install request from renderer
      ipcMain.handle(CHANNELS.UPDATE_QUIT_AND_INSTALL, () => {
        if (!this.updateDownloaded) {
          console.warn("[MAIN] Quit-and-install called before download completed");
          return;
        }
        try {
          getCrashRecoveryService().cleanupOnExit();
        } catch (err) {
          console.error("[MAIN] Crash recovery cleanup before quit-and-install failed:", err);
        }
        autoUpdater.quitAndInstall();
      });

      // Handle manual check-for-updates request from renderer
      ipcMain.handle(CHANNELS.UPDATE_CHECK_FOR_UPDATES, () => {
        this.checkForUpdatesManually();
      });

      ipcMain.handle(CHANNELS.UPDATE_GET_CHANNEL, () => {
        return store.get("updateChannel") ?? "stable";
      });

      ipcMain.handle(CHANNELS.UPDATE_SET_CHANNEL, (_event, channel: unknown) => {
        const validated: "stable" | "nightly" = channel === "nightly" ? "nightly" : "stable";
        store.set("updateChannel", validated);
        this.configureFeedForChannel(validated);
        this.updateDownloaded = false;
        return validated;
      });

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

    try {
      ipcMain.removeHandler(CHANNELS.UPDATE_QUIT_AND_INSTALL);
    } catch {
      // Handler may not have been registered
    }

    try {
      ipcMain.removeHandler(CHANNELS.UPDATE_CHECK_FOR_UPDATES);
    } catch {
      // Handler may not have been registered
    }

    try {
      ipcMain.removeHandler(CHANNELS.UPDATE_GET_CHANNEL);
    } catch {
      // Handler may not have been registered
    }

    try {
      ipcMain.removeHandler(CHANNELS.UPDATE_SET_CHANNEL);
    } catch {
      // Handler may not have been registered
    }

    this.window = null;
    this.updateDownloaded = false;
    this.isManualCheck = false;
    this.initialized = false;
  }
}

export const autoUpdaterService = new AutoUpdaterService();
