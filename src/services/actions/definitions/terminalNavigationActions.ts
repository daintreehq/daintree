import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import type { ActionId } from "@shared/types/actions";
import { useTerminalStore } from "@/store/terminalStore";
export function registerTerminalNavigationActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("terminal.focusNext", () => ({
    id: "terminal.focusNext",
    title: "Focus Next Terminal",
    description: "Focus the next terminal (cycles through grid then dock)",
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
    description: "Focus the previous terminal (cycles through grid then dock)",
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

  actions.set("terminal.focusDock", () => ({
    id: "terminal.focusDock",
    title: "Focus Dock",
    description: "Focus the active dock terminal (or first dock terminal in the active worktree)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = useTerminalStore.getState();
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const dockTerminals = state.terminals.filter(
        (t) =>
          t.location === "dock" && (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      );
      if (dockTerminals.length === 0) return;

      const targetId =
        (state.activeDockTerminalId &&
          dockTerminals.some((t) => t.id === state.activeDockTerminalId) &&
          state.activeDockTerminalId) ||
        dockTerminals[0]!.id;
      const group = state.getPanelGroup(targetId);
      if (group) {
        state.setActiveTab(group.id, targetId);
      }
      state.openDockTerminal(targetId);
    },
  }));

  actions.set("terminal.scrollToLastActivity", () => ({
    id: "terminal.scrollToLastActivity",
    title: "Scroll to Last Activity",
    description: "Scroll the focused terminal to where the agent last produced output",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const focusedId = useTerminalStore.getState().focusedId;
      if (!focusedId) return;
      const { terminalInstanceService } =
        await import("@/services/terminal/TerminalInstanceService");
      terminalInstanceService.scrollToLastActivity(focusedId);
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
