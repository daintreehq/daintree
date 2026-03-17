import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockTerminalClient } = vi.hoisted(() => ({
  mockTerminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    write: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffers: vi.fn(async () => ({
      visualBuffers: [],
      signalBuffer: null,
    })),
    acknowledgeData: vi.fn(),
  },
}));

vi.mock("@/clients", () => ({
  terminalClient: mockTerminalClient,
  systemClient: {
    openExternal: vi.fn(),
  },
  appClient: {
    getHydrationState: vi.fn(),
  },
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
    webLinksAddon: {},
    imageAddon: {},
    searchAddon: {},
  })),
}));

describe("TerminalInstanceService post-wake handling", () => {
  type PostWakeTestService = {
    instances: Map<string, { latestCols: number; latestRows: number }>;
    handlePostWake: (id: string) => void;
  };

  let service: PostWakeTestService | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: PostWakeTestService;
      });

    service.instances.clear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();

    if (service) {
      service.instances.clear();
    }
  });

  it("performs a single immediate resize without bounce", () => {
    const id = "term-post-wake";
    if (!service) throw new Error("Service not initialized");
    service.instances.set(id, { latestCols: 80, latestRows: 24 });

    service.handlePostWake(id);

    // xterm v6 handles rendering recovery without needing a row bounce.
    // Only the immediate forceImmediateResize should fire (which calls fit,
    // not terminalClient.resize directly).
    expect(mockTerminalClient.resize).toHaveBeenCalledTimes(1);
    expect(mockTerminalClient.resize).toHaveBeenNthCalledWith(1, id, 80, 24);

    // No delayed bounce timers
    vi.advanceTimersByTime(200);
    expect(mockTerminalClient.resize).toHaveBeenCalledTimes(1);
  });

  it("skips post-wake resize path when latest dimensions are invalid", () => {
    const id = "term-post-wake-invalid";
    if (!service) throw new Error("Service not initialized");
    service.instances.set(id, { latestCols: 0, latestRows: 24 });

    service.handlePostWake(id);
    vi.advanceTimersByTime(200);

    expect(mockTerminalClient.resize).not.toHaveBeenCalled();
  });
});
