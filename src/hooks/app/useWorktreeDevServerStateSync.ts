import { useEffect } from "react";
import { useWorktreeDevServerStore } from "@/store/worktreeDevServerStore";
import { onHostResync } from "@/store/hostResyncSignal";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";

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
    let disposed = false;
    // Worktrees whose state changed while a resync's snapshot was out: their
    // broadcast is newer than the snapshot, even within the same millisecond.
    let changedDuringResync: Set<string> | null = null;
    const offChanges = window.electron.devPreview.onStateChanged((payload) => {
      const { state } = payload;
      const worktreeId = state.worktreeId?.trim();
      if (!worktreeId) return;
      changedDuringResync?.add(worktreeId);
      useWorktreeDevServerStore.getState().setSession(worktreeId, state);
    });

    // Broadcasts sent while the link to a host was down are lost: take the
    // host's current sessions once it's back, and drop the ones it no longer
    // has (they ended meanwhile). Only the latest resync's answer applies.
    const asks = { latest: 0 };
    const offResync = onHostResync(() => {
      asks.latest += 1;
      const mine = asks.latest;
      const changed = new Set<string>();
      changedDuringResync = changed;
      window.electron.devPreview.getAllSessions().then(
        (sessions) => {
          if (disposed || mine !== asks.latest) return;
          changedDuringResync = null;
          const store = useWorktreeDevServerStore.getState();
          // The host answers for every project; this view follows its own.
          const projectId = getViewWorkspaceId();
          const present = new Set<string>();
          for (const state of sessions) {
            if (projectId && state.projectId !== projectId) continue;
            const worktreeId = state.worktreeId?.trim();
            if (!worktreeId) continue;
            present.add(worktreeId);
            if (!changed.has(worktreeId)) store.setSession(worktreeId, state);
          }
          for (const worktreeId of Object.keys(store.sessionsByWorktreeId)) {
            if (!present.has(worktreeId) && !changed.has(worktreeId)) {
              store.removeSession(worktreeId);
            }
          }
        },
        () => {
          if (mine === asks.latest) changedDuringResync = null;
        }
      );
    });

    return () => {
      disposed = true;
      offChanges();
      offResync();
    };
  }, []);
}
