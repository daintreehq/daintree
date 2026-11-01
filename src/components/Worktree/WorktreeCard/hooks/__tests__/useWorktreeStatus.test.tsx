/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import type { WorktreeState, WorktreeChanges } from "@/types";
import { useWorktreeStatus, type WorktreeReviewState } from "../useWorktreeStatus";

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

function prLinked(overrides: { prNumber?: number; prState?: string; prTitle?: string } = {}) {
  const num = overrides.prNumber ?? 10;
  return {
    linked: {
      providerId: "github",
      pr: {
        ref: { providerId: "github", owner: "test", repo: "test", number: num, rawData: {} },
        state: (overrides.prState ?? "open") as "open" | "merged" | "closed" | "declined",
        url: `https://github.com/test/repo/pull/${num}`,
        ...(overrides.prTitle ? { title: overrides.prTitle } : {}),
      },
    },
  };
}

describe("useWorktreeStatus — branchLabel", () => {
  function getStatus(overrides: Partial<WorktreeState> = {}) {
    const { result } = renderHook(() => useWorktreeStatus({ worktree: makeWorktree(overrides) }));
    return {
      branchLabel: result.current.branchLabel,
      isMainOnStandardBranch: result.current.isMainOnStandardBranch,
    };
  }

  it("returns branch name for main worktree on standard branch (main)", () => {
    const s = getStatus({ isMainWorktree: true, name: "daintree", branch: "main" });
    expect(s.branchLabel).toBe("main");
    expect(s.isMainOnStandardBranch).toBe(true);
  });

  it("handles case-insensitive standard branch matching", () => {
    const s = getStatus({ isMainWorktree: true, name: "daintree", branch: "Develop" });
    expect(s.branchLabel).toBe("Develop");
    expect(s.isMainOnStandardBranch).toBe(true);
  });

  it("does not treat near-miss branch as standard", () => {
    const s = getStatus({ isMainWorktree: true, name: "daintree", branch: "development" });
    expect(s.branchLabel).toBe("development");
    expect(s.isMainOnStandardBranch).toBe(false);
  });

  it("recognizes master and dev as standard branches", () => {
    for (const branch of ["master", "dev"]) {
      const s = getStatus({ isMainWorktree: true, name: "daintree", branch });
      expect(s.branchLabel).toBe(branch);
      expect(s.isMainOnStandardBranch).toBe(true);
    }
  });
});

describe("useWorktreeStatus — resource status badge", () => {
  function getResourceStatus(overrides: Partial<WorktreeState> = {}) {
    const { result } = renderHook(() => useWorktreeStatus({ worktree: makeWorktree(overrides) }));
    return {
      resourceStatusLabel: result.current.resourceStatusLabel,
      resourceStatusColor: result.current.resourceStatusColor,
      hasResourceConfig: result.current.hasResourceConfig,
    };
  }

  it("returns undefined when no resourceStatus present", () => {
    const s = getResourceStatus({});
    expect(s.resourceStatusLabel).toBeUndefined();
    expect(s.resourceStatusColor).toBeUndefined();
    expect(s.hasResourceConfig).toBe(false);
  });

  it("maps 'ready' to green", () => {
    const s = getResourceStatus({
      hasResourceConfig: true,
      resourceStatus: { lastStatus: "ready", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusLabel).toBe("ready");
    expect(s.resourceStatusColor).toBe("green");
    expect(s.hasResourceConfig).toBe(true);
  });

  it("maps 'provisioning' to yellow", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "provisioning", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusLabel).toBe("provisioning");
    expect(s.resourceStatusColor).toBe("yellow");
  });

  it("maps 'paused' to neutral", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "paused", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusLabel).toBe("paused");
    expect(s.resourceStatusColor).toBe("neutral");
  });

  it("maps 'unhealthy' to red", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "unhealthy", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusLabel).toBe("unhealthy");
    expect(s.resourceStatusColor).toBe("red");
  });

  it("maps unrecognized status to neutral", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "custom-provider-state", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusLabel).toBe("custom-provider-state");
    expect(s.resourceStatusColor).toBe("neutral");
  });

  it("is case-insensitive for status mapping", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "Ready", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusColor).toBe("green");
  });
});

describe("useWorktreeStatus — lifecycle labels for resource phases", () => {
  function getLifecycleLabel(overrides: Partial<WorktreeState> = {}) {
    const { result } = renderHook(() => useWorktreeStatus({ worktree: makeWorktree(overrides) }));
    return result.current.lifecycleLabel;
  }

  it("shows 'Provisioning resource' during resource-provision", () => {
    const label = getLifecycleLabel({
      lifecycleStatus: {
        phase: "resource-provision",
        state: "running",
        startedAt: Date.now(),
        currentCommand: "terraform apply",
      },
    });
    expect(label).toBe("Provisioning resource: terraform apply");
  });

  it("shows 'Tearing down resource' during resource-teardown", () => {
    const label = getLifecycleLabel({
      lifecycleStatus: {
        phase: "resource-teardown",
        state: "running",
        startedAt: Date.now(),
      },
    });
    expect(label).toBe("Tearing down resource…");
  });

  it("shows failure label for resource-provision failed", () => {
    const label = getLifecycleLabel({
      lifecycleStatus: {
        phase: "resource-provision",
        state: "failed",
        startedAt: Date.now(),
        completedAt: Date.now(),
      },
    });
    expect(label).toBe("Resource failed");
  });

  it("shows timed-out label for resource-status", () => {
    const label = getLifecycleLabel({
      lifecycleStatus: {
        phase: "resource-status",
        state: "timed-out",
        startedAt: Date.now(),
        completedAt: Date.now(),
      },
    });
    expect(label).toBe("Resource status timed out");
  });
});

describe("useWorktreeStatus — computedSubtitle", () => {
  function getSubtitle(overrides: Partial<WorktreeState> = {}) {
    const { result } = renderHook(() => useWorktreeStatus({ worktree: makeWorktree(overrides) }));
    return result.current.computedSubtitle;
  }

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
        ...prLinked({ prState: "open", prTitle: "feat: dark mode" }),
      })
    ).toEqual({ text: "feat: dark mode", tone: "muted" });
  });

  it("skips prTitle when prState is closed", () => {
    expect(
      getSubtitle({
        worktreeChanges: makeChanges({ lastCommitMessage: undefined }),
        prTitle: "feat: dark mode",
        prState: "closed",
        ...prLinked({ prState: "closed", prTitle: "feat: dark mode" }),
      })
    ).toEqual({ text: "No recent activity", tone: "muted" });
  });

  it("shows prTitle when prState is merged", () => {
    expect(
      getSubtitle({
        worktreeChanges: makeChanges({ lastCommitMessage: undefined }),
        prTitle: "feat: dark mode",
        prState: "merged",
        ...prLinked({ prState: "merged", prTitle: "feat: dark mode" }),
      })
    ).toEqual({ text: "feat: dark mode", tone: "muted" });
  });

  it('shows "Checking status…" instead of a false all-clear while git status is unresolved', () => {
    expect(getSubtitle({ worktreeChanges: null })).toEqual({
      text: "Checking status…",
      tone: "muted",
    });
  });

  it("still prefers an open PR title while git status is unresolved", () => {
    expect(
      getSubtitle({
        worktreeChanges: null,
        prTitle: "feat: dark mode",
        prState: "open",
        ...prLinked({ prState: "open", prTitle: "feat: dark mode" }),
      })
    ).toEqual({ text: "feat: dark mode", tone: "muted" });
  });
});

describe("useWorktreeStatus — reviewState", () => {
  function getReviewState(overrides: Partial<WorktreeState> = {}): WorktreeReviewState {
    const { result } = renderHook(() => useWorktreeStatus({ worktree: makeWorktree(overrides) }));
    return result.current.reviewState;
  }

  it("returns null when worktreeChanges is null", () => {
    expect(getReviewState({ worktreeChanges: null })).toBeNull();
  });

  it("returns null when no changes, no ahead, no conflicts", () => {
    expect(
      getReviewState({
        worktreeChanges: makeChanges({ changedFileCount: 0, ahead: 0 }),
      })
    ).toBeNull();
  });

  it('"conflicted" wins over ahead and changes', () => {
    expect(
      getReviewState({
        worktreeChanges: makeChanges({
          changedFileCount: 5,
          ahead: 3,
          changes: [{ path: "a.ts", status: "conflicted", insertions: null, deletions: null }],
        }),
      })
    ).toBe("conflicted");
  });

  it('"has-changes" wins over "unpushed-clean" when both apply', () => {
    expect(
      getReviewState({
        worktreeChanges: makeChanges({
          changedFileCount: 1,
          ahead: 2,
        }),
      })
    ).toBe("has-changes");
  });

  it('returns "unpushed-clean" when ahead > 0 and no changes', () => {
    expect(
      getReviewState({
        worktreeChanges: makeChanges({
          changedFileCount: 0,
          ahead: 2,
        }),
      })
    ).toBe("unpushed-clean");
  });

  it("treats missing changes array as no conflicts", () => {
    const { result } = renderHook(() =>
      useWorktreeStatus({
        worktree: makeWorktree({
          worktreeChanges: {
            worktreeId: "/test/worktree",
            rootPath: "/test/worktree",
            changedFileCount: 2,
          } as unknown as WorktreeChanges,
        }),
      })
    );
    expect(result.current.reviewState).toBe("has-changes");
  });
});

describe("useWorktreeStatus — gitStateIndicator", () => {
  function getIndicator(overrides: Partial<WorktreeState> = {}) {
    const { result } = renderHook(() => useWorktreeStatus({ worktree: makeWorktree(overrides) }));
    return result.current.gitStateIndicator;
  }

  it("is null for a dirty-only worktree (spine + file-count row carry that signal)", () => {
    expect(
      getIndicator({
        worktreeChanges: makeChanges({
          changedFileCount: 3,
          changes: [{ path: "a.ts", status: "modified", insertions: 2, deletions: 1 }],
        }),
      })
    ).toBeNull();
  });

  it("returns conflicted when changes include a conflicted file, even with dirty state", () => {
    expect(
      getIndicator({
        worktreeChanges: makeChanges({
          changedFileCount: 2,
          changes: [
            { path: "a.ts", status: "conflicted", insertions: null, deletions: null },
            { path: "b.ts", status: "modified", insertions: 1, deletions: 0 },
          ],
        }),
      })
    ).toEqual({ kind: "conflicted", label: "conflicted", tone: "error" });
  });

  it("returns detached with warning tone when isDetached and no blocker", () => {
    expect(getIndicator({ isDetached: true })).toEqual({
      kind: "detached",
      label: "detached",
      tone: "warning",
    });
  });
});
