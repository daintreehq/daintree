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
import type { PluginCatalogUpdateSource } from "./plugin/PluginCatalogService.js";

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
// A pass where every check failed (offline) must not burn the daily slot, but
// retrying on every hourly tick while the network stays down would hammer the
// registry the moment it returns. Back off from the base, doubling per
// consecutive failed pass, up to a ceiling well under the daily cadence.
const RETRY_BASE_MS = 30 * 60 * 1000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;

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
  // In-memory on purpose: a restart is a fresh attempt, and the persisted
  // `lastCheckedAt` stays a record of the last pass that actually answered.
  private consecutiveFailedPasses = 0;
  private retryNotBefore = 0;
  // Bumped by stop(): a pass still in flight across an off/on toggle must not arm
  // a backoff on the service the user just re-enabled.
  private generation = 0;

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
    this.generation += 1;
    this.resetRetryBackoff();
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
   * (wall-clock elapsed since `lastCheckedAt` ≥ 24h) + not inside the backoff
   * window left by a pass where every check failed. Public so tests can drive
   * it without flushing timers.
   */
  async maybeRunDue(context: "Initial" | "Periodic" | "Resume"): Promise<void> {
    if (this.disposed || this.inFlight) return;
    if (!this.getSettings().enabled) return;
    // A wait longer than the ceiling can only mean the wall clock moved backwards.
    const retryWaitMs = this.retryNotBefore - Date.now();
    if (retryWaitMs > 0 && retryWaitMs <= RETRY_MAX_MS) return;

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
    // `failedEntirely` is the narrower case where nothing was learned at all.
    const generation = this.generation;
    let outcome: PassOutcome | null;
    try {
      outcome = await this.collectUpdates();
    } catch (err) {
      logError("plugin-update-check-pass-failed", err);
      outcome = { updates: [], inconclusive: true, unchecked: null, failedEntirely: true };
    }

    if (outcome === null) return;

    // A pass that learned something, even partially, is the day's check. One
    // that learned nothing leaves lastCheckedAt alone so a later idle tick
    // retries once the backoff window passes, instead of waiting a full day.
    if (!outcome.failedEntirely) {
      this.resetRetryBackoff();
      this.setLastCheckedAt(Date.now());
    }

    // Re-check after the awaited checks: a toggle-off (updateSettings) or dispose
    // during the network round-trip must not resurrect a broadcast or a cache
    // entry it already cleared.
    if (this.disposed || !this.getSettings().enabled) return;

    if (outcome.failedEntirely && generation === this.generation) this.scheduleRetry(context);

    const { updates: fresh, inconclusive, unchecked } = outcome;
    if (fresh.length === 0) {
      // A conclusive empty pass supersedes any cached detection so a
      // late-mounting renderer doesn't hydrate an already-resolved update. Keep
      // the cache when the pass was inconclusive — we genuinely don't know.
      if (!inconclusive) this.lastDetected = null;
      // Otherwise only the offers this pass couldn't check again survive: one it
      // did check found no update, current or delisted (#16781).
      else if (this.lastDetected && unchecked) {
        this.lastDetected = keepUnchecked(this.lastDetected, unchecked);
      }
      return;
    }

    // A plugin this pass couldn't check keeps its last known offer beside the
    // fresh ones, the same rule as the empty branch above (#17444).
    let updates = fresh;
    if (inconclusive && this.lastDetected && unchecked) {
      updates = [...fresh, ...this.lastDetected.updates.filter((u) => unchecked.has(u.pluginId))];
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

  private scheduleRetry(context: "Initial" | "Periodic" | "Resume"): void {
    const delayMs = Math.min(RETRY_BASE_MS * 2 ** this.consecutiveFailedPasses, RETRY_MAX_MS);
    this.consecutiveFailedPasses += 1;
    this.retryNotBefore = Date.now() + delayMs;
    logInfo("plugin-update-check-retry-scheduled", {
      delayMs,
      failedPasses: this.consecutiveFailedPasses,
      context,
    });
  }

  private resetRetryBackoff(): void {
    this.consecutiveFailedPasses = 0;
    this.retryNotBefore = 0;
  }

  /**
   * Resolve the plugin service, gather URL-installed targets, and check them.
   * Returns `null` when the pass should abort without touching state (disabled
   * or disposed mid-init); otherwise the available updates + whether the pass
   * was inconclusive (any per-plugin fetch failure) or failed entirely (it had
   * targets and none of them could be checked).
   */
  private async collectUpdates(): Promise<PassOutcome | null> {
    const { pluginService } = await import("./PluginService.js");
    try {
      await pluginService.waitForCatalog();
    } catch {
      // If init never settled the list read below simply returns what's loaded.
    }
    // Re-check enabled after the async init — a toggle-off mid-wait aborts.
    if (this.disposed || !this.getSettings().enabled) return null;

    // The registry can list one plugin twice while a re-enable is in flight (running
    // and disabled rows). One check per id keeps a plugin out of both `found` and
    // `failedIds`, so a fresh offer never sits beside its own cached version.
    const targets = [
      ...new Set(
        pluginService
          .listPlugins()
          // A catalog install is checked against the catalog, not its URL (#16781).
          .filter(
            (p) => !p.isBuiltin && (p.source === "catalog" || (!!p.originalUrl && !!p.archiveHash))
          )
          .map((p) => p.manifest.name)
      ),
    ];

    const { found, failedIds } = await this.checkAll(pluginService, targets);
    return {
      updates: found,
      inconclusive: failedIds.length > 0,
      unchecked: new Set(failedIds),
      failedEntirely: targets.length > 0 && failedIds.length === targets.length,
    };
  }

  /**
   * Bounded worker-pool over the plugin ids; collects only `available` results.
   * `failedIds` names every plugin whose check failed or threw, so the caller can
   * tell a clean "nothing available" pass from one that couldn't determine status.
   */
  private async checkAll(
    pluginService: typeof import("./PluginService.js").pluginService,
    ids: string[]
  ): Promise<{ found: PluginBackgroundUpdateEntry[]; failedIds: string[] }> {
    const found: PluginBackgroundUpdateEntry[] = [];
    // Ids we couldn't determine this pass (fetch-failed or threw). Collected as
    // a pushed-to array (like `found`) so the caller can tell a clean "nothing
    // available" pass from an inconclusive one.
    const failedIds: string[] = [];
    let cursor = 0;
    // Every catalog install in the pass reads one catalog rather than fetching
    // its own (#17805). Opened by the first catalog lookup, whatever the list
    // said, so a pass with no catalog install never loads the catalog client.
    // A catalog the person added gets its own (#17434), so no install is ever
    // checked against another catalog than the one it came from.
    const added = new Map<string, PluginCatalogUpdateSource>();
    const options = {
      catalog: passCatalog(),
      catalogFor: (sourceUrl: string) => {
        let catalog = added.get(sourceUrl);
        if (!catalog) {
          catalog = passCatalog(sourceUrl);
          added.set(sourceUrl, catalog);
        }
        return catalog;
      },
    };

    const worker = async (): Promise<void> => {
      while (cursor < ids.length) {
        if (this.disposed || !this.getSettings().enabled) return;
        const id = ids[cursor++];
        try {
          const result = await pluginService.checkForUpdate(id, options);
          if (result.status === "available") {
            found.push({
              pluginId: id,
              displayName: result.displayName ?? result.name,
              version: result.version,
              capabilities: result.capabilities,
            });
          } else if (result.status === "fetch-failed" || result.status === "catalog-unavailable") {
            failedIds.push(id);
          }
          // A delisted plugin is neither an update nor a failed check: nothing
          // newer is listed, and the installed copy keeps running.
        } catch (err) {
          // Isolate per plugin — one failed fetch never aborts the batch.
          failedIds.push(id);
          logError("plugin-update-check-single-failed", err, { pluginId: id });
        }
      }
    };

    const pool = Math.min(CONCURRENCY, Math.max(ids.length, 1));
    await Promise.all(Array.from({ length: pool }, () => worker()));
    return { found, failedIds };
  }
}

/**
 * What a pass found. `unchecked` names the plugins it couldn't check, or is
 * `null` when the pass failed before it knew which. `failedEntirely` is set when
 * the pass threw, or every plugin it tried to check failed.
 */
interface PassOutcome {
  updates: PluginBackgroundUpdateEntry[];
  inconclusive: boolean;
  unchecked: ReadonlySet<string> | null;
  failedEntirely: boolean;
}

/** One pass's copy of a catalog (Daintree's own when `sourceUrl` is omitted), opened on its first lookup. */
function passCatalog(sourceUrl?: string): PluginCatalogUpdateSource {
  let batch: Promise<PluginCatalogUpdateSource> | null = null;
  return {
    lookupUpdate: async (id, installedVersion) => {
      batch ??= import("./plugin/PluginCatalogService.js").then((m) =>
        m.getPluginCatalogService(sourceUrl).openUpdateBatch()
      );
      return (await batch).lookupUpdate(id, installedVersion);
    },
  };
}

/** The cached result cut down to the plugins a pass couldn't check, or `null` when none is left. */
function keepUnchecked(
  cached: PluginBackgroundUpdateCheckResult,
  unchecked: ReadonlySet<string>
): PluginBackgroundUpdateCheckResult | null {
  const updates = cached.updates.filter((u) => unchecked.has(u.pluginId));
  if (updates.length === cached.updates.length) return cached;
  return updates.length === 0 ? null : { ...cached, updates, signature: computeSignature(updates) };
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
