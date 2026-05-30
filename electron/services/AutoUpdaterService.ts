// eager-import-allow: reads updater config via store.get and the staged installer via sync fs
import { existsSync, readFileSync } from "fs";
import path from "path";
import { app, ipcMain } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateInfo, ProgressInfo } from "electron-updater";
import * as semver from "semver";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { getCrashRecoveryService } from "./CrashRecoveryService.js";
import { getSystemSleepService } from "./SystemSleepService.js";
import { trackEvent } from "./TelemetryService.js";
import { store } from "../store.js";
import { PRODUCT_NAME } from "../utils/productBranding.js";
import { isTrustedRendererUrl } from "../../shared/utils/trustedRenderer.js";
import { isWindowsStoreBuild } from "../../shared/config/distribution.js";

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
  "ENETDOWN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ECONNABORTED",
]);
const PERMANENT_CERT_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
]);
// Issue #7592: Electron's net stack rejects with errors whose only signal is
// `err.message = "net::ERR_*"` — no Node-style `code`, no `cause`. These two
// allowlists cover the Chromium tokens we explicitly know how to classify.
// Anything outside both sets falls through to the permanent path (fail closed).
const TRANSIENT_NET_ERROR_TOKENS = new Set([
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NETWORK_CHANGED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_ABORTED",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_TIMED_OUT",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_DNS_TIMED_OUT",
  "ERR_ADDRESS_UNREACHABLE",
]);
const PERMANENT_NET_ERROR_TOKENS = new Set([
  "ERR_CERT_DATE_INVALID",
  "ERR_CERT_AUTHORITY_INVALID",
  "ERR_CERT_COMMON_NAME_INVALID",
  "ERR_CERT_REVOKED",
  "ERR_SSL_PROTOCOL_ERROR",
  "ERR_BLOCKED_BY_CLIENT",
  "ERR_NETWORK_ACCESS_DENIED",
  "ERR_HSTS_POLICY_BYPASSED",
]);
const ELECTRON_NET_TOKEN_RE = /net::([A-Z0-9_]+)/g;
const STABLE_FEED_URL = "https://updates.daintree.org/releases/";
const NIGHTLY_FEED_URL = "https://updates.daintree.org/nightly/";
const { autoUpdater } = electronUpdater;

const RESUME_CHECK_DELAY_MS = 7_000;

// macOS-only watchdog after `autoUpdater.quitAndInstall()`: if the process is
// still alive after 5s, Squirrel.Mac's ShipIt likely failed to acquire its
// staging lock (electron-builder #8997) and the in-flight `app.quit()` will
// never fire. `app.exit(0)` force-terminates so ShipIt has a clean shot on the
// next launch. 5s is the community-recommended floor — 3s is too tight under
// memory pressure or slow disk. Windows/Linux keep the original setImmediate
// timing (no force-exit) because their installer paths don't share this mode.
const QUIT_AND_INSTALL_WATCHDOG_MS = 5_000;

// 400ms Doherty threshold gates the "Checking…" menu label so a fast CDN
// round-trip (sub-threshold) never flickers a transient label change.
const CHECKING_MENU_DELAY_MS = 400;

export type UpdateMenuState = "idle" | "checking" | "ready";

class AutoUpdaterService {
  private checkInterval: NodeJS.Timeout | null = null;
  private startupJitterTimeout: NodeJS.Timeout | null = null;
  private retryTimeout: NodeJS.Timeout | null = null;
  private resumeTimeout: NodeJS.Timeout | null = null;
  private watchdogTimeout: NodeJS.Timeout | null = null;
  private removeSuspendListener: (() => void) | null = null;
  private removeWakeListener: (() => void) | null = null;
  private retryCount = 0;
  private initialized = false;
  private channelHandlersRegistered = false;
  private updateDownloaded = false;
  private isManualCheck = false;
  private lastBroadcastVersion: string | null = null;
  private menuState: UpdateMenuState = "idle";
  private checkingMenuTimeout: NodeJS.Timeout | null = null;
  private menuStateListeners: Set<(state: UpdateMenuState) => void> = new Set();
  private channelGeneration = 0;
  private downloadGeneration = 0;
  private checkingHandler: (() => void) | null = null;
  private availableHandler: ((info: UpdateInfo) => void) | null = null;
  private notAvailableHandler: ((info: UpdateInfo) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;
  private progressHandler: ((progress: ProgressInfo) => void) | null = null;
  private downloadedHandler: ((info: UpdateInfo) => void) | null = null;

  private recordSuccessfulUpdateCheck(): void {
    try {
      store.set("lastUpdateCheck", Date.now());
    } catch (err) {
      console.error("[MAIN] Failed to write lastUpdateCheck to store:", err);
    }
  }

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

  private clearCheckingMenuTimeout(): void {
    if (this.checkingMenuTimeout) {
      clearTimeout(this.checkingMenuTimeout);
      this.checkingMenuTimeout = null;
    }
  }

  private setMenuState(state: UpdateMenuState): void {
    if (this.menuState === state) return;
    this.menuState = state;
    for (const listener of this.menuStateListeners) {
      try {
        listener(state);
      } catch (err) {
        console.error("[MAIN] Update menu state listener threw:", err);
      }
    }
  }

  getMenuState(): UpdateMenuState {
    return this.menuState;
  }

  onMenuStateChange(cb: (state: UpdateMenuState) => void): () => void {
    this.menuStateListeners.add(cb);
    return () => {
      this.menuStateListeners.delete(cb);
    };
  }

  // Shared install-trigger for `quitAndInstallIfReady()` and the
  // UPDATE_QUIT_AND_INSTALL IPC handler. Both call sites need identical
  // behavior: defer past the menu-close frame via `setImmediate` (Windows
  // animation timing), then arm a macOS-only watchdog that force-exits if
  // ShipIt fails to land its `app.quit()`. `quitAndInstall()` is wrapped so
  // a thrown exception still arms the watchdog (force-exit is still the
  // right move — ShipIt has its best chance on the next launch), and the
  // `app.exit(0)` inside the watchdog is wrapped so a shutdown-time throw
  // doesn't become an unhandled rejection.
  private executeQuitAndInstall(): void {
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall();
      } catch (err) {
        console.error("[MAIN] autoUpdater.quitAndInstall() threw:", err);
      }
      if (process.platform !== "darwin") return;
      this.watchdogTimeout = setTimeout(() => {
        this.watchdogTimeout = null;
        try {
          app.exit(0);
        } catch (err) {
          console.error("[MAIN] Quit-and-install watchdog app.exit(0) failed:", err);
        }
      }, QUIT_AND_INSTALL_WATCHDOG_MS);
    });
  }

  private checkPendingUpdateInstallVersion(): void {
    // Read+delete synchronously before any await so a crash between the two
    // doesn't re-fire on every subsequent boot. Mirrors the crash-counter
    // clear-on-read pattern in CrashRecoveryService.
    const raw = store.get("pendingUpdateVersion");
    try {
      store.delete("pendingUpdateVersion");
    } catch (err) {
      console.error("[MAIN] Failed to clear pendingUpdateVersion:", err);
    }
    if (typeof raw !== "string") return;
    const expected = raw.trim();
    if (expected.length === 0 || !semver.valid(expected)) return;
    const actual = app.getVersion();
    if (expected === actual) return;
    try {
      trackEvent("auto_update_install_version_mismatch", {
        expectedVersion: expected,
        actualVersion: actual,
        platform: process.platform,
      });
    } catch (err) {
      console.error("[MAIN] Failed to track auto_update_install_version_mismatch:", err);
    }
  }

  quitAndInstallIfReady(): boolean {
    if (isWindowsStoreBuild()) return false;
    if (this.menuState !== "ready" || !this.updateDownloaded) return false;
    // Flip both guards synchronously so a rapid double-click can't queue two
    // setImmediate(quitAndInstall) calls — the second invocation reads idle
    // and bails. Resetting menuState back to idle also gives instant visual
    // feedback that the click registered.
    this.updateDownloaded = false;
    this.setMenuState("idle");
    try {
      getCrashRecoveryService().cleanupOnExit();
    } catch (err) {
      console.error("[MAIN] Crash recovery cleanup before quit-and-install failed:", err);
    }
    // Disarm the before-quit listener so the explicit quitAndInstall() path
    // and the autoInstallOnAppQuit path don't race the installer subprocess.
    autoUpdater.autoInstallOnAppQuit = false;
    this.executeQuitAndInstall();
    return true;
  }

  // electron-updater 6.3.x doesn't surface a categorized error type, so classify
  // by Node `err.code` (network/DNS), `err.statusCode` (HTTP), and `err.message`
  // (Electron net errors, which carry a `net::ERR_*` token in the message and
  // no `code`). Walk the `cause` chain so signals nested by builder-util-runtime
  // or future Node error-chaining aren't hidden from the classifier. Cert errors
  // at any depth return false immediately (permanent wins); transient signals
  // are deferred until the full chain is walked so a deeper cert error can
  // override. Anything we can't positively prove is transient is treated as
  // permanent — fail closed so we don't loop on a misconfigured feed.
  private isTransientUpdateError(err: unknown): boolean {
    let current: unknown = err;
    let foundTransient = false;
    for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") {
        if (PERMANENT_CERT_ERROR_CODES.has(code)) return false;
        if (TRANSIENT_ERROR_CODES.has(code)) foundTransient = true;
      }
      const statusCode = (current as { statusCode?: unknown }).statusCode;
      if (typeof statusCode === "number") {
        if (statusCode === 404 || statusCode === 401 || statusCode === 403) return false;
        if (statusCode >= 500 && statusCode < 600) foundTransient = true;
        if (statusCode === 408 || statusCode === 429) foundTransient = true;
      }
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string") {
        // Walk every `net::ERR_*` token in the message — a permanent token
        // anywhere in the string must short-circuit even if a transient token
        // appears first (preserves permanent-wins inside a single message).
        for (const match of message.matchAll(ELECTRON_NET_TOKEN_RE)) {
          const token = match[1];
          if (PERMANENT_NET_ERROR_TOKENS.has(token)) return false;
          if (TRANSIENT_NET_ERROR_TOKENS.has(token)) foundTransient = true;
        }
      }
      current = (current as { cause?: unknown }).cause;
    }
    return foundTransient;
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

  private runUpdateCheck(context: "Initial" | "Periodic" | "Retry" | "Resume"): void {
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
    if (isWindowsStoreBuild()) {
      console.log("[MAIN] Auto-updater disabled for Windows Store builds");
      return;
    }
    if (!this.initialized) {
      console.log("[MAIN] Auto-updater not active, skipping manual check");
      return;
    }
    this.isManualCheck = true;
    // Doherty gate: only flip the menu to "Checking…" when the round-trip
    // exceeds 400ms. Re-arming on a second click cancels the pending flip
    // and restarts the window — the menu only transitions after the latest
    // call passes the threshold.
    this.clearCheckingMenuTimeout();
    if (this.menuState !== "ready") {
      this.checkingMenuTimeout = setTimeout(() => {
        this.checkingMenuTimeout = null;
        if (this.isManualCheck && this.menuState !== "ready") {
          this.setMenuState("checking");
        }
      }, CHECKING_MENU_DELAY_MS);
    }
    try {
      const result = autoUpdater.checkForUpdates();
      Promise.resolve(result).catch((err) => {
        console.error("[MAIN] Manual update check failed:", err);
        this.isManualCheck = false;
        this.clearCheckingMenuTimeout();
        // The check rejected without an `error` event — restore Idle so the
        // menu doesn't get stuck on "Checking…". Ready persists.
        if (this.menuState !== "ready") this.setMenuState("idle");
      });
    } catch (err) {
      console.error("[MAIN] Manual update check failed:", err);
      this.isManualCheck = false;
      this.clearCheckingMenuTimeout();
      if (this.menuState !== "ready") this.setMenuState("idle");
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
        // Mirror the `?? "stable"` fallback that initialize() applies. Without
        // it, a fresh install (no stored key) reads previousChannel as
        // undefined and the same-channel guard never fires — saving "stable"
        // would discard a validly-staged installer.
        const previousChannel = store.get("updateChannel") ?? "stable";
        store.set("updateChannel", validated);

        // Same-channel re-save (e.g. user opens settings and clicks Save
        // without changing the channel) must not blow away a validly-staged
        // installer for the active channel.
        if (validated === previousChannel) return validated;

        // Reset all install guards synchronously BEFORE the async clear so
        // quitAndInstallIfReady() and the IPC handler can't race through
        // during the await window and install the old channel's payload.
        autoUpdater.autoInstallOnAppQuit = false;
        this.updateDownloaded = false;
        this.lastBroadcastVersion = null;
        this.resetRetryState();
        this.clearCheckingMenuTimeout();
        this.setMenuState("idle");
        // Drop the pending-install marker for the prior channel so the next
        // boot doesn't fire a false-positive mismatch (issue #9261). The new
        // channel's download will re-arm it via update-downloaded.
        try {
          store.delete("pendingUpdateVersion");
        } catch (err) {
          console.error("[MAIN] Failed to clear pendingUpdateVersion on channel switch:", err);
        }
        // Transition to Idle done; now discard the staged installer on disk
        // and reconfigure the feed. Re-arm happens in the update-downloaded
        // handler when the new channel's download completes.
        this.channelGeneration += 1;
        await this.clearStagedInstaller();

        if (this.initialized) {
          this.configureFeedForChannel(validated);
        }
        return validated;
      });

      ipcMain.handle(CHANNELS.UPDATE_GET_LAST_CHECK, () => {
        return store.get("lastUpdateCheck") ?? null;
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

      this.channelHandlersRegistered = true;
    }

    if (!app.isPackaged) {
      console.log("[MAIN] Auto-updater disabled in non-packaged mode");
      return;
    }

    // Boot-time install verification (issue #9261). Runs on every packaged
    // platform — the Windows-Store / Linux guards below cause early returns
    // before electron-updater is wired up, but a prior install could still
    // have left `pendingUpdateVersion` on disk (e.g. user switched packaging
    // mode between launches). Run before those guards so the marker is always
    // consumed exactly once. Cross-platform because NSIS empty-directory
    // races (electron-builder #9181) produce the same observable symptom.
    this.checkPendingUpdateInstallVersion();

    if (isWindowsStoreBuild()) {
      console.log("[MAIN] Auto-updater disabled for Windows Store builds");
      return;
    }

    if (process.platform === "linux" && process.env.FLATPAK_ID) {
      console.log("[MAIN] Auto-updater disabled: Linux Flatpak sandbox detected");
      return;
    }

    if (process.platform === "linux" && process.env.SNAP) {
      console.log("[MAIN] Auto-updater disabled: Linux Snap sandbox detected");
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
      autoUpdater.disableWebInstaller = true;

      const initialChannel = store.get("updateChannel") ?? "stable";
      this.configureFeedForChannel(initialChannel);

      this.checkingHandler = () => {
        console.log("[MAIN] Checking for update...");
      };
      autoUpdater.on("checking-for-update", this.checkingHandler);

      this.availableHandler = (info: UpdateInfo) => {
        console.log("[MAIN] Update available:", info.version);
        this.downloadGeneration = this.channelGeneration;
        const suppressed = this.shouldSuppressUpdateAvailable(info.version);
        this.isManualCheck = false;
        this.recordSuccessfulUpdateCheck();
        // A successful check ends the retry cycle regardless of whether we
        // broadcast — the network round-tripped, so the transient condition
        // has cleared.
        this.resetRetryState();
        // Update available, but the install isn't ready until download
        // completes — let the downloaded handler flip to "ready".
        this.clearCheckingMenuTimeout();
        if (this.menuState !== "ready") this.setMenuState("idle");
        if (suppressed) return;
        this.lastBroadcastVersion = info.version;
        broadcastToRenderer(CHANNELS.UPDATE_AVAILABLE, { version: info.version });
      };
      autoUpdater.on("update-available", this.availableHandler);

      this.notAvailableHandler = (_info: UpdateInfo) => {
        console.log("[MAIN] Update not available");
        this.recordSuccessfulUpdateCheck();
        this.resetRetryState();
        this.clearCheckingMenuTimeout();
        if (this.menuState !== "ready") this.setMenuState("idle");
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
        this.clearCheckingMenuTimeout();
        if (this.menuState !== "ready") this.setMenuState("idle");
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
        this.recordSuccessfulUpdateCheck();
        this.resetRetryState();
        this.clearCheckingMenuTimeout();
        // Stale-download guard: downloadGeneration was captured in
        // update-available, channelGeneration is incremented on channel
        // switch. If they diverged, this download belongs to the prior
        // channel and must not re-arm install.
        if (this.channelGeneration !== this.downloadGeneration) return;
        this.updateDownloaded = true;
        autoUpdater.autoInstallOnAppQuit = true;
        // Persist the staged version so the next boot can detect a silent
        // install failure (issue #9261). Write before broadcasting so a crash
        // between event delivery and the IPC frame still leaves the marker on
        // disk. `semver.valid` defends against a malformed payload from a
        // future electron-updater revision.
        if (typeof info.version === "string") {
          const trimmed = info.version.trim();
          // Persist the canonical semver form (no leading `v`, no `=` prefix)
          // so the boot comparison round-trips cleanly against
          // `app.getVersion()`, which already emits canonical form.
          const canonical = trimmed.length > 0 ? semver.valid(trimmed) : null;
          if (canonical) {
            try {
              store.set("pendingUpdateVersion", canonical);
            } catch (err) {
              console.error("[MAIN] Failed to persist pendingUpdateVersion:", err);
            }
          }
        }
        this.setMenuState("ready");
        broadcastToRenderer(CHANNELS.UPDATE_DOWNLOADED, { version: info.version });
      };
      autoUpdater.on("update-downloaded", this.downloadedHandler);

      // Handle quit-and-install request from renderer. Mirrors the guard +
      // cleanup pattern from quitAndInstallIfReady() and validates the sender
      // origin synchronously (matches UPDATE_DISMISS_TOAST pattern).
      ipcMain.handle(CHANNELS.UPDATE_QUIT_AND_INSTALL, (event) => {
        const senderUrl = event.senderFrame?.url;
        if (!senderUrl || !isTrustedRendererUrl(senderUrl)) return;
        if (!this.updateDownloaded) {
          console.warn("[MAIN] Quit-and-install called before download completed");
          return;
        }
        this.updateDownloaded = false;
        this.setMenuState("idle");
        try {
          getCrashRecoveryService().cleanupOnExit();
        } catch (err) {
          console.error("[MAIN] Crash recovery cleanup before quit-and-install failed:", err);
        }
        autoUpdater.autoInstallOnAppQuit = false;
        this.executeQuitAndInstall();
      });

      // Handle manual check-for-updates request from renderer
      ipcMain.handle(CHANNELS.UPDATE_CHECK_FOR_UPDATES, () => {
        this.checkForUpdatesManually();
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

      try {
        this.removeSuspendListener = getSystemSleepService().onSuspend(() => {
          if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
          }
          if (this.startupJitterTimeout) {
            clearTimeout(this.startupJitterTimeout);
            this.startupJitterTimeout = null;
          }
          if (this.resumeTimeout) {
            clearTimeout(this.resumeTimeout);
            this.resumeTimeout = null;
          }
          this.clearRetryTimeout();
          this.resetRetryState();
        });
        this.removeWakeListener = getSystemSleepService().onWake(() => {
          if (this.resumeTimeout || this.checkInterval) return;
          this.resumeTimeout = setTimeout(() => {
            this.resumeTimeout = null;
            this.runUpdateCheck("Resume");
            if (!this.checkInterval) {
              this.checkInterval = setInterval(() => {
                this.runUpdateCheck("Periodic");
              }, CHECK_INTERVAL_MS);
            }
          }, RESUME_CHECK_DELAY_MS);
        });
      } catch {
        // SystemSleepService may not be initialized yet at early startup.
        // The suspend hook is best-effort — periodic timer covers the gap.
      }

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
    if (this.resumeTimeout) {
      clearTimeout(this.resumeTimeout);
      this.resumeTimeout = null;
    }
    if (this.watchdogTimeout) {
      clearTimeout(this.watchdogTimeout);
      this.watchdogTimeout = null;
    }
    this.retryCount = 0;

    if (this.removeSuspendListener) {
      this.removeSuspendListener();
      this.removeSuspendListener = null;
    }
    if (this.removeWakeListener) {
      this.removeWakeListener();
      this.removeWakeListener = null;
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

    try {
      ipcMain.removeHandler(CHANNELS.UPDATE_GET_LAST_CHECK);
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
    this.channelGeneration = 0;
    this.downloadGeneration = 0;
    this.initialized = false;
    this.clearCheckingMenuTimeout();
    // Reset menu state to idle BEFORE clearing listeners so any registered
    // menu callback gets the final transition. After listener clearance any
    // future setMenuState is a silent no-op.
    if (this.menuState !== "idle") this.setMenuState("idle");
    this.menuStateListeners.clear();
  }
}

export const autoUpdaterService = new AutoUpdaterService();
