import { beforeEach, describe, expect, it } from "vitest";
import { useWorktreeFilterStore } from "../worktreeFilterStore";

function resetWorktreeFilterStore() {
  useWorktreeFilterStore.setState({
    query: "",
    orderBy: "created",
    groupByType: false,
    statusFilters: new Set(),
    typeFilters: new Set(),
    githubFilters: new Set(),
    sessionFilters: new Set(),
    activityFilters: new Set(),
    alwaysShowActive: true,
    hideMainWorktree: true,
    pinnedWorktrees: [],
  });
}

describe("worktreeFilterStore", () => {
  beforeEach(() => {
    resetWorktreeFilterStore();
  });

  it("does not duplicate pinned worktree ids", () => {
    useWorktreeFilterStore.getState().pinWorktree("wt-1");
    useWorktreeFilterStore.getState().pinWorktree("wt-1");
    useWorktreeFilterStore.getState().pinWorktree("wt-2");

    expect(useWorktreeFilterStore.getState().pinnedWorktrees).toEqual(["wt-1", "wt-2"]);
  });

  it("tracks active filter count across filter buckets", () => {
    const store = useWorktreeFilterStore.getState();
    store.setQuery("abc");
    store.toggleStatusFilter("active");
    store.toggleGitHubFilter("hasIssue");

    expect(useWorktreeFilterStore.getState().getActiveFilterCount()).toBe(3);
    expect(useWorktreeFilterStore.getState().hasActiveFilters()).toBe(true);
  });

  it("treats whitespace-only query as inactive", () => {
    useWorktreeFilterStore.getState().setQuery("   ");

    expect(useWorktreeFilterStore.getState().hasActiveFilters()).toBe(false);
    expect(useWorktreeFilterStore.getState().getActiveFilterCount()).toBe(0);
  });
});
