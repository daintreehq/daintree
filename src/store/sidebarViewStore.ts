import { create } from "zustand";

/** The built-in sidebar view's id — the worktree list every project starts on. */
export const WORKTREES_SIDEBAR_VIEW_ID = "worktrees";

/**
 * Which sidebar view this project view shows, published to plugin `when`
 * clauses as `activeSidebarView`. Independent of whether the sidebar is
 * visible (`macroFocusStore`). Not persisted: remembering the choice per
 * project belongs to the sidebar view switcher that drives it.
 */
interface SidebarViewState {
  activeSidebarView: string;
  setActiveSidebarView: (viewId: string) => void;
}

export const useSidebarViewStore = create<SidebarViewState>((set) => ({
  activeSidebarView: WORKTREES_SIDEBAR_VIEW_ID,
  setActiveSidebarView: (viewId) =>
    set((state) => (state.activeSidebarView === viewId ? state : { activeSidebarView: viewId })),
}));
