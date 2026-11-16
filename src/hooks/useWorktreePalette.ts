import { useCallback, useMemo } from "react";
import type { WorktreeState } from "@/types";
import { useWorktreeSelectionStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";
import { scoreWorktree } from "@/lib/worktreeFilters";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { deferPaletteFocusRestore } from "@/components/ui/paletteFocusRestore";

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
      // Scored once per row: scoring inside the comparator re-ran the match
      // across every field for both sides of each of the sort's n·log n
      // comparisons. The sort is stable, so equal scores keep the incoming
      // active/main/name order.
      const scored: { worktree: WorktreeState; score: number }[] = [];
      for (const worktree of items) {
        const score = scoreWorktree(worktree, query, customTitles[worktree.id]);
        if (score > 0) scored.push({ worktree, score });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.map((entry) => entry.worktree);
    },
    [customTitles]
  );

  const { results, selectedIndex, isStale, close, ...paletteRest } =
    useSearchablePalette<WorktreeState>({
      items: sortedWorktrees,
      filterFn: filterWorktrees,
      maxResults: 20,
      paletteId: "worktree",
      // Opened from the action registry through the store, not through `open()`.
      resetOnStoreOpen: true,
    });

  const handleSelect = useCallback(
    (worktree: WorktreeState) => {
      // The switch focuses the worktree's last panel; the palette's exit-time
      // restore must not hand the keyboard back to the worktree just left.
      deferPaletteFocusRestore((restore) => restore());
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
