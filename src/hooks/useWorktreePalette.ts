import { useCallback, useMemo } from "react";
import type { WorktreeState } from "@/types";
import { useWorktreeSelectionStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";

export type UseWorktreePaletteReturn = UseSearchablePaletteReturn<WorktreeState> & {
  activeWorktreeId: string | null;
  selectWorktree: (worktree: WorktreeState) => void;
  confirmSelection: () => void;
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

  const { results, selectedIndex, close, ...paletteRest } = useSearchablePalette<WorktreeState>({
    items: sortedWorktrees,
    filterFn: filterWorktrees,
    maxResults: 20,
  });

  const handleSelect = useCallback(
    (worktree: WorktreeState) => {
      selectWorktree(worktree.id);
      close();
    },
    [selectWorktree, close]
  );

  const confirmSelection = useCallback(() => {
    if (results.length > 0 && selectedIndex >= 0) {
      handleSelect(results[selectedIndex]);
    } else {
      close();
    }
  }, [results, selectedIndex, close, handleSelect]);

  return {
    results,
    selectedIndex,
    close,
    ...paletteRest,
    activeWorktreeId,
    selectWorktree: handleSelect,
    confirmSelection,
  };
}
