import { create } from "zustand";
import type { PluginDevStatus } from "@shared/types/plugin";

/**
 * Renderer mirror of the live `daintree-plugin dev` sessions (#12277), keyed by
 * plugin instance id. Source of truth is `PluginService`; we hydrate from
 * `plugin:dev-status-changed`, which carries one session's COMPLETE current
 * state per event (a `null` status means the session ended). Cold-restored
 * views get the current set replayed via `pushSnapshotTo`.
 *
 * A whole snapshot per event rather than a reload notification is the point:
 * anything reading this agrees with the worker on which generation is live,
 * which a sequence of "reloaded" pings cannot give you.
 *
 * Subscription is module-level so a session's state survives the unmount and
 * remount of whatever is displaying it, and no event is missed between renders.
 */
interface PluginDevStatusState {
  statusById: ReadonlyMap<string, PluginDevStatus>;
  /** Idempotent: subscribes to live dev-session updates. */
  init: () => void;
}

let initialized = false;
let unsubscribe: (() => void) | null = null;

export const usePluginDevStatusStore = create<PluginDevStatusState>((set, get) => ({
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

    unsubscribe = events.on("plugin:dev-status-changed", ({ pluginId, status }) => {
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
  },
}));

/** Live dev-session state for a plugin, or null when it has no session. */
export function usePluginDevStatus(pluginId: string): PluginDevStatus | null {
  return usePluginDevStatusStore((s) => s.statusById.get(pluginId) ?? null);
}

/** Test-only: reset the module-level init guard and state between cases. */
export function _resetPluginDevStatusStoreForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  usePluginDevStatusStore.setState({ statusById: new Map() });
}
