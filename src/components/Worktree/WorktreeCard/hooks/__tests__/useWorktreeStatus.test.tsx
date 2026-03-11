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

  it("returns null when worktreeChanges is null (loading)", () => {
    expect(getLifecycleStage({ worktreeChanges: null })).toBeNull();
  });

  it('returns "working" when there are local changes', () => {
    expect(
      getLifecycleStage({
        worktreeChanges: makeChanges({ changedFileCount: 3 }),
      })
    ).toBe("working");
  });

  it('returns "working" even with an open PR when there are changes', () => {
    expect(
      getLifecycleStage({
        worktreeChanges: makeChanges({ changedFileCount: 1 }),
        prState: "open",
        prNumber: 10,
      })
    ).toBe("working");
  });

  it('returns "working" even with a merged PR when there are changes', () => {
    expect(
      getLifecycleStage({
        worktreeChanges: makeChanges({ changedFileCount: 1 }),
        prState: "merged",
        prNumber: 10,
      })
    ).toBe("working");
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

  it("updates when worktree state changes", () => {
    const initialWorktree = makeWorktree({
      worktreeChanges: makeChanges({ changedFileCount: 2 }),
    });
    const { result, rerender } = renderHook(
      ({ wt }) => useWorktreeStatus({ worktree: wt, worktreeErrorCount: 0 }),
      { initialProps: { wt: initialWorktree } }
    );

    expect(result.current.lifecycleStage).toBe("working");

    const updatedWorktree = makeWorktree({
      worktreeChanges: makeChanges({ changedFileCount: 0 }),
      prState: "open",
      prNumber: 5,
    });
    rerender({ wt: updatedWorktree });

    expect(result.current.lifecycleStage).toBe("in-review");
  });
});
