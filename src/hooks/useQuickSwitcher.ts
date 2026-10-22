import { useCallback, useMemo, useEffect, useState } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store";
import { useWorktrees } from "./useWorktrees";
import { useWorktreeSelectionStore } from "@/store";
import { isPtyPanel, type PanelKind } from "@shared/types/panel";
import { isQuickSwitchablePanel } from "@/utils/quickSwitcher";
import { useSearchablePalette, type FuseResultMatch } from "./useSearchablePalette";
import { usePaletteStore } from "@/store/paletteStore";
import { deferPaletteFocusRestore } from "@/components/ui/paletteFocusRestore";
import { deriveTerminalChrome, type TerminalChromeDescriptor } from "@/utils/terminalChrome";
import { usePluginSearch, type PluginSearchHit, type PluginSearchStatus } from "./usePluginSearch";
import { openPluginSearchHit } from "@/components/QuickSwitcher/openPluginSearchHit";
import { SEARCH_PROVIDER_BLENDED_TOTAL } from "@shared/config/pluginSearchProviders";
import type { PluginSearchProviderInfo } from "@shared/types/plugin";

export type QuickSwitcherItemType = "terminal" | "worktree" | "plugin";

export interface QuickSwitcherItem {
  id: string;
  type: QuickSwitcherItemType;
  title: string;
  subtitle?: string;
  terminalKind?: PanelKind;
  chrome?: TerminalChromeDescriptor;
  worktreeId?: string;
  /** A plugin search provider's result (#13792): what it opens and who it came from. */
  pluginHit?: PluginSearchHit;
}

export interface UseQuickSwitcherReturn {
  isOpen: boolean;
  query: string;
  results: QuickSwitcherItem[];
  totalResults: number;
  selectedIndex: number;
  /** Match ranges per row id for the current query, for row emphasis. */
  matchesById: ReadonlyMap<string, readonly FuseResultMatch[]>;
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
  /** The plugin search provider the switcher is scoped to (#13792), if any. */
  scopedProvider: PluginSearchProviderInfo | null;
  /** The provider whose keyword the unscoped query spells exactly — Tab scopes to it. */
  keywordProvider: PluginSearchProviderInfo | null;
  /** How the scoped provider's last answer for this query went. */
  scopedStatus: PluginSearchStatus;
  enterScope: (providerKey: string) => void;
  exitScope: () => void;
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

/**
 * The ranking index's options plus match ranges. Kept on a second index so
 * ranking itself pays nothing for them, and with a two-character floor so a
 * fuzzy hit doesn't sprinkle single-letter bands across a row.
 */
const FUSE_MATCH_OPTIONS: IFuseOptions<QuickSwitcherItem> = {
  ...FUSE_OPTIONS,
  includeMatches: true,
  minMatchCharLength: 2,
};

const EMPTY_MATCHES: ReadonlyMap<string, readonly FuseResultMatch[]> = new Map();

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

  // Plugin search providers (#13792). The scope is the provider the user
  // picked by keyword + Tab; it only counts while that provider is still in
  // the catalog, so a provider switched off or unloaded drops the scope too.
  const pluginSearch = usePluginSearch(paletteIsOpen);
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const scopedProvider = scopeKey
    ? (pluginSearch.providers.find((provider) => provider.key === scopeKey) ?? null)
    : null;
  const activeScopeKey = scopedProvider?.key ?? null;

  useEffect(() => {
    if (!paletteIsOpen && scopeKey !== null) setScopeKey(null);
  }, [paletteIsOpen, scopeKey]);

  const builtinItems = useMemo<QuickSwitcherItem[]>(() => {
    const result: QuickSwitcherItem[] = [];

    // Every open panel, PTY or not, keyed `terminal:` so persisted MRU
    // entries and the prune guard below keep working unchanged.
    for (const id of panelIds) {
      const t = panelsById[id];
      if (!t || !isQuickSwitchablePanel(t)) continue;
      const worktreeName = t.worktreeId ? worktreeMap.get(t.worktreeId)?.name : undefined;
      const isBackground = t.location === "background";
      const baseSubtitle = worktreeName ?? (isPtyPanel(t) ? t.cwd : undefined);
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

  const { state: pluginState } = pluginSearch;
  const pluginItems = useMemo<QuickSwitcherItem[]>(() => {
    const hits =
      pluginState.scopeKey === null
        ? pluginState.hits.slice(0, SEARCH_PROVIDER_BLENDED_TOTAL)
        : pluginState.hits;
    return hits.map((hit) => ({
      id: hit.id,
      type: "plugin",
      title: hit.row.label,
      subtitle: hit.row.description,
      pluginHit: hit,
    }));
  }, [pluginState]);

  // Scoped, the list is the provider's alone. Unscoped, its blended rows sit
  // below the built-in ones, which never wait on them.
  const items = useMemo<QuickSwitcherItem[]>(
    () => (activeScopeKey !== null ? pluginItems : [...builtinItems, ...pluginItems]),
    [activeScopeKey, builtinItems, pluginItems]
  );

  // Prune stale MRU entries when item set or MRU list changes (e.g. after hydration).
  // Panels and worktrees populate asynchronously during hydration, so a category
  // can be momentarily empty while the other has loaded. Pruning a category before
  // it has hydrated would gut the restored MRU order before it can be used — so only
  // prune a category (terminal:/worktree:) once at least one of its items exists,
  // protecting the not-yet-loaded category's entries in the meantime (#9922).
  useEffect(() => {
    if (mruList.length === 0) return;
    if (builtinItems.length === 0) return;
    const hasTerminalItems = builtinItems.some((item) => item.type === "terminal");
    const hasWorktreeItems = builtinItems.some((item) => item.type === "worktree");
    const validIds = new Set(builtinItems.map((item) => item.id));
    for (const id of mruList) {
      if (!hasTerminalItems && id.startsWith("terminal:")) validIds.add(id);
      if (!hasWorktreeItems && id.startsWith("worktree:")) validIds.add(id);
    }
    pruneMru(validIds);
  }, [builtinItems, mruList, pruneMru]);

  const fuse = useMemo(() => new Fuse(builtinItems, FUSE_OPTIONS), [builtinItems]);

  const filterFn = useCallback(
    (_allItems: QuickSwitcherItem[], query: string): QuickSwitcherItem[] => {
      // Plugin rows answer one (scope, query); for any other they are stale,
      // and left out in the same render the input changed, so neither Enter
      // nor a click can open a row from the previous query.
      const live =
        pluginState.scopeKey === activeScopeKey && pluginState.query === query ? pluginItems : [];
      if (activeScopeKey !== null) return live;

      const mruIndexMap = new Map<string, number>();
      mruList.forEach((id, index) => mruIndexMap.set(id, index));
      const mruSize = mruList.length;

      if (!query.trim()) {
        // Empty query: return items in MRU order (MRU items first, then others)
        return [...builtinItems].sort((a, b) => {
          const aIndex = mruIndexMap.get(a.id) ?? Infinity;
          const bIndex = mruIndexMap.get(b.id) ?? Infinity;
          return aIndex - bIndex;
        });
      }

      // Non-empty query: Fuse search with MRU boost (lower score = better match)
      const fuseResults = fuse.search(query);
      const ranked = fuseResults
        .map((r) => {
          const rank = mruIndexMap.get(r.item.id);
          const boost =
            rank !== undefined ? (1 - rank / Math.max(mruSize, 1)) * MRU_BOOST_FACTOR : 0;
          return { item: r.item, boostedScore: (r.score ?? 1) - boost };
        })
        .sort((a, b) => a.boostedScore - b.boostedScore)
        .map((r) => r.item);
      // Blended rows go after the built-in budget, in arrival order, so one
      // landing late never moves a row already on screen.
      if (live.length === 0) return ranked;
      return [...ranked.slice(0, MAX_RESULTS), ...live, ...ranked.slice(MAX_RESULTS)];
    },
    [fuse, mruList, builtinItems, pluginItems, pluginState, activeScopeKey]
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
    maxResults: MAX_RESULTS + pluginItems.length,
    paletteId: "quick-switcher",
  });

  const { request: requestPluginSearch, providers: pluginProviders } = pluginSearch;
  useEffect(() => {
    requestPluginSearch(paletteIsOpen, activeScopeKey, query, pluginProviders);
  }, [requestPluginSearch, paletteIsOpen, activeScopeKey, query, pluginProviders]);

  // Scoped and not yet answered for this exact query (debouncing or in
  // flight) reads as loading, so the empty state never flashes between keys.
  const scopedStatus: PluginSearchStatus =
    activeScopeKey === null
      ? "idle"
      : pluginState.scopeKey === activeScopeKey && pluginState.query === query
        ? pluginState.status
        : "loading";

  const keywordProvider = useMemo(() => {
    if (activeScopeKey !== null) return null;
    const typed = query.trim().toLowerCase();
    if (typed.length === 0) return null;
    return pluginProviders.find((provider) => provider.keyword === typed) ?? null;
  }, [activeScopeKey, query, pluginProviders]);

  const enterScope = useCallback(
    (providerKey: string) => {
      setScopeKey(providerKey);
      setQuery("");
    },
    [setQuery]
  );
  const exitScope = useCallback(() => setScopeKey(null), []);

  const matchFuse = useMemo(() => new Fuse(builtinItems, FUSE_MATCH_OPTIONS), [builtinItems]);
  const matchesById = useMemo(() => {
    if (!query.trim()) return EMPTY_MATCHES;
    const byId = new Map<string, readonly FuseResultMatch[]>();
    for (const r of matchFuse.search(query)) {
      if (r.matches) byId.set(r.item.id, r.matches);
    }
    return byId;
  }, [matchFuse, query]);

  const restoreBackgroundTerminal = usePanelStore((state) => state.restoreBackgroundTerminal);
  const activateTerminal = usePanelStore((state) => state.activateTerminal);

  const selectItem = useCallback(
    (item: QuickSwitcherItem) => {
      // A plugin row opens only while it still answers what the field says:
      // with deferred filtering the list can trail the input by a render, and
      // Enter in that gap would open the previous query's result.
      const hit = item.pluginHit;
      if (
        hit &&
        !(
          pluginState.scopeKey === activeScopeKey &&
          pluginState.query === query &&
          pluginState.hits.some((candidate) => candidate.id === hit.id)
        )
      ) {
        return;
      }
      // The palette refocuses its opener after the exit animation, which would
      // pull the keyboard straight off the pick. Restore only if nothing took
      // it — re-picking the focused panel moves no focus at all.
      deferPaletteFocusRestore((restore) => restore());
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
        }
        // Activate rather than focus: a panel behind a fullscreen neighbour
        // would otherwise land focused but hidden.
        activateTerminal(terminalId);
      } else if (item.type === "worktree") {
        const worktreeId = item.id.replace("worktree:", "");
        selectWorktree(worktreeId);
      } else if (hit) {
        openPluginSearchHit(hit);
      }
      close();
    },
    [
      selectWorktree,
      close,
      restoreBackgroundTerminal,
      activateTerminal,
      pluginState,
      activeScopeKey,
      query,
    ]
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
    matchesById,
    isLoading:
      (activeScopeKey === null && !worktreesInitialized && worktreeError === null) ||
      scopedStatus === "loading",
    open,
    close,
    toggle,
    setQuery,
    setSelectedIndex,
    selectPrevious,
    selectNext,
    selectItem,
    confirmSelection,
    scopedProvider,
    keywordProvider,
    scopedStatus,
    enterScope,
    exitScope,
  };
}
