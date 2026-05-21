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
  requestConfirmation: (cwd: string) => Promise<boolean>;
  resolveConfirmation: (ok: boolean) => void;
}

export const useGitPushConfirmStore = create<GitPushConfirmState>()((set, get) => ({
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
