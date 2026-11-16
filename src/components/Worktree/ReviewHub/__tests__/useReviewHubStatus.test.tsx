// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const status = { currentBranch: "feature", staged: [], unstaged: [] } as unknown as StagingStatus;

function captured(captureId: string): ReviewMarkCaptureOutcome {
  return { status: "captured", capture: { captureId } } as unknown as ReviewMarkCaptureOutcome;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

  it("sends nothing for an opening closed while its capture runs", async () => {
    const capture = deferred<ReviewMarkCaptureOutcome>();
    marks.capture.mockReturnValueOnce(capture.promise);
    const { rerender } = renderStatus();

    rerender({ open: false });
    await advance(5_000);
    await act(async () => capture.resolve(captured("c1")));
    await advance(5_000);

    expect(getStagingStatus).not.toHaveBeenCalled();
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
