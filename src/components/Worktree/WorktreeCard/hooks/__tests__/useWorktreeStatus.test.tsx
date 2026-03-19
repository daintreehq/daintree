/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import type { WorktreeState, WorktreeChanges } from "@/types";
import { useWorktreeStatus, type WorktreeLifecycleStage } from "../useWorktreeStatus";

function makeChanges(overrides: Partial<WorktreeChanges> = {}): WorktreeChanges {
  return {
    worktreeId: "/test/worktree",
    rootPath: "/test/worktree",
    changes: [],
    changedFileCount: 0,
    lastCommitMessage: "init",
    ...overrides,
  };
}

function makeWorktree(overrides: Partial<WorktreeState> = {}): WorktreeState {
  return {
    id: "/test/worktree",
    worktreeId: "/test/worktree",
    path: "/test/worktree",
    name: "test-branch",
    branch: "feature/test",
    isCurrent: false,
    isMainWorktree: false,
    lastActivityTimestamp: Date.now(),
    worktreeChanges: makeChanges(),
    ...overrides,
  };
}

describe("useWorktreeStatus — lifecycleStage", () => {
  function getLifecycleStage(
    overrides: Partial<WorktreeState> = {}
  ): WorktreeLifecycleStage | null {
    const { result } = renderHook(() =>
      useWorktreeStatus({ worktree: makeWorktree(overrides), worktreeErrorCount: 0 })
    );
    return result.current.lifecycleStage;
  }

  it("returns null for main worktree", () => {
    expect(getLifecycleStage({ isMainWorktree: true })).toBeNull();
  });

  it("returns null for main worktree even with changes and open PR", () => {
    expect(
      getLifecycleStage({
        isMainWorktree: true,
        worktreeChanges: makeChanges({ changedFileCount: 5 }),
        prState: "open",
        prNumber: 10,
      })
    ).toBeNull();
  });

  it("returns null when worktreeChanges is null (loading)", () => {
    expect(getLifecycleStage({ worktreeChanges: null })).toBeNull();
  });

  it("returns null when loading even with merged PR", () => {
    expect(
      getLifecycleStage({
        worktreeChanges: null,
        prState: "merged",
        prNumber: 10,
        issueNumber: 42,
      })
    ).toBeNull();
  });

  it("returns null when there are local changes but no PR", () => {
    expect(
      getLifecycleStage({
        worktreeChanges: makeChanges({ changedFileCount: 3 }),
      })
    ).toBeNull();
  });

  it('returns "in-review" when open PR has local changes', () => {
    expect(
      getLifecycleStage({
        worktreeChanges: makeChanges({ changedFileCount: 1 }),
        prState: "open",
        prNumber: 10,
      })
    ).toBe("in-review");
  });

  it('returns "merged" when merged PR has local changes and no issue', () => {
    expect(
      getLifecycleStage({
        worktreeChanges: makeChanges({ changedFileCount: 1 }),
        prState: "merged",
        prNumber: 10,
      })
    ).toBe("merged");
  });

  it('returns "ready-for-cleanup" when merged PR has local changes and issue linked', () => {
    expect(
      getLifecycleStage({
        worktreeChanges: makeChanges({ changedFileCount: 1 }),
        prState: "merged",
        prNumber: 10,
        issueNumber: 42,
      })
    ).toBe("ready-for-cleanup");
  });

  it('returns "ready-for-cleanup" when PR merged and issue linked', () => {
    expect(
      getLifecycleStage({
        prState: "merged",
        prNumber: 10,
        issueNumber: 42,
      })
    ).toBe("ready-for-cleanup");
  });

  it('returns "merged" when PR merged but no issue linked', () => {
    expect(
      getLifecycleStage({
        prState: "merged",
        prNumber: 10,
      })
    ).toBe("merged");
  });

  it('returns "in-review" when PR is open and no local changes', () => {
    expect(
      getLifecycleStage({
        prState: "open",
        prNumber: 10,
      })
    ).toBe("in-review");
  });

  it("returns null when PR is closed (not merged)", () => {
    expect(
      getLifecycleStage({
        prState: "closed",
        prNumber: 10,
      })
    ).toBeNull();
  });

  it("returns null when no PR and no changes", () => {
    expect(getLifecycleStage({})).toBeNull();
  });

  it("updates from merged to ready-for-cleanup when issueNumber is added", () => {
    const initialWorktree = makeWorktree({
      prState: "merged",
      prNumber: 10,
    });
    const { result, rerender } = renderHook(
      ({ wt }) => useWorktreeStatus({ worktree: wt, worktreeErrorCount: 0 }),
      { initialProps: { wt: initialWorktree } }
    );

    expect(result.current.lifecycleStage).toBe("merged");

    rerender({
      wt: makeWorktree({ prState: "merged", prNumber: 10, issueNumber: 42 }),
    });

    expect(result.current.lifecycleStage).toBe("ready-for-cleanup");
  });
});

describe("useWorktreeStatus — branchLabel", () => {
  function getBranchLabel(overrides: Partial<WorktreeState> = {}): string {
    const { result } = renderHook(() =>
      useWorktreeStatus({ worktree: makeWorktree(overrides), worktreeErrorCount: 0 })
    );
    return result.current.branchLabel;
  }

  it("returns directory name for main worktree even when branch is set", () => {
    expect(getBranchLabel({ isMainWorktree: true, name: "canopy", branch: "main" })).toBe("canopy");
  });

  it("returns branch name for non-main worktree", () => {
    expect(getBranchLabel({ isMainWorktree: false, name: "canopy", branch: "feature/test" })).toBe(
      "feature/test"
    );
  });

  it("falls back to name when branch is undefined for non-main worktree", () => {
    expect(getBranchLabel({ isMainWorktree: false, name: "canopy", branch: undefined })).toBe(
      "canopy"
    );
  });
});

describe("useWorktreeStatus — computedSubtitle", () => {
  function getSubtitle(overrides: Partial<WorktreeState> = {}, worktreeErrorCount = 0) {
    const { result } = renderHook(() =>
      useWorktreeStatus({ worktree: makeWorktree(overrides), worktreeErrorCount })
    );
    return result.current.computedSubtitle;
  }

  it("shows error count when errors exist", () => {
    expect(getSubtitle({}, 3)).toEqual({ text: "3 errors", tone: "error" });
  });

  it("shows last commit message when available", () => {
    expect(
      getSubtitle({ worktreeChanges: makeChanges({ lastCommitMessage: "fix: bug" }) })
    ).toEqual({ text: "fix: bug", tone: "muted" });
  });

  it("does not use issueTitle in subtitle (issue title is now the headline)", () => {
    expect(
      getSubtitle({
        worktreeChanges: makeChanges({ lastCommitMessage: undefined }),
        issueTitle: "Add dark mode support",
      })
    ).toEqual({ text: "No recent activity", tone: "muted" });
  });

  it("falls back to prTitle when no commit message", () => {
    expect(
      getSubtitle({
        worktreeChanges: makeChanges({ lastCommitMessage: undefined }),
        prTitle: "feat: dark mode",
        prState: "open",
      })
    ).toEqual({ text: "feat: dark mode", tone: "muted" });
  });

  it("falls back to prTitle even when issueTitle is present (issue title shown as headline)", () => {
    expect(
      getSubtitle({
        worktreeChanges: makeChanges({ lastCommitMessage: undefined }),
        issueTitle: "Add dark mode support",
        prTitle: "feat: dark mode",
        prState: "open",
      })
    ).toEqual({ text: "feat: dark mode", tone: "muted" });
  });

  it("skips prTitle when prState is closed", () => {
    expect(
      getSubtitle({
        worktreeChanges: makeChanges({ lastCommitMessage: undefined }),
        prTitle: "feat: dark mode",
        prState: "closed",
      })
    ).toEqual({ text: "No recent activity", tone: "muted" });
  });

  it("shows prTitle when prState is merged", () => {
    expect(
      getSubtitle({
        worktreeChanges: makeChanges({ lastCommitMessage: undefined }),
        prTitle: "feat: dark mode",
        prState: "merged",
      })
    ).toEqual({ text: "feat: dark mode", tone: "muted" });
  });

  it("ignores issueTitle entirely in subtitle fallback", () => {
    expect(
      getSubtitle({
        worktreeChanges: makeChanges({ lastCommitMessage: undefined }),
        issueTitle: "Valid issue title",
      })
    ).toEqual({ text: "No recent activity", tone: "muted" });
  });

  it('falls back to "No recent activity" when nothing available', () => {
    expect(getSubtitle({ worktreeChanges: makeChanges({ lastCommitMessage: undefined }) })).toEqual(
      { text: "No recent activity", tone: "muted" }
    );
  });
});
