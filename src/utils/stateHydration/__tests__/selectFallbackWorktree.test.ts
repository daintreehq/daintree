import { describe, expect, it } from "vitest";
import { selectFallbackWorktree } from "../index";

type TestWorktree = { id: string; name: string; isMainWorktree?: boolean };

describe("selectFallbackWorktree (#9512)", () => {
  it("prefers the main worktree even when a temp worktree sorts first alphabetically", () => {
    const worktrees: TestWorktree[] = [
      { id: "wt-aaa-temp", name: "aaa-issue-1-fix", isMainWorktree: false },
      { id: "wt-root", name: "daintree", isMainWorktree: true },
      { id: "wt-bbb-temp", name: "bbb-issue-2-fix", isMainWorktree: false },
    ];

    expect(selectFallbackWorktree(worktrees)?.id).toBe("wt-root");
  });

  it("treats an absent isMainWorktree flag as non-main and never picks it over the real main", () => {
    const worktrees: TestWorktree[] = [
      { id: "wt-aaa-temp", name: "aaa-temp" }, // isMainWorktree undefined
      { id: "wt-root", name: "zzz-root", isMainWorktree: true },
    ];

    // Even though "aaa-temp" sorts first, the main worktree wins.
    expect(selectFallbackWorktree(worktrees)?.id).toBe("wt-root");
  });

  it("falls back to the alphabetically-first worktree when none is main", () => {
    const worktrees: TestWorktree[] = [
      { id: "wt-charlie", name: "charlie", isMainWorktree: false },
      { id: "wt-alpha", name: "alpha", isMainWorktree: false },
      { id: "wt-bravo", name: "bravo" },
    ];

    expect(selectFallbackWorktree(worktrees)?.id).toBe("wt-alpha");
  });

  it("returns undefined for an empty list", () => {
    expect(selectFallbackWorktree([])).toBeUndefined();
  });

  it("returns the only worktree when the list has one entry", () => {
    const worktrees: TestWorktree[] = [{ id: "wt-only", name: "only" }];
    expect(selectFallbackWorktree(worktrees)?.id).toBe("wt-only");
  });
});
