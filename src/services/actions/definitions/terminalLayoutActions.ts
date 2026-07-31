import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { appClient } from "@/clients";
import { computeGridColumns } from "@/lib/terminalLayout";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";
import { usePanelStore } from "@/store/panelStore";
import { useLayoutUndoStore } from "@/store/layoutUndoStore";
import { panelKindIsDockable } from "@shared/config/panelKindRegistry";
import { requireExplicitTerminalIdForAgentDispatch } from "./terminalTargetBinding";
export function registerTerminalLayoutActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("terminal.moveToDock", () => ({
    id: "terminal.moveToDock",
    title: "Move to Dock",
    description:
      "Move the target terminal from the grid to the dock. Args: `terminalId` — panel UUID from `terminal.list` (the `id` field). REQUIRED for agent/MCP dispatch, which cannot see what is focused. Interactive dispatch may omit it and falls back to the focused terminal.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown, ctx) => {
      const { terminalId } = args as { terminalId?: string };
      requireExplicitTerminalIdForAgentDispatch("terminal.moveToDock", terminalId, ctx);
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        const terminal = state.panelsById[targetId];
        if (!terminal) {
          return;
        }
        // Dock membership is capability-gated (PTY kinds + dockable non-PTY
        // kinds like file panels). Reject the rest so they don't silently
        // disappear into a dock slot that won't render them.
        if (!panelKindIsDockable(terminal.kind ?? "terminal")) {
          return;
        }

        useLayoutUndoStore.getState().pushLayoutSnapshot();

        state.moveTerminalToDock(targetId);

        const moved = usePanelStore.getState().panelsById[targetId];
        if (moved?.location === "dock") {
          state.openDockTerminal(targetId);
        }
      }
    },
  }));

  actions.set("terminal.moveToGrid", () => ({
    id: "terminal.moveToGrid",
    title: "Move to Grid",
    description:
      "Move the target terminal from the dock back into the grid. Args: `terminalId` — panel UUID from `terminal.list` (the `id` field). REQUIRED for agent/MCP dispatch, which cannot see what is focused. Interactive dispatch may omit it and falls back to the focused terminal.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown, ctx) => {
      const { terminalId } = args as { terminalId?: string };
      requireExplicitTerminalIdForAgentDispatch("terminal.moveToGrid", terminalId, ctx);
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        const terminal = state.panelsById[targetId];
        if (!terminal) {
          return;
        }
        useLayoutUndoStore.getState().pushLayoutSnapshot();
        state.moveTerminalToGrid(targetId);
      }
    },
  }));

  actions.set("terminal.toggleMaximize", () => ({
    id: "terminal.toggleMaximize",
    title: "Toggle Maximize",
    description: "Toggle terminal maximize state (maximizes entire tab group if panel is grouped)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown, ctx) => {
      const { terminalId } = args as { terminalId?: string };
      requireExplicitTerminalIdForAgentDispatch("terminal.toggleMaximize", terminalId, ctx);
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        // Pass getPanelGroup to enable group-aware maximize
        state.toggleMaximize(targetId, undefined, undefined, state.getPanelGroup);
      }
    },
  }));

  actions.set("terminal.maximize", () => ({
    id: "terminal.maximize",
    title: "Maximize Terminal",
    description: "Toggle terminal maximize state (maximizes entire tab group if panel is grouped)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = usePanelStore.getState();
      if (state.focusedId) {
        // Pass getPanelGroup to enable group-aware maximize
        state.toggleMaximize(state.focusedId, undefined, undefined, state.getPanelGroup);
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
      const state = usePanelStore.getState();
      const { focusedId, panelIds, panelsById, reorderTerminals } = state;
      if (!focusedId) return;
      useLayoutUndoStore.getState().pushLayoutSnapshot();
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const gridTerminals = panelIds
        .map((id) => panelsById[id])
        .filter(
          (t) =>
            t &&
            (t.location === "grid" || t.location === undefined) &&
            (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
        );
      const currentIndex = gridTerminals.findIndex((t) => t!.id === focusedId);
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
      const state = usePanelStore.getState();
      const { focusedId, panelIds, panelsById, reorderTerminals } = state;
      if (!focusedId) return;
      useLayoutUndoStore.getState().pushLayoutSnapshot();
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const gridTerminals = panelIds
        .map((id) => panelsById[id])
        .filter(
          (t) =>
            t &&
            (t.location === "grid" || t.location === undefined) &&
            (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
        );
      const currentIndex = gridTerminals.findIndex((t) => t!.id === focusedId);
      if (currentIndex >= 0 && currentIndex < gridTerminals.length - 1) {
        reorderTerminals(currentIndex, currentIndex + 1, "grid", activeWorktreeId);
      }
    },
  }));

  actions.set("terminal.moveUp", () => ({
    id: "terminal.moveUp",
    title: "Move Terminal Up",
    description: "Move terminal up in the grid",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = usePanelStore.getState();
      const { focusedId, panelIds, panelsById, reorderTerminals } = state;
      if (!focusedId) return;
      useLayoutUndoStore.getState().pushLayoutSnapshot();
      const terminal = panelsById[focusedId];
      if (!terminal || terminal.location === "dock") return;
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const gridTerminals = panelIds
        .map((id) => panelsById[id])
        .filter(
          (t) =>
            t &&
            (t.location === "grid" || t.location === undefined) &&
            (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
        );
      const currentIndex = gridTerminals.findIndex((t) => t!.id === focusedId);
      if (currentIndex < 0) return;
      const { layoutConfig, gridDimensions } = useLayoutConfigStore.getState();
      const cols = computeGridColumns(
        gridTerminals.length,
        gridDimensions?.width ?? null,
        layoutConfig.strategy,
        layoutConfig.value
      );
      if (currentIndex >= cols) {
        reorderTerminals(currentIndex, currentIndex - cols, "grid", activeWorktreeId);
      }
    },
  }));

  actions.set("terminal.moveDown", () => ({
    id: "terminal.moveDown",
    title: "Move Terminal Down",
    description: "Move terminal down in the grid",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = usePanelStore.getState();
      const { focusedId, panelIds, panelsById, reorderTerminals } = state;
      if (!focusedId) return;
      useLayoutUndoStore.getState().pushLayoutSnapshot();
      const terminal = panelsById[focusedId];
      if (!terminal || terminal.location === "dock") return;
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const gridTerminals = panelIds
        .map((id) => panelsById[id])
        .filter(
          (t) =>
            t &&
            (t.location === "grid" || t.location === undefined) &&
            (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
        );
      const currentIndex = gridTerminals.findIndex((t) => t!.id === focusedId);
      if (currentIndex < 0) return;
      const { layoutConfig, gridDimensions } = useLayoutConfigStore.getState();
      const cols = computeGridColumns(
        gridTerminals.length,
        gridDimensions?.width ?? null,
        layoutConfig.strategy,
        layoutConfig.value
      );
      if (currentIndex + cols < gridTerminals.length) {
        reorderTerminals(currentIndex, currentIndex + cols, "grid", activeWorktreeId);
      }
    },
  }));

  actions.set("terminal.toggleDock", () => ({
    id: "terminal.toggleDock",
    title: "Toggle Dock",
    description:
      "Toggle a terminal between the dock and the grid. Pushes a layout undo snapshot so the move can be reversed. Args: `terminalId` — panel UUID from `terminal.list` (the `id` field). REQUIRED for agent/MCP dispatch, which cannot see what is focused. Interactive dispatch may omit it and falls back to the focused terminal.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    // Carries a target even though the keybinding never passes one: without it
    // an agent/MCP caller had no way to name a terminal at all, so the binding
    // guard below could only ever reject it (#11532).
    argsSchema: z.object({ terminalId: z.string().optional() }),
    // Types the parameter instead of casting `unknown`, the way terminal.inject
    // does. Reads optionally because this action took no args until #11532 and
    // its keybinding still dispatches without any.
    run: async (args: { terminalId?: string } | undefined, ctx) => {
      const terminalId = args?.terminalId;
      requireExplicitTerminalIdForAgentDispatch("terminal.toggleDock", terminalId, ctx);
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (!targetId) return;
      const terminal = state.panelsById[targetId];
      if (!terminal) return;
      const toGrid = terminal.location === "dock";
      // Same dockability gate as terminal.moveToDock — a non-dockable kind
      // toggled dockward would strand invisibly.
      if (!toGrid && !panelKindIsDockable(terminal.kind ?? "terminal")) return;
      // Snapshot only once the move is certain: pushing clears the redo stack,
      // so doing it before these bails would let a caller naming a stale panel
      // wipe the user's redo history and then change nothing.
      useLayoutUndoStore.getState().pushLayoutSnapshot();
      if (toGrid) {
        state.moveTerminalToGrid(targetId);
      } else {
        state.moveTerminalToDock(targetId);
        state.openDockTerminal(targetId);
      }
    },
  }));

  actions.set("terminal.toggleDockAll", () => ({
    id: "terminal.toggleDockAll",
    title: "Toggle All Dock",
    description: "Toggle all terminals between grid and dock",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useLayoutUndoStore.getState().pushLayoutSnapshot();
      const state = usePanelStore.getState();
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const activeTerminals = state.panelIds
        .map((id) => state.panelsById[id])
        .filter(
          (t) =>
            t &&
            t.location !== "trash" &&
            // Overlay panels (the Daintree Assistant) are not dock/grid members;
            // including one would make `allDocked` permanently false (#9699).
            t.location !== "overlay" &&
            // Same for dialog panels: one open file dialog would make
            // `allDocked` false and turn "toggle" into a no-op "dock all".
            t.location !== "dialog" &&
            (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
        );
      const allDocked = activeTerminals.every((t) => t!.location === "dock");
      if (allDocked) {
        state.bulkMoveToGrid();
      } else {
        state.bulkMoveToDock();
      }
    },
  }));

  actions.set("layout.undo", () => ({
    id: "layout.undo",
    title: "Undo Layout Change",
    description: "Undo the last panel layout change (drag-and-drop, move, reorder)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    isEnabled: () => useLayoutUndoStore.getState().canUndo,
    disabledReason: () => {
      if (!useLayoutUndoStore.getState().canUndo) {
        return "No layout change to undo";
      }
      return undefined;
    },
    run: async () => {
      useLayoutUndoStore.getState().undo();
    },
  }));

  actions.set("layout.redo", () => ({
    id: "layout.redo",
    title: "Redo Layout Change",
    description: "Redo the last undone panel layout change",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    isEnabled: () => useLayoutUndoStore.getState().canRedo,
    disabledReason: () => {
      if (!useLayoutUndoStore.getState().canRedo) {
        return "No layout change to redo";
      }
      return undefined;
    },
    run: async () => {
      useLayoutUndoStore.getState().redo();
    },
  }));

  const setStrategySchema = z.object({
    strategy: z.enum(["automatic", "fixed-columns", "fixed-rows"]),
  });

  const runSetStrategy = async (args: unknown) => {
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
  };

  const setValueSchema = z.object({ value: z.number().int().min(1).max(10) });

  const runSetValue = async (args: unknown) => {
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
  };

  // Canonical panel.gridLayout.* action IDs
  actions.set("panel.gridLayout.setStrategy", () => ({
    id: "panel.gridLayout.setStrategy",
    title: "Set Grid Layout Strategy",
    description: "Set the panel grid layout strategy",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: setStrategySchema,
    run: runSetStrategy,
  }));

  actions.set("panel.gridLayout.setValue", () => ({
    id: "panel.gridLayout.setValue",
    title: "Set Grid Layout Value",
    description: "Set the panel grid layout value (columns/rows count)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: setValueSchema,
    run: runSetValue,
  }));

  // Legacy aliases for backward compatibility
  actions.set("terminal.gridLayout.setStrategy", () => ({
    id: "terminal.gridLayout.setStrategy",
    title: "Set Grid Layout Strategy",
    description: "Set the panel grid layout strategy",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: setStrategySchema,
    run: runSetStrategy,
  }));

  actions.set("terminal.gridLayout.setValue", () => ({
    id: "terminal.gridLayout.setValue",
    title: "Set Grid Layout Value",
    description: "Set the panel grid layout value (columns/rows count)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: setValueSchema,
    run: runSetValue,
  }));
}
