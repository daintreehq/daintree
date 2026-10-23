// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedTerminal } from "../types";
import type { ProjectViewLifecyclePhase } from "@/lib/viewCacheState";

// Module mock rather than the preload-bridge stub: the service is re-imported
// under vi.resetModules() and subscribes to the lifecycle at construction, so
// the listener it registers has to be captured here.
// Cached and hidden are independent inputs, combined the way the real
// observability helper combines them.
const viewCache = vi.hoisted(() => ({
  cached: false,
  hidden: false,
  listeners: new Set<(phase: ProjectViewLifecyclePhase) => void>(),
  visibilityListeners: new Set<() => void>(),
}));

vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewCached: () => viewCache.cached,
  isProjectViewObservable: () => !viewCache.cached && !viewCache.hidden,
  subscribeProjectViewLifecycle: (listener: (phase: ProjectViewLifecyclePhase) => void) => {
    viewCache.listeners.add(listener);
    return () => viewCache.listeners.delete(listener);
  },
  // Edge-triggered like the real helper: fires only when the combined answer
  // flips, from either a lifecycle phase or a visibilitychange.
  subscribeProjectViewObservability: (listener: (observable: boolean) => void) => {
    const observable = () => !viewCache.cached && !viewCache.hidden;
    let last = observable();
    const check = () => {
      const next = observable();
      if (next === last) return;
      last = next;
      listener(next);
    };
    viewCache.listeners.add(check);
    viewCache.visibilityListeners.add(check);
    return () => {
      viewCache.listeners.delete(check);
      viewCache.visibilityListeners.delete(check);
    };
  },
}));

const renderSuspension = vi.hoisted(() => ({
  suspendXtermRender: vi.fn(() => true),
  resumeXtermRender: vi.fn(),
}));

vi.mock("../xtermRenderSuspension", () => renderSuspension);

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    onReset: vi.fn(() => vi.fn()),
    write: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffers: vi.fn(async () => ({ visualBuffers: [], signalBuffer: null })),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
    getPortAckGeneration: vi.fn(() => 0),
    discardPortAcks: vi.fn(),
  },
  systemClient: { openExternal: vi.fn() },
  appClient: { getHydrationState: vi.fn() },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

type BufferTestService = {
  instances: Map<string, ManagedTerminal>;
  scheduleWhySlowReport: () => void;
  dispose: () => void;
};

function emit(phase: ProjectViewLifecyclePhase): void {
  viewCache.cached = phase === "cached";
  for (const listener of Array.from(viewCache.listeners)) {
    try {
      listener(phase);
    } catch {
      // ignore
    }
  }
}

function makeManaged(normalLines: number, alternateLines: number, cols: number): ManagedTerminal {
  return {
    isOpened: false,
    isFocused: false,
    terminal: {
      cols,
      buffer: { normal: { length: normalLines }, alternate: { length: alternateLines } },
    } as unknown as ManagedTerminal["terminal"],
  } as ManagedTerminal;
}

describe("TerminalInstanceService renderer buffer counts (#14213)", () => {
  let service: BufferTestService;
  const report = vi.fn((_payload: Record<string, unknown>) => Promise.resolve());
  const eventListeners = new Map<string, () => void>();
  const allSampleListeners: Array<() => void> = [];
  const unsubscribe = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    viewCache.cached = false;
    viewCache.listeners.clear();
    viewCache.visibilityListeners.clear();
    report.mockClear();
    unsubscribe.mockClear();
    eventListeners.clear();
    allSampleListeners.length = 0;
    (window as unknown as { electron: unknown }).electron = {
      system: { reportTerminalRendererDiagnostics: report },
      events: {
        on: (name: string, cb: () => void) => {
          if (!eventListeners.has(name)) eventListeners.set(name, cb);
          if (name === "window:sample-terminal-buffers") allSampleListeners.push(cb);
          return unsubscribe;
        },
      },
    };
    service = (await (
      await import("../terminalInstanceServiceAccessor")
    ).load()) as unknown as BufferTestService;
    service.instances.clear();
    service.instances.set("agent", makeManaged(10_000, 0, 182));
    service.instances.set("vim", makeManaged(24, 24, 80));
  });

  afterEach(() => {
    service.instances.clear();
    service.dispose();
    delete (window as unknown as { electron?: unknown }).electron;
  });

  function lastBufferMemory() {
    const payload = report.mock.calls.at(-1)?.[0];
    return payload?.bufferMemory as
      { sampledAt: number; terminals: Array<Record<string, unknown>> } | undefined;
  }

  it("answers a sample request with each terminal's line counts and width", () => {
    eventListeners.get("window:sample-terminal-buffers")?.();

    expect(report).toHaveBeenCalledTimes(1);
    expect(lastBufferMemory()?.terminals).toEqual([
      { terminalId: "agent", normalLines: 10_000, alternateLines: 0, cols: 182 },
      { terminalId: "vim", normalLines: 24, alternateLines: 24, cols: 80 },
    ]);
    expect(lastBufferMemory()?.sampledAt).toEqual(expect.any(Number));
  });

  it("ignores a sample request that lands after the view was cached", () => {
    emit("cached");
    report.mockClear();

    eventListeners.get("window:sample-terminal-buffers")?.();

    expect(report).not.toHaveBeenCalled();
  });

  it("pushes its counts synchronously on the way into the cache", () => {
    emit("cached");

    expect(report).toHaveBeenCalled();
    expect(lastBufferMemory()?.terminals).toHaveLength(2);
  });

  it("leaves buffers out of routine create/destroy/tier reports", async () => {
    service.scheduleWhySlowReport();
    await Promise.resolve();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).not.toHaveProperty("bufferMemory");
  });

  it("reports every paint surface's terminals once, from the primary service", () => {
    const Service = service.constructor as new () => BufferTestService;
    const aux = new Service();
    aux.instances.set("aux-term", makeManaged(500, 0, 120));
    try {
      // The request reaches both services' listeners; only the primary answers.
      for (const listener of allSampleListeners) listener();

      expect(report).toHaveBeenCalledTimes(1);
      expect(lastBufferMemory()?.terminals.map((t) => t.terminalId)).toEqual([
        "agent",
        "vim",
        "aux-term",
      ]);
    } finally {
      aux.instances.clear();
      aux.dispose();
    }
  });

  it("drops its sample-request subscription on dispose", () => {
    // Stub terminals have no host element for destroy() to tear down.
    service.instances.clear();
    service.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
