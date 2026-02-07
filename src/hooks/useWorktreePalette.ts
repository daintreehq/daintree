import { useCallback, useMemo, useRef } from "react";
import type { WorktreeState } from "@/types";
import { useWorktreeSelectionStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";

export type UseWorktreePaletteReturn = UseSearchablePaletteReturn<WorktreeState> & {
  activeWorktreeId: string | null;
  selectWorktree: (worktree: WorktreeState) => void;
};

interface UseWorktreePaletteProps {
  worktrees: WorktreeState[];
}

export function useWorktreePalette({
  worktrees,
}: UseWorktreePaletteProps): UseWorktreePaletteReturn {
  const { selectWorktree, activeWorktreeId } = useWorktreeSelectionStore(
    useShallow((state) => ({
      selectWorktree: state.selectWorktree,
      activeWorktreeId: state.activeWorktreeId,
    }))
  );

  const sortedWorktrees = useMemo(() => {
    return [...worktrees].sort((a, b) => {
      if (a.id === activeWorktreeId) return -1;
      if (b.id === activeWorktreeId) return 1;
      if (a.isMainWorktree && !b.isMainWorktree) return -1;
      if (!a.isMainWorktree && b.isMainWorktree) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [worktrees, activeWorktreeId]);

  const closeFnRef = useRef<() => void>(() => {});

  const handleSelect = useCallback(
    (worktree: WorktreeState) => {
      selectWorktree(worktree.id);
      closeFnRef.current();
    },
    [selectWorktree]
  );

  const filterWorktrees = useCallback((items: WorktreeState[], query: string): WorktreeState[] => {
    if (!query.trim()) return items;
    const search = query.trim().toLowerCase();
    return items.filter((worktree) => {
      const branch = worktree.branch ?? "";
      const issueTitle = worktree.issueTitle ?? "";
      const prTitle = worktree.prTitle ?? "";
      return (
        worktree.name.toLowerCase().includes(search) ||
        branch.toLowerCase().includes(search) ||
        worktree.path.toLowerCase().includes(search) ||
        issueTitle.toLowerCase().includes(search) ||
        prTitle.toLowerCase().includes(search)
      );
    });
  }, []);

  const palette = useSearchablePalette<WorktreeState>({
    items: sortedWorktrees,
    filterFn: filterWorktrees,
    maxResults: 20,
    onSelect: handleSelect,
  });

  closeFnRef.current = palette.close;

  return {
    ...palette,
    activeWorktreeId,
    selectWorktree: handleSelect,
  };
}
