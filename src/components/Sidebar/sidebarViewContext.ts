import { createContext, useContext, type ComponentType } from "react";
import type { SidebarViewOption } from "@/lib/sidebarViews";
import { WORKTREES_SIDEBAR_VIEW_ID } from "@/store/sidebarViewStore";

/** What every sidebar header needs to draw the switcher, provided by `SidebarViewHost`. */
export interface SidebarViewSwitcherModel {
  /** Highest priority first, the built-in view always among them. */
  options: readonly SidebarViewOption[];
  /** The view showing. */
  activeId: string;
  /** The built-in view's name and glyph here: the worktree list, or the workspace without git. */
  builtIn: { title: string; icon: ComponentType<{ className?: string }> };
  choose: (viewId: string) => void;
}

export const SidebarViewSwitcherContext = createContext<SidebarViewSwitcherModel | null>(null);

/**
 * Whether the built-in view this component belongs to is hidden behind a
 * plugin's sidebar view. It stays mounted and laid out there, so anything that
 * acts on its geometry or speaks for it — a drop target, an announcement —
 * has to stand down itself: `inert` covers focus and pointer input only.
 */
export function useBuiltInSidebarViewHidden(): boolean {
  const model = useContext(SidebarViewSwitcherContext);
  return model !== null && model.activeId !== WORKTREES_SIDEBAR_VIEW_ID;
}
