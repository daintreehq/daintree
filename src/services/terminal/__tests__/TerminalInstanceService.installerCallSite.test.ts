// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";

// Spy on the canonical listener installer. The create path (TIS.getOrCreate)
// imports this module, so the mock intercepts every terminal-bound install.
const { installMock } = vi.hoisted(() => ({
  installMock: vi.fn(),
}));

vi.mock("../TerminalListenerInstaller", () => ({
  installTerminalBoundListeners: installMock,
}));

const mockTerminalClient = {
  onData: vi.fn(() => vi.fn()),
  onExit: vi.fn(() => vi.fn()),
  onTierChanged: vi.fn(() => vi.fn()),
  setActivityTier: vi.fn(),
  wake: vi.fn().mockResolvedValue({ state: null }),
  write: vi.fn(),
  getSerializedState: vi.fn(),
  getSharedBuffer: vi.fn(() => null),
  acknowledgeData: vi.fn(),
  acknowledgePortData: vi.fn(),
  discardPortAcks: vi.fn(),
};

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

const mockGetEffectiveAgentConfig = vi.fn();
vi.mock("@shared/config/agentRegistry", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getEffectiveAgentConfig: (...args: unknown[]) => mockGetEffectiveAgentConfig(...args),
  };
});

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

type CallSiteTestService = {
  instances: Map<string, Record<string, unknown>>;
  getOrCreate: (
    id: string,
    launchAgentId: string | undefined,
    options: Record<string, unknown>,
    getRefreshTier?: () => TerminalRefreshTier,
    onInput?: (data: string) => void
  ) => Record<string, unknown>;
  detachForProjectSwitch: (id: string) => void;
};

function makeMockManaged(overrides: Record<string, unknown> = {}) {
  const terminal = {
    options: { scrollback: 5000 },
    rows: 24,
    cols: 80,
    modes: { mouseTrackingMode: "none" as const },
    buffer: {
      active: { length: 100, type: "normal", baseY: 0, viewportY: 0 },
      onBufferChange: vi.fn(() => ({ dispose: vi.fn() })),
    },
    parser: {
      registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })),
    },
    attachCustomWheelEventHandler: vi.fn(),
    refresh: vi.fn(),
    loadAddon: vi.fn(),
    registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ""),
    dispose: vi.fn(),
    write: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onKey: vi.fn(() => ({ dispose: vi.fn() })),
    onScroll: vi.fn(() => ({ dispose: vi.fn() })),
    onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
    onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
    onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
    clearTextureAtlas: vi.fn(),
    selectAll: vi.fn(),
    open: vi.fn(),
  };

  const managed = {
    terminal,
    type: "terminal",
    kind: "terminal",
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    imageAddon: { dispose: vi.fn() } as { dispose: ReturnType<typeof vi.fn> } | null,
    searchAddon: {},
    fileLinksDisposable: { dispose: vi.fn() } as { dispose: ReturnType<typeof vi.fn> } | null,
    webLinksAddon: { dispose: vi.fn() } as { dispose: ReturnType<typeof vi.fn> } | null,
    hostElement: document.createElement("div"),
    isOpened: true,
    isVisible: true,
    isFocused: false,
    isUserScrolledBack: false,
    isAltBuffer: false,
    lastActiveTime: Date.now(),
    lastWidth: 0,
    lastHeight: 0,
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
    isHibernated: false,
    isInputLocked: false,
    ipcListenerCount: 0,
    ...overrides,
  };
  return managed;
}

describe("TerminalInstanceService — installTerminalBoundListeners call-site parity", () => {
  let service: CallSiteTestService;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.clearAllMocks();

    (window as unknown as Record<string, unknown>).electron = {
      terminal: {
        reportTitleState: vi.fn(),
        updateObservedTitle: vi.fn(),
      },
      clipboard: {
        writeSelection: vi.fn().mockResolvedValue(undefined),
        readSelection: vi.fn().mockResolvedValue({ text: "" }),
      },
      system: {
        requestInteractiveOverride: vi.fn().mockResolvedValue(undefined),
      },
    };

    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: CallSiteTestService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("create path: getOrCreate installs terminal-bound listeners exactly once", async () => {
    await service.getOrCreate("t1", undefined, {});

    expect(installMock).toHaveBeenCalledTimes(1);
    expect(installMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ kind: "terminal" }),
      "t1",
      expect.any(Object)
    );
  });

  it("onUserScrollIntent dep requests an interactive profile-hold over IPC (#10858)", async () => {
    await service.getOrCreate("t1", undefined, {});

    const deps = installMock.mock.calls[0]?.[3] as { onUserScrollIntent: (id: string) => void };
    deps.onUserScrollIntent("t1");

    expect(
      (
        window as unknown as {
          electron: { system: { requestInteractiveOverride: ReturnType<typeof vi.fn> } };
        }
      ).electron.system.requestInteractiveOverride
    ).toHaveBeenCalledWith(1500);
  });

  it("detach path: detachForProjectSwitch does not install listeners", () => {
    const managed = makeMockManaged();
    // Append hostElement to a container so the parented DOM-move branch in
    // detachForProjectSwitch (lines 1311-1315) is exercised, not just the
    // unparented short-circuit.
    document.body.appendChild(managed.hostElement);
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.detachForProjectSwitch("t1");

    expect(installMock).not.toHaveBeenCalled();
  });
});
