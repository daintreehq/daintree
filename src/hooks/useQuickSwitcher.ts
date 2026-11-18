import { useCallback, useMemo, useEffect, useRef } from "react";
import type { IFuseOptions } from "fuse.js";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store";
import { useWorktrees } from "./useWorktrees";
import { useWorktreeSelectionStore } from "@/store";
import { isPtyPanel, type PanelKind } from "@shared/types/panel";
import type { AgentState } from "@shared/types/agent";
import { isQuickSwitchablePanel } from "@/utils/quickSwitcher";
import {
  useSearchablePalette,
  type FuseResultMatch,
  type PaletteSearchResult,
} from "./useSearchablePalette";
import { createFuseSearch } from "@/lib/fuseIndex";
import { usePaletteStore } from "@/store/paletteStore";
import { deferPaletteFocusRestore } from "@/components/ui/paletteFocusRestore";
import { deriveTerminalChrome, type TerminalChromeDescriptor } from "@/utils/terminalChrome";
import { usePluginSearch, type PluginSearchHit, type PluginSearchStatus } from "./usePluginSearch";
import { openPluginSearchHit } from "@/components/QuickSwitcher/openPluginSearchHit";
import { openQuickSwitcherFile } from "@/components/QuickSwitcher/openQuickSwitcherFile";
import {
  FILE_SEARCH_KEYWORD,
  SEARCH_PROVIDER_BLENDED_TOTAL,
} from "@shared/config/pluginSearchProviders";
import type { FileChangeDetail } from "@shared/types/git";
import { isAbsolute, isPathInside, join, toWorktreeRelative } from "@shared/utils/path";
import { FILE_RESULT_CAP, useQuickSwitcherFileSearch } from "./useQuickSwitcherFileSearch";
import { withDisplayEmoji } from "@shared/utils/displayIdentity";
import type { PluginSearchProviderInfo } from "@shared/types/plugin";
import { getWorktreeBranchLabel, getWorktreeQualifier } from "@/lib/worktreeHeadline";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";

export type QuickSwitcherItemType = "terminal" | "worktree" | "plugin" | "file";

/** A file row of the switcher's file scope (#17329). */
export interface QuickSwitcherFile {
  /** The worktree root it was found under, as the worktree reports it. */
  rootPath: string;
  /** Forward-slash path below the root; the row's title is its last segment. */
  relativePath: string;
  absolutePath: string;
  /** Listed because the worktree's changes name it, not because a search did. */
  changed: boolean;
}

export interface QuickSwitcherItem {
  id: string;
  type: QuickSwitcherItemType;
  title: string;
  subtitle?: string;
  terminalKind?: PanelKind;
  chrome?: TerminalChromeDescriptor;
  worktreeId?: string;
  /**
   * Where a panel lives — its worktree's name, or its cwd outside one. Drawn
   * beside the title rather than under it: three agents all titled "Claude"
   * differ only here, so it belongs on the line the eye scans.
   */
  context?: string;
  /** A panel parked in the background rather than in the grid or dock. */
  isBackground?: boolean;
  /** The agent state last observed on a panel, when an agent was detected. */
  agentState?: AgentState;
  /** The focused panel, or the worktree being shown: where the user is now. */
  isCurrent?: boolean;
  /**
   * A worktree row's identity for its glyph, as the sidebar card draws it: the
   * sprout for main, the branch's type mark otherwise. Not search keys.
   */
  isMainWorktree?: boolean;
  branchLabel?: string;
  /**
   * What a custom title (#13409) displaced: the branch, or the detached commit.
   * It is the row's qualifier and is searched with the title, so a worktree the
   * user retitled is still found and told apart by what git calls it. `null`
   * when a title displaced nothing worth saying (it is the branch itself), so
   * the row does not fall back to the qualifier an untitled worktree gets;
   * `undefined` without a title.
   */
  displaced?: string | null;
  /** A plugin search provider's result (#13792): what it opens and who it came from. */
  pluginHit?: PluginSearchHit;
  file?: QuickSwitcherFile;
}

/** The switcher scoped to the active worktree's files, as its field names it. */
export interface QuickSwitcherFileScope {
  /** The worktree searched, or null while none is selected. */
  worktreeName: string | null;
  /** The last search failed; typing asks again. */
  failed: boolean;
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
  /** The rows on screen answer an earlier query while the current one is on its way. */
  isFiltering: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setQuery: (query: string) => void;
  setSelectedIndex: (index: number) => void;
  selectPrevious: () => void;
  selectNext: () => void;
  /** `modified` is the platform modifier: a file row then opens in the external editor. */
  selectItem: (item: QuickSwitcherItem, modified?: boolean) => void;
  confirmSelection: (modified?: boolean) => void;
  /** The plugin search provider the switcher is scoped to (#13792), if any. */
  scopedProvider: PluginSearchProviderInfo | null;
  /** The provider whose keyword the unscoped query spells exactly — Tab scopes to it. */
  keywordProvider: PluginSearchProviderInfo | null;
  /** How the scoped provider's last answer for this query went. */
  scopedStatus: PluginSearchStatus;
  enterScope: (providerKey: string) => void;
  /** The switcher is scoped to the active worktree's files (#17329). */
  fileScope: QuickSwitcherFileScope | null;
  /** The unscoped query spells the file search's keyword — Tab scopes to files. */
  isFileKeyword: boolean;
  enterFileScope: () => void;
  exitScope: () => void;
}

// No `type` key: "terminal", "worktree" and "plugin" are never drawn on a row,
// so a query fuzzily matching them listed rows with nothing visible to explain
// why ("lin" found every panel through "terminal").
//
// A custom-titled worktree's `displaced` text is a second value of the `title`
// key rather than a key of its own: Fuse spreads each key's weight across every
// configured key, present on a row or not, so a third key moved the scores of
// rows that have no title and reordered them under the MRU boost. An untitled
// row still hands Fuse its scalar title and scores exactly as before.
//
// One index ranks and highlights. Its match floor stays at Fuse's default of
// one character: `minMatchCharLength` also decides membership, so raising it
// would drop single-letter queries from the results. The two-character floor
// for highlights is applied to the ranges instead (`highlightRanges`).
const FUSE_OPTIONS: IFuseOptions<QuickSwitcherItem> = {
  keys: [
    {
      name: "title",
      weight: 2,
      getFn: (item) => (item.displaced ? [item.title, item.displaced] : item.title),
    },
    { name: "subtitle", weight: 1 },
  ],
  threshold: 0.4,
  includeScore: true,
  includeMatches: true,
};

const searchBuiltinItems = createFuseSearch(FUSE_OPTIONS);

/** Shortest range worth marking: a fuzzy hit shouldn't sprinkle single-letter bands across a row. */
const MIN_HIGHLIGHT_LENGTH = 2;

/** `displaced` is the second value of the `title` key (`FUSE_OPTIONS`), so its matches carry `refIndex` 1. */
const DISPLACED_REF_INDEX = 1;

// A match on `displaced` is relabelled to say so: left as `title`, its ranges
// would be read as offsets into the headline.
function highlightRanges(
  matches: readonly FuseResultMatch[] | undefined
): readonly FuseResultMatch[] | null {
  if (!matches) return null;
  const kept: FuseResultMatch[] = [];
  for (const match of matches) {
    const indices = match.indices.filter(([start, end]) => end - start + 1 >= MIN_HIGHLIGHT_LENGTH);
    if (indices.length === 0) continue;
    const key =
      match.key === "title" && match.refIndex === DISPLACED_REF_INDEX ? "displaced" : match.key;
    kept.push({ ...match, key, indices });
  }
  return kept.length > 0 ? kept : null;
}

function emptyMatches(): Map<string, readonly FuseResultMatch[]> {
  return new Map();
}

const MAX_RESULTS = 20;
const MRU_BOOST_FACTOR = 0.05;

const EMPTY_PANEL_IDS: string[] = [];
const EMPTY_ITEMS: QuickSwitcherItem[] = [];
const EMPTY_PANELS_BY_ID: ReturnType<typeof usePanelStore.getState>["panelsById"] = {};
const EMPTY_MRU: string[] = [];
const EMPTY_CUSTOM_TITLES: Readonly<Record<string, string>> = {};

function fileItem(rootPath: string, relativePath: string, changed: boolean): QuickSwitcherItem {
  const slash = relativePath.lastIndexOf("/");
  const root = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
  return {
    id: `file:${relativePath}`,
    type: "file",
    title: relativePath.slice(slash + 1),
    subtitle: slash > 0 ? relativePath.slice(0, slash) : undefined,
    file: { rootPath, relativePath, absolutePath: `${root}/${relativePath}`, changed },
  };
}

interface ChangedFiles {
  /** The changed files that can still be opened, most recently modified first. */
  items: QuickSwitcherItem[];
  /** Root-relative paths git reports deleted: the index can still list them. */
  deleted: ReadonlySet<string>;
}

const NO_CHANGES: ChangedFiles = { items: EMPTY_ITEMS, deleted: new Set() };

/**
 * The worktree's changes, read for the file scope: what agents just touched,
 * so the likeliest next pick. Ignored entries, folders and anything outside
 * the root are left out. Git reports absolute paths against the realpath of
 * the root (`changesRoot`), which differs from the worktree's own path under a
 * symlinked ancestor (/tmp -> /private/tmp), so paths are made relative to it
 * and rows are rebuilt on the worktree's path; older snapshots report relative
 * paths.
 */
function readChangedFiles(
  rootPath: string,
  changesRoot: string | undefined,
  changes: readonly FileChangeDetail[] | undefined
): ChangedFiles {
  if (!changes || changes.length === 0) return NO_CHANGES;
  const base = changesRoot || rootPath;
  const byPath = new Map<string, number>();
  const deleted = new Set<string>();
  for (const change of changes) {
    if (change.status === "ignored") continue;
    if (change.path.endsWith("/") || change.path.endsWith("\\")) continue;
    const absolute = isAbsolute(change.path) ? change.path : join(base, change.path);
    if (!isPathInside(absolute, base)) continue;
    const relative = toWorktreeRelative(absolute, base);
    if (relative === "" || relative === absolute) continue;
    if (change.status === "deleted") {
      deleted.add(relative);
      continue;
    }
    const mtime = change.mtimeMs ?? change.mtime ?? 0;
    byPath.set(relative, Math.max(mtime, byPath.get(relative) ?? 0));
  }
  if (byPath.size === 0 && deleted.size === 0) return NO_CHANGES;
  const items = [...byPath]
    .sort(([a, aTime], [b, bTime]) => bTime - aTime || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, FILE_RESULT_CAP)
    .map(([relative]) => fileItem(rootPath, relative, true));
  return { items: items.length > 0 ? items : EMPTY_ITEMS, deleted };
}

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
  const focusedPanelId = usePanelStore((state) => (paletteIsOpen ? state.focusedId : null));
  const pruneMru = usePanelStore((state) => state.pruneMru);
  const customTitles = useWorktreeFilterStore((state) =>
    paletteIsOpen ? state.worktreeCustomTitles : EMPTY_CUSTOM_TITLES
  );

  const {
    worktrees,
    worktreeMap,
    isInitialized: worktreesInitialized,
    error: worktreeError,
  } = useWorktrees({ enabled: paletteIsOpen });
  const { selectWorktree, activeWorktreeId } = useWorktreeSelectionStore(
    useShallow((state) => ({
      selectWorktree: state.selectWorktree,
      activeWorktreeId: paletteIsOpen ? state.activeWorktreeId : null,
    }))
  );

  // The scope lives in the palette store, so an opener can ask for a scoped
  // switcher in the update that opens it; every opening and close resets it.
  const scope = usePaletteStore((state) => (paletteIsOpen ? state.quickSwitcherScope : null));
  const setScope = usePaletteStore((state) => state.setQuickSwitcherScope);
  // Which opening this is: a repeat open asks the file search again, and an
  // Enter waiting on the previous opening's answer is dropped.
  const opening = usePaletteStore((state) => (paletteIsOpen ? state.openRequestId : 0));

  // Plugin search providers (#13792). The scope is the provider the user
  // picked by keyword + Tab; it only counts while that provider is still in
  // the catalog, so a provider switched off or unloaded drops the scope too.
  const pluginSearch = usePluginSearch(paletteIsOpen);
  const scopeKey = scope?.kind === "plugin" ? scope.key : null;
  const scopedProvider = scopeKey
    ? (pluginSearch.providers.find((provider) => provider.key === scopeKey) ?? null)
    : null;
  const activeScopeKey = scopedProvider?.key ?? null;

  // The file scope (#17329) searches the worktree being shown, and only it.
  const inFileScope = scope?.kind === "files";
  const fileWorktree =
    inFileScope && activeWorktreeId ? worktreeMap.get(activeWorktreeId) : undefined;
  const fileRoot = fileWorktree?.path || null;
  const fileChanges = fileWorktree?.worktreeChanges?.changes;
  const fileChangesRoot = fileWorktree?.worktreeChanges?.rootPath;
  const changedFiles = useMemo(
    () => (fileRoot ? readChangedFiles(fileRoot, fileChangesRoot, fileChanges) : NO_CHANGES),
    [fileRoot, fileChangesRoot, fileChanges]
  );
  const changedItems = changedFiles.items;
  const fileSearch = useQuickSwitcherFileSearch();
  const { answer: fileAnswer, request: fileRequest } = fileSearch.state;
  // A file deleted in the working tree stays in the index until the deletion
  // is staged; it has nothing left to open. Capped only after that, and here
  // rather than by the palette: the host stops at its own limit, so a count of
  // the rest would understate what typing more would narrow.
  const searchedItems = useMemo(() => {
    if (!fileAnswer || fileAnswer.rootPath !== fileRoot) return EMPTY_ITEMS;
    const { deleted } = changedFiles;
    const items = fileAnswer.paths
      .filter((path) => !deleted.has(path))
      .slice(0, FILE_RESULT_CAP)
      .map((path) => fileItem(fileAnswer.rootPath, path, false));
    return items.length > 0 ? items : EMPTY_ITEMS;
  }, [fileAnswer, fileRoot, changedFiles]);
  const fileRootAnswered = fileAnswer !== null && fileAnswer.rootPath === fileRoot;

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
        title: withDisplayEmoji(t.title, t.displayEmoji),
        subtitle: isBackground
          ? baseSubtitle
            ? `${baseSubtitle} · Backgrounded`
            : "Backgrounded"
          : baseSubtitle,
        terminalKind: t.kind,
        chrome: deriveTerminalChrome(t),
        worktreeId: t.worktreeId,
        context: baseSubtitle,
        isBackground,
        agentState: isPtyPanel(t) ? t.agentState : undefined,
        isCurrent: t.id === focusedPanelId,
      });
    }

    // Add worktrees
    for (const w of worktrees) {
      const customTitle = customTitles[w.id];
      result.push({
        id: `worktree:${w.id}`,
        type: "worktree",
        title: customTitle || (w.name ?? w.branch ?? "Worktree"),
        subtitle: w.path,
        isCurrent: w.id === activeWorktreeId,
        isMainWorktree: w.isMainWorktree,
        branchLabel: getWorktreeBranchLabel(w),
        displaced: customTitle ? getWorktreeQualifier(w, customTitle) : undefined,
      });
    }

    return result;
  }, [
    panelIds,
    panelsById,
    worktrees,
    worktreeMap,
    focusedPanelId,
    activeWorktreeId,
    customTitles,
  ]);

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
  // below the built-in ones, which never wait on them. The file scope's branch
  // of `searchFn` picks between its own two lists by query, so it hands none.
  const items = useMemo<QuickSwitcherItem[]>(
    () =>
      inFileScope
        ? EMPTY_ITEMS
        : activeScopeKey !== null
          ? pluginItems
          : [...builtinItems, ...pluginItems],
    [inFileScope, activeScopeKey, builtinItems, pluginItems]
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

  const searchFn = useCallback(
    (_allItems: QuickSwitcherItem[], query: string): PaletteSearchResult<QuickSwitcherItem> => {
      // The host already ranked the files; an empty field lists the changed
      // ones when there are any. What was on screen stays there, dimmed, until
      // the current query is answered (the changed files too, until the first
      // search lands), but only a row that answers the field opens.
      if (inFileScope) {
        const items =
          (query.trim() === "" || !fileRootAnswered) && changedItems.length > 0
            ? changedItems
            : searchedItems;
        return { items, matchesById: emptyMatches() };
      }

      // Plugin rows answer one (scope, query); for any other they are stale,
      // and left out in the same render the input changed, so neither Enter
      // nor a click can open a row from the previous query.
      const live =
        pluginState.scopeKey === activeScopeKey && pluginState.query === query ? pluginItems : [];
      if (activeScopeKey !== null) return { items: live, matchesById: emptyMatches() };

      const mruIndexMap = new Map<string, number>();
      mruList.forEach((id, index) => mruIndexMap.set(id, index));
      const mruSize = mruList.length;

      // Closed, the list is the browse order whatever query was left behind
      // when another palette took over: a closed switcher never searches.
      if (!paletteIsOpen || !query.trim()) {
        // Empty query: return items in MRU order (MRU items first, then others)
        const items = [...builtinItems].sort((a, b) => {
          const aIndex = mruIndexMap.get(a.id) ?? Infinity;
          const bIndex = mruIndexMap.get(b.id) ?? Infinity;
          return aIndex - bIndex;
        });
        return { items, matchesById: emptyMatches() };
      }

      // Non-empty query: Fuse search with MRU boost (lower score = better match).
      // A plugin reply or MRU change re-runs this for the same query and gets
      // the cached hits back rather than a second search.
      const fuseResults = searchBuiltinItems(builtinItems, query);
      const matchesById = emptyMatches();
      for (const r of fuseResults) {
        const ranges = highlightRanges(r.matches);
        if (ranges) matchesById.set(r.item.id, ranges);
      }
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
      if (live.length === 0) return { items: ranked, matchesById };
      return {
        items: [...ranked.slice(0, MAX_RESULTS), ...live, ...ranked.slice(MAX_RESULTS)],
        matchesById,
      };
    },
    [
      inFileScope,
      changedItems,
      searchedItems,
      fileRootAnswered,
      paletteIsOpen,
      mruList,
      builtinItems,
      pluginItems,
      pluginState,
      activeScopeKey,
    ]
  );

  const {
    isOpen,
    query,
    results,
    totalResults,
    selectedIndex,
    matchesById,
    open,
    close,
    toggle,
    setQuery,
    setSelectedIndex,
    selectPrevious,
    selectNext,
  } = useSearchablePalette<QuickSwitcherItem>({
    items,
    searchFn,
    maxResults: inFileScope ? FILE_RESULT_CAP : MAX_RESULTS + pluginItems.length,
    paletteId: "quick-switcher",
    // Opened from the action registry through the store, not through `open()`.
    resetOnStoreOpen: true,
  });

  // Nothing typed in the file scope never reaches a plugin: unscoped (null)
  // means "ask the blending providers", so the file scope asks them nothing.
  const { request: requestPluginSearch, providers: pluginProviders } = pluginSearch;
  useEffect(() => {
    requestPluginSearch(paletteIsOpen && !inFileScope, activeScopeKey, query, pluginProviders);
  }, [requestPluginSearch, paletteIsOpen, inFileScope, activeScopeKey, query, pluginProviders]);

  // What the file scope asks the host for: the typed query, or with nothing
  // typed the root's shortest paths, unless there are changed files to list.
  const fileQuery = query.trim();
  const fileRequestQuery =
    inFileScope && fileRoot !== null && (fileQuery !== "" || changedItems.length === 0)
      ? fileQuery
      : null;
  const requestFileSearch = fileSearch.request;
  useEffect(() => {
    requestFileSearch(fileRequestQuery === null ? null : fileRoot, fileRequestQuery);
  }, [requestFileSearch, fileRoot, fileRequestQuery, opening]);

  // The answer on screen is to the query in the field, not an earlier one.
  const fileAnswerIsLive =
    fileRequestQuery !== null &&
    fileRequest !== null &&
    fileRequest.rootPath === fileRoot &&
    fileRequest.query === fileRequestQuery &&
    fileAnswer !== null &&
    fileAnswer.seq === fileRequest.seq;
  const fileSearchPending = fileRequestQuery !== null && !fileAnswerIsLive;

  // Scoped and not yet answered for this exact query (debouncing or in
  // flight) reads as loading, so the empty state never flashes between keys.
  const scopedStatus: PluginSearchStatus =
    activeScopeKey === null
      ? "idle"
      : pluginState.scopeKey === activeScopeKey && pluginState.query === query
        ? pluginState.status
        : "loading";

  const typedKeyword = scope === null ? query.trim().toLowerCase() : "";
  // Main refuses a provider claiming the file search's keyword, so at most one
  // of these can match.
  const isFileKeyword = typedKeyword === FILE_SEARCH_KEYWORD;
  const keywordProvider = useMemo(() => {
    if (typedKeyword.length === 0) return null;
    return pluginProviders.find((provider) => provider.keyword === typedKeyword) ?? null;
  }, [typedKeyword, pluginProviders]);

  const enterScope = useCallback(
    (providerKey: string) => {
      setScope({ kind: "plugin", key: providerKey });
      setQuery("");
    },
    [setScope, setQuery]
  );
  const enterFileScope = useCallback(() => {
    setScope({ kind: "files" });
    setQuery("");
  }, [setScope, setQuery]);
  const exitScope = useCallback(() => setScope(null), [setScope]);

  const restoreBackgroundTerminal = usePanelStore((state) => state.restoreBackgroundTerminal);
  const activateTerminal = usePanelStore((state) => state.activateTerminal);

  // A file row opens only while it is one of the rows the field's current
  // query lists, from the worktree still being shown: a search answering an
  // earlier query stays on screen while the next one is on its way.
  const isLiveFile = useCallback(
    (file: QuickSwitcherFile): boolean => {
      if (!inFileScope || file.rootPath !== fileRoot) return false;
      if (file.changed) {
        return (
          fileQuery === "" &&
          changedItems.some((item) => item.file?.relativePath === file.relativePath)
        );
      }
      return (
        fileAnswerIsLive &&
        searchedItems.some((item) => item.file?.relativePath === file.relativePath)
      );
    },
    [inFileScope, fileRoot, fileQuery, changedItems, fileAnswerIsLive, searchedItems]
  );

  // Enter before the file search has answered what the field says waits for
  // that answer and opens its top hit, so a pasted path and Enter in one breath
  // opens that file rather than a row from the previous query.
  const queuedFileEnterRef = useRef<{
    opening: number;
    root: string;
    query: string;
    modified: boolean;
  } | null>(null);

  const selectItem = useCallback(
    (item: QuickSwitcherItem, modified = false) => {
      if (item.file) {
        // The store is read live: a handler from a render before a close, or
        // from an earlier opening, must not open a file, nor touch this
        // opening's waiting Enter. A pick of its own replaces that Enter.
        const live = usePaletteStore.getState();
        if (
          live.activePaletteId !== "quick-switcher" ||
          live.openRequestId !== opening ||
          live.quickSwitcherScope?.kind !== "files"
        ) {
          return;
        }
        queuedFileEnterRef.current = null;
        if (!isLiveFile(item.file)) return;
      }
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
      } else if (item.file) {
        openQuickSwitcherFile(item.file.absolutePath, modified);
      } else if (hit) {
        openPluginSearchHit(hit);
      }
      close();
    },
    [
      isLiveFile,
      opening,
      selectWorktree,
      close,
      restoreBackgroundTerminal,
      activateTerminal,
      pluginState,
      activeScopeKey,
      query,
    ]
  );

  // The waiting Enter belongs to one opening, root and query: the moment the
  // field asks anything else it is dropped, even if it comes back to the same
  // query before either answer lands.
  useEffect(() => {
    const queued = queuedFileEnterRef.current;
    if (queued === null) return;
    if (
      queued.opening !== opening ||
      queued.root !== fileRoot ||
      queued.query !== fileRequestQuery
    ) {
      queuedFileEnterRef.current = null;
      return;
    }
    if (fileSearchPending) return;
    queuedFileEnterRef.current = null;
    const top = searchedItems[0];
    if (top) selectItem(top, queued.modified);
  }, [opening, fileSearchPending, fileRoot, fileRequestQuery, searchedItems, selectItem]);

  const confirmSelection = useCallback(
    (modified = false) => {
      if (fileSearchPending && fileRoot !== null && fileRequestQuery !== null) {
        queuedFileEnterRef.current = { opening, root: fileRoot, query: fileRequestQuery, modified };
        return;
      }
      if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
        selectItem(results[selectedIndex]!, modified);
      }
    },
    [opening, fileSearchPending, fileRoot, fileRequestQuery, results, selectedIndex, selectItem]
  );

  return {
    isOpen,
    query,
    results,
    totalResults,
    selectedIndex,
    matchesById,
    isLoading:
      (activeScopeKey === null && !worktreesInitialized && worktreeError === null) ||
      scopedStatus === "loading" ||
      (fileSearchPending && results.length === 0),
    isFiltering: fileSearchPending && results.length > 0,
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
    fileScope: inFileScope
      ? {
          worktreeName: fileWorktree ? (fileWorktree.name ?? fileWorktree.branch ?? null) : null,
          failed: fileAnswerIsLive && fileAnswer!.failed,
        }
      : null,
    isFileKeyword,
    enterFileScope,
    exitScope,
  };
}
