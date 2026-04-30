// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";

const mockTerminalClient = {
  onData: vi.fn(() => vi.fn()),
  onExit: vi.fn(() => vi.fn()),
  setActivityTier: vi.fn(),
  wake: vi.fn().mockResolvedValue({ state: null }),
  write: vi.fn(),
  getSerializedState: vi.fn(),
  getSharedBuffer: vi.fn(() => null),
  acknowledgeData: vi.fn(),
  acknowledgePortData: vi.fn(),
};

vi.mock("@/clients", () => ({
  terminalClient: mockTerminalClient,
  systemClient: { openExternal: vi.fn() },
  appClient: { getHydrationState: vi.fn() },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function () {
    return {
      dispose: vi.fn(),
      onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
    };
  }),
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

type WebGLVisibilityService = {
  instances: Map<string, Record<string, unknown>>;
  setVisible: (id: string, visible: boolean, expectedGeneration?: number) => void;
  destroy: (id: string) => void;
  webGLManager: {
    isActive: (id: string) => boolean;
    ensureContext: (id: string, managed: unknown) => void;
    releaseContext: (id: string) => void;
  };
};

function makeMockManaged(overrides: Record<string, unknown> = {}) {
  const terminal = {
    rows: 24,
    cols: 80,
    refresh: vi.fn(),
    loadAddon: vi.fn(),
    dispose: vi.fn(),
    element: document.createElement("div"),
  };

  const hostElement = document.createElement("div");
  Object.defineProperty(hostElement, "getBoundingClientRect", {
    value: () => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 }),
  });

  const managed = {
    terminal,
    type: "terminal",
    kind: "terminal",
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    imageAddon: null,
    searchAddon: {},
    fileLinksDisposable: null,
    webLinksAddon: null,
    hostElement,
    isOpened: true,
    isVisible: true,
    isFocused: false,
    isAttaching: false,
    isUserScrolledBack: false,
    isAltBuffer: false,
    isHibernated: false,
    runtimeAgentId: "claude" as string | undefined,
    launchAgentId: "claude",
    lastActiveTime: Date.now(),
    lastWidth: 800,
    lastHeight: 600,
    lastAppliedTier: TerminalRefreshTier.FOCUSED as TerminalRefreshTier | undefined,
    pendingTier: undefined as TerminalRefreshTier | undefined,
    tierChangeTimer: undefined as number | undefined,
    getRefreshTier: () => TerminalRefreshTier.FOCUSED,
    needsWake: false,
    agentStateSubscribers: new Set(),
    altBufferListeners: new Set(),
    listeners: [] as Array<() => void>,
    exitSubscribers: new Set(),
    latestCols: 80,
    latestRows: 24,
    latestWasAtBottom: true,
    keyHandlerInstalled: false,
    lastAttachAt: 0,
    lastDetachAt: 0,
    writeChain: Promise.resolve(),
    restoreGeneration: 0,
    isSerializedRestoreInProgress: false,
    deferredOutput: [] as Array<string | Uint8Array>,
    hibernationTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    webGLRestoreTimer: undefined as number | undefined,
    isInputLocked: false,
    ipcListenerCount: 0,
    attachGeneration: 0,
    attachRevealToken: 0,
    scrollbackRestoreState: "none" as const,
    ...overrides,
  };
  return managed;
}

describe("TerminalInstanceService - visibility-driven WebGL lease", () => {
  let service: WebGLVisibilityService;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.resetModules();

    (window as unknown as Record<string, unknown>).electron = {
      terminal: { reportTitleState: vi.fn() },
    };

    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: WebGLVisibilityService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("setVisible(false) immediately releases the WebGL context", () => {
    const managed = makeMockManaged();
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);
    expect(service.webGLManager.isActive("t1")).toBe(true);

    service.setVisible("t1", false);

    // No timer advance — release happens synchronously on the hide path
    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("setVisible(false) calls terminal.refresh after WebGL release for DOM fallback", () => {
    const managed = makeMockManaged();
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);
    (managed.terminal.refresh as ReturnType<typeof vi.fn>).mockClear();

    service.setVisible("t1", false);

    expect(managed.terminal.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("setVisible(false) does not refresh when no WebGL was active", () => {
    const managed = makeMockManaged();
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    // Never acquired WebGL
    (managed.terminal.refresh as ReturnType<typeof vi.fn>).mockClear();

    service.setVisible("t1", false);

    expect(managed.terminal.refresh).not.toHaveBeenCalled();
  });

  it("setVisible(true) restores WebGL after the debounce window", () => {
    const managed = makeMockManaged({ isVisible: false });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    expect(service.webGLManager.isActive("t1")).toBe(false);

    service.setVisible("t1", true);

    // Restore is debounced — not active yet
    expect(service.webGLManager.isActive("t1")).toBe(false);

    vi.advanceTimersByTime(100);
    expect(service.webGLManager.isActive("t1")).toBe(true);
  });

  it("setVisible(true) calls terminal.refresh after re-acquiring WebGL", () => {
    const managed = makeMockManaged({ isVisible: false });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    (managed.terminal.refresh as ReturnType<typeof vi.fn>).mockClear();

    service.setVisible("t1", true);
    vi.advanceTimersByTime(100);

    expect(managed.terminal.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("rapid hide→show→hide before debounce expires keeps context released", () => {
    const managed = makeMockManaged();
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);

    service.setVisible("t1", false);
    expect(service.webGLManager.isActive("t1")).toBe(false);

    service.setVisible("t1", true);
    // Within debounce — not yet restored
    expect(service.webGLManager.isActive("t1")).toBe(false);

    service.setVisible("t1", false);
    // Restore timer cancelled, still released
    expect(service.webGLManager.isActive("t1")).toBe(false);

    vi.advanceTimersByTime(200);
    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("standard (non-agent) terminal does not acquire WebGL on show", () => {
    const managed = makeMockManaged({
      isVisible: false,
      runtimeAgentId: undefined,
      launchAgentId: undefined,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.setVisible("t1", true);
    vi.advanceTimersByTime(100);

    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("show while attaching defers WebGL restore (no addon load)", () => {
    const managed = makeMockManaged({ isVisible: false, isAttaching: true });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.setVisible("t1", true);
    vi.advanceTimersByTime(100);

    // setVisible's isAttaching branch returns early — no restore timer scheduled
    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("show while in BACKGROUND tier does not restore WebGL", () => {
    const managed = makeMockManaged({
      isVisible: false,
      lastAppliedTier: TerminalRefreshTier.BACKGROUND,
      getRefreshTier: () => TerminalRefreshTier.BACKGROUND,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.setVisible("t1", true);
    vi.advanceTimersByTime(100);

    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("destroy clears the pending WebGL restore timer", () => {
    const managed = makeMockManaged({ isVisible: false });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.setVisible("t1", true);
    expect(managed.webGLRestoreTimer).toBeDefined();

    service.destroy("t1");

    // Timer cleared (won't fire and won't crash)
    vi.advanceTimersByTime(200);
    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("hibernated terminal short-circuits — no WebGL changes", () => {
    const managed = makeMockManaged({ isHibernated: true });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.setVisible("t1", false);
    service.setVisible("t1", true);
    vi.advanceTimersByTime(100);

    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("stale generation cleanup does not release WebGL", () => {
    const managed = makeMockManaged({ attachGeneration: 5 });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);

    // Stale generation from a previous mount — should be ignored entirely
    service.setVisible("t1", false, 4);
    expect(service.webGLManager.isActive("t1")).toBe(true);

    // Matching generation — release proceeds
    service.setVisible("t1", false, 5);
    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("agent demotion during debounce window cancels WebGL restore", () => {
    const managed = makeMockManaged({ isVisible: false });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.setVisible("t1", true);
    expect(service.webGLManager.isActive("t1")).toBe(false);

    // Demotion happens inside the debounce window — runtimeAgentId clears.
    managed.runtimeAgentId = undefined;

    vi.advanceTimersByTime(100);

    // shouldRestoreWebGL re-checks runtimeAgentId in the timer callback,
    // so the deferred restore must not fire after demotion.
    expect(service.webGLManager.isActive("t1")).toBe(false);
  });
});
