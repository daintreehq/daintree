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
}
