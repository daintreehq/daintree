import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { AgentSettingsEntrySchema } from "./schemas";
import { z } from "zod";
import {
  agentSettingsClient,
  appClient,
  hibernationClient,
  idleTerminalClient,
  worktreeConfigClient,
} from "@/clients";
import { dispatchEscape } from "@/lib/escapeStack";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";

export function registerAppConfigActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("agentSettings.get", () => ({
    id: "agentSettings.get",
    title: "Get Agent Settings",
    description: "Get agent settings",
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
    danger: "safe",
    scope: "renderer",
    keywords: ["defaults", "restore", "clear", "agents"],
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
    description: "Get auto-hibernation configuration",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
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
    argsSchema: z.object({
      enabled: z.boolean().optional(),
      thresholdMinutes: z.number().int().positive().optional(),
    }),
    run: async (args: unknown) => {
      const config = args as { enabled?: boolean; thresholdMinutes?: number };
      return await idleTerminalClient.updateConfig(config);
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
