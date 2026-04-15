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
    const { result } = renderHook(() => useWorktreeStatus({ worktree: makeWorktree(overrides) }));
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
    const { result, rerender } = renderHook(({ wt }) => useWorktreeStatus({ worktree: wt }), {
      initialProps: { wt: initialWorktree },
    });

    expect(result.current.lifecycleStage).toBe("merged");

    rerender({
      wt: makeWorktree({ prState: "merged", prNumber: 10, issueNumber: 42 }),
    });

    expect(result.current.lifecycleStage).toBe("ready-for-cleanup");
  });
});

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

  it("returns branch name for main worktree on standard branch (develop)", () => {
    const s = getStatus({ isMainWorktree: true, name: "daintree", branch: "develop" });
    expect(s.branchLabel).toBe("develop");
    expect(s.isMainOnStandardBranch).toBe(true);
  });

  it("handles case-insensitive standard branch matching", () => {
    const s = getStatus({ isMainWorktree: true, name: "daintree", branch: "Develop" });
    expect(s.branchLabel).toBe("Develop");
    expect(s.isMainOnStandardBranch).toBe(true);
  });

  it("returns branch name for main worktree on non-standard branch", () => {
    const s = getStatus({ isMainWorktree: true, name: "daintree", branch: "feature/test" });
    expect(s.branchLabel).toBe("feature/test");
    expect(s.isMainOnStandardBranch).toBe(false);
  });

  it("returns directory name for main worktree when detached", () => {
    const s = getStatus({
      isMainWorktree: true,
      name: "daintree",
      branch: undefined,
      isDetached: true,
    });
    expect(s.branchLabel).toBe("daintree");
    expect(s.isMainOnStandardBranch).toBe(false);
  });

  it("returns directory name for main worktree when branch is undefined", () => {
    const s = getStatus({ isMainWorktree: true, name: "daintree", branch: undefined });
    expect(s.branchLabel).toBe("daintree");
    expect(s.isMainOnStandardBranch).toBe(false);
  });

  it("does not treat near-miss branch as standard", () => {
    const s = getStatus({ isMainWorktree: true, name: "daintree", branch: "development" });
    expect(s.branchLabel).toBe("development");
    expect(s.isMainOnStandardBranch).toBe(false);
  });

  it("returns branch name for non-main worktree", () => {
    const s = getStatus({ isMainWorktree: false, name: "daintree", branch: "feature/test" });
    expect(s.branchLabel).toBe("feature/test");
    expect(s.isMainOnStandardBranch).toBe(false);
  });

  it("falls back to name when branch is undefined for non-main worktree", () => {
    const s = getStatus({ isMainWorktree: false, name: "daintree", branch: undefined });
    expect(s.branchLabel).toBe("daintree");
    expect(s.isMainOnStandardBranch).toBe(false);
  });

  it("recognizes master and dev as standard branches", () => {
    for (const branch of ["master", "dev"]) {
      const s = getStatus({ isMainWorktree: true, name: "daintree", branch });
      expect(s.branchLabel).toBe(branch);
      expect(s.isMainOnStandardBranch).toBe(true);
    }
  });

  it("returns directory name for detached HEAD even with stale branch value", () => {
    const s = getStatus({
      isMainWorktree: true,
      name: "daintree",
      branch: "main",
      isDetached: true,
    });
    expect(s.branchLabel).toBe("daintree");
    expect(s.isMainOnStandardBranch).toBe(false);
  });

  it("does not apply standard branch logic to non-main worktree on 'main'", () => {
    const s = getStatus({ isMainWorktree: false, name: "daintree", branch: "main" });
    expect(s.branchLabel).toBe("main");
    expect(s.isMainOnStandardBranch).toBe(false);
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

  it("maps 'running' to green", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "running", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusColor).toBe("green");
  });

  it("maps 'healthy' to green", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "healthy", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusColor).toBe("green");
  });

  it("maps 'up' to green", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "up", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusColor).toBe("green");
  });

  it("maps 'provisioning' to yellow", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "provisioning", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusLabel).toBe("provisioning");
    expect(s.resourceStatusColor).toBe("yellow");
  });

  it("maps 'starting' to yellow", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "starting", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusColor).toBe("yellow");
  });

  it("maps 'paused' to neutral", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "paused", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusLabel).toBe("paused");
    expect(s.resourceStatusColor).toBe("neutral");
  });

  it("maps legacy 'stopped' to neutral for graceful fallback", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "stopped", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusLabel).toBe("stopped");
    expect(s.resourceStatusColor).toBe("neutral");
  });

  it("maps 'unhealthy' to red", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "unhealthy", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusLabel).toBe("unhealthy");
    expect(s.resourceStatusColor).toBe("red");
  });

  it("maps 'error' to red", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "error", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusColor).toBe("red");
  });

  it("maps 'down' to red", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "down", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusColor).toBe("red");
  });

  it("maps 'failed' to red", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "failed", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusColor).toBe("red");
  });

  it("maps 'unknown' to neutral", () => {
    const s = getResourceStatus({
      resourceStatus: { lastStatus: "unknown", lastCheckedAt: Date.now() },
    });
    expect(s.resourceStatusLabel).toBe("unknown");
    expect(s.resourceStatusColor).toBe("neutral");
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
    expect(label).toBe("Tearing down resource...");
  });

  it("shows 'Resuming resource' during resource-resume", () => {
    const label = getLifecycleLabel({
      lifecycleStatus: {
        phase: "resource-resume",
        state: "running",
        startedAt: Date.now(),
        currentCommand: "docker compose up -d",
      },
    });
    expect(label).toBe("Resuming resource: docker compose up -d");
  });

  it("shows 'Pausing resource' during resource-pause", () => {
    const label = getLifecycleLabel({
      lifecycleStatus: {
        phase: "resource-pause",
        state: "running",
        startedAt: Date.now(),
      },
    });
    expect(label).toBe("Pausing resource...");
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
    expect(label).toBe("resource failed");
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
    expect(label).toBe("resource status timed out");
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
