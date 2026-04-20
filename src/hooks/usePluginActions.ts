import { useEffect } from "react";
import { actionService } from "@/services/ActionService";
import type { AnyActionDefinition } from "@/services/actions/actionTypes";
import type { ActionDefinition } from "@shared/types/actions";
import type { PluginActionDescriptor } from "@shared/types/plugin";
import { logWarn } from "@/utils/logger";

/**
 * Pull plugin-registered actions on mount and keep the renderer registry in
 * sync with main's plugin action set. Actions are registered as synthetic
 * ActionDefinitions whose run() bounces back to main via `plugin:invoke` —
 * the real handler lives in the plugin's main-process module.
 *
 * Pull-on-mount + push-on-change: a full-list broadcast makes pull and push
 * semantically identical, so a missed event during load cannot leave stale
 * state on a cached WebContentsView.
 */
export function usePluginActions(): void {
  useEffect(() => {
    let disposed = false;
    const registeredIds = new Set<string>();

    const sync = (descriptors: PluginActionDescriptor[]): void => {
      if (disposed) return;

      const incoming = new Map(descriptors.map((d) => [d.id, d]));

      for (const id of registeredIds) {
        if (!incoming.has(id)) {
          actionService.unregister(id);
          registeredIds.delete(id);
        }
      }

      for (const [id, descriptor] of incoming) {
        if (registeredIds.has(id)) continue;
        if (actionService.has(id)) {
          logWarn(
            `[PluginActions] Action "${id}" already registered in renderer — skipping plugin-sourced registration`
          );
          continue;
        }
        const definition = toSyntheticDefinition(descriptor);
        actionService.register(definition);
        registeredIds.add(id);
      }
    };

    const electron = typeof window !== "undefined" ? window.electron : undefined;
    if (!electron?.plugin) return;

    void electron.plugin
      .getActions()
      .then((actions) => {
        if (!disposed) sync(actions);
      })
      .catch((err: unknown) => {
        logWarn("[PluginActions] Failed to fetch initial plugin actions", { error: err });
      });

    const cleanup = electron.plugin.onActionsChanged((payload) => {
      sync(payload.actions);
    });

    return () => {
      disposed = true;
      cleanup();
      for (const id of registeredIds) {
        actionService.unregister(id);
      }
      registeredIds.clear();
    };
  }, []);
}

function toSyntheticDefinition(descriptor: PluginActionDescriptor): AnyActionDefinition {
  const { pluginId, id, title, description, category, kind, danger, keywords, inputSchema } =
    descriptor;

  const definition: ActionDefinition = {
    id,
    title,
    description,
    category,
    kind,
    danger,
    scope: "renderer",
    keywords: keywords ? [...keywords] : undefined,
    run: async (args) => {
      return window.electron.plugin.invoke(pluginId, id, args);
    },
  };

  const synthetic = definition as AnyActionDefinition;
  synthetic.pluginId = pluginId;
  if (inputSchema) synthetic.rawInputSchema = inputSchema;
  return synthetic;
}
