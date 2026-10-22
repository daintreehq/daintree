import { create } from "zustand";
import type { PluginToolbarButtonRuntimeState } from "@shared/types/plugin";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";

/**
 * Renderer mirror of the live toolbar-button state plugins set via
 * `host.setToolbarButtonState` (#13785), keyed `pluginId → manifest button id →
 * state` exactly as main sends it. Each `plugin:toolbar-states-changed` event
 * carries one plugin's COMPLETE map, so it replaces that plugin's entry
 * wholesale; an empty map (also what an unload sends) drops it. Cold-restored
 * views get the current state replayed via `pushSnapshotTo`. Not persisted.
 *
 * Subscription is module-level so state survives the toolbar remounting.
 */
type StatesByPlugin = Record<string, Record<string, PluginToolbarButtonRuntimeState>>;

interface PluginToolbarStateStoreState {
  statesByPlugin: StatesByPlugin;
  /** Idempotent: subscribes to live state updates. */
  init: () => void;
}

let initialized = false;
let unsubscribeChanged: (() => void) | null = null;

export const usePluginToolbarStateStore = create<PluginToolbarStateStoreState>((set) => ({
  statesByPlugin: {},
  init: () => {
    if (initialized) return;
    const plugin = window.electron?.plugin;
    if (typeof plugin?.onToolbarStatesChanged !== "function") return;
    initialized = true;

    unsubscribeChanged = plugin.onToolbarStatesChanged(({ pluginId, states }) => {
      set((state) => {
        if (Object.keys(states).length === 0) {
          if (!(pluginId in state.statesByPlugin)) return state;
          const { [pluginId]: _removed, ...statesByPlugin } = state.statesByPlugin;
          return { statesByPlugin };
        }
        return { statesByPlugin: { ...state.statesByPlugin, [pluginId]: states } };
      });
    });
  },
}));

/**
 * The live state of one plugin toolbar button, or null. The manifest id is what
 * follows the owning plugin's prefix, as in `toolbarBadgeFor`.
 */
export function toolbarStateFor(
  statesByPlugin: StatesByPlugin,
  config: Pick<ToolbarButtonConfig, "id" | "pluginId">
): PluginToolbarButtonRuntimeState | null {
  const { pluginId } = config;
  if (!pluginId) return null;
  const prefix = `${pluginId}.`;
  if (!config.id.startsWith(prefix)) return null;
  return statesByPlugin[pluginId]?.[config.id.slice(prefix.length)] ?? null;
}

/** Live state for one plugin toolbar button. */
export function usePluginToolbarButtonState(
  config: Pick<ToolbarButtonConfig, "id" | "pluginId">
): PluginToolbarButtonRuntimeState | null {
  return usePluginToolbarStateStore((s) => toolbarStateFor(s.statesByPlugin, config));
}

/** Test-only: reset the module-level init guard and state between cases. */
export function _resetPluginToolbarStateStoreForTest(): void {
  unsubscribeChanged?.();
  unsubscribeChanged = null;
  initialized = false;
  usePluginToolbarStateStore.setState({ statesByPlugin: {} });
}
