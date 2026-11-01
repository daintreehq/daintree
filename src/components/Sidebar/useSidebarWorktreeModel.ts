import { useDeferredValue, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { getWorktreeSortDragId } from "@/components/DragDrop/SortableWorktreeCard";
import { computeChipState } from "@/components/Worktree/utils/computeChipState";
import { useWorktreeAgentBucketInputs } from "@/hooks/useWorktreeAgentBucketInputs";
import { useWorktreeIds } from "@/hooks/useTerminalSelectors";
import {
  deriveWorktreeAgentBuckets,
  EMPTY_WORKTREE_AGENT_BUCKETS,
  isWorktreeMergedForCleanup,
} from "@/lib/worktreeAgentBuckets";
import {
  matchesFilters,
  matchesQuickStateFilter,
  computeChipCounts,
  type DerivedWorktreeMeta,
  type FilterState,
} from "@/lib/worktreeFilters";
import { usePanelStore } from "@/store";
import { useWorktreeDevServerStore } from "@/store/worktreeDevServerStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import type { DeletedWorktree } from "@/store/worktreeStore";
import {
  recordSidebarWorktreeOrder,
  DELETED_WORKTREE_GROUP_THRESHOLD,
} from "@/store/worktreeStore";
import type { WorktreeState } from "@/types";
import {
  selectSidebarVisiblePanelIds,
  selectSidebarAgentStateByPanelId,
  selectSidebarAgentPanelIds,
  selectSidebarFleetEligibleWorktreeById,
  computePanelStateByWorktree,
} from "./sidebarPanelDerivation";
import {
  buildSidebarFlatItems,
  filterSidebarWorktrees,
  type SidebarFlatItem,
} from "./sidebarWorktreeModel";
import { useRenderTime } from "./useRenderTime";
import type { SidebarKeyboardItem } from "./useWorktreeSidebarKeyboard";
import { worktreeProblemTone, type WorktreeProblemTone } from "./worktreeProblems";

const SIDEBAR_DEFER_FILTER_MIN_WORKTREES = 60;

// Stable empty ref so `filterArmEligibleIds` can bail to a constant when no
// worktrees are in scope instead of yielding a fresh `[]`.
const EMPTY_ELIGIBLE_IDS: readonly string[] = [];

const EMPTY_DERIVED_META: DerivedWorktreeMeta = {
  terminalCount: 0,
  hasAgent: false,
  hasWorkingAgent: false,
  hasWaitingAgent: false,
  hasCompletedAgent: false,
  hasExitedAgent: false,
  hasMergeConflict: false,
  buckets: EMPTY_WORKTREE_AGENT_BUCKETS,
  chipState: null,
};

interface UseSidebarWorktreeModelOptions {
  worktrees: WorktreeState[];
  activeWorktreeId: string | null;
  deletedWorktrees: Map<string, DeletedWorktree>;
  /** Whether `worktrees` is a list the host actually delivered (#13408). */
  canPruneWorktreeIds: boolean;
}

/**
 * Everything the worktree sidebar derives from its stores before it renders:
 * per-worktree metadata, the counts the quick-state bar and chips show, which
 * worktrees survive the filters, the main row's visibility, and the flat item
 * list the virtualized grid draws. It also prunes persisted per-worktree
 * preferences that point at worktrees which no longer exist.
 */
export function useSidebarWorktreeModel({
  worktrees,
  activeWorktreeId,
  deletedWorktrees,
  canPruneWorktreeIds,
}: UseSidebarWorktreeModelOptions) {
  const deferredWorktrees = useDeferredValue(worktrees);

  // Filter/sort state - destructured for stable memoization
  const {
    liveQuery,
    orderBy,
    groupByType: isGroupedByType,
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    hasAgentFilter,
    activityFilters,
    devServerFilters,
    alwaysShowActive,
    alwaysShowWaiting,
    pinnedWorktrees,
    manualOrder,
    quickStateFilter,
  } = useWorktreeFilterStore(
    useShallow((state) => ({
      liveQuery: state.liveQuery,
      orderBy: state.orderBy,
      groupByType: state.groupByType,
      statusFilters: state.statusFilters,
      typeFilters: state.typeFilters,
      prIssueFilters: state.prIssueFilters,
      sessionFilters: state.sessionFilters,
      hasAgentFilter: state.hasAgentFilter,
      activityFilters: state.activityFilters,
      devServerFilters: state.devServerFilters,
      alwaysShowActive: state.alwaysShowActive,
      alwaysShowWaiting: state.alwaysShowWaiting,
      pinnedWorktrees: state.pinnedWorktrees,
      manualOrder: state.manualOrder,
      quickStateFilter: state.quickStateFilter,
    }))
  );

  const devServerSessions = useWorktreeDevServerStore((s) => s.sessionsByWorktreeId);

  // Lag the expensive filtering work behind the input so keystrokes stay
  // responsive. `liveQuery` updates instantly (input + urgent UI state); the
  // filtering memos consume `deferredQuery`, which yields to input events.
  // Only for a large sidebar: with a few dozen worktrees the filter costs a
  // millisecond and deferring it just paints the keystroke a frame before the
  // list answers it.
  const laggedQuery = useDeferredValue(liveQuery);
  const deferredQuery =
    deferredWorktrees.length > SIDEBAR_DEFER_FILTER_MIN_WORKTREES ? laggedQuery : liveQuery;

  const clearAllFilters = useWorktreeFilterStore((state) => state.clearAll);
  // Called inside the selector, not on a selected `hasFacetFilters`: the getter
  // reads the store through get(), so the compiler would cache a render-time
  // call against the action's stable identity and freeze the facet gate.
  const hasFacetFiltersActive = useWorktreeFilterStore((state) => state.hasFacetFilters());
  const collapsedWorktrees = useWorktreeFilterStore((state) => state.collapsedWorktrees);
  const worktreeLabelColors = useWorktreeFilterStore((state) => state.worktreeLabelColors);
  const worktreeCustomTitles = useWorktreeFilterStore((state) => state.worktreeCustomTitles);
  const pruneStaleWorktreeIds = useWorktreeFilterStore((state) => state.pruneStaleWorktreeIds);
  const setQuickStateFilter = useWorktreeFilterStore((state) => state.setQuickStateFilter);

  // Terminal store: subscribe to stable primitives, then derive per-worktree
  // counts locally. Returning nested objects directly from the store selector
  // trips React's external-store snapshot guard.
  const worktreeIds = useWorktreeIds();
  const worktreeIdList = useMemo(() => deferredWorktrees.map((w) => w.id), [deferredWorktrees]);
  const panelIds = usePanelStore((state) => state.panelIds);
  const panelIdsByWorktreeId = usePanelStore((state) => state.panelIdsByWorktreeId);
  // Subscribing to the whole `panelsById` map re-ran every rollup below on each
  // rAF status-buffer flush (up to 60×/sec while an agent streams), because the
  // buffer replaces the map reference every flush (#10908). Instead subscribe to
  // flat primitive maps of ONLY the fields these rollups read (see
  // `sidebarPanelDerivation.ts`) — none of which the buffer writes — so
  // `useShallow` bails on buffer flushes and re-renders fire only on real
  // structural, agent-state, or fleet-eligibility changes.
  const visiblePanelIds = usePanelStore(useShallow(selectSidebarVisiblePanelIds));
  const agentStateByPanelId = usePanelStore(useShallow(selectSidebarAgentStateByPanelId));
  const agentPanelIds = usePanelStore(useShallow(selectSidebarAgentPanelIds));
  const fleetEligibleWorktreeById = usePanelStore(
    useShallow(selectSidebarFleetEligibleWorktreeById)
  );
  const panelStateByWorktree = useMemo(
    () =>
      computePanelStateByWorktree(
        worktreeIdList,
        panelIdsByWorktreeId,
        visiblePanelIds,
        agentStateByPanelId,
        agentPanelIds,
        worktreeIds
      ),
    [
      worktreeIdList,
      panelIdsByWorktreeId,
      visiblePanelIds,
      agentStateByPanelId,
      agentPanelIds,
      worktreeIds,
    ]
  );

  const setManualOrder = useWorktreeFilterStore((state) => state.setManualOrder);

  // Clean up stale pinned/collapsed/labelled worktrees (single store write so
  // pruning costs one persist flush, not N) and stale manual order entries.
  // Merged so the worktree-ID Set is built at most once per pass.
  useEffect(() => {
    if (!canPruneWorktreeIds) return;
    const labelledIds = Object.keys(worktreeLabelColors);
    const titledIds = Object.keys(worktreeCustomTitles);
    if (
      pinnedWorktrees.length === 0 &&
      collapsedWorktrees.length === 0 &&
      labelledIds.length === 0 &&
      titledIds.length === 0 &&
      manualOrder.length === 0
    ) {
      return;
    }
    const existingIds = new Set(worktrees.map((w) => w.id));
    const hasStalePin = pinnedWorktrees.some((id) => !existingIds.has(id));
    const hasStaleCollapsed = collapsedWorktrees.some((id) => !existingIds.has(id));
    const hasStaleLabel = labelledIds.some((id) => !existingIds.has(id));
    const hasStaleTitle = titledIds.some((id) => !existingIds.has(id));
    if (hasStalePin || hasStaleCollapsed || hasStaleLabel || hasStaleTitle) {
      pruneStaleWorktreeIds(existingIds);
    }
    if (manualOrder.length > 0) {
      const cleaned = manualOrder.filter((id) => existingIds.has(id));
      if (cleaned.length !== manualOrder.length) {
        setManualOrder(cleaned);
      }
    }
  }, [
    canPruneWorktreeIds,
    worktrees,
    pinnedWorktrees,
    collapsedWorktrees,
    worktreeLabelColors,
    worktreeCustomTitles,
    manualOrder,
    pruneStaleWorktreeIds,
    setManualOrder,
  ]);

  // Compute derived metadata for each worktree. Panel scan is delegated to the
  // single-pass `panelStateByWorktree` selector above; the quick-state buckets
  // join this worktree's visible agent panels to their fleet runs, through the
  // same derivation the overview modal, cycling and the card read.
  const { runsById, pluginByWorktreeId } = useWorktreeAgentBucketInputs();
  const derivedMetaMap = useMemo(() => {
    const map = new Map<string, DerivedWorktreeMeta>();
    for (const worktree of deferredWorktrees) {
      const panelState = panelStateByWorktree[worktree.id] ?? {
        terminalCount: 0,
        waitingTerminalCount: 0,
        hasAgent: false,
        hasWorkingAgent: false,
        hasWaitingAgent: false,
        hasCompletedAgent: false,
        hasExitedAgent: false,
      };

      const worktreeOrphaned = worktreeIds.size > 0 && !worktreeIds.has(worktree.id);
      const visibleAgentPanelIds = worktreeOrphaned
        ? []
        : (panelIdsByWorktreeId[worktree.id] ?? []).filter(
            (id) => visiblePanelIds[id] && agentPanelIds[id]
          );
      const buckets = deriveWorktreeAgentBuckets(
        visibleAgentPanelIds,
        runsById,
        isWorktreeMergedForCleanup(worktree),
        worktreeOrphaned ? undefined : pluginByWorktreeId.get(worktree.id)
      );

      map.set(worktree.id, {
        terminalCount: panelState.terminalCount,
        hasAgent: panelState.hasAgent,
        hasWorkingAgent: panelState.hasWorkingAgent,
        hasWaitingAgent: panelState.hasWaitingAgent,
        hasCompletedAgent: panelState.hasCompletedAgent,
        hasExitedAgent: panelState.hasExitedAgent,
        hasMergeConflict:
          worktree.worktreeChanges?.changes.some((c) => c.status === "conflicted") ?? false,
        buckets,
        chipState: computeChipState(buckets),
      });
    }
    return map;
  }, [
    deferredWorktrees,
    panelStateByWorktree,
    panelIdsByWorktreeId,
    visiblePanelIds,
    agentPanelIds,
    worktreeIds,
    runsById,
    pluginByWorktreeId,
  ]);

  // Apply filters and sorting
  const mainWorktree = useMemo(
    () => deferredWorktrees.find((w) => w.isMainWorktree) ?? deferredWorktrees[0] ?? null,
    [deferredWorktrees]
  );

  // Single source for every "worktrees other than the main card" set below —
  // quick-state counts, chip counts, the main card's aggregate, and the
  // filtered list all read this one array so they can never disagree about
  // which worktrees exist. #11433 was exactly that drift: a second, branch-name
  // derived exclusion removed a worktree from the counts while it stayed on
  // screen, so the filter bar read "All 0" above a visible row.
  const nonMainWorktrees = useMemo(
    () => deferredWorktrees.filter((w) => w.id !== mainWorktree?.id),
    [deferredWorktrees, mainWorktree]
  );

  // The search and the facets narrow every card, main included, and the
  // quick-state counts describe that narrowed set: the bar sits under the
  // search field and over every card it filters, so "All 4" over a list of
  // four is the only reading that does not need a footnote. Quick-state itself
  // is left out, so each segment says what choosing it would leave.
  const now = useRenderTime();
  const narrowingFilters: FilterState = {
    query: deferredQuery,
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    hasAgentFilter,
    activityFilters,
    devServerFilters,
    customTitles: worktreeCustomTitles,
  };
  const isNarrowed = deferredQuery.trim().length > 0 || hasFacetFiltersActive;
  const narrowedWorktrees = isNarrowed
    ? deferredWorktrees.filter((w) =>
        matchesFilters(
          w,
          narrowingFilters,
          derivedMetaMap.get(w.id) ?? EMPTY_DERIVED_META,
          w.id === activeWorktreeId,
          devServerSessions,
          now
        )
      )
    : deferredWorktrees;

  const quickStateCounts = useMemo(() => {
    const counts = {
      all: narrowedWorktrees.length,
      working: 0,
      waiting: 0,
      finished: 0,
      finishedUnseen: 0,
    };
    for (const w of narrowedWorktrees) {
      const meta = derivedMetaMap.get(w.id);
      if (!meta) continue;
      if (matchesQuickStateFilter("working", meta)) counts.working++;
      if (matchesQuickStateFilter("waiting", meta)) counts.waiting++;
      if (matchesQuickStateFilter("finished", meta)) counts.finished++;
      if (meta.buckets.finishedUnseen) counts.finishedUnseen++;
    }
    return counts;
  }, [narrowedWorktrees, derivedMetaMap]);

  /**
   * The population the chip counts describe. It is deliberately WIDER than
   * `nonMainWorktrees`: the main worktree is not a list row, but it is subject
   * to the same facets (`mainVisible` below), so leaving it out made
   * every facet it alone satisfies read zero. "Main" is the clear case — the
   * only worktree of that type is the main one, so the chip read (0) forever.
   *
   * Quick-state IS applied, to main as well, because that is exactly how the
   * cards themselves are gated. The `alwaysShowActive` / `alwaysShowWaiting`
   * bypasses are deliberately ignored: they only fire while no facet filter is
   * active, so selecting any chip switches them off anyway — a count taken
   * without them is the count that will actually apply once the chip is clicked.
   *
   * The counts gate `disabled` on a chip, so both directions of error cost
   * something. Under-reporting takes a working filter away; over-reporting
   * promises matches and hands back an empty list. This population is the set
   * of rows a facet can actually reach, which is neither.
   */
  const countedWorktrees = useMemo(() => {
    const eligible =
      quickStateFilter === "all"
        ? nonMainWorktrees
        : nonMainWorktrees.filter((w) => {
            const meta = derivedMetaMap.get(w.id);
            return meta ? matchesQuickStateFilter(quickStateFilter, meta) : false;
          });
    const mainMeta = mainWorktree ? derivedMetaMap.get(mainWorktree.id) : undefined;
    const mainEligible =
      mainWorktree !== null &&
      (quickStateFilter === "all" ||
        (mainMeta !== undefined && matchesQuickStateFilter(quickStateFilter, mainMeta)));
    return mainEligible && mainWorktree ? [mainWorktree, ...eligible] : eligible;
  }, [mainWorktree, nonMainWorktrees, quickStateFilter, derivedMetaMap]);

  const chipCounts = useMemo(() => {
    return computeChipCounts(
      countedWorktrees,
      derivedMetaMap,
      activeWorktreeId,
      {
        query: deferredQuery,
        statusFilters,
        typeFilters,
        prIssueFilters,
        sessionFilters,
        hasAgentFilter,
        activityFilters,
        devServerFilters,
        customTitles: worktreeCustomTitles,
      },
      devServerSessions
    );
  }, [
    countedWorktrees,
    derivedMetaMap,
    activeWorktreeId,
    deferredQuery,
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    hasAgentFilter,
    activityFilters,
    devServerFilters,
    devServerSessions,
    worktreeCustomTitles,
  ]);

  const {
    filteredWorktrees,
    groupedSections,
    hasResultsWithoutQuickState,
    resultsWithoutQuickStateCount,
    totalCount,
  } = useMemo(
    () =>
      filterSidebarWorktrees({
        deferredWorktrees,
        nonMainWorktrees,
        deferredQuery,
        orderBy,
        isGroupedByType,
        statusFilters,
        typeFilters,
        prIssueFilters,
        sessionFilters,
        hasAgentFilter,
        activityFilters,
        devServerFilters,
        devServerSessions,
        alwaysShowActive,
        alwaysShowWaiting,
        pinnedWorktrees,
        manualOrder,
        derivedMetaMap,
        activeWorktreeId,
        quickStateFilter,
        hasFacetFiltersActive,
        worktreeCustomTitles,
      }),
    [
      deferredWorktrees,
      nonMainWorktrees,
      deferredQuery,
      orderBy,
      isGroupedByType,
      statusFilters,
      typeFilters,
      prIssueFilters,
      sessionFilters,
      hasAgentFilter,
      activityFilters,
      devServerFilters,
      devServerSessions,
      alwaysShowActive,
      alwaysShowWaiting,
      pinnedWorktrees,
      manualOrder,
      derivedMetaMap,
      activeWorktreeId,
      quickStateFilter,
      hasFacetFiltersActive,
      worktreeCustomTitles,
    ]
  );

  // `filteredWorktrees` gets a new identity on every worktree update, even when
  // only one card's status changed. Keying the id order on its content keeps
  // `dragStartOrder` and dnd-kit's `SortableContext` items stable across those
  // updates, so the memoized rows (and every sortable card) skip re-rendering.
  // NUL can't occur in a worktree id, so the join is unambiguous.
  const worktreeOrderKey = filteredWorktrees.map((w) => w.id).join("\0");
  const dragStartOrder = useMemo(
    () => (worktreeOrderKey === "" ? [] : worktreeOrderKey.split("\0")),
    [worktreeOrderKey]
  );
  const sortableIds = useMemo(() => dragStartOrder.map(getWorktreeSortDragId), [dragStartOrder]);

  // Main-row visibility. The main worktree is a pinned card rather than a list
  // row, but it sits under the same search, facets and quick-state bar as
  // every other card, so it takes all three, with no bypass a list row lacks:
  // a segment shows exactly the cards its count says.
  const mainMeta = mainWorktree ? derivedMetaMap.get(mainWorktree.id) : undefined;
  const mainNarrowed = mainWorktree !== null && narrowedWorktrees.includes(mainWorktree);
  const mainMatchesQuickState =
    quickStateFilter === "all" ||
    (mainMeta !== undefined && matchesQuickStateFilter(quickStateFilter, mainMeta));
  const mainVisible = mainNarrowed && mainMatchesQuickState;
  // Main matched the search and facets but the segment hid it: one of the
  // results a segment is hiding, which the empty state has to count.
  const mainHiddenByQuickState = mainNarrowed && !mainMatchesQuickState;
  // Main sitting on screen under a segment because it is in that bucket: the
  // empty state then says the list is empty rather than that nothing is.
  const mainInQuickState = quickStateFilter !== "all" && mainVisible && mainMatchesQuickState;

  // Arm-eligible agent terminals inside the currently visible worktrees, split
  // so an arm/disarm elsewhere only re-walks the unarmed tally rather than
  // re-scanning every panel. Drives the QuickStateFilterBar arm affordance,
  // which is agent-scoped like the state-filter presets beside it (#11637).
  const filterArmEligibleIds = useMemo(() => {
    // The main card counts in the segments it sits under, so its agents arm
    // with the rest; the bar's count and its arm button describe one set.
    const worktreeIdSet = new Set(filteredWorktrees.map((w) => w.id));
    if (mainVisible && mainWorktree) worktreeIdSet.add(mainWorktree.id);
    if (worktreeIdSet.size === 0) return EMPTY_ELIGIBLE_IDS;
    const ids: string[] = [];
    for (const id of panelIds) {
      const worktreeId = fleetEligibleWorktreeById[id];
      if (worktreeId === undefined) continue; // not eligible
      if (!worktreeId || !worktreeIdSet.has(worktreeId)) continue;
      ids.push(id);
    }
    return ids;
  }, [filteredWorktrees, panelIds, fleetEligibleWorktreeById, mainVisible, mainWorktree]);

  const mainRowIndex = mainVisible ? 1 : 0;
  const firstScrollableRowIndex = mainRowIndex + 1;

  // Total rows in the grid — the main row + group header rows + data rows.
  // Group header rows count toward aria-rowcount because they carry role="row".
  // Deleted rows carry `role="row"` too, so they count — a collapsed group is
  // one row no matter how many worktrees it holds.
  const deletedRowCount =
    deletedWorktrees.size >= DELETED_WORKTREE_GROUP_THRESHOLD ? 1 : deletedWorktrees.size;
  const ariaRowCount =
    mainRowIndex +
    (groupedSections
      ? groupedSections.reduce((n, s) => n + 1 + s.worktrees.length, 0)
      : filteredWorktrees.length) +
    deletedRowCount;

  // Build the flat item array that drives the virtualized scroll region. The
  // grouped path interleaves sticky header sentinels with static rows; the
  // ungrouped path emits sortable rows so dnd-kit's SortableContext can
  // wrap the whole Virtuoso surface.
  // Publish the visible order so a worktree deleted later can anchor its row to
  // the live successor it currently precedes (#11232). Recorded from an effect
  // rather than during render because it is a write to module state — reading it
  // happens once, at deletion, well after this has settled.
  useEffect(() => {
    recordSidebarWorktreeOrder(filteredWorktrees.map((w) => w.id));
  }, [filteredWorktrees]);

  const sidebarItems = useMemo<SidebarFlatItem[]>(
    () =>
      buildSidebarFlatItems({
        groupedSections,
        filteredWorktrees,
        firstScrollableRowIndex,
        pinnedWorktrees,
        dragStartOrder,
        deletedWorktrees,
      }),
    [
      groupedSections,
      filteredWorktrees,
      firstScrollableRowIndex,
      pinnedWorktrees,
      dragStartOrder,
      deletedWorktrees,
    ]
  );

  // The quick-state bar's "Attention" bucket, by the bar's own predicate, so
  // each pill's mark is a directional share of the number shown just above the
  // list and clicking the "Attention" segment filters to exactly these rows.
  const attentionWorktreeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, meta] of derivedMetaMap) {
      if (matchesQuickStateFilter("waiting", meta)) ids.add(id);
    }
    return ids;
  }, [derivedMetaMap]);

  // Rows reporting something broken that no agent is asking about (conflict,
  // failing CI, failed setup, failed sign-in), so a band can say a failure is
  // past the edge even when nothing there is waiting.
  const problemWorktreeTones = useMemo(() => {
    const tones = new Map<string, WorktreeProblemTone>();
    for (const worktree of deferredWorktrees) {
      const tone = worktreeProblemTone(worktree, derivedMetaMap.get(worktree.id));
      if (tone) tones.set(worktree.id, tone);
    }
    return tones;
  }, [deferredWorktrees, derivedMetaMap]);

  // The pinned main row lives OUTSIDE the Virtuoso surface but INSIDE the
  // role="grid" container, so keyboard navigation must visit it before
  // descending into the virtualized list. It carries isPinned so the hook
  // skips scrollToIndex (it's always rendered, never windowed).
  const keyboardItems = useMemo<SidebarKeyboardItem[]>(() => {
    const items: SidebarKeyboardItem[] = [];
    if (mainVisible && mainWorktree) {
      items.push({ kind: "row", worktreeId: mainWorktree.id, isPinned: true });
    }
    for (const item of sidebarItems) {
      items.push(
        item.kind === "row" ? { kind: "row", worktreeId: item.worktreeId } : { kind: "header" }
      );
    }
    return items;
  }, [sidebarItems, mainVisible, mainWorktree]);

  return {
    deferredWorktrees,
    liveQuery,
    deferredQuery,
    isGroupedByType,
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    hasAgentFilter,
    activityFilters,
    devServerFilters,
    quickStateFilter,
    hasFacetFiltersActive,
    clearAllFilters,
    setQuickStateFilter,
    mainWorktree,
    mainVisible,
    mainInQuickState,
    mainHiddenByQuickState,
    nonMainWorktrees,
    quickStateCounts,
    chipCounts,
    filteredWorktrees,
    groupedSections,
    hasResultsWithoutQuickState,
    resultsWithoutQuickStateCount,
    totalCount,
    dragStartOrder,
    sortableIds,
    filterArmEligibleIds,
    mainRowIndex,
    ariaRowCount,
    sidebarItems,
    attentionWorktreeIds,
    problemWorktreeTones,
    keyboardItems,
  };
}
