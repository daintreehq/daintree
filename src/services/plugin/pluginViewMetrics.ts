import type {
  PluginDurationStats,
  PluginRendererMetricsReport,
  PluginViewLoadSample,
} from "@shared/types/pluginMetrics";

/**
 * Renderer-side cost observations for plugin views, per project view context.
 *
 * Everything here is an observation: a long frame that overlapped a plugin's
 * commit says the plugin was active during the stall, not that it caused it.
 * A later phase drains the pending deltas to main; until then the local
 * snapshot serves tests and any in-renderer fallback UI.
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
/** Plugins and `plugin://` authorities remembered; the oldest idle ones go first. */
const MAX_TRACKED_PLUGINS = 64;
const MAX_TRACKED_AUTHORITIES = 64;
/**
 * Recent commit windows kept for long-frame overlap. Long animation frames are
 * delivered within a frame or two of the work, so a short ring is enough, and
 * a fixed one keeps `recordCommit` allocation-free.
 */
const COMMIT_WINDOW_RING = 64;

interface PluginEntry {
  pendingLoads: PluginViewLoadSample[];
  pendingCommits: number[];
  /** Commits seen this drain window, including any the reservoir dropped. */
  pendingCommitsSeen: number;
  pendingCommitMax: number;
  pendingLongFrames: LongFrame[];
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
  /** `plugin://` authority → plugin id, learned from the URLs views load from. */
  const authorities = new Map<string, string>();

  const windowStarts = new Float64Array(COMMIT_WINDOW_RING);
  const windowEnds = new Float64Array(COMMIT_WINDOW_RING);
  const windowPlugins: (string | undefined)[] = new Array(COMMIT_WINDOW_RING);
  let windowCursor = 0;
  let windowCount = 0;

  /** Mounted plugin views, per plugin. Long frames are only attributed while any are open. */
  const openViews = new Map<string, number>();
  let openViewCount = 0;

  function evictIdlePlugins(): void {
    for (const pluginId of plugins.keys()) {
      if (plugins.size <= MAX_TRACKED_PLUGINS) return;
      if (openViews.has(pluginId) || dirty.has(pluginId)) continue;
      plugins.delete(pluginId);
    }
  }

  function entryFor(pluginId: string): PluginEntry {
    let entry = plugins.get(pluginId);
    if (!entry) {
      entry = {
        pendingLoads: [],
        pendingCommits: [],
        pendingCommitsSeen: 0,
        pendingCommitMax: 0,
        pendingLongFrames: [],
        recentLoads: [],
        localCommits: new Float64Array(LOCAL_COMMIT_WINDOW),
        localCommitCount: 0,
        localCommitLast: 0,
        longFrameCount: 0,
        longFrameBlockingMs: 0,
        longFrameLastAt: null,
      };
      plugins.set(pluginId, entry);
      if (plugins.size > MAX_TRACKED_PLUGINS) evictIdlePlugins();
    }
    return entry;
  }

  // Listeners hear "there is something to drain" once per drain window, not
  // once per commit, so a chatty view cannot turn the notification into load.
  function markDirty(pluginId: string): void {
    if (dirty.has(pluginId)) return;
    const wasClean = dirty.size === 0;
    dirty.add(pluginId);
    if (!wasClean) return;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A failing listener must not break measurement for the others.
      }
    }
  }

  function recordViewLoad(pluginId: string, sample: PluginViewLoadSample): void {
    const entry = entryFor(pluginId);
    pushBounded(entry.pendingLoads, sample, MAX_PENDING_VIEW_LOADS);
    pushBounded(entry.recentLoads, sample, MAX_RECENT_VIEW_LOADS);
    markDirty(pluginId);
  }

  /**
   * Called from a React `Profiler` `onRender`, so it has to stay O(1) and
   * allocation-free in the steady state. Past the pending cap the drain window
   * becomes a uniform reservoir sample (so p50/p95 stay representative); the
   * window's worst commit is tracked beside it and put back at drain.
   */
  function recordCommit(
    pluginId: string,
    actualDurationMs: number,
    startTime: number,
    commitTime: number
  ): void {
    const entry = entryFor(pluginId);
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

    // The render's own duration back from the commit, not `startTime` onwards:
    // a concurrent render can yield between the two, and a frame in that gap
    // saw none of this plugin's work.
    windowStarts[windowCursor] = Math.max(startTime, commitTime - actualDurationMs);
    windowEnds[windowCursor] = commitTime;
    windowPlugins[windowCursor] = pluginId;
    windowCursor = (windowCursor + 1) % COMMIT_WINDOW_RING;
    if (windowCount < COMMIT_WINDOW_RING) windowCount++;

    markDirty(pluginId);
  }

  function recordLongFrame(pluginId: string, frame: LongFrame): void {
    const entry = entryFor(pluginId);
    pushBounded(entry.pendingLongFrames, frame, MAX_PENDING_LONG_FRAMES);
    entry.longFrameCount++;
    entry.longFrameBlockingMs += frame.blockingMs;
    entry.longFrameLastAt = frame.at;
    markDirty(pluginId);
  }

  /** Remember which plugin a `plugin://` module URL's authority belongs to. */
  function registerViewOrigin(pluginId: string, moduleUrl: string): void {
    const authority = authorityOf(moduleUrl);
    if (!authority) return;
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
    let released = false;
    return () => {
      if (released) return;
      released = true;
      openViewCount--;
      const remaining = (openViews.get(pluginId) ?? 1) - 1;
      if (remaining > 0) openViews.set(pluginId, remaining);
      else openViews.delete(pluginId);
    };
  }

  function pluginIdForScriptUrl(sourceURL: string): string | undefined {
    if (authorities.size === 0) return undefined;
    const authority = authorityOf(sourceURL);
    return authority ? authorities.get(authority) : undefined;
  }

  /** Plugins with a recorded commit window intersecting `[start, end]` (performance.now() clock). */
  function pluginsCommittingDuring(start: number, end: number): string[] {
    if (windowCount === 0) return [];
    const found: string[] = [];
    for (let i = 0; i < windowCount; i++) {
      const pluginId = windowPlugins[i];
      if (pluginId === undefined) continue;
      if (windowStarts[i]! <= end && windowEnds[i]! >= start && !found.includes(pluginId)) {
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
    if (dirty.size === 0) return [];
    const reports: PluginRendererMetricsReport[] = [];
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
        pluginId,
        viewLoads: entry.pendingLoads,
        commitDurationsMs: entry.pendingCommits,
        longFrames: entry.pendingLongFrames,
      });
      entry.pendingLoads = [];
      entry.pendingCommits = [];
      entry.pendingCommitsSeen = 0;
      entry.pendingCommitMax = 0;
      entry.pendingLongFrames = [];
    }
    dirty.clear();
    return reports;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
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
    subscribe,
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
