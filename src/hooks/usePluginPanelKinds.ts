import { useEffect } from "react";
import {
  registerPanelKind,
  unregisterPanelKind,
  unregisterPluginPanelKinds,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import { registerPanelKindDefinition, unregisterPanelKindDefinition } from "@/registry";
import { TerminalPane } from "@/components/Terminal/TerminalPane";
import { logWarn } from "@/utils/logger";

/**
 * Pull plugin-contributed panel kinds on mount and keep the renderer
 * registries in sync with main's authoritative set. Panels using PTY are
 * rendered through `TerminalPane` (the only generic component that can host
 * an extension PTY); non-PTY plugin panels do not yet have a generic host
 * component and remain `PluginMissingPanel` placeholders until per-kind
 * components are registered separately.
 *
 * Pull-on-mount is a safety net for cached `WebContentsView`s that may have
 * missed a broadcast. Push-on-change is authoritative — once a push has
 * arrived, any later-resolving pull from mount-time is dropped to avoid
 * rolling back state.
 *
 * The hook updates two registries:
 *   1. `PANEL_KIND_REGISTRY` (shared) — so `getPanelKindConfig` returns the
 *      plugin's metadata (icon, color, hasPty) for kind-aware UI code.
 *   2. `PANEL_KIND_DEFINITION_REGISTRY` (renderer) — so `GridPanel` /
 *      `DockedPanel` resolve to a real React component instead of
 *      `PluginMissingPanel`. The mutation also notifies
 *      `useSyncExternalStore` subscribers, which is what causes a previously
 *      missing-kind panel to hot-swap into its real component.
 */
export function usePluginPanelKinds(): void {
  useEffect(() => {
    let disposed = false;
    let pushReceived = false;
    const registeredByPlugin = new Map<string, Set<string>>();

    const sync = (kinds: PanelKindConfig[]): void => {
      if (disposed) return;

      const incomingByPlugin = new Map<string, PanelKindConfig[]>();
      for (const config of kinds) {
        if (!config.extensionId) continue;
        let bucket = incomingByPlugin.get(config.extensionId);
        if (!bucket) {
          bucket = [];
          incomingByPlugin.set(config.extensionId, bucket);
        }
        bucket.push(config);
      }

      // Remove plugins (and their kinds) absent from the incoming snapshot
      for (const [pluginId, kindIds] of registeredByPlugin) {
        if (!incomingByPlugin.has(pluginId)) {
          for (const id of kindIds) {
            unregisterPanelKindDefinition(id);
          }
          unregisterPluginPanelKinds(pluginId);
          registeredByPlugin.delete(pluginId);
        }
      }

      // Reconcile each plugin's kinds against the new snapshot
      for (const [pluginId, configs] of incomingByPlugin) {
        const incomingIds = new Set(configs.map((c) => c.id));
        const previousIds = registeredByPlugin.get(pluginId);

        // Drop kinds the plugin no longer contributes — must clear both the
        // shared metadata registry and the renderer's component registry.
        if (previousIds) {
          for (const id of previousIds) {
            if (!incomingIds.has(id)) {
              unregisterPanelKindDefinition(id);
              unregisterPanelKind(id);
            }
          }
        }

        for (const config of configs) {
          registerPanelKind(config);
          if (config.hasPty) {
            registerPanelKindDefinition(config.id, TerminalPane);
          }
        }

        registeredByPlugin.set(pluginId, incomingIds);
      }
    };

    const electron = typeof window !== "undefined" ? window.electron : undefined;
    if (!electron?.plugin) return;

    void electron.plugin
      .getPanelKinds()
      .then((kinds) => {
        if (disposed) return;
        if (pushReceived) return;
        sync(kinds);
      })
      .catch((err: unknown) => {
        logWarn("[PluginPanelKinds] Failed to fetch initial plugin panel kinds", { error: err });
      });

    const cleanup = electron.plugin.onPanelKindsChanged((payload) => {
      pushReceived = true;
      sync(payload.kinds);
    });

    return () => {
      disposed = true;
      cleanup();
      for (const [pluginId, kindIds] of registeredByPlugin) {
        for (const id of kindIds) {
          unregisterPanelKindDefinition(id);
        }
        unregisterPluginPanelKinds(pluginId);
      }
      registeredByPlugin.clear();
    };
  }, []);
}
