import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { z } from "zod";

export function registerIntrospectionActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("actions.list", () => ({
    id: "actions.list",
    title: "List Actions",
    description:
      "Get a manifest of available actions. Use category or search to filter. Note: MCP clients already receive the tool list via the MCP protocol — use this only if you need action metadata like danger level or enabled state.",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        category: z
          .string()
          .optional()
          .describe("Filter by category (e.g. terminal, git, github, panel, sidecar)"),
        search: z.string().optional().describe("Search in action id, title, or description"),
        enabledOnly: z
          .boolean()
          .optional()
          .describe("Only return enabled actions (default: false)"),
      })
      .optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { category, search, enabledOnly } =
        (args as { category?: string; search?: string; enabledOnly?: boolean } | undefined) ?? {};
      const { actionService } = await import("@/services/ActionService");
      let manifest = actionService.list(ctx);

      if (category) {
        manifest = manifest.filter((a) => a.category === category);
      }
      if (search) {
        const q = search.toLowerCase();
        manifest = manifest.filter(
          (a) =>
            a.id.toLowerCase().includes(q) ||
            a.title.toLowerCase().includes(q) ||
            a.description.toLowerCase().includes(q)
        );
      }
      if (enabledOnly) {
        manifest = manifest.filter((a) => a.enabled);
      }

      return manifest;
    },
  }));

  actions.set("actions.getContext", () => ({
    id: "actions.getContext",
    title: "Get Action Context",
    description:
      "Get the current action execution context including focused panel, active worktree, and current project",
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
