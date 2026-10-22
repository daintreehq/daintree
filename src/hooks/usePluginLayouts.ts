import { useEffect } from "react";
import type { PluginLayoutConfig } from "@shared/types/plugin";
import type { ActionDefinition, ActionId } from "@shared/types/actions";
import { actionService } from "@/services/ActionService";
import { applyPluginLayout } from "@/services/layout/applyPluginLayout";
import { usePluginLayoutsStore } from "@/store/pluginLayoutsStore";
import { logWarn } from "@/utils/logger";

/** Palette entry for one plugin layout; `layout.apply` stays the one dispatch entry point. */
export function pluginLayoutActionId(layoutId: string): ActionId {
  return `layout.apply.${layoutId}` as ActionId;
}

function toAction(layout: PluginLayoutConfig): ActionDefinition {
  return {
    id: pluginLayoutActionId(layout.id),
    title: `Apply layout: ${layout.name}`,
    description: `Open or move the panels in the ${layout.name} layout from ${layout.pluginName}`,
    category: "panel",
    kind: "command",
    danger: "safe",
    nonRepeatable: true,
    scope: "renderer",
    keywords: ["layout", "arrange", "panels", layout.pluginName],
    mcpVisibility: "hidden",
    run: async (_args, ctx) => {
      await applyPluginLayout(layout.id, ctx);
    },
  };
}

/**
 * Mirror main's plugin layouts for this view's project (#13780) into the
 * layouts store and the action palette, one row per layout. A layout that
 * leaves the snapshot — plugin disabled, uninstalled, hidden in this project or
 * reloaded — loses its row.
 *
 * Pull-on-mount is a safety net for a view that missed a broadcast; push is
 * authoritative, so a pull resolving after a push is dropped (see
 * {@link usePluginTours}).
 */
export function usePluginLayouts(): void {
  useEffect(() => {
    const electron = typeof window !== "undefined" ? window.electron : undefined;
    if (!electron?.plugin) return;

    let disposed = false;
    let pushReceived = false;
    const registered = new Map<string, { key: string; actionId: ActionId }>();

    const withdraw = (id: string): void => {
      const entry = registered.get(id);
      if (!entry) return;
      actionService.unregister(entry.actionId);
      registered.delete(id);
    };

    const sync = (layouts: readonly PluginLayoutConfig[]): void => {
      if (disposed) return;
      usePluginLayoutsStore.getState().setLayouts(layouts);
      const incoming = new Map(layouts.map((layout) => [layout.id, layout]));
      for (const [id, entry] of registered) {
        const next = incoming.get(id);
        if (!next || JSON.stringify(next) !== entry.key) withdraw(id);
      }
      for (const [id, layout] of incoming) {
        if (registered.has(id)) continue;
        const actionId = pluginLayoutActionId(id);
        if (actionService.has(actionId)) {
          logWarn("[PluginLayouts] An action is already registered under this id", { actionId });
          continue;
        }
        actionService.register(toAction(layout));
        registered.set(id, { key: JSON.stringify(layout), actionId });
      }
    };

    void electron.plugin
      .layouts()
      .then((layouts) => {
        if (!pushReceived) sync(layouts);
      })
      .catch((error: unknown) => {
        logWarn("[PluginLayouts] Failed to fetch initial plugin layouts", { error });
      });

    const cleanup = electron.plugin.onLayoutsChanged((payload) => {
      pushReceived = true;
      sync(payload.layouts);
    });

    return () => {
      disposed = true;
      cleanup();
      for (const id of [...registered.keys()]) withdraw(id);
      usePluginLayoutsStore.getState().setLayouts([]);
    };
  }, []);
}
