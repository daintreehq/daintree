import type { WorktreeSnapshot, WorktreeState } from "@shared/types";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useWorktreeDevServerStore } from "@/store/worktreeDevServerStore";
import { computeChipState } from "@/components/Worktree/utils/computeChipState";
import {
  deriveWorktreeAgentBuckets,
  EMPTY_WORKTREE_AGENT_BUCKETS,
  isWorktreeMergedForCleanup,
} from "@/lib/worktreeAgentBuckets";
import {
  readWorktreeAgentBucketInputs,
  type WorktreeAgentBucketInputs,
} from "@/hooks/useWorktreeAgentBucketInputs";
import {
  compareWorktreeNames,
  groupByType,
  matchesFilters,
  matchesQuickStateFilter,
  scoreWorktree,
  sortWorktrees,
  sortWorktreesByRelevance,
  type DerivedWorktreeMeta,
  type FilterState,
} from "@/lib/worktreeFilters";
import { parseExactNumber } from "@/lib/parseExactNumber";
import { isTerminalVisible } from "@/lib/terminalVisibility";
import { isAgentTerminal } from "@/utils/terminalType";
import { isValidPastTimestamp } from "@/utils/timestamps";

function normalizeSnapshot(snap: WorktreeSnapshot): WorktreeState {
  return {
    ...snap,
    worktreeChanges: snap.worktreeChanges ?? null,
    lastActivityTimestamp: snap.lastActivityTimestamp ?? null,
  } as WorktreeState;
}

function buildDerivedMeta(
  worktree: WorktreeState,
  panelsById: ReturnType<typeof usePanelStore.getState>["panelsById"],
  // This worktree's bucket from `panelIdsByWorktreeId` — iterating it instead
  // of every panel keeps the per-worktree rollup O(own panels), matching
  // `computePanelStateByWorktree` in sidebarPanelDerivation.ts. Bucket
  // membership is equivalent to the previous `t.worktreeId === worktree.id`
  // scan over all panel ids.
  worktreePanelIds: readonly string[] | undefined,
  isInTrash: (id: string) => boolean,
  worktreeIds: Set<string>,
  bucketInputs: WorktreeAgentBucketInputs
): DerivedWorktreeMeta {
  let terminalCount = 0;
  let hasAgent = false;
  let hasWorkingAgent = false;
  let hasWaitingAgent = false;
  let hasCompletedAgent = false;
  let hasExitedAgent = false;
  const agentIds: string[] = [];

  for (const id of worktreePanelIds ?? []) {
    const t = panelsById[id];
    if (!t || !isTerminalVisible(t, isInTrash, worktreeIds)) continue;
    terminalCount++;
    if (!isAgentTerminal(t)) continue;
    if (!isPtyPanel(t)) continue;
    hasAgent = true;
    agentIds.push(id);
    if (t.agentState === "working") hasWorkingAgent = true;
    if (t.agentState === "waiting") hasWaitingAgent = true;
    if (t.agentState === "completed") hasCompletedAgent = true;
    if (t.agentState === "exited") hasExitedAgent = true;
  }

  const buckets = deriveWorktreeAgentBuckets(
    agentIds,
    bucketInputs.runsById,
    isWorktreeMergedForCleanup(worktree)
  );

  return {
    terminalCount,
    hasAgent,
    hasWorkingAgent,
    hasWaitingAgent,
    hasCompletedAgent,
    hasExitedAgent,
    hasMergeConflict:
      worktree.worktreeChanges?.changes.some((c) => c.status === "conflicted") ?? false,
    buckets,
    chipState: computeChipState(buckets),
  };
}

function worktreeMatchesQuery(
  worktree: WorktreeState,
  query: string,
  customTitle: string | undefined
): boolean {
  if (!query) return true;
  const exactNum = parseExactNumber(query);
  if (exactNum !== null) {
    return worktree.issueNumber === exactNum || worktree.linked?.pr?.ref.number === exactNum;
  }
  return scoreWorktree(worktree, query, customTitle) > 0;
}

/**
 * Returns worktrees in the exact order the sidebar renders them.
 *
 * Mirrors the `filteredWorktrees` memo in `SidebarContent.tsx` so that
 * cycle/index-jump keybindings walk the same list the user sees.
 *
 * Call this inside action `run()` bodies — each call reads fresh state
 * from the filter, view, and panel stores at dispatch time.
 */
export function getVisibleWorktreesForCycling(
  activeWorktreeId: string | null | undefined = undefined
): WorktreeState[] {
  const filterState = useWorktreeFilterStore.getState();
  const {
    // Use the instant `liveQuery` so cycling walks the same list the user sees,
    // not the debounced persisted `query` that lags ~500ms behind typing.
    liveQuery: query,
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
    worktreeCustomTitles: customTitles,
  } = filterState;

  const devServerSessions = useWorktreeDevServerStore.getState().sessionsByWorktreeId;

  const viewState = getCurrentViewStore().getState();
  const now = Date.now();
  const rawWorktrees = Array.from(viewState.worktrees.values())
    .map(normalizeSnapshot)
    // Pre-sort to match `useWorktrees()` so the fallback main worktree
    // (when no `isMainWorktree===true` entry exists) resolves to the same
    // element the sidebar would render.
    .sort((a, b) => {
      if (a.isMainWorktree && !b.isMainWorktree) return -1;
      if (!a.isMainWorktree && b.isMainWorktree) return 1;
      const timeA = isValidPastTimestamp(a.lastActivityTimestamp, now)
        ? a.lastActivityTimestamp
        : 0;
      const timeB = isValidPastTimestamp(b.lastActivityTimestamp, now)
        ? b.lastActivityTimestamp
        : 0;
      if (timeA !== timeB) return timeB - timeA;
      return compareWorktreeNames(a.name, b.name);
    });
  if (rawWorktrees.length === 0) return [];

  const panelState = usePanelStore.getState();
  const validWorktreeIds = new Set<string>();
  for (const wt of rawWorktrees) {
    validWorktreeIds.add(wt.id);
    if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
  }
  const derivedMetaMap = new Map<string, DerivedWorktreeMeta>();
  const bucketInputs = readWorktreeAgentBucketInputs();
  for (const worktree of rawWorktrees) {
    derivedMetaMap.set(
      worktree.id,
      buildDerivedMeta(
        worktree,
        panelState.panelsById,
        panelState.panelIdsByWorktreeId[worktree.id],
        panelState.isInTrash,
        validWorktreeIds,
        bucketInputs
      )
    );
  }

  const mainWorktree = rawWorktrees.find((w) => w.isMainWorktree) ?? rawWorktrees[0] ?? null;

  const filters: FilterState = {
    query,
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    hasAgentFilter,
    activityFilters,
    devServerFilters,
    customTitles,
  };

  const hasFacetFiltersActive = filterState.hasFacetFilters();

  const nonMain = rawWorktrees.filter((w) => w.id !== mainWorktree?.id);

  const filtered = nonMain.filter((worktree) => {
    const derived = derivedMetaMap.get(worktree.id);
    if (!derived) return false;
    const isActive = worktree.id === activeWorktreeId;
    const hasActiveQuery = query.trim().length > 0;

    if (
      alwaysShowActive &&
      isActive &&
      !hasActiveQuery &&
      quickStateFilter === "all" &&
      !hasFacetFiltersActive
    ) {
      return true;
    }
    if (
      alwaysShowWaiting &&
      derived.hasWaitingAgent &&
      !hasActiveQuery &&
      quickStateFilter === "all" &&
      !hasFacetFiltersActive
    ) {
      return true;
    }
    if (quickStateFilter !== "all" && !matchesQuickStateFilter(quickStateFilter, derived)) {
      return false;
    }
    return matchesFilters(worktree, filters, derived, isActive, devServerSessions);
  });

  const existingIds = new Set(rawWorktrees.map((w) => w.id));
  const validPinnedWorktrees = pinnedWorktrees.filter((id) => existingIds.has(id));

  const hasQuery = query.trim().length > 0;
  const sortedNonMain = hasQuery
    ? sortWorktreesByRelevance(
        filtered,
        query,
        orderBy,
        validPinnedWorktrees,
        manualOrder,
        customTitles
      )
    : sortWorktrees(filtered, orderBy, validPinnedWorktrees, manualOrder);

  // Match sidebar's grouped rendering: when grouped-by-type is on and
  // there is no query, the user sees groups flattened in WORKTREE_TYPE_IDS order.
  const scrollableList =
    isGroupedByType && !hasQuery
      ? groupByType(sortedNonMain, orderBy, validPinnedWorktrees).flatMap((s) => s.worktrees)
      : sortedNonMain;

  const topPinned: WorktreeState[] = [];
  if (mainWorktree && worktreeMatchesQuery(mainWorktree, query, customTitles[mainWorktree.id])) {
    const mainDerived = derivedMetaMap.get(mainWorktree.id) ?? {
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
    if (
      !hasFacetFiltersActive ||
      matchesFilters(
        mainWorktree,
        filters,
        mainDerived,
        mainWorktree.id === activeWorktreeId,
        devServerSessions
      )
    ) {
      topPinned.push(mainWorktree);
    }
  }
  return [...topPinned, ...scrollableList];
}
