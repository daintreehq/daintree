import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectPulse, PulseRangeDays } from "@shared/types";

const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: dispatchMock,
  },
}));

import { usePulseStore } from "../pulseStore";

function resetPulseStore() {
  usePulseStore.setState({
    pulses: new Map(),
    loading: new Map(),
    errors: new Map<string, string | null>(),
    rangeDays: 60,
    requestIds: new Map(),
    retryCount: new Map(),
    lastRetryTimestamp: new Map(),
    retryTimers: new Map(),
  });
}

describe("pulseStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetPulseStore();
  });

  // Cancel retries instead of running them: a retry fired here would answer
  // after the real clock is back and arm a real timer no test owns.
  afterEach(() => {
    usePulseStore.getState().invalidateAll();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("stores successful pulse fetch results", async () => {
    const pulse = {
      worktreeId: "wt-1",
      commitCount: 10,
      recentCommits: [],
      rangeDays: 60,
    } as unknown as ProjectPulse;

    dispatchMock.mockResolvedValueOnce({ ok: true, result: pulse });

    const result = await usePulseStore.getState().fetchPulse("wt-1");

    expect(result).toEqual(pulse);
    expect(usePulseStore.getState().getPulse("wt-1")).toEqual(pulse);
    expect(usePulseStore.getState().getRetryCount("wt-1")).toBe(0);
    expect(dispatchMock).toHaveBeenCalledWith(
      "git.getProjectPulse",
      expect.objectContaining({
        worktreeId: "wt-1",
        rangeDays: 60,
        includeDelta: true,
      }),
      { source: "user" }
    );
  });

  it("maps technical errors and schedules bounded retries", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: false,
      error: { message: "Not a git repository" },
    });

    const result = await usePulseStore.getState().fetchPulse("wt-2");

    expect(result).toBeNull();
    expect(usePulseStore.getState().getError("wt-2")).toBe(
      "This directory is not a git repository"
    );
    expect(usePulseStore.getState().getRetryCount("wt-2")).toBe(1);
    expect(usePulseStore.getState().retryTimers.has("wt-2")).toBe(true);

    const retryResult = await usePulseStore.getState().fetchPulse("wt-2", false, true);
    expect(retryResult).toBeNull();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("treats empty repositories as non-errors and skips retries", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: false,
      error: { message: "fatal: ambiguous argument 'HEAD'" },
    });

    const result = await usePulseStore.getState().fetchPulse("wt-empty");

    expect(result).toBeNull();
    expect(usePulseStore.getState().getError("wt-empty")).toBeNull();
    expect(usePulseStore.getState().getRetryCount("wt-empty")).toBe(0);
    expect(usePulseStore.getState().retryTimers.has("wt-empty")).toBe(false);
  });

  it.each([
    ["HEAD keyword", "Failed to read git HEAD: something"],
    ["Repository has no commits", "Repository has no commits"],
    ["does not have any commits yet", "your current branch 'main' does not have any commits yet"],
    ["no commits yet", "error: no commits yet on branch 'main'"],
  ])("treats no-commits error variant as null (no error): %s", async (_label, errorMessage) => {
    dispatchMock.mockResolvedValueOnce({
      ok: false,
      error: { message: errorMessage },
    });

    await usePulseStore.getState().fetchPulse("wt-new");

    expect(usePulseStore.getState().getError("wt-new")).toBeNull();
    expect(usePulseStore.getState().getRetryCount("wt-new")).toBe(0);
    expect(usePulseStore.getState().retryTimers.has("wt-new")).toBe(false);
  });

  it("clears stale request ids and cancels retries when range changes", () => {
    const retry = vi.fn();
    const timer = setTimeout(() => retry(), 2000);
    usePulseStore.setState({
      requestIds: new Map([["wt-3", 123]]),
      retryTimers: new Map([["wt-3", timer]]),
      retryCount: new Map([["wt-3", 2]]),
      lastRetryTimestamp: new Map([["wt-3", Date.now()]]),
    });

    usePulseStore.getState().setRangeDays(120);

    const state = usePulseStore.getState();
    expect(state.rangeDays).toBe(120);
    expect(state.requestIds.size).toBe(0);
    expect(state.retryTimers.size).toBe(0);
    expect(state.retryCount.size).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(retry).not.toHaveBeenCalled();
  });

  it("keeps every worktree's last snapshot across a range change", () => {
    const one = makePulse("wt-1", 60);
    const two = makePulse("wt-2", 60);
    usePulseStore.setState({
      pulses: new Map([
        ["wt-1", one],
        ["wt-2", two],
      ]),
      loading: new Map([["wt-1", true]]),
      errors: new Map([["wt-2", "Unable to load activity data"]]),
    });

    usePulseStore.getState().setRangeDays(120);

    const state = usePulseStore.getState();
    expect(state.getPulse("wt-1")).toBe(one);
    expect(state.getPulse("wt-2")).toBe(two);
    expect(state.isLoading("wt-1")).toBe(false);
    expect(state.getError("wt-2")).toBeUndefined();
  });

  it("drops a snapshot from another range when the new range fails", async () => {
    const other = makePulse("wt-2", 60);
    usePulseStore.setState({
      pulses: new Map([
        ["wt-1", makePulse("wt-1", 60)],
        ["wt-2", other],
      ]),
    });
    usePulseStore.getState().setRangeDays(120);
    dispatchMock.mockResolvedValueOnce({ ok: false, error: { message: "boom" } });

    await usePulseStore.getState().fetchPulse("wt-1");

    expect(usePulseStore.getState().getPulse("wt-1")).toBeUndefined();
    expect(usePulseStore.getState().getError("wt-1")).toBe("Unable to load activity data");
    expect(usePulseStore.getState().getPulse("wt-2")).toBe(other);
  });

  it("drops a snapshot from another range when the new range has no commits", async () => {
    usePulseStore.setState({ pulses: new Map([["wt-1", makePulse("wt-1", 60)]]) });
    usePulseStore.getState().setRangeDays(180);
    dispatchMock.mockResolvedValueOnce({ ok: false, error: { message: "no commits yet" } });

    await usePulseStore.getState().fetchPulse("wt-1");

    expect(usePulseStore.getState().getPulse("wt-1")).toBeUndefined();
    expect(usePulseStore.getState().getError("wt-1")).toBeNull();
  });

  it("keeps a same-range snapshot when a refresh fails", async () => {
    const kept = makePulse("wt-1", 60);
    usePulseStore.setState({ pulses: new Map([["wt-1", kept]]) });
    dispatchMock.mockResolvedValueOnce({ ok: false, error: { message: "boom" } });

    await usePulseStore.getState().fetchPulse("wt-1");

    expect(usePulseStore.getState().getPulse("wt-1")).toBe(kept);
  });

  it("ignores a late failure from an earlier request in the same millisecond", async () => {
    const first = deferred();
    dispatchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(new Promise(() => {}));
    const store = usePulseStore.getState();

    const firstFetch = store.fetchPulse("wt-1");
    store.setRangeDays(120);
    store.setRangeDays(60);
    void store.fetchPulse("wt-1");

    first.resolve({ ok: false, error: { message: "boom" } });
    await firstFetch;

    const state = usePulseStore.getState();
    expect(state.isLoading("wt-1")).toBe(true);
    expect(state.getError("wt-1")).toBeNull();
    expect(state.getRetryCount("wt-1")).toBe(0);
    expect(state.retryTimers.has("wt-1")).toBe(false);
  });

  it("ignores a late answer from an earlier request in the same millisecond", async () => {
    const first = deferred();
    const third = deferred();
    dispatchMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(new Promise(() => {}))
      .mockReturnValueOnce(third.promise);
    const store = usePulseStore.getState();

    const firstFetch = store.fetchPulse("wt-1");
    store.setRangeDays(120);
    void store.fetchPulse("wt-1");
    store.setRangeDays(60);
    const thirdFetch = store.fetchPulse("wt-1");

    const stale = makePulse("wt-1", 60);
    first.resolve({ ok: true, result: stale });
    expect(await firstFetch).toBeNull();
    expect(usePulseStore.getState().getPulse("wt-1")).toBeUndefined();
    expect(usePulseStore.getState().isLoading("wt-1")).toBe(true);

    const fresh = makePulse("wt-1", 60);
    third.resolve({ ok: true, result: fresh });
    expect(await thirdFetch).toBe(fresh);
    expect(usePulseStore.getState().getPulse("wt-1")).toBe(fresh);
  });
});

function makePulse(worktreeId: string, rangeDays: PulseRangeDays): ProjectPulse {
  return { worktreeId, rangeDays, heatmap: [], generatedAt: Date.now() } as unknown as ProjectPulse;
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
