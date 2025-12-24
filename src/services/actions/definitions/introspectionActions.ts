import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";

export function registerIntrospectionActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("actions.list", () => ({
    id: "actions.list",
    title: "List Actions",
    description: "Get a manifest of all available actions",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async (_args, ctx: ActionContext) => {
      const { actionService } = await import("@/services/ActionService");
      return actionService.list(ctx);
    },
  }));

  actions.set("actions.getContext", () => ({
    id: "actions.getContext",
    title: "Get Action Context",
    description: "Get the current action execution context",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const { getActionContext } = await import("@/services/ActionService");
      return getActionContext();
    },
  }));
}
