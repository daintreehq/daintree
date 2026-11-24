// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import type { StagingStatus } from "@shared/types";
import type { ReviewMarkCaptureOutcome } from "@shared/types/ipc/reviewMarks";
import { resetStagingStatusCacheForTests } from "../stagingStatusCache";
import { useReviewHubStatus } from "../useReviewHubStatus";

const { marks } = vi.hoisted(() => ({
  marks: {
    available: true,
    capture: vi.fn<(worktreeId: string) => Promise<ReviewMarkCaptureOutcome>>(),
  },
}));

vi.mock("@/store/reviewMarksStore", () => ({
  reviewMarkCapturesAvailable: () => marks.available,
  captureForReviewMark: (worktreeId: string) =>
    marks.available ? marks.capture(worktreeId) : null,
  getReviewMarksRevision: () => 0,
}));

const WT = "/repo/wt";
const status: StagingStatus = {
  staged: [],
  unstaged: [{ path: "src/app.ts", status: "modified", insertions: 3, deletions: 1 }],
  conflicted: [],
  conflictedFiles: [],
  isDetachedHead: false,
  currentBranch: "feature",
  hasRemote: false,
  pushDestination: { remote: "origin", branch: "feature" },
  pullSource: { remote: "origin", branch: "feature" },
  repoState: "DIRTY",
  repoOperationId: null,
  rebaseStep: null,
  rebaseTotalSteps: null,
  rebaseSequence: null,
};

function captured(captureId: string): ReviewMarkCaptureOutcome {
  return {
    status: "captured",
    capture: {
      captureId,
      capturedAt: 1,
      head: { kind: "branch", branch: "feature", commit: "a".repeat(40) },
      complete: true,
      pathCount: 1,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const getStagingStatus = vi.fn<(path: string) => Promise<StagingStatus>>();

function renderStatus(isOpen = true) {
  return renderHook(
    ({ open }: { open: boolean }) =>
      useReviewHubStatus({ isOpen: open, worktreePath: WT, worktreeId: "wt-1" }),
    { initialProps: { open: isOpen } }
  );
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  marks.available = true;
  marks.capture.mockReset().mockResolvedValue(captured("c1"));
  getStagingStatus.mockReset().mockResolvedValue(status);
  Object.defineProperty(window, "electron", {
    value: {
      git: { getStagingStatus },
      worktreePort: { onEvent: vi.fn(() => vi.fn()) },
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  resetStagingStatusCacheForTests();
});

describe("useReviewHubStatus beginOpen", () => {
  it("seeds an opening once, so a second call can't leave its status stale", async () => {
    const { result, rerender } = renderStatus();
    act(() => result.current.beginOpen());
    await advance(0);
    expect(result.current.statusIsFresh).toBe(true);
    expect(result.current.statusCapture?.capture.captureId).toBe("c1");

    act(() => result.current.beginOpen());

    expect(result.current.statusIsFresh).toBe(true);
    expect(result.current.statusCapture?.capture.captureId).toBe("c1");
    expect(getStagingStatus).toHaveBeenCalledTimes(1);

    // A new opening is a new session, which begins again.
    rerender({ open: false });
    const capture = deferred<ReviewMarkCaptureOutcome>();
    marks.capture.mockReturnValueOnce(capture.promise);
    rerender({ open: true });
    act(() => result.current.beginOpen());
    expect(result.current.statusIsFresh).toBe(false);
    expect(result.current.statusCapture).toBeNull();
  });
});

describe("useReviewHubStatus opening read", () => {
  it("reads once, after a capture that lands in time, and shows that capture", async () => {
    const capture = deferred<ReviewMarkCaptureOutcome>();
    marks.capture.mockReturnValueOnce(capture.promise);
    const { result } = renderStatus();

    // Raised for the wait too, so a cold open's skeleton covers the capture.
    expect(result.current.loading).toBe(true);
    expect(getStagingStatus).not.toHaveBeenCalled();

    await act(async () => capture.resolve(captured("c1")));
    await advance(5_000);

    expect(getStagingStatus).toHaveBeenCalledTimes(1);
    expect(result.current.statusCapture?.capture.captureId).toBe("c1");
    expect(result.current.statusIsFresh).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it("reads without a slow capture, then once after it, and never a third time", async () => {
    const capture = deferred<ReviewMarkCaptureOutcome>();
    marks.capture.mockReturnValueOnce(capture.promise);
    const { result } = renderStatus();

    await advance(399);
    expect(getStagingStatus).not.toHaveBeenCalled();
    await advance(1);
    expect(getStagingStatus).toHaveBeenCalledTimes(1);
    expect(result.current.statusIsFresh).toBe(true);
    // The read that went out without it can't show a capture.
    expect(result.current.statusCapture).toBeNull();

    // Past the background lane's own early-read wait: the deadline read stood in for it.
    await advance(5_000);
    expect(getStagingStatus).toHaveBeenCalledTimes(1);

    await act(async () => capture.resolve(captured("c1")));
    await advance(0);
    expect(getStagingStatus).toHaveBeenCalledTimes(2);
    expect(result.current.statusCapture?.capture.captureId).toBe("c1");
  });

  it("reads straight away where it can't capture", async () => {
    marks.available = false;
    const { result } = renderStatus();

    expect(getStagingStatus).toHaveBeenCalledTimes(1);
    await advance(5_000);
    expect(getStagingStatus).toHaveBeenCalledTimes(1);
    expect(result.current.statusIsFresh).toBe(true);
    expect(marks.capture).not.toHaveBeenCalled();
  });

  it("sends nothing for an opening closed while its capture runs, and stops loading", async () => {
    const capture = deferred<ReviewMarkCaptureOutcome>();
    marks.capture.mockReturnValueOnce(capture.promise);
    const { result, rerender } = renderStatus();
    expect(result.current.loading).toBe(true);

    rerender({ open: false });
    expect(result.current.loading).toBe(false);
    await advance(5_000);
    await act(async () => capture.resolve(captured("c1")));
    await advance(5_000);

    expect(getStagingStatus).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it("lets a Refresh joining a background capture stand in for its early read", async () => {
    const { result } = renderStatus();
    await advance(0);
    expect(getStagingStatus).toHaveBeenCalledTimes(1);

    // An event's capture runs long; Refresh lands just before its early read is due.
    const running = deferred<ReviewMarkCaptureOutcome>();
    marks.capture.mockReturnValueOnce(running.promise).mockResolvedValueOnce(captured("c3"));
    act(() => result.current.readWithCapture());
    await advance(1_400);
    act(() => result.current.refreshWithCapture());
    const deadlineRead = deferred<StagingStatus>();
    getStagingStatus.mockReturnValueOnce(deadlineRead.promise);

    await advance(399);
    expect(getStagingStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(getStagingStatus).toHaveBeenCalledTimes(2);
    // Sent as Refresh's own read, so its answer is what lowers `loading`.
    expect(result.current.loading).toBe(true);
    await act(async () => deadlineRead.resolve(status));
    expect(result.current.loading).toBe(false);

    await act(async () => running.resolve(captured("c2")));
    await advance(0);
    expect(getStagingStatus).toHaveBeenCalledTimes(3);
    expect(result.current.statusCapture?.capture.captureId).toBe("c3");
  });

  it("captures again for a Refresh that joins a running capture, then reads once", async () => {
    const { result } = renderStatus();
    await advance(0);
    expect(getStagingStatus).toHaveBeenCalledTimes(1);

    // An event starts a capture; Refresh lands while it runs.
    const running = deferred<ReviewMarkCaptureOutcome>();
    marks.capture.mockReturnValueOnce(running.promise).mockResolvedValueOnce(captured("c3"));
    act(() => result.current.readWithCapture());
    act(() => result.current.refreshWithCapture());
    expect(result.current.loading).toBe(true);

    // The capture that was running may predate whatever Refresh was pressed for.
    await act(async () => running.resolve(captured("c2")));
    await advance(0);

    expect(marks.capture).toHaveBeenCalledTimes(3);
    expect(getStagingStatus).toHaveBeenCalledTimes(2);
    expect(result.current.statusCapture?.capture.captureId).toBe("c3");
    expect(result.current.loading).toBe(false);
  });
});

describe("useReviewHubStatus failed reads", () => {
  const newer: StagingStatus = { ...status, currentBranch: "newer" };

  it("keeps a newer background success over an older foreground read that rejects", async () => {
    marks.available = false;
    const foreground = deferred<StagingStatus>();
    getStagingStatus.mockReturnValueOnce(foreground.promise);
    const { result } = renderStatus();
    expect(result.current.loading).toBe(true);

    getStagingStatus.mockResolvedValueOnce(newer);
    act(() => result.current.readWithCapture());
    await advance(0);
    expect(result.current.status?.currentBranch).toBe("newer");

    await act(async () => foreground.reject(new Error("git status failed")));

    expect(result.current.status?.currentBranch).toBe("newer");
    expect(result.current.statusIsFresh).toBe(true);
    expect(result.current.loadError).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("still shows a foreground failure that nothing newer answered", async () => {
    marks.available = false;
    const foreground = deferred<StagingStatus>();
    getStagingStatus.mockReturnValueOnce(foreground.promise);
    const { result } = renderStatus();

    await act(async () => foreground.reject(new Error("git status failed")));

    expect(result.current.loadError).toBe("git status failed");
    expect(result.current.loading).toBe(false);
  });

  it("lets an older read that succeeds after a newer failure restore the list", async () => {
    marks.available = false;
    const opening = deferred<StagingStatus>();
    getStagingStatus.mockReturnValueOnce(opening.promise);
    const { result } = renderStatus();
    act(() => result.current.beginOpen());

    const background = deferred<StagingStatus>();
    getStagingStatus.mockReturnValueOnce(background.promise);
    act(() => result.current.readWithCapture());
    const foreground = deferred<StagingStatus>();
    getStagingStatus.mockReturnValueOnce(foreground.promise);
    act(() => void result.current.refresh());

    // The opening's read, superseded by Refresh, fails with nothing published
    // yet: only its request id keeps it from showing.
    await act(async () => opening.reject(new Error("opening failed")));
    expect(result.current.loadError).toBeNull();
    expect(result.current.loading).toBe(true);

    // A rejection (the host's rate limit, say) carries no status to order by.
    await act(async () => foreground.reject(new Error("rate limited")));
    expect(result.current.loadError).toBe("rate limited");
    expect(result.current.loading).toBe(false);
    expect(result.current.statusIsFresh).toBe(false);

    await act(async () => background.resolve(newer));
    expect(result.current.status?.currentBranch).toBe("newer");
    expect(result.current.loadError).toBeNull();
    expect(result.current.statusIsFresh).toBe(true);
    expect(result.current.isBackgroundRefreshing).toBe(false);
  });

  it("shows a Refresh's failure over an earlier result, until a newer read answers", async () => {
    marks.available = false;
    const { result } = renderStatus();
    await advance(0);
    expect(result.current.status?.currentBranch).toBe("feature");

    const foreground = deferred<StagingStatus>();
    getStagingStatus.mockReturnValueOnce(foreground.promise);
    act(() => void result.current.refresh());
    const background = deferred<StagingStatus>();
    getStagingStatus.mockReturnValueOnce(background.promise);
    act(() => result.current.readWithCapture());

    await act(async () => foreground.reject(new Error("git status failed")));
    expect(result.current.loadError).toBe("git status failed");
    expect(result.current.loading).toBe(false);

    await act(async () => background.resolve(newer));
    expect(result.current.status?.currentBranch).toBe("newer");
    expect(result.current.loadError).toBeNull();
  });

  it("keeps a held Refresh's failure for another worktree out of the open one", async () => {
    marks.available = false;
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) =>
        useReviewHubStatus({ isOpen: true, worktreePath: path, worktreeId: "wt-1" }),
      { initialProps: { path: WT } }
    );
    await advance(0);
    // A staging action awaiting its git call holds this worktree's `refresh`.
    const heldRefresh = result.current.refresh;

    rerender({ path: "/repo/other" });
    await advance(0);
    expect(result.current.loadError).toBeNull();

    getStagingStatus.mockClear();
    getStagingStatus.mockRejectedValueOnce(new Error("not a git repository"));
    await act(async () => heldRefresh());

    // It never reads a worktree the hub has left, so it has no failure to show.
    expect(getStagingStatus).not.toHaveBeenCalled();
    expect(result.current.loadError).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});

describe("useReviewHubStatus after a worktree switch", () => {
  const OTHER = "/repo/other";

  it("ignores a refresh held from the previous worktree, so the new one's read still lands", async () => {
    marks.available = false;
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) =>
        useReviewHubStatus({ isOpen: true, worktreePath: path, worktreeId: "wt-1" }),
      { initialProps: { path: WT } }
    );
    await advance(0);
    // What a staging write started on the first worktree calls once it settles.
    const heldRefresh = result.current.refresh;

    const otherRead = deferred<StagingStatus>();
    getStagingStatus.mockReturnValueOnce(otherRead.promise);
    rerender({ path: OTHER });
    act(() => result.current.beginOpen());
    expect(getStagingStatus).toHaveBeenLastCalledWith(OTHER);
    getStagingStatus.mockClear();

    await act(async () => {
      await heldRefresh();
    });
    expect(getStagingStatus).not.toHaveBeenCalled();

    await act(async () => otherRead.resolve({ ...status, currentBranch: "other" }));
    expect(result.current.status?.currentBranch).toBe("other");
    expect(result.current.statusIsFresh).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it("answers whether a path is the worktree open now, from the switch's own commit", async () => {
    marks.available = false;
    // A layout effect declared after the hook runs after its own: what anything
    // settling between the switch's commit and its passive effects would see.
    const seenAtCommit: boolean[] = [];
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => {
        const hub = useReviewHubStatus({ isOpen: true, worktreePath: path, worktreeId: "wt-1" });
        const { isOpenPath } = hub;
        useLayoutEffect(() => {
          seenAtCommit.push(isOpenPath(WT));
        }, [isOpenPath, path]);
        return hub;
      },
      { initialProps: { path: WT } }
    );
    await advance(0);
    expect(result.current.isOpenPath(WT)).toBe(true);
    seenAtCommit.length = 0;

    rerender({ path: OTHER });
    await advance(0);

    expect(seenAtCommit[0]).toBe(false);
    expect(result.current.isOpenPath(WT)).toBe(false);
    expect(result.current.isOpenPath(OTHER)).toBe(true);
  });
});
