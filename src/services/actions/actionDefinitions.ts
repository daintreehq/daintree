import { z } from "zod";
import type { ActionDefinition, ActionContext, ActionId } from "@shared/types/actions";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

const AgentIdSchema = z.enum(["claude", "gemini", "codex", "terminal", "browser"]);

const SettingsTabSchema = z.enum([
  "general",
  "keyboard",
  "terminal",
  "terminalAppearance",
  "worktree",
  "agents",
  "github",
  "sidecar",
  "troubleshooting",
]);

export type ActionRegistry = Map<ActionId, () => ActionDefinition<unknown, unknown>>;

export function createActionDefinitions(callbacks: {
  onOpenSettings: () => void;
  onOpenSettingsTab: (tab: string) => void;
  onToggleSidebar: () => void;
  onOpenAgentPalette: () => void;
  onLaunchAgent: (
    agentId: string,
    options?: { cwd?: string; worktreeId?: string }
  ) => Promise<void>;
  getDefaultCwd: () => string;
  getActiveWorktreeId: () => string | undefined;
}): ActionRegistry {
  const actions = new Map<ActionId, () => ActionDefinition<unknown, unknown>>();

  actions.set("terminal.new", () => ({
    id: "terminal.new",
    title: "New Terminal",
    description: "Create a new terminal in the active worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const addTerminal = useTerminalStore.getState().addTerminal;
      await addTerminal({
        type: "terminal",
        cwd: callbacks.getDefaultCwd(),
        location: "grid",
        worktreeId: callbacks.getActiveWorktreeId(),
      });
    },
  }));

  actions.set("worktree.createDialog.open", () => ({
    id: "worktree.createDialog.open",
    title: "New Worktree",
    description: "Open dialog to create a new worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const openCreateWorktreeDialog = useWorktreeSelectionStore.getState().openCreateDialog;
      openCreateWorktreeDialog();
    },
  }));

  actions.set("app.settings", () => ({
    id: "app.settings",
    title: "Open Settings",
    description: "Open the settings modal",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenSettings();
    },
  }));

  actions.set("app.settings.openTab", () => ({
    id: "app.settings.openTab",
    title: "Open Settings Tab",
    description: "Open a specific settings tab",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tab: SettingsTabSchema }),
    run: async (args: unknown) => {
      const { tab } = args as { tab: string };
      callbacks.onOpenSettingsTab(tab);
    },
  }));

  actions.set("nav.toggleSidebar", () => ({
    id: "nav.toggleSidebar",
    title: "Toggle Sidebar",
    description: "Toggle sidebar/focus mode",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onToggleSidebar();
    },
  }));

  actions.set("terminal.palette", () => ({
    id: "terminal.palette",
    title: "Open Agent Palette",
    description: "Open the terminal/agent palette",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenAgentPalette();
    },
  }));

  actions.set("agent.launch", () => ({
    id: "agent.launch",
    title: "Launch Agent",
    description: "Launch an AI agent in a new terminal",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      agentId: AgentIdSchema,
      cwd: z.string().optional(),
      worktreeId: z.string().optional(),
    }),
    run: async (args: unknown) => {
      const { agentId, cwd, worktreeId } = args as {
        agentId: string;
        cwd?: string;
        worktreeId?: string;
      };
      await callbacks.onLaunchAgent(agentId, { cwd, worktreeId });
    },
  }));

  actions.set("actions.list", () => ({
    id: "actions.list",
    title: "List Actions",
    description: "Get a manifest of all available actions",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async (_args, ctx: ActionContext) => {
      const { actionService } = await import("../ActionService");
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
      const { getActionContext } = await import("../ActionService");
      return getActionContext();
    },
  }));

  return actions;
}
