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

  afterEach(() => {
    vi.runOnlyPendingTimers();
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

  it("clears stale request ids when range changes", () => {
    const timer = setTimeout(() => {}, 2000);
    usePulseStore.setState({
      requestIds: new Map([["wt-3", 123]]),
      retryTimers: new Map([["wt-3", timer]]),
      retryCount: new Map([["wt-3", 2]]),
      lastRetryTimestamp: new Map([["wt-3", Date.now()]]),
    });

    usePulseStore.getState().setRangeDays(30 as PulseRangeDays);

    const state = usePulseStore.getState();
    expect(state.rangeDays).toBe(30);
    expect(state.requestIds.size).toBe(0);
    expect(state.retryTimers.size).toBe(0);
    expect(state.retryCount.size).toBe(0);
  });
});
