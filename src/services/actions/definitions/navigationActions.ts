import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { notifyUndoableKeyboardLayoutChange } from "../keyboardLayoutChangeFeedback";
import { useFocusStore } from "@/store/focusStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectHomeStore } from "@/store/projectHomeStore";
import { currentProjectSurface } from "@/hooks/useRenderableSurfaceClaim";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";

/** Only a project whose plugin offers a Home, and that hasn't chosen to have none, has one to go to. */
const hasProjectHome = () => currentProjectSurface("projectHome") !== null;
const NO_PROJECT_HOME = "This project has no home view";

export function registerNavigationActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("nav.toggleSidebar", () => ({
    id: "nav.toggleSidebar",
    title: "Toggle sidebar",
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
            // Take the resize lock AppLayout would have taken, or the width
            // animates without it and the terminals re-fit every frame.
            suppressSidebarResizes();
            useFocusStore.getState().setSidebarGestureHidden(false);
          }
        },
      });
    },
  }));

  actions.set("action.palette.open", () => ({
    id: "action.palette.open",
    title: "Open command palette",
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
    title: "Toggle focus mode",
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
    title: "Quick switcher",
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

  actions.set("nav.showProjectHome", () => ({
    id: "nav.showProjectHome",
    title: "Show project home",
    description: "Switch the main area to the home view this project's plugin provides",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    keywords: ["home", "plugin", "main area"],
    isVisible: hasProjectHome,
    isEnabled: hasProjectHome,
    disabledReason: () => (hasProjectHome() ? undefined : NO_PROJECT_HOME),
    run: async () => {
      // Asked for by name, so a maximized cell drawing over the main area
      // gives way rather than leave the command looking like it did nothing.
      usePanelStore.getState().exitMaximize();
      useProjectHomeStore.getState().showHome();
    },
  }));

  actions.set("nav.showProjectSplit", () => ({
    id: "nav.showProjectSplit",
    title: "Show project home beside grid",
    description:
      "Show the project's home view beside its panels, so agents launched or focused there keep it in view",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    keywords: ["home", "split", "side by side", "plugin", "main area", "panels"],
    isVisible: hasProjectHome,
    isEnabled: hasProjectHome,
    disabledReason: () => (hasProjectHome() ? undefined : NO_PROJECT_HOME),
    run: async () => {
      // A maximize stays: in a split it fills only the panels' side.
      useProjectHomeStore.getState().showSplit();
    },
  }));

  actions.set("nav.showGrid", () => ({
    id: "nav.showGrid",
    title: "Show grid",
    description: "Switch the main area from the project's home view to its panels alone",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    keywords: ["panels", "grid", "main area"],
    isVisible: hasProjectHome,
    isEnabled: hasProjectHome,
    disabledReason: () => (hasProjectHome() ? undefined : NO_PROJECT_HOME),
    run: async () => {
      useProjectHomeStore.getState().showGrid();
    },
  }));

  actions.set("nav.focusRegion.next", () => ({
    id: "nav.focusRegion.next",
    title: "Focus next region",
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
    title: "Focus previous region",
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
    title: "Find in focused panel",
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
