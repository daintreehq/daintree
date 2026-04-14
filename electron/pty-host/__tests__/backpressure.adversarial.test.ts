import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyPauseCoordinator } from "../PtyPauseCoordinator.js";

import {
  BackpressureManager,
  MAX_PENDING_BYTES_PER_TERMINAL,
  MAX_TOTAL_PENDING_BYTES,
} from "../backpressure.js";

type CoordinatorLike = Pick<PtyPauseCoordinator, "pause" | "resume" | "isPaused">;

function createCoordinator() {
  return {
    resume: vi.fn(),
    pause: vi.fn(),
    isPaused: false,
  };
}

describe("BackpressureManager adversarial", () => {
  const coordinators = new Map<string, CoordinatorLike>();
  const sendEvent = vi.fn();

  beforeEach(() => {
    coordinators.clear();
    sendEvent.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function manager() {
    return new BackpressureManager({
      getTerminal: vi.fn(),
      getPauseCoordinator: (id) =>
        coordinators.get(id) as unknown as PtyPauseCoordinator | undefined,
      sendEvent,
      metricsEnabled: () => true,
    });
  }

  it("rejects additional pending bytes once MAX_TOTAL_PENDING_BYTES is saturated across terminals", () => {
    const backpressure = manager();

    for (let i = 0; i < 4; i++) {
      expect(
        backpressure.enqueuePendingSegment(`term-${i}`, {
          data: new Uint8Array(MAX_PENDING_BYTES_PER_TERMINAL),
          offset: 0,
        })
      ).toBe(true);
    }

    expect(MAX_TOTAL_PENDING_BYTES).toBe(MAX_PENDING_BYTES_PER_TERMINAL * 4);
    expect(
      backpressure.enqueuePendingSegment("overflow", {
        data: new Uint8Array(1),
        offset: 0,
      })
    ).toBe(false);
  });

  it("treats a stalled terminal as suspended and clears pending state in one transition", () => {
    const coordinator = createCoordinator();
    coordinators.set("term-1", coordinator);

    const backpressure = manager();
    const timeout = setTimeout(() => {}, 10_000);

    backpressure.enqueuePendingSegment("term-1", {
      data: new Uint8Array(64),
      offset: 0,
    });
    backpressure.setPauseStartTime("term-1", 100);
    backpressure.setPausedInterval("term-1", timeout);

    backpressure.suspendVisualStream("term-1", "consumer stalled", 92.5, 750, 1);

    expect(coordinator.resume).toHaveBeenCalledWith("backpressure");
    expect(backpressure.isSuspended("term-1")).toBe(true);
    expect(backpressure.isPaused("term-1")).toBe(false);
    expect(backpressure.getPauseStartTime("term-1")).toBeUndefined();
    expect(backpressure.hasPendingSegments("term-1")).toBe(false);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "terminal-status",
        id: "term-1",
        status: "suspended",
      })
    );
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "terminal-reliability-metric",
        payload: expect.objectContaining({
          terminalId: "term-1",
          metricType: "suspend",
          durationMs: 750,
        }),
      })
    );
  });

  it("suppresses duplicate terminal-status events during concurrent pause and resume churn", () => {
    const backpressure = manager();

    backpressure.emitTerminalStatus("term-1", "paused-backpressure", 80);
    backpressure.emitTerminalStatus("term-1", "paused-backpressure", 81);
    backpressure.emitTerminalStatus("term-1", "running", 20, 50);
    backpressure.emitTerminalStatus("term-1", "running", 19, 51);

    expect(sendEvent.mock.calls).toHaveLength(2);
    expect(sendEvent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        type: "terminal-status",
        id: "term-1",
        status: "paused-backpressure",
      })
    );
    expect(sendEvent.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        type: "terminal-status",
        id: "term-1",
        status: "running",
      })
    );
  });

  it("clears timers and bookkeeping during a disposal race after a pause signal is recorded", () => {
    const backpressure = manager();
    const timeout = setTimeout(() => {}, 10_000);

    backpressure.setPausedInterval("term-1", timeout);
    backpressure.setPauseStartTime("term-1", 100);
    backpressure.setActivityTier("term-1", "background");
    backpressure.setSuspended("term-1");
    backpressure.emitTerminalStatus("term-1", "paused-backpressure", 88);
    backpressure.enqueuePendingSegment("term-1", {
      data: new Uint8Array(128),
      offset: 0,
    });

    backpressure.cleanupTerminal("term-1");

    expect(backpressure.getPausedInterval("term-1")).toBeUndefined();
    expect(backpressure.getPauseStartTime("term-1")).toBeUndefined();
    expect(backpressure.hasPendingSegments("term-1")).toBe(false);
    expect(backpressure.isSuspended("term-1")).toBe(false);
    expect(backpressure.terminalStatusesMap.has("term-1")).toBe(false);
    expect(backpressure.terminalActivityTiersMap.has("term-1")).toBe(false);
  });

  it.todo(
    "safety-timeout force-resume behavior is orchestrated in electron/pty-host.ts rather than BackpressureManager"
  );
});
