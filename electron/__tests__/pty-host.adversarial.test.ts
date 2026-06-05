import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { SharedRingBuffer } from "../../shared/utils/SharedRingBuffer.js";

type TestMock = Mock;

class MiniEmitter {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const current = this.listeners.get(event);
    if (!current) return false;
    for (const listener of [...current]) {
      listener(...args);
    }
    return current.length > 0;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    const current = this.listeners.get(event);
    if (!current) return this;
    this.listeners.set(
      event,
      current.filter((candidate) => candidate !== listener)
    );
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
    return this;
  }
}

interface MockParentPort extends MiniEmitter {
  postMessage: TestMock;
}

interface MockRendererPort extends MiniEmitter {
  postMessage: TestMock;
  start: TestMock;
  close: TestMock;
}

interface MockTerminalRecord {
  id: string;
  projectId?: string;
  cwd: string;
  spawnedAt: number;
  ptyProcess: {
    pause: TestMock;
    resume: TestMock;
    pid: number;
  };
  analysisEnabled?: boolean;
  wasKilled?: boolean;
  isExited?: boolean;
}

interface InspectablePauseCoordinator {
  pause: TestMock;
  resume: TestMock;
  forceReleaseAll: TestMock;
  heldTokens: Set<string>;
  readonly isPaused: boolean;
}

type PendingSegment = { data: Uint8Array; offset: number };

interface InspectableBackpressureManager {
  stats: {
    pauseCount: number;
    resumeCount: number;
    suspendCount: number;
    forceResumeCount: number;
  };
  pauseStartTimes: Map<string, number>;
  pausedIntervals: Map<string, ReturnType<typeof setTimeout>>;
  suspended: Set<string>;
  pendingSegments: Map<string, PendingSegment[]>;
  emitTerminalStatus: (
    id: string,
    status: string,
    bufferUtilization?: number,
    pauseDuration?: number
  ) => void;
  emitReliabilityMetric: TestMock;
  getPauseStartTime: (id: string) => number | undefined;
  setPauseStartTime: (id: string, time: number) => void;
  deletePauseStartTime: (id: string) => void;
  getPausedInterval: (id: string) => ReturnType<typeof setTimeout> | undefined;
  setPausedInterval: (id: string, timer: ReturnType<typeof setTimeout>) => void;
  deletePausedInterval: (id: string) => void;
  isPaused: (id: string) => boolean;
  isSuspended: (id: string) => boolean;
  setSuspended: (id: string) => void;
  clearSuspended: (id: string) => void;
  getActivityTier: (id: string) => "active" | "background";
  setActivityTier: (id: string, tier: "active" | "background") => void;
  enqueuePendingSegment: (id: string, segment: PendingSegment) => boolean;
  hasPendingSegments: (id: string) => boolean;
  getPendingSegments: (id: string) => PendingSegment[] | undefined;
  consumePendingBytes: (id: string, bytes: number) => void;
  clearPendingVisual: (id: string) => void;
  suspendVisualStream: (
    id: string,
    reason: string,
    utilization?: number,
    pauseDuration?: number
  ) => void;
  cleanupTerminal: (id: string) => void;
  dispose: () => void;
}

interface InspectableIpcQueueManager {
  queuedBytes: Map<string, number>;
  clearQueue: TestMock;
  removeBytes: TestMock;
  tryResume: TestMock;
  isAtCapacity: TestMock;
  addBytes: TestMock;
  getUtilization: TestMock;
  dispose: TestMock;
}

interface InspectablePortQueueManager {
  pauseToken: string;
  pausedIds: Set<string>;
  removeBytes: TestMock;
  tryResume: TestMock;
  clearQueue: TestMock;
  resumeAll: TestMock;
  dispose: TestMock;
  events: string[];
  markPaused: (id: string) => void;
}

interface InspectablePortBatcher {
  dispose: TestMock;
  flushTerminal: TestMock;
  write: TestMock;
}

const hostState = vi.hoisted(() => ({
  currentParentPort: null as MockParentPort | null,
  terminals: new Map<string, MockTerminalRecord>(),
  currentPtyManager: null as MiniEmitter | null,
  coordinators: [] as InspectablePauseCoordinator[],
  backpressureManagers: [] as InspectableBackpressureManager[],
  ipcQueueManagers: [] as InspectableIpcQueueManager[],
  portQueueManagers: [] as InspectablePortQueueManager[],
  batchers: [] as InspectablePortBatcher[],
  reset() {
    this.currentParentPort = null;
    this.terminals.clear();
    this.currentPtyManager = null;
    this.coordinators.length = 0;
    this.backpressureManagers.length = 0;
    this.ipcQueueManagers.length = 0;
    this.portQueueManagers.length = 0;
    this.batchers.length = 0;
  },
}));

function createTerminal(id: string, projectId?: string): MockTerminalRecord {
  return {
    id,
    projectId,
    cwd: "/tmp",
    spawnedAt: Date.now(),
    ptyProcess: {
      pause: vi.fn(),
      resume: vi.fn(),
      pid: 100,
    },
    analysisEnabled: false,
    wasKilled: false,
    isExited: false,
  };
}

function createParentPort(): MockParentPort {
  return Object.assign(new MiniEmitter(), {
    postMessage: vi.fn(),
  });
}

function createRendererPort(): MockRendererPort {
  return Object.assign(new MiniEmitter(), {
    postMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
  });
}

vi.mock("../services/PtyManager.js", () => {
  class MockPtyManager extends MiniEmitter {
    private sabMode = false;
    acknowledgeData = vi.fn();
    setSabMode = vi.fn((enabled: boolean) => {
      this.sabMode = enabled;
    });
    isSabMode = vi.fn(() => this.sabMode);
    setProcessTreeCache = vi.fn();
    setImagePathProbe = vi.fn();
    setPtyPool = vi.fn();
    setActivityMonitorTier = vi.fn();
    spawn = vi.fn((id: string, options: { projectId?: string }) => {
      if (!hostState.terminals.has(id)) {
        hostState.terminals.set(id, createTerminal(id, options.projectId));
      }
    });
    getTerminal = vi.fn((id: string) => hostState.terminals.get(id));
    getAll = vi.fn(() => Array.from(hostState.terminals.values()));
    write = vi.fn();
    resize = vi.fn();
    kill = vi.fn();
    submit = vi.fn();
    setAnalysisEnabled = vi.fn();
    trimScrollback = vi.fn();
    getAllTerminalSnapshots = vi.fn(() => []);
    transitionState = vi.fn(() => false);
    getTerminalsForProject = vi.fn(() => []);
    getProjectStats = vi.fn(() => ({ terminalCount: 0, processIds: [], terminalTypes: {} }));
    getAvailableTerminals = vi.fn(() => []);
    getTerminalInfo = vi.fn(() => null);
    replayHistory = vi.fn(() => 0);
    getSerializedStateAsync = vi.fn(async () => null);
    dispose = vi.fn();
    markChecked = vi.fn();
    flushAgentSnapshot = vi.fn();
    restore = vi.fn();
    trash = vi.fn();
    gracefulKill = vi.fn();
    gracefulKillByProject = vi.fn();
    killByProject = vi.fn();
    setResourceMonitoring = vi.fn();
    setResourceProfile = vi.fn();
    setActivityTier = vi.fn();

    constructor() {
      super();
      hostState.currentPtyManager = this;
    }
  }

  return { PtyManager: MockPtyManager };
});

vi.mock("../services/PtyPool.js", () => ({
  PtyPool: class {},
  shouldEnablePtyPool: vi.fn(
    (platform: NodeJS.Platform = process.platform) => platform !== "win32"
  ),
  getPtyPool: vi.fn(() => ({
    warmPool: vi.fn(async () => undefined),
    drainAndRefill: vi.fn(async () => undefined),
    dispose: vi.fn(),
  })),
}));

vi.mock("../services/ProcessTreeCache.js", () => ({
  ProcessTreeCache: class {
    start = vi.fn();
    stop = vi.fn();
    setPollInterval = vi.fn();
  },
}));

vi.mock("../services/pty/TerminalResourceMonitor.js", () => ({
  TerminalResourceMonitor: class {
    dispose = vi.fn();
  },
}));

vi.mock("../pty-host/index.js", async () => {
  const actual =
    await vi.importActual<typeof import("../pty-host/index.js")>("../pty-host/index.js");

  class MockPtyPauseCoordinator implements InspectablePauseCoordinator {
    heldTokens = new Set<string>();

    constructor(private readonly raw: { pause: () => void; resume: () => void }) {
      hostState.coordinators.push(this);
    }

    pause = vi.fn((token: string) => {
      const wasEmpty = this.heldTokens.size === 0;
      this.heldTokens.add(token);
      if (wasEmpty) {
        this.raw.pause();
      }
    });

    resume = vi.fn((token: string) => {
      if (!this.heldTokens.delete(token)) return;
      if (this.heldTokens.size === 0) {
        this.raw.resume();
      }
    });

    forceReleaseAll = vi.fn(() => {
      if (this.heldTokens.size === 0) return;
      this.heldTokens.clear();
      this.raw.resume();
    });

    get isPaused(): boolean {
      return this.heldTokens.size > 0;
    }
  }

  class MockBackpressureManager implements InspectableBackpressureManager {
    stats = {
      pauseCount: 0,
      resumeCount: 0,
      suspendCount: 0,
      forceResumeCount: 0,
    };
    pauseStartTimes = new Map<string, number>();
    pausedIntervals = new Map<string, ReturnType<typeof setTimeout>>();
    suspended = new Set<string>();
    pendingSegments = new Map<string, PendingSegment[]>();
    private activityTiers = new Map<string, "active" | "background">();
    private terminalStatuses = new Map<string, string>();
    emitReliabilityMetric = vi.fn();

    constructor(
      private readonly deps: {
        getPauseCoordinator: (id: string) => InspectablePauseCoordinator | undefined;
        sendEvent: (event: unknown) => void;
      }
    ) {
      hostState.backpressureManagers.push(this);
    }

    getPauseStartTime(id: string): number | undefined {
      return this.pauseStartTimes.get(id);
    }

    setPauseStartTime(id: string, time: number): void {
      this.pauseStartTimes.set(id, time);
    }

    deletePauseStartTime(id: string): void {
      this.pauseStartTimes.delete(id);
    }

    getPausedInterval(id: string): ReturnType<typeof setTimeout> | undefined {
      return this.pausedIntervals.get(id);
    }

    setPausedInterval(id: string, timer: ReturnType<typeof setTimeout>): void {
      this.pausedIntervals.set(id, timer);
    }

    deletePausedInterval(id: string): void {
      this.pausedIntervals.delete(id);
    }

    isPaused(id: string): boolean {
      return this.pausedIntervals.has(id);
    }

    isSuspended(id: string): boolean {
      return this.suspended.has(id);
    }

    setSuspended(id: string): void {
      this.suspended.add(id);
    }

    clearSuspended(id: string): void {
      this.suspended.delete(id);
    }

    getActivityTier(id: string): "active" | "background" {
      return this.activityTiers.get(id) ?? "active";
    }

    setActivityTier(id: string, tier: "active" | "background"): void {
      this.activityTiers.set(id, tier);
    }

    enqueuePendingSegment(id: string, segment: PendingSegment): boolean {
      const queue = this.pendingSegments.get(id) ?? [];
      queue.push(segment);
      this.pendingSegments.set(id, queue);
      return true;
    }

    hasPendingSegments(id: string): boolean {
      return (this.pendingSegments.get(id)?.length ?? 0) > 0;
    }

    getPendingSegments(id: string): PendingSegment[] | undefined {
      return this.pendingSegments.get(id);
    }

    consumePendingBytes(id: string, bytes: number): void {
      if (bytes <= 0) return;
      const queue = this.pendingSegments.get(id);
      if (!queue || queue.length === 0) return;
    }

    clearPendingVisual(id: string): void {
      this.pendingSegments.delete(id);
    }

    emitTerminalStatus(
      id: string,
      status: string,
      bufferUtilization?: number,
      pauseDuration?: number
    ): void {
      if (this.terminalStatuses.get(id) === status) {
        return;
      }
      this.terminalStatuses.set(id, status);
      this.deps.sendEvent({
        type: "terminal-status",
        id,
        status,
        bufferUtilization,
        pauseDuration,
        timestamp: Date.now(),
      });
    }

    suspendVisualStream(
      id: string,
      _reason: string,
      utilization?: number,
      pauseDuration?: number
    ): void {
      this.deps.getPauseCoordinator(id)?.resume("backpressure");
      const timer = this.pausedIntervals.get(id);
      if (timer) {
        clearTimeout(timer);
      }
      this.pausedIntervals.delete(id);
      this.pauseStartTimes.delete(id);
      this.suspended.add(id);
      this.pendingSegments.delete(id);
      this.stats.suspendCount++;
      this.emitTerminalStatus(id, "suspended", utilization, pauseDuration);
    }

    cleanupTerminal(id: string): void {
      const timer = this.pausedIntervals.get(id);
      if (timer) {
        clearTimeout(timer);
      }
      this.pausedIntervals.delete(id);
      this.pauseStartTimes.delete(id);
      this.suspended.delete(id);
      this.pendingSegments.delete(id);
      this.activityTiers.delete(id);
      this.terminalStatuses.delete(id);
    }

    dispose(): void {
      for (const timer of this.pausedIntervals.values()) {
        clearTimeout(timer);
      }
      this.pausedIntervals.clear();
      this.pauseStartTimes.clear();
      this.suspended.clear();
      this.pendingSegments.clear();
      this.activityTiers.clear();
      this.terminalStatuses.clear();
    }
  }

  class MockIpcQueueManager implements InspectableIpcQueueManager {
    queuedBytes = new Map<string, number>();
    clearQueue = vi.fn((id: string) => {
      this.queuedBytes.delete(id);
    });
    removeBytes = vi.fn((id: string, bytes: number) => {
      const current = this.queuedBytes.get(id) ?? 0;
      const next = Math.max(0, current - bytes);
      if (next === 0) {
        this.queuedBytes.delete(id);
      } else {
        this.queuedBytes.set(id, next);
      }
    });
    tryResume = vi.fn();
    isAtCapacity = vi.fn(() => false);
    addBytes = vi.fn((id: string, bytes: number) => {
      this.queuedBytes.set(id, (this.queuedBytes.get(id) ?? 0) + bytes);
    });
    getUtilization = vi.fn(() => 0);
    dispose = vi.fn();

    constructor() {
      hostState.ipcQueueManagers.push(this);
    }
  }

  class MockPortQueueManager implements InspectablePortQueueManager {
    pausedIds = new Set<string>();
    events: string[] = [];
    pauseToken: string;

    constructor(
      private readonly deps: {
        getPauseCoordinator: (id: string) => InspectablePauseCoordinator | undefined;
        pauseToken?: string;
      }
    ) {
      this.pauseToken = deps.pauseToken ?? "port-queue";
      hostState.portQueueManagers.push(this);
    }

    removeBytes = vi.fn();
    tryResume = vi.fn();
    clearQueue = vi.fn((id: string) => {
      this.pausedIds.delete(id);
    });
    resumeAll = vi.fn(() => {
      this.events.push("resumeAll");
      for (const id of this.pausedIds) {
        this.deps.getPauseCoordinator(id)?.resume(this.pauseToken);
      }
      this.pausedIds.clear();
    });
    dispose = vi.fn(() => {
      this.events.push("dispose");
      this.pausedIds.clear();
    });

    markPaused(id: string): void {
      this.pausedIds.add(id);
      this.deps.getPauseCoordinator(id)?.pause(this.pauseToken);
    }
  }

  class MockPortBatcher implements InspectablePortBatcher {
    dispose = vi.fn();
    flushTerminal = vi.fn();
    write = vi.fn(() => false);

    constructor() {
      hostState.batchers.push(this);
    }
  }

  class MockResourceGovernor {
    start = vi.fn();
    dispose = vi.fn();
  }

  return {
    ...actual,
    appendEmergencyLog: vi.fn(),
    emergencyLogFatal: vi.fn(),
    metricsEnabled: vi.fn(() => false),
    PtyPauseCoordinator: MockPtyPauseCoordinator,
    BackpressureManager: MockBackpressureManager,
    IpcQueueManager: MockIpcQueueManager,
    PortQueueManager: MockPortQueueManager,
    PortBatcher: MockPortBatcher,
    ResourceGovernor: MockResourceGovernor,
    parseSpawnError: vi.fn(() => "spawn error"),
    toHostSnapshot: vi.fn(() => null),
  };
});

import { BACKPRESSURE_SAFETY_TIMEOUT_MS } from "../pty-host/index.js";
import { getPtyPool } from "../services/PtyPool.js";

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, "parentPort");
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const originalMaxListeners = process.getMaxListeners();
process.setMaxListeners(50);

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function loadHost(): Promise<MockParentPort> {
  vi.resetModules();
  hostState.reset();
  const parentPort = createParentPort();
  hostState.currentParentPort = parentPort;
  Object.defineProperty(process, "parentPort", {
    value: parentPort,
    configurable: true,
  });
  await import("../pty-host.js");
  await flushMicrotasks();
  return parentPort;
}

function terminalStatusPayloads(parentPort: MockParentPort): Array<Record<string, unknown>> {
  return parentPort.postMessage.mock.calls
    .map((call: unknown[]) => call[0])
    .filter(
      (payload: unknown): payload is Record<string, unknown> =>
        typeof payload === "object" &&
        payload !== null &&
        (payload as { type?: string }).type === "terminal-status"
    );
}

function dataPayloads(parentPort: MockParentPort): Array<Record<string, unknown>> {
  return parentPort.postMessage.mock.calls
    .map((call: unknown[]) => call[0])
    .filter(
      (payload: unknown): payload is Record<string, unknown> =>
        typeof payload === "object" &&
        payload !== null &&
        (payload as { type?: string }).type === "data"
    );
}

describe("pty-host adversarial", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getPtyPool).mockClear();
  });

  afterEach(async () => {
    hostState.currentParentPort?.emit("message", { type: "dispose" });
    await flushMicrotasks();
    hostState.currentParentPort?.removeAllListeners();
    if (originalParentPortDescriptor) {
      Object.defineProperty(process, "parentPort", originalParentPortDescriptor);
    } else {
      delete (process as unknown as { parentPort?: unknown }).parentPort;
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    vi.useRealTimers();
  });

  afterAll(() => {
    process.setMaxListeners(originalMaxListeners);
  });

  it("WINDOWS_STARTUP_SKIPS_PTY_POOL", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    const parentPort = await loadHost();

    expect(parentPort.postMessage).toHaveBeenCalledWith({ type: "ready" });
    expect(getPtyPool).not.toHaveBeenCalled();
    const manager = hostState.currentPtyManager as MiniEmitter & { setPtyPool: TestMock };
    expect(manager.setPtyPool).not.toHaveBeenCalled();
  });

  it("SAB_ACK_TIMEOUT_SUSPENDS_STREAM", async () => {
    const parentPort = await loadHost();
    const terminal = createTerminal("t1");
    hostState.terminals.set("t1", terminal);

    parentPort.emit("message", {
      type: "init-buffers",
      visualBuffers: [SharedRingBuffer.create(64)],
      visualSignalBuffer: new SharedArrayBuffer(4),
    });
    await flushMicrotasks();

    // Use the smallest legal ring (64 bytes) plus a payload whose framed
    // packet (5-byte header + 60 bytes) cannot fit, so the write is rejected
    // and the segment lands in the pending queue — exactly what this test
    // wants to exercise.
    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "a".repeat(60));

    const backpressure = hostState.backpressureManagers[0];
    expect(backpressure.hasPendingSegments("t1")).toBe(true);

    vi.advanceTimersByTime(BACKPRESSURE_SAFETY_TIMEOUT_MS);
    await flushMicrotasks();

    const statusPayloads = terminalStatusPayloads(parentPort);
    expect(terminal.ptyProcess.pause).toHaveBeenCalledTimes(1);
    expect(statusPayloads.map((payload) => payload.status)).toEqual([
      "paused-backpressure",
      "suspended",
    ]);
    expect(statusPayloads.some((payload) => payload.status === "running")).toBe(false);
  });

  it("IPC_QUEUE_FULL_EMITS_DATA_LOSS_STATUS", async () => {
    const parentPort = await loadHost();
    const terminal = createTerminal("t1");
    hostState.terminals.set("t1", terminal);

    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });
    await flushMicrotasks();

    // Force the IPC fallback path to consider the queue full. No init-buffers
    // means the SAB write loop never runs, so visualWritten stays false and
    // the IPC fallback branch is the only data sink.
    const ipcQueue = hostState.ipcQueueManagers[0];
    ipcQueue.isAtCapacity.mockReturnValue(true);
    ipcQueue.getUtilization.mockReturnValue(100);
    parentPort.postMessage.mockClear();

    const payload = "a".repeat(123);
    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", payload);
    await flushMicrotasks();

    const statusPayloads = terminalStatusPayloads(parentPort);
    const dataLoss = statusPayloads.filter((p) => p.status === "data-loss");
    expect(dataLoss).toHaveLength(1);
    expect(dataLoss[0]).toMatchObject({
      type: "terminal-status",
      id: "t1",
      status: "data-loss",
      droppedBytes: payload.length,
    });

    // The reliability metric must still fire alongside the new status event —
    // existing telemetry consumers must keep working.
    const backpressure = hostState.backpressureManagers[0];
    expect(backpressure.emitReliabilityMetric).toHaveBeenCalledTimes(1);
    expect(backpressure.emitReliabilityMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalId: "t1",
        metricType: "suspend",
        bufferUtilization: 100,
      })
    );

    // Drop path returns early, so addBytes and the data event are never sent.
    expect(ipcQueue.addBytes).not.toHaveBeenCalled();
    const dataEvents = parentPort.postMessage.mock.calls
      .map((call: unknown[]) => call[0])
      .filter(
        (msg: unknown) =>
          typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "data"
      );
    expect(dataEvents).toHaveLength(0);
  });

  it("IPC_QUEUE_FULL_DROPPED_BYTES_USES_UTF8_BYTE_COUNT", async () => {
    // Multi-byte chars must report UTF-8 byte count, not JS string length.
    // Using payload.length here would silently mis-report drops for any
    // non-ASCII output (CJK terminals, emoji, accented characters).
    const parentPort = await loadHost();
    const terminal = createTerminal("t1");
    hostState.terminals.set("t1", terminal);

    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });
    await flushMicrotasks();

    const ipcQueue = hostState.ipcQueueManagers[0];
    ipcQueue.isAtCapacity.mockReturnValue(true);
    ipcQueue.getUtilization.mockReturnValue(100);
    parentPort.postMessage.mockClear();

    const payload = "⚠".repeat(10); // 10 chars, 30 UTF-8 bytes
    expect(payload.length).toBe(10);
    expect(Buffer.byteLength(payload, "utf8")).toBe(30);

    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", payload);
    await flushMicrotasks();

    const dataLoss = terminalStatusPayloads(parentPort).filter((p) => p.status === "data-loss");
    expect(dataLoss).toHaveLength(1);
    expect(dataLoss[0].droppedBytes).toBe(30);
  });

  it("IPC_QUEUE_FULL_BYPASSES_TERMINAL_STATUS_DEDUP", async () => {
    const parentPort = await loadHost();
    const terminal = createTerminal("t1");
    hostState.terminals.set("t1", terminal);

    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });
    await flushMicrotasks();

    const ipcQueue = hostState.ipcQueueManagers[0];
    ipcQueue.isAtCapacity.mockReturnValue(true);
    ipcQueue.getUtilization.mockReturnValue(100);
    parentPort.postMessage.mockClear();

    // Two consecutive drops on the same terminal must produce two distinct
    // data-loss events. BackpressureManager.emitTerminalStatus dedup would
    // collapse repeated identical statuses, so the drop site must call
    // sendEvent directly to bypass it.
    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "a".repeat(50));
    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "b".repeat(80));
    await flushMicrotasks();

    const dataLoss = terminalStatusPayloads(parentPort).filter((p) => p.status === "data-loss");
    expect(dataLoss).toHaveLength(2);
    expect(dataLoss[0].droppedBytes).toBe(50);
    expect(dataLoss[1].droppedBytes).toBe(80);
  });

  it("IPC_DATA_MIRROR_DELIVERS_BACKGROUND_TERMINAL_OUTPUT", async () => {
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1", "project-1"));

    parentPort.emit("message", { type: "spawn", id: "t1", options: { projectId: "project-1" } });
    parentPort.emit("message", { type: "set-ipc-data-mirror", id: "t1", enabled: true });
    parentPort.emit("message", { type: "set-activity-tier", id: "t1", tier: "background" });
    await flushMicrotasks();

    parentPort.postMessage.mockClear();
    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "http://localhost:4173\n");
    await flushMicrotasks();

    expect(dataPayloads(parentPort)).toEqual([
      expect.objectContaining({
        type: "data",
        id: "t1",
        data: "http://localhost:4173\n",
      }),
    ]);
  });

  it("LATE_ACK_AFTER_TIMEOUT_IS_IGNORED", async () => {
    const parentPort = await loadHost();
    const terminal = createTerminal("t1");
    hostState.terminals.set("t1", terminal);

    parentPort.emit("message", {
      type: "init-buffers",
      visualBuffers: [SharedRingBuffer.create(64)],
      visualSignalBuffer: new SharedArrayBuffer(4),
    });
    await flushMicrotasks();

    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "a".repeat(60));
    vi.advanceTimersByTime(BACKPRESSURE_SAFETY_TIMEOUT_MS);
    await flushMicrotasks();

    const resumeCallsBefore = terminal.ptyProcess.resume.mock.calls.length;
    const statusCountBefore = terminalStatusPayloads(parentPort).length;

    parentPort.emit("message", { type: "acknowledge-data", id: "t1", charCount: 60 });
    await flushMicrotasks();

    expect(terminal.ptyProcess.resume).toHaveBeenCalledTimes(resumeCallsBefore);
    expect(terminalStatusPayloads(parentPort)).toHaveLength(statusCountBefore);
  });

  it("FORCE_RESUME_CLEARS_STALLED_STATE", async () => {
    const parentPort = await loadHost();
    const terminal = createTerminal("t1");
    hostState.terminals.set("t1", terminal);

    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });
    await flushMicrotasks();

    const coordinator = hostState.coordinators[0];
    const backpressure = hostState.backpressureManagers[0];
    const ipcQueue = hostState.ipcQueueManagers[0];
    coordinator.pause("backpressure");
    backpressure.emitTerminalStatus("t1", "suspended", 100, 0);
    backpressure.setPauseStartTime("t1", Date.now() - 750);
    backpressure.setPausedInterval(
      "t1",
      setTimeout(() => undefined, 60_000)
    );
    backpressure.setSuspended("t1");
    backpressure.enqueuePendingSegment("t1", {
      data: new Uint8Array([1, 2, 3]),
      offset: 0,
    });
    ipcQueue.queuedBytes.set("t1", 42);
    parentPort.postMessage.mockClear();

    parentPort.emit("message", { type: "force-resume", id: "t1" });
    await flushMicrotasks();

    const runningPayloads = terminalStatusPayloads(parentPort).filter(
      (payload) => payload.status === "running"
    );
    expect(coordinator.forceReleaseAll).toHaveBeenCalledTimes(1);
    expect(ipcQueue.clearQueue).toHaveBeenCalledWith("t1");
    expect(backpressure.hasPendingSegments("t1")).toBe(false);
    expect(backpressure.isSuspended("t1")).toBe(false);
    expect(runningPayloads).toHaveLength(1);
    expect(runningPayloads[0].pauseDuration).toBe(750);
  });

  it("PORT_REPLACE_DROPS_STALE_ACKS", async () => {
    const parentPort = await loadHost();
    const portA = createRendererPort();
    const portB = createRendererPort();

    parentPort.emit("message", {
      data: { type: "connect-port", windowId: 1 },
      ports: [portA],
    });
    await flushMicrotasks();
    const oldQueueManager = hostState.portQueueManagers[0];
    const oldBatcher = hostState.batchers[0];

    parentPort.emit("message", {
      data: { type: "connect-port", windowId: 1 },
      ports: [portB],
    });
    await flushMicrotasks();
    const activeQueueManager = hostState.portQueueManagers[1];
    const activeRemoveBefore = activeQueueManager.removeBytes.mock.calls.length;

    portA.emit("message", { type: "ack", id: "t1", bytes: 5 });

    expect(oldBatcher.dispose).toHaveBeenCalledTimes(1);
    expect(oldQueueManager.resumeAll).toHaveBeenCalledTimes(1);
    expect(activeQueueManager.removeBytes).toHaveBeenCalledTimes(activeRemoveBefore);
  });

  it("EXPLICIT_DISCONNECT_PLUS_PORT_CLOSE_IS_IDEMPOTENT", async () => {
    const parentPort = await loadHost();
    const port = createRendererPort();

    parentPort.emit("message", {
      data: { type: "connect-port", windowId: 1 },
      ports: [port],
    });
    await flushMicrotasks();
    const queueManager = hostState.portQueueManagers[0];
    const batcher = hostState.batchers[0];

    parentPort.emit("message", { type: "disconnect-port", windowId: 1 });
    await flushMicrotasks();
    port.emit("close");

    expect(batcher.dispose).toHaveBeenCalledTimes(1);
    expect(queueManager.resumeAll).toHaveBeenCalledTimes(1);
    expect(queueManager.dispose).toHaveBeenCalledTimes(1);
    expect(port.close).toHaveBeenCalledTimes(1);
  });

  it("DISPOSE_RELEASES_RENDERER_PAUSE_HOLDS", async () => {
    const parentPort = await loadHost();
    const terminal = createTerminal("t1");
    hostState.terminals.set("t1", terminal);

    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });
    parentPort.emit("message", {
      data: { type: "connect-port", windowId: 1 },
      ports: [createRendererPort()],
    });
    await flushMicrotasks();

    const queueManager = hostState.portQueueManagers[0];
    queueManager.markPaused("t1");

    parentPort.emit("message", { type: "dispose" });
    await flushMicrotasks();

    expect(queueManager.events).toEqual(["resumeAll", "dispose"]);
    expect(terminal.ptyProcess.resume).toHaveBeenCalledTimes(1);
  });

  it("TIER_CHANGED_BROADCAST_RESPECTS_PROJECT_FILTER", async () => {
    // recomputeActivityTiers must push a tier-changed reconciliation message to
    // exactly the renderer ports that also receive the terminal's data — i.e.
    // the same per-window project filter as the data path. Otherwise the
    // renderer's dedupe baseline goes stale and output freezes (issue #9778).
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1", "project-1"));

    const portA = createRendererPort();
    const portB = createRendererPort();
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [portA] });
    parentPort.emit("message", { data: { type: "connect-port", windowId: 2 }, ports: [portB] });
    await flushMicrotasks();

    // Window 2 owns project-2 first so the later window-1 recompute is the one
    // under assertion; clear both ports of the intermediate broadcast.
    parentPort.emit("message", { type: "set-active-project", windowId: 2, projectId: "project-2" });
    await flushMicrotasks();
    portA.postMessage.mockClear();
    portB.postMessage.mockClear();

    // Window 1 activates project-1 (t1's project) → recompute → broadcast.
    parentPort.emit("message", { type: "set-active-project", windowId: 1, projectId: "project-1" });
    await flushMicrotasks();

    const tierA = portA.postMessage.mock.calls
      .map((c: unknown[]) => c[0])
      .filter(
        (m: unknown): m is { type: string } =>
          typeof m === "object" &&
          m !== null &&
          (m as Record<string, unknown>).type === "tier-changed"
      );
    const tierB = portB.postMessage.mock.calls
      .map((c: unknown[]) => c[0])
      .filter(
        (m: unknown): m is { type: string } =>
          typeof m === "object" &&
          m !== null &&
          (m as Record<string, unknown>).type === "tier-changed"
      );

    // Window 1 (project-1) is the consumer of t1 — it gets the reconciliation.
    expect(tierA).toContainEqual({ type: "tier-changed", id: "t1", tier: "active" });
    // Window 2 (project-2) is project-filtered away from t1 — nothing leaks to it.
    expect(
      tierB.some(
        (m: unknown) =>
          typeof m === "object" && m !== null && (m as Record<string, unknown>).id === "t1"
      )
    ).toBe(false);
  });

  it("UNDEFINED_PROJECT_TERMINAL_STAYS_ACTIVE_WHEN_PROJECTS_ACTIVE", async () => {
    // Aggravating #9778 detail: a terminal with no project association is
    // global/shared, not orphaned. It must stay active whenever any project is
    // active, while a terminal genuinely belonging to an inactive project is
    // correctly backgrounded.
    const parentPort = await loadHost();
    const backpressure = hostState.backpressureManagers[0];
    hostState.terminals.set("t-global", createTerminal("t-global")); // undefined projectId
    hostState.terminals.set("t-other", createTerminal("t-other", "project-2"));

    parentPort.emit("message", { type: "set-active-project", windowId: 1, projectId: "project-1" });
    await flushMicrotasks();

    expect(backpressure.getActivityTier("t-global")).toBe("active");
    expect(backpressure.getActivityTier("t-other")).toBe("background");
  });

  it("TIER_CHANGED_BROADCAST_TOLERATES_A_CLOSING_PORT", async () => {
    // A port that throws on postMessage (closing mid-iteration) must not block
    // the reconciliation from reaching the other still-open ports. Window 1 is
    // connected first, so it is iterated first and exercises the try/catch.
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1", "project-1"));

    const portThrowing = createRendererPort();
    const portHealthy = createRendererPort();
    parentPort.emit("message", {
      data: { type: "connect-port", windowId: 1 },
      ports: [portThrowing],
    });
    parentPort.emit("message", {
      data: { type: "connect-port", windowId: 2 },
      ports: [portHealthy],
    });
    await flushMicrotasks();

    // Both windows own t1's project, so both are broadcast targets.
    parentPort.emit("message", { type: "set-active-project", windowId: 1, projectId: "project-1" });
    parentPort.emit("message", { type: "set-active-project", windowId: 2, projectId: "project-1" });
    await flushMicrotasks();
    portThrowing.postMessage.mockClear();
    portHealthy.postMessage.mockClear();
    portThrowing.postMessage.mockImplementation(() => {
      throw new Error("port closing");
    });

    // Re-applying window 2's project triggers a fresh recompute + broadcast.
    expect(() =>
      parentPort.emit("message", {
        type: "set-active-project",
        windowId: 2,
        projectId: "project-1",
      })
    ).not.toThrow();
    await flushMicrotasks();

    const tierHealthy = portHealthy.postMessage.mock.calls
      .map((c: unknown[]) => c[0])
      .filter(
        (m: unknown): m is { type: string } =>
          typeof m === "object" &&
          m !== null &&
          (m as Record<string, unknown>).type === "tier-changed"
      );
    expect(tierHealthy).toContainEqual({ type: "tier-changed", id: "t1", tier: "active" });
  });

  it("RECOMPUTE_WITH_NO_RENDERER_CONNECTIONS_IS_SAFE", async () => {
    // With no connected ports the broadcast loop must no-op without throwing,
    // while tiers are still applied to the backpressure manager.
    const parentPort = await loadHost();
    const backpressure = hostState.backpressureManagers[0];
    hostState.terminals.set("t1", createTerminal("t1", "project-1"));

    expect(() =>
      parentPort.emit("message", {
        type: "set-active-project",
        windowId: 1,
        projectId: "project-1",
      })
    ).not.toThrow();
    await flushMicrotasks();

    expect(backpressure.getActivityTier("t1")).toBe("active");
  });

  // Truth table for recomputeActivityTiers' tier decision (#9800). The rule is
  // active ⇔ activeProjects.size === 0 OR terminal.projectId === undefined OR
  // activeProjects.has(terminal.projectId). Each cell seeds the OPPOSITE tier
  // first so a green assertion proves recompute actually wrote the tier rather
  // than reading back the "active" default — and the expected column is the
  // test author's independent prediction of behavior, not a copy of the source
  // constant. A regression in any branch of the rule flips exactly one cell.
  const TIER_MATRIX: ReadonlyArray<
    readonly [label: string, activeProjectId: string | null, termProjectId: string | undefined, expected: "active" | "background"]
  > = [
    ["no_active_project__global_terminal", null, undefined, "active"],
    ["no_active_project__owned_terminal", null, "project-1", "active"],
    ["no_active_project__foreign_terminal", null, "project-2", "active"],
    ["active_project__global_terminal_stays_active", "project-1", undefined, "active"],
    ["active_project__matching_terminal_active", "project-1", "project-1", "active"],
    ["active_project__foreign_terminal_backgrounded", "project-1", "project-2", "background"],
  ];

  it.each(TIER_MATRIX)(
    "TIER_MATRIX[%s]",
    async (_label, activeProjectId, termProjectId, expected) => {
      const parentPort = await loadHost();
      const backpressure = hostState.backpressureManagers[0];
      hostState.terminals.set("t1", createTerminal("t1", termProjectId));

      // Exactly one connected window, which also owns the active project, so the
      // recompute has a real broadcast target (rendererConnections.size = 1).
      parentPort.emit("message", {
        data: { type: "connect-port", windowId: 1 },
        ports: [createRendererPort()],
      });
      await flushMicrotasks();

      // Seed the opposite tier so the final assertion can only pass if recompute
      // performed a genuine write to this terminal's tier.
      backpressure.setActivityTier("t1", expected === "active" ? "background" : "active");

      // projectId:null is a real window with no active project — it contributes
      // nothing to the active-project union, giving the activeProjects.size === 0
      // rows while still driving a recompute (connect-port alone does not).
      parentPort.emit("message", {
        type: "set-active-project",
        windowId: 1,
        projectId: activeProjectId,
      });
      await flushMicrotasks();

      expect(backpressure.getActivityTier("t1")).toBe(expected);
    }
  );

  it("TIER_CHANGED_STREAM_IS_FIFO_ORDERED_ON_A_SINGLE_PORT", async () => {
    // The reconciliation push is posted on the SAME per-window MessagePort as
    // terminal data (pty-host.ts: `conn.port.postMessage` in recompute vs the
    // batcher's `receivedPort.postMessage` for data), so a tier-changed lands
    // FIFO-ordered ahead of any chunk gated by that tier. This test pins the
    // ordering guarantee for the tier stream itself: a viewer window that owns
    // no project (windowProject === null) receives every terminal's
    // reconciliation, and a sequence of host-driven transitions must arrive in
    // exactly the order they happened — no reordering, dropping, or collapsing.
    // If recompute ever moved the post behind an async/batched path, this
    // sequence would scramble and the renderer's dedupe baseline would desync
    // (the #9778 failure class).
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1", "project-1"));

    const viewer = createRendererPort();
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [viewer] });
    // Viewer owns no project → it is a consumer of every terminal's tier-changed.
    parentPort.emit("message", { type: "set-active-project", windowId: 1, projectId: null });
    await flushMicrotasks();
    viewer.postMessage.mockClear();

    // Window 2 (no port needed — it only contributes to the active-project union)
    // drives t1 through background → active → background.
    parentPort.emit("message", { type: "set-active-project", windowId: 2, projectId: "project-2" });
    await flushMicrotasks();
    parentPort.emit("message", { type: "set-active-project", windowId: 2, projectId: "project-1" });
    await flushMicrotasks();
    parentPort.emit("message", { type: "set-active-project", windowId: 2, projectId: "project-2" });
    await flushMicrotasks();

    const tierSequence = viewer.postMessage.mock.calls
      .map((c: unknown[]) => c[0])
      .filter(
        (m: unknown): m is { type: string; id: string; tier: string } =>
          typeof m === "object" &&
          m !== null &&
          (m as Record<string, unknown>).type === "tier-changed" &&
          (m as Record<string, unknown>).id === "t1"
      )
      .map((m) => m.tier);

    // Derived from the three transitions driven above — not copied from source.
    expect(tierSequence).toEqual(["background", "active", "background"]);
  });

  it("RACE_FUZZER_TIER_QUIESCENCE_INVARIANT", async () => {
    // Fuzz the interleaving of connect-port and set-active-project across
    // macrotasks. connect-port never triggers a recompute while set-active-project
    // always does, so the two orders exercise different paths; the invariant is
    // that after every interleaving settles, each terminal's tier reflects the
    // FINAL active-project union — order-independent quiescence. A regression
    // that recomputed off stale window state, or left a tier stranded when the
    // port arrived after the project switch, breaks this for some interleaving.
    const parentPort = await loadHost();
    const backpressure = hostState.backpressureManagers[0];
    hostState.terminals.set("t-a", createTerminal("t-a", "project-a"));
    hostState.terminals.set("t-b", createTerminal("t-b", "project-b"));

    const PROJECTS: Array<string | null> = ["project-a", "project-b", null];
    const ITERATIONS = 200;

    for (let i = 0; i < ITERATIONS; i++) {
      const windowId = (i % 4) + 1;
      const activeProject = PROJECTS[i % PROJECTS.length];
      const connectFirst = i % 2 === 0;
      const port = createRendererPort();

      const connectOp = () =>
        parentPort.emit("message", { data: { type: "connect-port", windowId }, ports: [port] });
      const projectOp = () =>
        parentPort.emit("message", {
          type: "set-active-project",
          windowId,
          projectId: activeProject,
        });

      // Schedule the two operations on separate macrotasks in an order that
      // flips each iteration, so connect-before-project and project-before-connect
      // both get exercised.
      setTimeout(connectFirst ? connectOp : projectOp, 0);
      setTimeout(connectFirst ? projectOp : connectOp, 0);
      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();

      // Quiescence invariant: an active project backgrounds only the terminals
      // that belong to a different project; a null active project (empty union)
      // leaves everything active.
      const expectA =
        activeProject === null || activeProject === "project-a" ? "active" : "background";
      const expectB =
        activeProject === null || activeProject === "project-b" ? "active" : "background";
      expect(backpressure.getActivityTier("t-a")).toBe(expectA);
      expect(backpressure.getActivityTier("t-b")).toBe(expectB);

      // Explicit disconnect forgets this window's project + connection, resetting
      // the union to empty before the next interleaving.
      parentPort.emit("message", { type: "disconnect-port", windowId });
      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
    }

    // With every window disconnected the union is empty → both terminals settle
    // back to active.
    expect(backpressure.getActivityTier("t-a")).toBe("active");
    expect(backpressure.getActivityTier("t-b")).toBe("active");
  });
});
