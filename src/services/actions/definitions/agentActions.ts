import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { AgentIdSchema, LaunchLocationSchema } from "./schemas";
import { z } from "zod";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { AGENT_REGISTRY } from "@/config/agents";
import type { ActionId } from "@shared/types/actions";
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
      model: z.string().optional(),
      presetId: z.string().nullable().optional(),
      activateDockOnCreate: z.boolean().optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
    run: async (args: unknown) => {
      const {
        agentId,
        location,
        cwd,
        worktreeId,
        prompt,
        interactive,
        model,
        presetId,
        activateDockOnCreate,
        env,
      } = args as {
        agentId: string;
        location?: "grid" | "dock";
        cwd?: string;
        worktreeId?: string;
        prompt?: string;
        interactive?: boolean;
        model?: string;
        presetId?: string | null;
        activateDockOnCreate?: boolean;
        env?: Record<string, string>;
      };
      const terminalId = await callbacks.onLaunchAgent(agentId, {
        location,
        cwd,
        worktreeId,
        prompt,
        interactive,
        modelId: model,
        presetId,
        activateDockOnCreate,
        env,
      });
      return { terminalId };
    },
  }));

  actions.set("agent.palette", () => ({
    id: "agent.palette",
    title: "Open Quick Switcher",
    description: "Open the quick switcher to find panels",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenQuickSwitcher();
    },
  }));

  for (const [id, config] of Object.entries(AGENT_REGISTRY)) {
    const actionId = `agent.${id}` as ActionId;
    actions.set(actionId, () => ({
      id: actionId,
      title: `Launch ${config.name}`,
      description: `Launch ${config.name} agent`,
      category: "agent",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      run: async () => {
        const terminalId = await callbacks.onLaunchAgent(id);
        return { terminalId };
      },
    }));
  }

  actions.set("agent.terminal", () => ({
    id: "agent.terminal",
    title: "Launch Terminal",
    description: "Launch a plain terminal",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const terminalId = await callbacks.onLaunchAgent("terminal");
      return { terminalId };
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
      const state = usePanelStore.getState();
      const worktreeData = getCurrentViewStore().getState();
      const validWorktreeIds = new Set<string>();
      for (const [id, wt] of worktreeData.worktrees) {
        validWorktreeIds.add(id);
        if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
      }
      state.focusNextWaiting(state.isInTrash, validWorktreeIds);
    },
  }));

  actions.set("agent.focusNextWorking", () => ({
    id: "agent.focusNextWorking",
    title: "Focus Next Working Agent",
    description: "Focus the next agent in working state",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = usePanelStore.getState();
      const worktreeData = getCurrentViewStore().getState();
      const validWorktreeIds = new Set<string>();
      for (const [id, wt] of worktreeData.worktrees) {
        validWorktreeIds.add(id);
        if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
      }
      state.focusNextWorking(state.isInTrash, validWorktreeIds);
    },
  }));

  actions.set("agent.focusNextAgent", () => ({
    id: "agent.focusNextAgent",
    title: "Focus Next Agent",
    description: "Cycle through all agent panels",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = usePanelStore.getState();
      const worktreeData = getCurrentViewStore().getState();
      const validWorktreeIds = new Set<string>();
      for (const [id, wt] of worktreeData.worktrees) {
        validWorktreeIds.add(id);
        if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
      }
      state.focusNextAgent(state.isInTrash, validWorktreeIds);
    },
  }));

  actions.set("dock.focusNextWaiting", () => ({
    id: "dock.focusNextWaiting",
    title: "Focus Next Blocked Dock Agent",
    description: "Jump to the next waiting agent in the dock",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = usePanelStore.getState();
      const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      state.focusNextBlockedDock(activeWorktreeId ?? undefined, state.getPanelGroup);
    },
  }));

  actions.set("agent.focusPreviousAgent", () => ({
    id: "agent.focusPreviousAgent",
    title: "Focus Previous Agent",
    description: "Cycle backwards through all agent panels",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = usePanelStore.getState();
      const worktreeData = getCurrentViewStore().getState();
      const validWorktreeIds = new Set<string>();
      for (const [id, wt] of worktreeData.worktrees) {
        validWorktreeIds.add(id);
        if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
      }
      state.focusPreviousAgent(state.isInTrash, validWorktreeIds);
    },
  }));
}
