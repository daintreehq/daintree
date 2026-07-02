// eager-import-allow: reads opt-in config via store.get synchronously; the heavy
// PluginService is lazy-imported inside the pass, never at module load.
import { powerMonitor } from "electron";
import type {
  PluginBackgroundUpdateCheckResult,
  PluginBackgroundUpdateCheckSettings,
  PluginBackgroundUpdateEntry,
} from "../../shared/types/plugin.js";
import { store } from "../store.js";
import { getSystemSleepService } from "./SystemSleepService.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import { logInfo, logError } from "../utils/logger.js";

// Daily cadence. A URL re-fetch of every installed plugin is cheap but not free,
// so once a day is the coarsest useful granularity for "an update landed."
const DAILY_MS = 24 * 60 * 60 * 1000;
// Wall-clock revalidation tick. A bare 24h setInterval doesn't "catch up" across
// sleep, so we tick hourly and compare `lastCheckedAt` against the wall clock —
// the interval is a heartbeat, the timestamp is the source of truth.
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const IDLE_THRESHOLD_S = 60; // 60s of system idle before a background pass
const INITIAL_CHECK_DELAY_MS = 10_000; // let startup settle before the first pass
const RESUME_CHECK_DELAY_MS = 7_000; // let the OS stabilize after wake
// Chromium caps ~6 connections/host and each check streams an archive to a temp
// dir, so an unbounded Promise.all would exhaust the socket pool and spike memory.
const CONCURRENCY = 2;

/**
 * PluginUpdateCheckService — opt-in periodic background update check for all
 * URL-installed plugins (#10893).
 *
 * Reuses the existing lock-free `PluginService.checkForUpdate` (the #9297 manual
 * mechanism) per plugin with a small concurrency cap, collects the `available`
 * results, and — when any are found — broadcasts one batched event that the
 * renderer turns into a single low-priority inbox notification. It never
 * installs; the user still confirms each reinstall through the manager's
 * capability-diff flow.
 *
 * @pattern Factory/Accessor Methods
 *
 * Structurally mirrors {@link IdleBackgroundAutoCloseService} (opt-in config in
 * electron-store, off by default, start/stop on toggle) and
 * {@link WindowsStoreNotifierService} (main-side `lastDetected` cache for
 * late-subscriber hydration, resume-triggered revalidation). Defaults OFF.
 */
export class PluginUpdateCheckService {
  private checkInterval: NodeJS.Timeout | null = null;
  private initialCheckTimer: NodeJS.Timeout | null = null;
  private resumeTimeout: NodeJS.Timeout | null = null;
  private removeSuspendListener: (() => void) | null = null;
  private removeWakeListener: (() => void) | null = null;
  private inFlight = false;
  private inFlightPromise: Promise<void> | null = null;
  private disposed = false;
  private lastDetected: PluginBackgroundUpdateCheckResult | null = null;

  getSettings(): PluginBackgroundUpdateCheckSettings {
    const raw = store.get("pluginBackgroundUpdateCheck");
    return {
      enabled: typeof raw?.enabled === "boolean" ? raw.enabled : false,
    };
  }

  private getLastCheckedAt(): number | null {
    const raw = store.get("pluginBackgroundUpdateCheck");
    return typeof raw?.lastCheckedAt === "number" ? raw.lastCheckedAt : null;
  }

  private setLastCheckedAt(value: number | null): void {
    const raw = store.get("pluginBackgroundUpdateCheck");
    store.set("pluginBackgroundUpdateCheck", {
      enabled: typeof raw?.enabled === "boolean" ? raw.enabled : false,
      lastCheckedAt: value,
    });
  }

  updateSettings(
    patch: Partial<PluginBackgroundUpdateCheckSettings>
  ): PluginBackgroundUpdateCheckSettings {
    const current = this.getSettings();
    const next: PluginBackgroundUpdateCheckSettings = {
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    };
    store.set("pluginBackgroundUpdateCheck", {
      enabled: next.enabled,
      lastCheckedAt: this.getLastCheckedAt(),
    });

    if (next.enabled) {
      this.start();
    } else {
      // Drop the cached detection so a re-enable doesn't immediately re-surface
      // a stale set the user already dismissed.
      this.lastDetected = null;
      this.stop();
    }
    logInfo("plugin-update-check-settings-updated", { enabled: next.enabled });
    return next;
  }

  getLatest(): PluginBackgroundUpdateCheckResult | null {
    return this.lastDetected;
  }

  /** Idempotent. Installs the revalidation tick + wake listener when enabled. */
  start(): void {
    if (this.disposed) return;
    if (!this.getSettings().enabled) return;

    if (!this.initialCheckTimer && !this.checkInterval) {
      this.initialCheckTimer = setTimeout(() => {
        this.initialCheckTimer = null;
        void this.maybeRunDue("Initial");
      }, INITIAL_CHECK_DELAY_MS);
    }

    if (!this.checkInterval) {
      this.checkInterval = setInterval(() => {
        void this.maybeRunDue("Periodic");
      }, CHECK_INTERVAL_MS);
    }

    try {
      this.removeSuspendListener ??= getSystemSleepService().onSuspend(() => {
        if (this.checkInterval) {
          clearInterval(this.checkInterval);
          this.checkInterval = null;
        }
        if (this.resumeTimeout) {
          clearTimeout(this.resumeTimeout);
          this.resumeTimeout = null;
        }
      });
      this.removeWakeListener ??= getSystemSleepService().onWake(() => {
        if (this.resumeTimeout) return;
        this.resumeTimeout = setTimeout(() => {
          this.resumeTimeout = null;
          void this.maybeRunDue("Resume");
          if (!this.checkInterval && !this.disposed && this.getSettings().enabled) {
            this.checkInterval = setInterval(() => {
              void this.maybeRunDue("Periodic");
            }, CHECK_INTERVAL_MS);
          }
        }, RESUME_CHECK_DELAY_MS);
      });
    } catch {
      // SystemSleepService may not be initialized yet — the periodic tick covers it.
    }
    logInfo("plugin-update-check-started");
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.initialCheckTimer) {
      clearTimeout(this.initialCheckTimer);
      this.initialCheckTimer = null;
    }
    if (this.resumeTimeout) {
      clearTimeout(this.resumeTimeout);
      this.resumeTimeout = null;
    }
    if (this.removeSuspendListener) {
      this.removeSuspendListener();
      this.removeSuspendListener = null;
    }
    if (this.removeWakeListener) {
      this.removeWakeListener();
      this.removeWakeListener = null;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    if (this.inFlightPromise) {
      try {
        await this.inFlightPromise;
      } catch {
        // Each plugin's check is isolated in runPass(); nothing to add here.
      }
    }
    this.lastDetected = null;
    logInfo("plugin-update-check-disposed");
  }

  /**
   * Gate a pass on enabled + not-disposed + not-in-flight + system-idle + due
   * (wall-clock elapsed since `lastCheckedAt` ≥ 24h). Public so tests can drive
   * it without flushing timers.
   */
  async maybeRunDue(context: "Initial" | "Periodic" | "Resume"): Promise<void> {
    if (this.disposed || this.inFlight) return;
    if (!this.getSettings().enabled) return;

    try {
      if (powerMonitor.getSystemIdleTime() < IDLE_THRESHOLD_S) return;
    } catch {
      // powerMonitor may not be ready (early startup / Wayland) — skip this tick.
      return;
    }

    const last = this.getLastCheckedAt();
    if (last !== null && Date.now() - last < DAILY_MS) return;

    await this.runPassGuarded(context);
  }

  /** Test seam: run a pass now, bypassing the idle + due gates (respects enabled). */
  async _checkNowForTest(): Promise<void> {
    if (this.disposed || !this.getSettings().enabled) return;
    await this.runPassGuarded("Periodic");
  }

  private async runPassGuarded(context: "Initial" | "Periodic" | "Resume"): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    this.inFlightPromise = this.runPass(context);
    try {
      await this.inFlightPromise;
    } finally {
      this.inFlight = false;
      this.inFlightPromise = null;
    }
  }

  private async runPass(context: "Initial" | "Periodic" | "Resume"): Promise<void> {
    // `null` means the pass aborted before checking (disabled/disposed mid-init)
    // — don't touch lastCheckedAt or the cache. `inconclusive` is true when the
    // pass couldn't fully determine status (import/list threw, or a per-plugin
    // fetch failed), so a partial-failure pass doesn't clear a valid cache.
    let outcome: { updates: PluginBackgroundUpdateEntry[]; inconclusive: boolean } | null;
    try {
      outcome = await this.collectUpdates();
    } catch (err) {
      logError("plugin-update-check-pass-failed", err);
      // A hard failure still persists lastCheckedAt (below) so it doesn't
      // retry-storm on every tick, but is inconclusive so the cache survives.
      outcome = { updates: [], inconclusive: true };
    }

    if (outcome === null) return;

    // Persist the pass timestamp even on partial fetch failures — the next pass
    // is a day out regardless, matching the daily cadence.
    this.setLastCheckedAt(Date.now());

    // Re-check after the awaited checks: a toggle-off (updateSettings) or dispose
    // during the network round-trip must not resurrect a broadcast or a cache
    // entry it already cleared.
    if (this.disposed || !this.getSettings().enabled) return;

    const { updates, inconclusive } = outcome;
    if (updates.length === 0) {
      // A conclusive empty pass supersedes any cached detection so a
      // late-mounting renderer doesn't hydrate an already-resolved update. Keep
      // the cache when the pass was inconclusive — we genuinely don't know.
      if (!inconclusive) this.lastDetected = null;
      return;
    }

    const result: PluginBackgroundUpdateCheckResult = {
      checkedAt: Date.now(),
      updates,
      signature: computeSignature(updates),
    };
    this.lastDetected = result;
    logInfo("plugin-update-check-available", { count: updates.length, context });
    try {
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
        name: "plugin:bg-update-available",
        payload: result,
      });
    } catch {
      // All windows may be closing.
    }
  }

  /**
   * Resolve the plugin service, gather URL-installed targets, and check them.
   * Returns `null` when the pass should abort without touching state (disabled
   * or disposed mid-init); otherwise the available updates + whether the pass
   * was inconclusive (any per-plugin fetch failure).
   */
  private async collectUpdates(): Promise<{
    updates: PluginBackgroundUpdateEntry[];
    inconclusive: boolean;
  } | null> {
    const { pluginService } = await import("./PluginService.js");
    try {
      await pluginService.waitForInit();
    } catch {
      // If init never settled the list read below simply returns what's loaded.
    }
    // Re-check enabled after the async init — a toggle-off mid-wait aborts.
    if (this.disposed || !this.getSettings().enabled) return null;

    const targets = pluginService
      .listPlugins()
      .filter((p) => !p.isBuiltin && !!p.originalUrl && !!p.archiveHash)
      .map((p) => p.manifest.name);

    const { found, hadError } = await this.checkAll(pluginService, targets);
    return { updates: found, inconclusive: hadError };
  }

  /**
   * Bounded worker-pool over the plugin ids; collects only `available` results.
   * `hadError` is true if any per-plugin check threw, so the caller can tell a
   * clean "nothing available" pass from one that couldn't determine status.
   */
  private async checkAll(
    pluginService: typeof import("./PluginService.js").pluginService,
    ids: string[]
  ): Promise<{ found: PluginBackgroundUpdateEntry[]; hadError: boolean }> {
    const found: PluginBackgroundUpdateEntry[] = [];
    // Ids we couldn't determine this pass (fetch-failed or threw). Collected as
    // a pushed-to array (like `found`) so the caller can tell a clean "nothing
    // available" pass from an inconclusive one.
    const failedIds: string[] = [];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < ids.length) {
        if (this.disposed || !this.getSettings().enabled) return;
        const id = ids[cursor++];
        try {
          const result = await pluginService.checkForUpdate(id);
          if (result.status === "available") {
            found.push({
              pluginId: id,
              displayName: result.displayName ?? result.name,
              version: result.version,
              capabilities: result.capabilities,
            });
          } else if (result.status === "fetch-failed") {
            failedIds.push(id);
          }
        } catch (err) {
          // Isolate per plugin — one failed fetch never aborts the batch.
          failedIds.push(id);
          logError("plugin-update-check-single-failed", err, { pluginId: id });
        }
      }
    };

    const pool = Math.min(CONCURRENCY, Math.max(ids.length, 1));
    await Promise.all(Array.from({ length: pool }, () => worker()));
    return { found, hadError: failedIds.length > 0 };
  }
}

/** Deterministic digest of the update set so repeated passes dedupe to one row. */
function computeSignature(updates: PluginBackgroundUpdateEntry[]): string {
  return updates
    .map((u) => `${u.pluginId}@${u.version}`)
    .sort()
    .join(",");
}

let instance: PluginUpdateCheckService | null = null;

export function getPluginUpdateCheckService(): PluginUpdateCheckService {
  if (!instance) {
    instance = new PluginUpdateCheckService();
  }
  return instance;
}
