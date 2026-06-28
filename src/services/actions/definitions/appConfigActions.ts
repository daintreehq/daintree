import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { AgentSettingsEntrySchema } from "./schemas";
import { z } from "zod";
import {
  agentSettingsClient,
  appClient,
  hibernationClient,
  idleTerminalClient,
  idleBackgroundAutoCloseClient,
  worktreeConfigClient,
} from "@/clients";
import { dispatchEscape } from "@/lib/escapeStack";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";

const ProjectIdArgsSchema = z.object({ projectId: z.string().min(1) });

export function registerAppConfigActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("agentSettings.get", () => ({
    id: "agentSettings.get",
    title: "Get Agent Settings",
    description:
      "Read the per-agent settings map (model, flags, and other agent configuration). Takes no args. Returns { agents } — a record keyed by agent id of settings entries — plus an optional `settingsVersion`. Never errors; unconfigured agents are absent from the map. Use `agentSettings.set` to change a value.",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({
      agents: z.record(z.string(), AgentSettingsEntrySchema),
      settingsVersion: z.number().optional(),
    }),
    run: async () => {
      const settings = await agentSettingsClient.get();
      useAgentSettingsStore.setState({
        settings,
        isLoading: false,
        error: null,
        isInitialized: true,
      });
      return settings;
    },
  }));

  actions.set("agentSettings.set", () => ({
    id: "agentSettings.set",
    title: "Update Agent Settings",
    description: "Update settings for an agent",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ agentId: z.string(), settings: AgentSettingsEntrySchema }),
    run: async (args: unknown) => {
      const { agentId, settings } = args as { agentId: string; settings: Record<string, unknown> };
      const updated = await agentSettingsClient.set(agentId, settings as any);
      useAgentSettingsStore.setState({
        settings: updated,
        isLoading: false,
        error: null,
        isInitialized: true,
      });
      return updated;
    },
  }));

  actions.set("agentSettings.reset", () => ({
    id: "agentSettings.reset",
    title: "Reset Agent Settings",
    description: "Reset settings for one agent or all agents",
    category: "settings",
    kind: "command",
    // Omitting agentId resets EVERY agent's model/flags with no undo — a
    // destructive-local (D1) mutation, so it requires confirmation and is
    // excluded from the MRU/repeat rails. Configured from Settings (which calls
    // the client directly), not the palette.
    danger: "confirm",
    dangerRationale:
      "Resets agent model and flag overrides to defaults. Omitting an agent id resets every agent at once, with no undo.",
    scope: "renderer",
    keywords: ["defaults", "restore", "clear", "agents"],
    palette: { mode: "hidden" },
    argsSchema: z
      .object({
        agentId: z.string().optional(),
      })
      .optional(),
    run: async (args: unknown) => {
      const { agentId } = (args as { agentId?: string } | undefined) ?? {};
      const updated = await agentSettingsClient.reset(agentId);
      useAgentSettingsStore.setState({
        settings: updated,
        isLoading: false,
        error: null,
        isInitialized: true,
      });
      return updated;
    },
  }));

  actions.set("hibernation.getConfig", () => ({
    id: "hibernation.getConfig",
    title: "Get Hibernation Config",
    description:
      "Read the auto-hibernation configuration that governs when idle worktrees are suspended to reclaim host memory. No arguments. Returns { enabled, inactiveThresholdHours }: `enabled` is whether auto-hibernation is on; `inactiveThresholdHours` is how long a worktree must be idle before it hibernates.",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    mcpVisibility: "discoverable",
    resultSchema: z.object({
      enabled: z.boolean(),
      inactiveThresholdHours: z.number(),
    }),
    run: async () => {
      return await hibernationClient.getConfig();
    },
  }));

  actions.set("hibernation.updateConfig", () => ({
    id: "hibernation.updateConfig",
    title: "Update Hibernation Config",
    description: "Update auto-hibernation configuration",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    // Config-patch tool: a palette pick dispatches `{}` (an empty patch that
    // changes nothing). Belongs in Settings, not the palette. Stays an MCP tool.
    palette: { mode: "hidden" },
    argsSchema: z.object({
      enabled: z.boolean().optional(),
      inactiveThresholdHours: z.number().int().positive().optional(),
    }),
    run: async (args: unknown) => {
      const config = args as { enabled?: boolean; inactiveThresholdHours?: number };
      return await hibernationClient.updateConfig(config);
    },
  }));

  actions.set("idleTerminalNotify.getConfig", () => ({
    id: "idleTerminalNotify.getConfig",
    title: "Get Idle Terminal Notification Config",
    description: "Get idle terminal notification configuration",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({
      enabled: z.boolean(),
      thresholdMinutes: z.number(),
    }),
    run: async () => {
      return await idleTerminalClient.getConfig();
    },
  }));

  actions.set("idleTerminalNotify.updateConfig", () => ({
    id: "idleTerminalNotify.updateConfig",
    title: "Update Idle Terminal Notification Config",
    description: "Update idle terminal notification configuration",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    // Config-patch tool: a palette pick dispatches `{}` (an empty patch that
    // changes nothing). Belongs in Settings, not the palette. Stays an MCP tool.
    palette: { mode: "hidden" },
    argsSchema: z.object({
      enabled: z.boolean().optional(),
      thresholdMinutes: z.number().int().positive().optional(),
    }),
    run: async (args: unknown) => {
      const config = args as { enabled?: boolean; thresholdMinutes?: number };
      return await idleTerminalClient.updateConfig(config);
    },
  }));

  actions.set("idleTerminalNotify.closeProject", () => ({
    id: "idleTerminalNotify.closeProject",
    title: "Close Idle Terminals",
    description:
      "Close (hibernate) the idle terminals in a background project. Args: { projectId }. Used as the recovery action on an idle-terminal inbox notification.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    // Contextual: requires a projectId from the originating notification, so it
    // has no meaning as a free-standing palette pick. nonRepeatable keeps a
    // PTY-terminating action out of the repeat-last and MRU rails, where it
    // could fire against a stale projectId.
    palette: { mode: "hidden" },
    nonRepeatable: true,
    argsSchema: ProjectIdArgsSchema,
    run: async (args: unknown) => {
      const { projectId } = ProjectIdArgsSchema.parse(args);
      await idleTerminalClient.closeProject(projectId);
    },
  }));

  actions.set("idleTerminalNotify.muteProject", () => ({
    id: "idleTerminalNotify.muteProject",
    title: "Mute Idle Terminal Notifications",
    description:
      "Mute idle-terminal notifications for a project for the cooldown window. Args: { projectId }. Used as the dismiss action on an idle-terminal inbox notification.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    palette: { mode: "hidden" },
    nonRepeatable: true,
    argsSchema: ProjectIdArgsSchema,
    run: async (args: unknown) => {
      const { projectId } = ProjectIdArgsSchema.parse(args);
      await idleTerminalClient.dismissProject(projectId);
    },
  }));

  actions.set("idleBackgroundAutoClose.getConfig", () => ({
    id: "idleBackgroundAutoClose.getConfig",
    title: "Get Idle Background Auto-Close Config",
    description: "Get the idle background-project auto-close configuration",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({
      enabled: z.boolean(),
      thresholdMinutes: z.number(),
    }),
    run: async () => {
      return await idleBackgroundAutoCloseClient.getConfig();
    },
  }));

  actions.set("idleBackgroundAutoClose.updateConfig", () => ({
    id: "idleBackgroundAutoClose.updateConfig",
    title: "Update Idle Background Auto-Close Config",
    description: "Update the idle background-project auto-close configuration",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    // Config-patch tool: a palette pick dispatches `{}` (an empty patch that
    // changes nothing). Belongs in Settings, not the palette. Stays an MCP tool.
    palette: { mode: "hidden" },
    argsSchema: z.object({
      enabled: z.boolean().optional(),
      thresholdMinutes: z.number().int().positive().optional(),
    }),
    run: async (args: unknown) => {
      const config = args as { enabled?: boolean; thresholdMinutes?: number };
      return await idleBackgroundAutoCloseClient.updateConfig(config);
    },
  }));

  actions.set("worktreeConfig.get", () => ({
    id: "worktreeConfig.get",
    title: "Get Worktree Config",
    description: "Get worktree configuration",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({ pathPattern: z.string() }),
    run: async () => {
      return await worktreeConfigClient.get();
    },
  }));

  actions.set("worktreeConfig.setPattern", () => ({
    id: "worktreeConfig.setPattern",
    title: "Set Worktree Path Pattern",
    description: "Update the default worktree path pattern",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ pattern: z.string().min(1) }),
    run: async (args: unknown) => {
      const { pattern } = args as { pattern: string };
      return await worktreeConfigClient.setPattern(pattern);
    },
  }));

  actions.set("modal.close", () => ({
    id: "modal.close",
    title: "Close Modal",
    description: "Close the active modal or dialog",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dismiss", "escape", "dialog", "overlay"],
    nonRepeatable: true,
    run: async () => {
      dispatchEscape();
    },
  }));

  actions.set("app.quit", () => ({
    id: "app.quit",
    title: "Quit App",
    description: "Quit Daintree",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["exit", "close", "shutdown", "leave"],
    run: async () => {
      await appClient.quit();
    },
  }));

  actions.set("app.forceQuit", () => ({
    id: "app.forceQuit",
    title: "Force Quit App",
    description: "Force quit Daintree immediately (no graceful shutdown)",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["exit", "kill", "shutdown", "terminate"],
    run: async () => {
      await appClient.forceQuit();
    },
  }));
}
