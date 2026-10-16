import { create } from "zustand";

/**
 * Deferred-Promise confirm gate for the two destructive file-row actions,
 * `git.discardFileChanges` and `file.trash` (#13424). The menu closes before
 * the action settles and its row may vanish with the file, so the dialog lives
 * in an always-mounted host rather than beside the row.
 *
 * Mirrors `gitPullRebaseConfirmStore`: a second request while one is pending
 * cancels the first (resolves false).
 */

export type FileMutationKind = "discard" | "trash";

export interface FileMutationConfirmRequest {
  kind: FileMutationKind;
  /** Path relative to the worktree root, shown so the dialog names the file. */
  relativePath: string;
}

interface PendingFileMutationConfirmation extends FileMutationConfirmRequest {
  resolve: (ok: boolean) => void;
}

interface FileMutationConfirmState {
  pendingConfirm: PendingFileMutationConfirmation | null;
  /** Bumped on every request; the host's ErrorBoundary `resetKeys` signal (#9918). */
  requestSeq: number;
  requestConfirmation: (request: FileMutationConfirmRequest) => Promise<boolean>;
  resolveConfirmation: (ok: boolean) => void;
}

export const useFileMutationConfirmStore = create<FileMutationConfirmState>()((set, get) => ({
  pendingConfirm: null,
  requestSeq: 0,

  requestConfirmation: (request) => {
    get().pendingConfirm?.resolve(false);
    return new Promise<boolean>((resolve) => {
      set((state) => ({
        pendingConfirm: { ...request, resolve },
        requestSeq: state.requestSeq + 1,
      }));
    });
  },

  resolveConfirmation: (ok) => {
    const pending = get().pendingConfirm;
    if (pending) {
      pending.resolve(ok);
      set({ pendingConfirm: null });
    }
  },
}));
