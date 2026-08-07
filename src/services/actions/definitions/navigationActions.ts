import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { notifyUndoableKeyboardLayoutChange } from "../keyboardLayoutChangeFeedback";
import { useFocusStore } from "@/store/focusStore";

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
    nonRepeatable: true,
    run: async (_args, ctx) => {
      // Read the store across the callback rather than predicting the outcome:
      // the toggle travels through a synchronous window event to AppLayout,
      // which drops it when an overlay is open or no workspace is mounted. An
      // observed false → true transition is the only proof the sidebar actually
      // went away, and it costs nothing to re-derive those guards here.
      const wasHidden = useFocusStore.getState().gestureSidebarHidden;
      callbacks.onToggleSidebar();
      const isHidden = useFocusStore.getState().gestureSidebarHidden;

      notifyUndoableKeyboardLayoutChange({
        actionId: "nav.toggleSidebar",
        dispatchSource: ctx?.dispatchSource,
        changed: !wasHidden && isHidden,
        title: "Sidebar hidden",
        message: (displayCombo) => `${displayCombo} toggles the sidebar`,
        onUndo: () => {
          // The user may have brought it back themselves while the toast was up.
          if (!useFocusStore.getState().gestureSidebarHidden) return;
          // Back out through the same event, so AppLayout re-applies its resize
          // suppression and the live sidebar width — rather than writing the
          // focus store here with panel state we'd have to guess.
          callbacks.onToggleSidebar();
          // That event is dropped while an overlay is open, and the toast is
          // dismissed by the click either way. Undo is a promise the user
          // already accepted, so restore directly rather than leave them with
          // the sidebar still gone and the way back retired. Safe to pass no
          // panel state: revealing keeps whatever the store already held.
          if (useFocusStore.getState().gestureSidebarHidden) {
            useFocusStore.getState().setSidebarGestureHidden(false);
          }
        },
      });
    },
  }));

  actions.set("action.palette.open", () => ({
    id: "action.palette.open",
    title: "Open Command Palette",
    description: "Search and execute any action",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    // Opens a modal palette — a post-dispatch hint would land on top of it
    // (ShortcutHint sits at z-toast, above z-modal). Issue #11030.
    // Not redundant with dispatch()'s overlay-claim check (#11507): this
    // opener is synchronous, so the continuation can beat the palette's
    // claim effect. Keep the flag.
    suppressShortcutHint: true,
    run: async () => {
      callbacks.onOpenActionPalette();
    },
  }));

  actions.set("nav.toggleFocusMode", () => ({
    id: "nav.toggleFocusMode",
    title: "Toggle Focus Mode",
    description: "Toggle focus mode (hide sidebar and assistant panel)",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    keywords: ["zen", "focus", "distraction-free"],
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
    nonRepeatable: true,
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
    nonRepeatable: true,
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
    nonRepeatable: true,
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
