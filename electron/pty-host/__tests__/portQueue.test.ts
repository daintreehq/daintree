import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PortQueueManager, type PortQueueDeps } from "../portQueue.js";
import type { PtyPauseCoordinator } from "../PtyPauseCoordinator.js";

// Mirror the real constants from pty/types.ts
const IPC_MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const IPC_HIGH_WATERMARK_PERCENT = 95;
const IPC_LOW_WATERMARK_PERCENT = 60;

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

    vi.advanceTimersByTime(5000);

    expect(mgr.isPaused("t1")).toBe(false);
    const coordinator = deps.getPauseCoordinator("t1");
    expect(coordinator!.resume).toHaveBeenCalledWith("port-queue");
  });

  it("clearQueue clears all state for a terminal", () => {
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));

    mgr.clearQueue("t1");

    expect(mgr.getQueuedBytes("t1")).toBe(0);
    expect(mgr.isPaused("t1")).toBe(false);
  });

  it("dispose clears all terminals", () => {
    const deps = createMockDeps();
    const mgr = new PortQueueManager(deps);

    const highWatermark = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    mgr.addBytes("t1", highWatermark + 1);
    mgr.addBytes("t2", highWatermark + 1);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    mgr.applyBackpressure("t2", mgr.getUtilization("t2"));

    mgr.dispose();

    expect(mgr.getQueuedBytes("t1")).toBe(0);
    expect(mgr.getQueuedBytes("t2")).toBe(0);
    expect(mgr.isPaused("t1")).toBe(false);
    expect(mgr.isPaused("t2")).toBe(false);
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
});
