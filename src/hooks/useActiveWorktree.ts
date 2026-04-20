import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { WorktreeSnapshot } from "@shared/types";

/**
 * Read-only hook exposing the currently active worktree for plugin panels.
 *
 * Returns the active `WorktreeSnapshot` or `null` when nothing is selected.
 * Plugin panels mount under `WorktreeStoreProvider`, so subscribing via the
 * existing `useWorktreeStore` context is sufficient — no `useSyncExternalStore`
 * gymnastics needed.
 */
export function useActiveWorktree(): WorktreeSnapshot | null {
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  return useWorktreeStore((state) =>
    activeWorktreeId ? (state.worktrees.get(activeWorktreeId) ?? null) : null
  );
}
