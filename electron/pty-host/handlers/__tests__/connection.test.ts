import { describe, it, expect, vi } from "vitest";
import { createConnectionHandlers } from "../connection.js";
import { SharedRingBuffer } from "../../../../shared/utils/SharedRingBuffer.js";
import type { HostContext } from "../types.js";

function makeCtx(stateRef: {
  visualBuffers: SharedRingBuffer[];
  visualSignalView: Int32Array | null;
  analysisBuffer: SharedRingBuffer | null;
}): HostContext {
  const ptyManager = {
    setSabMode: vi.fn(),
    isSabMode: vi.fn(() => true),
  } as unknown as HostContext["ptyManager"];

  return {
    ptyManager,
    processTreeCache: {} as HostContext["processTreeCache"],
    terminalResourceMonitor: {} as HostContext["terminalResourceMonitor"],
    backpressureManager: {} as HostContext["backpressureManager"],
    ipcQueueManager: {} as HostContext["ipcQueueManager"],
    resourceGovernor: {} as HostContext["resourceGovernor"],
    packetFramer: {} as HostContext["packetFramer"],
    pauseCoordinators: new Map(),
    rendererConnections: new Map(),
    windowProjectMap: new Map(),
    ipcDataMirrorTerminals: new Set(),
    // Mirror the production wiring: getter/setter pairs read & write the
    // outer module-level state. Handlers must see the *current* value, not
    // a snapshot taken at factory construction time.
    get visualBuffers() {
      return stateRef.visualBuffers;
    },
    set visualBuffers(value: SharedRingBuffer[]) {
      stateRef.visualBuffers = value;
    },
    get visualSignalView() {
      return stateRef.visualSignalView;
    },
    set visualSignalView(value: Int32Array | null) {
      stateRef.visualSignalView = value;
    },
    get analysisBuffer() {
      return stateRef.analysisBuffer;
    },
    set analysisBuffer(value: SharedRingBuffer | null) {
      stateRef.analysisBuffer = value;
    },
    ptyPool: null,
    sendEvent: vi.fn(),
    getPauseCoordinator: vi.fn(),
    getOrCreatePauseCoordinator: vi.fn(),
    disconnectWindow: vi.fn(),
    recomputeActivityTiers: vi.fn(),
    tryReplayAndResume: vi.fn(),
    resumePausedTerminal: vi.fn(),
    createPortQueueManager: vi.fn(),
  };
}

describe("init-buffers handler", () => {
  it("populates visualBuffers, visualSignalView, and analysisBuffer via the ctx setters", () => {
    // The whole reason HostContext uses getter/setter pairs is that
    // init-buffers swaps in fresh SharedRingBuffer instances after factory
    // construction. If the handler captured a local snapshot of
    // `ctx.visualBuffers` it would silently keep using the empty array.
    const stateRef = {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
    const ctx = makeCtx(stateRef);
    const handlers = createConnectionHandlers(ctx);

    const visualBuffer = SharedRingBuffer.create(4096);
    const analysisBuffer = SharedRingBuffer.create(4096);
    const signalBuffer = new SharedArrayBuffer(4);

    handlers["init-buffers"]({
      visualBuffers: [visualBuffer],
      visualSignalBuffer: signalBuffer,
      analysisBuffer,
    });

    expect(stateRef.visualBuffers).toHaveLength(1);
    expect(stateRef.visualBuffers[0]).toBeInstanceOf(SharedRingBuffer);
    expect(stateRef.visualSignalView).toBeInstanceOf(Int32Array);
    expect(stateRef.analysisBuffer).toBeInstanceOf(SharedRingBuffer);
    expect(ctx.ptyManager.setSabMode).toHaveBeenCalledWith(true);
  });

  it("does not enable SAB mode if visualBuffers is missing or invalid", () => {
    const stateRef = {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
    const ctx = makeCtx(stateRef);
    const handlers = createConnectionHandlers(ctx);

    vi.spyOn(console, "warn").mockImplementation(() => {});

    handlers["init-buffers"]({
      visualBuffers: undefined,
      visualSignalBuffer: undefined,
      analysisBuffer: undefined,
    });

    expect(ctx.ptyManager.setSabMode).not.toHaveBeenCalled();
    expect(stateRef.visualBuffers).toHaveLength(0);
    expect(stateRef.visualSignalView).toBeNull();
    expect(stateRef.analysisBuffer).toBeNull();
  });

  it("project handler updates the window→project map and recomputes activity tiers", () => {
    const stateRef = {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
    const ctx = makeCtx(stateRef);
    const handlers = createConnectionHandlers(ctx);

    handlers["set-active-project"]({ windowId: 1, projectId: "proj-a" });

    expect(ctx.windowProjectMap.get(1)).toBe("proj-a");
    expect(ctx.recomputeActivityTiers).toHaveBeenCalledTimes(1);
  });
});
