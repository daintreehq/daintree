import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { z } from "zod";
import { useTerminalStore } from "@/store/terminalStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";

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
      "Get the current UI context: focused terminal, active worktree, current project, and sidecar state",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
      const { useSidecarStore } = await import("@/store/sidecarStore");

      const project = useProjectStore.getState().currentProject;
      const terminalState = useTerminalStore.getState();
      const worktreeSelection = useWorktreeSelectionStore.getState();
      const worktrees = useWorktreeDataStore.getState().worktrees;
      const sidecar = useSidecarStore.getState();

      const focusedId = terminalState.focusedId;
      const focusedTerminal = focusedId
        ? terminalState.terminals.find((t) => t.id === focusedId)
        : null;

      const activeWorktreeId = worktreeSelection.activeWorktreeId;
      const activeWorktree = activeWorktreeId ? worktrees.get(activeWorktreeId) : null;

      const ctx: ActionContext = {
        projectId: project?.id,
        projectName: project?.name,
        projectPath: project?.path,
        activeWorktreeId: activeWorktreeId ?? undefined,
        activeWorktreeName: activeWorktree?.name,
        activeWorktreePath: activeWorktree?.path,
        activeWorktreeBranch: activeWorktree?.branch,
        activeWorktreeIsMain: activeWorktree?.isMainWorktree,
        focusedWorktreeId: worktreeSelection.focusedWorktreeId ?? undefined,
        focusedTerminalId: focusedId ?? undefined,
        focusedTerminalKind: focusedTerminal?.kind,
        focusedTerminalType: focusedTerminal?.type,
        focusedTerminalTitle: focusedTerminal?.title,
      };

      return {
        ...ctx,
        sidecarOpen: sidecar.isOpen,
        sidecarActiveTabId: sidecar.activeTabId,
        terminalCount: terminalState.terminals.filter((t) => t.location !== "trash").length,
        worktreeCount: worktrees.size,
      };
    },
  }));
}
