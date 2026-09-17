import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GracefulCaptureTracker } from "../GracefulCaptureTracker.js";
import { PtyPauseCoordinator } from "../PtyPauseCoordinator.js";
import { IpcQueueManager } from "../ipcQueue.js";
import { PortQueueManager } from "../portQueue.js";
import {
  IPC_HIGH_WATERMARK_PERCENT,
  IPC_MAX_PAUSE_MS,
  IPC_MAX_QUEUE_BYTES,
  type GracefulCaptureLease,
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

  const open = (id: string): GracefulCaptureLease => {
    const lease = tracker.open(id);
    if (!lease) throw new Error(`no capture window for ${id}`);
    return lease;
  };

  return { tracker, coordinators, live, emitDataLoss, addTerminal, open };
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

/** A kept chunk posted to a renderer queue that never acknowledges. */
function route(
  lease: GracefulCaptureLease,
  queue: IpcQueueManager | PortQueueManager,
  id: string,
  chunk: string
): boolean {
  if (lease.shouldDiscard(chunk)) return false;
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
    const { tracker, addTerminal, open } = createHost();
    const capturing = addTerminal("t1");
    const neighbour = addTerminal("t2");
    capturing.pause("resource-governor");
    neighbour.pause("resource-governor");

    open("t1");

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

  it("opens nothing for a terminal without a coordinator", () => {
    const { tracker } = createHost();
    expect(tracker.open("ghost")).toBeNull();
    expect(tracker.isCapturing("ghost")).toBe(false);
    expect(() => tracker.end("ghost", "terminal-exit")).not.toThrow();
    expect(captureLogs()).toHaveLength(0);
  });

  it("refuses a second window on a terminal that already has one", () => {
    const { tracker, addTerminal, open } = createHost();
    const coordinator = addTerminal("t1");
    const first = open("t1");

    expect(tracker.open("t1")).toBeNull();

    first.close();
    expect(coordinator.isCapturing).toBe(false);
    expect(tracker.open("t1")).not.toBeNull();
  });

  it("keeps output while nothing asks for the terminal to be held", () => {
    const { addTerminal, open } = createHost();
    const coordinator = addTerminal("t1");
    const lease = open("t1");

    expect(lease.shouldDiscard(CHUNK)).toBe(false);

    coordinator.pause("resource-governor");
    expect(lease.shouldDiscard(CHUNK)).toBe(true);

    coordinator.resume("resource-governor");
    expect(lease.shouldDiscard(CHUNK)).toBe(false);
  });

  it("keeps an unacknowledged renderer queue under its watermark while capture reads on", () => {
    const { coordinators, addTerminal, open } = createHost();
    const coordinator = addTerminal("t1");
    const queue = createIpcQueue(coordinators);
    const lease = open("t1");

    let kept = 0;
    let dropped = 0;
    // Several times the queue's own hard cap, with no acknowledgement at all.
    for (let i = 0; i < 200; i++) {
      if (route(lease, queue, "t1", CHUNK)) kept++;
      else dropped++;
      expect(coordinator.isReadPaused).toBe(false);
    }

    expect(kept).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(0);
    expect(queue.getQueuedBytes("t1")).toBeLessThan(HIGH_WATERMARK_BYTES + CHUNK.length);
    expect(queue.getQueuedBytes("t1")).toBeLessThan(IPC_MAX_QUEUE_BYTES);
    queue.dispose();
  });

  it("bounds a per-window port queue the same way", () => {
    const { coordinators, addTerminal, open } = createHost();
    const coordinator = addTerminal("t1");
    const queue = createPortQueue(coordinators);
    const lease = open("t1");

    for (let i = 0; i < 200; i++) route(lease, queue, "t1", CHUNK);

    expect(coordinator.isReadPaused).toBe(false);
    expect(coordinator.hasToken("port-queue-7")).toBe(true);
    expect(queue.getQueuedBytes("t1")).toBeLessThan(HIGH_WATERMARK_BYTES + CHUNK.length);
    queue.dispose();
  });

  it("keeps everything for a renderer that keeps up", () => {
    const { coordinators, addTerminal, open } = createHost();
    addTerminal("t1");
    const queue = createIpcQueue(coordinators);
    const lease = open("t1");

    for (let i = 0; i < 200; i++) {
      expect(route(lease, queue, "t1", CHUNK)).toBe(true);
      queue.removeBytes("t1", CHUNK.length);
      queue.tryResume("t1");
    }
    queue.dispose();
  });

  it("re-pauses a surviving terminal whose renderer is still behind, and marks the gap once", () => {
    const { tracker, coordinators, addTerminal, emitDataLoss, open } = createHost();
    const coordinator = addTerminal("t1");
    const queue = createIpcQueue(coordinators);
    const lease = open("t1");

    let droppedBytes = 0;
    for (let i = 0; i < 100; i++) {
      if (!route(lease, queue, "t1", CHUNK)) droppedBytes += CHUNK.length;
    }
    expect(droppedBytes).toBeGreaterThan(0);

    lease.close();
    lease.close();

    expect(tracker.isCapturing("t1")).toBe(false);
    expect(coordinator.isCapturing).toBe(false);
    expect(coordinator.isReadPaused).toBe(true);
    expect(emitDataLoss).toHaveBeenCalledTimes(1);
    expect(emitDataLoss).toHaveBeenCalledWith("t1", droppedBytes);
    expect(lease.shouldDiscard(CHUNK)).toBe(false);

    // The queue's own safety bound still applies to the restored hold.
    vi.advanceTimersByTime(IPC_MAX_PAUSE_MS);
    expect(coordinator.isReadPaused).toBe(false);
    queue.dispose();
  });

  it("restores normal protection once a surviving terminal's window closes", () => {
    const { addTerminal, open } = createHost();
    const coordinator = addTerminal("t1");
    const lease = open("t1");
    lease.close();

    coordinator.pause("resource-governor");

    expect(coordinator.isReadPaused).toBe(true);
    expect(lease.shouldDiscard(CHUNK)).toBe(false);
  });

  it("does not mark a gap on a terminal that was killed", () => {
    const { addTerminal, live, emitDataLoss, open } = createHost();
    const coordinator = addTerminal("t1");
    const lease = open("t1");
    coordinator.pause("resource-governor");
    lease.shouldDiscard(CHUNK);
    live.set("t1", false);

    lease.close();

    expect(emitDataLoss).not.toHaveBeenCalled();
  });

  it("does not mark a gap when nothing was discarded", () => {
    const { addTerminal, emitDataLoss, open } = createHost();
    addTerminal("t1");
    open("t1").close();
    expect(emitDataLoss).not.toHaveBeenCalled();
  });

  it("counts discarded bytes, not characters", () => {
    const { addTerminal, emitDataLoss, open } = createHost();
    const coordinator = addTerminal("t1");
    const lease = open("t1");
    coordinator.pause("resource-governor");

    lease.shouldDiscard("é");
    lease.shouldDiscard(new Uint8Array(5));
    lease.close();

    expect(emitDataLoss).toHaveBeenCalledWith("t1", 7);
  });

  it("retires the window when the terminal exits first", () => {
    const { tracker, addTerminal, emitDataLoss, open } = createHost();
    const coordinator = addTerminal("t1");
    const lease = open("t1");
    coordinator.pause("resource-governor");
    lease.shouldDiscard(CHUNK);

    tracker.end("t1", "terminal-exit");
    expect(emitDataLoss).not.toHaveBeenCalled();
    lease.close();

    expect(captureLogs()).toHaveLength(1);
    expect(emitDataLoss).not.toHaveBeenCalled();
    expect(coordinator.isCapturing).toBe(false);
  });

  it("keeps a replaced incarnation's window off its successor", () => {
    const { tracker, coordinators, addTerminal, emitDataLoss, open } = createHost();
    const old = addTerminal("t1");
    const oldLease = open("t1");
    old.pause("resource-governor");

    // Respawn at the same id retires the old coordinator.
    const replacement = addTerminal("t1");
    replacement.pause("resource-governor");

    expect(coordinators.get("t1")).toBe(replacement);
    expect(tracker.isCapturing("t1")).toBe(false);
    expect(oldLease.shouldDiscard(CHUNK)).toBe(false);
    expect(replacement.isReadPaused).toBe(true);

    const newLease = open("t1");
    expect(replacement.isReadPaused).toBe(false);

    // The old teardown settling late must not close the new window.
    oldLease.close();
    expect(replacement.isCapturing).toBe(true);
    expect(newLease.shouldDiscard(CHUNK)).toBe(true);
    expect(emitDataLoss).not.toHaveBeenCalled();
  });

  it("logs one bounded summary without terminal output", () => {
    const { addTerminal, open } = createHost();
    const coordinator = addTerminal("t1");
    coordinator.pause("resource-governor");
    coordinator.pause("port-queue-4");
    const lease = open("t1");
    coordinator.pause("ipc-queue");
    lease.shouldDiscard("SECRET-OUTPUT codex resume 1234");
    vi.advanceTimersByTime(750);

    lease.close();

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
    const { addTerminal, open } = createHost();
    const coordinator = addTerminal("t1");
    coordinator.pause("system-sleep");

    const lease = open("t1");
    expect(coordinator.isReadPaused).toBe(true);
    lease.close();

    const context = captureLogs()[0]!.context as Record<string, unknown>;
    expect(context).toMatchObject({ sleepHeld: true, suppressed: [] });
  });

  it("drops every window on dispose", () => {
    const { tracker, addTerminal, open } = createHost();
    addTerminal("t1");
    const lease = open("t1");
    tracker.dispose();
    expect(tracker.isCapturing("t1")).toBe(false);
    expect(() => lease.close()).not.toThrow();
  });
});
