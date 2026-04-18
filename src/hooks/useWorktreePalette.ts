import { useCallback, useMemo } from "react";
import type { WorktreeState } from "@/types";
import { useWorktreeSelectionStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";
import { scoreWorktree } from "@/lib/worktreeFilters";

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
    const matched = items.filter((worktree) => scoreWorktree(worktree, query) > 0);
    return [...matched].sort((a, b) => {
      const scoreA = scoreWorktree(a, query);
      const scoreB = scoreWorktree(b, query);
      if (scoreA !== scoreB) return scoreB - scoreA;
      return 0;
    });
  }, []);

  const { results, selectedIndex, close, ...paletteRest } = useSearchablePalette<WorktreeState>({
    items: sortedWorktrees,
    filterFn: filterWorktrees,
    maxResults: 20,
    paletteId: "worktree",
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
      handleSelect(results[selectedIndex]!);
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
