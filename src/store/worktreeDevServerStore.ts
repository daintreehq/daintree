import { create } from "zustand";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";

/**
 * Runtime-ephemeral cache of the latest dev-server session per worktree, keyed
 * by `worktreeId`. Populated by a single app-level `DEV_PREVIEW_STATE_CHANGED`
 * subscription (`useWorktreeDevServerStateSync`) plus per-row lazy hydration
 * (`useWorktreeDevServerSession`). Not persisted — dev-server state is process
 * state that does not survive an app restart.
 *
 * Sessions in any status (including `stopped`/`restored-stopped`) are retained
 * so the `updatedAt` freshness guard can reject stale writes; read sites decide
 * which statuses are "live" (see `isLiveDevServerStatus` in `worktreeFilters`).
 */
interface WorktreeDevServerState {
  sessionsByWorktreeId: Record<string, DevPreviewSessionState>;
  setSession: (worktreeId: string, session: DevPreviewSessionState) => void;
  removeSession: (worktreeId: string) => void;
  reset: () => void;
}

export const useWorktreeDevServerStore = create<WorktreeDevServerState>((set) => ({
  sessionsByWorktreeId: {},
  setSession: (worktreeId, session) =>
    set((state) => {
      const existing = state.sessionsByWorktreeId[worktreeId];
      // Freshness guard: a lazy `getByWorktree` hydration can resolve after a
      // newer live broadcast already landed. Drop only strictly-older writes so
      // the row never regresses to a stale snapshot. Equal timestamps apply
      // (last-write-wins): two distinct transitions emitted in the same
      // millisecond — e.g. a synchronous spawn failure flipping starting→error —
      // must not silently lose the latter.
      if (existing && session.updatedAt < existing.updatedAt) return state;
      return {
        sessionsByWorktreeId: { ...state.sessionsByWorktreeId, [worktreeId]: session },
      };
    }),
  removeSession: (worktreeId) =>
    set((state) => {
      if (!(worktreeId in state.sessionsByWorktreeId)) return state;
      const next = { ...state.sessionsByWorktreeId };
      delete next[worktreeId];
      return { sessionsByWorktreeId: next };
    }),
  reset: () => set({ sessionsByWorktreeId: {} }),
}));
