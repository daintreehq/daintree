import type { ActionCallbacks, ActionRegistry } from "../actionTypes";

export function registerNavigationActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
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

  actions.set("action.palette.open", () => ({
    id: "action.palette.open",
    title: "Open Action Palette",
    description: "Search and execute any action",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenActionPalette();
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

  actions.set("nav.quickSwitcher", () => ({
    id: "nav.quickSwitcher",
    title: "Quick Switcher",
    description: "Search and switch between terminals, agents, and worktrees",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenQuickSwitcher();
    },
  }));

  actions.set("nav.focusRegion.next", () => ({
    id: "nav.focusRegion.next",
    title: "Focus Next Region",
    description: "Cycle focus to the next major UI region",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onFocusRegionNext();
    },
  }));

  actions.set("nav.focusRegion.prev", () => ({
    id: "nav.focusRegion.prev",
    title: "Focus Previous Region",
    description: "Cycle focus to the previous major UI region",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onFocusRegionPrev();
    },
  }));

  actions.set("find.inFocusedPanel", () => ({
    id: "find.inFocusedPanel",
    title: "Find in Focused Panel",
    description: "Open find/search in the focused panel",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("daintree:find-in-panel"));
    },
  }));
}
