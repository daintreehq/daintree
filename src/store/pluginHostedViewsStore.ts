import { create } from "zustand";
import type { PluginHostedViewDescriptor, ViewLocation } from "@shared/types/plugin";
import { logWarn } from "@/utils/logger";

/**
 * This project view's copy of main's hosted-view registry (#13770): the plugin
 * views that mount outside the panel grid, already narrowed by main to what this
 * project may see — a project plugin's only in its own project, an installed
 * plugin's wherever it is visible.
 *
 * Every snapshot is complete, so each one replaces the last. A plugin reload
 * arrives as a snapshot carrying the new module URL; a plugin that stops, is
 * uninstalled or is hidden in this project leaves the snapshot.
 *
 * Subscription is module-level, like the runtime-status store: the homes that
 * mount these views come and go, and a reload while none is open must still
 * be seen.
 */
interface PluginHostedViewsState {
  /** `null` until the first snapshot, pulled or pushed, has arrived. */
  views: readonly PluginHostedViewDescriptor[] | null;
  /**
   * The first pull failed and no push has arrived since. Nothing is promised to
   * push until some plugin changes, so a host offers a retry rather than wait.
   */
  loadFailed: boolean;
  /**
   * Idempotent: subscribes to live updates, then pulls the current snapshot.
   * Callable again after a failed pull, which is how a host retries.
   */
  init: () => void;
}

let initialized = false;
let unsubscribe: (() => void) | null = null;
/** Bumped by a reset, so a pull from before it can't land in the next session. */
let epoch = 0;

export const usePluginHostedViewsStore = create<PluginHostedViewsState>((set) => ({
  views: null,
  loadFailed: false,
  init: () => {
    if (initialized) return;
    // Tolerate a partially stubbed bridge, and don't latch the guard until it
    // is there, so an early call stays retryable.
    const plugin = typeof window === "undefined" ? undefined : window.electron?.plugin;
    if (typeof plugin?.onHostedViewsChanged !== "function") return;
    initialized = true;
    const session = epoch;
    let pushed = false;
    set({ loadFailed: false });

    // Subscribed BEFORE the pull, so a snapshot landing mid-round-trip is kept.
    // Push is authoritative: a pull answered before that push is older than it.
    const off = plugin.onHostedViewsChanged(({ views }) => {
      pushed = true;
      set({ views, loadFailed: false });
    });
    unsubscribe = off;

    if (typeof plugin.getHostedViews !== "function") return;
    void plugin
      .getHostedViews()
      .then((views) => {
        if (pushed || session !== epoch) return;
        set({ views });
      })
      .catch((err: unknown) => {
        logWarn("[PluginHostedViews] Failed to fetch plugin hosted views", { error: err });
        if (pushed || session !== epoch) return;
        // Released rather than kept: the next `init` subscribes and pulls
        // afresh, and a push in between would already have answered.
        off();
        unsubscribe = null;
        initialized = false;
        set({ loadFailed: true });
      });
  },
}));

/** The view a plugin hosts at `location`, or `undefined` when this project isn't served one. */
export function selectPluginHostedView(
  views: readonly PluginHostedViewDescriptor[] | null,
  pluginId: string,
  location: Exclude<ViewLocation, "panel">
): PluginHostedViewDescriptor | undefined {
  return views?.find((view) => view.pluginId === pluginId && view.location === location);
}

/** Test-only: drop the snapshot and the subscription. */
export function _resetPluginHostedViewsStoreForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  epoch += 1;
  usePluginHostedViewsStore.setState({ views: null, loadFailed: false });
}
