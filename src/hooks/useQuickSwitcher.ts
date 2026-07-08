import { useCallback, useMemo, useEffect } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store";
import { useWorktrees } from "./useWorktrees";
import { useWorktreeSelectionStore } from "@/store";
import { isPtyPanel, type PanelKind } from "@shared/types/panel";
import { useSearchablePalette } from "./useSearchablePalette";
import { usePaletteStore } from "@/store/paletteStore";
import { deriveTerminalChrome, type TerminalChromeDescriptor } from "@/utils/terminalChrome";

export type QuickSwitcherItemType = "terminal" | "worktree";

export interface QuickSwitcherItem {
  id: string;
  type: QuickSwitcherItemType;
  title: string;
  subtitle?: string;
  terminalKind?: PanelKind;
  chrome?: TerminalChromeDescriptor;
  worktreeId?: string;
}

export interface UseQuickSwitcherReturn {
  isOpen: boolean;
  query: string;
  results: QuickSwitcherItem[];
  totalResults: number;
  selectedIndex: number;
  isLoading: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setQuery: (query: string) => void;
  setSelectedIndex: (index: number) => void;
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
const MRU_BOOST_FACTOR = 0.05;

const EMPTY_PANEL_IDS: string[] = [];
const EMPTY_PANELS_BY_ID: ReturnType<typeof usePanelStore.getState>["panelsById"] = {};
const EMPTY_MRU: string[] = [];

export function useQuickSwitcher(): UseQuickSwitcherReturn {
  // Always mounted in App: subscribe to the panel/worktree data only while the
  // palette is open, else every agent-state flip and status flush re-rendered
  // the whole App through this hook. Stable empty sentinels keep the memos
  // below inert while closed; opening flips the selectors live in the same
  // render, so the palette never shows stale items.
  const paletteIsOpen = usePaletteStore((state) => state.activePaletteId === "quick-switcher");
  const panelIds = usePanelStore((state) => (paletteIsOpen ? state.panelIds : EMPTY_PANEL_IDS));
  const panelsById = usePanelStore((state) =>
    paletteIsOpen ? state.panelsById : EMPTY_PANELS_BY_ID
  );
  const setFocused = usePanelStore((state) => state.setFocused);
  const mruList = usePanelStore((state) => (paletteIsOpen ? state.mruList : EMPTY_MRU));
  const pruneMru = usePanelStore((state) => state.pruneMru);

  const {
    worktrees,
    worktreeMap,
    isInitialized: worktreesInitialized,
    error: worktreeError,
  } = useWorktrees({ enabled: paletteIsOpen });
  const { selectWorktree } = useWorktreeSelectionStore(
    useShallow((state) => ({
      selectWorktree: state.selectWorktree,
    }))
  );

  const items = useMemo<QuickSwitcherItem[]>(() => {
    const result: QuickSwitcherItem[] = [];

    // Add terminals
    for (const id of panelIds) {
      const t = panelsById[id];
      if (!t) continue;
      if (t.location === "trash") continue;
      if (!isPtyPanel(t)) continue;
      if (t.excludeFromPersistence === true) continue;
      if (t.hasPty === false) continue;
      const worktreeName = t.worktreeId ? worktreeMap.get(t.worktreeId)?.name : undefined;
      const isBackground = t.location === "background";
      const baseSubtitle = worktreeName ?? t.cwd ?? undefined;
      result.push({
        id: `terminal:${t.id}`,
        type: "terminal",
        title: t.title,
        subtitle: isBackground
          ? baseSubtitle
            ? `${baseSubtitle} · Backgrounded`
            : "Backgrounded"
          : baseSubtitle,
        terminalKind: t.kind,
        chrome: deriveTerminalChrome(t),
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
  }, [panelIds, panelsById, worktrees, worktreeMap]);

  // Prune stale MRU entries when item set or MRU list changes (e.g. after hydration).
  // Panels and worktrees populate asynchronously during hydration, so a category
  // can be momentarily empty while the other has loaded. Pruning a category before
  // it has hydrated would gut the restored MRU order before it can be used — so only
  // prune a category (terminal:/worktree:) once at least one of its items exists,
  // protecting the not-yet-loaded category's entries in the meantime (#9922).
  useEffect(() => {
    if (mruList.length === 0) return;
    if (items.length === 0) return;
    const hasTerminalItems = items.some((item) => item.type === "terminal");
    const hasWorktreeItems = items.some((item) => item.type === "worktree");
    const validIds = new Set(items.map((item) => item.id));
    for (const id of mruList) {
      if (!hasTerminalItems && id.startsWith("terminal:")) validIds.add(id);
      if (!hasWorktreeItems && id.startsWith("worktree:")) validIds.add(id);
    }
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
    totalResults,
    selectedIndex,
    open,
    close,
    toggle,
    setQuery,
    setSelectedIndex,
    selectPrevious,
    selectNext,
  } = useSearchablePalette<QuickSwitcherItem>({
    items,
    filterFn,
    maxResults: MAX_RESULTS,
    paletteId: "quick-switcher",
  });

  const restoreBackgroundTerminal = usePanelStore((state) => state.restoreBackgroundTerminal);
  const activateTerminal = usePanelStore((state) => state.activateTerminal);

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
        // Restore backgrounded panels before focusing
        const terminal = usePanelStore.getState().panelsById[terminalId];
        if (terminal?.location === "background") {
          restoreBackgroundTerminal(terminalId);
          activateTerminal(terminalId);
        } else {
          setFocused(terminalId);
        }
      } else if (item.type === "worktree") {
        const worktreeId = item.id.replace("worktree:", "");
        selectWorktree(worktreeId);
      }
      close();
    },
    [setFocused, selectWorktree, close, restoreBackgroundTerminal, activateTerminal]
  );

  const confirmSelection = useCallback(() => {
    if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
      selectItem(results[selectedIndex]!);
    }
  }, [results, selectedIndex, selectItem]);

  return {
    isOpen,
    query,
    results,
    totalResults,
    selectedIndex,
    isLoading: !worktreesInitialized && worktreeError === null,
    open,
    close,
    toggle,
    setQuery,
    setSelectedIndex,
    selectPrevious,
    selectNext,
    selectItem,
    confirmSelection,
  };
}
