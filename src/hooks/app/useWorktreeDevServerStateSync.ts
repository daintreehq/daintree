import { useEffect } from "react";
import { useWorktreeDevServerStore } from "@/store/worktreeDevServerStore";

/**
 * App-level singleton that mirrors every `DEV_PREVIEW_STATE_CHANGED` broadcast
 * into `worktreeDevServerStore`, keyed by `worktreeId`. Mount once (in `App`).
 *
 * Payloads without a `worktreeId` (dev-preview panels opened with no worktree
 * association) are skipped — the worktree dashboard is worktree-centric and has
 * no row to attach them to. The subscription lives in `useEffect` with a
 * returned cleanup so it never leaks across fast-refresh or unmount (#4754).
 */
export function useWorktreeDevServerStateSync(): void {
  useEffect(() => {
    return window.electron.devPreview.onStateChanged((payload) => {
      const { state } = payload;
      const worktreeId = state.worktreeId?.trim();
      if (!worktreeId) return;
      useWorktreeDevServerStore.getState().setSession(worktreeId, state);
    });
  }, []);
}
