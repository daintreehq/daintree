import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { AgentIdSchema, LaunchLocationSchema, TerminalSpawnSourceSchema } from "./schemas";
import { z } from "zod";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { AGENT_REGISTRY } from "@/config/agents";
import type { ActionId } from "@shared/types/actions";
import type { TerminalSpawnSource } from "@shared/types/panel";
export function registerAgentActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  actions.set("agent.launch", () => ({
    id: "agent.launch",
    title: "Launch Agent",
    description:
      "Launch an AI agent in a new terminal. Returns terminalId and location. Fire up to 4 in parallel per message.",
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
      ephemeral: z.boolean().optional(),
      agentLaunchFlags: z.array(z.string()).optional(),
      spawnedBy: TerminalSpawnSourceSchema.optional(),
      requestedId: z.string().optional(),
      force: z.boolean().optional(),
    }),
    resultSchema: z
      .object({
        terminalId: z.string(),
        location: LaunchLocationSchema,
      })
      .nullable(),
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
        ephemeral,
        agentLaunchFlags,
        spawnedBy,
        requestedId,
        force,
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
        ephemeral?: boolean;
        agentLaunchFlags?: string[];
        spawnedBy?: TerminalSpawnSource;
        requestedId?: string;
        force?: boolean;
      };
      const result = await callbacks.onLaunchAgent(agentId, {
        location,
        cwd,
        worktreeId,
        prompt,
        interactive,
        modelId: model,
        presetId,
        activateDockOnCreate,
        env,
        ephemeral,
        agentLaunchFlags,
        spawnedBy,
        requestedId,
        force,
      });
      if (!result) return null;
      return { terminalId: result.terminalId, location: result.location };
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

  // Per-agent shortcut actions (`agent.claude`, `agent.codex`, …) accept
  // optional `location` and `spawnedBy` args so MCP-initiated launches can set
  // placement and be marked non-focus-stealing. See #6959, #7669.
  const shortcutLaunchSchema = z
    .object({
      location: LaunchLocationSchema.optional(),
      spawnedBy: TerminalSpawnSourceSchema.optional(),
    })
    .optional();

  const shortcutResultSchema = z
    .object({
      terminalId: z.string(),
      location: LaunchLocationSchema,
    })
    .nullable();

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
      argsSchema: shortcutLaunchSchema,
      resultSchema: shortcutResultSchema,
      run: async (args: unknown) => {
        const { location, spawnedBy } = (args ?? {}) as {
          location?: "grid" | "dock";
          spawnedBy?: TerminalSpawnSource;
        };
        const result = await callbacks.onLaunchAgent(id, {
          location,
          spawnedBy,
        });
        if (!result) return null;
        return { terminalId: result.terminalId, location: result.location };
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
    argsSchema: shortcutLaunchSchema,
    resultSchema: shortcutResultSchema,
    run: async (args: unknown) => {
      const { location, spawnedBy } = (args ?? {}) as {
        location?: "grid" | "dock";
        spawnedBy?: TerminalSpawnSource;
      };
      const result = await callbacks.onLaunchAgent("terminal", {
        location,
        spawnedBy,
      });
      if (!result) return null;
      return { terminalId: result.terminalId, location: result.location };
    },
  }));

  actions.set("agent.browser", () => ({
    id: "agent.browser",
    title: "Launch Browser",
    description: "Launch a browser panel",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: shortcutLaunchSchema,
    resultSchema: shortcutResultSchema,
    run: async (args: unknown) => {
      const { location, spawnedBy } = (args ?? {}) as {
        location?: "grid" | "dock";
        spawnedBy?: TerminalSpawnSource;
      };
      const result = await callbacks.onLaunchAgent("browser", {
        location,
        spawnedBy,
      });
      if (!result) return null;
      return { terminalId: result.terminalId, location: result.location };
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

  actions.set("agent.focusNextWaitingGlobal", () => ({
    id: "agent.focusNextWaitingGlobal",
    title: "Focus Next Waiting Agent (All Projects)",
    description:
      "Jump to the next project with a waiting agent. Cycles across all projects in sidebar order, wrapping around.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const projectState = useProjectStore.getState();
      const stats = useProjectStatsStore.getState().stats;
      const projects = projectState.projects;
      if (projects.length === 0) return;

      const currentProjectId = projectState.currentProject?.id ?? null;
      const currentIdx = currentProjectId
        ? projects.findIndex((p) => p.id === currentProjectId)
        : -1;

      // Start the search at the position AFTER the current project so the
      // first comparison hits the next candidate, not currentProject itself.
      // When currentProject isn't in the list (stale state, recently removed),
      // start from the head. Wrap around the full list so a single waiting
      // agent in currentProject still resolves (to a local focus dispatch).
      const startIdx = currentIdx >= 0 ? currentIdx + 1 : 0;
      let target: { id: string } | null = null;
      for (let i = 0; i < projects.length; i++) {
        const idx = (startIdx + i) % projects.length;
        const candidate = projects[idx];
        if (!candidate) continue;
        const waiting = stats[candidate.id]?.waitingAgentCount ?? 0;
        if (waiting > 0) {
          target = candidate;
          break;
        }
      }

      if (!target) return;

      if (target.id === currentProjectId) {
        // Same-project: just cycle within the active view.
        const panelState = usePanelStore.getState();
        const worktreeData = getCurrentViewStore().getState();
        const validWorktreeIds = new Set<string>();
        for (const [id, wt] of worktreeData.worktrees) {
          validWorktreeIds.add(id);
          if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
        }
        panelState.focusNextWaiting(panelState.isInTrash, validWorktreeIds);
        return;
      }

      // Cross-project: switch with a one-shot focus intent. The main process
      // delivers `project:focus-on-activate` to the incoming view once the
      // paint gate resolves (cold start) or immediately on cache hit, and
      // the renderer subscriber dispatches local `agent.focusNextWaiting`.
      await projectState.switchProject(target.id, { focusIntent: "focus-next-waiting" });
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

  actions.set("agent.getState", () => ({
    id: "agent.getState",
    title: "Get Agent State",
    description:
      "Query agent state; returns state, waitingReason ('prompt'|'question', non-null when waiting), terminalId, found.",
    category: "agent",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      agentId: z
        .string()
        .min(1)
        .describe("Agent ID to look up (e.g., 'claude', 'codex'). From terminal.list[].agentId."),
    }),
    resultSchema: z.object({
      agentId: z.string(),
      state: z.string().nullable(),
      waitingReason: z.string().nullable(),
      lastTransitionAt: z.number().nullable(),
      terminalId: z.string().nullable(),
      found: z.boolean(),
    }),
    run: async (args: unknown) => {
      const { agentId } = args as { agentId: string };
      const state = usePanelStore.getState();
      for (const id of state.panelIds) {
        const panel = state.panelsById[id];
        // Skip ephemeral panels (e.g. the Daintree Assistant's own dock
        // terminal) for the same reason terminal.list filters them — the
        // assistant must not be able to introspect its own process.
        if (!panel || panel.ephemeral === true) continue;
        const effectiveAgentId = panel.detectedAgentId ?? panel.launchAgentId;
        if (effectiveAgentId === agentId) {
          return {
            agentId,
            state: panel.agentState ?? null,
            waitingReason: panel.agentState === "waiting" ? (panel.waitingReason ?? null) : null,
            lastTransitionAt: panel.lastStateChange ?? null,
            terminalId: panel.id,
            found: true,
          };
        }
      }
      return {
        agentId,
        state: null,
        waitingReason: null,
        lastTransitionAt: null,
        terminalId: null,
        found: false,
      };
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
