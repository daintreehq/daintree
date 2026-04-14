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

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, "parentPort");
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

describe("pty-host adversarial", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.useRealTimers();
  });

  afterAll(() => {
    process.setMaxListeners(originalMaxListeners);
  });

  it("SAB_ACK_TIMEOUT_SUSPENDS_STREAM", async () => {
    const parentPort = await loadHost();
    const terminal = createTerminal("t1");
    hostState.terminals.set("t1", terminal);

    parentPort.emit("message", {
      type: "init-buffers",
      visualBuffers: [SharedRingBuffer.create(8)],
      visualSignalBuffer: new SharedArrayBuffer(4),
    });
    await flushMicrotasks();

    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "abc");

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

  it("LATE_ACK_AFTER_TIMEOUT_IS_IGNORED", async () => {
    const parentPort = await loadHost();
    const terminal = createTerminal("t1");
    hostState.terminals.set("t1", terminal);

    parentPort.emit("message", {
      type: "init-buffers",
      visualBuffers: [SharedRingBuffer.create(8)],
      visualSignalBuffer: new SharedArrayBuffer(4),
    });
    await flushMicrotasks();

    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "abc");
    vi.advanceTimersByTime(BACKPRESSURE_SAFETY_TIMEOUT_MS);
    await flushMicrotasks();

    const resumeCallsBefore = terminal.ptyProcess.resume.mock.calls.length;
    const statusCountBefore = terminalStatusPayloads(parentPort).length;

    parentPort.emit("message", { type: "acknowledge-data", id: "t1", charCount: 3 });
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
});
