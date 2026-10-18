import { create } from "zustand";
import type { PluginPanelBadge } from "@shared/types/plugin";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";

/**
 * Renderer mirror of the live toolbar-button badges plugins set via
 * `host.setToolbarButtonBadge` (#13503), keyed `pluginId → manifest button id →
 * badge` exactly as main sends it. Each `plugin:toolbar-badges-changed` event
 * carries one plugin's COMPLETE map, so it replaces that plugin's entry
 * wholesale; an empty map (also what an unload sends) drops it. Cold-restored
 * views get the current state replayed via `pushSnapshotTo`. Not persisted.
 *
 * Subscription is module-level so badges survive the toolbar remounting.
 */
type BadgesByPlugin = Record<string, Record<string, PluginPanelBadge>>;

interface PluginToolbarBadgeState {
  badgesByPlugin: BadgesByPlugin;
  /** Idempotent: subscribes to live badge updates. */
  init: () => void;
}

let initialized = false;
let unsubscribeChanged: (() => void) | null = null;

export const usePluginToolbarBadgeStore = create<PluginToolbarBadgeState>((set) => ({
  badgesByPlugin: {},
  init: () => {
    if (initialized) return;
    // Tolerate a partially-stubbed bridge, and stay retryable until it exists.
    const plugin = window.electron?.plugin;
    if (typeof plugin?.onToolbarBadgesChanged !== "function") return;
    initialized = true;

    unsubscribeChanged = plugin.onToolbarBadgesChanged(({ pluginId, badges }) => {
      set((state) => {
        if (Object.keys(badges).length === 0) {
          if (!(pluginId in state.badgesByPlugin)) return state;
          const { [pluginId]: _removed, ...badgesByPlugin } = state.badgesByPlugin;
          return { badgesByPlugin };
        }
        return { badgesByPlugin: { ...state.badgesByPlugin, [pluginId]: badges } };
      });
    });
  },
}));

/**
 * The badge on one plugin toolbar button, or null. A config's id is the
 * canonical `{pluginId}.{manifestId}` form, so the manifest id is what follows
 * the owning plugin's prefix — never a split on dots, which a plugin id may hold.
 */
export function toolbarBadgeFor(
  badgesByPlugin: BadgesByPlugin,
  config: Pick<ToolbarButtonConfig, "id" | "pluginId">
): PluginPanelBadge | null {
  const { pluginId } = config;
  if (!pluginId) return null;
  const prefix = `${pluginId}.`;
  if (!config.id.startsWith(prefix)) return null;
  return badgesByPlugin[pluginId]?.[config.id.slice(prefix.length)] ?? null;
}

/** Live badge for one plugin toolbar button, subscribing the store on first use. */
export function usePluginToolbarBadge(
  config: Pick<ToolbarButtonConfig, "id" | "pluginId">
): PluginPanelBadge | null {
  return usePluginToolbarBadgeStore((s) => toolbarBadgeFor(s.badgesByPlugin, config));
}

/** Test-only: reset the module-level init guard and state between cases. */
export function _resetPluginToolbarBadgeStoreForTest(): void {
  unsubscribeChanged?.();
  unsubscribeChanged = null;
  initialized = false;
  usePluginToolbarBadgeStore.setState({ badgesByPlugin: {} });
}
