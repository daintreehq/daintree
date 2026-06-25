// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TerminalHibernationManager,
  type HibernationManagerDeps,
} from "../TerminalHibernationManager";
import { type ManagedTerminal } from "../types";
import { TerminalRefreshTier } from "../../../../shared/types/panel";

const {
  freshTerminalCtor,
  freshTerminalOpenMock,
  freshTerminalOnKey,
  freshTerminalOnTitleChange,
  freshTerminalOnWriteParsed,
} = vi.hoisted(() => ({
  freshTerminalCtor: vi.fn(),
  freshTerminalOpenMock: vi.fn(),
  freshTerminalOnKey: vi.fn(() => ({ dispose: vi.fn() })),
  freshTerminalOnTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
  freshTerminalOnWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(function MockTerminal(this: Record<string, unknown>, options?: object) {
    freshTerminalCtor();
    this.options = options ?? { scrollback: 5000 };
    this.rows = 24;
    this.cols = 80;
    this.modes = { mouseTrackingMode: "none" };
    this.buffer = {
      active: { length: 0, type: "normal", baseY: 0, viewportY: 0 },
      onBufferChange: vi.fn(() => ({ dispose: vi.fn() })),
    };
    this.parser = {
      registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })),
    };
    this.attachCustomWheelEventHandler = vi.fn();
    this.dispose = vi.fn();
    this.open = freshTerminalOpenMock;
    this.onData = vi.fn(() => ({ dispose: vi.fn() }));
    this.onKey = freshTerminalOnKey;
    this.onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    this.onWriteParsed = freshTerminalOnWriteParsed;
    this.onSelectionChange = vi.fn(() => ({ dispose: vi.fn() }));
    this.onRender = vi.fn(() => ({ dispose: vi.fn() }));
    this.onTitleChange = freshTerminalOnTitleChange;
    this.getSelection = vi.fn(() => "");
  }),
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    write: vi.fn(),
  },
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
}));

vi.mock("../TerminalParserHandler", () => ({
  TerminalParserHandler: class {
    dispose = vi.fn();
    constructor(_managed: unknown, _onResize: () => void) {}
  },
}));

vi.mock("../TerminalScrollbackController", () => ({
  reduceScrollback: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@shared/config/scrollback", () => ({
  SCROLLBACK_BACKGROUND: 1000,
}));

vi.mock("@shared/config/agentRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/config/agentRegistry")>();
  return {
    ...actual,
    getEffectiveAgentConfig: vi.fn(() => undefined),
  };
});

function makeMockTerminal() {
  return {
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
    dispose: vi.fn(),
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onKey: vi.fn(() => ({ dispose: vi.fn() })),
    onScroll: vi.fn(() => ({ dispose: vi.fn() })),
    onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
    onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
    onRender: vi.fn(() => ({ dispose: vi.fn() })),
    onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
    getSelection: vi.fn(() => ""),
  };
}

function makeMockManaged(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  return {
    terminal: makeMockTerminal() as unknown as ManagedTerminal["terminal"],
    kind: "terminal",
    fitAddon: { fit: vi.fn() } as unknown as ManagedTerminal["fitAddon"],
    serializeAddon: { serialize: vi.fn() } as unknown as ManagedTerminal["serializeAddon"],
    imageAddon: { dispose: vi.fn() } as unknown as ManagedTerminal["imageAddon"],
    searchAddon: {} as ManagedTerminal["searchAddon"],
    fileLinksDisposable: { dispose: vi.fn() } as unknown as ManagedTerminal["fileLinksDisposable"],
    webLinksAddon: { dispose: vi.fn() } as unknown as ManagedTerminal["webLinksAddon"],
    hostElement: document.createElement("div"),
    isOpened: true,
    isVisible: true,
    isFocused: false,
    isUserScrolledBack: false,
    isAltBuffer: false,
    lastActiveTime: Date.now(),
    lastWidth: 0,
    lastHeight: 0,
    getRefreshTier: () => TerminalRefreshTier.FOCUSED,
    agentStateSubscribers: new Set(),
    altBufferListeners: new Set(),
    listeners: [],
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
    deferredOutput: [],
    scrollbackRestoreState: "none",
    attachGeneration: 0,
    attachRevealToken: 0,
    isHibernated: false,
    hibernationTimer: undefined,
    ipcListenerCount: 0,
    ...overrides,
  } as ManagedTerminal;
}

function makeMockDeps(managed?: ManagedTerminal): HibernationManagerDeps {
  const store = new Map<string, ManagedTerminal>();
  if (managed) store.set("t1", managed);
  return {
    getInstance: (id) => store.get(id),
    destroyRestoreState: vi.fn(),
    resetBufferedOutput: vi.fn(),
    releaseWebGL: vi.fn(),
    clearResizeJob: vi.fn(),
    clearSettledTimer: vi.fn(),
    applyDeferredResize: vi.fn(),
    drawDataLossMarker: vi.fn(),
    ensureDeferredAddons: vi.fn(),
    onHibernationChanged: vi.fn(),
    getIsBackgrounded: vi.fn(() => false),
    onBufferModeChange: vi.fn(),
    isWebGLActive: vi.fn(() => false),
    notifyParsed: vi.fn(),
    scrollToBottomSafe: vi.fn(),
    clearUnseen: vi.fn(),
    updateScrollState: vi.fn(),
    setCachedSelection: vi.fn(),
    deleteCachedSelection: vi.fn(),
    getCachedSelection: vi.fn(() => undefined),
    getBracketedPasteMode: vi.fn(() => false),
    isDisposed: vi.fn(() => false),
    isInputLocked: vi.fn(() => false),
    notifyUserInput: vi.fn(),
    clearDirectingState: vi.fn(),
    onUserInput: vi.fn(),
    onEnterPressed: vi.fn(),
    updateLastObservedTitle: vi.fn(),
    notifyXtermFocused: vi.fn(),
  };
}

function connectHost(hostElement: HTMLDivElement, width: number, height: number): void {
  document.body.appendChild(hostElement);
  Object.defineProperty(hostElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(hostElement, "clientHeight", { value: height, configurable: true });
}

describe("TerminalHibernationManager adversarial", () => {
  let manager: TerminalHibernationManager;
  let deps: HibernationManagerDeps;
  let managed: ManagedTerminal;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    (window as unknown as { electron?: unknown }).electron = {
      terminal: {
        reportTitleState: vi.fn(),
        updateObservedTitle: vi.fn(),
      },
      clipboard: {
        writeSelection: vi.fn().mockResolvedValue(undefined),
        readSelection: vi.fn().mockResolvedValue({ text: "" }),
      },
    };

    freshTerminalCtor.mockClear();
    freshTerminalOpenMock.mockReset();
    freshTerminalOnKey.mockReset();
    freshTerminalOnTitleChange.mockReset();
    freshTerminalOnWriteParsed.mockReset();
    freshTerminalOnKey.mockImplementation(() => ({ dispose: vi.fn() }));
    freshTerminalOnTitleChange.mockImplementation(() => ({ dispose: vi.fn() }));
    freshTerminalOnWriteParsed.mockImplementation(() => ({ dispose: vi.fn() }));

    managed = makeMockManaged();
    deps = makeMockDeps(managed);
    manager = new TerminalHibernationManager(deps);
  });

  it("HIBERNATE_DURING_ATTACH_LEAVES_CONSISTENT_STATE", () => {
    const ipcListenerA = vi.fn();
    const ipcListenerB = vi.fn();
    const terminalListener = vi.fn();
    managed = makeMockManaged({
      hostElement: document.createElement("div"),
      isAttaching: true,
      ipcListenerCount: 2,
      listeners: [ipcListenerA, ipcListenerB, terminalListener],
    });
    connectHost(managed.hostElement, 800, 600);
    deps = makeMockDeps(managed);
    manager = new TerminalHibernationManager(deps);

    const hostElement = managed.hostElement;
    const terminalDispose = managed.terminal.dispose;

    manager.hibernate("t1");

    expect(terminalDispose).toHaveBeenCalledTimes(1);
    expect(managed.isOpened).toBe(false);
    expect(managed.isHibernated).toBe(true);
    expect(managed.hostElement).toBe(hostElement);
    expect(managed.hostElement.isConnected).toBe(true);
    expect(managed.listeners).toEqual([ipcListenerA, ipcListenerB]);
  });

  it("DOUBLE_WAKE_ONLY_FIRST_REBUILDS_TERMINAL", () => {
    managed.isHibernated = true;
    managed.isOpened = false;
    connectHost(managed.hostElement, 800, 600);

    manager.unhibernate("t1");
    const rebuiltTerminal = managed.terminal;
    const listenerCountAfterFirstWake = managed.listeners.length;

    manager.unhibernate("t1");

    expect(freshTerminalCtor).toHaveBeenCalledTimes(1);
    expect(freshTerminalOpenMock).toHaveBeenCalledTimes(1);
    expect(managed.terminal).toBe(rebuiltTerminal);
    expect(managed.listeners).toHaveLength(listenerCountAfterFirstWake);
  });

  it("HIBERNATE_AFTER_IMMEDIATE_WAKE_DISPOSES_FRESH", () => {
    const ipcListener = vi.fn();
    managed = makeMockManaged({
      isHibernated: true,
      isOpened: false,
      ipcListenerCount: 1,
      listeners: [ipcListener],
    });
    connectHost(managed.hostElement, 800, 600);
    deps = makeMockDeps(managed);
    manager = new TerminalHibernationManager(deps);

    manager.unhibernate("t1");
    const freshTerminal = managed.terminal;
    manager.hibernate("t1");

    expect(freshTerminal.dispose).toHaveBeenCalledTimes(1);
    expect(managed.isHibernated).toBe(true);
    expect(managed.isOpened).toBe(false);
    expect(managed.listeners).toEqual([ipcListener]);
  });

  it("HIBERNATE_HALF_DISPOSED_NON_FATAL", () => {
    const parserDispose = vi.fn(() => {
      throw new Error("already disposed");
    });
    const markerDispose = vi.fn(() => {
      throw new Error("already disposed");
    });
    const terminalDispose = vi.fn(() => {
      throw new Error("already disposed");
    });
    const ipcListener = vi.fn();
    const terminalListener = vi.fn(() => {
      throw new Error("already disposed");
    });

    managed = makeMockManaged({
      parserHandler: { dispose: parserDispose },
      lastActivityMarker: {
        dispose: markerDispose,
      } as unknown as ManagedTerminal["lastActivityMarker"],
      ipcListenerCount: 1,
      listeners: [ipcListener, terminalListener],
    });
    managed.terminal.dispose = terminalDispose;
    deps = makeMockDeps(managed);
    manager = new TerminalHibernationManager(deps);

    expect(() => manager.hibernate("t1")).not.toThrow();
    expect(managed.isHibernated).toBe(true);
    expect(managed.isOpened).toBe(false);
    expect(managed.parserHandler).toBeUndefined();
    expect(managed.lastActivityMarker).toBeUndefined();
    expect(managed.listeners).toEqual([ipcListener]);
  });

  it("WAKE_ON_REMOVED_OR_ZERO_SIZED_HOST_STAYS_DETACHED", () => {
    managed = makeMockManaged({
      isHibernated: true,
      isOpened: false,
      isDetached: true,
      restoreGeneration: 7,
      lastReflowAt: 42,
    });
    deps = makeMockDeps(managed);
    manager = new TerminalHibernationManager(deps);

    manager.unhibernate("t1");

    expect(freshTerminalCtor).toHaveBeenCalledTimes(1);
    expect(freshTerminalOpenMock).not.toHaveBeenCalled();
    expect(managed.isOpened).toBe(false);
    expect(managed.isDetached).toBe(true);
    expect(managed.restoreGeneration).toBe(8);
    expect(managed.lastReflowAt).toBe(0);
  });

  it("STRANDED_PENDING_WRITES_CLEARED_ON_WAKE_RESTORES_HIBERNATION_ELIGIBILITY", () => {
    // A mid-write dispose (pre-#9912) leaves pendingWrites stranded above
    // zero — the old terminal's write callbacks never fire. The counter must
    // not survive the wake cycle, or hibernation is blocked forever.
    managed = makeMockManaged({
      isHibernated: true,
      isOpened: false,
      pendingWrites: 3, // stranded by a mid-write dispose
    });
    connectHost(managed.hostElement, 800, 600);
    deps = makeMockDeps(managed);
    manager = new TerminalHibernationManager(deps);

    // While stranded, the guard blocks hibernation for ANY terminal shape —
    // verify via the eligibility facade before the wake clears it.
    managed.isHibernated = false;
    expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1")).toBe(
      false
    );
    managed.isHibernated = true;

    manager.unhibernate("t1");
    expect(managed.pendingWrites).toBe(0);

    // With the counter cleared, the terminal is hibernatable again.
    expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1")).toBe(true);
    const wokenTerminal = managed.terminal;
    manager.hibernate("t1");
    expect(managed.isHibernated).toBe(true);
    expect(wokenTerminal.dispose).toHaveBeenCalledTimes(1);
  });

  it("BACKGROUNDED_BYPASS_DROPPED_WHEN_RESTORED_BETWEEN_SCHEDULE_AND_FIRE", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      managed = makeMockManaged({
        runtimeAgentId: "claude",
        canonicalAgentState: "working",
        isVisible: false,
        pendingWrites: 0,
        lastWriteAt: 0, // recent — well inside the silence window
      });
      deps = makeMockDeps(managed);
      // Backgrounded at schedule time → bypass active, normal timer armed.
      (deps.getIsBackgrounded as ReturnType<typeof vi.fn>).mockReturnValue(true);
      manager = new TerminalHibernationManager(deps);

      manager.scheduleHibernation("t1", managed);
      expect(managed.hibernationEligibilityTimer).toBeUndefined();
      expect(managed.hibernationTimer).toBeDefined();

      // User restores the panel before the timer fires: the backgrounded
      // map is cleared, so getIsBackgrounded now reads false live. The agent
      // is still active and within the silence window, so hibernate() must
      // bail rather than tear down a live agent.
      (deps.getIsBackgrounded as ReturnType<typeof vi.fn>).mockReturnValue(false);

      vi.advanceTimersByTime(30_000);

      // hibernate() must not have been attempted — assert the teardown side
      // effects never fired, not just the isHibernated flag (which alone
      // could pass vacuously if hibernate() was never called for any reason).
      expect(managed.isHibernated).toBe(false);
      expect(deps.destroyRestoreState).not.toHaveBeenCalled();
      expect(deps.resetBufferedOutput).not.toHaveBeenCalled();
      expect(managed.terminal.dispose).not.toHaveBeenCalled();
    } finally {
      vi.setSystemTime(new Date());
      vi.useRealTimers();
    }
  });
});
