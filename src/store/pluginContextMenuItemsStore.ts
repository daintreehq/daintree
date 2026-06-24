import { create } from "zustand";
import type { ContextMenuContribution } from "@shared/types/plugin";
import { logWarn } from "@/utils/logger";

export interface PluginContextMenuItemEntry {
  pluginId: string;
  item: ContextMenuContribution;
}

/**
 * Renderer mirror of the plugin-contributed context-menu items. Source of truth
 * is `PluginService` in main; we pull the current set once and keep it in sync
 * via the authoritative `plugin:context-menu-items-changed` push.
 *
 * The pull + subscription live here (one IPC round-trip, one listener) instead
 * of in every `usePluginContextMenuItems` caller — the hook is rendered once per
 * worktree card, file-change row, and terminal menu, so a per-instance pull
 * scaled the IPC traffic and listener count with the surface count (#10753). The
 * subscription is module-level (not per-component) so it survives consumer
 * unmount/remount (list churn, dock/grid toggle, LRU view restore) and no push
 * is missed between renders — it is never torn down for the renderer's lifetime.
 *
 * The `complete` flag on the broadcast is received but has no side effect (no
 * renderer-local persisted state to sweep); it is plumbed for symmetry with the
 * broadcast contract.
 */
interface PluginContextMenuItemsState {
  entries: PluginContextMenuItemEntry[];
  /** Idempotent: pulls the current set once and subscribes to live updates. */
  init: () => void;
}

let initialized = false;
let unsubscribe: (() => void) | null = null;
// Monotonic pull sequence: the one-shot mount pull must never overwrite a push
// that arrived while it was in flight. A push bumps this before applying its
// payload, so the older pull bails on resolution (push is authoritative).
let pullSeq = 0;

export const usePluginContextMenuItemsStore = create<PluginContextMenuItemsState>((set) => ({
  entries: [],
  init: () => {
    if (initialized) return;

    // Consumed from many leaf components (every worktree card, file-change row,
    // terminal menu), so tolerate a partially-stubbed bridge instead of pushing
    // a plugin-namespace mock into every component test. Absent bridge ⇒ empty
    // set, matching prod before the first pull. Don't latch `initialized` until
    // the bridge is present, so a no-bridge early return stays retryable.
    const plugin = window.electron?.plugin;
    if (
      typeof plugin?.contextMenuItems !== "function" ||
      typeof plugin.onContextMenuItemsChanged !== "function"
    ) {
      return;
    }
    initialized = true;

    // Capture the pull's sequence and start it BEFORE registering the listener:
    // a push that arrives while the pull is in flight bumps `pullSeq`, so the
    // stale pull bails on resolution.
    const seq = ++pullSeq;
    void plugin
      .contextMenuItems()
      .then((items) => {
        if (seq !== pullSeq) return;
        set({ entries: items });
      })
      .catch((err: unknown) => {
        logWarn("[pluginContextMenuItemsStore] Failed to fetch initial plugin context menu items", {
          error: err,
        });
      });

    unsubscribe = plugin.onContextMenuItemsChanged((payload) => {
      pullSeq++;
      set({ entries: payload.items });
    });
  },
}));

/** Test-only: reset the module-level init guard, pull sequence, and state. */
export function _resetPluginContextMenuItemsStoreForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  pullSeq = 0;
  usePluginContextMenuItemsStore.setState({ entries: [] });
}
