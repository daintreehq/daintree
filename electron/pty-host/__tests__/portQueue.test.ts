import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PortQueueManager, type PortQueueDeps } from "../portQueue.js";
import type { PtyPauseCoordinator } from "../PtyPauseCoordinator.js";
import {
  IPC_MAX_QUEUE_BYTES,
  IPC_HIGH_WATERMARK_PERCENT,
  IPC_LOW_WATERMARK_PERCENT,
  IPC_MAX_PAUSE_MS,
  IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES,
} from "../../services/pty/types.js";

function createMockDeps(): PortQueueDeps {
  const mockCoordinator: Pick<PtyPauseCoordinator, "pause" | "resume" | "isPaused"> = {
    pause: vi.fn(),
    resume: vi.fn(),
    get isPaused() {
      return false;
    },
  };
  return {
    getTerminal: vi.fn(() => ({ ptyProcess: { pause: vi.fn(), resume: vi.fn() } })),
    getPauseCoordinator: vi.fn(() => mockCoordinator as PtyPauseCoordinator),
    sendEvent: vi.fn(),
    metricsEnabled: vi.fn(() => true),
    emitTerminalStatus: vi.fn(),
    emitReliabilityMetric: vi.fn(),
  };
}

describe("PortQueueManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks addBytes and removeBytes correctly", () => {
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    mgr.addBytes("t1", 1000);
    expect(mgr.getQueuedBytes("t1")).toBe(1000);

    mgr.addBytes("t1", 500);
    expect(mgr.getQueuedBytes("t1")).toBe(1500);

    mgr.removeBytes("t1", 800);
    expect(mgr.getQueuedBytes("t1")).toBe(700);

    mgr.removeBytes("t1", 1000);
    expect(mgr.getQueuedBytes("t1")).toBe(0);
  });

  it("getUtilization returns correct percentage", () => {
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    mgr.addBytes("t1", IPC_MAX_QUEUE_BYTES / 2);
    expect(mgr.getUtilization("t1")).toBe(50);
  });

  it("isAtCapacity returns true when bytes exceed max", () => {
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    mgr.addBytes("t1", IPC_MAX_QUEUE_BYTES - 100);
    expect(mgr.isAtCapacity("t1", 101)).toBe(true);
    expect(mgr.isAtCapacity("t1", 100)).toBe(false);
  });

  it("applyBackpressure pauses coordinator at high watermark", () => {
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);

    const result = mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    expect(result).toBe(true);
    expect(mgr.isPaused("t1")).toBe(true);

    const coordinator = deps.getPauseCoordinator("t1");
    expect(coordinator!.pause).toHaveBeenCalledWith("port-queue");
    expect(deps.emitTerminalStatus).toHaveBeenCalledWith(
      "t1",
      "paused-backpressure",
      expect.any(Number)
    );
  });

  it("applyBackpressure does nothing below high watermark", () => {
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    mgr.addBytes("t1", 1000);
    const result = mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    expect(result).toBe(false);
    expect(mgr.isPaused("t1")).toBe(false);
  });

  it("applyBackpressure does nothing if already paused", () => {
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);

    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    const result = mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    expect(result).toBe(false);
  });

  it("tryResume resumes when bytes drop below low watermark", () => {
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    const lowWatermark = (IPC_MAX_QUEUE_BYTES * IPC_LOW_WATERMARK_PERCENT) / 100;
    mgr.removeBytes("t1", highWatermark + 1 - lowWatermark + 1);
    mgr.tryResume("t1");

    expect(mgr.isPaused("t1")).toBe(false);
    const coordinator = deps.getPauseCoordinator("t1");
    expect(coordinator!.resume).toHaveBeenCalledWith("port-queue");
  });

  it("tryResume does nothing when still above low watermark", () => {
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    mgr.removeBytes("t1", 100);
    mgr.tryResume("t1");

    expect(mgr.isPaused("t1")).toBe(true);
  });

  it("safety timeout force-resumes after IPC_MAX_PAUSE_MS", () => {
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    expect(mgr.isPaused("t1")).toBe(true);

    vi.advanceTimersByTime(IPC_MAX_PAUSE_MS);

    expect(mgr.isPaused("t1")).toBe(false);
    const coordinator = deps.getPauseCoordinator("t1");
    expect(coordinator!.resume).toHaveBeenCalledWith("port-queue");
  });

  it("safety timeout clears stale queuedBytes so next byte does not re-pause (#6244)", () => {
    // When the renderer crashes and stops draining the port, the safety
    // timeout fires after IPC_MAX_PAUSE_MS. It must drop the stale byte
    // accounting along with the pause maps, otherwise the very next
    // PTY byte re-triggers applyBackpressure and the pause loop wedges
    // for the entire reload window.
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    vi.advanceTimersByTime(IPC_MAX_PAUSE_MS);

    expect(mgr.getQueuedBytes("t1")).toBe(0);

    const coordinator = deps.getPauseCoordinator("t1");
    const pauseCallsAfterTimeout = (coordinator!.pause as ReturnType<typeof vi.fn>).mock.calls
      .length;

    mgr.addBytes("t1", 1);
    const result = mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    expect(result).toBe(false);
    expect(mgr.isPaused("t1")).toBe(false);
    expect((coordinator!.pause as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      pauseCallsAfterTimeout
    );
  });

  it("clearQueue when paused releases the coordinator hold (#7008)", () => {
    // Without coordinator.resume, the "port-queue" pause token leaks across
    // disconnectWindow / force-resume paths, wedging the PTY indefinitely.
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    const coordinator = deps.getPauseCoordinator("t1");
    vi.mocked(coordinator!.resume).mockClear();

    mgr.clearQueue("t1");

    expect(mgr.getQueuedBytes("t1")).toBe(0);
    expect(mgr.isPaused("t1")).toBe(false);
    expect(coordinator!.resume).toHaveBeenCalledTimes(1);
    expect(coordinator!.resume).toHaveBeenCalledWith("port-queue");
  });

  it("clearQueue when not paused does not call coordinator.resume", () => {
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    mgr.addBytes("t1", 1000);
    const coordinator = deps.getPauseCoordinator("t1");
    vi.mocked(coordinator!.resume).mockClear();

    mgr.clearQueue("t1");

    expect(coordinator!.resume).not.toHaveBeenCalled();
    expect(mgr.getQueuedBytes("t1")).toBe(0);
  });

  it("clearQueue with a custom pauseToken releases that exact token", () => {
    // Per-window port queue managers use unique tokens (e.g. "port-queue-7").
    // The release must match the token the manager held, not a hardcoded value.
    const deps = createMockDeps();
    const mgr = new PortQueueManager({ ...deps, pauseToken: "port-queue-7" });

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    const coordinator = deps.getPauseCoordinator("t1");
    vi.mocked(coordinator!.resume).mockClear();

    mgr.clearQueue("t1");

    expect(coordinator!.resume).toHaveBeenCalledWith("port-queue-7");
  });

  it("dispose clears all terminals and releases held pause tokens", () => {
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);
    mgr.addBytes("t2", highWatermark + 1);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    mgr.applyBackpressure("t2", mgr.getUtilization("t2"));

    const coordinator = deps.getPauseCoordinator("t1")!;
    vi.mocked(coordinator.resume).mockClear();

    mgr.dispose();

    expect(mgr.getQueuedBytes("t1")).toBe(0);
    expect(mgr.getQueuedBytes("t2")).toBe(0);
    expect(mgr.isPaused("t1")).toBe(false);
    expect(mgr.isPaused("t2")).toBe(false);
    // Held pause tokens MUST be released so the coordinator does not outlive
    // this manager with a stale hold.
    expect(coordinator.resume).toHaveBeenCalledWith("port-queue");
  });

  it("removeBytes clamps to zero for unknown terminals", () => {
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    mgr.removeBytes("unknown", 100);
    expect(mgr.getQueuedBytes("unknown")).toBe(0);
  });

  it("applyBackpressure returns false when coordinator is missing", () => {
    const deps = createMockDeps();
    vi.mocked(deps.getPauseCoordinator).mockReturnValue(undefined);
    const mgr = new PortQueueManager(deps);

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);

    const result = mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    expect(result).toBe(false);
    expect(mgr.isPaused("t1")).toBe(false);
  });

  it("emitTerminalStatus throwing after pause releases the token (#7641)", () => {
    // A post-pause side-effect (event emit, metric send) throwing after
    // coordinator.pause() succeeded must trigger a coordinator.resume so the
    // "port-queue" token is not leaked. Otherwise the PTY is permanently
    // paused with no entry in pausedTerminals — neither tryResume nor the
    // safety timeout can recover it.
    const deps = createMockDeps();
    vi.mocked(deps.emitTerminalStatus).mockImplementationOnce(() => {
      throw new Error("DataCloneError");
    });
    const mgr = new PortQueueManager(deps);
    const coordinator = deps.getPauseCoordinator("t1")!;

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);

    const result = mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    expect(result).toBe(false);
    expect(mgr.isPaused("t1")).toBe(false);
    expect(coordinator.pause).toHaveBeenCalledTimes(1);
    expect(coordinator.pause).toHaveBeenCalledWith("port-queue");
    expect(coordinator.resume).toHaveBeenCalledTimes(1);
    expect(coordinator.resume).toHaveBeenCalledWith("port-queue");

    // No orphaned safety timeout that could fire later and double-resume.
    vi.mocked(coordinator.resume).mockClear();
    vi.advanceTimersByTime(IPC_MAX_PAUSE_MS * 2);
    expect(coordinator.resume).not.toHaveBeenCalled();
  });

  it("emitReliabilityMetric throwing after pause releases the token (#7641)", () => {
    const deps = createMockDeps();
    vi.mocked(deps.emitReliabilityMetric).mockImplementationOnce(() => {
      throw new Error("DataCloneError");
    });
    const mgr = new PortQueueManager(deps);
    const coordinator = deps.getPauseCoordinator("t1")!;

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);

    const result = mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    expect(result).toBe(false);
    expect(mgr.isPaused("t1")).toBe(false);
    expect(coordinator.resume).toHaveBeenCalledWith("port-queue");

    // A subsequent applyBackpressure must succeed cleanly — the previous
    // failure must not have left the coordinator state inconsistent.
    vi.mocked(coordinator.resume).mockClear();
    const retry = mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    expect(retry).toBe(true);
    expect(mgr.isPaused("t1")).toBe(true);
  });

  it("custom pauseToken is released on post-pause throw (#7641)", () => {
    // Per-window port queue managers use unique tokens (e.g. "port-queue-7").
    // The release on throw must match the token the manager held, not "port-queue".
    const deps = createMockDeps();
    vi.mocked(deps.emitTerminalStatus).mockImplementationOnce(() => {
      throw new Error("DataCloneError");
    });
    const mgr = new PortQueueManager({ ...deps, pauseToken: "port-queue-7" });
    const coordinator = deps.getPauseCoordinator("t1")!;

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);

    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    expect(coordinator.pause).toHaveBeenCalledWith("port-queue-7");
    expect(coordinator.resume).toHaveBeenCalledWith("port-queue-7");
  });

  it("custom pauseToken is released when emitReliabilityMetric throws (#7641)", () => {
    // Cover the second post-pause throw site too, so a future cleanup-path
    // change that hardcoded "port-queue" would be caught regardless of which
    // dep threw.
    const deps = createMockDeps();
    vi.mocked(deps.emitReliabilityMetric).mockImplementationOnce(() => {
      throw new Error("DataCloneError");
    });
    const mgr = new PortQueueManager({ ...deps, pauseToken: "port-queue-12" });
    const coordinator = deps.getPauseCoordinator("t1")!;

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);

    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    expect(coordinator.pause).toHaveBeenCalledWith("port-queue-12");
    expect(coordinator.resume).toHaveBeenCalledWith("port-queue-12");
  });

  describe("aggregate byte tracking", () => {
    it("tracks total queued bytes across multiple terminals", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      expect(mgr.getTotalQueuedBytes()).toBe(0);

      mgr.addBytes("t1", 1000);
      expect(mgr.getTotalQueuedBytes()).toBe(1000);

      mgr.addBytes("t2", 2500);
      expect(mgr.getTotalQueuedBytes()).toBe(3500);

      mgr.addBytes("t1", 500);
      expect(mgr.getTotalQueuedBytes()).toBe(4000);
    });

    it("subtracts from total on removeBytes without underflow on over-remove", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      mgr.addBytes("t1", 1000);
      mgr.addBytes("t2", 1500);

      mgr.removeBytes("t1", 400);
      expect(mgr.getTotalQueuedBytes()).toBe(2100);
      expect(mgr.getQueuedBytes("t1")).toBe(600);

      // Over-remove from t1 — must not subtract more than t1 actually held
      mgr.removeBytes("t1", 10_000);
      expect(mgr.getQueuedBytes("t1")).toBe(0);
      expect(mgr.getTotalQueuedBytes()).toBe(1500);

      // t2 untouched
      expect(mgr.getQueuedBytes("t2")).toBe(1500);
    });

    it("clearQueue subtracts only the cleared terminal's bytes", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      mgr.addBytes("t1", 1000);
      mgr.addBytes("t2", 2000);
      mgr.addBytes("t3", 3000);

      mgr.clearQueue("t2");

      expect(mgr.getTotalQueuedBytes()).toBe(4000);
      expect(mgr.getQueuedBytes("t1")).toBe(1000);
      expect(mgr.getQueuedBytes("t2")).toBe(0);
      expect(mgr.getQueuedBytes("t3")).toBe(3000);
    });

    it("safety timeout subtracts dropped bytes from aggregate (#6244 + aggregate)", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
      mgr.addBytes("t1", highWatermark + 1);
      mgr.addBytes("t2", 1000);
      mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

      const totalBefore = mgr.getTotalQueuedBytes();
      expect(totalBefore).toBe(highWatermark + 1 + 1000);

      vi.advanceTimersByTime(IPC_MAX_PAUSE_MS);

      // Only t1's bytes were dropped on force-resume; t2 untouched.
      expect(mgr.getQueuedBytes("t1")).toBe(0);
      expect(mgr.getQueuedBytes("t2")).toBe(1000);
      expect(mgr.getTotalQueuedBytes()).toBe(1000);
    });

    it("dispose resets the aggregate scalar", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      mgr.addBytes("t1", 1000);
      mgr.addBytes("t2", 2000);
      expect(mgr.getTotalQueuedBytes()).toBe(3000);

      mgr.dispose();

      expect(mgr.getTotalQueuedBytes()).toBe(0);
    });

    it("getQueueSnapshot mirrors BackpressureManager shape", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      mgr.addBytes("t1", 1000);
      mgr.addBytes("t2", 2500);

      const snap = mgr.getQueueSnapshot();
      expect(snap.totalPendingBytes).toBe(3500);
      expect(snap.perTerminal).toHaveLength(2);
      const byId = new Map(snap.perTerminal.map((e) => [e.terminalId, e.pendingBytes]));
      expect(byId.get("t1")).toBe(1000);
      expect(byId.get("t2")).toBe(2500);
    });
  });

  describe("aggregate watermark gate", () => {
    // Spread bytes across terminals so each stays below its own ~2MB high
    // watermark while the window-level total crosses the 16MB aggregate gate.
    function fillBelowPerTerminalWatermark(mgr: PortQueueManager, count: number, bytes: number) {
      for (let i = 0; i < count; i++) {
        mgr.addBytes(`t${i}`, bytes);
      }
    }

    it("pauses a producing terminal when the aggregate crosses the high watermark", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      // 16 terminals × 1MB = 16MB aggregate; each is far below its own gate.
      fillBelowPerTerminalWatermark(mgr, 16, 1024 * 1024);
      expect(mgr.getTotalQueuedBytes()).toBe(IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES);

      const result = mgr.applyBackpressure("t0", mgr.getUtilization("t0"));
      expect(result).toBe(true);
      expect(mgr.isPaused("t0")).toBe(true);
    });

    it("does not pause below the aggregate watermark when per-terminal is also below", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      fillBelowPerTerminalWatermark(mgr, 8, 1024 * 1024);

      expect(mgr.applyBackpressure("t0", mgr.getUtilization("t0"))).toBe(false);
      expect(mgr.isPaused("t0")).toBe(false);
    });

    it("never pauses a terminal with no in-flight bytes of its own", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      fillBelowPerTerminalWatermark(mgr, 16, 1024 * 1024);

      expect(mgr.applyBackpressure("idle", mgr.getUtilization("idle"))).toBe(false);
      expect(mgr.isPaused("idle")).toBe(false);
    });

    it("holds the resume while the aggregate stays over the low watermark", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      fillBelowPerTerminalWatermark(mgr, 16, 1024 * 1024);
      mgr.applyBackpressure("t0", mgr.getUtilization("t0"));
      expect(mgr.isPaused("t0")).toBe(true);

      // t0's own queue fully drains, but the aggregate is still 15MB.
      mgr.removeBytes("t0", 1024 * 1024);
      mgr.tryResume("t0");
      expect(mgr.isPaused("t0")).toBe(true);
    });

    it("sweeps paused terminals when the aggregate drains below the low watermark", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      fillBelowPerTerminalWatermark(mgr, 16, 1024 * 1024);
      mgr.applyBackpressure("t0", mgr.getUtilization("t0"));
      mgr.removeBytes("t0", 1024 * 1024);
      expect(mgr.isPaused("t0")).toBe(true);

      // Acks from OTHER terminals drain the aggregate below 8MB — t0 gets no
      // acks of its own, so the removeBytes sweep must resume it.
      for (let i = 1; i < 9; i++) {
        mgr.removeBytes(`t${i}`, 1024 * 1024);
      }

      expect(mgr.isPaused("t0")).toBe(false);
      const coordinator = deps.getPauseCoordinator("t0");
      expect(coordinator!.resume).toHaveBeenCalledWith("port-queue");
    });

    it("per-terminal pauses still resume normally while the aggregate is low", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
      mgr.addBytes("t1", highWatermark + 1);
      mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
      expect(mgr.isPaused("t1")).toBe(true);

      mgr.removeBytes("t1", highWatermark + 1);
      mgr.tryResume("t1");
      expect(mgr.isPaused("t1")).toBe(false);
    });
  });

  describe("aggregate sweep on non-ack drains", () => {
    // The drain event that frees a swamped window is not always an ack:
    // safety-timeout force-resumes and terminal teardown (clearQueue) also
    // shrink the aggregate. A terminal paused by the window-level gate with an
    // empty queue of its own receives no acks, so those paths MUST run the
    // same resume sweep as removeBytes or it stays stranded until its own
    // 10s safety timeout.
    const BIG = 2.05 * 1024 * 1024; // over the ~2MB per-terminal watermark

    function pauseEightBigProducers(mgr: PortQueueManager) {
      for (let i = 1; i <= 8; i++) {
        mgr.addBytes(`big${i}`, BIG);
        mgr.applyBackpressure(`big${i}`, mgr.getUtilization(`big${i}`));
        expect(mgr.isPaused(`big${i}`)).toBe(true);
      }
    }

    it("safety-timeout force-resume sweeps aggregate-paused siblings", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      // Eight big producers pause on their own watermark at T=0 and push the
      // aggregate over 16MB.
      pauseEightBigProducers(mgr);
      expect(mgr.getTotalQueuedBytes()).toBeGreaterThan(IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES);

      // t0 pauses via the aggregate gate 1s later — its safety timeout is at
      // T+11s, strictly after the big producers' timeouts at T+10s.
      vi.advanceTimersByTime(1000);
      mgr.addBytes("t0", 1000);
      mgr.applyBackpressure("t0", mgr.getUtilization("t0"));
      expect(mgr.isPaused("t0")).toBe(true);

      // t0's own queue drains fully; the aggregate is still swamped.
      mgr.removeBytes("t0", 1000);
      expect(mgr.isPaused("t0")).toBe(true);

      // Advance to exactly T+10s: the big producers' safety timeouts fire and
      // drop their byte accounting. t0 must resume in the SAME tick via the
      // sweep — not 1s later when its own timeout fires.
      vi.advanceTimersByTime(IPC_MAX_PAUSE_MS - 1000);
      expect(mgr.isPaused("t0")).toBe(false);
      expect(deps.getPauseCoordinator("t0")!.resume).toHaveBeenCalledWith("port-queue");
    });

    it("clearQueue (terminal teardown) sweeps aggregate-paused siblings", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      pauseEightBigProducers(mgr);
      mgr.addBytes("t0", 1000);
      mgr.applyBackpressure("t0", mgr.getUtilization("t0"));
      mgr.removeBytes("t0", 1000);
      expect(mgr.isPaused("t0")).toBe(true);

      // The big producers exit (kill/trash) — no acks will ever arrive for
      // their bytes. Clearing them must free t0 as soon as the aggregate
      // crosses the low watermark.
      for (let i = 1; i <= 8; i++) {
        mgr.clearQueue(`big${i}`);
      }

      expect(mgr.isPaused("t0")).toBe(false);
      expect(deps.getPauseCoordinator("t0")!.resume).toHaveBeenCalledWith("port-queue");
    });
  });

  describe("resumeAll surfaces the release (stuck-pill regression)", () => {
    it("emits running + pause-end for each released terminal", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
      mgr.addBytes("t1", highWatermark + 1);
      mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
      expect(mgr.isPaused("t1")).toBe(true);

      const emitStatus = deps.emitTerminalStatus as ReturnType<typeof vi.fn>;
      const emitMetric = deps.emitReliabilityMetric as ReturnType<typeof vi.fn>;
      emitStatus.mockClear();
      emitMetric.mockClear();

      vi.advanceTimersByTime(1500);
      mgr.resumeAll();

      // Without the emission, the shared status map keeps "paused-backpressure"
      // and any other window still showing the terminal wears a stale pill
      // until an unrelated transition overwrites it.
      expect(emitStatus).toHaveBeenCalledWith("t1", "running", expect.any(Number), 1500);
      expect(emitMetric).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalId: "t1",
          metricType: "pause-end",
          durationMs: 1500,
        })
      );
      expect(mgr.isPaused("t1")).toBe(false);
      expect(deps.getPauseCoordinator("t1")!.resume).toHaveBeenCalledWith("port-queue");
    });

    it("suppresses the running status while another source still holds the pause", () => {
      const deps = createMockDeps();
      const heldCoordinator: Pick<PtyPauseCoordinator, "pause" | "resume" | "isPaused"> = {
        pause: vi.fn(),
        resume: vi.fn(),
        get isPaused() {
          // Still held by e.g. the ipc-queue token after this manager resumes.
          return true;
        },
      };
      deps.getPauseCoordinator = vi.fn(() => heldCoordinator as PtyPauseCoordinator);
      const mgr = new PortQueueManager(deps);

      const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
      mgr.addBytes("t1", highWatermark + 1);
      mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

      const emitStatus = deps.emitTerminalStatus as ReturnType<typeof vi.fn>;
      const emitMetric = deps.emitReliabilityMetric as ReturnType<typeof vi.fn>;
      emitStatus.mockClear();
      emitMetric.mockClear();

      mgr.resumeAll();

      // Terminal is NOT running (another hold remains) — no running status,
      // but the pause-end metric still fires so per-source tracking clears.
      expect(emitStatus).not.toHaveBeenCalledWith(
        "t1",
        "running",
        expect.anything(),
        expect.anything()
      );
      expect(emitMetric).toHaveBeenCalledWith(
        expect.objectContaining({ terminalId: "t1", metricType: "pause-end" })
      );
    });

    it("a throwing emitter cannot abort the release or leave pause state stale", () => {
      // resumeAll runs during window teardown, where sendEvent can race a
      // dying parent channel. A throw from either emitter must not stop the
      // remaining terminals from being released or leave the pause maps
      // populated (a stale map would strand coordinator holds forever).
      const deps = createMockDeps();
      let channelDead = false;
      deps.emitTerminalStatus = vi.fn(() => {
        if (channelDead) throw new Error("channel closing");
      });
      const mgr = new PortQueueManager(deps);

      const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
      mgr.addBytes("t1", highWatermark + 1);
      mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
      mgr.addBytes("t2", highWatermark + 1);
      mgr.applyBackpressure("t2", mgr.getUtilization("t2"));
      expect(mgr.isPaused("t1")).toBe(true);
      expect(mgr.isPaused("t2")).toBe(true);

      // The parent channel dies just as the window tears down.
      channelDead = true;
      expect(() => mgr.resumeAll()).not.toThrow();

      expect(mgr.isPaused("t1")).toBe(false);
      expect(mgr.isPaused("t2")).toBe(false);
      const coordinator = deps.getPauseCoordinator("t1");
      expect(coordinator!.resume).toHaveBeenCalledWith("port-queue");
    });

    it("second resumeAll is a no-op (disconnect then dispose)", () => {
      const deps = createMockDeps();
      const mgr = new PortQueueManager(deps);

      const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
      mgr.addBytes("t1", highWatermark + 1);
      mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
      mgr.resumeAll();

      const emitMetric = deps.emitReliabilityMetric as ReturnType<typeof vi.fn>;
      emitMetric.mockClear();
      mgr.resumeAll();
      expect(emitMetric).not.toHaveBeenCalled();
    });
  });

  describe("focused-terminal prioritization (#10878)", () => {
    function fillBelowPerTerminalWatermark(mgr: PortQueueManager, count: number, bytes: number) {
      for (let i = 0; i < count; i++) {
        mgr.addBytes(`t${i}`, bytes);
      }
    }

    it("exempts the focused terminal from the aggregate high-watermark pause", () => {
      const deps = createMockDeps();
      deps.getFocusedTerminalId = () => "t0";
      const mgr = new PortQueueManager(deps);

      // 16 × 1MB = aggregate high watermark; every terminal is below its own gate.
      fillBelowPerTerminalWatermark(mgr, 16, 1024 * 1024);
      expect(mgr.getTotalQueuedBytes()).toBe(IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES);

      // Focused terminal is NOT paused by the aggregate trigger...
      expect(mgr.applyBackpressure("t0", mgr.getUtilization("t0"))).toBe(false);
      expect(mgr.isPaused("t0")).toBe(false);
      // ...while a non-focused sibling in the same window still is.
      expect(mgr.applyBackpressure("t1", mgr.getUtilization("t1"))).toBe(true);
      expect(mgr.isPaused("t1")).toBe(true);
    });

    it("still pauses the focused terminal at its OWN high watermark", () => {
      const deps = createMockDeps();
      deps.getFocusedTerminalId = () => "t1";
      const mgr = new PortQueueManager(deps);

      // Aggregate exemption must never let the focused terminal grow unbounded:
      // its own per-terminal watermark applies unconditionally.
      const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
      mgr.addBytes("t1", highWatermark + 1);

      expect(mgr.applyBackpressure("t1", mgr.getUtilization("t1"))).toBe(true);
      expect(mgr.isPaused("t1")).toBe(true);
    });

    it("resumes the focused terminal first when the aggregate drains", () => {
      const deps = createMockDeps();
      let focused: string | null = null;
      deps.getFocusedTerminalId = () => focused;
      const mgr = new PortQueueManager(deps);

      // Everything floods; t0 and t1 both pause on the aggregate while unfocused.
      fillBelowPerTerminalWatermark(mgr, 16, 1024 * 1024);
      mgr.applyBackpressure("t0", mgr.getUtilization("t0"));
      mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
      expect(mgr.isPaused("t0")).toBe(true);
      expect(mgr.isPaused("t1")).toBe(true);

      // The user focuses t1, then everyone's queue drains. Drain t0/t1's own
      // bytes to 0 first (aggregate still high, so no resume yet).
      focused = "t1";
      mgr.removeBytes("t0", 1024 * 1024);
      mgr.removeBytes("t1", 1024 * 1024);
      expect(mgr.isPaused("t0")).toBe(true);
      expect(mgr.isPaused("t1")).toBe(true);

      // Sibling acks drain the aggregate below the low watermark, triggering the
      // resume sweep. Capture the order terminals are resumed in via the
      // "running" status emissions.
      const emit = deps.emitTerminalStatus as ReturnType<typeof vi.fn>;
      emit.mockClear();
      for (let i = 2; i < 10; i++) {
        mgr.removeBytes(`t${i}`, 1024 * 1024);
      }

      expect(mgr.isPaused("t0")).toBe(false);
      expect(mgr.isPaused("t1")).toBe(false);
      const resumeOrder = emit.mock.calls
        .filter((c) => c[1] === "running")
        .map((c) => c[0] as string);
      expect(resumeOrder).toEqual(["t1", "t0"]);
    });

    it("sweeps every paused terminal even when the focused id is not paused", () => {
      const deps = createMockDeps();
      // Focused terminal has no in-flight bytes of its own, so it never entered
      // pausedTerminals — the sweep must still resume the paused siblings.
      deps.getFocusedTerminalId = () => "focused-idle";
      const mgr = new PortQueueManager(deps);

      fillBelowPerTerminalWatermark(mgr, 16, 1024 * 1024);
      mgr.applyBackpressure("t0", mgr.getUtilization("t0"));
      mgr.removeBytes("t0", 1024 * 1024);
      expect(mgr.isPaused("t0")).toBe(true);

      for (let i = 1; i < 9; i++) {
        mgr.removeBytes(`t${i}`, 1024 * 1024);
      }
      expect(mgr.isPaused("t0")).toBe(false);
    });

    it("with no focused id the aggregate trigger applies to every terminal", () => {
      const deps = createMockDeps();
      // getFocusedTerminalId omitted → behaves exactly as before.
      const mgr = new PortQueueManager(deps);

      fillBelowPerTerminalWatermark(mgr, 16, 1024 * 1024);
      expect(mgr.applyBackpressure("t0", mgr.getUtilization("t0"))).toBe(true);
      expect(mgr.isPaused("t0")).toBe(true);
    });
  });

  describe("constants alignment — Claude burst headroom", () => {
    it("max queue is 3MB to absorb low-single-digit-MB bursts", () => {
      expect(IPC_MAX_QUEUE_BYTES).toBe(3 * 1024 * 1024);
    });

    it("high watermark sits near 2MB (67% of cap)", () => {
      const high = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
      expect(high).toBeGreaterThanOrEqual(2 * 1024 * 1024);
      expect(high).toBeLessThan(2.1 * 1024 * 1024);
    });

    it("low watermark sits near 1MB (33% of cap, ~1MB drain window)", () => {
      const low = (IPC_MAX_QUEUE_BYTES * IPC_LOW_WATERMARK_PERCENT) / 100;
      expect(low).toBeGreaterThan(1000 * 1024);
      expect(low).toBeLessThanOrEqual(1024 * 1024);
    });
  });
});
