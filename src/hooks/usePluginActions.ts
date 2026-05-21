import { useEffect } from "react";
import { actionService } from "@/services/ActionService";
import type { AnyActionDefinition } from "@/services/actions/actionTypes";
import type { ActionDefinition } from "@shared/types/actions";
import type { PluginActionDescriptor } from "@shared/types/plugin";
import { requestPluginConfirmation, usePluginConfirmStore } from "@/store/pluginConfirmStore";
import { logWarn } from "@/utils/logger";

/**
 * Pull plugin-registered actions on mount and keep the renderer registry in
 * sync with main's plugin action set. Actions are registered as synthetic
 * ActionDefinitions whose run() bounces back to main via `plugin:invoke` —
 * the real handler lives in the plugin's main-process module.
 *
 * Pull-on-mount is a safety net for cached WebContentsViews that may have
 * missed a broadcast. Push-on-change is authoritative. Once a push has
 * arrived, any later-resolving pull from mount-time is ignored to avoid
 * rolling back state to an older snapshot.
 */
export function usePluginActions(): void {
  useEffect(() => {
    let disposed = false;
    let pushReceived = false;
    const registered = new Map<string, PluginActionDescriptor>();
    // requestIds of confirm dialogs currently awaiting a user decision.
    // Dropped on cleanup so an in-flight resolver can't outlive the hook
    // (HMR / app-state change while a modal is open) and strand its promise.
    const inFlightConfirms = new Set<string>();

    const sync = (descriptors: PluginActionDescriptor[]): void => {
      if (disposed) return;

      const incoming = new Map(descriptors.map((d) => [d.id, d]));

      for (const [id, current] of registered) {
        const next = incoming.get(id);
        if (!next) {
          actionService.unregister(id);
          registered.delete(id);
          continue;
        }
        if (!descriptorsEqual(current, next)) {
          // Re-register so stale title/category/schema is replaced.
          actionService.unregister(id);
          actionService.register(toSyntheticDefinition(next, inFlightConfirms));
          registered.set(id, next);
        }
      }

      for (const [id, descriptor] of incoming) {
        if (registered.has(id)) continue;
        if (actionService.has(id)) {
          logWarn(
            `[PluginActions] Action "${id}" already registered in renderer — skipping plugin-sourced registration`
          );
          continue;
        }
        actionService.register(toSyntheticDefinition(descriptor, inFlightConfirms));
        registered.set(id, descriptor);
      }
    };

    const electron = typeof window !== "undefined" ? window.electron : undefined;
    if (!electron?.plugin) return;

    void electron.plugin
      .getActions()
      .then((actions) => {
        if (disposed) return;
        // A push may have overtaken the mount-time pull. Trust the push and
        // drop the older snapshot rather than reverting.
        if (pushReceived) return;
        sync(actions);
      })
      .catch((err: unknown) => {
        logWarn("[PluginActions] Failed to fetch initial plugin actions", { error: err });
      });

    const cleanup = electron.plugin.onActionsChanged((payload) => {
      pushReceived = true;
      sync(payload.actions);
    });

    return () => {
      disposed = true;
      cleanup();
      // Settle any open confirm dialogs as "rejected" so their dispatch
      // promises resolve instead of leaking a resolver in the store.
      const drop = usePluginConfirmStore.getState().drop;
      for (const requestId of inFlightConfirms) {
        drop(requestId);
      }
      inFlightConfirms.clear();
      for (const id of registered.keys()) {
        actionService.unregister(id);
      }
      registered.clear();
    };
  }, []);
}

function descriptorsEqual(a: PluginActionDescriptor, b: PluginActionDescriptor): boolean {
  return (
    a.pluginId === b.pluginId &&
    a.id === b.id &&
    a.title === b.title &&
    a.description === b.description &&
    a.category === b.category &&
    a.kind === b.kind &&
    a.danger === b.danger &&
    a.effectiveDanger === b.effectiveDanger &&
    JSON.stringify(a.keywords ?? null) === JSON.stringify(b.keywords ?? null) &&
    JSON.stringify(a.inputSchema ?? null) === JSON.stringify(b.inputSchema ?? null)
  );
}

function toSyntheticDefinition(
  descriptor: PluginActionDescriptor,
  inFlightConfirms: Set<string>
): AnyActionDefinition {
  const { pluginId, id, title, description, category, kind, keywords, inputSchema } = descriptor;

  // Read the host-authoritative classification, never the plugin's advisory
  // `danger`. Fail safe to "confirm" if `effectiveDanger` is absent — e.g. a
  // stale descriptor from a pre-migration cached WebContentsView — so a
  // missing field can never silently downgrade a destructive action.
  const effectiveDanger = descriptor.effectiveDanger ?? "confirm";

  const definition: ActionDefinition = {
    id,
    title: title ?? "",
    description: description ?? "",
    category,
    kind,
    danger: effectiveDanger,
    scope: "renderer",
    keywords: keywords ? [...keywords] : undefined,
    run: async (args, ctx) => {
      // Confirm before dispatching a host-classified destructive plugin
      // action. Skip for agent-sourced dispatch: the MCP bridge already
      // surfaced its own confirm dialog and a second prompt would
      // double-gate the same call. This is a UI consent gate, not a
      // security boundary (enforcement is trust-based per #5651).
      if (effectiveDanger === "confirm" && ctx?.dispatchSource !== "agent") {
        const requestId = crypto.randomUUID();
        inFlightConfirms.add(requestId);
        let decision;
        try {
          decision = await requestPluginConfirmation({
            requestId,
            pluginId,
            actionId: id,
            actionTitle: title ?? id,
            actionDescription: description ?? "",
          });
        } finally {
          inFlightConfirms.delete(requestId);
        }
        // User cancelled (or the hook unmounted and dropped the request):
        // return silently. Returning a `{ ok: false }`-shaped value would be
        // wrapped by ActionService as a *successful* dispatch result, and a
        // thrown error would surface a misleading failure toast — neither is
        // correct for a deliberate user cancellation.
        if (decision !== "approved") {
          return undefined;
        }
      }
      return window.electron.plugin.invoke(pluginId, id, args);
    },
  };

  const synthetic = definition as AnyActionDefinition;
  synthetic.pluginId = pluginId;
  if (inputSchema) synthetic.rawInputSchema = { ...inputSchema };
  return synthetic;
}
