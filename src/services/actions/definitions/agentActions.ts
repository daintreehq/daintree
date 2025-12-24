import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { AgentIdSchema, LaunchLocationSchema } from "./schemas";
import { z } from "zod";
import { useTerminalStore } from "@/store/terminalStore";

export function registerAgentActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
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
      location: LaunchLocationSchema.optional(),
      cwd: z.string().optional(),
      worktreeId: z.string().optional(),
      prompt: z.string().optional(),
      interactive: z.boolean().optional(),
    }),
    run: async (args: unknown) => {
      const { agentId, location, cwd, worktreeId, prompt, interactive } = args as {
        agentId: string;
        location?: "grid" | "dock";
        cwd?: string;
        worktreeId?: string;
        prompt?: string;
        interactive?: boolean;
      };
      await callbacks.onLaunchAgent(agentId, { location, cwd, worktreeId, prompt, interactive });
    },
  }));

  actions.set("agent.palette", () => ({
    id: "agent.palette",
    title: "Open Agent Palette",
    description: "Open the agent selection palette",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenAgentPalette();
    },
  }));

  actions.set("agent.claude", () => ({
    id: "agent.claude",
    title: "Launch Claude",
    description: "Launch Claude agent",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      await callbacks.onLaunchAgent("claude");
    },
  }));

  actions.set("agent.gemini", () => ({
    id: "agent.gemini",
    title: "Launch Gemini",
    description: "Launch Gemini agent",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      await callbacks.onLaunchAgent("gemini");
    },
  }));

  actions.set("agent.codex", () => ({
    id: "agent.codex",
    title: "Launch Codex",
    description: "Launch Codex agent",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      await callbacks.onLaunchAgent("codex");
    },
  }));

  actions.set("agent.terminal", () => ({
    id: "agent.terminal",
    title: "Launch Terminal",
    description: "Launch a plain terminal",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      await callbacks.onLaunchAgent("terminal");
    },
  }));

  actions.set("agent.focusNextWaiting", () => ({
    id: "agent.focusNextWaiting",
    title: "Focus Next Waiting Agent",
    description: "Focus the next agent in waiting state",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = useTerminalStore.getState();
      state.focusNextWaiting(state.isInTrash);
    },
  }));
}
