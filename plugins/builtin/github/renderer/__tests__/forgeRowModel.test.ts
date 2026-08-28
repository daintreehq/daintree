import { describe, it, expect } from "vitest";
import { buildWorktreeIndex, deriveRowModel, describeWorktree } from "../components/forgeRowModel";
import type { Worktree } from "@shared/types/worktree";

const wt = (overrides: Partial<Worktree>): Worktree => ({
  id: "wt",
  path: "/tmp/wt",
  name: "wt",
  isCurrent: false,
  ...overrides,
});

describe("buildWorktreeIndex", () => {
  it("indexes issue worktrees by issue number and ignores PR links", () => {
    const index = buildWorktreeIndex(
      [wt({ id: "a", issueNumber: 42 }), wt({ id: "b", prNumber: 42 })],
      "issue",
      null
    );
    expect(index.get(42)?.id).toBe("a");
  });

  it("indexes PR worktrees by PR number", () => {
    const index = buildWorktreeIndex(
      [wt({ id: "a", issueNumber: 42 }), wt({ id: "b", prNumber: 42 })],
      "pr",
      null
    );
    expect(index.get(42)?.id).toBe("b");
  });

  it("skips worktrees that name no resource", () => {
    expect(buildWorktreeIndex([wt({ id: "a" })], "issue", null).size).toBe(0);
  });

  it("lets the active worktree win a duplicate, whichever order it arrives in", () => {
    // Two worktrees can legitimately name one resource — a second made before
    // the first was cleaned up. The old per-row scan took whichever the map
    // happened to yield first, so the row you were standing in could lose.
    const first = [wt({ id: "a", issueNumber: 7 }), wt({ id: "b", issueNumber: 7 })];
    expect(buildWorktreeIndex(first, "issue", "b").get(7)?.id).toBe("b");
    expect(buildWorktreeIndex([...first].reverse(), "issue", "b").get(7)?.id).toBe("b");
  });

  it("keeps the first of two inactive duplicates, in whichever order they arrive", () => {
    // Asserting only [a,b] -> a cannot tell first-wins from lowest-id-wins.
    const pair = [wt({ id: "a", issueNumber: 7 }), wt({ id: "b", issueNumber: 7 })];
    expect(buildWorktreeIndex(pair, "issue", null).get(7)?.id).toBe("a");
    expect(buildWorktreeIndex([...pair].reverse(), "issue", null).get(7)?.id).toBe("b");
  });
});

describe("deriveRowModel", () => {
  it("switches when a worktree already exists", () => {
    const model = deriveRowModel({ state: "open" }, wt({ id: "x" }), null);
    expect(model.primaryAction).toEqual({ kind: "switch", worktreeId: "x" });
    expect(model.isActiveWorktree).toBe(false);
  });

  it("knows when that worktree is the one in view", () => {
    expect(deriveRowModel({ state: "open" }, wt({ id: "x" }), "x").isActiveWorktree).toBe(true);
  });

  it("creates for an open resource with no worktree", () => {
    expect(deriveRowModel({ state: "open" }, undefined, null).primaryAction).toEqual({
      kind: "create",
    });
  });

  it("falls through to the forge when there is nothing to make locally", () => {
    // A closed issue or a merged PR has no worktree to create, so activation
    // opens it rather than silently doing nothing.
    expect(deriveRowModel({ state: "closed" }, undefined, null).primaryAction).toEqual({
      kind: "open",
    });
    expect(deriveRowModel({ state: "merged" }, undefined, null).primaryAction).toEqual({
      kind: "open",
    });
  });

  it("switches to a closed resource's worktree rather than opening the forge", () => {
    const model = deriveRowModel({ state: "closed" }, wt({ id: "x" }), null);
    expect(model.primaryAction).toEqual({ kind: "switch", worktreeId: "x" });
  });
});

describe("describeWorktree", () => {
  it("names the worktree", () => {
    expect(describeWorktree(wt({ name: "fix-42" }), false)).toBe("Worktree: fix-42");
  });

  it("says which one is active", () => {
    expect(describeWorktree(wt({ name: "fix-42" }), true)).toBe("Active worktree: fix-42");
  });

  it("names a branch that differs from the worktree", () => {
    // The match is on resource number, not branch, so the local branch can
    // legitimately diverge from the PR's head ref.
    expect(describeWorktree(wt({ name: "fix-42", branch: "feature/other" }), false)).toBe(
      "Worktree: fix-42 on feature/other"
    );
  });

  it("does not repeat a branch that is just the name again", () => {
    expect(describeWorktree(wt({ name: "fix-42", branch: "fix-42" }), false)).toBe(
      "Worktree: fix-42"
    );
  });

  it("reports a detached head", () => {
    expect(
      describeWorktree(wt({ name: "fix-42", isDetached: true, head: "abc1234def" }), false)
    ).toBe("Worktree: fix-42 (detached at abc1234)");
    expect(describeWorktree(wt({ name: "fix-42", isDetached: true }), false)).toBe(
      "Worktree: fix-42 (detached HEAD)"
    );
  });
});
