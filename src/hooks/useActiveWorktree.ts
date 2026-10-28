import { useMemo } from "react";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import type { PluginWorktreeSnapshot } from "@shared/types/plugin";
import { toPluginWorktreeSnapshot } from "@shared/utils/pluginWorktreeSnapshot";

/**
 * Read-only hook exposing the currently active worktree for plugin panels.
 *
 * Returns a frozen `PluginWorktreeSnapshot` (an allowlisted projection of the
 * internal shape) or `null` when nothing is selected. Plugin panels mount
 * under `WorktreeStoreProvider`, so subscribing via the existing
 * `useWorktreeStore` context is sufficient — no `useSyncExternalStore`
 * gymnastics needed.
 */
export function useActiveWorktree(): PluginWorktreeSnapshot | null {
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const snapshot = useWorktreeStore((state) =>
    activeWorktreeId ? (state.worktrees.get(activeWorktreeId) ?? null) : null
  );
  // Selected on its own so a rename re-projects even though the snapshot didn't change.
  const customTitle = useWorktreeFilterStore((state) =>
    activeWorktreeId ? (state.worktreeCustomTitles[activeWorktreeId] ?? null) : null
  );
  return useMemo(
    () => (snapshot ? toPluginWorktreeSnapshot(snapshot, customTitle) : null),
    [snapshot, customTitle]
  );
}
