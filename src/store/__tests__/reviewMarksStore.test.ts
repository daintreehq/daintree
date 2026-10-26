// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewPoint } from "@shared/types/reviewPoint";
import type { ReviewMarkSummary, ReviewMarksSnapshot } from "@shared/types/ipc/reviewMarks";
import { notifyHostResync } from "../hostResyncSignal";
import {
  _resetReviewMarksStoreForTesting,
  clearWorktreeReviewMark,
  getReviewMarksRevision,
  markWorktreeReviewed,
  startReviewMarksSync,
  useReviewMarksStore,
  worktreeReviewMark,
} from "../reviewMarksStore";

const PROJECT = "a".repeat(64);
const WT_1 = "/repos/alpha/feature-1";
const WT_2 = "/repos/alpha/feature-2";
const COMMIT = "1".repeat(40);

type ChangedCallback = (snapshot: ReviewMarksSnapshot) => void;

function summary(revision: number, branch = "feature-1"): ReviewMarkSummary {
  return {
    markedAt: 10,
    capturedAt: 5,
    head: { kind: "branch", branch, commit: COMMIT },
    base: { ref: null, tip: null },
    complete: true,
    pathCount: 0,
    revision,
  };
}

function snapshot(marks: Record<string, ReviewMarkSummary>, revision: number): ReviewMarksSnapshot {
  return { projectId: PROJECT, marks, revision };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const POINT = { capturedAt: 5 } as unknown as ReviewPoint;

function installBridge() {
  const listeners: ChangedCallback[] = [];
  const hydrate = vi.fn(async (): Promise<ReviewMarksSnapshot | null> => snapshot({}, 0));
  const mark = vi.fn();
  const clear = vi.fn();
  const onChanged = vi.fn((cb: ChangedCallback) => {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  });
  // `defineProperty` rather than an assignment + cast: a partial stub of the
  // full `ElectronAPI` would need a type assertion the lint ratchet counts.
  Object.defineProperty(window, "electron", {
    value: { reviewMarks: { hydrate, mark, clear, onChanged } },
    configurable: true,
    writable: true,
  });
  return {
    hydrate,
    mark,
    clear,
    push: (next: ReviewMarksSnapshot) => {
      for (const cb of [...listeners]) cb(next);
    },
    listenerCount: () => listeners.length,
  };
}

let stop: (() => void) | null = null;

beforeEach(() => {
  _resetReviewMarksStoreForTesting();
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
});

describe("reviewMarksStore", () => {
  it("adopts the host's marks and then each push, dropping older ones", async () => {
    const bridge = installBridge();
    bridge.hydrate.mockResolvedValueOnce(snapshot({ [WT_1]: summary(1) }, 1));
    stop = startReviewMarksSync();
    await vi.waitFor(() => expect(useReviewMarksStore.getState().loaded).toBe(true));
    expect(useReviewMarksStore.getState().marks).toEqual({ [WT_1]: summary(1) });

    bridge.push(snapshot({ [WT_1]: summary(1), [WT_2]: summary(3, "feature-2") }, 3));
    bridge.push(snapshot({ [WT_1]: summary(1) }, 2));
    expect(Object.keys(useReviewMarksStore.getState().marks)).toEqual([WT_1, WT_2]);
    expect(getReviewMarksRevision()).toBe(3);
  });

  it("keeps a push that overtook the first read", async () => {
    const bridge = installBridge();
    const read = deferred<ReviewMarksSnapshot | null>();
    bridge.hydrate.mockReturnValueOnce(read.promise);
    stop = startReviewMarksSync();
    bridge.push(snapshot({ [WT_1]: summary(2) }, 2));
    read.resolve(snapshot({}, 1));
    await vi.waitFor(() => expect(bridge.hydrate).toHaveBeenCalled());
    await read.promise;
    await Promise.resolve();
    expect(useReviewMarksStore.getState().revision).toBe(2);
    expect(useReviewMarksStore.getState().marks[WT_1]).toBeDefined();
  });

  it("reads again while the view isn't bound to its project yet", async () => {
    vi.useFakeTimers();
    const bridge = installBridge();
    bridge.hydrate.mockResolvedValueOnce(null);
    bridge.hydrate.mockResolvedValueOnce(snapshot({ [WT_1]: summary(1) }, 1));
    stop = startReviewMarksSync();
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.hydrate).toHaveBeenCalledTimes(2);
    expect(useReviewMarksStore.getState().marks[WT_1]).toBeDefined();
  });

  it("reads again after a reconnect, behind a read already in flight", async () => {
    const bridge = installBridge();
    stop = startReviewMarksSync();
    await vi.waitFor(() => expect(useReviewMarksStore.getState().loaded).toBe(true));

    // The link dropped and the push for this mark never arrived.
    const first = deferred<ReviewMarksSnapshot | null>();
    bridge.hydrate.mockReturnValueOnce(first.promise);
    bridge.hydrate.mockResolvedValueOnce(snapshot({ [WT_1]: summary(4) }, 4));
    notifyHostResync();
    notifyHostResync();
    first.resolve(snapshot({}, 3));
    await vi.waitFor(() => expect(useReviewMarksStore.getState().revision).toBe(4));
    expect(bridge.hydrate).toHaveBeenCalledTimes(3);
    expect(useReviewMarksStore.getState().marks[WT_1]).toBeDefined();
  });

  it("tries the re-read after a reconnect again when it fails", async () => {
    const bridge = installBridge();
    stop = startReviewMarksSync();
    await vi.waitFor(() => expect(useReviewMarksStore.getState().loaded).toBe(true));
    vi.useFakeTimers();

    bridge.hydrate.mockRejectedValueOnce(new Error("link still settling"));
    bridge.hydrate.mockResolvedValueOnce(snapshot({ [WT_1]: summary(2) }, 2));
    notifyHostResync();
    await vi.advanceTimersByTimeAsync(300);

    expect(bridge.hydrate).toHaveBeenCalledTimes(3);
    expect(useReviewMarksStore.getState().revision).toBe(2);
  });

  it("adopts a write's reply, and one naming a reset store over what it held", async () => {
    const bridge = installBridge();
    bridge.hydrate.mockResolvedValueOnce(snapshot({ [WT_1]: summary(5) }, 5));
    stop = startReviewMarksSync();
    await vi.waitFor(() => expect(useReviewMarksStore.getState().revision).toBe(5));

    bridge.mark.mockResolvedValueOnce({
      status: "saved",
      snapshot: snapshot({ [WT_1]: summary(6) }, 6),
    });
    const basedOn = getReviewMarksRevision();
    expect((await markWorktreeReviewed(WT_1, POINT, basedOn)).status).toBe("saved");
    expect(bridge.mark).toHaveBeenCalledWith(WT_1, POINT, 5);
    expect(useReviewMarksStore.getState().revision).toBe(6);

    // The host's file was reset: its revisions start again below ours.
    bridge.clear.mockResolvedValueOnce({ status: "stale", snapshot: snapshot({}, 0) });
    expect((await clearWorktreeReviewMark(WT_1, 6)).status).toBe("stale");
    expect(useReviewMarksStore.getState()).toMatchObject({ marks: {}, revision: 0 });
  });

  it("stops following the host once disposed", async () => {
    const bridge = installBridge();
    stop = startReviewMarksSync();
    await vi.waitFor(() => expect(useReviewMarksStore.getState().loaded).toBe(true));
    stop();
    stop = null;
    expect(bridge.listenerCount()).toBe(0);
    notifyHostResync();
    expect(bridge.hydrate).toHaveBeenCalledTimes(1);
  });

  it("reports a mark as applying only on the branch it was made on", () => {
    const marks = { [WT_1]: summary(1) };
    expect(worktreeReviewMark(marks, { id: WT_2, branch: "feature-2" })).toBeNull();
    expect(worktreeReviewMark(marks, { id: WT_1, branch: "feature-1" })?.applicability).toBe(
      "applicable"
    );
    expect(worktreeReviewMark(marks, { id: WT_1, branch: "renamed" })?.applicability).toBe(
      "branch-changed"
    );
    expect(worktreeReviewMark(marks, { id: WT_1, isDetached: true })?.applicability).toBe(
      "branch-changed"
    );
    expect(worktreeReviewMark(marks, { id: WT_1 })?.applicability).toBe("branch-unknown");
  });
});
