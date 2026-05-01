import { existsSync, readFileSync } from "fs";
import path from "path";
import { app, ipcMain } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateInfo, ProgressInfo } from "electron-updater";
import * as semver from "semver";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { getCrashRecoveryService } from "./CrashRecoveryService.js";
import { store } from "../store.js";
import { PRODUCT_NAME } from "../utils/productBranding.js";
import { isTrustedRendererUrl } from "../../shared/utils/trustedRenderer.js";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
// Issue #6401: bounded backoff for transient network failures. The 4-hour
// periodic tick is too coarse to recover from a brief CDN blip or DNS hiccup
// during launch. 30s/2m/8m with ±20% jitter spreads retries across a window
// that's still useful while not pummeling a degraded feed.
const RETRY_BASE_DELAYS_MS = [30_000, 120_000, 480_000] as const;
const MAX_RETRIES = RETRY_BASE_DELAYS_MS.length;
// Issue #6401: spread CDN load on the launch tick across a 60s window so a
// fleet of restarts (e.g. after an OS update) doesn't stampede the feed.
const STARTUP_JITTER_MAX_MS = 60_000;
// Cap dismiss-version length before any further validation. SemVer with
// pre-release/build identifiers stays well under 64 chars; anything longer is
// either malformed or a probe.
const DISMISS_VERSION_MAX_LEN = 64;
// SemVer always starts with a numeric major; requiring a leading digit kills
// the `v1.2.3` / `=1.2.3` tolerance that `semver.valid` permits, so the stored
// form is always canonical.
const DISMISS_VERSION_ALLOWLIST = /^[0-9][0-9a-zA-Z._+-]{0,63}$/;
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EPIPE",
  "ENETUNREACH",
]);
const PERMANENT_CERT_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
]);
const STABLE_FEED_URL = "https://updates.daintree.org/releases/";
const NIGHTLY_FEED_URL = "https://updates.daintree.org/nightly/";
const { autoUpdater } = electronUpdater;

class AutoUpdaterService {
  private checkInterval: NodeJS.Timeout | null = null;
  private startupJitterTimeout: NodeJS.Timeout | null = null;
  private retryTimeout: NodeJS.Timeout | null = null;
  private retryCount = 0;
  private initialized = false;
  private channelHandlersRegistered = false;
  private updateDownloaded = false;
  private isManualCheck = false;
  private lastBroadcastVersion: string | null = null;
  private checkingHandler: (() => void) | null = null;
  private availableHandler: ((info: UpdateInfo) => void) | null = null;
  private notAvailableHandler: ((info: UpdateInfo) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;
  private progressHandler: ((progress: ProgressInfo) => void) | null = null;
  private downloadedHandler: ((info: UpdateInfo) => void) | null = null;

  private clearRetryTimeout(): void {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
  }

  private resetRetryState(): void {
    this.clearRetryTimeout();
    this.retryCount = 0;
  }

  // electron-updater 6.3.x doesn't surface a categorized error type, so classify
  // by Node `err.code` (network/DNS) and `err.statusCode` (HTTP) on the raw
  // Error. Anything we can't positively prove is transient is treated as
  // permanent — fail closed so we don't loop on a misconfigured feed.
  private isTransientUpdateError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      if (PERMANENT_CERT_ERROR_CODES.has(code)) return false;
      if (TRANSIENT_ERROR_CODES.has(code)) return true;
    }
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number") {
      if (statusCode === 404 || statusCode === 401 || statusCode === 403) return false;
      if (statusCode >= 500 && statusCode < 600) return true;
      if (statusCode === 408 || statusCode === 429) return true;
    }
    return false;
  }

  private scheduleRetry(): void {
    if (this.retryCount >= MAX_RETRIES) return;
    const base = RETRY_BASE_DELAYS_MS[this.retryCount];
    // ±20% full jitter centered on the base — multiplier in [0.8, 1.2).
    const jitterFactor = 0.8 + 0.4 * Math.random();
    const delay = Math.floor(base * jitterFactor);
    this.retryCount += 1;
    this.clearRetryTimeout();
    this.retryTimeout = setTimeout(() => {
      this.retryTimeout = null;
      this.runUpdateCheck("Retry");
    }, delay);
  }

  private async clearStagedInstaller(): Promise<void> {
    // `downloadedUpdateHelper` is `protected` on AppUpdater (not part of the
    // public TS surface), so we reach through with a structural cast. It's
    // initialized lazily on first download, so the null guard is mandatory.
    // `clear()` internally swallows fs errors, but wrap defensively in case the
    // internals change in a future patch.
    const helper = (
      autoUpdater as unknown as {
        downloadedUpdateHelper?: { clear?: () => Promise<void> } | null;
      }
    ).downloadedUpdateHelper;
    if (!helper || typeof helper.clear !== "function") return;
    try {
      await helper.clear();
    } catch (err) {
      console.warn("[MAIN] Failed to clear staged installer cache:", err);
    }
  }

  private shouldSuppressUpdateAvailable(version: string): boolean {
    // Manual checks always bypass suppression so users see a result.
    if (this.isManualCheck) return false;

    // In-session dedup: electron-updater refires `update-available` on every
    // poll for the same pending version. Swallow repeats within this session.
    if (this.lastBroadcastVersion === version) return true;

    const dismissedVersion = store.get("dismissedUpdateVersion");
    const dismissedAt = store.get("dismissedUpdateAt");
    if (
      typeof dismissedVersion !== "string" ||
      typeof dismissedAt !== "number" ||
      !Number.isFinite(dismissedAt)
    ) {
      // Corrupt record (e.g., NaN/Infinity from a future writer or hand-edited
      // config) — clear it and fall through so the user still sees updates.
      if (typeof dismissedVersion === "string" || typeof dismissedAt === "number") {
        store.delete("dismissedUpdateVersion");
        store.delete("dismissedUpdateAt");
      }
      return false;
    }

    // Newer version bypasses the cooldown. If either side fails to coerce,
    // fall back to not-newer (fail closed — keep suppressing) to match the
    // AgentVersionService pattern.
    const incoming = semver.coerce(version);
    const dismissed = semver.coerce(dismissedVersion);
    if (incoming && dismissed) {
      try {
        if (semver.gt(incoming, dismissed)) return false;
      } catch {
        // fall through
      }
    }

    const elapsed = Date.now() - dismissedAt;
    if (elapsed < 0 || elapsed >= DISMISS_COOLDOWN_MS) {
      // Cooldown expired (or clock skew) — clear stale record and broadcast.
      store.delete("dismissedUpdateVersion");
      store.delete("dismissedUpdateAt");
      return false;
    }

    // Same version is still within the 24h cooldown.
    return dismissedVersion === version;
  }

  private configureFeedForChannel(channel: "stable" | "nightly"): void {
    // URL separation (not channel-name separation) routes stable vs. nightly.
    // Both feeds serve `latest*.yml` under their respective URL prefixes —
    // electron-builder 26.x restricts the publish `channel` field to a fixed
    // enum, so we can't emit a `nightly.yml`. Omitting channel here makes
    // electron-updater fall back to `latest*.yml` at whichever URL is active.
    autoUpdater.setFeedURL({
      provider: "generic",
      url: channel === "nightly" ? NIGHTLY_FEED_URL : STABLE_FEED_URL,
    });
    // Only nightly permits downgrades: a user who opts into the nightly channel
    // from e.g. 0.6.0 stable needs to be able to receive 0.6.0-nightly.X, which
    // is semver-lower than the stable they're on. Stable feeds must never
    // downgrade — a regressed or overwritten latest.yml would otherwise walk
    // every installed user backwards on the next check.
    autoUpdater.allowDowngrade = channel === "nightly";
  }

  private runUpdateCheck(context: "Initial" | "Periodic" | "Retry"): void {
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

  initialize(): void {
    if (this.initialized) {
      console.log("[MAIN] Auto-updater already initialized, skipping");
      return;
    }

    // Register channel-preference handlers unconditionally — they only
    // read/write electron-store and don't depend on electron-updater.
    if (!this.channelHandlersRegistered) {
      ipcMain.handle(CHANNELS.UPDATE_GET_CHANNEL, () => {
        return store.get("updateChannel") ?? "stable";
      });

      ipcMain.handle(CHANNELS.UPDATE_SET_CHANNEL, async (_event, channel: unknown) => {
        const validated: "stable" | "nightly" = channel === "nightly" ? "nightly" : "stable";
        const previousChannel = store.get("updateChannel");
        store.set("updateChannel", validated);

        // Same-channel re-save (e.g. user opens settings and clicks Save
        // without changing the channel) must not blow away a validly-staged
        // installer for the active channel.
        if (validated === previousChannel) return validated;

        // Discard prior-channel state BEFORE reconfiguring the feed, so a
        // throw inside configureFeedForChannel can't leave a stale installer
        // that quit-and-install would later run.
        await this.clearStagedInstaller();
        this.updateDownloaded = false;
        this.lastBroadcastVersion = null;
        this.resetRetryState();

        if (this.initialized) {
          this.configureFeedForChannel(validated);
        }
        return validated;
      });

      this.channelHandlersRegistered = true;
    }

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
        const suppressed = this.shouldSuppressUpdateAvailable(info.version);
        this.isManualCheck = false;
        // A successful check ends the retry cycle regardless of whether we
        // broadcast — the network round-tripped, so the transient condition
        // has cleared.
        this.resetRetryState();
        if (suppressed) return;
        this.lastBroadcastVersion = info.version;
        broadcastToRenderer(CHANNELS.UPDATE_AVAILABLE, { version: info.version });
      };
      autoUpdater.on("update-available", this.availableHandler);

      this.notAvailableHandler = (_info: UpdateInfo) => {
        console.log("[MAIN] Update not available");
        this.resetRetryState();
        if (this.isManualCheck) {
          this.isManualCheck = false;
          broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
            type: "info",
            title: "No updates available",
            message: `${PRODUCT_NAME} ${app.getVersion()} is the latest version.`,
          });
        }
      };
      autoUpdater.on("update-not-available", this.notAvailableHandler);

      this.errorHandler = (err: Error) => {
        console.error("[MAIN] Auto-updater error:", err);
        const wasManual = this.isManualCheck;
        this.isManualCheck = false;
        if (wasManual) {
          // Manual checks surface to the user immediately and offer a Retry
          // action — don't shadow that with background backoff, the user is
          // already deciding when to retry.
          this.resetRetryState();
          broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
            type: "error",
            title: "Update failed",
            message: err.message,
            action: {
              label: "Retry",
              ipcChannel: CHANNELS.UPDATE_CHECK_FOR_UPDATES,
            },
          });
          return;
        }
        if (!this.isTransientUpdateError(err)) {
          // Permanent: 404 (missing latest.yml), cert errors, or any error we
          // can't classify. Don't retry — wait for the next 4-hour tick or a
          // manual re-check.
          this.resetRetryState();
          return;
        }
        if (this.retryCount >= MAX_RETRIES) {
          this.resetRetryState();
          return;
        }
        this.scheduleRetry();
      };
      autoUpdater.on("error", this.errorHandler);

      this.progressHandler = (progress: ProgressInfo) => {
        console.log(`[MAIN] Download progress: ${Math.round(progress.percent)}%`);
        broadcastToRenderer(CHANNELS.UPDATE_DOWNLOAD_PROGRESS, { percent: progress.percent });
      };
      autoUpdater.on("download-progress", this.progressHandler);

      this.downloadedHandler = (info: UpdateInfo) => {
        console.log("[MAIN] Update downloaded:", info.version);
        this.updateDownloaded = true;
        this.resetRetryState();
        broadcastToRenderer(CHANNELS.UPDATE_DOWNLOADED, { version: info.version });
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

      // Persist dismiss of the "Update Available" toast — the renderer sends
      // this when the user closes the toast so the same version is suppressed
      // across app restarts for the 24h cooldown window. Validate the sender
      // origin synchronously (matches recovery.ts and plugin.ts pattern), cap
      // length, allowlist characters, and require strict semver — defense in
      // depth on top of contextIsolation + asar integrity.
      ipcMain.handle(CHANNELS.UPDATE_DISMISS_TOAST, (event, version: unknown) => {
        const senderUrl = event.senderFrame?.url;
        if (!senderUrl || !isTrustedRendererUrl(senderUrl)) return;
        if (typeof version !== "string") return;
        const trimmed = version.trim();
        if (trimmed.length === 0 || trimmed.length > DISMISS_VERSION_MAX_LEN) return;
        if (!DISMISS_VERSION_ALLOWLIST.test(trimmed)) return;
        if (!semver.valid(trimmed)) return;
        store.set("dismissedUpdateVersion", trimmed);
        store.set("dismissedUpdateAt", Date.now());
      });

      // Spread the launch-time check across a 60s window so a fleet of
      // simultaneous restarts (e.g. after an OS update) doesn't stampede the
      // CDN. Main-process setTimeout is not subject to renderer background
      // throttling.
      const startupJitterMs = Math.floor(Math.random() * STARTUP_JITTER_MAX_MS);
      this.startupJitterTimeout = setTimeout(() => {
        this.startupJitterTimeout = null;
        this.runUpdateCheck("Initial");
      }, startupJitterMs);

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
    if (this.startupJitterTimeout) {
      clearTimeout(this.startupJitterTimeout);
      this.startupJitterTimeout = null;
    }
    this.clearRetryTimeout();
    this.retryCount = 0;

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

    try {
      ipcMain.removeHandler(CHANNELS.UPDATE_DISMISS_TOAST);
    } catch {
      // Handler may not have been registered
    }

    this.updateDownloaded = false;
    this.isManualCheck = false;
    this.lastBroadcastVersion = null;
    this.channelHandlersRegistered = false;
    this.initialized = false;
  }
}

export const autoUpdaterService = new AutoUpdaterService();
