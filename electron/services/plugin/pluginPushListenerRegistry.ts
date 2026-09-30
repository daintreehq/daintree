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
  callback: (hasListeners: boolean) => void;
}

/** How many destroyed renderer ids are remembered, so a late report cannot resurrect one. */
const MAX_REMEMBERED_GONE = 4096;

/**
 * How often watchers are re-evaluated while any exist. Reports and renderer
 * teardown re-evaluate them at once; this catches what the registry is not
 * told about — a view registering with (or leaving) a project, which changes
 * which renderers a bound plugin's scope covers.
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
 * Absence of information always means "deliver": a renderer that has not
 * reported yet (just created, or its report was refused as oversized or over
 * budget) is treated as listening to everything, exactly as before this
 * registry existed. Only a renderer that has positively said it has no
 * subscriber for a channel is skipped.
 */
export class PluginPushListenerRegistry {
  /** webContents id → its reported table, or `null` while its state is unknown. */
  private readonly sources = new Map<number, ListenerTable | null>();
  private readonly watchedSources = new Set<number>();
  private readonly gone = new Set<number>();
  private readonly watchers = new Set<Watcher>();

  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly resolveScope: PluginPushListenerScopeResolver = (projectId) =>
      getProjectRendererTargets(projectId),
    private readonly reconcileIntervalMs: number = RECONCILE_INTERVAL_MS
  ) {}

  /**
   * Replace `source`'s reported subscriptions. `null` marks its state unknown
   * (a report that could not be accepted), which restores full delivery to it.
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
   * Whether a push on `channel` (targeted at `panelId`, or `null` for a
   * broadcast) should be handed to renderer `targetId`. True unless that
   * renderer reported and has no subscriber the preload would dispatch it to:
   * broadcasts reach only `plugin.on` subscribers, targeted pushes only the
   * `onPanel` subscribers for that exact panel.
   */
  shouldDeliver(targetId: number, channel: string, panelId: string | null): boolean {
    const table = this.sources.get(targetId);
    if (table === undefined || table === null) return true;
    return table.get(channel)?.has(panelId) ?? false;
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
    callback: (hasListeners: boolean) => void
  ): () => void {
    const watcher: Watcher = {
      projectId,
      channel,
      last: this.hasListeners(projectId, channel),
      callback,
    };
    this.watchers.add(watcher);
    this.armReconcile();
    return () => {
      this.watchers.delete(watcher);
      if (this.watchers.size === 0) this.disarmReconcile();
    };
  }

  /** Test seam: whether a renderer has a known (reported) state. */
  isReported(id: number): boolean {
    return this.sources.get(id) != null;
  }

  /** Test seam. */
  watcherCount(): number {
    return this.watchers.size;
  }

  /** Re-evaluate every watcher now. Test seam for the periodic reconcile. */
  reconcile(): void {
    this.notifyWatchers();
  }

  private armReconcile(): void {
    if (this.reconcileTimer !== null || this.reconcileIntervalMs <= 0) return;
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

/** The process-wide registry the push batcher and every plugin host consult. */
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
