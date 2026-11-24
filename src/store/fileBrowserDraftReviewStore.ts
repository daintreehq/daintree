import { create } from "zustand";

export interface FileBrowserDraftReview {
  /** Module-wide, so settling an older request can never clear a newer one. */
  seq: number;
  /** The base-relative selection the draft belongs to. */
  path: string;
}

interface FileBrowserDraftReviewState {
  byPanelId: Readonly<Record<string, FileBrowserDraftReview>>;
  /** Ask the panel's viewer to open `path` in Edit, where the draft's recovery shows. */
  requestReview: (panelId: string, path: string) => void;
  /** The viewer took the request up. Ignored unless `seq` is still the panel's latest. */
  settleReview: (panelId: string, seq: number) => void;
}

let nextSeq = 1;

/**
 * "Review draft" for a file browser (#17197). A file panel stores its view
 * mode on the panel record, so the way back to a draft can just set it; a file
 * browser keeps its mode in the viewer's own state, which a tab or worktree
 * switch remounts or resets. The request waits here, keyed by panel, until a
 * viewer showing that file takes it up — including one that only mounts
 * because the request brought its tab forward.
 *
 * Renderer-local and per project view, like every store under `src/store`.
 */
export const useFileBrowserDraftReviewStore = create<FileBrowserDraftReviewState>()((set) => ({
  byPanelId: {},
  requestReview: (panelId, path) =>
    set((state) => ({
      byPanelId: { ...state.byPanelId, [panelId]: { seq: nextSeq++, path } },
    })),
  settleReview: (panelId, seq) =>
    set((state) => {
      if (state.byPanelId[panelId]?.seq !== seq) return state;
      const { [panelId]: _settled, ...rest } = state.byPanelId;
      return { byPanelId: rest };
    }),
}));
