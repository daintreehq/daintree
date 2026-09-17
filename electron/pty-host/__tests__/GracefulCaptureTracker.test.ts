import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GracefulCaptureTracker } from "../GracefulCaptureTracker.js";
import { PtyPauseCoordinator } from "../PtyPauseCoordinator.js";
import { IpcQueueManager } from "../ipcQueue.js";
import { PortQueueManager } from "../portQueue.js";
import {
  IPC_HIGH_WATERMARK_PERCENT,
  IPC_MAX_PAUSE_MS,
  IPC_MAX_QUEUE_BYTES,
} from "../../services/pty/types.js";
import { logBuffer } from "../../services/LogBuffer.js";
import { getLogLevelOverrides, setLogLevelOverrides } from "../../utils/logger.js";

const LOG_SOURCE = "pty-host:GracefulCapture";
const HIGH_WATERMARK_BYTES = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
const CHUNK = "x".repeat(64 * 1024);

function createHost() {
  const coordinators = new Map<string, PtyPauseCoordinator>();
  const live = new Map<string, boolean>();
  const emitDataLoss = vi.fn<(id: string, droppedBytes: number) => void>();

  const addTerminal = (id: string): PtyPauseCoordinator => {
    const coordinator = new PtyPauseCoordinator({ pause: vi.fn(), resume: vi.fn() });
    coordinators.set(id, coordinator);
    live.set(id, true);
    return coordinator;
  };

  const tracker = new GracefulCaptureTracker({
    getPauseCoordinator: (id) => coordinators.get(id),
    getOrCreatePauseCoordinator: (id) => coordinators.get(id),
    isTerminalLive: (id) => live.get(id) ?? false,
    emitDataLoss,
  });

  return { tracker, coordinators, live, emitDataLoss, addTerminal };
}

function createIpcQueue(coordinators: Map<string, PtyPauseCoordinator>): IpcQueueManager {
  return new IpcQueueManager({
    getTerminal: () => undefined,
    getPauseCoordinator: (id) => coordinators.get(id),
    sendEvent: vi.fn(),
    metricsEnabled: () => false,
    emitTerminalStatus: vi.fn(),
    emitReliabilityMetric: vi.fn(),
  });
}

function createPortQueue(coordinators: Map<string, PtyPauseCoordinator>): PortQueueManager {
  return new PortQueueManager({
    getTerminal: () => undefined,
    getPauseCoordinator: (id) => coordinators.get(id),
    sendEvent: vi.fn(),
    metricsEnabled: () => false,
    emitTerminalStatus: vi.fn(),
    emitReliabilityMetric: vi.fn(),
    pauseToken: "port-queue-7",
  });
}

/** The host's routing decision, reduced to one queue that is never acked. */
function route(
  tracker: GracefulCaptureTracker,
  queue: IpcQueueManager | PortQueueManager,
  id: string,
  chunk: string
): boolean {
  if (tracker.shouldDiscardDelivery(id, chunk)) return false;
  queue.addBytes(id, chunk.length);
  queue.applyBackpressure(id, queue.getUtilization(id));
  return true;
}

describe("GracefulCaptureTracker", () => {
  let savedOverrides: ReturnType<typeof getLogLevelOverrides>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    savedOverrides = getLogLevelOverrides();
    setLogLevelOverrides({ "*": "info" });
    logBuffer.clear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    setLogLevelOverrides(savedOverrides);
    logBuffer.clear();
  });

  function captureLogs() {
    return logBuffer.getFiltered({ sources: [LOG_SOURCE] });
  }

  it("resumes a governor-paused terminal and leaves its neighbour paused", () => {
    const { tracker, addTerminal } = createHost();
    const capturing = addTerminal("t1");
    const neighbour = addTerminal("t2");
    capturing.pause("resource-governor");
    neighbour.pause("resource-governor");

    tracker.enter("t1");

    expect(tracker.isCapturing("t1")).toBe(true);
    expect(capturing.isReadPaused).toBe(false);
    expect(neighbour.isReadPaused).toBe(true);

    // Another pressure sample mid-handshake.
    capturing.pause("resource-governor");
    neighbour.pause("resource-governor");
    expect(capturing.isReadPaused).toBe(false);
    expect(neighbour.isReadPaused).toBe(true);
    expect(tracker.isCapturing("t2")).toBe(false);
  });

  it("does nothing for a terminal without a coordinator", () => {
    const { tracker } = createHost();
    tracker.enter("ghost");
    expect(tracker.isCapturing("ghost")).toBe(false);
    expect(tracker.shouldDiscardDelivery("ghost", CHUNK)).toBe(false);
    expect(() => tracker.end("ghost", "settled")).not.toThrow();
    expect(captureLogs()).toHaveLength(0);
  });

  it("delivers output while nothing asks for the terminal to be held", () => {
    const { tracker, addTerminal } = createHost();
    const coordinator = addTerminal("t1");
    tracker.enter("t1");

    expect(tracker.shouldDiscardDelivery("t1", CHUNK)).toBe(false);

    coordinator.pause("resource-governor");
    expect(tracker.shouldDiscardDelivery("t1", CHUNK)).toBe(true);

    coordinator.resume("resource-governor");
    expect(tracker.shouldDiscardDelivery("t1", CHUNK)).toBe(false);
  });

  it("never discards for a terminal that is not capturing", () => {
    const { tracker, addTerminal } = createHost();
    const coordinator = addTerminal("t1");
    coordinator.pause("ipc-queue");
    expect(tracker.shouldDiscardDelivery("t1", CHUNK)).toBe(false);
  });

  it("keeps an unacknowledged renderer queue under its watermark while capture reads on", () => {
    const { tracker, coordinators, addTerminal } = createHost();
    const coordinator = addTerminal("t1");
    const queue = createIpcQueue(coordinators);
    tracker.enter("t1");

    let delivered = 0;
    let dropped = 0;
    // Several times the queue's own hard cap, with no acknowledgement at all.
    for (let i = 0; i < 200; i++) {
      if (route(tracker, queue, "t1", CHUNK)) delivered++;
      else dropped++;
      expect(coordinator.isReadPaused).toBe(false);
    }

    expect(delivered).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(0);
    expect(queue.getQueuedBytes("t1")).toBeLessThan(HIGH_WATERMARK_BYTES + CHUNK.length);
    expect(queue.getQueuedBytes("t1")).toBeLessThan(IPC_MAX_QUEUE_BYTES);
    queue.dispose();
  });

  it("bounds a per-window port queue the same way", () => {
    const { tracker, coordinators, addTerminal } = createHost();
    const coordinator = addTerminal("t1");
    const queue = createPortQueue(coordinators);
    tracker.enter("t1");

    for (let i = 0; i < 200; i++) route(tracker, queue, "t1", CHUNK);

    expect(coordinator.isReadPaused).toBe(false);
    expect(coordinator.hasToken("port-queue-7")).toBe(true);
    expect(queue.getQueuedBytes("t1")).toBeLessThan(HIGH_WATERMARK_BYTES + CHUNK.length);
    queue.dispose();
  });

  it("delivers everything to a renderer that keeps up", () => {
    const { tracker, coordinators, addTerminal } = createHost();
    addTerminal("t1");
    const queue = createIpcQueue(coordinators);
    tracker.enter("t1");

    for (let i = 0; i < 200; i++) {
      expect(route(tracker, queue, "t1", CHUNK)).toBe(true);
      queue.removeBytes("t1", CHUNK.length);
      queue.tryResume("t1");
    }
    queue.dispose();
  });

  it("re-pauses a surviving terminal whose renderer is still behind, and resyncs it once", () => {
    const { tracker, coordinators, addTerminal, emitDataLoss } = createHost();
    const coordinator = addTerminal("t1");
    const queue = createIpcQueue(coordinators);
    tracker.enter("t1");

    let droppedBytes = 0;
    for (let i = 0; i < 100; i++) {
      if (!route(tracker, queue, "t1", CHUNK)) droppedBytes += CHUNK.length;
    }
    expect(droppedBytes).toBeGreaterThan(0);

    tracker.end("t1", "settled");

    expect(tracker.isCapturing("t1")).toBe(false);
    expect(coordinator.isCapturing).toBe(false);
    expect(coordinator.isReadPaused).toBe(true);
    expect(emitDataLoss).toHaveBeenCalledTimes(1);
    expect(emitDataLoss).toHaveBeenCalledWith("t1", droppedBytes);

    // The queue's own safety bound still applies to the restored hold.
    vi.advanceTimersByTime(IPC_MAX_PAUSE_MS);
    expect(coordinator.isReadPaused).toBe(false);
    queue.dispose();
  });

  it("restores normal protection once a surviving terminal's capture ends", () => {
    const { tracker, addTerminal } = createHost();
    const coordinator = addTerminal("t1");
    tracker.enter("t1");
    tracker.end("t1", "settled");

    coordinator.pause("resource-governor");

    expect(coordinator.isReadPaused).toBe(true);
    expect(tracker.shouldDiscardDelivery("t1", CHUNK)).toBe(false);
  });

  it("does not resync a terminal that was killed", () => {
    const { tracker, addTerminal, live, emitDataLoss } = createHost();
    const coordinator = addTerminal("t1");
    tracker.enter("t1");
    coordinator.pause("resource-governor");
    tracker.shouldDiscardDelivery("t1", CHUNK);
    live.set("t1", false);

    tracker.end("t1", "settled");

    expect(emitDataLoss).not.toHaveBeenCalled();
  });

  it("does not resync when nothing was dropped", () => {
    const { tracker, addTerminal, emitDataLoss } = createHost();
    addTerminal("t1");
    tracker.enter("t1");
    tracker.end("t1", "settled");
    expect(emitDataLoss).not.toHaveBeenCalled();
  });

  it("counts dropped bytes, not characters", () => {
    const { tracker, addTerminal, emitDataLoss } = createHost();
    const coordinator = addTerminal("t1");
    tracker.enter("t1");
    coordinator.pause("resource-governor");

    tracker.shouldDiscardDelivery("t1", "é");
    tracker.shouldDiscardDelivery("t1", new Uint8Array(5));
    tracker.end("t1", "settled");

    expect(emitDataLoss).toHaveBeenCalledWith("t1", 7);
  });

  it("ends once however many times it is told to", () => {
    const { tracker, addTerminal, emitDataLoss } = createHost();
    const coordinator = addTerminal("t1");
    tracker.enter("t1");
    tracker.enter("t1");
    coordinator.pause("resource-governor");
    tracker.shouldDiscardDelivery("t1", CHUNK);

    tracker.end("t1", "terminal-exit");
    tracker.end("t1", "settled");

    expect(captureLogs()).toHaveLength(1);
    expect(emitDataLoss).not.toHaveBeenCalled();
  });

  it("ignores a lease left behind by a replaced incarnation", () => {
    const { tracker, coordinators, addTerminal } = createHost();
    const old = addTerminal("t1");
    tracker.enter("t1");
    old.pause("resource-governor");

    // Respawn at the same id retires the old coordinator.
    const replacement = addTerminal("t1");
    replacement.pause("resource-governor");

    expect(coordinators.get("t1")).toBe(replacement);
    expect(tracker.isCapturing("t1")).toBe(false);
    expect(tracker.shouldDiscardDelivery("t1", CHUNK)).toBe(false);
    expect(replacement.isReadPaused).toBe(true);

    tracker.enter("t1");
    expect(replacement.isCapturing).toBe(true);
    expect(replacement.isReadPaused).toBe(false);
  });

  it("logs one bounded summary without terminal output", () => {
    const { tracker, addTerminal } = createHost();
    const coordinator = addTerminal("t1");
    coordinator.pause("resource-governor");
    coordinator.pause("port-queue-4");
    tracker.enter("t1");
    coordinator.pause("ipc-queue");
    tracker.shouldDiscardDelivery("t1", "SECRET-OUTPUT codex resume 1234");
    vi.advanceTimersByTime(750);

    tracker.end("t1", "settled");

    const entries = captureLogs();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("info");
    const context = entries[0]!.context as Record<string, unknown>;
    expect(context).toMatchObject({
      terminalId: "t1",
      cause: "settled",
      durationMs: 750,
      heldAtEntry: ["port-queue", "resource-governor"],
      readPausedAtEntry: true,
      suppressed: ["ipc-queue", "port-queue", "resource-governor"],
      sleepHeld: false,
      survived: true,
      readPausedAfter: true,
    });
    expect(context.discardedBytes).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain("SECRET-OUTPUT");
    expect(JSON.stringify(entries)).not.toContain("1234");
  });

  it("records a sleep hold that kept capture from reading", () => {
    const { tracker, addTerminal } = createHost();
    const coordinator = addTerminal("t1");
    coordinator.pause("system-sleep");

    tracker.enter("t1");
    expect(coordinator.isReadPaused).toBe(true);
    tracker.end("t1", "settled");

    const context = captureLogs()[0]!.context as Record<string, unknown>;
    expect(context).toMatchObject({ sleepHeld: true, suppressed: [] });
  });

  it("drops every lease on dispose", () => {
    const { tracker, addTerminal } = createHost();
    addTerminal("t1");
    tracker.enter("t1");
    tracker.dispose();
    expect(tracker.isCapturing("t1")).toBe(false);
  });
});
