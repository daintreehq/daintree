import { app, ipcMain, net } from "electron";
import { load as parseYaml } from "js-yaml";
import * as semver from "semver";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { getSystemSleepService } from "./SystemSleepService.js";
import { store } from "../store.js";
import { isTrustedRendererUrl } from "../../shared/utils/trustedRenderer.js";
import { isWindowsStoreBuild } from "../../shared/config/distribution.js";
import { raceAbort } from "../utils/raceAbort.js";
import { TimeoutError, timeoutSignal } from "../utils/withTimeout.js";

// Store handles installs every ~8 hours, so polling more often than the OS does
// makes us look noisy without surfacing anything sooner.
const CHECK_INTERVAL_MS = 8 * 60 * 60 * 1000;
const RETRY_BASE_DELAYS_MS = [30_000, 120_000, 480_000] as const;
const MAX_RETRIES = RETRY_BASE_DELAYS_MS.length;
const STARTUP_JITTER_MAX_MS = 60_000;
const RESUME_CHECK_DELAY_MS = 7_000;
// Covers the request and the body read together; a stalled CDN response would
// otherwise hold the check open until the next wake or 8-hour tick.
const FETCH_TIMEOUT_MS = 30_000;
const VERSION_MAX_LEN = 64;
// Same canonical-form gate as AutoUpdaterService — strict numeric leading
// digit prevents `v1.2.3`/`=1.2.3` from round-tripping through the store.
const VERSION_ALLOWLIST = /^[0-9][0-9a-zA-Z._+-]{0,63}$/;

// Public CDN paths — duplicated here on purpose. Coupling the Store notifier
// to AutoUpdaterService just to share two strings would force a load-order
// dependency for no benefit.
const STABLE_FEED_URL = "https://updates.daintree.org/releases/";
const NIGHTLY_FEED_URL = "https://updates.daintree.org/nightly/";

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
]);
const ELECTRON_NET_TOKEN_RE = /net::([A-Z0-9_]+)/g;

const MS_STORE_FALLBACK_URL = "ms-windows-store://downloadsandupdates";

export interface DetectedStoreUpdate {
  version: string;
  storeUrl: string;
}

interface ManifestVersion {
  version: string;
  etag: string | null;
}

interface InflightCheck {
  feedUrl: string;
  controller: AbortController;
  promise: Promise<void>;
}

const ABORTED = Symbol("aborted");

// Rejects with the deadline's own reason once it fires, even when the work
// ignores the signal: Chromium can end an aborted body as a plain abort, and
// a mocked or wedged read may never settle at all.
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const result = await raceAbort(work, signal, ABORTED);
  if (result === ABORTED) throw signal.reason;
  return result;
}

function buildStoreUrl(): string {
  const productId = process.env.DAINTREE_MICROSOFT_STORE_PRODUCT_ID;
  if (typeof productId !== "string") return MS_STORE_FALLBACK_URL;
  const trimmed = productId.trim();
  // Partner Center product IDs are 12 alphanumeric chars (e.g. 9NBLGGH4NNS1).
  // Any deviation falls back so a stale or malformed env var can't produce a
  // dead ms-windows-store URI.
  if (!/^[A-Za-z0-9]{12}$/.test(trimmed)) return MS_STORE_FALLBACK_URL;
  return `ms-windows-store://pdp/?ProductId=${trimmed}`;
}

function feedUrlForChannel(channel: "stable" | "nightly"): string {
  return channel === "nightly" ? NIGHTLY_FEED_URL : STABLE_FEED_URL;
}

// electron-builder publishes per-platform manifests; the notifier polls the
// Windows variant since this service only runs in Store builds.
function manifestUrl(feedUrl: string): string {
  return `${feedUrl}latest.yml`;
}

type CheckContext = "Initial" | "Periodic" | "Retry" | "Resume";

class WindowsStoreNotifierService {
  private checkInterval: NodeJS.Timeout | null = null;
  private startupJitterTimeout: NodeJS.Timeout | null = null;
  private retryTimeout: NodeJS.Timeout | null = null;
  private resumeTimeout: NodeJS.Timeout | null = null;
  private removeSuspendListener: (() => void) | null = null;
  private removeWakeListener: (() => void) | null = null;
  private retryCount = 0;
  private initialized = false;
  private handlersRegistered = false;
  // Tagged with its feed so a view opened after a channel switch, before the
  // next poll, isn't handed the previous channel's offer.
  private lastDetected: { update: DetectedStoreUpdate; feedUrl: string } | null = null;
  private activeFeedUrl: string | null = null;
  // Holds the ETag from a 200 response until the renderer confirms the user
  // has seen the notification (via DISMISS). If the app crashes before that
  // confirmation, we WANT the next launch to re-fetch the full body — storing
  // the ETag eagerly would let a future 304 silently suppress the version
  // forever (no broadcast, no lastNotifiedStoreVersion write).
  private pendingEtag: { version: string; etag: string; feedUrl: string } | null = null;
  // At most one manifest request runs at a time; triggers that land while it
  // is pending share it, so an older response can't overwrite a newer one.
  private inflightCheck: InflightCheck | null = null;

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

  // Same fail-closed posture as AutoUpdaterService: only the explicitly
  // catalogued transient signals retry. Anything else (404, cert error,
  // unknown net::ERR_) waits for the next 8-hour tick.
  private isTransientError(err: unknown): boolean {
    // Our own deadline — the same signal as net::ERR_TIMED_OUT.
    if (err instanceof TimeoutError) return true;
    let current: unknown = err;
    let foundTransient = false;
    for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string") {
        for (const match of message.matchAll(ELECTRON_NET_TOKEN_RE)) {
          const token = match[1];
          if (PERMANENT_NET_ERROR_TOKENS.has(token)) return false;
          if (TRANSIENT_NET_ERROR_TOKENS.has(token)) foundTransient = true;
        }
      }
      const statusCode = (current as { statusCode?: unknown }).statusCode;
      if (typeof statusCode === "number") {
        if (statusCode === 404 || statusCode === 401 || statusCode === 403) return false;
        if (statusCode >= 500 && statusCode < 600) foundTransient = true;
        if (statusCode === 408 || statusCode === 429) foundTransient = true;
      }
      current = (current as { cause?: unknown }).cause;
    }
    return foundTransient;
  }

  private scheduleRetry(): void {
    if (this.retryCount >= MAX_RETRIES) return;
    const base = RETRY_BASE_DELAYS_MS[this.retryCount];
    const jitterFactor = 0.8 + 0.4 * Math.random();
    const delay = Math.floor(base * jitterFactor);
    this.retryCount += 1;
    this.clearRetryTimeout();
    this.retryTimeout = setTimeout(() => {
      this.retryTimeout = null;
      void this.runCheck("Retry");
    }, delay);
  }

  private configuredFeedUrl(): string {
    return feedUrlForChannel(store.get("updateChannel") ?? "stable");
  }

  private setActiveFeedUrl(feedUrl: string): void {
    // Channel switched between polls — drop the prior ETag so we don't send
    // a stable-feed validator to the nightly feed (or vice versa), and the
    // offer that feed produced, which the new one may not carry. Retries the
    // old feed's failures earned don't count against the new one.
    if (this.activeFeedUrl && this.activeFeedUrl !== feedUrl) {
      try {
        store.delete("storeNotifierEtag");
      } catch {
        // Best-effort — corrupted store reads here shouldn't block polling.
      }
      // An undismissed notification from the old feed would otherwise commit
      // its validator back on DISMISS.
      this.pendingEtag = null;
      this.lastDetected = null;
      this.retryCount = 0;
    }
    this.activeFeedUrl = feedUrl;
  }

  private async fetchLatestVersion(
    feedUrl: string,
    cancelSignal: AbortSignal
  ): Promise<ManifestVersion | null> {
    const storedEtag = store.get("storeNotifierEtag");
    const headers: Record<string, string> = {};
    if (typeof storedEtag === "string" && storedEtag.length > 0) {
      headers["If-None-Match"] = storedEtag;
    }
    const deadline = timeoutSignal(FETCH_TIMEOUT_MS, cancelSignal);
    const release = new AbortController();
    try {
      const res = await untilAborted(
        net.fetch(manifestUrl(feedUrl), {
          headers,
          signal: AbortSignal.any([deadline.signal, release.signal]),
        }),
        deadline.signal
      );
      if (res.status === 304) return null;
      if (!res.ok) {
        // The status decides this; abort the unread body so a stalled one
        // can't hold the request open past the deadline's disposal.
        release.abort();
        const err: Error & { statusCode?: number } = new Error(
          `Manifest fetch failed: HTTP ${res.status}`
        );
        err.statusCode = res.status;
        throw err;
      }
      const text = await untilAborted(res.text(), deadline.signal);
      const parsed = parseYaml(text);
      if (typeof parsed !== "object" || parsed === null) return null;
      const version = (parsed as { version?: unknown }).version;
      if (typeof version !== "string") return null;
      const trimmed = version.trim();
      if (trimmed.length === 0 || trimmed.length > VERSION_MAX_LEN) return null;
      if (!VERSION_ALLOWLIST.test(trimmed)) return null;
      if (!semver.valid(trimmed)) return null;
      return { version: trimmed, etag: res.headers.get("etag") };
    } finally {
      deadline.dispose();
    }
  }

  private shouldNotify(remoteVersion: string): boolean {
    const installed = app.getVersion();
    // Compare full versions: coerce() drops prerelease identifiers, which would
    // hide nightly-to-nightly and nightly-to-stable updates.
    const installedSemver = semver.valid(installed);
    const remoteSemver = semver.valid(remoteVersion);
    if (!installedSemver || !remoteSemver) return false;
    if (!semver.gt(remoteSemver, installedSemver)) return false;
    const lastNotified = store.get("lastNotifiedStoreVersion");
    if (typeof lastNotified === "string" && lastNotified === remoteVersion) return false;
    return true;
  }

  private runCheck(context: CheckContext): Promise<void> {
    let feedUrl: string;
    try {
      feedUrl = this.configuredFeedUrl();
    } catch (err) {
      console.error(`[MAIN] ${context} Store update check failed:`, err);
      // Same as any non-transient failure, unless a running check owns the ladder.
      if (!this.inflightCheck) this.resetRetryState();
      return Promise.resolve();
    }
    const inflight = this.inflightCheck;
    if (inflight) {
      if (inflight.feedUrl === feedUrl) return inflight.promise;
      // The channel switched while that request was out: its answer (and its
      // ETag) belong to the old feed, so it must not land.
      this.cancelInflightCheck();
    }
    const controller = new AbortController();
    const promise = this.performCheck(context, feedUrl, controller.signal).finally(() => {
      if (this.inflightCheck?.controller === controller) this.inflightCheck = null;
    });
    this.inflightCheck = { feedUrl, controller, promise };
    return promise;
  }

  private cancelInflightCheck(): void {
    const inflight = this.inflightCheck;
    if (!inflight) return;
    this.inflightCheck = null;
    inflight.controller.abort();
  }

  private async performCheck(
    context: CheckContext,
    feedUrl: string,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const enabled = store.get("storeUpdateNotificationsEnabled") ?? true;
      if (!enabled) return;
      this.setActiveFeedUrl(feedUrl);
      const manifest = await this.fetchLatestVersion(feedUrl, signal);
      // Cancelled by dispose, suspend, the toggle, or a channel switch: the
      // canceller owns the timers and cached state now.
      if (signal.aborted) return;
      this.resetRetryState();
      // The channel moved while the request was in flight and nothing has
      // triggered a check since: its answer belongs to a feed the user has left.
      if (feedUrl !== this.configuredFeedUrl()) return;
      if (manifest === null) return;
      // Don't persist the ETag yet — see `pendingEtag` field comment. We pair
      // the version + ETag in memory so the DISMISS handler can commit them
      // together after the user has actually been shown the notification.
      this.pendingEtag = manifest.etag
        ? { version: manifest.version, etag: manifest.etag, feedUrl }
        : null;
      const remoteVersion = manifest.version;
      if (!this.shouldNotify(remoteVersion)) return;
      // Re-check the toggle after the fetch resolves — a user who flipped the
      // switch off during the network round-trip shouldn't still see a toast.
      const stillEnabled = store.get("storeUpdateNotificationsEnabled") ?? true;
      if (!stillEnabled) {
        this.pendingEtag = null;
        return;
      }
      const detected: DetectedStoreUpdate = {
        version: remoteVersion,
        storeUrl: buildStoreUrl(),
      };
      this.lastDetected = { update: detected, feedUrl };
      broadcastToRenderer(CHANNELS.STORE_UPDATE_AVAILABLE, detected);
    } catch (err) {
      if (signal.aborted) return;
      console.error(`[MAIN] ${context} Store update check failed:`, err);
      if (!this.isTransientError(err)) {
        this.resetRetryState();
        return;
      }
      if (this.retryCount >= MAX_RETRIES) {
        this.resetRetryState();
        return;
      }
      this.scheduleRetry();
    }
  }

  /** Test-only seam: trigger a manual check (bypasses the jitter timer). */
  _checkNowForTest(): Promise<void> {
    return this.runCheck("Initial");
  }

  getLastDetectedUpdate(): DetectedStoreUpdate | null {
    const cached = this.lastDetected;
    if (!cached || cached.feedUrl !== this.configuredFeedUrl()) return null;
    return cached.update;
  }

  initialize(): void {
    if (this.initialized) return;

    // Register the settings handlers unconditionally so non-Store renderers
    // that import the preload binding never see `undefined` returns. The
    // getter/setter just touch electron-store and don't depend on polling.
    if (!this.handlersRegistered) {
      ipcMain.handle(CHANNELS.STORE_UPDATE_GET_SETTINGS, () => {
        const enabled = store.get("storeUpdateNotificationsEnabled") ?? true;
        return { enabled };
      });

      ipcMain.handle(CHANNELS.STORE_UPDATE_SET_SETTINGS, (event, enabled: unknown) => {
        const senderUrl = event.senderFrame?.url;
        if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
          return { enabled: store.get("storeUpdateNotificationsEnabled") ?? true };
        }
        const validated = typeof enabled === "boolean" ? enabled : true;
        store.set("storeUpdateNotificationsEnabled", validated);
        if (!validated) {
          // Stop polling and drop the cached detection so a re-enable doesn't
          // immediately fire a stale notification.
          this.cancelInflightCheck();
          this.resetRetryState();
          this.lastDetected = null;
          this.pendingEtag = null;
        }
        return { enabled: validated };
      });

      ipcMain.handle(CHANNELS.STORE_UPDATE_GET_LATEST, () => {
        return this.getLastDetectedUpdate();
      });

      ipcMain.handle(CHANNELS.STORE_UPDATE_DISMISS, (event, version: unknown) => {
        const senderUrl = event.senderFrame?.url;
        if (!senderUrl || !isTrustedRendererUrl(senderUrl)) return;
        if (typeof version !== "string") return;
        const trimmed = version.trim();
        if (trimmed.length === 0 || trimmed.length > VERSION_MAX_LEN) return;
        if (!VERSION_ALLOWLIST.test(trimmed)) return;
        if (!semver.valid(trimmed)) return;
        store.set("lastNotifiedStoreVersion", trimmed);
        // Commit the paired ETag now that the user has been notified. If a
        // mid-flight crash had wiped this in-memory state, we'd have re-
        // fetched the full body on next launch instead of being suppressed
        // forever by a stored ETag for an un-dismissed version.
        const pending = this.pendingEtag;
        if (pending && pending.version === trimmed) {
          this.pendingEtag = null;
          try {
            // A validator from a feed the user has since left must never be
            // sent to the one they switched to.
            if (pending.feedUrl === this.configuredFeedUrl()) {
              store.set("storeNotifierEtag", pending.etag);
            }
          } catch {
            // Best-effort — a write failure means we re-fetch the body next
            // tick. Version compare still works via lastNotifiedStoreVersion.
          }
        }
      });

      this.handlersRegistered = true;
    }

    if (!isWindowsStoreBuild()) {
      console.log("[MAIN] Store update notifier inactive: not a Windows Store build");
      return;
    }

    if (!app.isPackaged) {
      console.log("[MAIN] Store update notifier inactive: not packaged");
      return;
    }

    try {
      const startupJitterMs = Math.floor(Math.random() * STARTUP_JITTER_MAX_MS);
      this.startupJitterTimeout = setTimeout(() => {
        this.startupJitterTimeout = null;
        void this.runCheck("Initial");
      }, startupJitterMs);

      this.checkInterval = setInterval(() => {
        void this.runCheck("Periodic");
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
          // A request held across sleep fails on wake and would schedule a
          // retry beside the resume check; wake starts a fresh one instead.
          this.cancelInflightCheck();
          this.resetRetryState();
        });
        this.removeWakeListener = getSystemSleepService().onWake(() => {
          if (this.resumeTimeout || this.checkInterval) return;
          this.resumeTimeout = setTimeout(() => {
            this.resumeTimeout = null;
            void this.runCheck("Resume");
            if (!this.checkInterval) {
              this.checkInterval = setInterval(() => {
                void this.runCheck("Periodic");
              }, CHECK_INTERVAL_MS);
            }
          }, RESUME_CHECK_DELAY_MS);
        });
      } catch {
        // SystemSleepService not initialized — periodic timer covers the gap.
      }

      this.initialized = true;
      console.log("[MAIN] Windows Store update notifier initialized");
    } catch (err) {
      console.error("[MAIN] Windows Store notifier initialization failed:", err);
      this.dispose();
    }
  }

  dispose(): void {
    this.cancelInflightCheck();
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
    this.retryCount = 0;
    if (this.removeSuspendListener) {
      this.removeSuspendListener();
      this.removeSuspendListener = null;
    }
    if (this.removeWakeListener) {
      this.removeWakeListener();
      this.removeWakeListener = null;
    }
    try {
      ipcMain.removeHandler(CHANNELS.STORE_UPDATE_GET_SETTINGS);
    } catch {
      // Handler may not have been registered.
    }
    try {
      ipcMain.removeHandler(CHANNELS.STORE_UPDATE_SET_SETTINGS);
    } catch {
      // Handler may not have been registered.
    }
    try {
      ipcMain.removeHandler(CHANNELS.STORE_UPDATE_GET_LATEST);
    } catch {
      // Handler may not have been registered.
    }
    try {
      ipcMain.removeHandler(CHANNELS.STORE_UPDATE_DISMISS);
    } catch {
      // Handler may not have been registered.
    }
    this.handlersRegistered = false;
    this.lastDetected = null;
    this.activeFeedUrl = null;
    this.pendingEtag = null;
    this.initialized = false;
  }
}

export const windowsStoreNotifierService = new WindowsStoreNotifierService();
export { buildStoreUrl, MS_STORE_FALLBACK_URL, FETCH_TIMEOUT_MS };
