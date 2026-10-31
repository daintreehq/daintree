import { create } from "zustand";
import type { GitPushReview } from "@shared/types/git";

/**
 * Deferred-Promise confirm gate for `git.push` dispatched from the action
 * palette or a keybinding. `ActionService.dispatch` only blocks destructive
 * actions from `source === "agent"`, so palette/keybinding pushes would
 * otherwise reach `window.electron.git.push` with no D2 preview (#8242).
 *
 * Mirrors the `panelLimitStore` request/resolve pattern: the action `run()`
 * awaits `requestConfirmation`, the lazily-mounted `GitPushConfirmDialog`
 * resolves it. A second request while one is pending cancels the first
 * (resolves declined) — same semantics as `panelLimitStore`.
 */

/**
 * What the dialog approved, not merely THAT it approved (#15646).
 *
 * A bare boolean let the push run against whatever the branch held by then:
 * agents keep committing, checking out and reconfiguring the worktree while the
 * dialog is open. `review` is the branch, commit and destination the dialog was
 * showing when it was approved, and the push refuses if any of them moved.
 * Always `null` when declined.
 */
export type GitPushConfirmResult =
  | { confirmed: true; review: GitPushReview }
  | { confirmed: false; review: null };

const DECLINED: GitPushConfirmResult = { confirmed: false, review: null };

interface PendingPushConfirmation {
  resolve: (result: GitPushConfirmResult) => void;
  cwd: string;
}

interface GitPushConfirmState {
  pendingConfirm: PendingPushConfirmation | null;
  /**
   * Monotonic counter bumped on every request. Used as the always-mounted host's
   * ErrorBoundary `resetKeys` signal so a crashed dialog auto-recovers when a new
   * request arrives — including the back-to-back supersede case where
   * `pendingConfirm` never returns to null between requests (#9918).
   */
  requestSeq: number;
  requestConfirmation: (cwd: string) => Promise<GitPushConfirmResult>;
  /** Approve with the review on screen, or decline with `null`. */
  resolveConfirmation: (review: GitPushReview | null) => void;
}

export const useGitPushConfirmStore = create<GitPushConfirmState>()((set, get) => ({
  pendingConfirm: null,
  requestSeq: 0,

  requestConfirmation: (cwd: string): Promise<GitPushConfirmResult> => {
    const existing = get().pendingConfirm;
    if (existing) {
      existing.resolve(DECLINED);
    }

    return new Promise<GitPushConfirmResult>((resolve) => {
      set((state) => ({ pendingConfirm: { resolve, cwd }, requestSeq: state.requestSeq + 1 }));
    });
  },

  resolveConfirmation: (review: GitPushReview | null) => {
    const pending = get().pendingConfirm;
    if (pending) {
      pending.resolve(review ? { confirmed: true, review } : DECLINED);
      set({ pendingConfirm: null });
    }
  },
}));
