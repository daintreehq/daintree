import { create } from "zustand";
import type { GitPullRebaseReview } from "@shared/types/git";

/**
 * Deferred-Promise confirm gate for pull-and-rebase. Two callers await it: the
 * `git.pullRebase` action when dispatched outside agent control — palette,
 * keybinding, or the terminal push-error `ErrorBanner` recovery action
 * (`shared/utils/gitOperationErrors.ts` maps `push-rejected-outdated` to
 * `git.pullRebase`) — and Review Hub's pull-and-rebase CTA, which calls the IPC
 * itself after asking here. `ActionService.dispatch` only blocks unconfirmed
 * agent sources, so those interactive paths would otherwise rebase with no
 * preview (#8242).
 *
 * Mirrors `gitPushConfirmStore` / `panelLimitStore`: a second request while
 * one is pending cancels the first (resolves declined).
 */

/**
 * What the dialog approved, not merely THAT it approved (#17188).
 *
 * A bare boolean let the pull rebase whatever the worktree held by the time it
 * ran: agents keep committing and checking out branches while the dialog is
 * open. `review` is the branch and commit the dialog's replay set was measured
 * against, and the pull refuses if either moved. Always `null` when declined.
 */
export type GitPullRebaseConfirmResult =
  { confirmed: true; review: GitPullRebaseReview } | { confirmed: false; review: null };

const DECLINED: GitPullRebaseConfirmResult = { confirmed: false, review: null };

interface PendingPullRebaseConfirmation {
  resolve: (result: GitPullRebaseConfirmResult) => void;
  cwd: string;
}

interface GitPullRebaseConfirmState {
  pendingConfirm: PendingPullRebaseConfirmation | null;
  /**
   * Monotonic counter bumped on every request. The dialog keys its preview read
   * on it, so a request that supersedes another for the SAME worktree reads its
   * own preview instead of approving the first one's (#17188). The
   * always-mounted host also uses it as its ErrorBoundary `resetKeys` signal so
   * a crashed dialog auto-recovers when a new request arrives — including the
   * back-to-back supersede case where `pendingConfirm` never returns to null
   * between requests (#9918).
   */
  requestSeq: number;
  requestConfirmation: (cwd: string) => Promise<GitPullRebaseConfirmResult>;
  /** Approve with the review on screen, or decline with `null`. */
  resolveConfirmation: (review: GitPullRebaseReview | null) => void;
}

export const useGitPullRebaseConfirmStore = create<GitPullRebaseConfirmState>()((set, get) => ({
  pendingConfirm: null,
  requestSeq: 0,

  requestConfirmation: (cwd: string): Promise<GitPullRebaseConfirmResult> => {
    const existing = get().pendingConfirm;
    if (existing) {
      existing.resolve(DECLINED);
    }

    return new Promise<GitPullRebaseConfirmResult>((resolve) => {
      set((state) => ({ pendingConfirm: { resolve, cwd }, requestSeq: state.requestSeq + 1 }));
    });
  },

  resolveConfirmation: (review: GitPullRebaseReview | null) => {
    const pending = get().pendingConfirm;
    if (pending) {
      pending.resolve(review ? { confirmed: true, review } : DECLINED);
      set({ pendingConfirm: null });
    }
  },
}));

/**
 * Decline a pull whose dialog failed to render (#17204), so the action
 * awaiting it ends. A no-op unless request `requestSeq` is still pending.
 */
export function declineFailedGitPullRebaseConfirmation(requestSeq: number): void {
  const state = useGitPullRebaseConfirmStore.getState();
  if (state.pendingConfirm === null || state.requestSeq !== requestSeq) return;
  state.resolveConfirmation(null);
}
