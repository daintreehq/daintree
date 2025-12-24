import { z } from "zod";
import type { ActionDefinition, ActionContext, ActionId } from "@shared/types/actions";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useSidecarStore } from "@/store/sidecarStore";
import { terminalClient } from "@/clients";

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

const TerminalTypeSchema = z.enum(["terminal", "claude", "gemini", "codex"]);

export type ActionRegistry = Map<ActionId, () => ActionDefinition<unknown, unknown>>;

export type NavigationDirection = "up" | "down" | "left" | "right";

export interface ActionCallbacks {
  onOpenSettings: () => void;
  onOpenSettingsTab: (tab: string) => void;
  onToggleSidebar: () => void;
  onToggleFocusMode: () => void;
  onOpenAgentPalette: () => void;
  onOpenWorktreePalette: () => void;
  onOpenNewTerminalPalette: () => void;
  onOpenShortcuts: () => void;
  onLaunchAgent: (
    agentId: string,
    options?: { cwd?: string; worktreeId?: string }
  ) => Promise<void>;
  onInject: (worktreeId: string) => void;
  onOpenTerminalInfo: (terminalId: string) => void;
  onRenameTerminal: (terminalId: string) => void;
  getDefaultCwd: () => string;
  getActiveWorktreeId: () => string | undefined;
  getWorktrees: () => Array<{ id: string; path: string }>;
  getFocusedId: () => string | null;
  getGridNavigation: () => {
    findNearest: (currentId: string, direction: NavigationDirection) => string | null;
    findByIndex: (index: number) => string | null;
    findDockByIndex: (currentId: string, direction: "left" | "right") => string | null;
    getCurrentLocation: () => "grid" | "dock" | null;
  };
}

export function createActionDefinitions(callbacks: ActionCallbacks): ActionRegistry {
  const actions = new Map<ActionId, () => ActionDefinition<unknown, unknown>>();

  // ============================================
  // TERMINAL ACTIONS
  // ============================================

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

  actions.set("terminal.close", () => ({
    id: "terminal.close",
    title: "Close Terminal",
    description: "Close the focused terminal (move to trash)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = useTerminalStore.getState();
      const targetId = state.focusedId ?? state.terminals.find((t) => t.location !== "trash")?.id;
      if (targetId) {
        state.trashTerminal(targetId);
      }
    },
  }));

  actions.set("terminal.trash", () => ({
    id: "terminal.trash",
    title: "Trash Terminal",
    description: "Move terminal to trash",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.trashTerminal(targetId);
      }
    },
  }));

  actions.set("terminal.kill", () => ({
    id: "terminal.kill",
    title: "Kill Terminal",
    description: "Permanently kill and remove terminal",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.removeTerminal(targetId);
      }
    },
  }));

  actions.set("terminal.restart", () => ({
    id: "terminal.restart",
    title: "Restart Terminal",
    description: "Restart the terminal process",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.restartTerminal(targetId);
      }
    },
  }));

  actions.set("terminal.duplicate", () => ({
    id: "terminal.duplicate",
    title: "Duplicate Terminal",
    description: "Create a duplicate of the terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        const terminal = state.terminals.find((t) => t.id === targetId);
        if (terminal) {
          await state.addTerminal({
            type: terminal.type,
            cwd: terminal.cwd,
            location: terminal.location,
            worktreeId: terminal.worktreeId,
          });
        }
      }
    },
  }));

  actions.set("terminal.reopenLast", () => ({
    id: "terminal.reopenLast",
    title: "Reopen Last Closed",
    description: "Restore the most recently trashed terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useTerminalStore.getState().restoreLastTrashed();
    },
  }));

  actions.set("terminal.rename", () => ({
    id: "terminal.rename",
    title: "Rename Terminal",
    description: "Rename the terminal tab",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
      if (targetId) {
        callbacks.onRenameTerminal(targetId);
      }
    },
  }));

  actions.set("terminal.viewInfo", () => ({
    id: "terminal.viewInfo",
    title: "View Terminal Info",
    description: "View detailed terminal information",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
      if (targetId) {
        callbacks.onOpenTerminalInfo(targetId);
      }
    },
  }));

  // Terminal positioning
  actions.set("terminal.moveToDock", () => ({
    id: "terminal.moveToDock",
    title: "Move to Dock",
    description: "Move terminal to the dock",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.moveTerminalToDock(targetId);
      }
    },
  }));

  actions.set("terminal.moveToGrid", () => ({
    id: "terminal.moveToGrid",
    title: "Move to Grid",
    description: "Move terminal to the grid",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.moveTerminalToGrid(targetId);
      }
    },
  }));

  actions.set("terminal.minimize", () => ({
    id: "terminal.minimize",
    title: "Minimize Terminal",
    description: "Minimize terminal to dock",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = useTerminalStore.getState();
      if (state.focusedId) {
        state.moveTerminalToDock(state.focusedId);
      }
    },
  }));

  actions.set("terminal.restore", () => ({
    id: "terminal.restore",
    title: "Restore Terminal",
    description: "Restore terminal from dock to grid",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = useTerminalStore.getState();
      const dockTerminals = state.terminals.filter((t) => t.location === "dock");
      if (dockTerminals.length > 0) {
        state.moveTerminalToGrid(dockTerminals[0].id);
      }
    },
  }));

  actions.set("terminal.toggleMaximize", () => ({
    id: "terminal.toggleMaximize",
    title: "Toggle Maximize",
    description: "Toggle terminal maximize state",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.toggleMaximize(targetId);
      }
    },
  }));

  actions.set("terminal.maximize", () => ({
    id: "terminal.maximize",
    title: "Maximize Terminal",
    description: "Toggle terminal maximize state",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = useTerminalStore.getState();
      if (state.focusedId) {
        state.toggleMaximize(state.focusedId);
      }
    },
  }));

  actions.set("terminal.toggleInputLock", () => ({
    id: "terminal.toggleInputLock",
    title: "Toggle Input Lock",
    description: "Toggle terminal input lock",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.toggleInputLocked(targetId);
      }
    },
  }));

  actions.set("terminal.forceResume", () => ({
    id: "terminal.forceResume",
    title: "Force Resume",
    description: "Force resume an agent terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
      if (targetId) {
        await terminalClient.forceResume(targetId);
      }
    },
  }));

  actions.set("terminal.moveToWorktree", () => ({
    id: "terminal.moveToWorktree",
    title: "Move to Worktree",
    description: "Move terminal to a different worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z.string().optional(),
      worktreeId: z.string(),
    }),
    run: async (args: unknown) => {
      const { terminalId, worktreeId } = args as { terminalId?: string; worktreeId: string };
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.moveTerminalToWorktree(targetId, worktreeId);
      }
    },
  }));

  actions.set("terminal.convertType", () => ({
    id: "terminal.convertType",
    title: "Convert Terminal Type",
    description: "Convert terminal to a different type",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z.string().optional(),
      type: TerminalTypeSchema,
    }),
    run: async (args: unknown) => {
      const { terminalId, type } = args as { terminalId?: string; type: string };
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.convertTerminalType(targetId, type as "terminal" | "claude" | "gemini" | "codex");
      }
    },
  }));

  // Terminal reordering
  actions.set("terminal.moveLeft", () => ({
    id: "terminal.moveLeft",
    title: "Move Terminal Left",
    description: "Move terminal left in the grid",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = useTerminalStore.getState();
      const { focusedId, terminals, reorderTerminals } = state;
      if (!focusedId) return;
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const gridTerminals = terminals.filter(
        (t) =>
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      );
      const currentIndex = gridTerminals.findIndex((t) => t.id === focusedId);
      if (currentIndex > 0) {
        reorderTerminals(currentIndex, currentIndex - 1, "grid", activeWorktreeId);
      }
    },
  }));

  actions.set("terminal.moveRight", () => ({
    id: "terminal.moveRight",
    title: "Move Terminal Right",
    description: "Move terminal right in the grid",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = useTerminalStore.getState();
      const { focusedId, terminals, reorderTerminals } = state;
      if (!focusedId) return;
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const gridTerminals = terminals.filter(
        (t) =>
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      );
      const currentIndex = gridTerminals.findIndex((t) => t.id === focusedId);
      if (currentIndex >= 0 && currentIndex < gridTerminals.length - 1) {
        reorderTerminals(currentIndex, currentIndex + 1, "grid", activeWorktreeId);
      }
    },
  }));

  // Terminal focus
  actions.set("terminal.focusNext", () => ({
    id: "terminal.focusNext",
    title: "Focus Next Terminal",
    description: "Focus the next terminal in the grid",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useTerminalStore.getState().focusNext();
    },
  }));

  actions.set("terminal.focusPrevious", () => ({
    id: "terminal.focusPrevious",
    title: "Focus Previous Terminal",
    description: "Focus the previous terminal in the grid",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useTerminalStore.getState().focusPrevious();
    },
  }));

  actions.set("terminal.focusUp", () => ({
    id: "terminal.focusUp",
    title: "Focus Terminal Up",
    description: "Focus terminal above",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const nav = callbacks.getGridNavigation();
      if (nav.getCurrentLocation() === "grid") {
        useTerminalStore.getState().focusDirection("up", nav.findNearest);
      }
    },
  }));

  actions.set("terminal.focusDown", () => ({
    id: "terminal.focusDown",
    title: "Focus Terminal Down",
    description: "Focus terminal below",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const nav = callbacks.getGridNavigation();
      if (nav.getCurrentLocation() === "grid") {
        useTerminalStore.getState().focusDirection("down", nav.findNearest);
      }
    },
  }));

  actions.set("terminal.focusLeft", () => ({
    id: "terminal.focusLeft",
    title: "Focus Terminal Left",
    description: "Focus terminal to the left",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const nav = callbacks.getGridNavigation();
      const location = nav.getCurrentLocation();
      if (location === "grid") {
        useTerminalStore.getState().focusDirection("left", nav.findNearest);
      } else if (location === "dock") {
        useTerminalStore.getState().focusDockDirection("left", nav.findDockByIndex);
      }
    },
  }));

  actions.set("terminal.focusRight", () => ({
    id: "terminal.focusRight",
    title: "Focus Terminal Right",
    description: "Focus terminal to the right",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const nav = callbacks.getGridNavigation();
      const location = nav.getCurrentLocation();
      if (location === "grid") {
        useTerminalStore.getState().focusDirection("right", nav.findNearest);
      } else if (location === "dock") {
        useTerminalStore.getState().focusDockDirection("right", nav.findDockByIndex);
      }
    },
  }));

  // Panel focus by index (parameterized)
  actions.set("panel.focusIndex", () => ({
    id: "panel.focusIndex",
    title: "Focus Panel by Index",
    description: "Focus the panel at a specific position (1-9)",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ index: z.number().int().min(1).max(9) }),
    run: async (args: unknown) => {
      const { index } = args as { index: number };
      const nav = callbacks.getGridNavigation();
      useTerminalStore.getState().focusByIndex(index, nav.findByIndex);
    },
  }));

  // Bulk terminal operations
  actions.set("terminal.closeAll", () => ({
    id: "terminal.closeAll",
    title: "Close All Terminals",
    description: "Close all terminals in the active worktree",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    run: async () => {
      useTerminalStore.getState().bulkTrashAll();
    },
  }));

  actions.set("terminal.killAll", () => ({
    id: "terminal.killAll",
    title: "Kill All Terminals",
    description: "Kill all terminals",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    run: async () => {
      const state = useTerminalStore.getState();
      state.terminals.forEach((t) => {
        if (t.location !== "trash") state.trashTerminal(t.id);
      });
    },
  }));

  actions.set("terminal.restartAll", () => ({
    id: "terminal.restartAll",
    title: "Restart All Terminals",
    description: "Restart all terminals in the active worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useTerminalStore.getState().bulkRestartAll();
    },
  }));

  actions.set("terminal.minimizeAll", () => ({
    id: "terminal.minimizeAll",
    title: "Minimize All Terminals",
    description: "Move all terminals to dock",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useTerminalStore.getState().bulkMoveToDock();
    },
  }));

  actions.set("terminal.restoreAll", () => ({
    id: "terminal.restoreAll",
    title: "Restore All Terminals",
    description: "Move all terminals from dock to grid",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useTerminalStore.getState().bulkMoveToGrid();
    },
  }));

  actions.set("terminal.palette", () => ({
    id: "terminal.palette",
    title: "Open Terminal Palette",
    description: "Open the terminal/agent palette",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenAgentPalette();
    },
  }));

  actions.set("terminal.spawnPalette", () => ({
    id: "terminal.spawnPalette",
    title: "Open New Terminal Palette",
    description: "Open palette to spawn a new terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenNewTerminalPalette();
    },
  }));

  actions.set("terminal.inject", () => ({
    id: "terminal.inject",
    title: "Inject Context",
    description: "Inject worktree context into terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      if (activeWorktreeId) {
        callbacks.onInject(activeWorktreeId);
      }
    },
  }));

  // ============================================
  // AGENT ACTIONS
  // ============================================

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

  // ============================================
  // PANEL ACTIONS
  // ============================================

  actions.set("panel.toggleDock", () => ({
    id: "panel.toggleDock",
    title: "Toggle Terminal Dock",
    description: "Toggle the terminal dock visibility",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("canopy:toggle-terminal-dock"));
    },
  }));

  actions.set("panel.toggleDockAlt", () => ({
    id: "panel.toggleDockAlt",
    title: "Toggle Terminal Dock (Alt)",
    description: "Toggle the terminal dock visibility",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("canopy:toggle-terminal-dock"));
    },
  }));

  actions.set("panel.toggleDiagnostics", () => ({
    id: "panel.toggleDiagnostics",
    title: "Toggle Diagnostics",
    description: "Toggle the diagnostics panel",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useDiagnosticsStore.getState().toggleDock();
    },
  }));

  actions.set("panel.diagnosticsLogs", () => ({
    id: "panel.diagnosticsLogs",
    title: "Show Logs",
    description: "Open diagnostics panel with logs tab",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useDiagnosticsStore.getState().openDock("logs");
    },
  }));

  actions.set("panel.diagnosticsEvents", () => ({
    id: "panel.diagnosticsEvents",
    title: "Show Events",
    description: "Open diagnostics panel with events tab",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useDiagnosticsStore.getState().openDock("events");
    },
  }));

  actions.set("panel.diagnosticsMessages", () => ({
    id: "panel.diagnosticsMessages",
    title: "Show Problems",
    description: "Open diagnostics panel with problems tab",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useDiagnosticsStore.getState().openDock("problems");
    },
  }));

  actions.set("panel.toggleSidecar", () => ({
    id: "panel.toggleSidecar",
    title: "Toggle Sidecar",
    description: "Toggle the sidecar panel",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("canopy:toggle-sidecar"));
    },
  }));

  actions.set("sidecar.toggle", () => ({
    id: "sidecar.toggle",
    title: "Toggle Sidecar",
    description: "Toggle the sidecar panel",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useSidecarStore.getState().toggle();
    },
  }));

  actions.set("sidecar.closeTab", () => ({
    id: "sidecar.closeTab",
    title: "Close Sidecar Tab",
    description: "Close the active sidecar tab",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = useSidecarStore.getState();
      if (state.activeTabId) {
        state.closeTab(state.activeTabId);
      }
    },
  }));

  actions.set("sidecar.nextTab", () => ({
    id: "sidecar.nextTab",
    title: "Next Sidecar Tab",
    description: "Switch to next sidecar tab",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useSidecarStore.getState().cycleNextTab();
    },
  }));

  actions.set("sidecar.prevTab", () => ({
    id: "sidecar.prevTab",
    title: "Previous Sidecar Tab",
    description: "Switch to previous sidecar tab",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useSidecarStore.getState().cyclePrevTab();
    },
  }));

  actions.set("sidecar.newTab", () => ({
    id: "sidecar.newTab",
    title: "New Sidecar Tab",
    description: "Open a new sidecar tab",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useSidecarStore.getState().createBlankTab();
    },
  }));

  // ============================================
  // WORKTREE ACTIONS
  // ============================================

  actions.set("worktree.createDialog.open", () => ({
    id: "worktree.createDialog.open",
    title: "New Worktree",
    description: "Open dialog to create a new worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useWorktreeSelectionStore.getState().openCreateDialog();
    },
  }));

  actions.set("worktree.select", () => ({
    id: "worktree.select",
    title: "Select Worktree",
    description: "Select a worktree by ID",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string() }),
    run: async (args: unknown) => {
      const { worktreeId } = args as { worktreeId: string };
      useWorktreeSelectionStore.getState().selectWorktree(worktreeId);
    },
  }));

  actions.set("worktree.next", () => ({
    id: "worktree.next",
    title: "Next Worktree",
    description: "Switch to the next worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const worktrees = callbacks.getWorktrees();
      if (worktrees.length === 0) return;
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const currentIndex = activeWorktreeId
        ? worktrees.findIndex((w) => w.id === activeWorktreeId)
        : -1;
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % worktrees.length;
      useWorktreeSelectionStore.getState().selectWorktree(worktrees[nextIndex].id);
    },
  }));

  actions.set("worktree.previous", () => ({
    id: "worktree.previous",
    title: "Previous Worktree",
    description: "Switch to the previous worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const worktrees = callbacks.getWorktrees();
      if (worktrees.length === 0) return;
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const currentIndex = activeWorktreeId
        ? worktrees.findIndex((w) => w.id === activeWorktreeId)
        : -1;
      const prevIndex =
        currentIndex === -1 ? 0 : (currentIndex - 1 + worktrees.length) % worktrees.length;
      useWorktreeSelectionStore.getState().selectWorktree(worktrees[prevIndex].id);
    },
  }));

  // Worktree switch by index (parameterized)
  actions.set("worktree.switchIndex", () => ({
    id: "worktree.switchIndex",
    title: "Switch to Worktree by Index",
    description: "Switch to worktree at a specific position (1-9)",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ index: z.number().int().min(1).max(9) }),
    run: async (args: unknown) => {
      const { index } = args as { index: number };
      const worktrees = callbacks.getWorktrees();
      if (worktrees.length >= index) {
        useWorktreeSelectionStore.getState().selectWorktree(worktrees[index - 1].id);
      }
    },
  }));

  actions.set("worktree.openPalette", () => ({
    id: "worktree.openPalette",
    title: "Open Worktree Palette",
    description: "Open the worktree selection palette",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenWorktreePalette();
    },
  }));

  actions.set("worktree.panel", () => ({
    id: "worktree.panel",
    title: "Open Worktree Panel",
    description: "Open the worktree panel",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenWorktreePalette();
    },
  }));

  actions.set("worktree.copyTree", () => ({
    id: "worktree.copyTree",
    title: "Copy Worktree Tree",
    description: "Copy the file tree of the active worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      // This action requires worktree-specific handling from the hook
      // Dispatch a custom event that will be handled by the worktree actions hook
      window.dispatchEvent(new CustomEvent("canopy:copy-worktree-tree"));
    },
  }));

  actions.set("worktree.openEditor", () => ({
    id: "worktree.openEditor",
    title: "Open in Editor",
    description: "Open the active worktree in external editor",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("canopy:open-worktree-editor"));
    },
  }));

  // ============================================
  // NAVIGATION ACTIONS
  // ============================================

  actions.set("nav.toggleSidebar", () => ({
    id: "nav.toggleSidebar",
    title: "Toggle Sidebar",
    description: "Toggle sidebar visibility",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onToggleSidebar();
    },
  }));

  actions.set("nav.toggleFocusMode", () => ({
    id: "nav.toggleFocusMode",
    title: "Toggle Focus Mode",
    description: "Toggle focus mode (hide sidebar)",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onToggleFocusMode();
    },
  }));

  // ============================================
  // APP/SETTINGS ACTIONS
  // ============================================

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

  actions.set("help.shortcuts", () => ({
    id: "help.shortcuts",
    title: "Keyboard Shortcuts",
    description: "Show keyboard shortcuts reference",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenShortcuts();
    },
  }));

  actions.set("help.shortcutsAlt", () => ({
    id: "help.shortcutsAlt",
    title: "Keyboard Shortcuts (Alt)",
    description: "Show keyboard shortcuts reference",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenShortcuts();
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
    run: async () => {
      // This is typically handled by the modal component itself via Escape key
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    },
  }));

  // ============================================
  // BROWSER ACTIONS
  // ============================================

  actions.set("browser.reload", () => ({
    id: "browser.reload",
    title: "Reload Browser",
    description: "Reload the browser panel",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
      if (targetId) {
        window.dispatchEvent(
          new CustomEvent("canopy:reload-browser", { detail: { terminalId: targetId } })
        );
      }
    },
  }));

  actions.set("browser.openExternal", () => ({
    id: "browser.openExternal",
    title: "Open in External Browser",
    description: "Open the current URL in external browser",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ url: z.string() }),
    run: async (args: unknown) => {
      const { url } = args as { url: string };
      if (url && window.electron?.system?.openExternal) {
        await window.electron.system.openExternal(url);
      }
    },
  }));

  actions.set("browser.copyUrl", () => ({
    id: "browser.copyUrl",
    title: "Copy URL",
    description: "Copy the current browser URL to clipboard",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ url: z.string() }),
    run: async (args: unknown) => {
      const { url } = args as { url: string };
      if (url) {
        await navigator.clipboard.writeText(url);
      }
    },
  }));

  // ============================================
  // INTROSPECTION ACTIONS
  // ============================================

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
