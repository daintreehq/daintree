import { create } from "zustand";
import type { PluginRuntimeStatus } from "@shared/types/plugin";

/**
 * Renderer mirror of every plugin instance's runtime health (#12277, #12278),
 * keyed by plugin instance id. Source of truth is `PluginService`; we hydrate
 * from `plugin:runtime-status-changed`, which carries one instance's COMPLETE
 * current state per event (a `null` status means the instance left the
 * inventory).
 *
 * A whole snapshot per event rather than a change notification is the point:
 * anything reading this agrees with the worker on which generation is live,
 * which a sequence of "reloaded"/"crashed" pings cannot give you.
 *
 * Subscription is module-level so an instance's state survives the unmount and
 * remount of whatever is displaying it, and no event is missed between renders.
 */
interface PluginRuntimeStatusState {
  statusById: ReadonlyMap<string, PluginRuntimeStatus>;
  /** Idempotent: subscribes to live updates, then pulls the current snapshot. */
  init: () => void;
}

let initialized = false;
let unsubscribe: (() => void) | null = null;
/**
 * Instances a push has already written since the in-flight hydration pull
 * started. The pull races live events — it is a round trip, and a worker can
 * die inside it — so its response must not roll an instance back to the state
 * it held when main answered, nor resurrect one the same window already
 * removed. Push is authoritative; the pull only fills gaps (#6324).
 */
let pushedDuringHydration: Set<string> | null = null;

export const usePluginRuntimeStatusStore = create<PluginRuntimeStatusState>((set, get) => ({
  statusById: new Map(),
  init: () => {
    if (initialized) return;
    // Read from leaf components, so tolerate a partially-stubbed bridge rather
    // than pushing an events mock into every component test. Don't latch the
    // guard until the bridge is actually there, so a no-bridge early return
    // stays retryable.
    const events = window.electron?.events;
    if (typeof events?.on !== "function") return;
    initialized = true;

    unsubscribe = events.on("plugin:runtime-status-changed", ({ pluginId, status }) => {
      pushedDuringHydration?.add(pluginId);
      const current = get().statusById;
      if (!status) {
        if (!current.has(pluginId)) return;
        const next = new Map(current);
        next.delete(pluginId);
        set({ statusById: next });
        return;
      }
      const next = new Map(current);
      next.set(pluginId, status);
      set({ statusById: next });
    });

    // Subscribed BEFORE the pull, so an event landing mid-round-trip is captured
    // rather than dropped. `pushSnapshotTo` only replays on `did-finish-load`,
    // and this store initializes from a leaf component that may mount long
    // after — so a panel restored into a running window needs this pull to
    // learn about a backend that died before it mounted.
    const pull = window.electron?.plugin?.getRuntimeStatuses;
    if (typeof pull !== "function") return;
    const seen = new Set<string>();
    pushedDuringHydration = seen;
    void pull()
      .then((statuses) => {
        if (pushedDuringHydration !== seen) return;
        const current = get().statusById;
        const next = new Map(current);
        let changed = false;
        for (const status of statuses) {
          // A live event already spoke for this instance; it is newer than a
          // response main built before that transition happened.
          if (seen.has(status.pluginId)) continue;
          next.set(status.pluginId, status);
          changed = true;
        }
        if (changed) set({ statusById: next });
      })
      .catch(() => {
        // Best-effort gap-filler. The push channel is authoritative, and a
        // failed pull leaves the store exactly as the pushes left it.
      })
      .finally(() => {
        if (pushedDuringHydration === seen) pushedDuringHydration = null;
      });
  },
}));

/** Live runtime state for a plugin instance, or null when nothing is tracked. */
export function usePluginRuntimeStatus(pluginId: string): PluginRuntimeStatus | null {
  return usePluginRuntimeStatusStore((s) => s.statusById.get(pluginId) ?? null);
}

/** Test-only: reset the module-level init guard and state between cases. */
export function _resetPluginRuntimeStatusStoreForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  pushedDuringHydration = null;
  usePluginRuntimeStatusStore.setState({ statusById: new Map() });
}
