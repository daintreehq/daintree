import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
import type { CanopyEventMap } from "../events.js";
import type { PRCheckCandidate } from "../github/types.js";

function makeWorktreeSnapshot(
  overrides: Partial<WorktreeSnapshot> & Pick<WorktreeSnapshot, "worktreeId">
): WorktreeSnapshot {
  return {
    id: overrides.worktreeId,
    path: "/repo",
    name: "Worktree",
    isCurrent: false,
    ...overrides,
  };
}

describe("PullRequestService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("detects PRs for non-default branches without issue numbers", async () => {
    const batchCheckLinkedPRs = vi.fn(async (_cwd: string, candidates: PRCheckCandidate[]) => ({
      results: new Map([
        [
          candidates[0].worktreeId,
          {
            issueNumber: candidates[0].issueNumber,
            branchName: candidates[0].branchName,
            pr: {
              number: 42,
              title: "Add new feature",
              url: "https://github.com/o/r/pull/42",
              state: "open",
              isDraft: false,
            },
          },
        ],
      ]),
    }));
    const clearPRCaches = vi.fn();

    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const detected: CanopyEventMap["sys:pr:detected"][] = [];
    const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/no-issue" })
    );

    await pullRequestService.refresh();

    expect(batchCheckLinkedPRs).toHaveBeenCalledTimes(1);
    expect(batchCheckLinkedPRs.mock.calls[0][1]).toEqual([
      { worktreeId: "wt-1", issueNumber: undefined, branchName: "feature/no-issue" },
    ]);

    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({
      worktreeId: "wt-1",
      prNumber: 42,
      prUrl: "https://github.com/o/r/pull/42",
      prState: "open",
      prTitle: "Add new feature",
    });
    expect(detected[0].issueNumber).toBeUndefined();

    unsubscribe();
    pullRequestService.destroy();
  });

  it("does not track default branches like main/master", async () => {
    const batchCheckLinkedPRs = vi.fn(async () => ({ results: new Map() }));
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-main", branch: "main" })
    );
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-master", branch: "master" })
    );

    await pullRequestService.refresh();

    expect(batchCheckLinkedPRs).not.toHaveBeenCalled();

    pullRequestService.destroy();
  });

  it("clears PR state only when branch changes (not when issue number changes)", async () => {
    const batchCheckLinkedPRs = vi.fn(async (_cwd: string, candidates: PRCheckCandidate[]) => ({
      results: new Map(
        candidates.map((c) => [
          c.worktreeId,
          {
            issueNumber: c.issueNumber,
            branchName: c.branchName,
            pr: {
              number: 7,
              title: "Fix bug",
              url: "https://github.com/o/r/pull/7",
              state: "open",
              isDraft: false,
            },
          },
        ])
      ),
    }));
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const cleared: CanopyEventMap["sys:pr:cleared"][] = [];
    const unsubscribeCleared = events.on("sys:pr:cleared", (payload) => cleared.push(payload));

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a", issueNumber: undefined })
    );
    await pullRequestService.refresh();

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a", issueNumber: 123 })
    );

    expect(cleared).toHaveLength(0);

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/b", issueNumber: 123 })
    );

    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ worktreeId: "wt-1", timestamp: expect.any(Number) });

    unsubscribeCleared();
    pullRequestService.destroy();
  });

  it("auto-recovers from circuit breaker after backoff period", async () => {
    let callCount = 0;
    const batchCheckLinkedPRs = vi.fn(async () => {
      callCount++;
      if (callCount <= 3) {
        return { results: new Map(), error: "API rate limit exceeded" };
      }
      return { results: new Map() };
    });
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
    );

    await pullRequestService.start();
    // start() calls checkForPRs (error 1), then schedules next poll
    expect(callCount).toBe(1);

    // Advance past first backoff (1 min) to trigger second poll
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(callCount).toBe(2);

    // Advance past second backoff (2 min) to trigger third poll
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(callCount).toBe(3);

    // After 3 errors, circuit breaker is tripped (5 min backoff)
    const status = pullRequestService.getStatus();
    expect(status.isEnabled).toBe(false);
    expect(status.consecutiveErrors).toBe(3);

    // Advance past the 5-min circuit breaker backoff
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    // The service should have auto-recovered and made another call
    expect(callCount).toBe(4);
    expect(pullRequestService.getStatus().consecutiveErrors).toBe(0);

    pullRequestService.destroy();
  });

  it("revalidates resolved PRs at 90-second intervals", async () => {
    let checkCallCount = 0;
    const batchCheckLinkedPRs = vi.fn(async (_cwd: string, candidates: PRCheckCandidate[]) => {
      checkCallCount++;
      return {
        results: new Map(
          candidates.map((c) => [
            c.worktreeId,
            {
              issueNumber: c.issueNumber,
              branchName: c.branchName,
              pr: {
                number: 10,
                title: "My PR",
                url: "https://github.com/o/r/pull/10",
                state: "open" as const,
                isDraft: false,
              },
            },
          ])
        ),
      };
    });
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/reval" })
    );

    await pullRequestService.start();
    // start() calls checkForPRs (resolves wt-1), then schedules revalidation
    expect(checkCallCount).toBe(1);

    // Advance 90 seconds — revalidation should fire
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(checkCallCount).toBe(2);

    // Advance another 90 seconds — another revalidation
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(checkCallCount).toBe(3);

    pullRequestService.destroy();
  });

  it("calls clearPRCaches on manual refresh", async () => {
    const batchCheckLinkedPRs = vi.fn(async () => ({ results: new Map() }));
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));

    const { pullRequestService } = await import("../PullRequestService.js");

    pullRequestService.initialize("/repo");

    await pullRequestService.refresh();

    expect(clearPRCaches).toHaveBeenCalledTimes(1);

    pullRequestService.destroy();
  });

  it("caps error backoff at 5 minutes", async () => {
    const batchCheckLinkedPRs = vi.fn(async () => ({
      results: new Map(),
      error: "Server error",
    }));
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/backoff" })
    );

    await pullRequestService.start();
    // 1st error, backoff = 1 min
    expect(pullRequestService.getStatus().consecutiveErrors).toBe(1);

    await vi.advanceTimersByTimeAsync(60 * 1000);
    // 2nd error, backoff = 2 min
    expect(pullRequestService.getStatus().consecutiveErrors).toBe(2);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    // 3rd error, circuit breaker trips with 5 min backoff
    expect(pullRequestService.getStatus().consecutiveErrors).toBe(3);
    expect(pullRequestService.getStatus().isEnabled).toBe(false);

    // Advance 4 minutes — still tripped
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(pullRequestService.getStatus().isEnabled).toBe(false);

    // Advance 1 more minute (total 5) — should be enabled again
    await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
    expect(pullRequestService.getStatus().isEnabled).toBe(true);

    pullRequestService.destroy();
  });
});
