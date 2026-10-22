import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import { getViewWorkspaceId } from "./viewWorkspaceId";
import { hostScopedKey } from "@/hooks/useHostPlatform";

/** The built-in sidebar view's id — the worktree list every project starts on. */
export const WORKTREES_SIDEBAR_VIEW_ID = "worktrees";

/** What the user said when a plugin view became this project's default. */
export type SidebarDefaultAnswer = "keep" | "worktrees";

/**
 * Which sidebar view this project view shows. Two ids, because a choice can
 * outlive what is on offer: a plugin view the user picked may not have loaded
 * yet (the hosted-view snapshot arrives after first render), or may stop
 * applying when its plugin is hidden or its `when` turns false. The choice is
 * kept through all of that and comes back the moment the view does.
 *
 * - `chosenSidebarView` is the user's own pick, remembered per project; `null`
 *   until they make one, so the project follows the highest-priority view on
 *   offer. A default is derived each render and never written here.
 * - `defaultAnswers` remembers, per view id, the answer to the one-time notice
 *   that a plugin view became the default, so it is asked once per view.
 * - `activeSidebarView` is what shows — the pick while it is on offer, else the
 *   default — and is what plugin `when` clauses see. Published by the sidebar
 *   host; independent of whether the sidebar is visible (`macroFocusStore`).
 */
interface SidebarViewState {
  chosenSidebarView: string | null;
  defaultAnswers: Record<string, SidebarDefaultAnswer>;
  activeSidebarView: string;
  chooseSidebarView: (viewId: string) => void;
  answerDefaultView: (viewId: string, answer: SidebarDefaultAnswer) => void;
  resetDefaultView: () => void;
  setActiveSidebarView: (viewId: string) => void;
}

interface SidebarViewPersistedState {
  chosenSidebarView: string | null;
  defaultAnswers: Record<string, SidebarDefaultAnswer>;
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
      chosenSidebarView: null,
      defaultAnswers: {},
      activeSidebarView: WORKTREES_SIDEBAR_VIEW_ID,
      chooseSidebarView: (viewId) =>
        set((state) =>
          state.chosenSidebarView === viewId ? state : { chosenSidebarView: viewId }
        ),
      // "Show worktrees" is an answer and a pick in one write, so the notice
      // and the view it leaves can't disagree.
      answerDefaultView: (viewId, answer) =>
        set((state) => ({
          defaultAnswers: { ...state.defaultAnswers, [viewId]: answer },
          ...(answer === "worktrees" ? { chosenSidebarView: WORKTREES_SIDEBAR_VIEW_ID } : {}),
        })),
      resetDefaultView: () =>
        set((state) =>
          state.chosenSidebarView === null && Object.keys(state.defaultAnswers).length === 0
            ? state
            : { chosenSidebarView: null, defaultAnswers: {} }
        ),
      setActiveSidebarView: (viewId) =>
        set((state) =>
          state.activeSidebarView === viewId ? state : { activeSidebarView: viewId }
        ),
    }),
    {
      name: STORAGE_KEY,
      version: 2,
      storage: createSafeJSONStorage<SidebarViewPersistedState>(),
      partialize: (state): SidebarViewPersistedState => ({
        chosenSidebarView: state.chosenSidebarView,
        defaultAnswers: state.defaultAnswers,
      }),
      // v1 stored the worktree list as the pick of a user who never chose, so it
      // can't be told from a deliberate one: it becomes "no pick" and the project
      // follows the default. Any other id was a pick.
      migrate: (persisted) => {
        const chosen = readChosen(persisted);
        return {
          chosenSidebarView: chosen === WORKTREES_SIDEBAR_VIEW_ID ? null : chosen,
          defaultAnswers: {},
        };
      },
      // The file is user-editable: anything but a non-empty id is "no pick".
      merge: (persisted, current) => ({
        ...current,
        chosenSidebarView: readChosen(persisted),
        defaultAnswers: readAnswers(persisted),
      }),
    }
  )
);

function readChosen(persisted: unknown): string | null {
  const chosen =
    typeof persisted === "object" && persisted !== null && "chosenSidebarView" in persisted
      ? persisted.chosenSidebarView
      : undefined;
  return typeof chosen === "string" && chosen.length > 0 ? chosen : null;
}

function readAnswers(persisted: unknown): Record<string, SidebarDefaultAnswer> {
  const raw =
    typeof persisted === "object" && persisted !== null && "defaultAnswers" in persisted
      ? persisted.defaultAnswers
      : undefined;
  const answers: Record<string, SidebarDefaultAnswer> = {};
  if (typeof raw !== "object" || raw === null) return answers;
  for (const [id, answer] of Object.entries(raw)) {
    if (answer === "keep" || answer === "worktrees") answers[id] = answer;
  }
  return answers;
}

registerPersistedStore({
  storeId: "sidebarViewStore",
  store: useSidebarViewStore,
  persistedStateType:
    '{ chosenSidebarView: string | null; defaultAnswers: Record<string, "keep" | "worktrees"> }',
});
