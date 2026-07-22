import type {
  PluginPanelLifecycleEvent,
  PluginPanelLifecyclePhase,
} from "../../../shared/types/plugin.js";

export type PluginPanelLifecycleListener = (event: PluginPanelLifecycleEvent) => void;

/**
 * The slice of `Electron.WebContents` needed to notice a renderer going away.
 * Structural so the owning service stays unit-testable without an Electron stub.
 */
export interface PanelLifecycleSourceHandle {
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

/** Resolves a panel kind id to its owning plugin, or `undefined` if unknown. */
export type PanelKindOwnerResolver = (panelKindId: string) => string | undefined;

const VALID_PHASES = new Set<PluginPanelLifecyclePhase>([
  "mounted",
  "hidden",
  "backgrounded",
  "trashed",
  "restored",
  "removed",
  "render-failed",
]);

/**
 * Transition phases that describe where a panel *is*, as opposed to something
 * that momentarily happened to it. Only these are replayed to a late
 * subscriber: replaying `restored` would tell a worker a panel just came out of
 * the trash long after the fact, and replaying `removed` would announce a panel
 * the worker never knew existed.
 */
function isReplayable(phase: PluginPanelLifecyclePhase): boolean {
  return phase !== "restored" && phase !== "removed";
}

/**
 * Routes plugin panel lifecycle transitions from renderers to plugin workers
 * (#11301).
 *
 * The renderer is the only process that can tell "this view unmounted because a
 * sibling was maximized" from "this panel was closed for good", so it is the
 * authority on phase. Main's job is routing and memory: it keeps the current
 * phase of every live panel per renderer source, so a plugin that activates
 * lazily — which is the norm, since opening a view is what triggers activation —
 * still learns about the panel that caused its activation when it subscribes a
 * moment later.
 *
 * Ownership is resolved against main's own panel-kind registry rather than the
 * `pluginId` the renderer claims, so a compromised renderer cannot address
 * another plugin's worker.
 */
export class PluginPanelLifecycleBroker {
  /** sourceId (webContents id) → panelId → current event. */
  private readonly bySource = new Map<number, Map<string, PluginPanelLifecycleEvent>>();
  private readonly listeners = new Map<string, Set<PluginPanelLifecycleListener>>();

  constructor(private readonly resolveOwner: PanelKindOwnerResolver) {}

  /**
   * Accept a renderer batch. Malformed entries and unknown panel kinds are
   * dropped individually — a plugin that unloaded mid-batch must not cost the
   * rest of the batch its delivery.
   */
  ingest(sourceId: number, events: readonly unknown[]): void {
    if (!Array.isArray(events)) return;
    for (const raw of events) {
      const event = this.normalize(raw);
      if (!event) continue;

      let panels = this.bySource.get(sourceId);
      if (!panels) {
        panels = new Map();
        this.bySource.set(sourceId, panels);
      }
      if (event.phase === "removed") {
        panels.delete(event.panelId);
      } else if (event.phase !== "restored") {
        panels.set(event.panelId, event);
      }

      this.emit(event);
    }
  }

  /**
   * Subscribe a plugin to its own panels' transitions. Replays each live
   * panel's current phase before returning, so subscribing during `activate()`
   * cannot miss the panel whose open triggered that activation.
   */
  subscribe(pluginId: string, listener: PluginPanelLifecycleListener): () => void {
    let bucket = this.listeners.get(pluginId);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(pluginId, bucket);
    }
    bucket.add(listener);

    for (const panels of this.bySource.values()) {
      for (const event of panels.values()) {
        if (event.pluginId !== pluginId || !isReplayable(event.phase)) continue;
        this.deliver(listener, event);
      }
    }

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const current = this.listeners.get(pluginId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(pluginId);
    };
  }

  /**
   * Forget everything a renderer reported. Called when a `WebContentsView` is
   * evicted or destroyed — deliberately WITHOUT synthesizing `removed`, because
   * a cached or crashed view says nothing about whether the user closed the
   * panel, and a false terminal event is exactly the destructive misreading
   * this issue exists to prevent.
   */
  clearSource(sourceId: number): void {
    this.bySource.delete(sourceId);
  }

  /** Drop every listener a plugin registered (unload / worker teardown). */
  clearPlugin(pluginId: string): void {
    this.listeners.delete(pluginId);
  }

  dispose(): void {
    this.bySource.clear();
    this.listeners.clear();
  }

  private normalize(raw: unknown): PluginPanelLifecycleEvent | null {
    if (raw === null || typeof raw !== "object") return null;
    const candidate = raw as Record<string, unknown>;
    const panelId = candidate.panelId;
    const panelKindId = candidate.panelKindId;
    const phase = candidate.phase;
    if (typeof panelId !== "string" || panelId.length === 0) return null;
    if (typeof panelKindId !== "string" || panelKindId.length === 0) return null;
    if (typeof phase !== "string" || !VALID_PHASES.has(phase as PluginPanelLifecyclePhase)) {
      return null;
    }
    // Authoritative ownership — never the renderer-supplied `pluginId`. Falling
    // back to the owner we already recorded for this panel matters: while a
    // plugin is disabled or mid-upgrade its kinds are unregistered, so a live
    // registry lookup misses. Dropping those events would strand the panel's
    // last known phase — typically `mounted` — and replay it to the next worker
    // as though the panel were still open, which is the same false-liveness
    // reading in reverse.
    const pluginId = this.resolveOwner(panelKindId) ?? this.rememberedOwner(panelId, panelKindId);
    if (!pluginId) return null;
    return Object.freeze({
      panelId,
      panelKindId,
      pluginId,
      phase: phase as PluginPanelLifecyclePhase,
    });
  }

  /**
   * The owner recorded the last time this exact panel resolved, used only when
   * the live registry no longer knows the kind. Matching on `panelKindId` too
   * keeps a recycled panel id from inheriting an unrelated plugin's ownership.
   */
  private rememberedOwner(panelId: string, panelKindId: string): string | undefined {
    for (const panels of this.bySource.values()) {
      const known = panels.get(panelId);
      if (known && known.panelKindId === panelKindId) return known.pluginId;
    }
    return undefined;
  }

  private emit(event: PluginPanelLifecycleEvent): void {
    const bucket = this.listeners.get(event.pluginId);
    if (!bucket) return;
    for (const listener of [...bucket]) {
      this.deliver(listener, event);
    }
  }

  private deliver(listener: PluginPanelLifecycleListener, event: PluginPanelLifecycleEvent): void {
    try {
      listener(event);
    } catch (err) {
      console.error(
        `[PluginPanelLifecycle] listener for "${event.pluginId}" threw on ${event.phase}:`,
        err
      );
    }
  }
}
