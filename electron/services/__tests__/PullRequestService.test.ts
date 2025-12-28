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

    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs }));

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
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs }));

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
    vi.doMock("../GitHubService.js", () => ({ batchCheckLinkedPRs }));

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
});
