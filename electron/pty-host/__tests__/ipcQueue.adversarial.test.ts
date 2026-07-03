import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcQueueManager, type IpcQueueDeps } from "../ipcQueue.js";
import {
  IPC_MAX_QUEUE_BYTES,
  IPC_HIGH_WATERMARK_PERCENT,
  IPC_LOW_WATERMARK_PERCENT,
  IPC_MAX_PAUSE_MS,
} from "../../services/pty/types.js";

const HIGH_BYTES = Math.ceil((IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100);
const LOW_BYTES = Math.ceil((IPC_MAX_QUEUE_BYTES * IPC_LOW_WATERMARK_PERCENT) / 100);

type FakeCoordinator = {
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  isPaused: boolean;
};

function makeCoordinator(): FakeCoordinator {
  const coord: FakeCoordinator = {
    pause: vi.fn(() => {
      coord.isPaused = true;
    }),
    resume: vi.fn(() => {
      coord.isPaused = false;
    }),
    isPaused: false,
  };
  return coord;
}

function makeDeps(coordinator: FakeCoordinator | undefined): IpcQueueDeps {
  return {
    getTerminal: vi.fn(() => ({
      ptyProcess: { pause: vi.fn(), resume: vi.fn() },
    })),
    getPauseCoordinator: vi.fn(() => coordinator as never),
    sendEvent: vi.fn(),
    metricsEnabled: vi.fn(() => true),
    emitTerminalStatus: vi.fn(),
    emitReliabilityMetric: vi.fn(),
  };
}

describe("IpcQueueManager adversarial", () => {
  let coord: FakeCoordinator;
  let deps: IpcQueueDeps;
  let mgr: IpcQueueManager;

  beforeEach(() => {
    vi.useFakeTimers();
    coord = makeCoordinator();
    deps = makeDeps(coord);
    mgr = new IpcQueueManager(deps);
  });

  afterEach(() => {
    mgr.dispose();
    vi.useRealTimers();
  });

  it("high-watermark pause fires exactly once even on repeated applyBackpressure calls", () => {
    mgr.addBytes("t1", HIGH_BYTES);
    const firstUtil = mgr.getUtilization("t1");

    const first = mgr.applyBackpressure("t1", firstUtil);
    const second = mgr.applyBackpressure("t1", firstUtil);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(coord.pause).toHaveBeenCalledTimes(1);
    const statusCalls = vi.mocked(deps.emitTerminalStatus).mock.calls;
    const pauseStatuses = statusCalls.filter((c) => c[1] === "paused-backpressure");
    expect(pauseStatuses).toHaveLength(1);
    const reliabilityStarts = vi
      .mocked(deps.emitReliabilityMetric)
      .mock.calls.filter((c) => c[0].metricType === "pause-start");
    expect(reliabilityStarts).toHaveLength(1);
  });

  it("applyBackpressure below high watermark does nothing", () => {
    mgr.addBytes("t1", HIGH_BYTES - 1);
    const result = mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    expect(result).toBe(false);
    expect(coord.pause).not.toHaveBeenCalled();
  });

  it("tryResume at or above low watermark does not resume", () => {
    mgr.addBytes("t1", HIGH_BYTES);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    expect(coord.resume).not.toHaveBeenCalled();

    mgr.removeBytes("t1", HIGH_BYTES - LOW_BYTES);
    mgr.tryResume("t1");
    expect(coord.resume).not.toHaveBeenCalled();
    expect(mgr.isPaused("t1")).toBe(true);
  });

  it("tryResume just below low watermark resumes exactly once", () => {
    mgr.addBytes("t1", HIGH_BYTES);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    mgr.removeBytes("t1", HIGH_BYTES - LOW_BYTES + 1);
    mgr.tryResume("t1");

    expect(coord.resume).toHaveBeenCalledTimes(1);
    expect(coord.resume).toHaveBeenCalledWith("ipc-queue");
    expect(mgr.isPaused("t1")).toBe(false);
    const statusCalls = vi.mocked(deps.emitTerminalStatus).mock.calls;
    const running = statusCalls.filter((c) => c[1] === "running");
    expect(running).toHaveLength(1);
  });

  it("safety timeout force-resumes a stalled paused terminal after IPC_MAX_PAUSE_MS", () => {
    mgr.addBytes("t1", HIGH_BYTES);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    expect(mgr.isPaused("t1")).toBe(true);
    expect(coord.resume).not.toHaveBeenCalled();

    vi.advanceTimersByTime(IPC_MAX_PAUSE_MS);

    expect(coord.resume).toHaveBeenCalledWith("ipc-queue");
    expect(mgr.isPaused("t1")).toBe(false);
    const endMetric = vi
      .mocked(deps.emitReliabilityMetric)
      .mock.calls.find((c) => c[0].metricType === "pause-end");
    expect(endMetric).toBeDefined();
    expect(endMetric?.[0].durationMs).toBeGreaterThanOrEqual(IPC_MAX_PAUSE_MS);
  });

  it("clearQueue when paused releases the coordinator hold and cancels the safety-timeout (#7008)", () => {
    // clearQueue must release the coordinator hold it owns. Without this,
    // force-resume paths (renderer reload, view eviction) clear queue maps
    // but leak the "ipc-queue" pause token, wedging the PTY indefinitely.
    mgr.addBytes("t1", HIGH_BYTES);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    expect(mgr.isPaused("t1")).toBe(true);
    coord.resume.mockClear();

    mgr.clearQueue("t1");
    expect(mgr.isPaused("t1")).toBe(false);
    expect(coord.resume).toHaveBeenCalledTimes(1);
    expect(coord.resume).toHaveBeenCalledWith("ipc-queue");

    // The cancelled safety timeout must not fire later and double-resume.
    coord.resume.mockClear();
    vi.advanceTimersByTime(IPC_MAX_PAUSE_MS * 2);
    expect(coord.resume).not.toHaveBeenCalled();
    expect(mgr.getQueuedBytes("t1")).toBe(0);
  });

  it("clearQueue when not paused does not call coordinator.resume", () => {
    mgr.addBytes("t1", 100);
    coord.resume.mockClear();

    mgr.clearQueue("t1");

    expect(coord.resume).not.toHaveBeenCalled();
    expect(mgr.getQueuedBytes("t1")).toBe(0);
  });

  it("safety timeout clears stale queuedBytes so next byte does not re-pause (#7008)", () => {
    // Mirrors the port-path #6244 regression: when ack-driven resume fails
    // and the safety timeout fires, queuedBytes must be cleared along with
    // pause maps. Otherwise the next addBytes immediately re-paints the
    // queue above the high watermark and applyBackpressure re-triggers.
    mgr.addBytes("t1", HIGH_BYTES);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    vi.advanceTimersByTime(IPC_MAX_PAUSE_MS);

    expect(mgr.getQueuedBytes("t1")).toBe(0);
    const pauseCallsAfterTimeout = coord.pause.mock.calls.length;

    mgr.addBytes("t1", 1);
    const result = mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    expect(result).toBe(false);
    expect(mgr.isPaused("t1")).toBe(false);
    expect(coord.pause.mock.calls.length).toBe(pauseCallsAfterTimeout);
  });

  it("applyBackpressure without a pause coordinator returns false and does not enter paused state", () => {
    mgr.dispose();
    deps = makeDeps(undefined);
    mgr = new IpcQueueManager(deps);
    mgr.addBytes("t1", HIGH_BYTES);

    const result = mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    expect(result).toBe(false);
    expect(mgr.isPaused("t1")).toBe(false);
    expect(deps.emitTerminalStatus).not.toHaveBeenCalled();
    expect(deps.emitReliabilityMetric).not.toHaveBeenCalled();
  });

  it("coordinator.pause throwing leaves no half-paused state", () => {
    coord.pause.mockImplementationOnce(() => {
      throw new Error("coordinator busy");
    });
    mgr.addBytes("t1", HIGH_BYTES);

    const result = mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    expect(result).toBe(false);
    expect(mgr.isPaused("t1")).toBe(false);
    const startMetric = vi
      .mocked(deps.emitReliabilityMetric)
      .mock.calls.find((c) => c[0].metricType === "pause-start");
    expect(startMetric).toBeUndefined();
  });

  it("emitTerminalStatus throwing after pause releases the token (#7641)", () => {
    // If a post-pause side-effect (event emit, metric send) throws after
    // coordinator.pause() succeeded, the catch path must not leave the
    // coordinator holding the "ipc-queue" token. Otherwise the PTY is
    // permanently paused with no entry in pausedTerminals — neither
    // tryResume nor the safety timeout can recover it.
    vi.mocked(deps.emitTerminalStatus).mockImplementationOnce(() => {
      throw new Error("DataCloneError");
    });
    mgr.addBytes("t1", HIGH_BYTES);

    const result = mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    expect(result).toBe(false);
    expect(mgr.isPaused("t1")).toBe(false);
    expect(coord.pause).toHaveBeenCalledTimes(1);
    expect(coord.pause).toHaveBeenCalledWith("ipc-queue");
    expect(coord.resume).toHaveBeenCalledTimes(1);
    expect(coord.resume).toHaveBeenCalledWith("ipc-queue");

    // No orphaned safety timeout that could fire later and double-resume.
    coord.resume.mockClear();
    vi.advanceTimersByTime(IPC_MAX_PAUSE_MS * 2);
    expect(coord.resume).not.toHaveBeenCalled();
  });

  it("emitReliabilityMetric throwing after pause releases the token (#7641)", () => {
    vi.mocked(deps.emitReliabilityMetric).mockImplementationOnce(() => {
      throw new Error("DataCloneError");
    });
    mgr.addBytes("t1", HIGH_BYTES);

    const result = mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    expect(result).toBe(false);
    expect(mgr.isPaused("t1")).toBe(false);
    expect(coord.resume).toHaveBeenCalledWith("ipc-queue");

    // A subsequent applyBackpressure must succeed cleanly — the previous
    // failure must not have left the coordinator state inconsistent.
    coord.resume.mockClear();
    const retry = mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    expect(retry).toBe(true);
    expect(mgr.isPaused("t1")).toBe(true);
  });

  it("dispose releases held pause tokens and cancels their safety timeouts", () => {
    mgr.addBytes("t1", HIGH_BYTES);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    mgr.addBytes("t2", HIGH_BYTES);
    mgr.applyBackpressure("t2", mgr.getUtilization("t2"));
    coord.resume.mockClear();

    mgr.dispose();

    expect(mgr.isPaused("t1")).toBe(false);
    expect(mgr.isPaused("t2")).toBe(false);
    // Held tokens MUST be released during dispose so the coordinator does not
    // outlive this manager with a stale hold.
    expect(coord.resume).toHaveBeenCalledTimes(2);
    expect(coord.resume).toHaveBeenCalledWith("ipc-queue");

    coord.resume.mockClear();
    vi.advanceTimersByTime(IPC_MAX_PAUSE_MS * 2);
    // Safety timers must have been cancelled — no further resume calls.
    expect(coord.resume).not.toHaveBeenCalled();
  });

  it("removeBytes clamps at 0 and deletes the map entry when reaching zero", () => {
    mgr.addBytes("t1", 100);
    mgr.removeBytes("t1", 100);
    expect(mgr.getQueuedBytes("t1")).toBe(0);

    mgr.removeBytes("t1", 50);
    expect(mgr.getQueuedBytes("t1")).toBe(0);
  });

  it("isAtCapacity respects strict > comparison — exactly at the limit is still under capacity", () => {
    expect(mgr.isAtCapacity("t1", IPC_MAX_QUEUE_BYTES)).toBe(false);
    expect(mgr.isAtCapacity("t1", IPC_MAX_QUEUE_BYTES + 1)).toBe(true);
  });

  describe("aggregate byte tracking", () => {
    it("tracks total queued bytes across multiple terminals", () => {
      expect(mgr.getTotalQueuedBytes()).toBe(0);

      mgr.addBytes("t1", 1000);
      mgr.addBytes("t2", 2500);
      mgr.addBytes("t1", 500);

      expect(mgr.getTotalQueuedBytes()).toBe(4000);
    });

    it("removeBytes clamps the aggregate delta to per-terminal balance (no underflow)", () => {
      mgr.addBytes("t1", 1000);
      mgr.addBytes("t2", 1500);

      mgr.removeBytes("t1", 10_000);

      expect(mgr.getQueuedBytes("t1")).toBe(0);
      expect(mgr.getTotalQueuedBytes()).toBe(1500);
    });

    it("clearQueue removes only the cleared terminal's contribution", () => {
      mgr.addBytes("t1", 1000);
      mgr.addBytes("t2", 2000);
      mgr.addBytes("t3", 3000);

      mgr.clearQueue("t2");

      expect(mgr.getTotalQueuedBytes()).toBe(4000);
    });

    it("safety timeout clears t1's bytes from aggregate without affecting t2", () => {
      mgr.addBytes("t1", HIGH_BYTES);
      mgr.addBytes("t2", 1000);
      mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

      vi.advanceTimersByTime(IPC_MAX_PAUSE_MS);

      expect(mgr.getQueuedBytes("t1")).toBe(0);
      expect(mgr.getQueuedBytes("t2")).toBe(1000);
      expect(mgr.getTotalQueuedBytes()).toBe(1000);
    });

    it("dispose resets the aggregate scalar", () => {
      mgr.addBytes("t1", 1000);
      mgr.addBytes("t2", 2000);
      mgr.dispose();
      expect(mgr.getTotalQueuedBytes()).toBe(0);
    });

    it("getQueueSnapshot returns ResourceGovernor-compatible shape", () => {
      mgr.addBytes("t1", 1000);
      mgr.addBytes("t2", 2500);

      const snap = mgr.getQueueSnapshot();
      expect(snap.totalPendingBytes).toBe(3500);
      const byId = new Map(snap.perTerminal.map((e) => [e.terminalId, e.pendingBytes]));
      expect(byId.get("t1")).toBe(1000);
      expect(byId.get("t2")).toBe(2500);
    });

    it("aggregate boundary tracking at 0, low, high, max, max+1", () => {
      expect(mgr.getTotalQueuedBytes()).toBe(0);

      mgr.addBytes("t1", LOW_BYTES);
      expect(mgr.getTotalQueuedBytes()).toBe(LOW_BYTES);

      mgr.addBytes("t1", HIGH_BYTES - LOW_BYTES);
      expect(mgr.getTotalQueuedBytes()).toBe(HIGH_BYTES);

      mgr.addBytes("t1", IPC_MAX_QUEUE_BYTES - HIGH_BYTES);
      expect(mgr.getTotalQueuedBytes()).toBe(IPC_MAX_QUEUE_BYTES);

      mgr.addBytes("t1", 1);
      expect(mgr.getTotalQueuedBytes()).toBe(IPC_MAX_QUEUE_BYTES + 1);
    });
  });

  describe("aggregate sweep on non-ack drains", () => {
    // A terminal paused by the aggregate watermark with an empty queue of its
    // own receives no acks, so removeBytes never runs for it. The other two
    // aggregate-shrinking paths — safety-timeout force-resume and clearQueue —
    // must run the same resume sweep, or the terminal stays stranded until its
    // own 10s safety timeout.
    const BIG = HIGH_BYTES + 1;

    function pauseEightBigProducers() {
      for (let i = 1; i <= 8; i++) {
        mgr.addBytes(`big${i}`, BIG);
        mgr.applyBackpressure(`big${i}`, mgr.getUtilization(`big${i}`));
        expect(mgr.isPaused(`big${i}`)).toBe(true);
      }
    }

    it("safety-timeout force-resume sweeps aggregate-paused siblings", () => {
      // Eight big producers (own-watermark pauses at T=0) push the aggregate
      // over its 16MB gate.
      pauseEightBigProducers();

      // t0 pauses via the aggregate gate 1s later; its own timeout is at
      // T+11s, strictly after the big producers' timeouts at T+10s.
      vi.advanceTimersByTime(1000);
      mgr.addBytes("t0", 1000);
      mgr.applyBackpressure("t0", mgr.getUtilization("t0"));
      expect(mgr.isPaused("t0")).toBe(true);
      mgr.removeBytes("t0", 1000);
      expect(mgr.isPaused("t0")).toBe(true);

      // At T+10s the big producers force-resume and drop their bytes — t0
      // must resume in the same tick via the sweep, not at T+11s.
      vi.advanceTimersByTime(IPC_MAX_PAUSE_MS - 1000);
      expect(mgr.isPaused("t0")).toBe(false);
    });

    it("clearQueue (terminal teardown) sweeps aggregate-paused siblings", () => {
      pauseEightBigProducers();
      mgr.addBytes("t0", 1000);
      mgr.applyBackpressure("t0", mgr.getUtilization("t0"));
      mgr.removeBytes("t0", 1000);
      expect(mgr.isPaused("t0")).toBe(true);

      for (let i = 1; i <= 8; i++) {
        mgr.clearQueue(`big${i}`);
      }

      expect(mgr.isPaused("t0")).toBe(false);
    });
  });
});
