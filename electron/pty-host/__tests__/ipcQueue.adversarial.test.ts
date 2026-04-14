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

  it("clearQueue cancels a pending safety-timeout force-resume", () => {
    mgr.addBytes("t1", HIGH_BYTES);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    expect(mgr.isPaused("t1")).toBe(true);
    coord.resume.mockClear();

    mgr.clearQueue("t1");
    expect(mgr.isPaused("t1")).toBe(false);

    vi.advanceTimersByTime(IPC_MAX_PAUSE_MS * 2);

    expect(coord.resume).not.toHaveBeenCalled();
    expect(mgr.getQueuedBytes("t1")).toBe(0);
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

  it("dispose clears all paused terminals and cancels their safety timeouts", () => {
    mgr.addBytes("t1", HIGH_BYTES);
    mgr.applyBackpressure("t1", mgr.getUtilization("t1"));
    mgr.addBytes("t2", HIGH_BYTES);
    mgr.applyBackpressure("t2", mgr.getUtilization("t2"));
    coord.resume.mockClear();

    mgr.dispose();

    expect(mgr.isPaused("t1")).toBe(false);
    expect(mgr.isPaused("t2")).toBe(false);

    vi.advanceTimersByTime(IPC_MAX_PAUSE_MS * 2);
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
});
