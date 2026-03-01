import { useCallback, useMemo, useEffect } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore, type TerminalInstance } from "@/store";
import { useWorktrees } from "./useWorktrees";
import { useWorktreeSelectionStore } from "@/store";
import { isPtyPanel } from "@shared/types/domain";
import { useSearchablePalette } from "./useSearchablePalette";

export type QuickSwitcherItemType = "terminal" | "worktree";

export interface QuickSwitcherItem {
  id: string;
  type: QuickSwitcherItemType;
  title: string;
  subtitle?: string;
  terminalType?: TerminalInstance["type"];
  terminalKind?: TerminalInstance["kind"];
  agentId?: TerminalInstance["agentId"];
  detectedProcessId?: TerminalInstance["detectedProcessId"];
  worktreeId?: string;
}

export interface UseQuickSwitcherReturn {
  isOpen: boolean;
  query: string;
  results: QuickSwitcherItem[];
  selectedIndex: number;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setQuery: (query: string) => void;
  selectPrevious: () => void;
  selectNext: () => void;
  selectItem: (item: QuickSwitcherItem) => void;
  confirmSelection: () => void;
}

const FUSE_OPTIONS: IFuseOptions<QuickSwitcherItem> = {
  keys: [
    { name: "title", weight: 2 },
    { name: "subtitle", weight: 1 },
    { name: "type", weight: 0.5 },
  ],
  threshold: 0.4,
  includeScore: true,
};

const MAX_RESULTS = 20;
const DEBOUNCE_MS = 150;
const MRU_BOOST_FACTOR = 0.05;

export function useQuickSwitcher(): UseQuickSwitcherReturn {
  const terminals = useTerminalStore(useShallow((state) => state.terminals));
  const setFocused = useTerminalStore((state) => state.setFocused);
  const mruList = useTerminalStore(useShallow((state) => state.mruList));
  const pruneMru = useTerminalStore((state) => state.pruneMru);

  const { worktrees, worktreeMap } = useWorktrees();
  const { selectWorktree } = useWorktreeSelectionStore(
    useShallow((state) => ({
      selectWorktree: state.selectWorktree,
    }))
  );

  const items = useMemo<QuickSwitcherItem[]>(() => {
    const result: QuickSwitcherItem[] = [];

    // Add terminals
    for (const t of terminals) {
      if (t.location === "trash") continue;
      if (t.hasPty === false) continue;
      if (!isPtyPanel(t)) continue;
      const worktreeName = t.worktreeId ? worktreeMap.get(t.worktreeId)?.name : undefined;
      result.push({
        id: `terminal:${t.id}`,
        type: "terminal",
        title: t.title,
        subtitle: worktreeName ?? t.cwd ?? undefined,
        terminalType: t.type,
        terminalKind: t.kind,
        agentId: t.agentId,
        detectedProcessId: t.detectedProcessId,
        worktreeId: t.worktreeId,
      });
    }

    // Add worktrees
    for (const w of worktrees) {
      result.push({
        id: `worktree:${w.id}`,
        type: "worktree",
        title: w.name ?? w.branch ?? "Worktree",
        subtitle: w.path,
      });
    }

    return result;
  }, [terminals, worktrees, worktreeMap]);

  // Prune stale MRU entries when item set or MRU list changes (e.g. after hydration)
  useEffect(() => {
    if (mruList.length === 0) return;
    const validIds = new Set(items.map((item) => item.id));
    pruneMru(validIds);
  }, [items, mruList, pruneMru]);

  const fuse = useMemo(() => new Fuse(items, FUSE_OPTIONS), [items]);

  const filterFn = useCallback(
    (allItems: QuickSwitcherItem[], query: string): QuickSwitcherItem[] => {
      const mruIndexMap = new Map<string, number>();
      mruList.forEach((id, index) => mruIndexMap.set(id, index));
      const mruSize = mruList.length;

      if (!query.trim()) {
        // Empty query: return items in MRU order (MRU items first, then others)
        return [...allItems].sort((a, b) => {
          const aIndex = mruIndexMap.get(a.id) ?? Infinity;
          const bIndex = mruIndexMap.get(b.id) ?? Infinity;
          return aIndex - bIndex;
        });
      }

      // Non-empty query: Fuse search with MRU boost (lower score = better match)
      const fuseResults = fuse.search(query);
      return fuseResults
        .map((r) => {
          const rank = mruIndexMap.get(r.item.id);
          const boost =
            rank !== undefined ? (1 - rank / Math.max(mruSize, 1)) * MRU_BOOST_FACTOR : 0;
          return { item: r.item, boostedScore: (r.score ?? 1) - boost };
        })
        .sort((a, b) => a.boostedScore - b.boostedScore)
        .map((r) => r.item);
    },
    [fuse, mruList]
  );

  const {
    isOpen,
    query,
    results,
    selectedIndex,
    open,
    close,
    toggle,
    setQuery,
    selectPrevious,
    selectNext,
  } = useSearchablePalette<QuickSwitcherItem>({
    items,
    filterFn,
    maxResults: MAX_RESULTS,
    debounceMs: DEBOUNCE_MS,
  });

  const selectItem = useCallback(
    (item: QuickSwitcherItem) => {
      if (item.type === "terminal") {
        const terminalId = item.id.replace("terminal:", "");
        if (
          item.worktreeId &&
          item.worktreeId !== useWorktreeSelectionStore.getState().activeWorktreeId
        ) {
          selectWorktree(item.worktreeId);
        }
        setFocused(terminalId);
      } else if (item.type === "worktree") {
        const worktreeId = item.id.replace("worktree:", "");
        selectWorktree(worktreeId);
      }
      close();
    },
    [setFocused, selectWorktree, close]
  );

  const confirmSelection = useCallback(() => {
    if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
      selectItem(results[selectedIndex]);
    }
  }, [results, selectedIndex, selectItem]);

  return {
    isOpen,
    query,
    results,
    selectedIndex,
    open,
    close,
    toggle,
    setQuery,
    selectPrevious,
    selectNext,
    selectItem,
    confirmSelection,
  };
}
