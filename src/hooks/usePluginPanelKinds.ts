import { useEffect, type ComponentType } from "react";
import {
  registerPanelKind,
  unregisterPanelKind,
  unregisterPluginPanelKinds,
  getPanelKindConfig,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import { registerPanelKindDefinition, unregisterPanelKindDefinition } from "@/registry";
import { TerminalPane } from "@/components/Terminal/TerminalPane";
import { makePluginViewHost } from "@/components/Plugin/PluginViewHost";
import { reconcileDockMembership } from "@/store/reconcileDockMembership";
import { logWarn } from "@/utils/logger";

/**
 * Pull plugin-contributed panel kinds on mount and keep the renderer
 * registries in sync with main's authoritative set. Panels using PTY are
 * rendered through `TerminalPane` (the only generic component that can host
 * an extension PTY); non-PTY plugin panels with a `componentPath` set by an
 * `views` contribution render through `makePluginViewHost`
 * (#9229), which lazy-imports the plugin's React module over the `plugin://`
 * protocol. Non-PTY plugin panels without a matching view remain
 * `PluginMissingPanel` placeholders.
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
// Metadata fields carried by a plugin panel kind over the IPC broadcast.
// Function fields (serialize/createDefaults/policy) never cross the bridge, so
// a shallow compare of these is a complete equality check for re-register
// detection.
const PANEL_KIND_META_KEYS = [
  "name",
  "iconId",
  "color",
  "hasPty",
  "canRestart",
  "canConvert",
  "usesTerminalUi",
  "keepAliveOnProjectSwitch",
  "firstRenderRestore",
  "lazyImportPath",
  "showInPalette",
  "dockable",
  "extensionId",
  "componentPath",
  "shortcut",
] as const satisfies readonly (keyof PanelKindConfig)[];

function panelKindMetaEqual(a: PanelKindConfig, b: PanelKindConfig): boolean {
  for (const key of PANEL_KIND_META_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  const aliasesA = a.searchAliases ?? [];
  const aliasesB = b.searchAliases ?? [];
  if (aliasesA.length !== aliasesB.length) return false;
  return aliasesA.every((alias, i) => alias === aliasesB[i]);
}

export function usePluginPanelKinds(): void {
  useEffect(() => {
    let disposed = false;
    let pushReceived = false;
    const registeredByPlugin = new Map<string, Set<string>>();
    // Memoize per-kind PluginViewHost factories so an identity-equal replay
    // snapshot (or any push that doesn't actually change a kind) does not
    // produce a new ComponentType ref. Without this, every broadcast would
    // unmount+remount every live plugin view subtree — losing local state,
    // in-flight requests, and active subscriptions. Cache key combines `id`
    // with `componentPath` so a plugin that ships a new bundle path
    // (legitimate hot-swap) does invalidate the cached host.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- registry component type uses unconstrained props
    const hostCache = new Map<string, ComponentType<any>>();

    // View-host entries are keyed `${id}\0${componentPath}` (see below), so a
    // bare `hostCache.delete(id)` never matches them — that was the leak in
    // #10512: removed kinds/plugins left their `ComponentType` closures
    // resident until the hook unmounted. Evict every entry owned by `id`
    // (the bare key from PTY/no-view paths AND any composite view-host key).
    const evictHostCache = (id: string): void => {
      hostCache.delete(id);
      const prefix = `${id}\0`;
      for (const key of hostCache.keys()) {
        if (key.startsWith(prefix)) hostCache.delete(key);
      }
    };

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
            evictHostCache(id);
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
              evictHostCache(id);
            }
          }
        }

        for (const config of configs) {
          // Only (re)register when the kind is new or its metadata actually
          // changed. Re-registering an unchanged kind triggers the registry's
          // "already registered, overwriting" warn on every broadcast (which
          // fires per plugin lifecycle event), desensitizing the signal meant
          // to catch genuine collisions.
          const existing = getPanelKindConfig(config.id);
          if (!existing || !panelKindMetaEqual(existing, config)) {
            registerPanelKind(config);
          }
          if (config.hasPty) {
            registerPanelKindDefinition(config.id, TerminalPane);
            evictHostCache(config.id);
          } else if (config.componentPath) {
            // Non-PTY plugin panel with a matching `views`
            // contribution — render through PluginViewHost (#9229). Cache by
            // (kind id + componentPath) so identity-equal replay snapshots
            // don't churn the component ref and unmount live plugin views.
            const cacheKey = `${config.id}\0${config.componentPath}`;
            let host = hostCache.get(cacheKey);
            if (!host) {
              host = makePluginViewHost(config);
              // A componentPath change for the same kind id invalidates the
              // prior cached entry — drop any other entry for this id.
              for (const key of hostCache.keys()) {
                if (key.startsWith(`${config.id}\0`) && key !== cacheKey) {
                  hostCache.delete(key);
                }
              }
              hostCache.set(cacheKey, host);
              registerPanelKindDefinition(config.id, host);
            }
          } else {
            // Non-PTY plugin panel with no view contribution falls back to
            // `PluginMissingPanel`. Also handles re-registration of a kind
            // that flipped from `hasPty: true` to `hasPty: false` without a
            // matching view: clear any prior TerminalPane definition.
            unregisterPanelKindDefinition(config.id);
            evictHostCache(config.id);
          }
        }

        registeredByPlugin.set(pluginId, incomingIds);
      }

      // A `dockable:true→false` flip or a plugin unregister above can strand
      // panels currently living in the dock (the dock now filters them out while
      // their stored location stays "dock"). Relocate them to the grid so they
      // stay reachable (#11375). Cheap — it scans dock membership, which is
      // small, and no-ops when nothing is stranded.
      reconcileDockMembership();
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
      hostCache.clear();
    };
  }, []);
}
