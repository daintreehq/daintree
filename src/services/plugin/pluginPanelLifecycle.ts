import type { PluginPanelLifecycleEvent, PluginPanelLifecyclePhase } from "@shared/types/plugin";
import type { PanelLocation } from "@shared/types/panel";
import { logWarn } from "@/utils/logger";

/**
 * Renderer-side authority for plugin panel lifecycle (#11301).
 *
 * Plugin views used to get a single `disposeSignal` that fired identically for
 * "the user maximized a sibling pane" and "the user closed this panel forever",
 * so a plugin could only guess whether to release durable resources. Two things
 * fix that, and both are served from here:
 *
 *   1. `getPanelRemovedSignal(panelId)` hands out ONE `AbortSignal` per panel id
 *      that survives every remount and aborts only on permanent removal.
 *   2. Phase transitions are streamed to main (and on to the plugin's worker),
 *      which is where durable resources actually live — the React subtree is
 *      gone during exactly the unmount this issue is about, so a view-owned
 *      subscription could never report its own backgrounding.
 *
 * This module deliberately does NOT import the panel store: it is pulled into
 * `PluginViewContent`'s graph, and a module-scope store import there would drag
 * the store (and its `window` reads) into every suite that renders a plugin
 * view. The store half lives in `usePluginPanelLifecycle`, which pushes
 * snapshots in through {@link syncPluginPanels}.
 */

interface TrackedPanel {
  kindId: string;
  pluginId: string;
  /** `undefined` until the store observer has seen this panel. */
  location: PanelLocation | undefined;
  /** Live mount tokens. StrictMode double-invokes effects, so this is a set. */
  mountTokens: Set<number>;
  renderFailed: boolean;
  removal: AbortController;
  /** Last phase actually emitted, so repeat transitions stay silent. */
  lastPhase: PluginPanelLifecyclePhase | null;
  /** Panel is gone; the entry lingers only until the pending flush drains. */
  removed: boolean;
}

const tracked = new Map<string, TrackedPanel>();
let pending: PluginPanelLifecycleEvent[] = [];
let flushScheduled = false;
let nextMountToken = 1;

/** Snapshot entry for one live plugin panel. */
export interface PluginPanelSnapshotEntry {
  panelId: string;
  kindId: string;
  pluginId: string;
  location: PanelLocation | undefined;
}

function ensureEntry(
  panelId: string,
  seed?: Omit<PluginPanelSnapshotEntry, "panelId">
): TrackedPanel {
  let entry = tracked.get(panelId);
  if (!entry) {
    entry = {
      kindId: seed?.kindId ?? "",
      pluginId: seed?.pluginId ?? "",
      location: seed?.location,
      mountTokens: new Set(),
      renderFailed: false,
      removal: new AbortController(),
      lastPhase: null,
      removed: false,
    };
    tracked.set(panelId, entry);
  } else if (seed) {
    // Identity arrives from whichever side saw the panel first. A view that
    // mounts before the observer's first snapshot creates a bare entry, so fill
    // it in rather than leaving the worker with an unroutable empty pluginId.
    if (seed.kindId) entry.kindId = seed.kindId;
    if (seed.pluginId) entry.pluginId = seed.pluginId;
    entry.location = seed.location;
  }
  return entry;
}

/**
 * The panel's current phase, resolved by precedence rather than by "whatever
 * happened last": record state outranks view state, because a trashed panel
 * whose subtree also unmounted is trashed, not hidden.
 *
 * `removed > trashed > backgrounded > render-failed > mounted > hidden`
 *
 * `hidden` is simply "the panel record is live but no view is mounted". That
 * one rule covers every temporary-teardown case — sibling maximize, an inactive
 * dock tab, a cached project view — because all of them unmount the subtree,
 * which is precisely why they all aborted `disposeSignal` before.
 */
function effectivePhase(entry: TrackedPanel): PluginPanelLifecyclePhase {
  if (entry.removed) return "removed";
  if (entry.location === "trash") return "trashed";
  if (entry.location === "background") return "backgrounded";
  if (entry.renderFailed) return "render-failed";
  return entry.mountTokens.size > 0 ? "mounted" : "hidden";
}

function enqueue(panelId: string, entry: TrackedPanel, phase: PluginPanelLifecyclePhase): void {
  pending.push(
    Object.freeze({
      panelId,
      panelKindId: entry.kindId,
      pluginId: entry.pluginId,
      phase,
    })
  );
  if (flushScheduled) return;
  flushScheduled = true;
  // Coalesce a burst (a maximize toggle moves every sibling at once) into one
  // IPC round trip, mirroring how `schedulePanelKindsBroadcast` batches on the
  // main side.
  queueMicrotask(flush);
}

function flush(): void {
  flushScheduled = false;
  const batch = pending;
  pending = [];
  // Drop entries whose terminal event has now shipped; keeping them would make
  // a later panel reusing the id look permanently removed.
  for (const [panelId, entry] of tracked) {
    if (entry.removed) tracked.delete(panelId);
  }
  if (batch.length === 0) return;
  const report =
    typeof window !== "undefined" ? window.electron?.plugin?.reportPanelLifecycle : undefined;
  if (!report) return;
  void report(batch).catch((error: unknown) => {
    logWarn("[PluginPanelLifecycle] Failed to report panel lifecycle events", { error });
  });
}

/** Emit the entry's phase if it changed since the last emission. */
function settle(panelId: string, entry: TrackedPanel): void {
  const phase = effectivePhase(entry);
  if (phase === entry.lastPhase) return;
  entry.lastPhase = phase;
  enqueue(panelId, entry, phase);
}

/**
 * The stable per-panel removal signal handed to plugin views as
 * `panelRemovedSignal`. Created on first request so a view that renders before
 * the store observer's first snapshot still gets the same object the observer
 * will later abort — identity is the whole point, since the view is remounted
 * many times over one panel's life.
 */
export function getPanelRemovedSignal(panelId: string): AbortSignal {
  return ensureEntry(panelId).removal.signal;
}

/**
 * Record that a plugin view committed for `panelId`. Returns the matching
 * unmount reporter, which releases only ITS OWN token — a StrictMode remount or
 * a generation swap runs the old cleanup after the new mount, and a naive
 * boolean would let that stale cleanup report the live view as hidden.
 */
export function reportViewMounted(
  panelId: string,
  identity: { kindId: string; pluginId: string }
): () => void {
  const entry = ensureEntry(panelId);
  if (identity.kindId) entry.kindId = identity.kindId;
  if (identity.pluginId) entry.pluginId = identity.pluginId;
  const token = nextMountToken++;
  entry.mountTokens.add(token);
  // A view that reaches commit has rendered, so any prior failure is resolved.
  entry.renderFailed = false;
  settle(panelId, entry);
  return () => {
    const current = tracked.get(panelId);
    if (!current) return;
    if (!current.mountTokens.delete(token)) return;
    settle(panelId, current);
  };
}

/** The current view attempt hit the plugin error boundary. */
export function reportViewRenderFailed(
  panelId: string,
  identity: { kindId: string; pluginId: string }
): void {
  const entry = ensureEntry(panelId);
  if (identity.kindId) entry.kindId = identity.kindId;
  if (identity.pluginId) entry.pluginId = identity.pluginId;
  entry.renderFailed = true;
  settle(panelId, entry);
}

/** A retry started — drop the failure so the next commit reads as `mounted`. */
export function clearViewRenderFailure(panelId: string): void {
  const entry = tracked.get(panelId);
  if (!entry || !entry.renderFailed) return;
  entry.renderFailed = false;
  settle(panelId, entry);
}

/**
 * Reconcile the tracked set against the store.
 *
 * `entries` are the panels whose kind currently resolves to a plugin;
 * `livePanelIds` is EVERY panel in the store. The two are separate on purpose:
 * during a plugin upgrade its kinds are unregistered and re-registered, so its
 * panels briefly stop resolving to a plugin while the panel records themselves
 * are untouched. Keying removal off `entries` alone would fire a terminal
 * `removed` (and abort `panelRemovedSignal`) in the middle of an upgrade — the
 * precise false "the user deleted this" reading this module exists to prevent.
 * A tracked panel that is still in `livePanelIds` but missing from `entries`
 * simply holds its last phase.
 *
 * A panel absent from `livePanelIds` is genuinely gone: its removal signal
 * aborts synchronously, so view cleanup runs in the same tick as the store
 * mutation rather than a microtask later, and a terminal `removed` event ships.
 */
export function syncPluginPanels(
  entries: readonly PluginPanelSnapshotEntry[],
  livePanelIds?: ReadonlySet<string>
): void {
  // Callers that don't track non-plugin panels (tests, and any future caller
  // that only ever sees plugin kinds) fall back to the plugin entries.
  const live = livePanelIds ?? new Set(entries.map((e) => e.panelId));

  for (const snapshot of entries) {
    const known = tracked.get(snapshot.panelId);
    const wasTrashed = known?.location === "trash";
    const entry = ensureEntry(snapshot.panelId, {
      kindId: snapshot.kindId,
      pluginId: snapshot.pluginId,
      location: snapshot.location,
    });
    // `restored` is an edge, not a resting state: emit it on the way out of
    // trash, then let `settle` report where the panel actually landed.
    if (wasTrashed && snapshot.location !== "trash") {
      entry.lastPhase = "restored";
      enqueue(snapshot.panelId, entry, "restored");
    }
    settle(snapshot.panelId, entry);
  }

  for (const [panelId, entry] of tracked) {
    if (live.has(panelId) || entry.removed) continue;
    entry.removed = true;
    entry.lastPhase = "removed";
    enqueue(panelId, entry, "removed");
    if (!entry.removal.signal.aborted) entry.removal.abort();
  }
}

/** Test seam — drops all tracked state without aborting or emitting. */
export function resetPluginPanelLifecycleForTests(): void {
  tracked.clear();
  pending = [];
  flushScheduled = false;
  nextMountToken = 1;
}
