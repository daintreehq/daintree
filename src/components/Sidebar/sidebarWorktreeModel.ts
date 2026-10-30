import type { WorktreeState } from "@/types";
import type { DeletedWorktree } from "@/store/worktreeStore";
import type { OrderBy } from "@/store/worktreeFilterStore";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import { planDeletedWorktreePlacement } from "./deletedWorktreePlacement";
import {
  matchesFilters,
  matchesQuickStateFilter,
  orderWorktreesLikeSidebar,
  sortWorktreesByRelevance,
  groupByType,
  isExternalWorktree,
  type DerivedWorktreeMeta,
  type FilterState,
  type GroupedSection,
  type QuickStateFilter,
} from "@/lib/worktreeFilters";
import { EMPTY_WORKTREE_AGENT_BUCKETS } from "@/lib/worktreeAgentBuckets";

export interface SidebarHeaderFlatItem {
  kind: "header";
  id: string;
  type: string;
  displayName: string;
  count: number;
  ariaRowIndex: number;
}

export interface SidebarRowFlatItem {
  kind: "row";
  id: string;
  worktreeId: string;
  ariaRowIndex: number;
  rowIndex: number;
  isPinned: boolean;
  mode: "sortable" | "static";
}

export interface SidebarDeletedWorktreeFlatItem {
  kind: "deletedWorktree";
  id: string;
  worktree: DeletedWorktree;
  ariaRowIndex: number;
}

/**
 * Several deleted worktrees collapsed behind one summary row (#11260). One
 * Virtuoso item regardless of expansion — the member cards render inside it —
 * so it spans a variable number of ARIA rows while occupying a single index.
 */
export interface SidebarDeletedWorktreeGroupFlatItem {
  kind: "deletedWorktreeGroup";
  id: string;
  worktrees: DeletedWorktree[];
  ariaRowIndex: number;
}

export type SidebarFlatItem =
  | SidebarHeaderFlatItem
  | SidebarRowFlatItem
  | SidebarDeletedWorktreeFlatItem
  | SidebarDeletedWorktreeGroupFlatItem;

export interface SidebarWorktreeFilterInput {
  deferredWorktrees: readonly WorktreeState[];
  nonMainWorktrees: readonly WorktreeState[];
  deferredQuery: string;
  orderBy: OrderBy;
  isGroupedByType: boolean;
  statusFilters: FilterState["statusFilters"];
  typeFilters: FilterState["typeFilters"];
  prIssueFilters: FilterState["prIssueFilters"];
  sessionFilters: FilterState["sessionFilters"];
  hasAgentFilter: boolean;
  activityFilters: FilterState["activityFilters"];
  devServerFilters: FilterState["devServerFilters"];
  devServerSessions: Record<string, DevPreviewSessionState>;
  alwaysShowActive: boolean;
  alwaysShowWaiting: boolean;
  pinnedWorktrees: string[];
  manualOrder: string[];
  derivedMetaMap: Map<string, DerivedWorktreeMeta>;
  activeWorktreeId: string | null;
  quickStateFilter: QuickStateFilter;
  hasFacetFiltersActive: boolean;
  worktreeCustomTitles: Record<string, string>;
}

export interface SidebarWorktreeFilterResult {
  filteredWorktrees: WorktreeState[];
  groupedSections: GroupedSection<WorktreeState>[] | null;
  hasResultsWithoutQuickState: boolean;
  /** How many worktrees the quick-state tab alone is hiding; 0 when it is "all". */
  resultsWithoutQuickStateCount: number;
  totalCount: number;
}

export function filterSidebarWorktrees({
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
}: SidebarWorktreeFilterInput): SidebarWorktreeFilterResult {
  const filters: FilterState = {
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

  let withoutQuickStateCount = 0;
  const filtered = nonMainWorktrees.filter((worktree) => {
    const derived = derivedMetaMap.get(worktree.id) ?? {
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
    const isActive = worktree.id === activeWorktreeId;
    const hasActiveQuery = deferredQuery.trim().length > 0;

    // Counterfactual: would this worktree be visible if the quick state
    // filter were "all"? Mirrors the same precedence below (active /
    // waiting bypasses → matchesFilters), with quickStateFilter forced
    // to "all". Counted rather than short-circuited: an empty tab that is
    // hiding a search's matches says how many it is hiding.
    if (quickStateFilter !== "all") {
      if (alwaysShowActive && isActive && !hasActiveQuery && !hasFacetFiltersActive) {
        withoutQuickStateCount++;
      } else if (
        alwaysShowWaiting &&
        derived.hasWaitingAgent &&
        !hasActiveQuery &&
        !hasFacetFiltersActive
      ) {
        withoutQuickStateCount++;
      } else if (matchesFilters(worktree, filters, derived, isActive, devServerSessions)) {
        withoutQuickStateCount++;
      }
    }

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

  const existingWorktreeIds = new Set(deferredWorktrees.map((w) => w.id));
  const validPinnedWorktrees = pinnedWorktrees.filter((id) => existingWorktreeIds.has(id));

  const hasQuery = deferredQuery.trim().length > 0;
  const sorted = hasQuery
    ? sortWorktreesByRelevance(
        filtered,
        deferredQuery,
        orderBy,
        validPinnedWorktrees,
        manualOrder,
        worktreeCustomTitles
      )
    : // `groupByType: false` on purpose. The sections are built separately
      // below, because `filteredWorktrees` has to stay the pre-grouping
      // array: row indices and the deleted-worktree anchors are positions
      // in it, not in the flattened section order.
      orderWorktreesLikeSidebar(filtered, {
        orderBy,
        groupByType: false,
        pinnedWorktrees: validPinnedWorktrees,
        manualOrder,
      });

  if (isGroupedByType && !hasQuery) {
    return {
      filteredWorktrees: sorted,
      groupedSections: groupByType(sorted, orderBy, validPinnedWorktrees),
      hasResultsWithoutQuickState: withoutQuickStateCount > 0,
      resultsWithoutQuickStateCount: withoutQuickStateCount,
      totalCount: nonMainWorktrees.length,
    };
  }

  return {
    filteredWorktrees: sorted,
    groupedSections: null,
    hasResultsWithoutQuickState: withoutQuickStateCount > 0,
    resultsWithoutQuickStateCount: withoutQuickStateCount,
    totalCount: nonMainWorktrees.length,
  };
}

export interface SidebarFlatItemsInput {
  groupedSections: GroupedSection<WorktreeState>[] | null;
  filteredWorktrees: readonly WorktreeState[];
  firstScrollableRowIndex: number;
  pinnedWorktrees: readonly string[];
  dragStartOrder: readonly string[];
  deletedWorktrees: ReadonlyMap<string, DeletedWorktree>;
}

export function buildSidebarFlatItems({
  groupedSections,
  filteredWorktrees,
  firstScrollableRowIndex,
  pinnedWorktrees,
  dragStartOrder,
  deletedWorktrees,
}: SidebarFlatItemsInput): SidebarFlatItem[] {
  const items: SidebarFlatItem[] = [];
  const pinnedSet = new Set(pinnedWorktrees);
  // External worktrees sort below the pinned area regardless of a leftover pin
  // entry, so their rows must not claim pinned affordances either (#11434).
  const isRowPinned = (w: WorktreeState) => pinnedSet.has(w.id) && !isExternalWorktree(w);
  let nextRowIndex = firstScrollableRowIndex;

  // Deleted worktrees anchor their row to the live neighbour it sat above
  // when it was deleted, so the terminals the user is looking for stay where
  // they left them instead of jumping to an edge of the list (#11232). Ties
  // and gone anchors fall back to deletion order / trailing for a stable
  // render. `dragStartOrder` is the live filtered id order.
  const deletedList = Array.from(deletedWorktrees.values()).sort(
    (a, b) => a.deletedAt - b.deletedAt
  );
  const {
    isGrouped,
    groupSlot,
    byIndex: deletedByIndex,
    trailing: trailingDeleted,
  } = planDeletedWorktreePlacement(deletedList, dragStartOrder);
  const hasGroupSlot = groupSlot >= 0;
  const pushDeleted = (deleted: DeletedWorktree) => {
    items.push({
      kind: "deletedWorktree",
      id: `deleted-${deleted.id}`,
      worktree: deleted,
      ariaRowIndex: nextRowIndex++,
    });
  };
  const pushDeletedGroup = () => {
    items.push({
      kind: "deletedWorktreeGroup",
      id: "deleted-worktree-group",
      worktrees: deletedList,
      ariaRowIndex: nextRowIndex++,
    });
  };

  if (groupedSections) {
    const orderIndex = new Map(dragStartOrder.map((id, i) => [id, i]));
    for (const section of groupedSections) {
      items.push({
        kind: "header",
        id: `header-${section.type}`,
        type: section.type,
        displayName: section.displayName,
        count: section.worktrees.length,
        ariaRowIndex: nextRowIndex++,
      });
      for (const w of section.worktrees) {
        items.push({
          kind: "row",
          id: `row-${w.id}`,
          worktreeId: w.id,
          ariaRowIndex: nextRowIndex++,
          rowIndex: orderIndex.get(w.id) ?? -1,
          isPinned: isRowPinned(w),
          mode: "static",
        });
      }
    }
    // Type grouping has no slot for a worktree that no longer has a type to
    // group by, so deleted rows collect at the end rather than inventing a
    // section for them. Piling up there is exactly what made a burst
    // unreadable, so the group summary matters most in this path.
    if (isGrouped) pushDeletedGroup();
    else for (const deleted of deletedList) pushDeleted(deleted);
    return items;
  }

  for (let i = 0; i < filteredWorktrees.length; i++) {
    if (hasGroupSlot && i === groupSlot) pushDeletedGroup();
    if (!isGrouped) for (const deleted of deletedByIndex.get(i) ?? []) pushDeleted(deleted);
    const w = filteredWorktrees[i]!;
    items.push({
      kind: "row",
      id: `row-${w.id}`,
      worktreeId: w.id,
      ariaRowIndex: nextRowIndex++,
      rowIndex: i,
      isPinned: isRowPinned(w),
      mode: "sortable",
    });
  }
  if (isGrouped) {
    if (!hasGroupSlot) pushDeletedGroup();
  } else {
    for (const deleted of trailingDeleted) pushDeleted(deleted);
  }
  return items;
}
