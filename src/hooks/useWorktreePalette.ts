import { useCallback, useMemo } from "react";
import type { WorktreeState } from "@/types";
import { useWorktreeSelectionStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";
import { scoreWorktree } from "@/lib/worktreeFilters";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";

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

  const customTitles = useWorktreeFilterStore((state) => state.worktreeCustomTitles);
  const filterWorktrees = useCallback(
    (items: WorktreeState[], query: string): WorktreeState[] => {
      if (!query.trim()) return items;
      const score = (worktree: WorktreeState) =>
        scoreWorktree(worktree, query, customTitles[worktree.id]);
      const matched = items.filter((worktree) => score(worktree) > 0);
      return [...matched].sort((a, b) => {
        const scoreA = score(a);
        const scoreB = score(b);
        if (scoreA !== scoreB) return scoreB - scoreA;
        return 0;
      });
    },
    [customTitles]
  );

  const { results, selectedIndex, isStale, close, ...paletteRest } =
    useSearchablePalette<WorktreeState>({
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
    // Avoid confirming against lagging deferred results during the stale
    // window — the user's repeat Enter will land on the up-to-date row.
    if (isStale) return;
    if (results.length > 0 && selectedIndex >= 0) {
      handleSelect(results[selectedIndex]!);
    } else {
      close();
    }
  }, [isStale, results, selectedIndex, close, handleSelect]);

  return {
    results,
    selectedIndex,
    isStale,
    close,
    ...paletteRest,
    activeWorktreeId,
    selectWorktree: handleSelect,
    confirmSelection,
  };
}
