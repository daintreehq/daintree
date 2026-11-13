import { create } from "zustand";

/** What the confirmation shows, frozen when the request opened. */
export interface ResourceTeardownConfirmRequest {
  worktreeId: string;
  /** The worktree as the card names it: its issue title, else branch, else folder. */
  label: string;
  /**
   * The resource teardown commands the host would run, already substituted.
   * Empty when it found none; `null` when they couldn't be read.
   */
  commands: string[] | null;
  /** `false` when they come from a config the user hasn't approved, so none will run yet. */
  approved: boolean;
}

interface PendingResourceTeardownConfirmation {
  resolve: (ok: boolean) => void;
  request: ResourceTeardownConfirmRequest;
}

interface WorktreeResourceTeardownConfirmState {
  pendingConfirm: PendingResourceTeardownConfirmation | null;
  /** Bumped on every request; the host's ErrorBoundary `resetKeys` signal (#9918). */
  requestSeq: number;
  requestConfirmation: (request: ResourceTeardownConfirmRequest) => Promise<boolean>;
  resolveConfirmation: (ok: boolean) => void;
}

/**
 * Deferred-Promise confirm gate for `worktree.resource.teardown`.
 * `ActionService` only gates agent and plugin dispatch, so the palette, a
 * keybinding and the card's menu all reach `run()` unconfirmed and this is the
 * one dialog every one of them waits on. A second request while one is pending
 * cancels the first.
 */
export const useWorktreeResourceTeardownConfirmStore = create<WorktreeResourceTeardownConfirmState>()(
  (set, get) => ({
    pendingConfirm: null,
    requestSeq: 0,

    requestConfirmation: (request) => {
      get().pendingConfirm?.resolve(false);
      return new Promise<boolean>((resolve) => {
        set((state) => ({
          pendingConfirm: { resolve, request },
          requestSeq: state.requestSeq + 1,
        }));
      });
    },

    resolveConfirmation: (ok) => {
      const pending = get().pendingConfirm;
      if (!pending) return;
      pending.resolve(ok);
      set({ pendingConfirm: null });
    },
  })
);
