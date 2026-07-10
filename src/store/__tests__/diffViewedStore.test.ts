import { describe, expect, it, beforeEach } from "vitest";
import { useDiffViewedStore, selectViewedSet } from "../diffViewedStore";

describe("diffViewedStore", () => {
  beforeEach(() => {
    useDiffViewedStore.setState({ viewedByWorktree: {} });
  });

  it("marks and unmarks keys per worktree", () => {
    const { setViewed } = useDiffViewedStore.getState();
    setViewed("/wt-a", "staged:src/a.ts", true);
    setViewed("/wt-b", "staged:src/a.ts", true);

    expect(selectViewedSet(useDiffViewedStore.getState(), "/wt-a").has("staged:src/a.ts")).toBe(
      true
    );
    setViewed("/wt-a", "staged:src/a.ts", false);
    expect(selectViewedSet(useDiffViewedStore.getState(), "/wt-a").has("staged:src/a.ts")).toBe(
      false
    );
    // The other worktree's marker is untouched.
    expect(selectViewedSet(useDiffViewedStore.getState(), "/wt-b").has("staged:src/a.ts")).toBe(
      true
    );
  });

  it("toggleViewed flips membership", () => {
    const { toggleViewed } = useDiffViewedStore.getState();
    toggleViewed("/wt", "k");
    expect(selectViewedSet(useDiffViewedStore.getState(), "/wt").has("k")).toBe(true);
    toggleViewed("/wt", "k");
    expect(selectViewedSet(useDiffViewedStore.getState(), "/wt").has("k")).toBe(false);
  });

  it("setViewed is a no-op state update when the value is unchanged", () => {
    const { setViewed } = useDiffViewedStore.getState();
    setViewed("/wt", "k", true);
    const before = useDiffViewedStore.getState().viewedByWorktree;
    setViewed("/wt", "k", true);
    expect(useDiffViewedStore.getState().viewedByWorktree).toBe(before);
  });

  it("returns a stable empty set for unknown worktrees", () => {
    const a = selectViewedSet(useDiffViewedStore.getState(), "/unknown-1");
    const b = selectViewedSet(useDiffViewedStore.getState(), "/unknown-2");
    expect(a.size).toBe(0);
    expect(a).toBe(b);
  });

  it("clearWorktree drops only that worktree", () => {
    const { setViewed, clearWorktree } = useDiffViewedStore.getState();
    setViewed("/wt-a", "k", true);
    setViewed("/wt-b", "k", true);
    clearWorktree("/wt-a");
    expect(selectViewedSet(useDiffViewedStore.getState(), "/wt-a").size).toBe(0);
    expect(selectViewedSet(useDiffViewedStore.getState(), "/wt-b").has("k")).toBe(true);
  });
});
