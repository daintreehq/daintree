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
    imageAddon: { dispose: vi.fn() },
    searchAddon: {},
    fileLinksDisposable: { dispose: vi.fn() },
    webLinksAddon: { dispose: vi.fn() },
  })),
  createImageAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createFileLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createWebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
}));

interface PostWakeInstance {
  latestCols: number;
  latestRows: number;
  hostElement: { getBoundingClientRect: () => DOMRect; isConnected: boolean };
  fitAddon: { fit: ReturnType<typeof vi.fn> };
  terminal: { cols: number; rows: number };
  agentId?: string;
}

type PostWakeTestService = {
  instances: Map<string, PostWakeInstance>;
  handlePostWake: (id: string) => void;
};

function makeInstance(overrides: Partial<PostWakeInstance> = {}): PostWakeInstance {
  return {
    latestCols: 80,
    latestRows: 24,
    hostElement: {
      getBoundingClientRect: () =>
        ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }) as DOMRect,
      isConnected: true,
    },
    fitAddon: { fit: vi.fn() },
    terminal: { cols: 120, rows: 30 },
    ...overrides,
  };
}

describe("TerminalInstanceService post-wake handling", () => {
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

  it("calls fit() first and returns early when fit succeeds", () => {
    const id = "term-post-wake";
    if (!service) throw new Error("Service not initialized");

    const instance = makeInstance({ terminal: { cols: 120, rows: 30 } });
    service.instances.set(id, instance);

    service.handlePostWake(id);

    // fit() was called on the addon
    expect(instance.fitAddon.fit).toHaveBeenCalledTimes(1);

    // fit() succeeded so sendPtyResize was called with the terminal's current dimensions
    expect(mockTerminalClient.resize).toHaveBeenCalledTimes(1);
    expect(mockTerminalClient.resize).toHaveBeenCalledWith(id, 120, 30);

    // No delayed timers
    vi.advanceTimersByTime(600);
    expect(mockTerminalClient.resize).toHaveBeenCalledTimes(1);
  });

  it("falls back to forceImmediateResize when fit() returns null (offscreen)", () => {
    const id = "term-post-wake-offscreen";
    if (!service) throw new Error("Service not initialized");

    const instance = makeInstance({
      latestCols: 80,
      latestRows: 24,
      hostElement: {
        getBoundingClientRect: () =>
          ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }) as DOMRect,
        isConnected: true,
      },
    });
    service.instances.set(id, instance);

    service.handlePostWake(id);

    // fit() was NOT called on the addon (getBoundingClientRect returned zero dims)
    expect(instance.fitAddon.fit).not.toHaveBeenCalled();

    // Fallback: forceImmediateResize sends PTY resize with cached dims
    expect(mockTerminalClient.resize).toHaveBeenCalledTimes(1);
    expect(mockTerminalClient.resize).toHaveBeenCalledWith(id, 80, 24);
  });

  it("skips post-wake resize path when latest dimensions are invalid", () => {
    const id = "term-post-wake-invalid";
    if (!service) throw new Error("Service not initialized");

    const instance = makeInstance({
      latestCols: 0,
      latestRows: 24,
      hostElement: {
        getBoundingClientRect: () =>
          ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }) as DOMRect,
        isConnected: true,
      },
    });
    service.instances.set(id, instance);

    service.handlePostWake(id);
    vi.advanceTimersByTime(200);

    expect(mockTerminalClient.resize).not.toHaveBeenCalled();
  });
});
