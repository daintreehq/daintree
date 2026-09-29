import type {
  PluginDurationStats,
  PluginRendererMetricsReport,
  PluginViewLoadSample,
} from "@shared/types/pluginMetrics";
import { stripPluginViewGeneration } from "@shared/utils/pluginViewUrl";

/**
 * Renderer-side cost observations for plugin views, per project view context.
 *
 * Everything here is an observation: a long frame that overlapped a plugin's
 * commit says the plugin was active during the stall, not that it caused it.
 * A later phase drains the pending deltas to main; until then the local
 * snapshot serves tests and any in-renderer fallback UI.
 *
 * Drain protocol: `subscribe` fires once when the first delta lands after a
 * drain (schedule a lazy drain); `onDrainRequested` fires once per drain
 * window when any plugin's pending buffer reaches its high-water mark (drain
 * now, before the buffer starts sampling or dropping). Both are reset by
 * `drainReports`.
 */

type LongFrame = PluginRendererMetricsReport["longFrames"][number];

/** Pending commit durations kept between drains; beyond this the window is sampled. */
export const MAX_PENDING_COMMITS = 512;
/** Pending view loads and long frames kept between drains; oldest drop first. */
export const MAX_PENDING_VIEW_LOADS = 32;
export const MAX_PENDING_LONG_FRAMES = 128;
/** View loads the local snapshot remembers across drains. */
export const MAX_RECENT_VIEW_LOADS = 20;
/** Commit durations the local snapshot's rolling stats cover. */
const LOCAL_COMMIT_WINDOW = 256;
/**
 * Fraction of a pending cap at which `onDrainRequested` fires, leaving room for
 * the drainer to run before sampling (commits) or dropping (long frames, loads)
 * begins.
 */
const HIGH_WATER_RATIO = 0.75;
const COMMIT_HIGH_WATER = Math.floor(MAX_PENDING_COMMITS * HIGH_WATER_RATIO);
const VIEW_LOAD_HIGH_WATER = Math.floor(MAX_PENDING_VIEW_LOADS * HIGH_WATER_RATIO);
const LONG_FRAME_HIGH_WATER = Math.floor(MAX_PENDING_LONG_FRAMES * HIGH_WATER_RATIO);
/**
 * Plugins and `plugin://` authorities remembered. Past the cap, the least
 * recently active plugins with no open view and nothing pending go first.
 */
export const MAX_TRACKED_PLUGINS = 64;
const MAX_TRACKED_AUTHORITIES = 64;
/**
 * Recent commit times kept for long-frame attribution. Long animation frames
 * are delivered within a frame or two of the work, so a short ring is enough,
 * and a fixed one keeps `recordCommit` allocation-free.
 */
const COMMIT_WINDOW_RING = 64;
/** Replaced generations remembered per plugin, so a straggler from one is dropped. */
const MAX_RETIRED_GENERATIONS = 8;

/**
 * The plugin load a view belongs to, read off its module URL (see
 * {@link generationOfViewUrl}).
 */
export interface PluginViewGeneration {
  /** The `plugin://` authority: main mints one per load and never reissues it. */
  token: string;
  /**
   * The URL's `__dtv-N` view generation, which main allocates from one
   * monotonic counter, so a later load always has a larger one. `null` when
   * the URL carries none.
   */
  order: number | null;
}

/** A drained report and the load it was observed against (`null`: none reported one). */
export interface TaggedPluginReport {
  generation: string | null;
  report: PluginRendererMetricsReport;
}

interface PluginEntry {
  /**
   * The plugin load these observations belong to: the `plugin://` authority
   * its views were served from. `null` until a view reports one.
   */
  generation: string | null;
  /** The {@link PluginViewGeneration.order} that load was first seen with. */
  generationOrder: number | null;
  pendingLoads: PluginViewLoadSample[];
  pendingCommits: number[];
  /** Commits seen this drain window, including any the reservoir dropped. */
  pendingCommitsSeen: number;
  pendingCommitMax: number;
  pendingLongFrames: LongFrame[];
  pendingLongFramesDropped: number;
  pendingLongFramesDroppedBlockingMs: number;
  recentLoads: PluginViewLoadSample[];
  localCommits: Float64Array;
  localCommitCount: number;
  localCommitLast: number;
  longFrameCount: number;
  longFrameBlockingMs: number;
  longFrameLastAt: number | null;
}

export interface PluginViewLocalSnapshot {
  pluginId: string;
  viewLoads: PluginViewLoadSample[];
  viewCommits: PluginDurationStats | null;
  longFrames: { count: number; totalBlockingMs: number; lastAt: number | null };
}

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function pushBounded<T>(list: T[], item: T, cap: number): void {
  list.push(item);
  if (list.length > cap) list.splice(0, list.length - cap);
}

export function createPluginViewMetrics() {
  const plugins = new Map<string, PluginEntry>();
  const dirty = new Set<string>();
  const listeners = new Set<() => void>();
  const drainRequestListeners = new Set<() => void>();
  let drainRequested = false;
  /** `plugin://` authority → plugin id, learned from the URLs views load from. */
  const authorities = new Map<string, string>();

  const commitTimes = new Float64Array(COMMIT_WINDOW_RING);
  const windowPlugins: (string | undefined)[] = new Array(COMMIT_WINDOW_RING);
  let windowCursor = 0;
  let windowCount = 0;

  /** Mounted plugin views, per plugin. Long frames are only attributed while any are open. */
  const openViews = new Map<string, number>();
  let openViewCount = 0;
  /** Bumped by `reset()`, so a release closure from before it cannot touch the new counts. */
  let resetEpoch = 0;
  /** Generations each plugin has moved past, newest last. */
  const retiredGenerations = new Map<string, string[]>();

  /**
   * Drop the least recently active closed, drained plugins until the cap holds.
   * Open and pending entries are never dropped, so the map can briefly exceed
   * the cap; the next drain or view release brings it back. `keep` protects an
   * entry that has just been created and not yet written to.
   */
  function evictIdlePlugins(keep?: string): void {
    if (plugins.size <= MAX_TRACKED_PLUGINS) return;
    for (const pluginId of plugins.keys()) {
      if (plugins.size <= MAX_TRACKED_PLUGINS) return;
      if (pluginId === keep || openViews.has(pluginId) || dirty.has(pluginId)) continue;
      plugins.delete(pluginId);
    }
  }

  function entryFor(pluginId: string): PluginEntry {
    let entry = plugins.get(pluginId);
    if (!entry) {
      entry = {
        generation: null,
        generationOrder: null,
        pendingLoads: [],
        pendingCommits: [],
        pendingCommitsSeen: 0,
        pendingCommitMax: 0,
        pendingLongFrames: [],
        pendingLongFramesDropped: 0,
        pendingLongFramesDroppedBlockingMs: 0,
        recentLoads: [],
        localCommits: new Float64Array(LOCAL_COMMIT_WINDOW),
        localCommitCount: 0,
        localCommitLast: 0,
        longFrameCount: 0,
        longFrameBlockingMs: 0,
        longFrameLastAt: null,
      };
      plugins.set(pluginId, entry);
      evictIdlePlugins(pluginId);
    }
    return entry;
  }

  function isRetired(pluginId: string, generation: string): boolean {
    return retiredGenerations.get(pluginId)?.includes(generation) === true;
  }

  /**
   * Retire everything observed under the plugin's previous load: it was
   * replaced, and main would reject those numbers anyway. The local snapshot
   * restarts too, the way main's evicted metrics do.
   */
  function rememberRetired(pluginId: string, generation: string): void {
    let retired = retiredGenerations.get(pluginId);
    if (!retired) {
      retired = [];
      retiredGenerations.set(pluginId, retired);
      if (retiredGenerations.size > MAX_TRACKED_PLUGINS) {
        const oldest = retiredGenerations.keys().next().value;
        if (oldest !== undefined && oldest !== pluginId) retiredGenerations.delete(oldest);
      }
    }
    if (!retired.includes(generation)) pushBounded(retired, generation, MAX_RETIRED_GENERATIONS);
    // The old load's scripts can outlive it (a timer in a module that was
    // never evicted), but their frames are no longer this plugin's to count.
    if (authorities.get(generation) === pluginId) authorities.delete(generation);
  }

  function retire(pluginId: string, entry: PluginEntry): void {
    if (entry.generation !== null) rememberRetired(pluginId, entry.generation);
    entry.pendingLoads = [];
    entry.pendingCommits = [];
    entry.pendingCommitsSeen = 0;
    entry.pendingCommitMax = 0;
    entry.pendingLongFrames = [];
    entry.pendingLongFramesDropped = 0;
    entry.pendingLongFramesDroppedBlockingMs = 0;
    entry.recentLoads = [];
    entry.localCommitCount = 0;
    entry.localCommitLast = 0;
    entry.longFrameCount = 0;
    entry.longFrameBlockingMs = 0;
    entry.longFrameLastAt = null;
    dirty.delete(pluginId);
    for (let i = 0; i < COMMIT_WINDOW_RING; i++) {
      if (windowPlugins[i] === pluginId) windowPlugins[i] = undefined;
    }
  }

  /**
   * The entry to record into for an observation made under `generation`, or
   * `null` when that load has already been replaced. Omitted, the observation
   * joins whatever load the plugin is currently on.
   *
   * A load's views can still be activating when its successor's first view
   * mounts, so first sight is not proof of being newer: the view generation
   * orders loads, and an older one that turns up late is retired on arrival
   * rather than allowed to retire its successor.
   */
  function entryForGeneration(
    pluginId: string,
    generation?: PluginViewGeneration
  ): PluginEntry | null {
    if (generation === undefined) return entryFor(pluginId);
    const { token, order } = generation;
    if (isRetired(pluginId, token)) return null;
    const entry = entryFor(pluginId);
    if (entry.generation === token) return entry;
    if (
      entry.generation !== null &&
      order !== null &&
      entry.generationOrder !== null &&
      order < entry.generationOrder
    ) {
      rememberRetired(pluginId, token);
      return null;
    }
    if (entry.generation !== null) retire(pluginId, entry);
    entry.generation = token;
    entry.generationOrder = order;
    return entry;
  }

  function notify(targets: Set<() => void>): void {
    for (const listener of targets) {
      try {
        listener();
      } catch {
        // A failing listener must not break measurement for the others.
      }
    }
  }

  // Listeners hear "there is something to drain" once per drain window, not
  // once per commit, so a chatty view cannot turn the notification into load.
  function markDirty(pluginId: string, entry: PluginEntry): void {
    if (dirty.has(pluginId)) return;
    const wasClean = dirty.size === 0;
    dirty.add(pluginId);
    // Move to the back of the eviction order: once per drain window, not per record.
    plugins.delete(pluginId);
    plugins.set(pluginId, entry);
    if (wasClean) notify(listeners);
  }

  function requestDrain(): void {
    if (drainRequested) return;
    drainRequested = true;
    notify(drainRequestListeners);
  }

  function recordViewLoad(
    pluginId: string,
    sample: PluginViewLoadSample,
    generation?: PluginViewGeneration
  ): void {
    const entry = entryForGeneration(pluginId, generation);
    if (!entry) return;
    pushBounded(entry.pendingLoads, sample, MAX_PENDING_VIEW_LOADS);
    pushBounded(entry.recentLoads, sample, MAX_RECENT_VIEW_LOADS);
    markDirty(pluginId, entry);
    // Last, so a listener that drains synchronously sees a finished record.
    if (entry.pendingLoads.length >= VIEW_LOAD_HIGH_WATER) requestDrain();
  }

  /**
   * Called from a React `Profiler` `onRender`, so it has to stay O(1) and
   * allocation-free in the steady state. Past the pending cap the drain window
   * becomes a uniform reservoir sample (so p50/p95 stay representative); the
   * window's worst commit is tracked beside it and put back at drain; the
   * report's `commitCount` stays exact either way. `generation` is the view's
   * load (see {@link generationOfViewUrl}); a commit from a replaced load is
   * dropped.
   */
  function recordCommit(
    pluginId: string,
    actualDurationMs: number,
    commitTime: number,
    generation?: PluginViewGeneration
  ): void {
    const entry = entryForGeneration(pluginId, generation);
    if (!entry) return;
    const seen = ++entry.pendingCommitsSeen;
    const pending = entry.pendingCommits;
    if (pending.length < MAX_PENDING_COMMITS) {
      pending.push(actualDurationMs);
    } else {
      const slot = Math.floor(Math.random() * seen);
      if (slot < MAX_PENDING_COMMITS) pending[slot] = actualDurationMs;
    }
    if (actualDurationMs > entry.pendingCommitMax) entry.pendingCommitMax = actualDurationMs;

    entry.localCommits[entry.localCommitCount % LOCAL_COMMIT_WINDOW] = actualDurationMs;
    entry.localCommitCount++;
    entry.localCommitLast = actualDurationMs;

    // Only the commit instant is reliable: `actualDuration` is render time
    // summed across a render that may have yielded, not a contiguous interval,
    // so a window reconstructed from it can span frames that saw none of it.
    commitTimes[windowCursor] = commitTime;
    windowPlugins[windowCursor] = pluginId;
    windowCursor = (windowCursor + 1) % COMMIT_WINDOW_RING;
    if (windowCount < COMMIT_WINDOW_RING) windowCount++;

    markDirty(pluginId, entry);
    if (seen === COMMIT_HIGH_WATER) requestDrain();
  }

  /** Past the pending cap a frame is counted in `longFramesDropped` rather than listed. */
  function recordLongFrame(pluginId: string, frame: LongFrame): void {
    const entry = entryFor(pluginId);
    const pending = entry.pendingLongFrames;
    if (pending.length < MAX_PENDING_LONG_FRAMES) {
      pending.push(frame);
    } else {
      entry.pendingLongFramesDropped++;
      entry.pendingLongFramesDroppedBlockingMs += frame.blockingMs;
    }
    entry.longFrameCount++;
    entry.longFrameBlockingMs += frame.blockingMs;
    entry.longFrameLastAt = frame.at;
    markDirty(pluginId, entry);
    if (pending.length === LONG_FRAME_HIGH_WATER) requestDrain();
  }

  /**
   * Remember which plugin a `plugin://` module URL's authority belongs to. A
   * view loading from a new authority is the plugin's new load, so this is
   * also where a replaced load's pending observations are retired.
   */
  function registerViewOrigin(pluginId: string, moduleUrl: string): void {
    const generation = generationOfViewUrl(moduleUrl);
    if (!generation) return;
    if (!entryForGeneration(pluginId, generation)) return;
    const authority = generation.token;
    // Re-inserted so a reload's fresh authority is the newest and the oldest
    // (a plugin load whose views are long gone) is what the cap drops.
    authorities.delete(authority);
    authorities.set(authority, pluginId);
    if (authorities.size > MAX_TRACKED_AUTHORITIES) {
      const oldest = authorities.keys().next().value;
      if (oldest !== undefined) authorities.delete(oldest);
    }
  }

  /** A plugin view mounted; the returned release is its unmount. */
  function retainView(pluginId: string): () => void {
    openViews.set(pluginId, (openViews.get(pluginId) ?? 0) + 1);
    openViewCount++;
    const retainedIn = resetEpoch;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // A view retained before `reset()` was already forgotten by it.
      if (retainedIn !== resetEpoch) return;
      openViewCount--;
      const remaining = (openViews.get(pluginId) ?? 1) - 1;
      if (remaining > 0) {
        openViews.set(pluginId, remaining);
      } else {
        openViews.delete(pluginId);
        evictIdlePlugins();
      }
    };
  }

  function pluginIdForScriptUrl(sourceURL: string): string | undefined {
    if (authorities.size === 0) return undefined;
    const authority = authorityOf(sourceURL);
    return authority ? authorities.get(authority) : undefined;
  }

  /** Plugins with a recorded commit whose `commitTime` falls in `[start, end]` (performance.now() clock). */
  function pluginsCommittingDuring(start: number, end: number): string[] {
    if (windowCount === 0) return [];
    const found: string[] = [];
    for (let i = 0; i < windowCount; i++) {
      const pluginId = windowPlugins[i];
      if (pluginId === undefined) continue;
      const at = commitTimes[i]!;
      if (at >= start && at <= end && !found.includes(pluginId)) {
        found.push(pluginId);
      }
    }
    return found;
  }

  /** Whether any plugin view is mounted here — the long-frame fast path. */
  function isTracking(): boolean {
    return openViewCount > 0;
  }

  function drainReports(): PluginRendererMetricsReport[] {
    return drainTaggedReports().map((tagged) => tagged.report);
  }

  /**
   * {@link drainReports} with each report's load attached, read before the
   * drain's own eviction can drop the entry that knew it.
   */
  function drainTaggedReports(): TaggedPluginReport[] {
    drainRequested = false;
    if (dirty.size === 0) return [];
    const reports: TaggedPluginReport[] = [];
    for (const pluginId of dirty) {
      const entry = plugins.get(pluginId);
      if (!entry) continue;
      if (
        entry.pendingLoads.length === 0 &&
        entry.pendingCommits.length === 0 &&
        entry.pendingLongFrames.length === 0
      ) {
        continue;
      }
      const commits = entry.pendingCommits;
      if (entry.pendingCommitsSeen > commits.length && !commits.includes(entry.pendingCommitMax)) {
        commits[Math.floor(Math.random() * commits.length)] = entry.pendingCommitMax;
      }
      reports.push({
        generation: entry.generation,
        report: {
          pluginId,
          viewLoads: entry.pendingLoads,
          commitDurationsMs: entry.pendingCommits,
          commitCount: entry.pendingCommitsSeen,
          longFrames: entry.pendingLongFrames,
          longFramesDropped: {
            count: entry.pendingLongFramesDropped,
            blockingMs: entry.pendingLongFramesDroppedBlockingMs,
          },
        },
      });
      entry.pendingLoads = [];
      entry.pendingCommits = [];
      entry.pendingCommitsSeen = 0;
      entry.pendingCommitMax = 0;
      entry.pendingLongFrames = [];
      entry.pendingLongFramesDropped = 0;
      entry.pendingLongFramesDroppedBlockingMs = 0;
    }
    dirty.clear();
    evictIdlePlugins();
    return reports;
  }

  /** Fires once when the first delta lands after a drain: schedule a lazy drain. */
  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * Fires once per drain window when a plugin's pending commits, view loads or
   * long frames reach 75% of their cap: drain promptly, so the report stays
   * unsampled. The drainer should also have a `subscribe` timer; this is the
   * early trigger, not the only one.
   */
  function onDrainRequested(listener: () => void): () => void {
    drainRequestListeners.add(listener);
    return () => {
      drainRequestListeners.delete(listener);
    };
  }

  function getLocalSnapshot(pluginId: string): PluginViewLocalSnapshot | null {
    const entry = plugins.get(pluginId);
    if (!entry) return null;
    let viewCommits: PluginDurationStats | null = null;
    const count = Math.min(entry.localCommitCount, LOCAL_COMMIT_WINDOW);
    if (count > 0) {
      const sorted = entry.localCommits.slice(0, count).sort();
      viewCommits = {
        count: entry.localCommitCount,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted[count - 1]!,
        lastMs: entry.localCommitLast,
      };
    }
    return {
      pluginId,
      viewLoads: [...entry.recentLoads],
      viewCommits,
      longFrames: {
        count: entry.longFrameCount,
        totalBlockingMs: entry.longFrameBlockingMs,
        lastAt: entry.longFrameLastAt,
      },
    };
  }

  function reset(): void {
    plugins.clear();
    dirty.clear();
    authorities.clear();
    openViews.clear();
    openViewCount = 0;
    resetEpoch++;
    retiredGenerations.clear();
    drainRequested = false;
    windowPlugins.fill(undefined);
    windowCursor = 0;
    windowCount = 0;
  }

  return {
    recordViewLoad,
    recordCommit,
    recordLongFrame,
    registerViewOrigin,
    retainView,
    pluginIdForScriptUrl,
    pluginsCommittingDuring,
    isTracking,
    drainReports,
    drainTaggedReports,
    subscribe,
    onDrainRequested,
    getLocalSnapshot,
    reset,
  };
}

const PLUGIN_SCHEME = "plugin://";

/** Authority of a `plugin://` URL without constructing a `URL` — this runs per long-frame script. */
function authorityOf(url: string): string | undefined {
  if (!url.startsWith(PLUGIN_SCHEME)) return undefined;
  const rest = url.slice(PLUGIN_SCHEME.length);
  let end = rest.length;
  for (const stop of ["/", "?", "#"]) {
    const at = rest.indexOf(stop);
    if (at !== -1 && at < end) end = at;
  }
  const authority = rest.slice(0, end).toLowerCase();
  return authority.length > 0 ? authority : undefined;
}

/**
 * The plugin load a view module URL belongs to. The token is the URL's
 * `plugin://` authority, shared by a load's regular and recovery view
 * generations since both are the same load; the order is its `__dtv-N`.
 */
export function generationOfViewUrl(url: string): PluginViewGeneration | undefined {
  const token = authorityOf(url);
  if (!token) return undefined;
  const pathStart = PLUGIN_SCHEME.length + token.length + 1;
  const path = url.charAt(pathStart - 1) === "/" ? url.slice(pathStart) : "";
  return { token, order: stripPluginViewGeneration(path)?.generation ?? null };
}

export type PluginViewMetrics = ReturnType<typeof createPluginViewMetrics>;

export type PluginViewPhase = "activate" | "import" | "styles" | "view-load" | "first-paint";

/**
 * Put one phase of a plugin view load on the DevTools Performance timeline as
 * `daintree:plugin:<pluginId>:<phase>`, so an author sees it next to their own
 * frames. The previous entry of the same name is cleared first, which caps the
 * user-timing buffer at one entry per plugin phase however often views open.
 */
export function measurePluginViewPhase(
  pluginId: string,
  phase: PluginViewPhase,
  start: number,
  end: number,
  detail?: Record<string, unknown>
): void {
  if (typeof performance === "undefined" || typeof performance.measure !== "function") return;
  const name = `daintree:plugin:${pluginId}:${phase}`;
  try {
    performance.clearMeasures?.(name);
    performance.measure(name, { start, end, detail });
  } catch {
    // User timing is a debugging aid; a refusal must never fail the load.
  }
}

export const pluginViewMetrics = createPluginViewMetrics();
