import { z } from "zod";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { getSidebarViewOptions } from "@/hooks/useSidebarViews";
import { OPEN_SIDEBAR_VIEW_SWITCHER_EVENT } from "@/lib/sidebarViews";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
import { useFocusStore } from "@/store/focusStore";
import { useSidebarViewStore, WORKTREES_SIDEBAR_VIEW_ID } from "@/store/sidebarViewStore";

const NO_PLUGIN_VIEWS = "No plugin adds a sidebar view to this project";

const SwitchViewArgsSchema = z.object({
  viewId: z
    .string()
    .min(1)
    .optional()
    .describe('"worktrees", or a plugin sidebar view id as activeSidebarView names it'),
});

type SidebarActionCallbacks = Pick<ActionCallbacks, "onToggleSidebar">;

/**
 * Bring a hidden sidebar back. Through the toggle path first, which owns its
 * resize handling; but that travels as a window event AppLayout drops while
 * any overlay is open — and the palette these run from still holds one while
 * it animates out — so a reveal that didn't land is applied directly, the way
 * `nav.toggleSidebar`'s undo does.
 */
function revealSidebar(callbacks: SidebarActionCallbacks): boolean {
  if (!useFocusStore.getState().gestureSidebarHidden) return false;
  callbacks.onToggleSidebar();
  if (useFocusStore.getState().gestureSidebarHidden) {
    suppressSidebarResizes();
    useFocusStore.getState().setSidebarGestureHidden(false);
  }
  return true;
}

export function registerSidebarActions(
  actions: ActionRegistry,
  callbacks: SidebarActionCallbacks
): void {
  actions.set("ui.sidebar.switchView", () => ({
    id: "ui.sidebar.switchView",
    title: "Switch sidebar view",
    description:
      "Show a sidebar view: the built-in worktree list or a plugin's. With no viewId, open the sidebar's view switcher.",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    keywords: ["sidebar", "view", "plugin", "switch"],
    argsSchema: SwitchViewArgsSchema,
    safeBreadcrumbArgs: ["viewId"],
    isEnabled: () => getSidebarViewOptions().length > 1,
    disabledReason: () => (getSidebarViewOptions().length > 1 ? undefined : NO_PLUGIN_VIEWS),
    run: async (args) => {
      const { viewId } = SwitchViewArgsSchema.parse(args ?? {});
      if (viewId !== undefined && !getSidebarViewOptions().some((option) => option.id === viewId)) {
        throw new Error(`No sidebar view "${viewId}" is on offer in this project`);
      }
      const revealed = revealSidebar(callbacks);
      if (viewId !== undefined) {
        useSidebarViewStore.getState().chooseSidebarView(viewId);
        return;
      }
      // A revealed sidebar is still inert until the layout commits it visible.
      const open = () => window.dispatchEvent(new CustomEvent(OPEN_SIDEBAR_VIEW_SWITCHER_EVENT));
      if (revealed) requestAnimationFrame(open);
      else open();
    },
  }));

  actions.set("ui.sidebar.showWorktrees", () => ({
    id: "ui.sidebar.showWorktrees",
    title: "Show worktrees in sidebar",
    description:
      "Switch the sidebar to its built-in view: the worktree list, or the workspace in a folder without git.",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    keywords: ["sidebar", "view", "worktrees", "workspace"],
    run: async () => {
      revealSidebar(callbacks);
      useSidebarViewStore.getState().chooseSidebarView(WORKTREES_SIDEBAR_VIEW_ID);
    },
  }));
}
