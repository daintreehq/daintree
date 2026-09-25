// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SerializedTerminalSnapshot } from "@shared/types/terminal";

type ResetCb = (id: string, snapshot: SerializedTerminalSnapshot | null) => void;

let capturedResetCb: ResetCb | null = null;
let currentGeneration = 0;

const onReset = vi.fn((cb: ResetCb) => {
  capturedResetCb = cb;
  return vi.fn();
});

vi.mock("@/clients", () => ({
  terminalClient: {
    onReset,
    onResizeResult: vi.fn(() => vi.fn()),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    getPortAckGeneration: vi.fn(() => currentGeneration),
    resize: vi.fn(),
    write: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffers: vi.fn(async () => ({ visualBuffers: [], signalBuffer: null })),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
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

vi.mock("../TerminalAddonManager", () => ({
  setupTerminalAddons: vi.fn(() => ({
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    imageAddon: { dispose: vi.fn() },
    searchAddon: {},
    fileLinksDisposable: { dispose: vi.fn() },
    webLinksAddon: { dispose: vi.fn() },
  })),
  createImageAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createFileLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createWebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
}));

interface FakeManaged {
  terminal: { cols: number; rows: number; reset: ReturnType<typeof vi.fn> };
  deferredOutput: Array<{ data: string; chunkCount: number; ackGeneration?: number }>;
}

type RemoteResetTestService = {
  instances: Map<string, FakeManaged>;
  prewarmTerminal: (
    id: string,
    type: string,
    options: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  restoreController: { restoreFetchedState: (...args: unknown[]) => Promise<boolean> };
  dataBuffer: { resetForTerminal: (id: string) => void };
  dispose: () => void;
};

function makeManaged(): FakeManaged {
  return { terminal: { cols: 80, rows: 24, reset: vi.fn() }, deferredOutput: [] };
}

describe("TerminalInstanceService — remote terminal reset", () => {
  let service: RemoteResetTestService;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    capturedResetCb = null;
    currentGeneration = 0;
    // Reached through Reflect: the test drives private members the public type hides.
    const mod: object = await import("../TerminalInstanceService");
    service = Reflect.get(mod, "terminalInstanceService");
    service.instances.clear();
  });

  it("subscribes lazily with the other host subscriptions, and not before", async () => {
    expect(onReset).not.toHaveBeenCalled();
    await service.prewarmTerminal("warm", "terminal", {});
    await service.prewarmTerminal("warm-2", "terminal", {});
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("repaints through the geometry-aware restore and drops what predates the reset", async () => {
    await service.prewarmTerminal("warm", "terminal", {});
    const managed = makeManaged();
    managed.deferredOutput = [
      { data: "before", chunkCount: 1, ackGeneration: 0 },
      { data: "after", chunkCount: 2, ackGeneration: 1 },
    ];
    service.instances.set("t1", managed);
    const restore = vi
      .spyOn(service.restoreController, "restoreFetchedState")
      .mockResolvedValue(true);
    const dropQueue = vi.spyOn(service.dataBuffer, "resetForTerminal");

    currentGeneration = 1;
    capturedResetCb?.("t1", { data: "SNAP", cols: 132, rows: 43 });

    expect(dropQueue).toHaveBeenCalledWith("t1");
    expect(managed.deferredOutput).toEqual([{ data: "after", chunkCount: 2, ackGeneration: 1 }]);
    expect(restore).toHaveBeenCalledWith("t1", "SNAP", { cols: 132, rows: 43 });
  });

  it("clears the terminal when the host sends no snapshot", async () => {
    await service.prewarmTerminal("warm", "terminal", {});
    const managed = makeManaged();
    service.instances.set("t1", managed);
    const restore = vi.spyOn(service.restoreController, "restoreFetchedState");

    capturedResetCb?.("t1", null);

    expect(managed.terminal.reset).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
  });

  it("ignores a reset for a terminal this view does not host", async () => {
    await service.prewarmTerminal("warm", "terminal", {});
    const restore = vi.spyOn(service.restoreController, "restoreFetchedState");
    const dropQueue = vi.spyOn(service.dataBuffer, "resetForTerminal");

    expect(() => capturedResetCb?.("unknown", { data: "S", cols: 80, rows: 24 })).not.toThrow();
    expect(restore).not.toHaveBeenCalled();
    expect(dropQueue).not.toHaveBeenCalled();
  });
});
