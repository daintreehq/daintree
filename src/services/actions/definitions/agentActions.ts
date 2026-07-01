import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import {
  AgentIdSchema,
  LaunchLocationSchema,
  TerminalSpawnSourceSchema,
  AddPanelFocusPolicySchema,
  AgentSessionRecordSchema,
} from "./schemas";
import { z } from "zod";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { AGENT_REGISTRY, getAgentDisplayTitle } from "@/config/agents";
import { agentSettingsClient, cliAvailabilityClient } from "@/clients";
import { isAssistantOnlyAgentId, LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
import { isAgentToolbarVisible } from "@shared/utils/agentPinned";
import { isAgentInstalled } from "@shared/utils/agentAvailability";
import type { ActionId } from "@shared/types/actions";
import { isPtyPanel, type TerminalSpawnSource } from "@shared/types/panel";
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
      excludeFromPersistence: z.boolean().optional(),
      removeOnExit: z.boolean().optional(),
      agentLaunchFlags: z.array(z.string()).optional(),
      spawnedBy: TerminalSpawnSourceSchema.optional(),
      focusPolicy: AddPanelFocusPolicySchema.optional(),
      requestedId: z.string().optional(),
      force: z.boolean().optional(),
      name: z
        .string()
        .max(200)
        .optional()
        .describe(
          'Always provide a short, task-descriptive name for the terminal tab (e.g. "Claude: auth refactor") so the user can tell parallel agents apart. Pins the title so agent detection cannot overwrite it. Empty/whitespace falls back to the default title.'
        ),
    }),
    resultSchema: z
      .object({
        terminalId: z.string(),
        location: LaunchLocationSchema,
      })
      .nullable(),
    mcpOutputSchema: true,
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
        excludeFromPersistence,
        removeOnExit,
        agentLaunchFlags,
        spawnedBy,
        focusPolicy,
        requestedId,
        force,
        name,
      } = args as {
        agentId: string;
        location?: "grid" | "dock" | "overlay";
        cwd?: string;
        worktreeId?: string;
        prompt?: string;
        interactive?: boolean;
        model?: string;
        presetId?: string | null;
        activateDockOnCreate?: boolean;
        env?: Record<string, string>;
        excludeFromPersistence?: boolean;
        removeOnExit?: boolean;
        agentLaunchFlags?: string[];
        spawnedBy?: TerminalSpawnSource;
        focusPolicy?: "auto" | "preserve" | "take";
        requestedId?: string;
        force?: boolean;
        name?: string;
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
        excludeFromPersistence,
        removeOnExit,
        agentLaunchFlags,
        spawnedBy,
        focusPolicy,
        requestedId,
        force,
        name,
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
      focusPolicy: AddPanelFocusPolicySchema.optional(),
    })
    .optional();

  const shortcutResultSchema = z
    .object({
      terminalId: z.string(),
      location: LaunchLocationSchema,
    })
    .nullable();

  for (const [id, config] of Object.entries(AGENT_REGISTRY)) {
    // Assistant-only agents (e.g. daintree-assistant) have no direct-launch
    // action — they're never spawned as a standalone agent, only used by the
    // Daintree Assistant overlay. Skipping registration keeps them out of the
    // action palette and the MCP action manifest.
    if (isAssistantOnlyAgentId(id)) continue;
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
        const { location, spawnedBy, focusPolicy } = (args ?? {}) as {
          location?: "grid" | "dock" | "overlay";
          spawnedBy?: TerminalSpawnSource;
          focusPolicy?: "auto" | "preserve" | "take";
        };
        const result = await callbacks.onLaunchAgent(id, {
          location,
          spawnedBy,
          focusPolicy,
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
      const { location, spawnedBy, focusPolicy } = (args ?? {}) as {
        location?: "grid" | "dock" | "overlay";
        spawnedBy?: TerminalSpawnSource;
        focusPolicy?: "auto" | "preserve" | "take";
      };
      const result = await callbacks.onLaunchAgent("terminal", {
        location,
        spawnedBy,
        focusPolicy,
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
        location?: "grid" | "dock" | "overlay";
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
      "Look up the live state of an agent by its agent id. Args: `agentId` (required) — agent id such as 'claude' or 'codex', as seen in `terminal.list` entries' `agentId` field. Returns { agentId, state, waitingReason ('prompt'|'question', non-null only when state is 'waiting'), lastTransitionAt, exitCode (number|null — set once the PTY has exited, null while running or on a signal kill; read alongside `state` to tell pass from fail), spawnedAt, terminalId, found }. Never errors — an unknown agent returns found:false with null fields. Do NOT use this to enumerate terminals — use `terminal.list` or `terminal.getStatus`.",
    category: "agent",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      agentId: z
        .string()
        .min(1)
        .describe(
          "Agent id to look up (e.g. 'claude', 'codex') — from `terminal.list` entries' `agentId` field."
        ),
    }),
    examples: [
      {
        args: { agentId: "claude" },
        description: "Check whether the Claude agent is working, waiting, or idle",
      },
    ],
    resultSchema: z.object({
      agentId: z.string(),
      state: z.string().nullable(),
      waitingReason: z.string().nullable(),
      lastTransitionAt: z.number().nullable(),
      // Process exit code once the agent's PTY has exited; null while running or
      // when signal-terminated with no numeric code. Disambiguate via `state`.
      exitCode: z.number().int().nullable(),
      // Wall-clock spawn timestamp (ms) for duration reasoning; null if unknown.
      spawnedAt: z.number().nullable(),
      terminalId: z.string().nullable(),
      found: z.boolean(),
    }),
    run: async (args: unknown) => {
      const { agentId } = args as { agentId: string };
      const state = usePanelStore.getState();
      for (const id of state.panelIds) {
        const panel = state.panelsById[id];
        // Skip tooling-internal panels (e.g. the Daintree Assistant's own dock
        // terminal) for the same reason terminal.list filters them — the
        // assistant must not be able to introspect its own process.
        if (!panel || !isPtyPanel(panel) || panel.excludeFromPersistence === true) continue;
        const effectiveAgentId = panel.detectedAgentId ?? panel.launchAgentId;
        if (effectiveAgentId === agentId) {
          return {
            agentId,
            state: panel.agentState ?? null,
            waitingReason: panel.agentState === "waiting" ? (panel.waitingReason ?? null) : null,
            lastTransitionAt: panel.lastStateChange ?? null,
            exitCode: panel.exitCode ?? null,
            spawnedAt: panel.startedAt ?? null,
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
        exitCode: null,
        spawnedAt: null,
        terminalId: null,
        found: false,
      };
    },
  }));

  actions.set("agentSessionHistory.list", () => ({
    id: "agentSessionHistory.list",
    title: "List Resumable Sessions",
    description:
      "List resumable agent sessions from the on-disk journal — the closed sessions the user can relaunch. This is a faithful record listing, NOT a summary of what happened in each session. Args: `worktreeId` (optional) — restrict to one worktree; omit to list every resumable session across all worktrees and projects (the default). Returns { sessions: [{ sessionId, agentId, worktreeId, title, projectId, savedAt (epoch ms; the list is newest-first), agentLaunchFlags?, agentModelId?, cwd?, branch? }] }, capped and pruned by the journal's retention policy. Never errors — returns { sessions: [] } when the journal is empty or unreadable. To relaunch a listed session, feed its `agentId`/`cwd`/`worktreeId`/`agentLaunchFlags`/`agentModelId` into `agent.launch`.",
    category: "agent",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        worktreeId: z
          .string()
          .optional()
          .describe(
            "Restrict the listing to one worktree id. Omit to list resumable sessions across all worktrees and projects."
          ),
      })
      .optional(),
    examples: [
      {
        args: {},
        description: "List every resumable agent session across the whole workspace",
      },
    ],
    resultSchema: z.object({
      sessions: z.array(AgentSessionRecordSchema),
    }),
    mcpOutputSchema: true,
    run: async (args: unknown) => {
      const { worktreeId } = (args ?? {}) as { worktreeId?: string };
      const sessions = await window.electron.agentSessionHistory.list(worktreeId);
      return { sessions };
    },
  }));

  actions.set("agent.listToolbar", () => ({
    id: "agent.listToolbar",
    title: "List Toolbar Agents",
    description:
      "List the built-in agents and their resolved toolbar visibility. Returns { agents: [{ id, displayName, pinned, installed, visible }] } for every launchable built-in agent. `pinned` is tri-state: true (explicitly pinned), false (explicitly hidden), or omitted (follows CLI availability). `installed` is whether the agent's CLI binary was detected. `visible` is the resolved toolbar state — true when the agent button currently shows in the toolbar. Use this to discover which agents the user has surfaced without reading the full agent settings.",
    category: "agent",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    mcpVisibility: "discoverable",
    resultSchema: z.object({
      agents: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          pinned: z.boolean().optional(),
          installed: z.boolean(),
          visible: z.boolean(),
        })
      ),
    }),
    run: async () => {
      // Mirror the toolbar's own resolution sources so `visible` stays in
      // lockstep with what actually renders. The toolbar reads the normalized
      // in-memory agent-settings store (initial pins seeded, legacy pins
      // migrated — see agentSettingsStore) rather than the raw persisted
      // settings, and the live CLI-availability store. Fall back to the
      // cache-aware clients only when a store hasn't hydrated yet.
      //
      // Imported lazily so this module's static graph stays free of the store
      // singletons — eager-importing them breaks unrelated action tests that
      // only partially mock the agent-config graph the stores pull in.
      const [{ useAgentSettingsStore }, { useCliAvailabilityStore }] = await Promise.all([
        import("@/store/agentSettingsStore"),
        import("@/store/cliAvailabilityStore"),
      ]);
      const storeSettings = useAgentSettingsStore.getState().settings;
      const settings = storeSettings ?? (await agentSettingsClient.get());
      const availabilityStore = useCliAvailabilityStore.getState();
      const availability = availabilityStore.hasRealData
        ? availabilityStore.availability
        : await cliAvailabilityClient.get();
      return {
        agents: LAUNCHABLE_AGENT_IDS.map((id) => {
          const entry = settings.agents?.[id];
          const state = availability[id];
          // Omit `pinned` unless it's an explicit boolean (tri-state): an
          // absent key means "follows CLI availability", distinct from an
          // explicit true/false pin/unpin. A non-boolean from a corrupted
          // config is treated as absent, never forwarded.
          return {
            id,
            displayName: getAgentDisplayTitle(id),
            ...(typeof entry?.pinned === "boolean" ? { pinned: entry.pinned } : {}),
            installed: isAgentInstalled(state),
            visible: isAgentToolbarVisible(entry, state),
          };
        }),
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
