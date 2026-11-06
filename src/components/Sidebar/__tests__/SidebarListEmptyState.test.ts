import { describe, it, expect } from "vitest";
import {
  resolveSidebarListEmpty,
  sidebarListEmptyTitle,
  type SidebarListEmpty,
} from "../SidebarListEmptyState";

type ResolveInput = Parameters<typeof resolveSidebarListEmpty>[0];

function resolve(overrides: Partial<ResolveInput>): SidebarListEmpty | null {
  return resolveSidebarListEmpty({
    filteredCount: 0,
    hasNonMainWorktrees: true,
    quickStateFilter: "all",
    hasQuery: false,
    hasFacets: false,
    resultsWithoutQuickStateCount: 0,
    mainVisible: false,
    mainInQuickState: false,
    displayQuery: "",
    ...overrides,
  });
}

describe("resolveSidebarListEmpty", () => {
  it("is null while the list has rows, or with no other worktrees and main on screen or unfiltered", () => {
    expect(resolve({ filteredCount: 2, quickStateFilter: "working" })).toBeNull();
    expect(
      resolve({ hasNonMainWorktrees: false, quickStateFilter: "working", mainVisible: true })
    ).toBeNull();
    expect(resolve({ hasNonMainWorktrees: false })).toBeNull();
  });

  it("explains an empty sidebar when a filter hid the only worktree, main", () => {
    // Main obeys the quick state and the search now, so with no other
    // worktrees a filter can empty the sidebar entirely; the empty state is
    // the only way back.
    expect(resolve({ hasNonMainWorktrees: false, quickStateFilter: "working" })).toEqual({
      kind: "drained",
      bucket: "working",
      mainInBucket: false,
    });
    expect(resolve({ hasNonMainWorktrees: false, hasQuery: true, displayQuery: "zzz" })).toEqual({
      kind: "no-match",
      query: "zzz",
      hasFacets: false,
      mainVisible: false,
    });
    expect(resolve({ hasNonMainWorktrees: false, hasFacets: true })).toEqual(
      expect.objectContaining({ kind: "no-match", hasFacets: true })
    );
  });

  it("reads a state tab with no search or facet as drained, whatever the counterfactual", () => {
    expect(resolve({ quickStateFilter: "finished", resultsWithoutQuickStateCount: 4 })).toEqual({
      kind: "drained",
      bucket: "finished",
      mainInBucket: false,
    });
  });

  it("reads a tab that hides a search's matches as hidden-by-tab, with how many", () => {
    expect(
      resolve({
        quickStateFilter: "working",
        hasQuery: true,
        displayQuery: "auth",
        resultsWithoutQuickStateCount: 3,
        mainVisible: true,
      })
    ).toEqual({ kind: "hidden-by-tab", bucket: "working", hiddenCount: 3, mainVisible: true });
  });

  it("reads a narrowed list with no match in any state as no-match, on a tab or on All", () => {
    const onTab = resolve({ quickStateFilter: "waiting", hasFacets: true });
    const onAll = resolve({ hasQuery: true, displayQuery: "  zzz  " });

    expect(onTab).toEqual({ kind: "no-match", query: "", hasFacets: true, mainVisible: false });
    expect(onAll).toEqual({ kind: "no-match", query: "zzz", hasFacets: false, mainVisible: false });
  });

  it("still explains the list when the main card is the only match", () => {
    expect(resolve({ quickStateFilter: "working", hasQuery: true, mainVisible: true })).toEqual(
      expect.objectContaining({ kind: "no-match", mainVisible: true })
    );
  });

  it("is null on an unnarrowed All tab, which can only be empty with no worktrees", () => {
    expect(resolve({})).toBeNull();
  });
});

describe("sidebarListEmptyTitle", () => {
  it("names the bucket for a drained tab, and the main worktree when it is the one in it", () => {
    const drained = sidebarListEmptyTitle({
      kind: "drained",
      bucket: "working",
      mainInBucket: false,
    });
    const mainOnly = sidebarListEmptyTitle({
      kind: "drained",
      bucket: "working",
      mainInBucket: true,
    });

    expect(drained).not.toBe(mainOnly);
    expect(mainOnly).toMatch(/main worktree/);
  });

  it("counts hidden matches with the right noun, and says 'more' beside a matching main card", () => {
    const one = sidebarListEmptyTitle({
      kind: "hidden-by-tab",
      bucket: "waiting",
      hiddenCount: 1,
      mainVisible: false,
    });
    const many = sidebarListEmptyTitle({
      kind: "hidden-by-tab",
      bucket: "working",
      hiddenCount: 3,
      mainVisible: true,
    });

    expect(one).toBe("1 match outside Attention");
    expect(many).toBe("3 more matches outside Working");
  });

  it("names the query and the filters a miss came from, and says 'other' beside main", () => {
    expect(
      sidebarListEmptyTitle({
        kind: "no-match",
        query: "plugin",
        hasFacets: true,
        mainVisible: false,
      })
    ).toBe('No matches for "plugin" with these filters');
    expect(
      sidebarListEmptyTitle({
        kind: "no-match",
        query: "main",
        hasFacets: false,
        mainVisible: true,
      })
    ).toBe('No other matches for "main"');
    expect(
      sidebarListEmptyTitle({ kind: "no-match", query: "", hasFacets: true, mainVisible: false })
    ).toBe("No worktrees match these filters");
  });

  it("truncates a long query to 40 characters", () => {
    const title = sidebarListEmptyTitle({
      kind: "no-match",
      query: "x".repeat(60),
      hasFacets: false,
      mainVisible: false,
    });

    expect(title).toBe(`No matches for "${"x".repeat(40)}…"`);
  });
});
