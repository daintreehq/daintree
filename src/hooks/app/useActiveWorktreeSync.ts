import { useEffect, useMemo, useRef } from "react";
import { useWorktrees } from "@/hooks";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store";
import { worktreeClient } from "@/clients";

export function useActiveWorktreeSync() {
  const { worktrees } = useWorktrees();
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const selectWorktree = useWorktreeSelectionStore((s) => s.selectWorktree);
  const currentProject = useProjectStore((s) => s.currentProject);

  const lastSyncedActiveRef = useRef<{ projectId: string | null; worktreeId: string | null }>({
    projectId: null,
    worktreeId: null,
  });

  const activeWorktree = useMemo(
    () => worktrees.find((w) => w.id === activeWorktreeId) ?? null,
    [worktrees, activeWorktreeId]
  );

  useEffect(() => {
    if (worktrees.length === 0) return;

    const worktreeExists = activeWorktreeId && worktrees.some((w) => w.id === activeWorktreeId);
    if (!worktreeExists) {
      const mainWorktree = worktrees.find((w) => w.isMainWorktree) ?? worktrees[0];
      selectWorktree(mainWorktree.id);
    }
  }, [worktrees, activeWorktreeId, selectWorktree]);

  useEffect(() => {
    const projectId = currentProject?.id ?? null;
    const selectedWorktreeId = activeWorktreeId ?? null;

    if (!projectId || !selectedWorktreeId) {
      lastSyncedActiveRef.current = { projectId, worktreeId: null };
      return;
    }

    const worktreeExists = worktrees.some((w) => w.id === selectedWorktreeId);
    if (!worktreeExists) {
      return;
    }

    if (
      lastSyncedActiveRef.current.projectId === projectId &&
      lastSyncedActiveRef.current.worktreeId === selectedWorktreeId
    ) {
      return;
    }

    lastSyncedActiveRef.current = { projectId, worktreeId: selectedWorktreeId };
    worktreeClient.setActive(selectedWorktreeId).catch(() => {
      if (
        lastSyncedActiveRef.current.projectId === projectId &&
        lastSyncedActiveRef.current.worktreeId === selectedWorktreeId
      ) {
        lastSyncedActiveRef.current = { projectId, worktreeId: null };
      }
    });
  }, [activeWorktreeId, currentProject?.id, worktrees]);

  const defaultTerminalCwd = useMemo(
    () => activeWorktree?.path ?? currentProject?.path ?? "",
    [activeWorktree, currentProject]
  );

  return { activeWorktree, defaultTerminalCwd };
}
