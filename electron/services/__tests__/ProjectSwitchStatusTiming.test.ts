import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusTimingMarks } from "../../../shared/types/workspace-host.js";

const { logInfoMock } = vi.hoisted(() => ({ logInfoMock: vi.fn() }));

vi.mock("../../utils/logger.js", () => ({ logInfo: logInfoMock }));

import {
  ProjectSwitchStatusTiming,
  STATUS_TIMING_DEADLINE_MS,
  STATUS_TIMING_REPORT_GRACE_MS,
} from "../ProjectSwitchStatusTiming.js";

const T0 = 1_700_000_000_000;

function hostMarks(overrides: Partial<HostStatusTimingMarks> = {}): HostStatusTimingMarks {
  return {
    loadStartedAt: T0 + 40,
    enumeratedAt: T0 + 180,
    firstSnapshotAt: T0 + 200,
    firstStatusAt: [T0 + 2_400, T0 + 900, T0 + 1_600],
    monitorCount: 3,
    ...overrides,
  };
}

function report(
  switchId: string,
  rendererAppliedAt: number | null,
  host: HostStatusTimingMarks = hostMarks(),
  rendererStatusCount = host.firstStatusAt.length
) {
  return {
    type: "switch-status-timing" as const,
    switchId,
    rendererAppliedAt,
    rendererStatusCount,
    host,
  };
}

function lastRecord(): Record<string, unknown> {
  expect(logInfoMock).toHaveBeenCalledTimes(1);
  const [message, context] = logInfoMock.mock.calls[0]!;
  expect(message).toBe("projectswitch.status-timing");
  return context as Record<string, unknown>;
}

describe("ProjectSwitchStatusTiming", () => {
  let timing: ProjectSwitchStatusTiming;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    logInfoMock.mockReset();
    timing = new ProjectSwitchStatusTiming();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the view's deadline measured from the request", () => {
    expect(timing.begin("s1", "p1", 1, T0 - 300)).toBe(T0 - 300 + STATUS_TIMING_DEADLINE_MS);
  });

  it("writes one record when the view reports its statuses applied on a cold host", () => {
    timing.begin("s1", "p1", 1, T0);
    vi.setSystemTime(T0 + 350);
    timing.hostReady("s1", "cold");
    vi.setSystemTime(T0 + 2_500);
    timing.complete(report("s1", T0 + 2_450));

    expect(lastRecord()).toEqual({
      projectId: "p1",
      switchId: "s1",
      outcome: "applied",
      host: "cold",
      worktreeCount: 3,
      hostReadyMs: 350,
      hostLoadStartMs: 40,
      worktreesEnumeratedMs: 180,
      firstSnapshotMs: 200,
      firstStatusMs: [900, 1_600, 2_400],
      preExistingStatusCount: 0,
      missingStatusCount: 0,
      statusAppliedMs: 2_450,
      appliedStatusCount: 3,
      totalMs: 2_500,
    });
    expect(timing.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts a warm host's earlier statuses instead of timing them", () => {
    timing.begin("s1", "p1", 1, T0);
    vi.setSystemTime(T0 + 5);
    timing.hostReady("s1", "warm");
    timing.complete(
      report(
        "s1",
        T0 + 60,
        hostMarks({
          loadStartedAt: T0 - 90_000,
          enumeratedAt: T0 - 89_000,
          firstSnapshotAt: T0 - 88_900,
          firstStatusAt: [T0 - 80_000, T0 - 79_000, T0 + 30],
        })
      )
    );

    const record = lastRecord();
    expect(record).toMatchObject({
      outcome: "applied",
      host: "warm",
      hostLoadStartMs: null,
      worktreesEnumeratedMs: null,
      firstSnapshotMs: null,
      firstStatusMs: [30],
      preExistingStatusCount: 2,
      statusAppliedMs: 60,
    });
  });

  it("records a deadline report as a timeout with the statuses that did land", () => {
    timing.begin("s1", "p1", 1, T0);
    timing.hostReady("s1", "cold");
    vi.setSystemTime(T0 + STATUS_TIMING_DEADLINE_MS);
    timing.complete(report("s1", null, hostMarks({ firstStatusAt: [T0 + 900] }), 1));

    expect(lastRecord()).toMatchObject({
      outcome: "timeout",
      worktreeCount: 3,
      firstStatusMs: [900],
      missingStatusCount: 2,
      statusAppliedMs: null,
      appliedStatusCount: 1,
    });
  });

  it("writes a main-only record when no report arrives by the backstop", () => {
    timing.begin("s1", "p1", 1, T0);
    timing.hostReady("s1", "cold");
    vi.advanceTimersByTime(STATUS_TIMING_DEADLINE_MS + STATUS_TIMING_REPORT_GRACE_MS - 1);
    expect(logInfoMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(lastRecord()).toMatchObject({
      outcome: "no-report",
      host: "cold",
      worktreeCount: null,
      firstStatusMs: [],
      missingStatusCount: null,
      statusAppliedMs: null,
      totalMs: STATUS_TIMING_DEADLINE_MS + STATUS_TIMING_REPORT_GRACE_MS,
    });
    expect(timing.size).toBe(0);
  });

  it("supersedes the previous switch in the same window and drops its late report", () => {
    timing.begin("s1", "p1", 1, T0);
    vi.setSystemTime(T0 + 100);
    timing.begin("s2", "p2", 1, T0 + 100);

    expect(lastRecord()).toMatchObject({ switchId: "s1", outcome: "superseded", totalMs: 100 });
    logInfoMock.mockReset();

    timing.complete(report("s1", T0 + 200));
    expect(logInfoMock).not.toHaveBeenCalled();

    timing.complete(report("s2", T0 + 400));
    expect(lastRecord()).toMatchObject({ switchId: "s2", projectId: "p2", outcome: "applied" });
    expect(timing.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps switches in different windows independent", () => {
    timing.begin("s1", "p1", 1, T0);
    timing.begin("s2", "p1", 2, T0);
    expect(logInfoMock).not.toHaveBeenCalled();
    expect(timing.size).toBe(2);

    timing.complete(report("s2", T0 + 10));
    timing.complete(report("s1", T0 + 20));
    expect(logInfoMock).toHaveBeenCalledTimes(2);
    expect(timing.size).toBe(0);
  });

  it.each(["load-failed", "swap-failed"] as const)("finishes at once on %s", (outcome) => {
    timing.begin("s1", "p1", 1, T0);
    timing.fail("s1", outcome);
    expect(lastRecord()).toMatchObject({ outcome });
    expect(vi.getTimerCount()).toBe(0);

    timing.complete(report("s1", T0 + 10));
    timing.fail("s1", outcome);
    vi.runAllTimers();
    expect(logInfoMock).toHaveBeenCalledTimes(1);
  });

  it("records a zero-worktree project as applied with nothing to time", () => {
    timing.begin("s1", "p1", 1, T0);
    timing.complete(report("s1", T0 + 70, hostMarks({ firstStatusAt: [], monitorCount: 0 })));
    expect(lastRecord()).toMatchObject({
      outcome: "applied",
      worktreeCount: 0,
      firstStatusMs: [],
      missingStatusCount: 0,
    });
  });

  it("ignores reports and marks for switches it is not timing", () => {
    timing.hostReady("nope", "warm");
    timing.complete(report("nope", T0));
    timing.fail("nope", "load-failed");
    expect(logInfoMock).not.toHaveBeenCalled();
  });

  it("logs only timings, counts, and ids", () => {
    timing.begin("s1", "p1", 1, T0);
    timing.hostReady("s1", "cold");
    timing.complete(report("s1", T0 + 2_450));
    for (const value of Object.values(lastRecord())) {
      if (typeof value === "string") expect(value).not.toMatch(/[\\/]/);
      if (Array.isArray(value)) expect(value.every((v) => typeof v === "number")).toBe(true);
    }
  });
});
