import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockTerminalClient } = vi.hoisted(() => ({
  mockTerminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    write: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffers: vi.fn(async () => ({
      visualBuffers: [],
      signalBuffer: null,
    })),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
    discardPortAcks: vi.fn(),
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
  hostElement: {
    getBoundingClientRect: () => DOMRect;
    isConnected: boolean;
    checkVisibility: ReturnType<typeof vi.fn>;
  };
  fitAddon: {
    fit: ReturnType<typeof vi.fn>;
    proposeDimensions: ReturnType<typeof vi.fn>;
  };
  terminal: {
    cols: number;
    rows: number;
    buffer: { active: { viewportY: number; baseY: number } };
    resize: ReturnType<typeof vi.fn>;
    scrollToBottom: ReturnType<typeof vi.fn>;
  };
  runtimeAgentId?: string;
  isUserScrolledBack: boolean;
}

type PostWakeTestService = {
  instances: Map<string, PostWakeInstance>;
  handlePostWake: (id: string) => void;
  maybeReflowTerminal: (managed: PostWakeInstance) => void;
  resizeController: { lockResize: (id: string, locked: boolean) => void };
};

function makeInstance(overrides: Partial<PostWakeInstance> = {}): PostWakeInstance {
  return {
    latestCols: 80,
    latestRows: 24,
    hostElement: {
      getBoundingClientRect: () =>
        ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }) as DOMRect,
      isConnected: true,
      checkVisibility: vi.fn(() => true),
    },
    fitAddon: {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 120, rows: 30 })),
    },
    terminal: {
      cols: 80,
      rows: 24,
      buffer: { active: { viewportY: 0, baseY: 0 } },
      resize: vi.fn(function (this: { cols: number; rows: number }, cols: number, rows: number) {
        this.cols = cols;
        this.rows = rows;
      }),
      scrollToBottom: vi.fn(),
    },
    isUserScrolledBack: false,
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

  it("applies a fresh fit proposal immediately for a default terminal", () => {
    const id = "term-post-wake";
    if (!service) throw new Error("Service not initialized");

    const instance = makeInstance();
    service.instances.set(id, instance);

    service.handlePostWake(id);

    expect(instance.fitAddon.proposeDimensions).toHaveBeenCalledTimes(2);
    expect(instance.fitAddon.fit).not.toHaveBeenCalled();
    expect(instance.terminal.resize).toHaveBeenCalledWith(120, 30);
    expect(mockTerminalClient.resize).toHaveBeenCalledTimes(1);
    expect(mockTerminalClient.resize).toHaveBeenCalledWith(id, 120, 30);

    // No delayed timers
    vi.advanceTimersByTime(600);
    expect(mockTerminalClient.resize).toHaveBeenCalledTimes(1);
  });

  it("fresh-measures a settled terminal and delays both xterm and PTY until commit", () => {
    const id = "term-post-wake-settled";
    if (!service) throw new Error("Service not initialized");
    const instance = makeInstance({ runtimeAgentId: "codex" });
    service.instances.set(id, instance);
    const reflow = vi.spyOn(service, "maybeReflowTerminal");

    service.handlePostWake(id);

    expect(instance.fitAddon.proposeDimensions).toHaveBeenCalledTimes(2);
    expect(instance.fitAddon.fit).not.toHaveBeenCalled();
    expect(instance.terminal.resize).not.toHaveBeenCalled();
    expect(mockTerminalClient.resize).not.toHaveBeenCalled();
    expect(reflow).not.toHaveBeenCalled();

    vi.advanceTimersByTime(499);
    expect(instance.terminal.resize).not.toHaveBeenCalled();
    expect(mockTerminalClient.resize).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(instance.terminal.resize).toHaveBeenCalledTimes(1);
    expect(instance.terminal.resize).toHaveBeenCalledWith(120, 30);
    expect(mockTerminalClient.resize).toHaveBeenCalledTimes(1);
    expect(mockTerminalClient.resize).toHaveBeenCalledWith(id, 120, 30);
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
        checkVisibility: vi.fn(() => false),
      },
    });
    service.instances.set(id, instance);

    service.handlePostWake(id);

    // fit() was NOT called on the addon (checkVisibility returned false)
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
        checkVisibility: vi.fn(() => false),
      },
    });
    service.instances.set(id, instance);

    service.handlePostWake(id);
    vi.advanceTimersByTime(200);

    expect(mockTerminalClient.resize).not.toHaveBeenCalled();
  });

  it("does not mutate xterm or the PTY when post-wake runs under a resize lock", () => {
    const id = "term-post-wake-locked";
    if (!service) throw new Error("Service not initialized");
    const instance = makeInstance();
    service.instances.set(id, instance);
    service.resizeController.lockResize(id, true);

    service.handlePostWake(id);

    expect(instance.terminal.resize).not.toHaveBeenCalled();
    expect(mockTerminalClient.resize).not.toHaveBeenCalled();
  });
});
