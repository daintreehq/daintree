import { create } from "zustand";

/**
 * Deferred-Promise confirm gate for the two destructive file-row actions,
 * `git.discardFileChanges` and `file.trash` (#13424). The menu closes before
 * the action settles and its row may vanish with the file, so the dialog lives
 * in an always-mounted host rather than beside the row.
 *
 * Mirrors `gitPullRebaseConfirmStore`: a second request while one is pending
 * cancels the first (resolves null).
 */

export type FileMutationKind = "discard" | "trash";

export interface FileMutationConfirmRequest {
  kind: FileMutationKind;
  /** Path relative to the worktree root, shown so the dialog names the file. */
  relativePath: string;
  /** Absolute worktree root the dialog reads its preview from (#15122). */
  worktreePath: string;
}

/** What the user approved. Null from `requestConfirmation` means they didn't. */
export interface FileMutationApproval {
  /**
   * The discard preview's fingerprint, for the discard to check before it
   * acts; null for a trash, which the Trash itself makes recoverable.
   */
  token: string | null;
}

interface PendingFileMutationConfirmation extends FileMutationConfirmRequest {
  resolve: (approval: FileMutationApproval | null) => void;
}

interface FileMutationConfirmState {
  pendingConfirm: PendingFileMutationConfirmation | null;
  /** Bumped on every request; the host's ErrorBoundary `resetKeys` signal (#9918). */
  requestSeq: number;
  requestConfirmation: (
    request: FileMutationConfirmRequest
  ) => Promise<FileMutationApproval | null>;
  resolveConfirmation: (approval: FileMutationApproval | null) => void;
}

export const useFileMutationConfirmStore = create<FileMutationConfirmState>()((set, get) => ({
  pendingConfirm: null,
  requestSeq: 0,

  requestConfirmation: (request) => {
    get().pendingConfirm?.resolve(null);
    return new Promise<FileMutationApproval | null>((resolve) => {
      set((state) => ({
        pendingConfirm: { ...request, resolve },
        requestSeq: state.requestSeq + 1,
      }));
    });
  },

  resolveConfirmation: (approval) => {
    const pending = get().pendingConfirm;
    if (pending) {
      pending.resolve(approval);
      set({ pendingConfirm: null });
    }
  },
}));
