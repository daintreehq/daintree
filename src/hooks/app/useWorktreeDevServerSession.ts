import { useEffect } from "react";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import { useWorktreeDevServerStore } from "@/store/worktreeDevServerStore";

/**
 * Reactive read of a worktree's latest dev-server session plus one-shot lazy
 * hydration. `DEV_PREVIEW_STATE_CHANGED` only fires on *changes*, so a server
 * that was already running before the dashboard mounted would never reach the
 * store via the broadcast alone — this primes the entry once via
 * `getByWorktree` when the cache has no record for the worktree yet.
 *
 * No cross-row dedup guard: the effect runs once per mount, the store-entry
 * check short-circuits once data exists, and `getByWorktree` is a cheap
 * in-memory lookup on the main side. The freshness guard in the store makes
 * concurrent writes idempotent, so a worktree shown in two places (sidebar +
 * overview modal) at most fires the lookup twice — simpler and race-free.
 */
export function useWorktreeDevServerSession(
  worktreeId: string
): DevPreviewSessionState | undefined {
  const session = useWorktreeDevServerStore((s) => s.sessionsByWorktreeId[worktreeId]);

  useEffect(() => {
    if (useWorktreeDevServerStore.getState().sessionsByWorktreeId[worktreeId] !== undefined) {
      return;
    }
    let disposed = false;
    window.electron.devPreview
      .getByWorktree({ worktreeId })
      .then((result) => {
        if (disposed || !result) return;
        useWorktreeDevServerStore.getState().setSession(worktreeId, result);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [worktreeId]);

  return session;
}
