import { useCallback } from "react";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import { getWorktreePathIndex } from "@/store/storeAccessors";
import type { InspectorContext } from "./inspectorController.js";

/**
 * The worktree this inspector panel is showing, read reactively so a worktree
 * rename or move reaches the source workspace without reopening the panel.
 */
export function useInspectorContext(panelId: string): InspectorContext {
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const worktreeId = usePanelStore((state) => state.panelsById[panelId]?.worktreeId ?? null);
  const storePath = useWorktreeStoreOptional(
    useCallback(
      (state) => (worktreeId ? (state.worktrees.get(worktreeId)?.path ?? null) : null),
      [worktreeId]
    ),
    null
  );
  // A plugin view is not guaranteed to sit under the worktree store provider;
  // the accessor index is the same data, just not reactive.
  const worktreePath =
    storePath ?? (worktreeId ? (getWorktreePathIndex()?.get(worktreeId) ?? null) : null);
  return { projectId, worktreeId, worktreePath };
}
