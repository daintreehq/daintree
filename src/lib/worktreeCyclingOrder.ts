import type { WorktreeSnapshot, WorktreeState } from "@shared/types";
import { usePanelStore } from "@/store/panelStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { computeChipState } from "@/components/Worktree/utils/computeChipState";
import type { WorktreeLifecycleStage } from "@/components/Worktree/WorktreeCard/hooks/useWorktreeStatus";
import {
  findIntegrationWorktree,
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
  panelIds: ReturnType<typeof usePanelStore.getState>["panelIds"]
): DerivedWorktreeMeta {
  let terminalCount = 0;
  let waitingTerminalCount = 0;
  let hasWorkingAgent = false;
  let hasRunningAgent = false;
  let hasWaitingAgent = false;
  let hasCompletedAgent = false;
  let hasExitedAgent = false;

  for (const id of panelIds) {
    const t = panelsById[id];
    if (!t || t.worktreeId !== worktree.id || t.location === "trash") continue;
    terminalCount++;
    if (t.agentState === "working") hasWorkingAgent = true;
    if (t.agentState === "running") hasRunningAgent = true;
    if (t.agentState === "waiting") {
      hasWaitingAgent = true;
      waitingTerminalCount++;
    }
    if (t.agentState === "completed") hasCompletedAgent = true;
    if (t.agentState === "exited") hasExitedAgent = true;
  }

  const hasChanges = (worktree.worktreeChanges?.changedFileCount ?? 0) > 0;
  const isComplete =
    !!worktree.issueNumber &&
    !!worktree.prNumber &&
    !hasChanges &&
    worktree.worktreeChanges !== null;

  let lifecycleStage: WorktreeLifecycleStage | null = null;
  if (!worktree.isMainWorktree && worktree.worktreeChanges !== null) {
    if (worktree.prState === "merged") {
      lifecycleStage = worktree.issueNumber ? "ready-for-cleanup" : "merged";
    } else if (worktree.prState === "open") {
      lifecycleStage = "in-review";
    }
  }

  const chipState = computeChipState({
    waitingTerminalCount,
    lifecycleStage,
    isComplete,
    hasActiveAgent: hasWorkingAgent || hasRunningAgent,
  });

  return {
    terminalCount,
    hasWorkingAgent,
    hasRunningAgent,
    hasWaitingAgent,
    hasCompletedAgent,
    hasExitedAgent,
    hasMergeConflict:
      worktree.worktreeChanges?.changes.some((c) => c.status === "conflicted") ?? false,
    chipState,
  };
}

function worktreeMatchesQuery(worktree: WorktreeState, query: string): boolean {
  if (!query) return true;
  const exactNum = parseExactNumber(query);
  if (exactNum !== null) {
    return worktree.issueNumber === exactNum || worktree.prNumber === exactNum;
  }
  return scoreWorktree(worktree, query) > 0;
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
    query,
    orderBy,
    groupByType: isGroupedByType,
    statusFilters,
    typeFilters,
    githubFilters,
    sessionFilters,
    activityFilters,
    alwaysShowActive,
    alwaysShowWaiting,
    pinnedWorktrees,
    manualOrder,
    quickStateFilter,
  } = filterState;

  const viewState = getCurrentViewStore().getState();
  const rawWorktrees = Array.from(viewState.worktrees.values())
    .map(normalizeSnapshot)
    // Pre-sort to match `useWorktrees()` so the fallback main worktree
    // (when no `isMainWorktree===true` entry exists) resolves to the same
    // element the sidebar would render.
    .sort((a, b) => {
      if (a.isMainWorktree && !b.isMainWorktree) return -1;
      if (!a.isMainWorktree && b.isMainWorktree) return 1;
      const timeA = a.lastActivityTimestamp ?? 0;
      const timeB = b.lastActivityTimestamp ?? 0;
      if (timeA !== timeB) return timeB - timeA;
      return a.name.localeCompare(b.name);
    });
  if (rawWorktrees.length === 0) return [];

  const panelState = usePanelStore.getState();
  const derivedMetaMap = new Map<string, DerivedWorktreeMeta>();
  for (const worktree of rawWorktrees) {
    derivedMetaMap.set(
      worktree.id,
      buildDerivedMeta(worktree, panelState.panelsById, panelState.panelIds)
    );
  }

  const mainWorktree = rawWorktrees.find((w) => w.isMainWorktree) ?? rawWorktrees[0] ?? null;
  const integrationWorktree = findIntegrationWorktree(rawWorktrees, mainWorktree?.id);

  const filters: FilterState = {
    query,
    statusFilters,
    typeFilters,
    githubFilters,
    sessionFilters,
    activityFilters,
  };

  const nonMain = rawWorktrees.filter(
    (w) => w.id !== mainWorktree?.id && w.id !== integrationWorktree?.id
  );

  const filtered = nonMain.filter((worktree) => {
    const derived = derivedMetaMap.get(worktree.id);
    if (!derived) return false;
    const isActive = worktree.id === activeWorktreeId;
    const hasActiveQuery = query.trim().length > 0;

    if (alwaysShowActive && isActive && !hasActiveQuery && quickStateFilter === "all") {
      return true;
    }
    if (
      alwaysShowWaiting &&
      derived.hasWaitingAgent &&
      !hasActiveQuery &&
      quickStateFilter === "all"
    ) {
      return true;
    }
    if (quickStateFilter !== "all" && !matchesQuickStateFilter(quickStateFilter, derived)) {
      return false;
    }
    return matchesFilters(worktree, filters, derived, isActive);
  });

  const existingIds = new Set(rawWorktrees.map((w) => w.id));
  const validPinnedWorktrees = pinnedWorktrees.filter((id) => existingIds.has(id));

  const hasQuery = query.trim().length > 0;
  const sortedNonMain = hasQuery
    ? sortWorktreesByRelevance(filtered, query, orderBy, validPinnedWorktrees, manualOrder)
    : sortWorktrees(filtered, orderBy, validPinnedWorktrees, manualOrder);

  // Match sidebar's grouped rendering: when grouped-by-type is on and
  // there is no query, the user sees groups flattened in TYPE_ORDER.
  const scrollableList =
    isGroupedByType && !hasQuery
      ? groupByType(sortedNonMain, orderBy, validPinnedWorktrees).flatMap((s) => s.worktrees)
      : sortedNonMain;

  const topPinned: WorktreeState[] = [];
  if (mainWorktree && worktreeMatchesQuery(mainWorktree, query)) {
    topPinned.push(mainWorktree);
  }
  if (integrationWorktree && worktreeMatchesQuery(integrationWorktree, query)) {
    topPinned.push(integrationWorktree);
  }

  return [...topPinned, ...scrollableList];
}
