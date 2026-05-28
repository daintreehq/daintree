import { useEffect } from "react";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import { useWorktreeDevServerStore } from "@/store/worktreeDevServerStore";

// Dedup guard shared across all rows: `getByWorktree` is a cheap in-memory
// lookup on the main side, but a worktree can mount in the sidebar and the grid
// simultaneously — without this set both rows would fire the same hydration.
const inFlightHydrations = new Set<string>();

/**
 * Reactive read of a worktree's latest dev-server session plus one-shot lazy
 * hydration. `DEV_PREVIEW_STATE_CHANGED` only fires on *changes*, so a server
 * that was already running before the dashboard mounted would never reach the
 * store via the broadcast alone — this primes the entry once via
 * `getByWorktree` when the cache has no record for the worktree yet.
 */
export function useWorktreeDevServerSession(
  worktreeId: string
): DevPreviewSessionState | undefined {
  const session = useWorktreeDevServerStore((s) => s.sessionsByWorktreeId[worktreeId]);

  useEffect(() => {
    if (useWorktreeDevServerStore.getState().sessionsByWorktreeId[worktreeId] !== undefined) {
      return;
    }
    if (inFlightHydrations.has(worktreeId)) return;
    inFlightHydrations.add(worktreeId);
    let disposed = false;
    window.electron.devPreview
      .getByWorktree({ worktreeId })
      .then((result) => {
        if (disposed || !result) return;
        useWorktreeDevServerStore.getState().setSession(worktreeId, result);
      })
      .catch(() => {})
      .finally(() => {
        inFlightHydrations.delete(worktreeId);
      });
    return () => {
      disposed = true;
    };
  }, [worktreeId]);

  return session;
}
