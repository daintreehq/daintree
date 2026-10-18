import { create } from "zustand";
import type { PluginContextValue } from "@shared/types/plugin";
import type { WhenClauseContext } from "@shared/utils/whenClause/types";
import { buildPluginWhenContext } from "@shared/utils/pluginContextKeys";

/**
 * Renderer mirror of the `when`-clause context keys plugins publish via
 * `host.setContext` (#13506), keyed `pluginId → key → value` exactly as main
 * sends it. Each `plugin:context-keys-changed` event carries one plugin's
 * COMPLETE map, so it replaces that plugin's entry wholesale; `null` (an
 * unload) drops it. An empty map is kept: a project instance with no keys
 * still owns its namespace over an installed copy's. Cold-restored views get
 * the current state replayed via `pushSnapshotTo`. Not persisted.
 *
 * `whenContext` is the same keys nested under each plugin's manifest name,
 * rebuilt only when a plugin's keys change, so the keydown path reads it
 * without rebuilding anything.
 */
type KeysByPlugin = Record<string, Record<string, PluginContextValue>>;

interface PluginContextKeyState {
  keysByPlugin: KeysByPlugin;
  whenContext: WhenClauseContext;
  /** Idempotent: subscribes to live context-key updates. */
  init: () => void;
}

let initialized = false;
let unsubscribeChanged: (() => void) | null = null;

export const usePluginContextKeyStore = create<PluginContextKeyState>((set) => ({
  keysByPlugin: {},
  whenContext: {},
  init: () => {
    if (initialized) return;
    // Tolerate a partially-stubbed bridge, and stay retryable until it exists.
    const plugin = window.electron?.plugin;
    if (typeof plugin?.onContextKeysChanged !== "function") return;
    initialized = true;

    unsubscribeChanged = plugin.onContextKeysChanged(({ pluginId, keys }) => {
      set((state) => {
        let keysByPlugin: KeysByPlugin;
        if (keys === null) {
          if (!(pluginId in state.keysByPlugin)) return state;
          const { [pluginId]: _removed, ...rest } = state.keysByPlugin;
          keysByPlugin = rest;
        } else {
          keysByPlugin = { ...state.keysByPlugin, [pluginId]: keys };
        }
        return { keysByPlugin, whenContext: buildPluginWhenContext(keysByPlugin) };
      });
    });
  },
}));

/** Test-only: reset the module-level init guard and state between cases. */
export function _resetPluginContextKeyStoreForTest(): void {
  unsubscribeChanged?.();
  unsubscribeChanged = null;
  initialized = false;
  usePluginContextKeyStore.setState({ keysByPlugin: {}, whenContext: {} });
}
