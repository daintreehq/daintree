import { getProjectRendererTargets } from "../../ipc/utils.js";

/**
 * One renderer's live plugin push subscriptions, as its preload reports them:
 * `[transportChannel, panelId]` pairs, where `transportChannel` is the full
 * `plugin:{pluginId}:{channel}` name and `panelId` is `null` for a `plugin.on`
 * (broadcast) subscriber or the panel an `onPanel` subscriber listens for.
 */
export type PluginPushListenerKey = readonly [channel: string, panelId: string | null];

/** The slice of `Electron.WebContents` the registry needs from a reporting renderer. */
export interface PluginPushListenerSource {
  readonly id: number;
  once(event: "destroyed", listener: () => void): unknown;
  /** Optional so structural fakes need not model it; every WebContents has it. */
  on?(event: "render-process-gone", listener: () => void): unknown;
}

/** The slice of `Electron.WebContents` the registry needs from a renderer in scope. */
export interface PluginPushListenerTarget {
  readonly id: number;
  isDestroyed(): boolean;
}

export type PluginPushListenerScopeResolver = (
  projectId: string | null
) => readonly PluginPushListenerTarget[];

/** channel → panel keys (`null` = broadcast) with at least one subscriber. */
type ListenerTable = Map<string, Set<string | null>>;

interface Watcher {
  projectId: string | null;
  channel: string;
  last: boolean;
  passive: boolean;
  callback: (hasListeners: boolean) => void;
}

export interface PluginPushListenerWatchOptions {
  /**
   * A passive watcher is re-evaluated only on what the registry is told —
   * reports and renderer teardown — and never keeps the periodic reconcile
   * running. For observations that back a synchronous read (a worker's
   * `hasListeners` cache), not for a plugin's own `onDidChangeListeners`.
   */
  passive?: boolean;
}

/** How many destroyed renderer ids are remembered, so a late report cannot resurrect one. */
const MAX_REMEMBERED_GONE = 4096;

/**
 * How often active watchers are re-evaluated while any exist. Reports, renderer
 * teardown and renderer scope changes (a view registering with or leaving a
 * project, wired through `reconcile` by the report handler) re-evaluate every
 * watcher at once; this is a backstop for a scope change that path misses, and
 * passive watchers go without it.
 */
const RECONCILE_INTERVAL_MS = 2_000;

/**
 * Which renderers have a listener for which plugin push channel (Main side).
 *
 * The preload owns every renderer-side plugin push subscription
 * (`window.electron.plugin.on` / `onPanel`), so it reports the full set of
 * `(channel, panelId)` pairs it has subscribers for whenever that set changes.
 * Each report replaces the previous one for that renderer, so a report that is
 * lost or superseded never leaves a count drifting.
 *
 * This is a producer-side signal only (`host.hasListeners`,
 * `host.onDidChangeListeners`): push delivery never consults it. A report is
 * always behind the renderer — a subscriber registered after an empty report
 * would lose any push main filtered on that report, and a generic push has no
 * replay — so the batcher sends to every renderer in scope. A producer that
 * pauses on this signal must be able to resync, as a synced collection does
 * through its snapshot.
 *
 * Absence of information always means "listening": a renderer that has not
 * reported yet (just created, or its report was refused as oversized or over
 * budget) counts as listening to everything, so the answer errs towards true.
 */
export class PluginPushListenerRegistry {
  /** webContents id → its reported table, or `null` while its state is unknown. */
  private readonly sources = new Map<number, ListenerTable | null>();
  private readonly watchedSources = new Set<number>();
  private readonly gone = new Set<number>();
  private readonly watchers = new Set<Watcher>();

  /** Watchers that are not passive; the periodic reconcile runs only while there are any. */
  private activeWatchers = 0;

  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly resolveScope: PluginPushListenerScopeResolver = (projectId) =>
      getProjectRendererTargets(projectId),
    private readonly reconcileIntervalMs: number = RECONCILE_INTERVAL_MS
  ) {}

  /**
   * Replace `source`'s reported subscriptions. `null` marks its state unknown
   * (a report that could not be accepted), which counts it as listening on
   * every channel again.
   */
  report(
    source: PluginPushListenerSource,
    listeners: readonly PluginPushListenerKey[] | null
  ): void {
    const id = source.id;
    if (this.gone.has(id)) return;
    this.watchDestroyed(source);
    if (listeners === null) {
      this.sources.set(id, null);
    } else {
      const table: ListenerTable = new Map();
      for (const [channel, panelId] of listeners) {
        let panels = table.get(channel);
        if (!panels) {
          panels = new Set();
          table.set(channel, panels);
        }
        panels.add(panelId);
      }
      this.sources.set(id, table);
    }
    this.notifyWatchers();
  }

  /** Forget a renderer. Called when its webContents is destroyed. */
  clearSource(id: number): void {
    this.gone.add(id);
    if (this.gone.size > MAX_REMEMBERED_GONE) {
      const oldest = this.gone.values().next();
      if (!oldest.done) this.gone.delete(oldest.value);
    }
    this.watchedSources.delete(id);
    if (!this.sources.delete(id)) return;
    this.notifyWatchers();
  }

  /**
   * Whether any renderer in `projectId`'s scope may be listening on `channel`,
   * broadcast or targeted. A renderer in scope that has not reported counts as
   * listening, so the answer errs towards true.
   */
  hasListeners(projectId: string | null, channel: string): boolean {
    return this.evaluate(this.scopeOf(projectId), channel);
  }

  /**
   * Call `callback` each time {@link hasListeners} for `(projectId, channel)`
   * changes value. Not called with the current value; read it with
   * {@link hasListeners}. Returns an idempotent disposer.
   */
  watch(
    projectId: string | null,
    channel: string,
    callback: (hasListeners: boolean) => void,
    options?: PluginPushListenerWatchOptions
  ): () => void {
    const passive = options?.passive === true;
    const watcher: Watcher = {
      projectId,
      channel,
      last: this.hasListeners(projectId, channel),
      passive,
      callback,
    };
    this.watchers.add(watcher);
    if (!passive) this.activeWatchers++;
    this.armReconcile();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.watchers.delete(watcher);
      if (!passive) this.activeWatchers--;
      if (this.activeWatchers === 0) this.disarmReconcile();
    };
  }

  /** Test seam: whether a renderer has a known (reported) state. */
  isReported(id: number): boolean {
    return this.sources.get(id) != null;
  }

  /** Test seam: the `(channel, panelId)` pairs a renderer last reported, or `null` while unknown. */
  reportedListeners(id: number): PluginPushListenerKey[] | null {
    const table = this.sources.get(id);
    if (table == null) return null;
    const keys: PluginPushListenerKey[] = [];
    for (const [channel, panels] of table) {
      for (const panelId of panels) keys.push([channel, panelId]);
    }
    return keys;
  }

  /** Test seam. */
  watcherCount(): number {
    return this.watchers.size;
  }

  /** Test seam: whether the periodic reconcile is running. */
  isReconciling(): boolean {
    return this.reconcileTimer !== null;
  }

  /** Re-evaluate every watcher now, passive ones included. Called when renderer scope changes. */
  reconcile(): void {
    this.notifyWatchers();
  }

  private armReconcile(): void {
    if (this.reconcileTimer !== null || this.reconcileIntervalMs <= 0) return;
    if (this.activeWatchers === 0) return;
    this.reconcileTimer = setInterval(() => this.notifyWatchers(), this.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
  }

  private disarmReconcile(): void {
    if (this.reconcileTimer === null) return;
    clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  private scopeOf(projectId: string | null): readonly PluginPushListenerTarget[] {
    try {
      return this.resolveScope(projectId).filter(
        (target) => !this.gone.has(target.id) && !isGone(target)
      );
    } catch {
      return [];
    }
  }

  private evaluate(scope: readonly PluginPushListenerTarget[], channel: string): boolean {
    for (const target of scope) {
      const table = this.sources.get(target.id);
      if (table === undefined || table === null) return true;
      const panels = table.get(channel);
      if (panels !== undefined && panels.size > 0) return true;
    }
    return false;
  }

  /**
   * Re-evaluate every watcher and fire the ones whose answer changed. Changes
   * are rare (a view mounting or unmounting), and watchers are one per watched
   * channel, so recomputing all of them is cheaper than tracking which scopes a
   * renderer belongs to.
   */
  private notifyWatchers(): void {
    if (this.watchers.size === 0) return;
    const scopes = new Map<string | null, readonly PluginPushListenerTarget[]>();
    for (const watcher of [...this.watchers]) {
      if (!this.watchers.has(watcher)) continue;
      let scope = scopes.get(watcher.projectId);
      if (!scope) {
        scope = this.scopeOf(watcher.projectId);
        scopes.set(watcher.projectId, scope);
      }
      const next = this.evaluate(scope, watcher.channel);
      if (next === watcher.last) continue;
      watcher.last = next;
      try {
        watcher.callback(next);
      } catch (err) {
        console.error(`[PluginPushListeners] watcher for "${watcher.channel}" threw:`, err);
      }
    }
  }

  private watchDestroyed(source: PluginPushListenerSource): void {
    if (this.watchedSources.has(source.id)) return;
    try {
      source.once("destroyed", () => this.clearSource(source.id));
      // A crashed renderer runs no subscriber until its page loads again, and
      // that page's preload reports afresh. Until then nothing there listens.
      source.on?.("render-process-gone", () => {
        if (this.gone.has(source.id)) return;
        this.sources.set(source.id, new Map());
        this.notifyWatchers();
      });
      this.watchedSources.add(source.id);
    } catch {
      // A torn-down webContents can throw; the scope filter drops it anyway.
    }
  }
}

function isGone(target: PluginPushListenerTarget): boolean {
  try {
    return target.isDestroyed();
  } catch {
    return true;
  }
}

let sharedRegistry: PluginPushListenerRegistry | null = null;

/** The process-wide registry every plugin host consults for its listener signal. */
export function getPluginPushListenerRegistry(): PluginPushListenerRegistry {
  sharedRegistry ??= new PluginPushListenerRegistry();
  return sharedRegistry;
}

/** Test seam: start the next caller from an empty registry, or from `next`. */
export function resetPluginPushListenerRegistryForTests(
  next: PluginPushListenerRegistry | null = null
): void {
  sharedRegistry = next;
}
