import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyPauseCoordinator } from "../PtyPauseCoordinator.js";

import {
  BackpressureManager,
  FUTURE_SAB_MAX_PENDING_BYTES_PER_TERMINAL,
  FUTURE_SAB_MAX_TOTAL_PENDING_BYTES,
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

  it("rejects additional pending bytes once FUTURE_SAB_MAX_TOTAL_PENDING_BYTES is saturated across terminals", () => {
    const backpressure = manager();

    for (let i = 0; i < 4; i++) {
      expect(
        backpressure.enqueuePendingSegment(`term-${i}`, {
          data: new Uint8Array(FUTURE_SAB_MAX_PENDING_BYTES_PER_TERMINAL),
          offset: 0,
        })
      ).toBe(true);
    }

    expect(FUTURE_SAB_MAX_TOTAL_PENDING_BYTES).toBe(FUTURE_SAB_MAX_PENDING_BYTES_PER_TERMINAL * 4);
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
        reason: "consumer stalled",
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

  it("refuses additional pending bytes when per-terminal FUTURE_SAB cap is exceeded", () => {
    const backpressure = new BackpressureManager({
      getTerminal: vi.fn(),
      getPauseCoordinator: () => undefined,
      sendEvent,
      metricsEnabled: () => false,
    });

    const fullSegment = new Uint8Array(FUTURE_SAB_MAX_PENDING_BYTES_PER_TERMINAL);
    expect(backpressure.enqueuePendingSegment("term-1", { data: fullSegment, offset: 0 })).toBe(
      true
    );

    // Per-terminal cap exceeded — should refuse
    expect(
      backpressure.enqueuePendingSegment("term-1", { data: new Uint8Array(1), offset: 0 })
    ).toBe(false);
  });

  it("refuses additional pending bytes when total FUTURE_SAB cap is exceeded", () => {
    const backpressure = new BackpressureManager({
      getTerminal: vi.fn(),
      getPauseCoordinator: () => undefined,
      sendEvent,
      metricsEnabled: () => false,
    });

    // Fill 4 terminals to the per-terminal max = 16MB total
    for (let i = 0; i < 4; i++) {
      expect(
        backpressure.enqueuePendingSegment(`term-${i}`, {
          data: new Uint8Array(FUTURE_SAB_MAX_PENDING_BYTES_PER_TERMINAL),
          offset: 0,
        })
      ).toBe(true);
    }

    // Total cap exceeded
    expect(
      backpressure.enqueuePendingSegment("term-new", { data: new Uint8Array(1), offset: 0 })
    ).toBe(false);
  });

  it("getPendingBytesSnapshot returns correct totals and does not mutate state", () => {
    const backpressure = manager();

    backpressure.enqueuePendingSegment("term-a", { data: new Uint8Array(100), offset: 0 });
    backpressure.enqueuePendingSegment("term-b", { data: new Uint8Array(200), offset: 0 });

    const snap1 = backpressure.getPendingBytesSnapshot();
    expect(snap1.totalPendingBytes).toBe(300);
    expect(snap1.perTerminal).toHaveLength(2);
    expect(snap1.perTerminal).toEqual(
      expect.arrayContaining([
        { terminalId: "term-a", pendingBytes: 100 },
        { terminalId: "term-b", pendingBytes: 200 },
      ])
    );

    // Does not mutate — second call returns same data
    const snap2 = backpressure.getPendingBytesSnapshot();
    expect(snap2).toEqual(snap1);
  });

  it("suspendVisualStream fires reliability metric even when metrics are disabled", () => {
    const coordinator = createCoordinator();
    coordinators.set("term-1", coordinator);

    const backpressure = new BackpressureManager({
      getTerminal: vi.fn(),
      getPauseCoordinator: (id) =>
        coordinators.get(id) as unknown as PtyPauseCoordinator | undefined,
      sendEvent,
      metricsEnabled: () => false,
    });

    backpressure.suspendVisualStream("term-1", "consumer stalled", 85.0, 500, 1);

    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "terminal-reliability-metric",
        payload: expect.objectContaining({
          terminalId: "term-1",
          metricType: "suspend",
          durationMs: 500,
          bufferUtilization: 85.0,
        }),
      })
    );

    // terminal-status should include the reason
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "terminal-status",
        id: "term-1",
        status: "suspended",
        reason: "consumer stalled",
      })
    );
  });

  it("emits a tier-transition metric on a real tier change carrying from/to/reason/heldTokens", () => {
    const backpressure = manager();

    backpressure.setActivityTier("term-1", "background", "set-activity-tier");

    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "terminal-reliability-metric",
        payload: expect.objectContaining({
          terminalId: "term-1",
          metricType: "tier-transition",
          tierTransitionFrom: "active",
          tierTransitionTo: "background",
          tierTransitionReason: "set-activity-tier",
          tierTransitionHeldTokens: [],
        }),
      })
    );
    expect(backpressure.getActivityTier("term-1")).toBe("background");
  });

  it("suppresses the tier-transition metric when the tier does not change (from === to)", () => {
    const backpressure = manager();

    // First write active→background emits once.
    backpressure.setActivityTier("term-1", "background", "set-activity-tier");
    sendEvent.mockReset();

    // Redundant write at the same tier must not emit (recomputeActivityTiers hot loop).
    backpressure.setActivityTier("term-1", "background", "recompute-activity-tiers");

    expect(sendEvent).not.toHaveBeenCalled();
    expect(backpressure.getActivityTier("term-1")).toBe("background");
  });

  it("tracks the from-tier across a background→active round-trip", () => {
    const backpressure = manager();

    backpressure.setActivityTier("term-1", "background", "r1");
    sendEvent.mockReset();

    backpressure.setActivityTier("term-1", "active", "r2");

    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "terminal-reliability-metric",
        payload: expect.objectContaining({
          metricType: "tier-transition",
          tierTransitionFrom: "background",
          tierTransitionTo: "active",
          tierTransitionReason: "r2",
        }),
      })
    );
  });

  it("applies the tier write even when metric emission throws", () => {
    sendEvent.mockImplementation(() => {
      throw new Error("port detached");
    });
    const backpressure = manager();

    expect(() =>
      backpressure.setActivityTier("term-1", "background", "set-activity-tier")
    ).not.toThrow();
    expect(backpressure.getActivityTier("term-1")).toBe("background");
  });

  it("mutates the tier map but emits nothing when metrics are disabled", () => {
    const backpressure = new BackpressureManager({
      getTerminal: vi.fn(),
      getPauseCoordinator: () => undefined,
      sendEvent,
      metricsEnabled: () => false,
    });

    backpressure.setActivityTier("term-1", "background", "set-activity-tier");

    expect(sendEvent).not.toHaveBeenCalled();
    expect(backpressure.getActivityTier("term-1")).toBe("background");
  });

  it("snapshots and sorts the coordinator's held tokens into the tier-transition metric", () => {
    const coordinator = {
      ...createCoordinator(),
      heldTokens: new Set(["system-sleep", "resource-governor"]),
    };
    coordinators.set("term-1", coordinator as unknown as CoordinatorLike);

    const backpressure = manager();
    backpressure.setActivityTier("term-1", "background", "recompute-activity-tiers");

    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "terminal-reliability-metric",
        payload: expect.objectContaining({
          metricType: "tier-transition",
          tierTransitionHeldTokens: ["resource-governor", "system-sleep"],
        }),
      })
    );
  });

  it.todo(
    "safety-timeout force-resume behavior is orchestrated in electron/pty-host.ts rather than BackpressureManager"
  );

  describe("emitReliabilityMetric dep funnel", () => {
    // When the host wires `emitReliabilityMetric` as a dep, every
    // internal reliability-metric emission must route through it
    // (so the closure-scoped pause-tracking map in pty-host.ts can
    // observe pause-start / pause-end / suspend). Without the dep,
    // the manager falls back to the legacy inline wire emission.
    it("routes internal emissions through the dep when provided", () => {
      const dep = vi.fn();
      const backpressure = new BackpressureManager({
        getTerminal: vi.fn(),
        getPauseCoordinator: (id) =>
          coordinators.get(id) as unknown as PtyPauseCoordinator | undefined,
        sendEvent,
        metricsEnabled: () => true,
        emitReliabilityMetric: dep,
      });

      backpressure.emitReliabilityMetric({
        terminalId: "term-1",
        metricType: "pause-start",
        timestamp: 1000,
      });

      expect(dep).toHaveBeenCalledWith(
        expect.objectContaining({ metricType: "pause-start", terminalId: "term-1" }),
        false
      );
      // sendEvent must NOT be called when the dep is provided — the
      // dep owns the wire emission.
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("suspendVisualStream's internal suspend emission routes through the dep", () => {
      const dep = vi.fn();
      const backpressure = new BackpressureManager({
        getTerminal: vi.fn(),
        getPauseCoordinator: (id) =>
          coordinators.get(id) as unknown as PtyPauseCoordinator | undefined,
        sendEvent,
        metricsEnabled: () => true,
        emitReliabilityMetric: dep,
      });

      backpressure.suspendVisualStream("term-1", "stall", 85.0, 500, 1);

      // The internal `suspend` emission from suspendVisualStream must
      // also route through the dep (with forceEmit=true so the data-loss
      // pulse still fires when metrics are off).
      const suspendCalls = dep.mock.calls.filter(
        (c) => (c[0] as { metricType: string }).metricType === "suspend"
      );
      expect(suspendCalls).toHaveLength(1);
      expect(suspendCalls[0][1]).toBe(true);
    });

    it("falls back to inline wire emission when no dep is provided (legacy behavior)", () => {
      const backpressure = new BackpressureManager({
        getTerminal: vi.fn(),
        getPauseCoordinator: (id) =>
          coordinators.get(id) as unknown as PtyPauseCoordinator | undefined,
        sendEvent,
        metricsEnabled: () => true,
      });

      backpressure.emitReliabilityMetric({
        terminalId: "term-1",
        metricType: "pause-start",
        timestamp: 1000,
      });

      expect(sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "terminal-reliability-metric",
          payload: expect.objectContaining({ metricType: "pause-start" }),
        })
      );
    });
  });
});
