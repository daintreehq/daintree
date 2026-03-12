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
    alwaysShowWaiting: true,
    hideMainWorktree: false,
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

  it("shows main worktree by default (hideMainWorktree is false)", () => {
    expect(useWorktreeFilterStore.getState().hideMainWorktree).toBe(false);
  });

  it("toggles hideMainWorktree on and off", () => {
    const store = useWorktreeFilterStore.getState();

    store.setHideMainWorktree(true);
    expect(useWorktreeFilterStore.getState().hideMainWorktree).toBe(true);

    store.setHideMainWorktree(false);
    expect(useWorktreeFilterStore.getState().hideMainWorktree).toBe(false);
  });

  it("resets hideMainWorktree to false on clearAll", () => {
    useWorktreeFilterStore.getState().setHideMainWorktree(true);
    useWorktreeFilterStore.getState().clearAll();

    expect(useWorktreeFilterStore.getState().hideMainWorktree).toBe(false);
  });

  it("defaults alwaysShowWaiting to true", () => {
    expect(useWorktreeFilterStore.getState().alwaysShowWaiting).toBe(true);
  });

  it("toggles alwaysShowWaiting via setter", () => {
    useWorktreeFilterStore.getState().setAlwaysShowWaiting(false);
    expect(useWorktreeFilterStore.getState().alwaysShowWaiting).toBe(false);

    useWorktreeFilterStore.getState().setAlwaysShowWaiting(true);
    expect(useWorktreeFilterStore.getState().alwaysShowWaiting).toBe(true);
  });

  it("does not reset alwaysShowWaiting on clearAll", () => {
    useWorktreeFilterStore.getState().setAlwaysShowWaiting(false);
    useWorktreeFilterStore.getState().clearAll();

    expect(useWorktreeFilterStore.getState().alwaysShowWaiting).toBe(false);
  });
});
