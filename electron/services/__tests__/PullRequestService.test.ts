import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
import type { DaintreeEventMap } from "../events.js";
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

    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
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

    const cleared: DaintreeEventMap["sys:pr:cleared"][] = [];
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

  it("reschedules polling when checkForPRs throws unexpectedly", async () => {
    let callCount = 0;
    const batchCheckLinkedPRs = vi.fn(async (_cwd: string, _candidates: PRCheckCandidate[]) => {
      callCount++;
      if (callCount === 2) {
        throw new Error("Unexpected kaboom");
      }
      return {
        results: new Map(),
      };
    });
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));
    vi.doMock("../../utils/logger.js", () => ({
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logDebug: vi.fn(),
    }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/throw-test" })
    );

    await pullRequestService.start();
    expect(callCount).toBe(1);

    // Advance past normal poll interval (30s focused default) — checkForPRs throws
    await vi.advanceTimersByTimeAsync(30 * 1000);
    expect(callCount).toBe(2);

    // The poll loop should have rescheduled despite the throw.
    // Advance past the 1-error backoff (1 min) to trigger next poll.
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(callCount).toBe(3);

    pullRequestService.destroy();
  });

  it("reschedules revalidation when revalidateResolvedPRs throws unexpectedly", async () => {
    let revalidationCallCount = 0;
    const batchCheckLinkedPRs = vi.fn(async (_cwd: string, candidates: PRCheckCandidate[]) => {
      // First call is from start() — resolve the PR so revalidation has something to do
      // Subsequent calls are revalidation
      if (revalidationCallCount === 0) {
        revalidationCallCount++;
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
      }
      revalidationCallCount++;
      if (revalidationCallCount === 2) {
        throw new Error("Revalidation kaboom");
      }
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
    const logWarnMock = vi.fn();
    vi.doMock("../../utils/logger.js", () => ({
      logInfo: vi.fn(),
      logWarn: logWarnMock,
      logDebug: vi.fn(),
    }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/reval-throw" })
    );

    await pullRequestService.start();
    expect(revalidationCallCount).toBe(1);

    // Advance 90s — first revalidation fires and throws
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(revalidationCallCount).toBe(2);
    expect(logWarnMock).toHaveBeenCalledWith("Revalidation check error", {
      error: "Revalidation kaboom",
    });

    // Advance another 90s — revalidation should have rescheduled despite the throw
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(revalidationCallCount).toBe(3);

    pullRequestService.destroy();
  });

  it("logs warning but does not double-schedule when debounced check throws", async () => {
    let callCount = 0;
    const batchCheckLinkedPRs = vi.fn(async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error("Debounce kaboom");
      }
      return { results: new Map() };
    });
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));
    const logWarnMock = vi.fn();
    vi.doMock("../../utils/logger.js", () => ({
      logInfo: vi.fn(),
      logWarn: logWarnMock,
      logDebug: vi.fn(),
    }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    // Register the worktree and start polling
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/debounce-throw" })
    );
    await pullRequestService.start();
    expect(callCount).toBe(1);

    // Trigger a branch change to cause a debounced check
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/debounce-throw-2" })
    );

    // Advance past debounce timer (100ms) to trigger the throwing checkForPRs
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(2);
    expect(logWarnMock).toHaveBeenCalledWith("PR check failed", {
      error: "Debounce kaboom",
      consecutiveErrors: 1,
    });

    pullRequestService.destroy();
  });

  it("does not track root worktree even on non-default branch", async () => {
    const batchCheckLinkedPRs = vi.fn(async () => ({ results: new Map() }));
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-root", branch: "develop", isMainWorktree: true })
    );

    await pullRequestService.refresh();

    expect(batchCheckLinkedPRs).not.toHaveBeenCalled();

    pullRequestService.destroy();
  });

  it("evicts root worktree from candidates when isMainWorktree becomes true", async () => {
    const batchCheckLinkedPRs = vi.fn(async () => ({ results: new Map() }));
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    // First update without isMainWorktree — gets tracked as candidate
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-root", branch: "develop" })
    );
    await pullRequestService.refresh();
    expect(batchCheckLinkedPRs).toHaveBeenCalledTimes(1);
    expect(pullRequestService.getStatus().candidateCount).toBe(1);

    // Second update with isMainWorktree: true — evicted from candidates
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-root", branch: "develop", isMainWorktree: true })
    );

    expect(pullRequestService.getStatus().candidateCount).toBe(0);

    // Subsequent refresh should not check any candidates
    batchCheckLinkedPRs.mockClear();
    await pullRequestService.refresh();
    expect(batchCheckLinkedPRs).not.toHaveBeenCalled();

    pullRequestService.destroy();
  });

  it("tracks non-main worktree on develop branch normally", async () => {
    const batchCheckLinkedPRs = vi.fn(async (_cwd: string, candidates: PRCheckCandidate[]) => ({
      results: new Map(
        candidates.map((c) => [
          c.worktreeId,
          {
            issueNumber: c.issueNumber,
            branchName: c.branchName,
            pr: {
              number: 55,
              title: "Develop PR",
              url: "https://github.com/o/r/pull/55",
              state: "open" as const,
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

    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
    const unsubDetected = events.on("sys:pr:detected", (p) => detected.push(p));

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-linked", branch: "develop", isMainWorktree: false })
    );

    await pullRequestService.refresh();

    expect(batchCheckLinkedPRs).toHaveBeenCalledTimes(1);
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({ worktreeId: "wt-linked", prNumber: 55 });

    unsubDetected();
    pullRequestService.destroy();
  });

  it("setFocusCadence(false) lengthens the next poll to the blurred interval", async () => {
    let callCount = 0;
    const batchCheckLinkedPRs = vi.fn(async () => {
      callCount++;
      return { results: new Map() };
    });
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/cadence" })
    );

    await pullRequestService.start();
    expect(callCount).toBe(1);

    pullRequestService.setFocusCadence(false);

    // 30s elapsed should NOT trigger a poll under the 120s blurred cadence
    await vi.advanceTimersByTimeAsync(30 * 1000);
    expect(callCount).toBe(1);

    // 120s total elapsed should trigger the next poll
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(callCount).toBe(2);

    pullRequestService.destroy();
  });

  it("setFocusCadence(true) fires an immediate catch-up poll on focus regain", async () => {
    let callCount = 0;
    const batchCheckLinkedPRs = vi.fn(async () => {
      callCount++;
      return { results: new Map() };
    });
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/catchup" })
    );

    await pullRequestService.start();
    expect(callCount).toBe(1);

    // Blur, then focus — should immediately catch up
    pullRequestService.setFocusCadence(false);
    await vi.advanceTimersByTimeAsync(10 * 1000);
    expect(callCount).toBe(1);

    pullRequestService.setFocusCadence(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(2);

    pullRequestService.destroy();
  });

  it("throttles repeated focus catch-ups within 5s", async () => {
    let callCount = 0;
    const batchCheckLinkedPRs = vi.fn(async () => {
      callCount++;
      return { results: new Map() };
    });
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/throttle" })
    );

    await pullRequestService.start();
    expect(callCount).toBe(1);

    // First focus → catch-up fires
    pullRequestService.setFocusCadence(false);
    pullRequestService.setFocusCadence(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(2);

    // Second blur→focus within 5s → no extra poll
    await vi.advanceTimersByTimeAsync(2 * 1000);
    pullRequestService.setFocusCadence(false);
    pullRequestService.setFocusCadence(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(2);

    // After 5s+ has elapsed since the last catch-up, focus regain fires again
    await vi.advanceTimersByTimeAsync(4 * 1000);
    pullRequestService.setFocusCadence(false);
    pullRequestService.setFocusCadence(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(3);

    pullRequestService.destroy();
  });

  it("setFocusCadence is a no-op while not polling but still updates the stored interval", async () => {
    const batchCheckLinkedPRs = vi.fn(async () => ({ results: new Map() }));
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/idle" })
    );

    pullRequestService.setFocusCadence(false);
    expect(batchCheckLinkedPRs).not.toHaveBeenCalled();

    await pullRequestService.start();
    // start() preserves the blurred cadence set while idle
    expect(batchCheckLinkedPRs).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30 * 1000);
    expect(batchCheckLinkedPRs).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(batchCheckLinkedPRs).toHaveBeenCalledTimes(2);

    pullRequestService.destroy();
  });

  it("does not leak a duplicate timer when blur arrives mid-catchup", async () => {
    // Regression: blur during in-flight focus catch-up used to orphan the
    // background-cadence timer set by updatePollInterval(120s) when the
    // catch-up's .finally re-entered scheduleNextPoll without first clearing
    // the existing pollTimer.
    let resolveCheck: (() => void) | null = null;
    let callCount = 0;
    const batchCheckLinkedPRs = vi.fn(async () => {
      callCount++;
      // Hold the catch-up promise open so blur can interleave.
      if (callCount === 2) {
        await new Promise<void>((resolve) => {
          resolveCheck = resolve;
        });
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
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/leak" })
    );

    await pullRequestService.start();
    expect(callCount).toBe(1);

    // Focus regain — fires catch-up that hangs awaiting `resolveCheck`.
    pullRequestService.setFocusCadence(true);
    await Promise.resolve();
    expect(callCount).toBe(2);

    // Blur arrives mid-catchup — sets the 120s timer.
    pullRequestService.setFocusCadence(false);

    // Resolve the in-flight catch-up; .finally calls scheduleNextPoll again.
    resolveCheck!();
    await vi.advanceTimersByTimeAsync(0);

    // Advance one full blurred cycle. With the leak, two timers would fire
    // → callCount becomes 4. Fixed: exactly one timer fires → callCount = 3.
    await vi.advanceTimersByTimeAsync(120 * 1000);
    expect(callCount).toBe(3);

    pullRequestService.destroy();
  });

  it("polls at 30s by default after start() with no interval argument", async () => {
    let callCount = 0;
    const batchCheckLinkedPRs = vi.fn(async () => {
      callCount++;
      return { results: new Map() };
    });
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs, clearPRCaches }));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/default" })
    );

    await pullRequestService.start();
    expect(callCount).toBe(1);

    // Under the old 60s clamp this would have required 60s
    await vi.advanceTimersByTimeAsync(30 * 1000);
    expect(callCount).toBe(2);

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
