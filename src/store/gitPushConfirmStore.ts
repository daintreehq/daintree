import { create } from "zustand";

/**
 * Deferred-Promise confirm gate for `git.push` dispatched from the action
 * palette or a keybinding. `ActionService.dispatch` only blocks destructive
 * actions from `source === "agent"`, so palette/keybinding pushes would
 * otherwise reach `window.electron.git.push` with no D2 preview (#8242).
 *
 * Mirrors the `panelLimitStore` request/resolve pattern: the action `run()`
 * awaits `requestConfirmation`, the lazily-mounted `GitPushConfirmDialog`
 * resolves it. A second request while one is pending cancels the first
 * (resolves false) — same semantics as `panelLimitStore`.
 */

interface PendingPushConfirmation {
  resolve: (ok: boolean) => void;
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
  requestConfirmation: (cwd: string) => Promise<boolean>;
  resolveConfirmation: (ok: boolean) => void;
}

export const useGitPushConfirmStore = create<GitPushConfirmState>()((set, get) => ({
  pendingConfirm: null,
  requestSeq: 0,

  requestConfirmation: (cwd: string): Promise<boolean> => {
    const existing = get().pendingConfirm;
    if (existing) {
      existing.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      set((state) => ({ pendingConfirm: { resolve, cwd }, requestSeq: state.requestSeq + 1 }));
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
