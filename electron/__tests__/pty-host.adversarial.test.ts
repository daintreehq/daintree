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
  deps: { emitReliabilityMetric?: (payload: Record<string, unknown>) => void } | undefined;
  clearQueue: TestMock;
  removeBytes: TestMock;
  tryResume: TestMock;
  isAtCapacity: TestMock;
  addBytes: TestMock;
  getUtilization: TestMock;
  applyBackpressure: TestMock;
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
  pendingSnapshot: Array<{ id: string; bytes: number }>;
  getPendingByteSnapshot: TestMock;
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
  resourceGovernorDeps: null as {
    getDropSnapshot: () => { droppedBytesDelta: number; dataLossCountDelta: number };
    getPausedDurationsSnapshot: () => Array<{ terminalId: string; heldDurationMs: number }>;
  } | null,
  reset() {
    this.currentParentPort = null;
    this.terminals.clear();
    this.currentPtyManager = null;
    this.resourceGovernorDeps = null;
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
    setAnalysisWorkerPool = vi.fn();
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
    getTerminalsForProject = vi.fn((projectId: string) =>
      Array.from(hostState.terminals.values())
        .filter((t) => t.projectId === projectId)
        .map((t) => t.id)
    );
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
    getAllProcesses = vi.fn(() => []);
    isTerminalTrashed = vi.fn(() => false);
    prunePreservedSnapshots = vi.fn();
    getTerminalRetention = vi.fn(() => null);
    getAllTerminalRetention = vi.fn(() => []);

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

    // Accessors the diagnostics (flow-control snapshot) handler reads.
    get terminalStatusesMap(): Map<string, string> {
      return this.terminalStatuses;
    }

    get suspendedSet(): Set<string> {
      return this.suspended;
    }

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
    applyBackpressure = vi.fn();
    dispose = vi.fn();
    getQueueSnapshot = vi.fn(() => ({ totalPendingBytes: 0, perTerminal: [] }));
    deps: { emitReliabilityMetric?: (payload: Record<string, unknown>) => void } | undefined;

    constructor(deps?: { emitReliabilityMetric?: (payload: Record<string, unknown>) => void }) {
      this.deps = deps;
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
        emitReliabilityMetric?: (payload: Record<string, unknown>) => void;
      }
    ) {
      this.pauseToken = deps.pauseToken ?? "port-queue";
      hostState.portQueueManagers.push(this);
    }

    removeBytes = vi.fn();
    tryResume = vi.fn();
    getQueueSnapshot = vi.fn(() => ({ totalPendingBytes: 0, perTerminal: [] }));
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
    getPausedTerminalIds = vi.fn(() => this.pausedIds.values());

    markPaused(id: string): void {
      this.pausedIds.add(id);
      this.deps.getPauseCoordinator(id)?.pause(this.pauseToken);
      // Mirror the real manager: a pause-start rides the reliability-metric
      // funnel, registering this window as a pause SOURCE in the host's
      // per-source tracking map (pausedTerminals closure in pty-host.ts).
      this.deps.emitReliabilityMetric?.({
        terminalId: id,
        metricType: "pause-start",
        timestamp: Date.now(),
      });
    }
  }

  class MockPortBatcher implements InspectablePortBatcher {
    dispose = vi.fn();
    flushTerminal = vi.fn();
    write = vi.fn(() => false);
    // Buffered-but-unflushed bytes, seeded by tests to simulate data batched
    // for a port that is about to close.
    pendingSnapshot: Array<{ id: string; bytes: number }> = [];
    getPendingByteSnapshot = vi.fn(() => this.pendingSnapshot);

    constructor() {
      hostState.batchers.push(this);
    }
  }

  class MockResourceGovernor {
    start = vi.fn();
    dispose = vi.fn();
    getSnapshot = vi.fn(() => ({
      isThrottling: false,
      isWarning: false,
      activeProfile: "balanced",
      smoothedUtilizationPercent: null,
      throttleDurationMs: 0,
    }));

    constructor(deps: {
      getDropSnapshot: () => { droppedBytesDelta: number; dataLossCountDelta: number };
      getPausedDurationsSnapshot: () => Array<{ terminalId: string; heldDurationMs: number }>;
    }) {
      hostState.resourceGovernorDeps = deps;
    }
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

import { BACKPRESSURE_SAFETY_TIMEOUT_MS, metricsEnabled } from "../pty-host/index.js";
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

function dataPayloads(
  parentPort: MockParentPort,
  type: "data" | "data-mirror" = "data"
): Array<Record<string, unknown>> {
  return parentPort.postMessage.mock.calls
    .map((call: unknown[]) => call[0])
    .filter(
      (payload: unknown): payload is Record<string, unknown> =>
        typeof payload === "object" &&
        payload !== null &&
        (payload as { type?: string }).type === type
    );
}

describe("pty-host adversarial", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getPtyPool).mockClear();
    // Restore the module-default (metrics off) so per-test overrides don't leak.
    vi.mocked(metricsEnabled).mockReturnValue(false);
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
    // Metrics on for the baseline case; the drop pulse itself passes
    // forceEmit so it would fire either way (see the gate-bypass test
    // below), and the data-loss status event is ungated regardless.
    vi.mocked(metricsEnabled).mockReturnValue(true);
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
    // existing telemetry consumers must keep working. The host funnel
    // (`emitReliabilityMetricWithTracking`) TERMINATES the chain by emitting
    // the wire event directly via sendEvent; it must NOT re-enter the manager
    // (which in prod is wired with its `emitReliabilityMetric` dep pointing
    // back at this same funnel — re-entering would recurse to a stack
    // overflow). So we assert on the actual wire event, not the manager
    // method, and confirm the manager was never re-invoked by the funnel.
    const reliabilityEvents = parentPort.postMessage.mock.calls
      .map((call: unknown[]) => call[0])
      .filter(
        (msg: unknown): msg is Record<string, unknown> =>
          typeof msg === "object" &&
          msg !== null &&
          (msg as { type?: string }).type === "terminal-reliability-metric"
      );
    expect(reliabilityEvents).toHaveLength(1);
    expect(reliabilityEvents[0]).toMatchObject({
      type: "terminal-reliability-metric",
      payload: {
        terminalId: "t1",
        metricType: "ipc-cap-drop",
        bufferUtilization: 100,
      },
    });
    // The funnel does NOT route back through the manager — that path is the
    // production recursion cycle and must stay broken.
    const backpressure = hostState.backpressureManagers[0];
    expect(backpressure.emitReliabilityMetric).not.toHaveBeenCalled();

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

  it("IPC_QUEUE_FULL_METRIC_BYPASSES_METRIC_GATE", async () => {
    // The drop pulse is a data-loss signal: it must reach the wire even
    // when metrics are gated off (forceEmit contract, #9902).
    vi.mocked(metricsEnabled).mockReturnValue(false);
    const parentPort = await loadHost();
    const terminal = createTerminal("t1");
    hostState.terminals.set("t1", terminal);

    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });
    await flushMicrotasks();

    const ipcQueue = hostState.ipcQueueManagers[0];
    ipcQueue.isAtCapacity.mockReturnValue(true);
    ipcQueue.getUtilization.mockReturnValue(100);
    parentPort.postMessage.mockClear();

    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "a".repeat(64));
    await flushMicrotasks();

    const reliabilityEvents = parentPort.postMessage.mock.calls
      .map((call: unknown[]) => call[0])
      .filter(
        (msg: unknown): msg is Record<string, unknown> =>
          typeof msg === "object" &&
          msg !== null &&
          (msg as { type?: string }).type === "terminal-reliability-metric"
      );
    expect(reliabilityEvents).toHaveLength(1);
    expect(reliabilityEvents[0]).toMatchObject({
      payload: { terminalId: "t1", metricType: "ipc-cap-drop" },
    });
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
    // EXPERIMENT (hibernation teardown): a terminal tagged "background" no longer
    // has its visual stream suppressed — the producer gate streams live. So the
    // chunk reaches the connected window's batcher (visualWritten=true), which in
    // turn re-enables the Main-process-only "data-mirror" copy DevPreview's
    // UrlDetector reads. The mirror never travels as a "data" event (that would
    // be re-broadcast into every renderer's xterm a second time).
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1", "project-1"));

    const port = createRendererPort();
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [port] });
    parentPort.emit("message", { type: "spawn", id: "t1", options: { projectId: "project-1" } });
    parentPort.emit("message", { type: "set-ipc-data-mirror", id: "t1", enabled: true });
    parentPort.emit("message", { type: "set-activity-tier", id: "t1", tier: "background" });
    await flushMicrotasks();

    // The lone window owns no project → it is a fan-out target; let its batcher
    // accept the chunk so the live visual path delivers it.
    const batcher = hostState.batchers[0];
    batcher.write.mockReturnValue(true);

    parentPort.postMessage.mockClear();
    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "http://localhost:4173\n");
    await flushMicrotasks();

    // The visual stream delivered live to the renderer port despite the
    // "background" tag — background no longer suppresses it.
    expect(batcher.write).toHaveBeenCalled();
    // Mirror copies travel as Main-process-only "data-mirror" events — a
    // plain "data" event here would be re-broadcast to every renderer view.
    expect(dataPayloads(parentPort)).toHaveLength(0);
    expect(dataPayloads(parentPort, "data-mirror")).toEqual([
      expect.objectContaining({
        type: "data-mirror",
        id: "t1",
        data: "http://localhost:4173\n",
      }),
    ]);
  });

  it("BACKGROUND_TRANSITION_DOES_NOT_CLEAR_QUEUE_HOLDS", async () => {
    // EXPERIMENT (hibernation teardown step 1): a background transition no longer
    // clears the port/IPC queues. The producer gate now streams unconditionally,
    // so a backgrounded pane keeps receiving live bytes and the renderer keeps
    // acking them — clearing the queues here would drop genuinely in-flight bytes
    // on the live path. (Previously the queues were cleared because the ingest
    // held chunks without acking while backgrounded; that hold is gone.)
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1", "project-1"));

    const port = createRendererPort();
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [port] });
    parentPort.emit("message", { type: "spawn", id: "t1", options: { projectId: "project-1" } });
    await flushMicrotasks();

    parentPort.emit("message", { type: "set-activity-tier", id: "t1", tier: "background" });
    await flushMicrotasks();

    expect(hostState.ipcQueueManagers[0].clearQueue).not.toHaveBeenCalled();
    expect(hostState.portQueueManagers[0].clearQueue).not.toHaveBeenCalled();
  });

  it("ACTIVE_TRANSITION_DOES_NOT_CLEAR_QUEUE_HOLDS", async () => {
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1", "project-1"));

    const port = createRendererPort();
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [port] });
    parentPort.emit("message", { type: "spawn", id: "t1", options: { projectId: "project-1" } });
    await flushMicrotasks();

    parentPort.emit("message", { type: "set-activity-tier", id: "t1", tier: "active" });
    await flushMicrotasks();

    expect(hostState.ipcQueueManagers[0].clearQueue).not.toHaveBeenCalled();
    expect(hostState.portQueueManagers[0].clearQueue).not.toHaveBeenCalled();
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

    parentPort.emit("message", { type: "acknowledge-data", id: "t1", byteCount: 60 });
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
    // The held duration now rides on the wire `pause-end` reliability metric
    // (issue #9898: the source-of-truth for held duration moved from the
    // SAB-only `backpressureManager.getPauseStartTime()` map to the
    // multi-source closure `pausedTerminals` map maintained by
    // `emitReliabilityMetricWithTracking`). The running status no longer
    // carries `pauseDuration` — the renderer reads the metric, not the status.
    expect(runningPayloads[0].pauseDuration).toBeUndefined();
    // The held duration now rides on the wire `pause-end` reliability metric
    // (issue #9898: the source-of-truth moved from the SAB-only
    // `backpressureManager.getPauseStartTime()` map to the multi-source
    // closure `pausedTerminals` map maintained by
    // `emitReliabilityMetricWithTracking`). The manager's `emitReliabilityMetric`
    // is the funnel entry point in production — assert it was called with a
    // `pause-end` metric (the dep then populates `durationMs` and emits to the
    // wire, which is tested in isolation at the funnel boundary).
    expect(backpressure.emitReliabilityMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalId: "t1",
        metricType: "pause-end",
      })
    );
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

  it("RECOMPUTE_ONLY_TOUCHES_THE_NEWLY_FOREGROUND_PROJECT (#10857)", async () => {
    // recomputeActivityTiers is scoped to the project that just became
    // foreground for some window — it must NOT force-activate a global/shared
    // terminal (undefined projectId) or a terminal belonging to a different
    // project. Those terminals are owned exclusively by the renderer's own
    // "set-activity-tier" IPC and must be left exactly as they were; bouncing
    // them to "active" on every unrelated project switch is the #10857 bug.
    const parentPort = await loadHost();
    const backpressure = hostState.backpressureManagers[0];
    hostState.terminals.set("t-global", createTerminal("t-global")); // undefined projectId
    hostState.terminals.set("t-other", createTerminal("t-other", "project-2"));

    // Seed "background" so a green assertion proves recompute genuinely left
    // these terminals alone rather than reading back a coincidental default.
    backpressure.setActivityTier("t-global", "background");
    backpressure.setActivityTier("t-other", "background");

    parentPort.emit("message", { type: "set-active-project", windowId: 1, projectId: "project-1" });
    await flushMicrotasks();

    expect(backpressure.getActivityTier("t-global")).toBe("background");
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

  // recomputeActivityTiers (#10857) is scoped to exactly the project that just
  // became foreground (`nextProjectId`) — it force-activates terminals in that
  // project and leaves every other terminal untouched, including a global/
  // shared terminal (undefined projectId) and a "no active project" event
  // (`null`, a pure no-op). Each row covers a distinct project relationship and
  // seeds "background" first, so a green assertion proves recompute either
  // performed a genuine write to "active" (matching row) or genuinely left the
  // terminal alone (every other row) — not a coincidental default.
  const TIER_MATRIX: ReadonlyArray<
    readonly [
      label: string,
      activeProjectId: string | null,
      termProjectId: string | undefined,
      expectedTier: "active" | "background",
    ]
  > = [
    ["no_active_project__global_terminal", null, undefined, "background"],
    ["no_active_project__owned_terminal", null, "project-1", "background"],
    ["active_project__global_terminal", "project-1", undefined, "background"],
    ["active_project__matching_terminal", "project-1", "project-1", "active"],
    ["active_project__foreign_terminal", "project-1", "project-2", "background"],
  ];

  it.each(TIER_MATRIX)(
    "TIER_MATRIX[%s]",
    async (_label, activeProjectId, termProjectId, expectedTier) => {
      const parentPort = await loadHost();
      const backpressure = hostState.backpressureManagers[0];
      hostState.terminals.set("t1", createTerminal("t1", termProjectId));

      // Exactly one connected window so the recompute has a real broadcast target
      // (rendererConnections.size = 1).
      parentPort.emit("message", {
        data: { type: "connect-port", windowId: 1 },
        ports: [createRendererPort()],
      });
      await flushMicrotasks();

      // Seed "background" so the final assertion can only pass if recompute
      // performed the row's expected (write-or-leave-alone) behavior.
      backpressure.setActivityTier("t1", "background");

      parentPort.emit("message", {
        type: "set-active-project",
        windowId: 1,
        projectId: activeProjectId,
      });
      await flushMicrotasks();

      expect(backpressure.getActivityTier("t1")).toBe(expectedTier);

      // The ActivityMonitor polling cadence is only pinned to 50ms when the
      // terminal was genuinely in scope for this recompute.
      const ptyManager = hostState.currentPtyManager as MiniEmitter & {
        setActivityMonitorTier: TestMock;
      };
      if (expectedTier === "active") {
        expect(ptyManager.setActivityMonitorTier).toHaveBeenCalledWith("t1", "active", 50);
      } else {
        expect(ptyManager.setActivityMonitorTier).not.toHaveBeenCalledWith(
          "t1",
          "active",
          expect.anything()
        );
      }
    }
  );

  it("TIER_CHANGED_STREAM_IS_FIFO_ORDERED_ON_A_SINGLE_PORT", async () => {
    // The reconciliation push is posted on the SAME per-window MessagePort as
    // terminal data (pty-host.ts: `conn.port.postMessage` in recompute vs the
    // batcher's `receivedPort.postMessage` for data), so a tier-changed lands
    // FIFO-ordered ahead of any chunk on that port. This test pins the ordering
    // guarantee for the tier stream itself: a viewer window that owns no project
    // (windowProject === null) receives a reconciliation for t1 only on a
    // recompute that is actually scoped to t1's project (#10857) — a switch to
    // an unrelated project must produce NO reconciliation for t1 at all, and the
    // ones that do fire must arrive in exactly the order they happened, none
    // dropped, reordered, or collapsed. If recompute ever moved the post behind
    // an async/batched path, or scoped incorrectly, the stream would scramble
    // and the renderer's dedupe baseline would desync (the #9778 failure class).
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1", "project-1"));

    const viewer = createRendererPort();
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [viewer] });
    // Viewer owns no project → it is a consumer of t1's tier-changed whenever
    // t1's project is actually recomputed.
    parentPort.emit("message", { type: "set-active-project", windowId: 1, projectId: null });
    await flushMicrotasks();
    viewer.postMessage.mockClear();

    // Window 2 (no port needed — it only drives recomputes) switches between
    // t1's project and an unrelated one, twice each: only the project-1
    // switches are in scope for t1 and should produce a reconciliation; the
    // project-2 switches must be silent for t1.
    parentPort.emit("message", { type: "set-active-project", windowId: 2, projectId: "project-1" });
    await flushMicrotasks();
    parentPort.emit("message", { type: "set-active-project", windowId: 2, projectId: "project-2" });
    await flushMicrotasks();
    parentPort.emit("message", { type: "set-active-project", windowId: 2, projectId: "project-1" });
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

    // Only the two project-1 (in-scope) switches reconcile t1 — the project-2
    // switch in between is correctly silent, none dropped, reordered, or
    // collapsed.
    expect(tierSequence).toEqual(["active", "active"]);
  });

  it("MULTI_WINDOW_CONNECT_DISCONNECT_SCOPES_ACTIVATION_TO_OWN_PROJECT (#10857)", async () => {
    // recomputeActivityTiers is scoped per-event to the project that just
    // became foreground. Two windows owning two different projects each
    // activate only their own project's terminal — the third-project terminal
    // (t-c), which no connected window owns, is never touched and stays at
    // whatever tier it already had. Disconnecting a window passes `null`
    // (a no-op, per the hard "never demote" constraint), so it never
    // re-backgrounds anything either.
    const parentPort = await loadHost();
    const backpressure = hostState.backpressureManagers[0];
    hostState.terminals.set("t-a", createTerminal("t-a", "project-a"));
    hostState.terminals.set("t-b", createTerminal("t-b", "project-b"));
    hostState.terminals.set("t-c", createTerminal("t-c", "project-c"));

    // Seed "background" so green assertions prove a genuine recompute write
    // (t-a, t-b) vs a genuine leave-alone (t-c).
    backpressure.setActivityTier("t-a", "background");
    backpressure.setActivityTier("t-b", "background");
    backpressure.setActivityTier("t-c", "background");

    parentPort.emit("message", {
      data: { type: "connect-port", windowId: 1 },
      ports: [createRendererPort()],
    });
    parentPort.emit("message", {
      data: { type: "connect-port", windowId: 2 },
      ports: [createRendererPort()],
    });
    parentPort.emit("message", { type: "set-active-project", windowId: 1, projectId: "project-a" });
    parentPort.emit("message", { type: "set-active-project", windowId: 2, projectId: "project-b" });
    await flushMicrotasks();

    // Only the two owned terminals activate — the unowned third project (t-c)
    // is left untouched.
    expect(backpressure.getActivityTier("t-a")).toBe("active");
    expect(backpressure.getActivityTier("t-b")).toBe("active");
    expect(backpressure.getActivityTier("t-c")).toBe("background");

    // Drop window 1 → recompute re-runs scoped to `null`, a no-op; nothing
    // changes for any terminal.
    parentPort.emit("message", { type: "disconnect-port", windowId: 1 });
    await flushMicrotasks();

    expect(backpressure.getActivityTier("t-a")).toBe("active");
    expect(backpressure.getActivityTier("t-b")).toBe("active");
    expect(backpressure.getActivityTier("t-c")).toBe("background");
  });

  it("RACE_FUZZER_TIER_QUIESCENCE_INVARIANT", async () => {
    // Fuzz the interleaving of connect-port and set-active-project across
    // macrotasks. connect-port never triggers a recompute while set-active-project
    // always does, so the two orders exercise different paths. Each iteration
    // drives a single window (set, assert, disconnect). recomputeActivityTiers
    // (#10857) is scoped to exactly the project that just became foreground: the
    // quiescence invariant is order-independent (connect-before-project and
    // project-before-connect settle to the same state) but project-DEPENDENT —
    // only the terminal matching the iteration's active project (if any) ends up
    // "active"; the other terminal is left at its seeded "background" tier. A
    // regression that resurrected the old global force-active (or scoped to the
    // wrong project) breaks this for some interleaving.
    const parentPort = await loadHost();
    const backpressure = hostState.backpressureManagers[0];
    hostState.terminals.set("t-a", createTerminal("t-a", "project-a"));
    hostState.terminals.set("t-b", createTerminal("t-b", "project-b"));

    const PROJECTS: Array<string | null> = ["project-a", "project-b", null];
    const ITERATIONS = 200;
    let lastActiveProject: string | null = null;

    for (let i = 0; i < ITERATIONS; i++) {
      const windowId = (i % 4) + 1;
      const activeProject = PROJECTS[i % PROJECTS.length];
      lastActiveProject = activeProject;
      const connectFirst = i % 2 === 0;
      const port = createRendererPort();

      // Seed "background" each iteration so a green assertion proves the
      // recompute genuinely wrote (matching terminal) or genuinely left alone
      // (non-matching terminal) rather than reading back a stale value.
      backpressure.setActivityTier("t-a", "background");
      backpressure.setActivityTier("t-b", "background");

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

      // Quiescence invariant: only the terminal matching this iteration's active
      // project (if any) is "active"; the other stays at its seeded tier.
      expect(backpressure.getActivityTier("t-a")).toBe(
        activeProject === "project-a" ? "active" : "background"
      );
      expect(backpressure.getActivityTier("t-b")).toBe(
        activeProject === "project-b" ? "active" : "background"
      );

      // Explicit disconnect forgets this window's project + connection before the
      // next interleaving.
      parentPort.emit("message", { type: "disconnect-port", windowId });
      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
    }

    // With every window disconnected, the tiers reflect only the last
    // iteration's recompute — disconnect itself never changes anything.
    expect(backpressure.getActivityTier("t-a")).toBe(
      lastActiveProject === "project-a" ? "active" : "background"
    );
    expect(backpressure.getActivityTier("t-b")).toBe(
      lastActiveProject === "project-b" ? "active" : "background"
    );
  });

  // Helper: terminal-status messages posted directly on a renderer MessagePort.
  function portStatusMessages(port: MockRendererPort): Array<Record<string, unknown>> {
    return port.postMessage.mock.calls
      .map((c: unknown[]) => c[0])
      .filter(
        (m: unknown): m is Record<string, unknown> =>
          typeof m === "object" && m !== null && (m as { type?: string }).type === "terminal-status"
      );
  }

  it("FAN_OUT_SATURATED_WINDOW_GETS_DATA_LOSS_PULSE", async () => {
    // The #9891 core: with two windows fanning out the same terminal, one
    // window's batcher accepts the chunk (visualWritten flips true, suppressing
    // the shared IPC fallback) while the other's is saturated. The starved
    // window must receive a per-port data-loss pulse — not a broadcast, which
    // would falsely flag the window that received its data — and the global
    // drop counter must account exactly the dropped chunk.
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1"));

    const portA = createRendererPort();
    const portB = createRendererPort();
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [portA] });
    parentPort.emit("message", { data: { type: "connect-port", windowId: 2 }, ports: [portB] });
    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });
    await flushMicrotasks();

    // No active project on either window → windowProjectMap empty → both windows
    // are fan-out targets. batchers are created per connect-port in order.
    const batcherA = hostState.batchers[0];
    const batcherB = hostState.batchers[1];
    batcherA.write.mockReturnValue(true); // window A accepts
    batcherB.write.mockReturnValue(false); // window B saturated

    portA.postMessage.mockClear();
    portB.postMessage.mockClear();
    parentPort.postMessage.mockClear();

    const payload = "a".repeat(40);
    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", payload);
    await flushMicrotasks();

    // Starved window B gets exactly one data-loss pulse on its own port.
    const statusB = portStatusMessages(portB);
    expect(statusB).toHaveLength(1);
    expect(statusB[0]).toMatchObject({
      type: "terminal-status",
      id: "t1",
      status: "data-loss",
      droppedBytes: payload.length,
    });
    expect(typeof statusB[0].timestamp).toBe("number");

    // Window A received its data on its own port — it must NOT be told of a loss.
    expect(portStatusMessages(portA)).toHaveLength(0);

    // The IPC broadcast path must NOT emit a data-loss for this chunk — that
    // would falsely reach window A (and every other window).
    const ipcDataLoss = terminalStatusPayloads(parentPort).filter((p) => p.status === "data-loss");
    expect(ipcDataLoss).toHaveLength(0);

    // The global drop counter accounts exactly the starved window's chunk once.
    const drops = hostState.resourceGovernorDeps?.getDropSnapshot();
    expect(drops).toEqual({ droppedBytesDelta: payload.length, dataLossCountDelta: 1 });
  });

  it("FAN_OUT_DATA_LOSS_USES_UTF8_BYTE_COUNT", async () => {
    // The dropped-byte accounting must report UTF-8 bytes, not JS string length,
    // or non-ASCII output (CJK, emoji) silently mis-reports the gap size.
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1"));

    const portA = createRendererPort();
    const portB = createRendererPort();
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [portA] });
    parentPort.emit("message", { data: { type: "connect-port", windowId: 2 }, ports: [portB] });
    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });
    await flushMicrotasks();

    hostState.batchers[0].write.mockReturnValue(true);
    hostState.batchers[1].write.mockReturnValue(false);
    portB.postMessage.mockClear();

    const payload = "⚠".repeat(10); // 10 chars, 30 UTF-8 bytes
    expect(payload.length).toBe(10);
    expect(Buffer.byteLength(payload, "utf8")).toBe(30);

    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", payload);
    await flushMicrotasks();

    const statusB = portStatusMessages(portB);
    expect(statusB).toHaveLength(1);
    expect(statusB[0].droppedBytes).toBe(30);
    expect(hostState.resourceGovernorDeps?.getDropSnapshot()).toEqual({
      droppedBytesDelta: 30,
      dataLossCountDelta: 1,
    });
  });

  it("FAN_OUT_ALL_SATURATED_FALLS_THROUGH_TO_IPC_WITHOUT_PULSE", async () => {
    // When EVERY window's batcher rejects, visualWritten stays false and the
    // shared IPC fallback broadcasts the chunk to all windows (the renderer's
    // onData listens on both the port and IPC). Nothing is lost, so no per-port
    // data-loss pulse must fire — the regression would double-signal a loss that
    // didn't happen.
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1"));

    const portA = createRendererPort();
    const portB = createRendererPort();
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [portA] });
    parentPort.emit("message", { data: { type: "connect-port", windowId: 2 }, ports: [portB] });
    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });
    await flushMicrotasks();

    // Both batchers reject (mock default is false) — leave them as-is.
    portA.postMessage.mockClear();
    portB.postMessage.mockClear();
    parentPort.postMessage.mockClear();

    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "a".repeat(25));
    await flushMicrotasks();

    // IPC fallback delivered the chunk (queue not at capacity by default).
    expect(dataPayloads(parentPort)).toHaveLength(1);
    // No window was starved, so no data-loss pulse on either port and no drop.
    expect(portStatusMessages(portA)).toHaveLength(0);
    expect(portStatusMessages(portB)).toHaveLength(0);
    expect(hostState.resourceGovernorDeps?.getDropSnapshot()).toEqual({
      droppedBytesDelta: 0,
      dataLossCountDelta: 0,
    });
  });

  it("FAN_OUT_SATURATED_PORT_THROWS_ON_STATUS_POSTMESSAGE", async () => {
    // A starved window whose port throws on postMessage (closing mid-iteration)
    // must not break the fan-out: the accepting window keeps its data and the
    // drop is still accounted. Mirrors the tier-changed closing-port tolerance.
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1"));

    const portA = createRendererPort();
    const portThrowing = createRendererPort();
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [portA] });
    parentPort.emit("message", {
      data: { type: "connect-port", windowId: 2 },
      ports: [portThrowing],
    });
    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });
    await flushMicrotasks();

    hostState.batchers[0].write.mockReturnValue(true);
    hostState.batchers[1].write.mockReturnValue(false);
    portThrowing.postMessage.mockImplementation(() => {
      throw new Error("port closing");
    });

    expect(() =>
      (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "a".repeat(15))
    ).not.toThrow();
    await flushMicrotasks();

    // The drop is still accounted even though the pulse delivery threw.
    expect(hostState.resourceGovernorDeps?.getDropSnapshot()).toEqual({
      droppedBytesDelta: 15,
      dataLossCountDelta: 1,
    });
  });

  it("FAN_OUT_THREE_WINDOWS_TWO_SATURATED_EACH_GET_A_PULSE", async () => {
    // With three windows fanning out, one accepting and two saturated, BOTH
    // starved windows must each get exactly one pulse — a regression that only
    // pulsed the first saturated connection would silently strand the rest.
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1"));

    const portA = createRendererPort();
    const portB = createRendererPort();
    const portC = createRendererPort();
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [portA] });
    parentPort.emit("message", { data: { type: "connect-port", windowId: 2 }, ports: [portB] });
    parentPort.emit("message", { data: { type: "connect-port", windowId: 3 }, ports: [portC] });
    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });
    await flushMicrotasks();

    hostState.batchers[0].write.mockReturnValue(true); // A accepts
    hostState.batchers[1].write.mockReturnValue(false); // B saturated
    hostState.batchers[2].write.mockReturnValue(false); // C saturated
    portA.postMessage.mockClear();
    portB.postMessage.mockClear();
    portC.postMessage.mockClear();

    const payload = "a".repeat(20);
    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", payload);
    await flushMicrotasks();

    expect(portStatusMessages(portA)).toHaveLength(0);
    expect(portStatusMessages(portB)).toHaveLength(1);
    expect(portStatusMessages(portC)).toHaveLength(1);
    expect(hostState.resourceGovernorDeps?.getDropSnapshot()).toEqual({
      droppedBytesDelta: payload.length * 2,
      dataLossCountDelta: 2,
    });
  });

  it("FAN_OUT_SATURATED_BEFORE_ACCEPTED_STILL_PULSES", async () => {
    // The pulse decision is post-loop, so it must not depend on whether the
    // saturated window is iterated before or after the accepting one. Here the
    // first-connected window is saturated and the second accepts.
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1"));

    const portSaturated = createRendererPort();
    const portAccepting = createRendererPort();
    parentPort.emit("message", {
      data: { type: "connect-port", windowId: 1 },
      ports: [portSaturated],
    });
    parentPort.emit("message", {
      data: { type: "connect-port", windowId: 2 },
      ports: [portAccepting],
    });
    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });
    await flushMicrotasks();

    hostState.batchers[0].write.mockReturnValue(false); // first window saturated
    hostState.batchers[1].write.mockReturnValue(true); // second window accepts
    portSaturated.postMessage.mockClear();
    portAccepting.postMessage.mockClear();

    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "a".repeat(12));
    await flushMicrotasks();

    expect(portStatusMessages(portSaturated)).toHaveLength(1);
    expect(portStatusMessages(portAccepting)).toHaveLength(0);
    expect(hostState.resourceGovernorDeps?.getDropSnapshot()).toEqual({
      droppedBytesDelta: 12,
      dataLossCountDelta: 1,
    });
  });

  it("FAN_OUT_IPC_MIRRORED_TERMINAL_GETS_PULSE", async () => {
    // The IPC data mirror is Main-process-only ("data-mirror" is never
    // re-broadcast to renderers), so a saturated window genuinely loses the
    // chunk and must get the same per-port data-loss pulse as any terminal.
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1"));

    const portA = createRendererPort();
    const portB = createRendererPort();
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [portA] });
    parentPort.emit("message", { data: { type: "connect-port", windowId: 2 }, ports: [portB] });
    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });
    parentPort.emit("message", { type: "set-ipc-data-mirror", id: "t1", enabled: true });
    await flushMicrotasks();

    hostState.batchers[0].write.mockReturnValue(true);
    hostState.batchers[1].write.mockReturnValue(false);
    portA.postMessage.mockClear();
    portB.postMessage.mockClear();
    parentPort.postMessage.mockClear();

    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "a".repeat(18));
    await flushMicrotasks();

    // The starved window gets its pulse and the drop is accounted.
    expect(portStatusMessages(portB)).toHaveLength(1);
    expect(hostState.resourceGovernorDeps?.getDropSnapshot()).toEqual({
      droppedBytesDelta: 18,
      dataLossCountDelta: 1,
    });
    // The Main-side mirror still fired, but no renderer-bound "data" event did.
    expect(dataPayloads(parentPort, "data-mirror")).toHaveLength(1);
    expect(dataPayloads(parentPort)).toHaveLength(0);
  });

  it("FAN_OUT_PULSE_RESPECTS_PROJECT_FILTER", async () => {
    // Only windows that own (or globally view) the terminal's project are fan-out
    // targets, so only a saturated TARGET window may get a pulse — a project-
    // filtered window is never a target and must never be pulsed.
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1", "project-1"));

    const portOwner = createRendererPort(); // window 1 → project-1 (target, saturated)
    const portViewer = createRendererPort(); // window 2 → project-1 (target, accepts)
    const portForeign = createRendererPort(); // window 3 → project-2 (filtered out)
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [portOwner] });
    parentPort.emit("message", {
      data: { type: "connect-port", windowId: 2 },
      ports: [portViewer],
    });
    parentPort.emit("message", {
      data: { type: "connect-port", windowId: 3 },
      ports: [portForeign],
    });
    parentPort.emit("message", { type: "set-active-project", windowId: 1, projectId: "project-1" });
    parentPort.emit("message", { type: "set-active-project", windowId: 2, projectId: "project-1" });
    parentPort.emit("message", { type: "set-active-project", windowId: 3, projectId: "project-2" });
    parentPort.emit("message", { type: "spawn", id: "t1", options: { projectId: "project-1" } });
    await flushMicrotasks();

    // batchers[0]=window1 (owner), [1]=window2 (viewer), [2]=window3 (foreign).
    hostState.batchers[0].write.mockReturnValue(false); // owner saturated
    hostState.batchers[1].write.mockReturnValue(true); // viewer accepts
    portOwner.postMessage.mockClear();
    portViewer.postMessage.mockClear();
    portForeign.postMessage.mockClear();

    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "a".repeat(22));
    await flushMicrotasks();

    expect(portStatusMessages(portOwner)).toHaveLength(1); // saturated target → pulse
    expect(portStatusMessages(portViewer)).toHaveLength(0); // accepted → no pulse
    expect(portStatusMessages(portForeign)).toHaveLength(0); // filtered out → never a target
    expect(hostState.resourceGovernorDeps?.getDropSnapshot()).toEqual({
      droppedBytesDelta: 22,
      dataLossCountDelta: 1,
    });
  });

  // Helper: flow-control snapshots sent to Main (diagnostics pull).
  function flowControlSnapshots(parentPort: MockParentPort): Array<Record<string, unknown>> {
    return parentPort.postMessage.mock.calls
      .map((c: unknown[]) => c[0])
      .filter(
        (m: unknown): m is Record<string, unknown> =>
          typeof m === "object" &&
          m !== null &&
          (m as { type?: string }).type === "flow-control-snapshot"
      );
  }

  it("DISCONNECT_ACCOUNTS_BATCHER_PENDING_AS_DROPPED", async () => {
    // Bytes batched for a closing port die with it — dispose() discards them
    // silently, so disconnectWindow must account them as data loss first.
    // Before this accounting, a port-replace mid-flood erased up to a full
    // batch window per terminal from the drop ledger.
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1"));

    const port = createRendererPort();
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [port] });
    await flushMicrotasks();

    const batcher = hostState.batchers[0];
    batcher.pendingSnapshot = [
      { id: "t1", bytes: 120 },
      { id: "t2", bytes: 40 },
    ];

    parentPort.emit("message", { type: "disconnect-port", windowId: 1 });
    await flushMicrotasks();

    expect(batcher.dispose).toHaveBeenCalledTimes(1);
    expect(hostState.resourceGovernorDeps?.getDropSnapshot()).toEqual({
      droppedBytesDelta: 160,
      dataLossCountDelta: 2,
    });
  });

  it("DISCONNECT_CLEARS_WINDOW_PAUSE_SOURCE_TRACKING", async () => {
    // The pre-fix ordering called resumeAll() (which clears the manager's
    // pause map) BEFORE iterating getPausedTerminalIds() — a live iterator
    // over that same map — so the removePauseSource loop visited nothing and
    // the window's pause-source entries leaked: the pause-duration gauge kept
    // reporting heldDurationMs for a window that no longer existed.
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1"));
    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });

    const port = createRendererPort();
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [port] });
    await flushMicrotasks();

    // Window 1's port queue pauses t1 — the pause-start rides the funnel and
    // registers source "port-1" in the host's tracking map.
    hostState.portQueueManagers[0].markPaused("t1");
    expect(hostState.resourceGovernorDeps?.getPausedDurationsSnapshot()).toEqual([
      expect.objectContaining({ terminalId: "t1" }),
    ]);

    parentPort.emit("message", { type: "disconnect-port", windowId: 1 });
    await flushMicrotasks();

    expect(hostState.resourceGovernorDeps?.getPausedDurationsSnapshot()).toEqual([]);
  });

  it("DISCONNECT_PRESERVES_OTHER_SOURCE_PAUSE_TRACKING", async () => {
    // Multi-source attribution: a terminal paused by BOTH this window's port
    // queue AND the IPC queue must keep its held-duration tracking when just
    // the window disconnects — only the "port-1" source is removed.
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1"));
    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });

    const port = createRendererPort();
    parentPort.emit("message", { data: { type: "connect-port", windowId: 1 }, ports: [port] });
    await flushMicrotasks();

    hostState.portQueueManagers[0].markPaused("t1");
    // The IPC queue also pauses t1 (source "ipc" via its own funnel wiring).
    hostState.ipcQueueManagers[0].deps?.emitReliabilityMetric?.({
      terminalId: "t1",
      metricType: "pause-start",
      timestamp: Date.now(),
    });

    parentPort.emit("message", { type: "disconnect-port", windowId: 1 });
    await flushMicrotasks();

    // The IPC hold keeps t1 in the tracking map after the window is gone.
    expect(hostState.resourceGovernorDeps?.getPausedDurationsSnapshot()).toEqual([
      expect.objectContaining({ terminalId: "t1" }),
    ]);
  });

  it("FLOW_SNAPSHOT_REPORTS_PER_TERMINAL_DROP_TALLY", async () => {
    // Two IPC-cap drops on the same terminal must surface as a cumulative
    // per-terminal tally in the flow-control snapshot — the streaming
    // data-loss gauge only carries process-wide deltas, so without the tally
    // a support bundle can't tell WHOSE scrollback has the gap.
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1"));
    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });
    await flushMicrotasks();

    const ipcQueue = hostState.ipcQueueManagers[0];
    ipcQueue.isAtCapacity.mockReturnValue(true);
    ipcQueue.getUtilization.mockReturnValue(100);

    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "a".repeat(50));
    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "b".repeat(30));
    await flushMicrotasks();

    parentPort.postMessage.mockClear();
    parentPort.emit("message", { type: "get-flow-control-snapshot", requestId: "req-drop" });
    await flushMicrotasks();

    const snapshots = flowControlSnapshots(parentPort);
    expect(snapshots).toHaveLength(1);
    const terminals = (snapshots[0].snapshot as { terminals: Array<Record<string, unknown>> })
      .terminals;
    const t1 = terminals.find((t) => t.terminalId === "t1");
    expect(t1).toMatchObject({ droppedBytes: 80, dropCount: 2 });
    expect(typeof t1?.lastDropAt).toBe("number");
  });

  it("EXIT_CLEARS_DROP_TALLY", async () => {
    // The tally entry dies with the terminal so the bounded map can't grow
    // across long sessions and the snapshot only reports live terminals.
    const parentPort = await loadHost();
    hostState.terminals.set("t1", createTerminal("t1"));
    parentPort.emit("message", { type: "spawn", id: "t1", options: {} });
    await flushMicrotasks();

    const ipcQueue = hostState.ipcQueueManagers[0];
    ipcQueue.isAtCapacity.mockReturnValue(true);
    ipcQueue.getUtilization.mockReturnValue(100);
    (hostState.currentPtyManager as MiniEmitter).emit("data", "t1", "a".repeat(50));
    await flushMicrotasks();

    (hostState.currentPtyManager as MiniEmitter).emit("exit", "t1", 0);
    await flushMicrotasks();

    parentPort.postMessage.mockClear();
    parentPort.emit("message", { type: "get-flow-control-snapshot", requestId: "req-exit" });
    await flushMicrotasks();

    const snapshots = flowControlSnapshots(parentPort);
    const terminals = (snapshots[0].snapshot as { terminals: Array<Record<string, unknown>> })
      .terminals;
    expect(terminals.find((t) => t.terminalId === "t1" && (t.droppedBytes as number) > 0)).toBe(
      undefined
    );
  });
});
