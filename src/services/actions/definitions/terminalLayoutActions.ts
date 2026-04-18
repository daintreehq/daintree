import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { appClient } from "@/clients";
import { computeGridColumns } from "@/lib/terminalLayout";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";
import { usePanelStore } from "@/store/panelStore";
import { useLayoutUndoStore } from "@/store/layoutUndoStore";
export function registerTerminalLayoutActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
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
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        const terminal = state.panelsById[targetId];
        if (!terminal) {
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
    description: "Move terminal to the grid",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
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
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
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
      const { layoutConfig } = useLayoutConfigStore.getState();
      const cols = computeGridColumns(
        gridTerminals.length,
        null,
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
      const { layoutConfig } = useLayoutConfigStore.getState();
      const cols = computeGridColumns(
        gridTerminals.length,
        null,
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
    description: "Toggle focused terminal between grid and dock",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = usePanelStore.getState();
      const focusedId = state.focusedId;
      if (!focusedId) return;
      useLayoutUndoStore.getState().pushLayoutSnapshot();
      const terminal = state.panelsById[focusedId];
      if (!terminal) return;
      if (terminal.location === "dock") {
        state.moveTerminalToGrid(focusedId);
      } else {
        state.moveTerminalToDock(focusedId);
        state.openDockTerminal(focusedId);
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
