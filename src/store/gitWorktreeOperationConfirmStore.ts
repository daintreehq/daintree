import { create } from "zustand";
import type { GitBaseIntegrationKind } from "@shared/types/git";
import type { RepoOperationState } from "@/components/Git/repoOperationCopy";

/**
 * Deferred-Promise confirm gate for the worktree Git submenu's three
 * history-changing rows (#12092): rebase onto the base branch, merge the base
 * branch in, and abort a halted operation.
 *
 * One store rather than three because they are one question asked at one
 * moment — "this changes the worktree's history, go ahead?" — and a menu can
 * only ever have one of them in flight. Splitting them would triple the
 * ModalHostLayer mounts and the reset-key plumbing for no behavioural gain.
 *
 * Mirrors `gitPushConfirmStore` / `gitPullRebaseConfirmStore`: a second request
 * while one is pending cancels the first (resolves false).
 */

/**
 * What is being confirmed.
 *
 * The two base kinds carry the base branch because the preview is measured
 * against it and the handler acts on it — the dialog must show the same ref
 * the operation will use, not re-derive one. `abort-operation` carries the
 * operation git is currently mid-way through, because what abort discards
 * depends on which one it is.
 */
export type GitWorktreeOperationConfirmRequest =
  | { kind: GitBaseIntegrationKind; cwd: string; baseBranch: string }
  | { kind: "abort-operation"; cwd: string; operation: RepoOperationState };

/**
 * What the dialog approved, not merely THAT it approved.
 *
 * A bare boolean was not enough: between the preview and the click an agent can
 * commit into the worktree or background fetch can move the base ref, and the
 * write would then do something other than what was on screen. `pinned` carries
 * the two commits the dialog actually described so the handler can refuse if
 * either moved. `null` when the surface had nothing to pin (the abort kind, or
 * a ref that did not resolve).
 */
export interface GitWorktreeOperationConfirmResult {
  confirmed: boolean;
  pinned: { headOid?: string; baseOid?: string } | null;
}

const DECLINED: GitWorktreeOperationConfirmResult = { confirmed: false, pinned: null };

interface PendingConfirmation {
  resolve: (result: GitWorktreeOperationConfirmResult) => void;
  request: GitWorktreeOperationConfirmRequest;
}

interface GitWorktreeOperationConfirmState {
  pendingConfirm: PendingConfirmation | null;
  /**
   * Monotonic counter bumped on every request. Used as the always-mounted
   * host's ErrorBoundary `resetKeys` signal so a crashed dialog auto-recovers
   * when a new request arrives — including the back-to-back supersede case
   * where `pendingConfirm` never returns to null between requests (#9918).
   */
  requestSeq: number;
  requestConfirmation: (
    request: GitWorktreeOperationConfirmRequest
  ) => Promise<GitWorktreeOperationConfirmResult>;
  resolveConfirmation: (
    ok: boolean,
    pinned?: { headOid?: string; baseOid?: string } | null
  ) => void;
}

export const useGitWorktreeOperationConfirmStore = create<GitWorktreeOperationConfirmState>()(
  (set, get) => ({
    pendingConfirm: null,
    requestSeq: 0,

    requestConfirmation: (
      request: GitWorktreeOperationConfirmRequest
    ): Promise<GitWorktreeOperationConfirmResult> => {
      const existing = get().pendingConfirm;
      if (existing) {
        existing.resolve(DECLINED);
      }

      return new Promise<GitWorktreeOperationConfirmResult>((resolve) => {
        set((state) => ({
          pendingConfirm: { resolve, request },
          requestSeq: state.requestSeq + 1,
        }));
      });
    },

    resolveConfirmation: (
      ok: boolean,
      pinned: { headOid?: string; baseOid?: string } | null = null
    ) => {
      const pending = get().pendingConfirm;
      if (pending) {
        pending.resolve(ok ? { confirmed: true, pinned } : DECLINED);
        set({ pendingConfirm: null });
      }
    },
  })
);
