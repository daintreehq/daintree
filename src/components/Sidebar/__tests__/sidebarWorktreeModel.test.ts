import { describe, expect, it } from "vitest";
import type { WorktreeState } from "@/types";
import type { DeletedWorktree } from "@/store/worktreeStore";
import type { StatusFilter } from "@/store/worktreeFilterStore";
import type { DerivedWorktreeMeta, QuickStateFilter } from "@/lib/worktreeFilters";
import { EMPTY_WORKTREE_AGENT_BUCKETS } from "@/lib/worktreeAgentBuckets";
import {
  buildSidebarFlatItems,
  filterSidebarWorktrees,
  type SidebarFlatItem,
  type SidebarWorktreeFilterInput,
} from "../sidebarWorktreeModel";

function makeWorktree(id: string, overrides: Partial<WorktreeState> = {}): WorktreeState {
  return {
    id,
    worktreeId: id,
    path: `/repo/${id}`,
    name: id,
    branch: `feature/${id}`,
    isCurrent: false,
    isMainWorktree: false,
    worktreeChanges: null,
    lastActivityTimestamp: null,
    ...overrides,
  };
}

function makeMeta(overrides: Partial<DerivedWorktreeMeta> = {}): DerivedWorktreeMeta {
  return {
    terminalCount: 0,
    hasAgent: false,
    hasWorkingAgent: false,
    hasWaitingAgent: false,
    hasCompletedAgent: false,
    hasExitedAgent: false,
    hasMergeConflict: false,
    buckets: EMPTY_WORKTREE_AGENT_BUCKETS,
    chipState: null,
    ...overrides,
  };
}

const WORKING_META = makeMeta({
  hasAgent: true,
  hasWorkingAgent: true,
  buckets: { ...EMPTY_WORKTREE_AGENT_BUCKETS, working: true },
});

const WAITING_META = makeMeta({
  hasAgent: true,
  hasWaitingAgent: true,
  buckets: { ...EMPTY_WORKTREE_AGENT_BUCKETS, attention: true },
});

function filterInput(
  worktrees: WorktreeState[],
  overrides: Partial<SidebarWorktreeFilterInput> = {}
): SidebarWorktreeFilterInput {
  return {
    deferredWorktrees: worktrees,
    nonMainWorktrees: worktrees,
    deferredQuery: "",
    orderBy: "manual",
    isGroupedByType: false,
    statusFilters: new Set(),
    typeFilters: new Set(),
    prIssueFilters: new Set(),
    sessionFilters: new Set(),
    hasAgentFilter: false,
    activityFilters: new Set(),
    devServerFilters: new Set(),
    devServerSessions: {},
    alwaysShowActive: false,
    alwaysShowWaiting: false,
    pinnedWorktrees: [],
    manualOrder: worktrees.map((w) => w.id),
    derivedMetaMap: new Map(),
    activeWorktreeId: null,
    quickStateFilter: "all",
    hasFacetFiltersActive: false,
    worktreeCustomTitles: {},
    ...overrides,
  };
}

function ids(worktrees: readonly WorktreeState[]): string[] {
  return worktrees.map((w) => w.id);
}

describe("filterSidebarWorktrees — quick-state counterfactual", () => {
  const alpha = makeWorktree("alpha");
  const beta = makeWorktree("beta");

  it("reports a match without the quick-state filter when only the quick state hides it", () => {
    const result = filterSidebarWorktrees(
      filterInput([alpha, beta], {
        quickStateFilter: "waiting",
        derivedMetaMap: new Map([["alpha", WORKING_META]]),
      })
    );

    expect(result.filteredWorktrees).toEqual([]);
    expect(result.hasResultsWithoutQuickState).toBe(true);
  });

  it("reports no match without the quick-state filter when the query hides everything too", () => {
    const result = filterSidebarWorktrees(
      filterInput([alpha, beta], { quickStateFilter: "waiting", deferredQuery: "zzz" })
    );

    expect(result.filteredWorktrees).toEqual([]);
    expect(result.hasResultsWithoutQuickState).toBe(false);
  });

  it("leaves the counterfactual false under 'all', even with every row visible", () => {
    const result = filterSidebarWorktrees(filterInput([alpha, beta]));

    expect(ids(result.filteredWorktrees)).toEqual(["alpha", "beta"]);
    expect(result.hasResultsWithoutQuickState).toBe(false);
  });

  it("filters and counts the non-main population, never the whole list", () => {
    const main = makeWorktree("main", { isMainWorktree: true });
    const result = filterSidebarWorktrees({
      ...filterInput([alpha, beta], {
        quickStateFilter: "working",
        derivedMetaMap: new Map([
          ["main", WORKING_META],
          ["beta", WORKING_META],
        ]),
      }),
      deferredWorktrees: [main, alpha, beta],
      manualOrder: ["main", "alpha", "beta"],
    });

    expect(ids(result.filteredWorktrees)).toEqual(["beta"]);
    expect(result.totalCount).toBe(2);
  });
});

describe("filterSidebarWorktrees — always-show bypasses", () => {
  // A query of spaces is no query, so nothing narrows the list; the bypasses
  // only matter once a quick-state filter narrows it.
  const active = makeWorktree("active");
  const waiting = makeWorktree("waiting-one");
  const idle = makeWorktree("idle");
  const worktrees = [active, waiting, idle];
  const derivedMetaMap = new Map([["waiting-one", WAITING_META]]);
  const bypassing: Partial<SidebarWorktreeFilterInput> = {
    deferredQuery: "   ",
    alwaysShowActive: true,
    alwaysShowWaiting: true,
    activeWorktreeId: "active",
    derivedMetaMap,
  };

  it("shows every worktree for a whitespace-only query", () => {
    const result = filterSidebarWorktrees(filterInput(worktrees, bypassing));

    expect(ids(result.filteredWorktrees)).toEqual(["active", "waiting-one", "idle"]);
  });

  it("drops the bypasses once a real query is typed", () => {
    const result = filterSidebarWorktrees(
      filterInput(worktrees, { ...bypassing, deferredQuery: "zzz" })
    );

    expect(result.filteredWorktrees).toEqual([]);
  });

  it("drops the bypasses while a facet filter is active", () => {
    const statusFilters = new Set<StatusFilter>(["dirty"]);
    const result = filterSidebarWorktrees(
      filterInput(worktrees, { ...bypassing, statusFilters, hasFacetFiltersActive: true })
    );

    expect(result.filteredWorktrees).toEqual([]);
  });

  it("drops the bypasses while a quick-state filter is narrowing", () => {
    const quickStateFilter: QuickStateFilter = "working";
    const result = filterSidebarWorktrees(
      filterInput(worktrees, { ...bypassing, quickStateFilter })
    );

    expect(result.filteredWorktrees).toEqual([]);
  });

  // The counterfactual asks whether "all" would show anything, so it applies
  // each bypass under the same query and facet gates the real pass uses. One
  // bypass at a time, so neither can stand in for the other.
  const onlyActive: Partial<SidebarWorktreeFilterInput> = {
    ...bypassing,
    alwaysShowWaiting: false,
  };
  const onlyWaiting: Partial<SidebarWorktreeFilterInput> = {
    ...bypassing,
    alwaysShowActive: false,
  };

  describe.each([
    ["active", onlyActive],
    ["waiting", onlyWaiting],
  ])("the %s bypass in the counterfactual", (_label, bypass) => {
    const narrowed: Partial<SidebarWorktreeFilterInput> = {
      ...bypass,
      quickStateFilter: "working",
    };

    it("reads a match the quick state is hiding", () => {
      const result = filterSidebarWorktrees(filterInput(worktrees, narrowed));

      expect(result.filteredWorktrees).toEqual([]);
      expect(result.hasResultsWithoutQuickState).toBe(true);
    });

    it("reads no match once a real query is typed", () => {
      const result = filterSidebarWorktrees(
        filterInput(worktrees, { ...narrowed, deferredQuery: "zzz" })
      );

      expect(result.hasResultsWithoutQuickState).toBe(false);
    });

    it("reads no match while a facet filter is active", () => {
      const result = filterSidebarWorktrees(
        filterInput(worktrees, {
          ...narrowed,
          statusFilters: new Set<StatusFilter>(["dirty"]),
          hasFacetFiltersActive: true,
        })
      );

      expect(result.hasResultsWithoutQuickState).toBe(false);
    });
  });
});

describe("filterSidebarWorktrees — grouping", () => {
  const featureA = makeWorktree("feature-a", { branch: "feature/a" });
  const bugfixB = makeWorktree("bugfix-b", { branch: "bugfix/b" });
  const featureC = makeWorktree("feature-c", { branch: "feature/c" });
  const worktrees = [featureA, bugfixB, featureC];

  it("keeps the filtered list in pre-grouping order while the sections regroup it", () => {
    const result = filterSidebarWorktrees(filterInput(worktrees, { isGroupedByType: true }));

    expect(ids(result.filteredWorktrees)).toEqual(["feature-a", "bugfix-b", "feature-c"]);
    const sectionOrder = (result.groupedSections ?? []).flatMap((s) => ids(s.worktrees));
    expect(sectionOrder).toHaveLength(3);
    expect(sectionOrder).not.toEqual(ids(result.filteredWorktrees));
  });

  it("skips the sections while a query is active", () => {
    const result = filterSidebarWorktrees(
      filterInput(worktrees, { isGroupedByType: true, deferredQuery: "feature" })
    );

    expect(result.groupedSections).toBeNull();
    expect(ids(result.filteredWorktrees).sort()).toEqual(["feature-a", "feature-c"]);
  });
});

function makeDeleted(id: string, overrides: Partial<DeletedWorktree> = {}): DeletedWorktree {
  return {
    id,
    title: id,
    path: `/repo/${id}`,
    deletedAt: 1,
    expiresAt: null,
    holdReason: null,
    pinnedBeforeWorktreeId: null,
    ...overrides,
  };
}

function rowSummary(items: SidebarFlatItem[]) {
  return items.map((item) =>
    item.kind === "row"
      ? { id: item.id, rowIndex: item.rowIndex, ariaRowIndex: item.ariaRowIndex }
      : { id: item.id, ariaRowIndex: item.ariaRowIndex }
  );
}

describe("buildSidebarFlatItems", () => {
  const featureA = makeWorktree("feature-a", { branch: "feature/a" });
  const bugfixB = makeWorktree("bugfix-b", { branch: "bugfix/b" });
  const featureC = makeWorktree("feature-c", { branch: "feature/c" });
  const filtered = [featureA, bugfixB, featureC];
  const order = ids(filtered);

  it("gives grouped rows their pre-grouping index and numbers ARIA rows in emitted order", () => {
    const { groupedSections } = filterSidebarWorktrees(
      filterInput(filtered, { isGroupedByType: true })
    );
    const items = buildSidebarFlatItems({
      groupedSections,
      filteredWorktrees: filtered,
      firstScrollableRowIndex: 2,
      pinnedWorktrees: [],
      dragStartOrder: order,
      deletedWorktrees: new Map(),
    });

    const sections = groupedSections ?? [];
    expect(sections.length).toBeGreaterThan(1);
    expect(items.map((item) => item.id)).toEqual(
      sections.flatMap((s) => [`header-${s.type}`, ...s.worktrees.map((w) => `row-${w.id}`)])
    );
    const rows = items.filter((item) => item.kind === "row");
    expect(rows.map((row) => [row.worktreeId, row.rowIndex, row.mode])).toEqual(
      sections.flatMap((s) => s.worktrees.map((w) => [w.id, order.indexOf(w.id), "static"]))
    );
    expect(items.map((item) => item.ariaRowIndex)).toEqual(items.map((_item, i) => i + 2));
  });

  it("inserts a deleted worktree before the live row it was anchored to", () => {
    const deleted = makeDeleted("gone", { pinnedBeforeWorktreeId: "bugfix-b" });
    const items = buildSidebarFlatItems({
      groupedSections: null,
      filteredWorktrees: filtered,
      firstScrollableRowIndex: 1,
      pinnedWorktrees: [],
      dragStartOrder: order,
      deletedWorktrees: new Map([["gone", deleted]]),
    });

    expect(rowSummary(items)).toEqual([
      { id: "row-feature-a", rowIndex: 0, ariaRowIndex: 1 },
      { id: "deleted-gone", ariaRowIndex: 2 },
      { id: "row-bugfix-b", rowIndex: 1, ariaRowIndex: 3 },
      { id: "row-feature-c", rowIndex: 2, ariaRowIndex: 4 },
    ]);
    // Flat rows are the sortable ones dnd-kit wraps.
    expect(items.flatMap((item) => (item.kind === "row" ? [item.mode] : []))).toEqual([
      "sortable",
      "sortable",
      "sortable",
    ]);
  });

  it("trails deleted worktrees after the sections in grouped mode", () => {
    const { groupedSections } = filterSidebarWorktrees(
      filterInput(filtered, { isGroupedByType: true })
    );
    const deleted = makeDeleted("gone", { pinnedBeforeWorktreeId: "bugfix-b" });
    const items = buildSidebarFlatItems({
      groupedSections,
      filteredWorktrees: filtered,
      firstScrollableRowIndex: 1,
      pinnedWorktrees: [],
      dragStartOrder: order,
      deletedWorktrees: new Map([["gone", deleted]]),
    });

    const sections = groupedSections ?? [];
    expect(items.map((item) => item.id)).toEqual([
      ...sections.flatMap((s) => [`header-${s.type}`, ...s.worktrees.map((w) => `row-${w.id}`)]),
      "deleted-gone",
    ]);
  });

  it("does not mark an external worktree pinned for a leftover pin entry", () => {
    const external = makeWorktree("outside", { isExternal: true });
    const items = buildSidebarFlatItems({
      groupedSections: null,
      filteredWorktrees: [featureA, external],
      firstScrollableRowIndex: 1,
      pinnedWorktrees: ["feature-a", "outside"],
      dragStartOrder: ["feature-a", "outside"],
      deletedWorktrees: new Map(),
    });

    const pinned = items.flatMap((item) =>
      item.kind === "row" ? [[item.worktreeId, item.isPinned] as const] : []
    );
    expect(pinned).toEqual([
      ["feature-a", true],
      ["outside", false],
    ]);
  });
});
