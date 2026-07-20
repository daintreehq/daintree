import { useEffect, useMemo, useRef } from "react";
import { useWorktrees } from "@/hooks";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store";
import { useScratchStore } from "@/store/scratchStore";
import { useHomeDir } from "@/hooks/app/useHomeDir";
import { resolveWorkspaceCwd } from "@/utils/workspaceCwd";

export function useActiveWorktreeSync() {
  const { worktrees, isInitialized } = useWorktrees();
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const selectWorktree = useWorktreeSelectionStore((s) => s.selectWorktree);
  const deletedWorktrees = useWorktreeSelectionStore((s) => s.deletedWorktrees);
  const currentProject = useProjectStore((s) => s.currentProject);
  const currentScratch = useScratchStore((s) => s.currentScratch);
  const { homeDir } = useHomeDir();

  const lastSyncedActiveRef = useRef<{ projectId: string | null; worktreeId: string | null }>({
    projectId: null,
    worktreeId: null,
  });

  const activeWorktree = useMemo(
    () => worktrees.find((w) => w.id === activeWorktreeId) ?? null,
    [worktrees, activeWorktreeId]
  );

  useEffect(() => {
    if (!isInitialized || worktrees.length === 0) return;

    // A deleted-worktree row (directory gone, terminals surviving) is a valid
    // active selection — the user clicked it to view its terminals. Only snap
    // back to main once the id is neither live nor a deleted row (e.g. its
    // last terminal closed and the row was pruned).
    const worktreeExists =
      activeWorktreeId &&
      (worktrees.some((w) => w.id === activeWorktreeId) || deletedWorktrees.has(activeWorktreeId));
    if (!worktreeExists) {
      const mainWorktree = worktrees.find((w) => w.isMainWorktree) ?? worktrees[0]!;
      selectWorktree(mainWorktree.id);
    }
  }, [worktrees, activeWorktreeId, isInitialized, selectWorktree, deletedWorktrees]);

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
    window.electron.worktreePort
      .request("set-active", { worktreeId: selectedWorktreeId })
      .catch(() => {
        if (
          lastSyncedActiveRef.current.projectId === projectId &&
          lastSyncedActiveRef.current.worktreeId === selectedWorktreeId
        ) {
          lastSyncedActiveRef.current = { projectId, worktreeId: null };
        }
      });
  }, [activeWorktreeId, currentProject?.id, worktrees]);

  // Before the snapshot is authoritative the worktree is withheld from the
  // chain — a stale selection would spawn terminals in the wrong tree.
  const defaultTerminalCwd = useMemo(
    () =>
      resolveWorkspaceCwd({
        worktreePath: isInitialized ? activeWorktree?.path : null,
        projectPath: currentProject?.path,
        scratchPath: currentScratch?.path,
        homeDir,
      }),
    [activeWorktree, currentProject, currentScratch, homeDir, isInitialized]
  );

  return { activeWorktree, defaultTerminalCwd };
}
