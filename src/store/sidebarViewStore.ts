import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import { getViewWorkspaceId } from "./viewWorkspaceId";
import { hostScopedKey } from "@/hooks/useHostPlatform";

/** The built-in sidebar view's id — the worktree list every project starts on. */
export const WORKTREES_SIDEBAR_VIEW_ID = "worktrees";

/**
 * Which sidebar view this project view shows. Two ids, because a choice can
 * outlive what is on offer: a plugin view the user picked may not have loaded
 * yet (the hosted-view snapshot arrives after first render), or may stop
 * applying when its plugin is hidden or its `when` turns false. The choice is
 * kept through all of that and comes back the moment the view does.
 *
 * - `chosenSidebarView` is the user's pick, remembered per project.
 * - `activeSidebarView` is what shows — the pick while it is on offer, else the
 *   worktree list — and is what plugin `when` clauses see. Reconciled by the
 *   sidebar host (`useSidebarViewReconciler`); independent of whether the
 *   sidebar is visible (`macroFocusStore`).
 */
interface SidebarViewState {
  chosenSidebarView: string;
  activeSidebarView: string;
  chooseSidebarView: (viewId: string) => void;
  setActiveSidebarView: (viewId: string) => void;
}

interface SidebarViewPersistedState {
  chosenSidebarView: string;
}

/**
 * One key per workspace, like the worktree filters: the view and its id are
 * fixed for the life of this renderer, and two windows on the same project
 * share the pick. Host-scoped, because a remote host's project can carry the
 * same id as a local one and every view shares this storage; bare locally.
 */
const STORAGE_KEY = `daintree-sidebar-view:${hostScopedKey(getViewWorkspaceId() ?? "default")}`;

export const useSidebarViewStore = create<SidebarViewState>()(
  persist(
    (set) => ({
      chosenSidebarView: WORKTREES_SIDEBAR_VIEW_ID,
      activeSidebarView: WORKTREES_SIDEBAR_VIEW_ID,
      chooseSidebarView: (viewId) =>
        set((state) =>
          state.chosenSidebarView === viewId ? state : { chosenSidebarView: viewId }
        ),
      setActiveSidebarView: (viewId) =>
        set((state) =>
          state.activeSidebarView === viewId ? state : { activeSidebarView: viewId }
        ),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createSafeJSONStorage<SidebarViewPersistedState>(),
      partialize: (state): SidebarViewPersistedState => ({
        chosenSidebarView: state.chosenSidebarView,
      }),
      // The file is user-editable: anything but a non-empty id is the default.
      merge: (persisted, current) => {
        const chosen =
          typeof persisted === "object" && persisted !== null && "chosenSidebarView" in persisted
            ? persisted.chosenSidebarView
            : undefined;
        return typeof chosen === "string" && chosen.length > 0
          ? { ...current, chosenSidebarView: chosen }
          : current;
      },
    }
  )
);

registerPersistedStore({
  storeId: "sidebarViewStore",
  store: useSidebarViewStore,
  persistedStateType: "{ chosenSidebarView: string }",
});
