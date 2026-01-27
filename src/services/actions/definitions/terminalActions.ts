import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { TerminalTypeSchema } from "./schemas";
import { z } from "zod";
import type { ActionId, ActionContext } from "@shared/types/actions";
import { appClient, terminalClient } from "@/clients";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { useDockStore } from "@/store/dockStore";

export function registerTerminalActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  const revealDockIfHidden = () => {
    const dockState = useDockStore.getState();
    if (dockState.behavior === "manual" && dockState.mode !== "expanded") {
      dockState.setMode("expanded");
    }
  };

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

  actions.set("terminal.redraw", () => ({
    id: "terminal.redraw",
    title: "Redraw Terminal",
    description: "Redraw terminal display to fix visual corruption",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        const { terminalInstanceService } =
          await import("@/services/terminal/TerminalInstanceService");
        terminalInstanceService.resetRenderer(targetId);
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
        if (!terminal) return;

        const location = terminal.location === "trash" ? "grid" : (terminal.location ?? "grid");

        await state.addTerminal({
          kind: terminal.kind,
          type: terminal.type,
          agentId: terminal.agentId,
          cwd: terminal.cwd,
          location,
          title: terminal.title ? `${terminal.title} (copy)` : undefined,
          worktreeId: terminal.worktreeId,
          command: terminal.command,
          isInputLocked: terminal.isInputLocked,
          browserUrl: terminal.browserUrl,
        });
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
        window.dispatchEvent(
          new CustomEvent("canopy:rename-terminal", { detail: { id: targetId } })
        );
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
        window.dispatchEvent(
          new CustomEvent("canopy:open-terminal-info", { detail: { id: targetId } })
        );
      }
    },
  }));

  actions.set("terminal.info.open", () => ({
    id: "terminal.info.open",
    title: "Open Terminal Info",
    description: "Open terminal info dialog",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
      if (targetId) {
        window.dispatchEvent(
          new CustomEvent("canopy:open-terminal-info", { detail: { id: targetId } })
        );
      }
    },
  }));

  actions.set("terminal.info.get", () => ({
    id: "terminal.info.get",
    title: "Get Terminal Info",
    description: "Get detailed terminal information for a terminal",
    category: "terminal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
      if (!targetId) {
        throw new Error("No terminal selected");
      }
      return await window.electron.terminal.getInfo(targetId);
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
        // Check if moving a group that contains the maximized panel
        const group = state.getPanelGroup(targetId);
        if (group && state.maximizedId && group.panelIds.includes(state.maximizedId)) {
          // Clear maximize state before moving to dock
          state.setMaximizedId(null);
        }
        state.moveTerminalToDock(targetId);
        // Reveal dock if hidden so the terminal is visible
        revealDockIfHidden();
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
        revealDockIfHidden();
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
        state.setFocused(null);
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
        state.convertTerminalType(
          targetId,
          type as "terminal" | "claude" | "gemini" | "codex" | "opencode"
        );
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

  // Non-parameterized focus actions (for KeyAction/keybinding compatibility)
  for (let index = 1; index <= 9; index++) {
    const actionId = `terminal.focusIndex${index}` as ActionId;
    actions.set(actionId, () => ({
      id: actionId,
      title: `Focus Terminal ${index}`,
      description: `Focus terminal at position ${index}`,
      category: "terminal",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      run: async () => {
        const nav = callbacks.getGridNavigation();
        useTerminalStore.getState().focusByIndex(index, nav.findByIndex);
      },
    }));
  }

  // Bulk terminal operations
  actions.set("terminal.closeAll", () => ({
    id: "terminal.closeAll",
    title: "Close All Terminals",
    description: "Move all terminals in the active worktree to trash",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    run: async () => {
      const state = useTerminalStore.getState();
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const terminalsToClose = state.terminals.filter(
        (t) =>
          t.location !== "trash" && (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      );
      terminalsToClose.forEach((t) => state.trashTerminal(t.id));
    },
  }));

  actions.set("terminal.killAll", () => ({
    id: "terminal.killAll",
    title: "Kill All Terminals",
    description: "Permanently remove all terminals (cannot be undone)",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    run: async () => {
      useTerminalStore.getState().bulkCloseAll();
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
      revealDockIfHidden();
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

  actions.set("terminal.gridLayout.setStrategy", () => ({
    id: "terminal.gridLayout.setStrategy",
    title: "Set Grid Layout Strategy",
    description: "Set the panel grid layout strategy",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      strategy: z.enum(["automatic", "fixed-columns", "fixed-rows"]),
    }),
    run: async (args: unknown) => {
      const { strategy } = args as {
        strategy: "automatic" | "fixed-columns" | "fixed-rows";
      };
      const state = useLayoutConfigStore.getState();
      const previous = state.layoutConfig;
      const next = { ...previous, strategy };
      state.setLayoutConfig(next);
      try {
        await appClient.setState({ panelGridConfig: next as any });
      } catch (error) {
        state.setLayoutConfig(previous);
        throw error;
      }
    },
  }));

  actions.set("terminal.gridLayout.setValue", () => ({
    id: "terminal.gridLayout.setValue",
    title: "Set Grid Layout Value",
    description: "Set the panel grid layout value (columns/rows count)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ value: z.number().int().min(1).max(10) }),
    run: async (args: unknown) => {
      const { value } = args as { value: number };
      const state = useLayoutConfigStore.getState();
      const previous = state.layoutConfig;
      const next = { ...previous, value };
      state.setLayoutConfig(next);
      try {
        await appClient.setState({ panelGridConfig: next as any });
      } catch (error) {
        state.setLayoutConfig(previous);
        throw error;
      }
    },
  }));

  // Helper to get terminal and its worktree for the open worktree actions
  const getTerminalWorktree = (ctx: ActionContext) => {
    const { focusedTerminalId } = ctx;
    if (!focusedTerminalId) return null;

    const terminal = useTerminalStore.getState().terminals.find((t) => t.id === focusedTerminalId);
    if (!terminal?.worktreeId) return null;

    const worktree = useWorktreeDataStore.getState().worktrees.get(terminal.worktreeId);
    if (!worktree) return null;

    return { terminal, worktree };
  };

  actions.set("terminal.openWorktreeEditor", () => ({
    id: "terminal.openWorktreeEditor",
    title: "Open Focused Terminal's Worktree Folder",
    description: "Open the folder for the focused terminal's worktree in your editor",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    isEnabled: (ctx: ActionContext) => {
      return getTerminalWorktree(ctx) !== null;
    },
    disabledReason: (ctx: ActionContext) => {
      if (!ctx.focusedTerminalId) return "No focused terminal";
      const terminal = useTerminalStore
        .getState()
        .terminals.find((t) => t.id === ctx.focusedTerminalId);
      if (!terminal) return "Focused terminal no longer exists";
      if (!terminal.worktreeId) return "Terminal has no associated worktree";
      const worktree = useWorktreeDataStore.getState().worktrees.get(terminal.worktreeId);
      if (!worktree) return "Worktree no longer exists";
      return undefined;
    },
    run: async (_args: unknown, ctx: ActionContext) => {
      const data = getTerminalWorktree(ctx);
      if (!data) return;

      const { actionService } = await import("@/services/ActionService");
      const result = await actionService.dispatch(
        "worktree.openEditor",
        { worktreeId: data.worktree.id },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    },
  }));

  actions.set("terminal.openWorktreeIssue", () => ({
    id: "terminal.openWorktreeIssue",
    title: "Open Focused Terminal's Worktree Issue",
    description: "Open the GitHub issue for the focused terminal's worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    isEnabled: (ctx: ActionContext) => {
      const data = getTerminalWorktree(ctx);
      return data !== null && !!data.worktree.issueNumber;
    },
    disabledReason: (ctx: ActionContext) => {
      if (!ctx.focusedTerminalId) return "No focused terminal";
      const terminal = useTerminalStore
        .getState()
        .terminals.find((t) => t.id === ctx.focusedTerminalId);
      if (!terminal) return "Focused terminal no longer exists";
      if (!terminal.worktreeId) return "Terminal has no associated worktree";
      const worktree = useWorktreeDataStore.getState().worktrees.get(terminal.worktreeId);
      if (!worktree) return "Worktree no longer exists";
      if (!worktree.issueNumber) return "Worktree has no associated issue";
      return undefined;
    },
    run: async (_args: unknown, ctx: ActionContext) => {
      const data = getTerminalWorktree(ctx);
      if (!data || !data.worktree.issueNumber) return;

      const { actionService } = await import("@/services/ActionService");
      const result = await actionService.dispatch(
        "worktree.openIssue",
        { worktreeId: data.worktree.id },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    },
  }));

  actions.set("terminal.openWorktreePR", () => ({
    id: "terminal.openWorktreePR",
    title: "Open Focused Terminal's Worktree Pull Request",
    description: "Open the GitHub pull request for the focused terminal's worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    isEnabled: (ctx: ActionContext) => {
      const data = getTerminalWorktree(ctx);
      return data !== null && !!data.worktree.prUrl;
    },
    disabledReason: (ctx: ActionContext) => {
      if (!ctx.focusedTerminalId) return "No focused terminal";
      const terminal = useTerminalStore
        .getState()
        .terminals.find((t) => t.id === ctx.focusedTerminalId);
      if (!terminal) return "Focused terminal no longer exists";
      if (!terminal.worktreeId) return "Terminal has no associated worktree";
      const worktree = useWorktreeDataStore.getState().worktrees.get(terminal.worktreeId);
      if (!worktree) return "Worktree no longer exists";
      if (!worktree.prUrl) return "Worktree has no associated pull request";
      return undefined;
    },
    run: async (_args: unknown, ctx: ActionContext) => {
      const data = getTerminalWorktree(ctx);
      if (!data || !data.worktree.prUrl) return;

      const { actionService } = await import("@/services/ActionService");
      const result = await actionService.dispatch(
        "worktree.openPR",
        { worktreeId: data.worktree.id },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    },
  }));

  // Tab navigation within tabbed panels
  const navigateTab = (direction: "next" | "previous") => {
    const state = useTerminalStore.getState();
    const focusedId = state.focusedId;
    if (!focusedId) return;

    // Get the group that contains the focused panel
    const group = state.getPanelGroup(focusedId);
    if (!group) return;

    // Get valid, non-trashed panels in the group using the store method
    const validPanels = state.getTabGroupPanels(group.id);
    if (validPanels.length < 2) return;

    // Find current position among valid panels
    const currentIndex = validPanels.findIndex((p) => p.id === focusedId);
    if (currentIndex === -1) return;

    // Calculate next index with wrap-around
    let nextIndex: number;
    if (direction === "next") {
      nextIndex = currentIndex < validPanels.length - 1 ? currentIndex + 1 : 0;
    } else {
      nextIndex = currentIndex > 0 ? currentIndex - 1 : validPanels.length - 1;
    }

    const nextPanel = validPanels[nextIndex];
    if (!nextPanel) return;

    // Update active tab in the group
    state.setActiveTab(group.id, nextPanel.id);

    // Handle dock vs grid differently
    if (nextPanel.location === "dock") {
      state.openDockTerminal(nextPanel.id);
    } else {
      state.setFocused(nextPanel.id);
    }
  };

  actions.set("tab.next", () => ({
    id: "tab.next",
    title: "Next Tab",
    description: "Switch to the next tab in the focused panel group",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      navigateTab("next");
    },
  }));

  actions.set("tab.previous", () => ({
    id: "tab.previous",
    title: "Previous Tab",
    description: "Switch to the previous tab in the focused panel group",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      navigateTab("previous");
    },
  }));
}
