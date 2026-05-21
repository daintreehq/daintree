import { create } from "zustand";

/**
 * Deferred-Promise confirm gate for the `git.pullRebase` action when
 * dispatched outside the ReviewHub component path — palette, keybinding, or
 * the terminal push-error `ErrorBanner` recovery action
 * (`shared/utils/gitOperationErrors.ts` maps `push-rejected-outdated` to
 * `git.pullRebase`). `ActionService.dispatch` only blocks unconfirmed agent
 * sources, so those interactive paths would otherwise rebase with no preview
 * (#8242). The ReviewHub CTA calls `window.electron.git.pullRebase` directly
 * and is gated by its own in-component `ConfirmDialog`, so it never reaches
 * this store.
 *
 * Mirrors `gitPushConfirmStore` / `panelLimitStore`: a second request while
 * one is pending cancels the first (resolves false).
 */

interface PendingPullRebaseConfirmation {
  resolve: (ok: boolean) => void;
  cwd: string;
}

interface GitPullRebaseConfirmState {
  pendingConfirm: PendingPullRebaseConfirmation | null;
  requestConfirmation: (cwd: string) => Promise<boolean>;
  resolveConfirmation: (ok: boolean) => void;
}

export const useGitPullRebaseConfirmStore = create<GitPullRebaseConfirmState>()((set, get) => ({
  pendingConfirm: null,

  requestConfirmation: (cwd: string): Promise<boolean> => {
    const existing = get().pendingConfirm;
    if (existing) {
      existing.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      set({ pendingConfirm: { resolve, cwd } });
    });
  },

  resolveConfirmation: (ok: boolean) => {
    const pending = get().pendingConfirm;
    if (pending) {
      pending.resolve(ok);
      set({ pendingConfirm: null });
    }
  },
}));
