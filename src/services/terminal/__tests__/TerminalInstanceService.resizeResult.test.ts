// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalResizeResult } from "@shared/types/pty-host";
import type { ManagedTerminal } from "../types";

// Captured when the service installs its lazy subscription. Not reset between
// tests — `vi.resetModules()` gives each test a fresh service that re-subscribes.
let capturedResizeResultCb: ((id: string, result: TerminalResizeResult) => void) | null = null;

const onResizeResult = vi.fn((cb: (id: string, result: TerminalResizeResult) => void) => {
  capturedResizeResultCb = cb;
  return vi.fn();
});

vi.mock("@/clients", () => ({
  terminalClient: {
    onResizeResult,
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
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

type ResizeResultTestService = {
  instances: Map<string, ManagedTerminal>;
  prewarmTerminal: (
    id: string,
    type: string,
    options: Record<string, unknown>
  ) => Record<string, unknown>;
};

function makeResult(overrides: Partial<TerminalResizeResult> = {}): TerminalResizeResult {
  return {
    launchGeneration: 1,
    requestedCols: 120,
    requestedRows: 40,
    appliedCols: 120,
    appliedRows: 40,
    outcome: "applied",
    ...overrides,
  };
}

function makeManaged(): ManagedTerminal {
  return {
    terminal: { cols: 120, rows: 40 },
    latestCols: 120,
    latestRows: 40,
  } as unknown as ManagedTerminal;
}

describe("TerminalInstanceService — PTY resize-result intake (#11641)", () => {
  let service: ResizeResultTestService;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    capturedResizeResultCb = null;

    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: ResizeResultTestService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes lazily on first terminal creation, once per process", async () => {
    // Constructing the singleton must not reach into terminalClient — the
    // service is built at module scope, where window.electron does not exist
    // under Node test environments.
    expect(onResizeResult).not.toHaveBeenCalled();

    await service.prewarmTerminal("warm-a", "terminal", {});
    await service.prewarmTerminal("warm-b", "terminal", {});

    // One listener routed by id, not one per terminal.
    expect(onResizeResult).toHaveBeenCalledTimes(1);
    expect(capturedResizeResultCb).toBeTypeOf("function");
  });

  it("stores the reported geometry on the addressed terminal only", async () => {
    await service.prewarmTerminal("warm", "terminal", {});
    const managed = makeManaged();
    service.instances.set("t1", managed);

    capturedResizeResultCb?.("t1", makeResult());
    expect(managed.lastPtyResizeResult).toMatchObject({ appliedCols: 120 });

    // An echo for a terminal this renderer does not host must not throw.
    expect(() => capturedResizeResultCb?.("unknown", makeResult())).not.toThrow();
  });

  it("retires the divergence history when a new PTY incarnation reports in", async () => {
    await service.prewarmTerminal("warm", "terminal", {});
    const managed = makeManaged();
    service.instances.set("t1", managed);

    capturedResizeResultCb?.("t1", makeResult());
    managed.ptyGeometryDivergenceCount = 4;
    managed.ptyGeometryDivergenceSignature = "1:120x40:80x40";

    // A respawn reuses the terminal id; the dead PTY's divergence tally says
    // nothing about the successor's grid.
    capturedResizeResultCb?.("t1", makeResult({ launchGeneration: 2 }));

    expect(managed.ptyGeometryDivergenceCount).toBe(0);
    expect(managed.ptyGeometryDivergenceSignature).toBeUndefined();
  });

  it("keeps the divergence tally across echoes from the same incarnation", async () => {
    await service.prewarmTerminal("warm", "terminal", {});
    const managed = makeManaged();
    service.instances.set("t1", managed);

    capturedResizeResultCb?.("t1", makeResult());
    managed.ptyGeometryDivergenceCount = 4;

    capturedResizeResultCb?.("t1", makeResult({ appliedCols: 130 }));

    expect(managed.ptyGeometryDivergenceCount).toBe(4);
  });
});
