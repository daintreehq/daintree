import { useEffect } from "react";
import { create } from "zustand";
import {
  samePanelMenuItems,
  type PublishedPanelMenuItem,
} from "@shared/utils/pluginPanelMenuItems";

type WorkerMenusByPanelId = Record<string, Record<string, readonly PublishedPanelMenuItem[]>>;

interface PluginPanelMenuState {
  /**
   * Lists a plugin's backend published with `host.setPanelMenuItems`,
   * `panelId → pluginId → items`. Mirrors main, which owns them and replays
   * them to a restored view.
   */
  workerMenusByPanelId: WorkerMenusByPanelId;
  /** Lists a view published with `PanelViewProps.setMenuItems`, `panelId → items`. */
  viewMenusByPanelId: Record<string, readonly PublishedPanelMenuItem[]>;
  /** Idempotent: subscribes to the backend lists main pushes. */
  init: () => void;
  /** Replace the view's list for a panel; an empty list clears it. */
  setViewItems: (panelId: string, items: readonly PublishedPanelMenuItem[]) => void;
  /** Drop every list on a panel: it closed. */
  removePanel: (panelId: string) => void;
}

let initialized = false;
let unsubscribeChanged: (() => void) | null = null;
let unsubscribeCleared: (() => void) | null = null;

/**
 * Replace one plugin's whole set of backend lists. Panels the plugin touches
 * neither before nor after keep their object reference, so their menus do not
 * re-render.
 */
function applyPluginMenus(
  current: WorkerMenusByPanelId,
  pluginId: string,
  menus: Record<string, readonly PublishedPanelMenuItem[]>
): WorkerMenusByPanelId {
  const affected = new Set<string>(Object.keys(menus));
  for (const [panelId, byPlugin] of Object.entries(current)) {
    if (pluginId in byPlugin) affected.add(panelId);
  }
  if (affected.size === 0) return current;

  const next: WorkerMenusByPanelId = {};
  let changed = false;
  for (const [panelId, byPlugin] of Object.entries(current)) {
    if (!affected.has(panelId)) next[panelId] = byPlugin;
  }
  for (const panelId of affected) {
    const before = current[panelId];
    const previous = before?.[pluginId];
    const items = menus[panelId];
    if (previous !== undefined && items !== undefined && samePanelMenuItems(previous, items)) {
      next[panelId] = before!;
      continue;
    }
    changed = true;
    const inner = { ...before };
    delete inner[pluginId];
    if (items !== undefined && items.length > 0) inner[pluginId] = items;
    if (Object.keys(inner).length > 0) next[panelId] = inner;
  }
  return changed ? next : current;
}

/**
 * The contextual actions plugins published for their panels' menus at runtime
 * (#13213), from the view and from the backend. Kept apart because each has
 * its own owner: the view's list goes when the view reloads, the backend's
 * when the plugin unloads. Keyed by panel so a menu reads its panel's lists in
 * O(1) and they outlive a view unmounting. Not persisted. The renderer store
 * orchestrator prunes a closed panel.
 */
export const usePluginPanelMenuStore = create<PluginPanelMenuState>((set, get) => ({
  workerMenusByPanelId: {},
  viewMenusByPanelId: {},
  init: () => {
    if (initialized) return;
    // Tolerate a partially-stubbed bridge, and stay retryable until it exists.
    const plugin = window.electron?.plugin;
    if (
      typeof plugin?.onPanelMenusChanged !== "function" ||
      typeof plugin.onPanelMenusCleared !== "function"
    ) {
      return;
    }
    initialized = true;
    unsubscribeChanged = plugin.onPanelMenusChanged(({ pluginId, menus }) => {
      const workerMenusByPanelId = applyPluginMenus(get().workerMenusByPanelId, pluginId, menus);
      if (workerMenusByPanelId !== get().workerMenusByPanelId) set({ workerMenusByPanelId });
    });
    unsubscribeCleared = plugin.onPanelMenusCleared(({ pluginId }) => {
      const workerMenusByPanelId = applyPluginMenus(get().workerMenusByPanelId, pluginId, {});
      if (workerMenusByPanelId !== get().workerMenusByPanelId) set({ workerMenusByPanelId });
    });
  },
  setViewItems: (panelId, items) =>
    set((state) => {
      const previous = state.viewMenusByPanelId[panelId];
      if (items.length === 0) {
        if (previous === undefined) return state;
        const { [panelId]: _removed, ...viewMenusByPanelId } = state.viewMenusByPanelId;
        return { viewMenusByPanelId };
      }
      if (previous !== undefined && samePanelMenuItems(previous, items)) return state;
      return { viewMenusByPanelId: { ...state.viewMenusByPanelId, [panelId]: items } };
    }),
  removePanel: (panelId) =>
    set((state) => {
      const inWorker = panelId in state.workerMenusByPanelId;
      const inView = panelId in state.viewMenusByPanelId;
      if (!inWorker && !inView) return state;
      const next: Partial<PluginPanelMenuState> = {};
      if (inWorker) {
        const { [panelId]: _removed, ...rest } = state.workerMenusByPanelId;
        next.workerMenusByPanelId = rest;
      }
      if (inView) {
        const { [panelId]: _removed, ...rest } = state.viewMenusByPanelId;
        next.viewMenusByPanelId = rest;
      }
      return next;
    }),
}));

/** Subscribe to the backend lists for the renderer's lifetime. Mounted once, in `App`. */
export function usePluginPanelMenuSubscription(): void {
  useEffect(() => {
    usePluginPanelMenuStore.getState().init();
  }, []);
}

const NO_ITEMS: readonly PublishedPanelMenuItem[] = Object.freeze([]);
const NO_WORKER_MENUS: Readonly<Record<string, readonly PublishedPanelMenuItem[]>> = Object.freeze(
  {}
);

/**
 * The list the panel's view published; the reference holds while it is
 * unchanged. `enabled: false` reads nothing, for a menu kept mounted closed
 * that should not re-render on a publish.
 */
export function usePanelViewMenuItems(
  panelId: string,
  enabled = true
): readonly PublishedPanelMenuItem[] {
  return usePluginPanelMenuStore((s) =>
    enabled ? (s.viewMenusByPanelId[panelId] ?? NO_ITEMS) : NO_ITEMS
  );
}

/** The lists backends published on the panel, by plugin; as {@link usePanelViewMenuItems}. */
export function usePanelWorkerMenus(
  panelId: string,
  enabled = true
): Readonly<Record<string, readonly PublishedPanelMenuItem[]>> {
  return usePluginPanelMenuStore((s) =>
    enabled ? (s.workerMenusByPanelId[panelId] ?? NO_WORKER_MENUS) : NO_WORKER_MENUS
  );
}

/** Test-only: reset the module-level init guard and state between cases. */
export function _resetPluginPanelMenuStoreForTest(): void {
  unsubscribeChanged?.();
  unsubscribeCleared?.();
  unsubscribeChanged = null;
  unsubscribeCleared = null;
  initialized = false;
  usePluginPanelMenuStore.setState({ workerMenusByPanelId: {}, viewMenusByPanelId: {} });
}
