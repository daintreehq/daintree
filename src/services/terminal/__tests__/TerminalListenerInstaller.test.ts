// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";
import type { ManagedTerminal } from "../types";
import {
  installTerminalBoundListeners,
  wheelEventToLineCount,
  type TerminalListenerInstallDeps,
} from "../TerminalListenerInstaller";

const writeTerminalInputOrFleetMock = vi.hoisted(() => vi.fn());

vi.mock("../fleetInputRouter", () => ({
  writeTerminalInputOrFleet: writeTerminalInputOrFleetMock,
}));

const isLinuxMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("@/lib/platform", () => ({
  isLinux: isLinuxMock,
  isMac: vi.fn(() => false),
}));

const installLinuxPrimarySelectionListenersMock = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock("../primarySelection", () => ({
  installLinuxPrimarySelectionListeners: installLinuxPrimarySelectionListenersMock,
}));

const getEffectiveAgentConfigMock = vi.hoisted(() => vi.fn());

vi.mock("@shared/config/agentRegistry", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getEffectiveAgentConfig: (...args: unknown[]) => getEffectiveAgentConfigMock(...args),
  };
});

vi.mock("@/clients", () => ({
  terminalClient: { write: vi.fn() },
}));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

interface CapturedCallbacks {
  onData?: (data: string) => void;
  onKey?: (event: { domEvent: Partial<KeyboardEvent> }) => void;
  onTitleChangeHandlers: Array<(title: string) => void>;
  onWriteParsed?: () => void;
  onSelectionChange?: () => void;
  onScroll?: () => void;
  onRender?: () => void;
  wheelHandler?: (event: WheelEvent) => boolean;
}

// xterm exposes `element` as readonly; the mock keeps it writable and wide-typed
// (via a function boundary, so it isn't narrowed to `undefined`) so DOM-snap
// tests can assign a real rows container without a type assertion.
const emptyMockElement = (): HTMLElement | undefined => undefined;

function makeMockTerminal(captured: CapturedCallbacks) {
  return {
    element: emptyMockElement(),
    options: { scrollback: 5000 },
    rows: 24,
    cols: 80,
    modes: { bracketedPasteMode: false, mouseTrackingMode: "none" as const },
    // Rendered cell dimensions read by getXtermCellDimensions(): a 20px cell
    // height makes the wheel normalizer's px-per-line basis exactly 20, the
    // value the amplifier/normalizer tests are written against.
    _core: { _renderService: { dimensions: { css: { cell: { width: 9, height: 20 } } } } },
    buffer: {
      active: { length: 0, type: "normal", baseY: 0, viewportY: 0 },
      onBufferChange: vi.fn(() => ({ dispose: vi.fn() })),
    },
    parser: {
      registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })),
    },
    attachCustomWheelEventHandler: vi.fn((handler: (event: WheelEvent) => boolean) => {
      captured.wheelHandler = handler;
    }),
    dispose: vi.fn(),
    onData: vi.fn((cb: (data: string) => void) => {
      captured.onData = cb;
      return { dispose: vi.fn() };
    }),
    onKey: vi.fn((cb: (event: { domEvent: Partial<KeyboardEvent> }) => void) => {
      captured.onKey = cb;
      return { dispose: vi.fn() };
    }),
    onScroll: vi.fn((cb: () => void) => {
      captured.onScroll = cb;
      return { dispose: vi.fn() };
    }),
    onWriteParsed: vi.fn((cb: () => void) => {
      captured.onWriteParsed = cb;
      return { dispose: vi.fn() };
    }),
    onSelectionChange: vi.fn((cb: () => void) => {
      captured.onSelectionChange = cb;
      return { dispose: vi.fn() };
    }),
    onRender: vi.fn((cb: () => void) => {
      captured.onRender = cb;
      return { dispose: vi.fn() };
    }),
    onTitleChange: vi.fn((cb: (title: string) => void) => {
      captured.onTitleChangeHandlers.push(cb);
      return { dispose: vi.fn() };
    }),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ""),
  };
}

function makeMockManaged(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  return {
    kind: "terminal",
    fitAddon: { fit: vi.fn() } as unknown as ManagedTerminal["fitAddon"],
    serializeAddon: { serialize: vi.fn() } as unknown as ManagedTerminal["serializeAddon"],
    imageAddon: null,
    searchAddon: {} as ManagedTerminal["searchAddon"],
    fileLinksDisposable: null,
    webLinksAddon: null,
    hoveredLink: null,
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
    ipcListenerCount: 0,
    ...overrides,
  } as ManagedTerminal;
}

function makeDeps(
  overrides: Partial<TerminalListenerInstallDeps> = {}
): TerminalListenerInstallDeps {
  return {
    onBufferModeChange: vi.fn(),
    isWebGLActive: vi.fn(() => false),
    notifyParsed: vi.fn(),
    scrollToBottomSafe: vi.fn(),
    updateScrollState: vi.fn(),
    clearUnseen: vi.fn(),
    onWriteParsedReflow: vi.fn(),
    setCachedSelection: vi.fn(),
    deleteCachedSelection: vi.fn(),
    getCachedSelection: vi.fn(() => undefined),
    getBracketedPasteMode: vi.fn(() => false),
    isDisposed: vi.fn(() => false),
    isInputLocked: vi.fn(() => false),
    notifyUserInput: vi.fn(),
    clearDirectingState: vi.fn(),
    onUserInput: vi.fn(),
    onActiveWheel: vi.fn(),
    onUserScrollIntent: vi.fn(),
    onEnterPressed: vi.fn(),
    updateLastObservedTitle: vi.fn(),
    notifyXtermFocused: vi.fn(),
    ...overrides,
  };
}

describe("installTerminalBoundListeners", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    isLinuxMock.mockReturnValue(false);
    getEffectiveAgentConfigMock.mockReset();

    (window as unknown as Record<string, unknown>).electron = {
      terminal: {
        reportTitleState: vi.fn(),
        updateObservedTitle: vi.fn(),
      },
      clipboard: {
        writeSelection: vi.fn().mockResolvedValue(undefined),
        readSelection: vi.fn().mockResolvedValue({ text: "" }),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes input through writeTerminalInputOrFleet, not terminalClient.write directly (drift #3 fix)", () => {
    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged();
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );

    expect(captured.onData).toBeDefined();
    captured.onData!("hello");

    expect(writeTerminalInputOrFleetMock).toHaveBeenCalledWith("t1", "hello");
    expect(deps.onUserInput).toHaveBeenCalledWith("t1", "hello");
  });

  it("forwards observed agent titles via window.electron.terminal.updateObservedTitle and panel store (drift #2 fix)", () => {
    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged({ runtimeAgentId: "claude" });
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );

    // Two onTitleChange listeners are installed: the observed-title forwarder
    // and the title-state hysteresis reporter. Both should fire.
    expect(captured.onTitleChangeHandlers.length).toBe(2);

    for (const handler of captured.onTitleChangeHandlers) {
      handler("claude — building feature");
    }
    vi.advanceTimersByTime(150);

    const electron = (
      window as unknown as { electron: { terminal: Record<string, ReturnType<typeof vi.fn>> } }
    ).electron;
    expect(electron.terminal.updateObservedTitle).toHaveBeenCalledWith(
      "t1",
      "claude — building feature"
    );
    expect(deps.updateLastObservedTitle).toHaveBeenCalledWith("t1", "claude — building feature");
  });

  it("installs Linux primary selection listeners when isLinux() returns true (drift #1 fix)", () => {
    isLinuxMock.mockReturnValue(true);

    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged();
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );

    expect(installLinuxPrimarySelectionListenersMock).toHaveBeenCalledTimes(1);
  });

  it("does not install Linux primary selection listeners on non-Linux platforms", () => {
    isLinuxMock.mockReturnValue(false);

    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged();
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );

    expect(installLinuxPrimarySelectionListenersMock).not.toHaveBeenCalled();
  });

  it("reports working title state immediately when matched", () => {
    getEffectiveAgentConfigMock.mockReturnValue({
      detection: {
        titleStatePatterns: { working: ["⏳"], waiting: ["✅"] },
      },
    });

    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged({ runtimeAgentId: "claude" });
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );

    for (const handler of captured.onTitleChangeHandlers) {
      handler("⏳ working on it");
    }

    const electron = (
      window as unknown as { electron: { terminal: Record<string, ReturnType<typeof vi.fn>> } }
    ).electron;
    expect(electron.terminal.reportTitleState).toHaveBeenCalledWith("t1", "working");
  });

  it("debounces waiting title state (250ms hysteresis)", () => {
    getEffectiveAgentConfigMock.mockReturnValue({
      detection: {
        titleStatePatterns: { working: ["⏳"], waiting: ["✅"] },
      },
    });

    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged({ runtimeAgentId: "claude" });
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );

    for (const handler of captured.onTitleChangeHandlers) {
      handler("✅ done");
    }

    const electron = (
      window as unknown as { electron: { terminal: Record<string, ReturnType<typeof vi.fn>> } }
    ).electron;
    expect(electron.terminal.reportTitleState).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);

    expect(electron.terminal.reportTitleState).toHaveBeenCalledWith("t1", "waiting");
  });

  it("invokes onEnterPressed when Enter is pressed without modifiers", () => {
    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged();
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );

    captured.onKey!({ domEvent: { key: "Enter" } as Partial<KeyboardEvent> });
    expect(deps.onEnterPressed).toHaveBeenCalledWith("t1");
  });

  it("does not invoke onEnterPressed when input is locked", () => {
    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged({ isInputLocked: true });
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );

    captured.onKey!({ domEvent: { key: "Enter" } as Partial<KeyboardEvent> });
    expect(deps.onEnterPressed).not.toHaveBeenCalled();
  });

  it("fully suppresses onData when input is locked (no fleet write, no user-input notify, no escape clear)", () => {
    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged({ isInputLocked: true });
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );

    captured.onData!("hello");
    captured.onData!("\x1b");

    expect(writeTerminalInputOrFleetMock).not.toHaveBeenCalled();
    expect(deps.onUserInput).not.toHaveBeenCalled();
    expect(deps.clearDirectingState).not.toHaveBeenCalled();
  });

  it("clears directing state on escape but not on regular input", () => {
    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged();
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );

    captured.onData!("\x1b");
    expect(deps.clearDirectingState).toHaveBeenCalledWith("t1", "escape-key");

    (deps.clearDirectingState as ReturnType<typeof vi.fn>).mockClear();
    captured.onData!("a");
    expect(deps.clearDirectingState).not.toHaveBeenCalled();
  });

  it("invokes onWriteParsedReflow when a parsed write occurs", () => {
    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged();
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );

    captured.onWriteParsed!();
    expect(deps.onWriteParsedReflow).toHaveBeenCalledWith(managed);
  });

  it("populates and clears the cached selection on selection change", () => {
    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged();
    const deps = makeDeps();

    (terminal.getSelection as ReturnType<typeof vi.fn>).mockReturnValueOnce("hello world");
    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );

    captured.onSelectionChange!();
    expect(deps.setCachedSelection).toHaveBeenCalledWith("t1", "hello world");

    (terminal.getSelection as ReturnType<typeof vi.fn>).mockReturnValue("");
    captured.onSelectionChange!();
    expect(deps.deleteCachedSelection).toHaveBeenCalledWith("t1");
  });

  it("invokes notifyXtermFocused when a descendant of the host element receives focus", () => {
    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged();
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    document.body.appendChild(managed.hostElement);
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );

    // Simulate xterm's helper textarea being created during terminal.open() —
    // a focus event on that descendant must bubble up and trigger the listener.
    const helperTextarea = document.createElement("textarea");
    managed.hostElement.appendChild(helperTextarea);
    helperTextarea.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(deps.notifyXtermFocused).toHaveBeenCalledTimes(1);

    document.body.removeChild(managed.hostElement);
  });

  it("removes the focusin listener via the cleanup function", () => {
    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged();
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    document.body.appendChild(managed.hostElement);
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );

    // Run all cleanups (the installer pushes the focusin removal lambda into
    // managed.listeners alongside everything else).
    for (const cleanup of managed.listeners) cleanup();

    const helperTextarea = document.createElement("textarea");
    managed.hostElement.appendChild(helperTextarea);
    helperTextarea.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(deps.notifyXtermFocused).not.toHaveBeenCalled();

    document.body.removeChild(managed.hostElement);
  });

  it("suppresses wheel→arrow translation when an agent terminal is in the alt-screen buffer (issue #6621)", () => {
    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged({ runtimeAgentId: "copilot" });
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );
    // The handler reads `managed.isAltBuffer` live, so mutating it after
    // install mirrors how the real `onBufferChange` listener flips it on
    // CSI ?1049h.
    managed.isAltBuffer = true;

    expect(captured.wheelHandler).toBeDefined();
    expect(captured.wheelHandler!({} as WheelEvent)).toBe(false);
  });

  it("passes wheel events through for plain (non-agent) terminals even when in alt-screen", () => {
    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged();
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );
    managed.isAltBuffer = true;

    expect(captured.wheelHandler!({} as WheelEvent)).toBe(true);
  });

  it("passes wheel events through for agent terminals in the normal buffer", () => {
    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged({ runtimeAgentId: "copilot" });
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );
    // isAltBuffer defaults to false from terminal.buffer.active.type === "normal"

    expect(captured.wheelHandler!({} as WheelEvent)).toBe(true);
  });

  it("passes wheel events through when the TUI has mouse tracking enabled", () => {
    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged({ runtimeAgentId: "crush" });
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );
    managed.isAltBuffer = true;
    // Mutate the captured mode so the live read inside the handler reflects
    // mouse-reporting TUIs that toggle this on after install.
    (terminal.modes as { mouseTrackingMode: string }).mouseTrackingMode = "any";

    expect(captured.wheelHandler!({} as WheelEvent)).toBe(true);
  });

  describe("onUserScrollIntent (#10858)", () => {
    function install() {
      const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
      const terminal = makeMockTerminal(captured);
      const managed = makeMockManaged();
      const deps = makeDeps();

      managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
      installTerminalBoundListeners(
        terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
        managed,
        "t1",
        deps
      );
      return { managed, deps };
    }

    it("fires on an ordinary scrollback wheel event", () => {
      const { managed, deps } = install();

      managed.hostElement.dispatchEvent(new WheelEvent("wheel", { deltaY: 10 }));

      expect(deps.onUserScrollIntent).toHaveBeenCalledWith("t1");
    });

    it.each(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"])(
      "fires on a %s keydown",
      (key) => {
        const { managed, deps } = install();

        managed.hostElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

        expect(deps.onUserScrollIntent).toHaveBeenCalledWith("t1");
      }
    );

    it("does not fire for a non-scroll keydown", () => {
      const { managed, deps } = install();

      managed.hostElement.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));

      expect(deps.onUserScrollIntent).not.toHaveBeenCalled();
    });

    it("does not fire from terminal.onScroll (programmatic auto-scroll guard)", () => {
      const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
      const terminal = makeMockTerminal(captured);
      const managed = makeMockManaged();
      const deps = makeDeps();

      managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
      installTerminalBoundListeners(
        terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
        managed,
        "t1",
        deps
      );

      // Simulate a PTY-output-driven programmatic scroll via xterm's onScroll —
      // must NOT be wired to onUserScrollIntent, or every streaming terminal
      // would stay pinned off efficiency indefinitely (defeats the downgrade).
      captured.onScroll?.();

      expect(deps.onUserScrollIntent).not.toHaveBeenCalled();
    });
  });

  describe("wheel amplification for mouse-tracking TUIs", () => {
    // Wire a real host > xterm element pair so the capture-phase amplifier can
    // intercept a physical wheel and re-dispatch synthetic reports onto the
    // xterm element, exactly as it does in production. Dispatch is paced across
    // animation frames (requestAnimationFrame, faked by the suite's fake timers),
    // so tests drive `flushFrame()` / `flushFrames()` to drain the backlog.

    // The amplifier dispatches one single-line synthetic event per line the
    // helper computes; assert against it so these survive WHEEL_PIXELS_PER_LINE
    // tuning instead of restating the value. A single notch (≤ one frame's cap)
    // drains in one frame.
    const NOTCH_REPORTS = Math.abs(
      wheelEventToLineCount({ deltaY: 120, deltaMode: 0 } as WheelEvent, 24, { partial: 0 })
    );

    function setupAmplifier(opts: {
      mouseTrackingMode: string;
      isAltBuffer: boolean;
      runtimeAgentId?: string;
      cellHeight?: number;
    }) {
      const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
      const terminal = makeMockTerminal(captured);
      if (opts.cellHeight !== undefined) {
        // Override the rendered cell height the px-per-line basis resolves from,
        // so a test can exercise the live-cell-height resolution end to end.
        terminal._core._renderService.dimensions.css.cell.height = opts.cellHeight;
      }
      // The normalizer gate does NOT depend on runtimeAgentId (a plain
      // lazygit/btop terminal must amplify too); default to an agent but let
      // callers clear it to cover the no-agent case.
      const runtimeAgentId = "runtimeAgentId" in opts ? opts.runtimeAgentId : "grok";
      const managed = makeMockManaged({ runtimeAgentId });
      const deps = makeDeps();

      const xtermEl = document.createElement("div");
      managed.hostElement.appendChild(xtermEl);
      (terminal as { element: HTMLElement }).element = xtermEl;
      document.body.appendChild(managed.hostElement);

      managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
      installTerminalBoundListeners(
        terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
        managed,
        "t1",
        deps
      );

      managed.isAltBuffer = opts.isAltBuffer;
      (terminal.modes as { mouseTrackingMode: string }).mouseTrackingMode = opts.mouseTrackingMode;

      // Watch what reaches the xterm element. Synthetic reports arrive in line
      // mode (deltaMode 1); a physical pixel-mode event (deltaMode 0) reaching
      // here would mean the capture listener failed to suppress the original.
      const synthetic: WheelEvent[] = [];
      let leakedOriginal = false;
      xtermEl.addEventListener("wheel", (e) => {
        const we = e as WheelEvent;
        synthetic.push(we);
        if (we.deltaMode === 0) leakedOriginal = true;
      });

      return {
        managed,
        terminal,
        deps,
        xtermEl,
        dispatch: (init: WheelEventInit, target: HTMLElement = managed.hostElement) => {
          const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
          const notCancelled = target.dispatchEvent(ev);
          return { defaultPrevented: !notCancelled };
        },
        runCleanups: () => {
          for (const cleanup of managed.listeners) cleanup();
        },
        // Advance exactly one animation frame's worth of paced dispatch.
        flushFrame: () => vi.advanceTimersToNextFrame(),
        // Drain the whole backlog: advance frames until one produces no new
        // report (the flush only re-arms a frame while lines remain).
        flushFrames: (maxFrames = 128) => {
          for (let i = 0; i < maxFrames; i++) {
            const before = synthetic.length;
            vi.advanceTimersToNextFrame();
            if (synthetic.length === before) break;
          }
        },
        getReports: () => synthetic.length,
        getSynthetic: () => synthetic,
        getLeakedOriginal: () => leakedOriginal,
      };
    }

    afterEach(() => {
      document.querySelectorAll("body > div").forEach((el) => el.remove());
    });

    it("forwards the conventional lines-per-notch for a discrete notch", () => {
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      const { defaultPrevented } = h.dispatch({ deltaY: 120, deltaMode: 0 });
      // preventDefault is synchronous (suppresses xterm immediately) even though
      // the synthetic reports are paced onto the next frame.
      expect(defaultPrevented).toBe(true);
      h.flushFrames();
      // A pixel-mode notch carries no OS lines signal, so we emit a fixed number
      // of line-reports — scrolling matches a normal terminal instead of crawling.
      expect(h.getReports()).toBe(NOTCH_REPORTS);
      // Each synthetic report MUST be a single-line event (deltaMode 1, deltaY 1):
      // xterm sends one mouse report per event, so N 1-line events scroll N lines,
      // whereas one N-line event would under-report (and a deltaY > 1 could
      // over-scroll an app that multiplies). This guards the per-line shape.
      for (const e of h.getSynthetic()) {
        expect(e.deltaMode).toBe(1);
        expect(e.deltaY).toBe(1);
      }
    });

    it("dispatches nothing synchronously — reports are paced onto a later frame", () => {
      // The whole fix: a physical wheel must NOT fan out its lines inline (that
      // round-trips every line at once and floods the PTY). Before any frame
      // runs, zero synthetic reports have been sent.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 120, deltaMode: 0 });
      expect(h.getReports()).toBe(0);
      h.flushFrames();
      expect(h.getReports()).toBe(NOTCH_REPORTS);
    });

    it("emits single-line synthetic events in the scroll direction (downward)", () => {
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: -120, deltaMode: 0 });
      h.flushFrames();
      expect(h.getReports()).toBe(NOTCH_REPORTS);
      for (const e of h.getSynthetic()) {
        expect(e.deltaMode).toBe(1);
        expect(e.deltaY).toBe(-1);
      }
    });

    it.each(["vt200", "drag", "any"] as const)(
      "amplifies under %s mouse tracking (all wheel-reporting modes, not just 'any')",
      (mouseTrackingMode) => {
        const h = setupAmplifier({ mouseTrackingMode, isAltBuffer: true });
        h.dispatch({ deltaY: 120, deltaMode: 0 });
        h.flushFrames();
        expect(h.getReports()).toBe(NOTCH_REPORTS);
      }
    );

    it("amplifies for a plain no-agent mouse-tracking TUI (lazygit/btop)", () => {
      // The gate keys on alt buffer + mouse tracking, not runtimeAgentId, so a
      // TUI launched directly in a shell must still get smooth scrolling.
      const h = setupAmplifier({
        mouseTrackingMode: "any",
        isAltBuffer: true,
        runtimeAgentId: undefined,
      });
      h.dispatch({ deltaY: 120, deltaMode: 0 });
      h.flushFrames();
      expect(h.getReports()).toBe(NOTCH_REPORTS);
    });

    it("accumulates fine/trackpad motion instead of dropping it", () => {
      // 10px against the 20px/line budget = half a line per event; xterm would
      // damp this to zero and send nothing. One event registers nothing yet, but
      // the carried remainder makes the second cross a line boundary — every
      // scroll counts.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 10, deltaMode: 0 });
      h.flushFrames();
      expect(h.getReports()).toBe(0);
      h.dispatch({ deltaY: 10, deltaMode: 0 });
      h.flushFrames();
      expect(h.getReports()).toBe(1);
    });

    it("delivers a page-mode fling's full screenful, paced across frames", () => {
      // A page event normalizes to one screenful (terminal.rows). Pacing must
      // still deliver every line — just spread over frames, not in one burst.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 1, deltaMode: 2 });
      h.flushFrames();
      expect(h.getReports()).toBe(24); // terminal.rows — full screenful, nothing dropped
    });

    it("paces a large fling across multiple frames rather than dispatching it at once", () => {
      // The flood guard: one frame may dispatch only a bounded slice of a
      // screenful-sized backlog; the rest drains on following frames. Asserted
      // structurally (first frame < total, full drain === total) so it survives
      // per-frame-cap tuning without restating the constant.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 1, deltaMode: 2 }); // one screenful (24 lines) pending
      h.flushFrame();
      const firstFrame = h.getReports();
      expect(firstFrame).toBeGreaterThan(0);
      expect(firstFrame).toBeLessThan(24);
      h.flushFrames();
      expect(h.getReports()).toBe(24);
    });

    it("coalesces several wheel events arriving before a frame into one paced drain", () => {
      // Many physical events in a single frame (a momentum stream) accumulate
      // into one backlog and drain at the per-frame cap — not one synchronous
      // burst per event. Three notches (18 lines) queue with zero sync dispatch,
      // the first frame stays capped below the total, and all 18 still arrive.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 120, deltaMode: 0 });
      h.dispatch({ deltaY: 120, deltaMode: 0 });
      h.dispatch({ deltaY: 120, deltaMode: 0 });
      expect(h.getReports()).toBe(0); // nothing dispatched synchronously
      h.flushFrame();
      expect(h.getReports()).toBeLessThan(3 * NOTCH_REPORTS); // first frame is capped
      h.flushFrames();
      expect(h.getReports()).toBe(3 * NOTCH_REPORTS); // every line still delivered
    });

    it("drops stale opposite-direction backlog on reversal", () => {
      // Mid-drain, a direction flip must scroll the new way immediately instead
      // of first cancelling un-dispatched travel. After one frame of a downward
      // fling, an upward notch should truncate the remaining downward backlog.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 1, deltaMode: 2 }); // 24 lines down pending
      h.flushFrame(); // dispatch one capped slice downward, backlog remains
      h.dispatch({ deltaY: -120, deltaMode: 0 }); // reverse: an upward notch
      h.flushFrames();
      const down = h.getSynthetic().filter((e) => e.deltaY > 0).length;
      const up = h.getSynthetic().filter((e) => e.deltaY < 0).length;
      // The downward fling was cut short (never reached its full screenful)...
      expect(down).toBeGreaterThan(0);
      expect(down).toBeLessThan(24);
      // ...and the upward notch was delivered in full.
      expect(up).toBe(NOTCH_REPORTS);
      // No downward report after the first upward one (stale backlog was dropped).
      const firstUp = h.getSynthetic().findIndex((e) => e.deltaY < 0);
      expect(
        h
          .getSynthetic()
          .slice(firstUp)
          .every((e) => e.deltaY < 0)
      ).toBe(true);
    });

    it("halts the coast on a sub-line reversal (first reverse event is < one line)", () => {
      // A trackpad reversal's first event is usually below the px-per-line budget,
      // so wheelEventToLineCount yields 0. The stale downward backlog must still
      // be cancelled by the raw direction flip — otherwise the view keeps coasting
      // down for several frames after the user has started scrolling up.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 1, deltaMode: 2 }); // 24 lines down pending
      h.flushFrame();
      const afterFirstFrame = h.getReports();
      expect(afterFirstFrame).toBeGreaterThan(0);
      expect(afterFirstFrame).toBeLessThan(24); // backlog still pending
      h.dispatch({ deltaY: -10, deltaMode: 0 }); // sub-line upward flick (0 lines)
      h.flushFrames();
      expect(h.getReports()).toBe(afterFirstFrame); // coast stopped — no more reports
      expect(h.getSynthetic().every((e) => e.deltaY > 0)).toBe(true); // none upward yet
    });

    it("drops queued reports if the pane leaves the alt buffer mid-drain", () => {
      // A multi-frame drain can outlast the mouse-reporting context. Once the TUI
      // exits the alt screen, the queued synthetic wheels must not keep firing
      // (they would leak into arrow-key fallback or normal-buffer scroll).
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 1, deltaMode: 2 }); // one screenful pending
      h.flushFrame();
      const afterFirstFrame = h.getReports();
      expect(afterFirstFrame).toBeGreaterThan(0);
      expect(afterFirstFrame).toBeLessThan(24); // backlog still pending
      h.managed.isAltBuffer = false; // TUI left the alt screen mid-drain
      h.flushFrames();
      expect(h.getReports()).toBe(afterFirstFrame); // nothing further dispatched
    });

    it("re-clamps the backlog to the current row count after a mid-drain shrink", () => {
      // The backlog cap scales with rows. A pane that shrinks mid-drain must not
      // keep draining the larger pre-resize queue; the remaining backlog is
      // re-clamped to the smaller viewport so it can't coast far past the gesture.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 1, deltaMode: 2 }); // one 24-row screenful pending
      h.flushFrame();
      expect(h.getReports()).toBeLessThan(24); // still draining
      (h.terminal as { rows: number }).rows = 1; // pane collapses mid-drain
      h.flushFrames();
      // Without the flush-time re-clamp the full 24-line queue would still drain.
      expect(h.getReports()).toBeLessThan(24);
    });

    it("does not intervene when the app has no mouse tracking", () => {
      const h = setupAmplifier({ mouseTrackingMode: "none", isAltBuffer: true });
      const { defaultPrevented } = h.dispatch({ deltaY: 120, deltaMode: 0 });
      h.flushFrames();
      expect(h.getReports()).toBe(0);
      expect(defaultPrevented).toBe(false);
    });

    it("does not intervene in the normal buffer", () => {
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: false });
      const { defaultPrevented } = h.dispatch({ deltaY: 120, deltaMode: 0 });
      h.flushFrames();
      expect(h.getReports()).toBe(0);
      // The physical wheel is left intact so xterm's viewport scrollback runs.
      expect(defaultPrevented).toBe(false);
    });

    it("passes modified wheels (ctrl-zoom etc.) through unchanged", () => {
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      const { defaultPrevented } = h.dispatch({ deltaY: 120, deltaMode: 0, ctrlKey: true });
      h.flushFrames();
      expect(h.getReports()).toBe(0);
      expect(defaultPrevented).toBe(false);
    });

    it("leaves x10 (click-only) mode alone so synthetic wheels can't become arrow keys", () => {
      // x10 reports mousedown only; xterm drops wheel reports for it, so taking
      // over would route synthetic wheels through the arrow-key fallback.
      const h = setupAmplifier({ mouseTrackingMode: "x10", isAltBuffer: true });
      const { defaultPrevented } = h.dispatch({ deltaY: 120, deltaMode: 0 });
      h.flushFrames();
      expect(h.getReports()).toBe(0);
      expect(defaultPrevented).toBe(false);
    });

    it("suppresses the physical wheel and forwards only synthetic reports (no leak/recursion)", () => {
      // Dispatch the physical event from the xterm element itself: the capture
      // listener on the host must stop it before it reaches xterm's own
      // bubble-phase listener, while the tagged synthetic events still arrive.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 120, deltaMode: 0 }, h.xtermEl);
      h.flushFrames();
      expect(h.getReports()).toBe(NOTCH_REPORTS); // one single-line report per line
      expect(h.getLeakedOriginal()).toBe(false); // original pixel-mode event was stopped
    });

    it("stops intercepting once the listeners are cleaned up", () => {
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.runCleanups();
      const { defaultPrevented } = h.dispatch({ deltaY: 120, deltaMode: 0 });
      h.flushFrames();
      expect(h.getReports()).toBe(0);
      expect(defaultPrevented).toBe(false);
    });

    it("cancels a pending frame on cleanup so a queued drain never dispatches late", () => {
      // A wheel arrives (arming a frame), then the pane is torn down before the
      // frame runs. The cancelled frame must not fire stray reports at a
      // disposed terminal.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 120, deltaMode: 0 });
      expect(h.getReports()).toBe(0); // still queued, not yet flushed
      h.runCleanups();
      h.flushFrames();
      expect(h.getReports()).toBe(0); // queued drain was cancelled
    });

    it("paces a trackpad fling more gently per frame than an equivalent wheel fling", () => {
      // The device-aware send-rate cap: a trackpad's momentum stream (the gesture
      // that actually floods the PTY round-trip) drains fewer lines per frame than
      // a physical wheel's discrete detents, even for the same total distance.
      const wheel = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      wheel.dispatch({ deltaX: 0, deltaY: 240, deltaMode: 0 }); // integer single-axis → wheel
      wheel.flushFrame();
      const wheelFirstFrame = wheel.getReports();

      const trackpad = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      trackpad.dispatch({ deltaX: 6, deltaY: 240.5, deltaMode: 0 }); // dual-axis fractional → trackpad
      trackpad.flushFrame();
      const trackpadFirstFrame = trackpad.getReports();

      expect(trackpadFirstFrame).toBeGreaterThan(0);
      expect(trackpadFirstFrame).toBeLessThan(wheelFirstFrame);
      // Pacing changes the per-frame rate, not the total: both devices deliver the
      // same gesture in full (same distance ⇒ same line count), just spread
      // differently across frames.
      wheel.flushFrames();
      trackpad.flushFrames();
      expect(trackpad.getReports()).toBe(wheel.getReports());
      expect(wheel.getReports()).toBeGreaterThan(wheelFirstFrame);
    });

    it("re-detects the device after an idle gap (stale wheel history doesn't pin the cap)", () => {
      // The classifier is reset at a gesture boundary, so a trackpad gesture that
      // follows a long pause after wheel scrolling is paced by the TRACKPAD cap on
      // its very first frame — not the leftover physical-wheel verdict. Compared
      // against the same sequence with no gap, where the rolling history still
      // reads as a wheel.
      function trackpadFirstFrameAfterWheel(gapMs: number): number {
        const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
        // Fill the classifier with a physical-wheel streak and let it drain.
        for (let i = 0; i < 5; i++) h.dispatch({ deltaX: 0, deltaY: 120, deltaMode: 0 });
        h.flushFrames();
        const drained = h.getReports();
        vi.advanceTimersByTime(gapMs);
        // Now a trackpad fling (dual-axis fractional).
        h.dispatch({ deltaX: 6, deltaY: 240.5, deltaMode: 0 });
        h.flushFrame();
        return h.getReports() - drained;
      }
      const afterGap = trackpadFirstFrameAfterWheel(1000); // gesture boundary → reset
      const noGap = trackpadFirstFrameAfterWheel(0); // continuous → wheel history persists
      expect(afterGap).toBeLessThan(noGap);
    });

    it("preserves sub-line carry across an idle gap (slow scrolling still accumulates)", () => {
      // The gap resets the device/backlog but NOT the lossless pixel carry: two
      // sub-line nudges separated by a long pause must still combine into a line,
      // otherwise a slow hi-res wheel would scroll nothing.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 10, deltaMode: 0 }); // half a line (20px basis), carried
      h.flushFrames();
      expect(h.getReports()).toBe(0);

      vi.advanceTimersByTime(1000); // a clearly human-idle pause

      h.dispatch({ deltaY: 10, deltaMode: 0 }); // resume same direction
      h.flushFrames();
      expect(h.getReports()).toBe(1); // the two halves still crossed a line boundary
    });

    it("signals onActiveWheel only when a real scroll is forwarded, not for sub-line motion", () => {
      // onActiveWheel drives the renderer BURST boost + resource-profile hold,
      // so it must fire on a forwarded scroll (lines !== 0) and stay silent for a
      // sub-line nudge that forwards nothing.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 10, deltaMode: 0 }); // half a line (20px basis) → no forward
      expect(h.deps.onActiveWheel).not.toHaveBeenCalled();
      h.dispatch({ deltaY: 120, deltaMode: 0 }); // a real notch → forwarded
      expect(h.deps.onActiveWheel).toHaveBeenCalledWith("t1");
    });

    it("does not signal onActiveWheel when it does not take over the wheel", () => {
      // Normal buffer (no mouse-reporting TUI): the wheel passes through to
      // xterm's own scrollback, so no boost is requested.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: false });
      h.dispatch({ deltaY: 120, deltaMode: 0 });
      expect(h.deps.onActiveWheel).not.toHaveBeenCalled();
    });

    it("clears a single notch within one frame and adds nothing on the next", () => {
      // A discrete notch (below the per-frame cap) must not be split across frames
      // — it should land whole on the first frame, then the next frame is a no-op.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 120, deltaMode: 0 });
      h.flushFrame();
      const afterOneFrame = h.getReports();
      expect(afterOneFrame).toBe(NOTCH_REPORTS); // all of the notch, in one frame
      h.flushFrame();
      expect(h.getReports()).toBe(afterOneFrame); // nothing left to drain
    });

    it("resolves lines from the live rendered cell height (bigger cell ⇒ fewer lines)", () => {
      // End-to-end through the real handler: the px-per-line basis is the rendered
      // cell height, so the SAME 120px gesture yields fewer line reports on a
      // taller cell. Guards the getXtermCellDimensions resolution path.
      const tall = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true, cellHeight: 40 });
      tall.dispatch({ deltaY: 120, deltaMode: 0 });
      tall.flushFrames();

      const short = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true, cellHeight: 10 });
      short.dispatch({ deltaY: 120, deltaMode: 0 });
      short.flushFrames();

      expect(tall.getReports()).toBeGreaterThan(0);
      expect(tall.getReports()).toBeLessThan(short.getReports()); // 120/40 < 120/10
    });
  });

  it("registers the same listener count on every call (idempotent shape)", () => {
    const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal = makeMockTerminal(captured);
    const managed = makeMockManaged();
    const deps = makeDeps();

    managed.terminal = terminal as unknown as ManagedTerminal["terminal"];
    installTerminalBoundListeners(
      terminal as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed,
      "t1",
      deps
    );
    const firstCount = managed.listeners.length;

    const captured2: CapturedCallbacks = { onTitleChangeHandlers: [] };
    const terminal2 = makeMockTerminal(captured2);
    const managed2 = makeMockManaged();
    managed2.terminal = terminal2 as unknown as ManagedTerminal["terminal"];

    installTerminalBoundListeners(
      terminal2 as unknown as Parameters<typeof installTerminalBoundListeners>[0],
      managed2,
      "t2",
      deps
    );

    expect(managed2.listeners.length).toBe(firstCount);
  });

  describe("DOM zebra-banding integer row-height snap (#10768)", () => {
    function makeRowsElement(cellHeightCss: string, rowCount: number): HTMLElement {
      const element = document.createElement("div");
      const rows = document.createElement("div");
      rows.className = "xterm-rows";
      for (let i = 0; i < rowCount; i++) {
        const row = document.createElement("div");
        row.style.height = cellHeightCss;
        row.style.lineHeight = cellHeightCss;
        rows.appendChild(row);
      }
      element.appendChild(rows);
      return element;
    }

    function rowHeights(element: HTMLElement): number[] {
      const rows = element.querySelector(".xterm-rows")!.children;
      return Array.from(rows).map((r) => parseFloat((r as HTMLElement).style.height));
    }

    function install(
      terminal: ReturnType<typeof makeMockTerminal>,
      deps: TerminalListenerInstallDeps
    ) {
      const managed = makeMockManaged();
      const asXterm = terminal as unknown as ManagedTerminal["terminal"];
      managed.terminal = asXterm;
      installTerminalBoundListeners(asXterm, managed, "t1", deps);
    }

    it("snaps fractional row heights to integers that sum exactly to the canvas height", () => {
      const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
      const terminal = makeMockTerminal(captured);
      // 691px canvas / 40 rows = 17.275px fractional cell height.
      const element = makeRowsElement("17.275px", 40);
      terminal.element = element;
      const deps = makeDeps();

      install(terminal, deps);
      captured.onRender!();

      const heights = rowHeights(element);
      // Every row is an integer pixel value.
      expect(heights.every((h) => Number.isInteger(h))).toBe(true);
      // No drift: snapped heights sum back to the integer canvas height.
      expect(heights.reduce((a, b) => a + b, 0)).toBe(Math.round(17.275 * 40));
      // Distributed, not uniform: a fractional cell needs a mix of two heights.
      expect(new Set(heights).size).toBe(2);
      // lineHeight is snapped in lockstep with height.
      const rows = element.querySelector(".xterm-rows")!.children;
      for (const r of Array.from(rows)) {
        const el = r as HTMLElement;
        expect(el.style.lineHeight).toBe(el.style.height);
      }
    });

    it("does not touch row heights when the pane is on the WebGL renderer", () => {
      const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
      const terminal = makeMockTerminal(captured);
      const element = makeRowsElement("17.275px", 40);
      terminal.element = element;
      const deps = makeDeps({ isWebGLActive: vi.fn(() => true) });

      install(terminal, deps);
      captured.onRender!();

      expect(rowHeights(element).every((h) => h === 17.275)).toBe(true);
    });

    it("leaves already-integer row heights untouched (idempotent)", () => {
      const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
      const terminal = makeMockTerminal(captured);
      const element = makeRowsElement("18px", 40);
      terminal.element = element;
      const deps = makeDeps();

      install(terminal, deps);
      captured.onRender!();

      expect(rowHeights(element).every((h) => h === 18)).toBe(true);
    });

    it("is idempotent across repeated renders", () => {
      const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
      const terminal = makeMockTerminal(captured);
      const element = makeRowsElement("17.275px", 40);
      terminal.element = element;
      const deps = makeDeps();

      install(terminal, deps);
      captured.onRender!();
      const first = rowHeights(element);
      captured.onRender!();
      const second = rowHeights(element);

      expect(second).toEqual(first);
    });

    it("no-ops when the terminal element is not yet attached", () => {
      const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
      const terminal = makeMockTerminal(captured);
      // No `element` set — terminal.open() hasn't run.
      const deps = makeDeps();

      install(terminal, deps);
      expect(() => captured.onRender!()).not.toThrow();
    });

    it("no-ops on an empty row list", () => {
      const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
      const terminal = makeMockTerminal(captured);
      terminal.element = makeRowsElement("17.275px", 0);
      const deps = makeDeps();

      install(terminal, deps);
      expect(() => captured.onRender!()).not.toThrow();
    });

    it("starts snapping only after the pane swaps WebGL → DOM (gate flips live)", () => {
      const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
      const terminal = makeMockTerminal(captured);
      const element = makeRowsElement("17.275px", 40);
      terminal.element = element;
      // WebGL active at install + first render → no snap (the production state
      // before a fleet DOM-mode flip / breaker trip).
      const isWebGLActive = vi.fn(() => true);
      const deps = makeDeps({ isWebGLActive });

      install(terminal, deps);
      captured.onRender!();
      expect(rowHeights(element).every((h) => h === 17.275)).toBe(true);

      // Pane swaps to the DOM renderer — the next render snaps.
      isWebGLActive.mockReturnValue(false);
      captured.onRender!();
      expect(rowHeights(element).every((h) => Number.isInteger(h))).toBe(true);
    });

    it("assigns one uniform integer height when the canvas rounds to an exact multiple (extra=0)", () => {
      const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
      const terminal = makeMockTerminal(captured);
      // 17.99px * 40 = 719.6 → round 720 = 18 * 40, so base 18, extra 0: every
      // row gets the same integer height, with no Bresenham distribution.
      const element = makeRowsElement("17.99px", 40);
      terminal.element = element;
      const deps = makeDeps();

      install(terminal, deps);
      captured.onRender!();

      const heights = rowHeights(element);
      expect(new Set(heights).size).toBe(1);
      expect(heights[0]).toBe(18);
      expect(heights.reduce((a, b) => a + b, 0)).toBe(720);
    });

    it("no-ops when the row height is unparseable", () => {
      const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
      const terminal = makeMockTerminal(captured);
      const element = makeRowsElement("auto", 40);
      terminal.element = element;
      const deps = makeDeps();

      install(terminal, deps);
      captured.onRender!();

      // "auto" stays as-is (parseFloat → NaN, guarded out).
      const rows = element.querySelector(".xterm-rows")!.children;
      expect((rows[0] as HTMLElement).style.height).toBe("auto");
    });
  });
});

describe("wheelEventToLineCount", () => {
  const ev = (deltaY: number, deltaMode: number): WheelEvent =>
    ({ deltaY, deltaMode }) as unknown as WheelEvent;

  it("forwards DOM_DELTA_LINE deltas as whole lines (the OS wheel step)", () => {
    expect(wheelEventToLineCount(ev(3, 1), 24, { partial: 0 })).toBe(3);
    expect(wheelEventToLineCount(ev(1, 1), 24, { partial: 0 })).toBe(1);
  });

  it("scrolls one screenful per page-mode event, in the event's direction", () => {
    // DOM_DELTA_PAGE => a full viewport, sign-following, regardless of rows.
    expect(wheelEventToLineCount(ev(1, 2), 24, { partial: 0 })).toBe(24);
    expect(wheelEventToLineCount(ev(-1, 2), 24, { partial: 0 })).toBe(-24);
    expect(wheelEventToLineCount(ev(1, 2), 10, { partial: 0 })).toBe(10);
  });

  it("scrolls several lines for a single discrete pixel notch", () => {
    // A ~120px detent is one physical notch; at the 20px/line budget it moves a
    // brisk handful of lines rather than crawling one at a time. Canonical
    // value; the tests below pin the surrounding invariants relationally so they
    // survive retuning the budget.
    expect(wheelEventToLineCount(ev(120, 0), 24, { partial: 0 })).toBe(6);
  });

  it("converts pixels at the supplied cell-height basis, inversely to cell size", () => {
    // The px-per-line basis is the live rendered cell height, not a constant. The
    // same 120px gesture must scroll proportionally fewer lines as the basis grows
    // (line count × basis ≈ the pixel distance), and halving the basis doubles the
    // lines — a relationship, not a pinned literal.
    const at10 = wheelEventToLineCount(ev(120, 0), 99, { partial: 0 }, 10);
    const at20 = wheelEventToLineCount(ev(120, 0), 99, { partial: 0 }, 20);
    const at40 = wheelEventToLineCount(ev(120, 0), 99, { partial: 0 }, 40);
    expect(at10).toBe(at20 * 2);
    expect(at20).toBe(at40 * 2);
    expect(at20 * 20).toBe(120); // basis × lines recovers the gesture distance
  });

  it("falls back to the default basis for a non-positive pixelsPerLine", () => {
    // A zero/negative basis (e.g. a degenerate cell measurement) must not divide
    // by zero or invert the sign — it behaves exactly as if the arg were omitted.
    const omitted = wheelEventToLineCount(ev(120, 0), 99, { partial: 0 });
    expect(wheelEventToLineCount(ev(120, 0), 99, { partial: 0 }, 0)).toBe(omitted);
    expect(wheelEventToLineCount(ev(120, 0), 99, { partial: 0 }, -5)).toBe(omitted);
  });

  it("ignores pixelsPerLine for line-mode and page-mode events", () => {
    // Only pixel-mode (deltaMode 0) events divide by the basis; line/page events
    // carry the OS step already, so a wildly different basis must not change them.
    expect(wheelEventToLineCount(ev(3, 1), 24, { partial: 0 }, 7)).toBe(3); // line mode
    expect(wheelEventToLineCount(ev(1, 2), 24, { partial: 0 }, 7)).toBe(24); // page mode → rows
  });

  it("scrolls clearly more than a single line per notch (the dead-scroll fix)", () => {
    // The original point of the amplifier: a notch must move more than one line
    // so it doesn't feel like only every few clicks register. Relationship, not
    // literal.
    expect(wheelEventToLineCount(ev(120, 0), 24, { partial: 0 })).toBeGreaterThan(1);
  });

  it("scrolls proportionally to pixel magnitude — coalesced detents aren't dropped", () => {
    // The bug this replaced: any pixel event >=40px scrolled a FLAT line count,
    // so when Chromium coalesces several physical detents into one large-delta
    // event the extra detents were silently eaten. Proportionality is the fix —
    // 2x/3x the pixels scrolls 2x/3x the lines (large rows so the clamp doesn't
    // mask it), and a coalesced multi-detent event scrolls strictly more than a
    // single detent.
    const one = wheelEventToLineCount(ev(120, 0), 999, { partial: 0 });
    const two = wheelEventToLineCount(ev(240, 0), 999, { partial: 0 });
    const three = wheelEventToLineCount(ev(360, 0), 999, { partial: 0 });
    expect(two).toBe(2 * one);
    expect(three).toBe(3 * one);
    expect(three).toBeGreaterThan(one);
  });

  it("scrolls momentum-sized deltas by distance, not a flat amount per event", () => {
    // macOS inertial scrolling emits a stream of medium continuous deltas. The
    // old rule amplified EACH to a flat 6 lines, running away into overscroll;
    // now the per-event count tracks the per-event distance.
    const small = wheelEventToLineCount(ev(40, 0), 999, { partial: 0 });
    const large = wheelEventToLineCount(ev(200, 0), 999, { partial: 0 });
    expect(large).toBeGreaterThan(small);
  });

  it("preserves scroll direction symmetrically (down === -up)", () => {
    const up = wheelEventToLineCount(ev(120, 0), 24, { partial: 0 });
    const down = wheelEventToLineCount(ev(-120, 0), 24, { partial: 0 });
    expect(down).toBe(-up);
  });

  it("clamps a pixel event to at most one screenful of lines, both directions", () => {
    // A huge fling (or a coalesced burst) never scrolls past a short viewport.
    expect(wheelEventToLineCount(ev(120, 0), 2, { partial: 0 })).toBe(2);
    expect(wheelEventToLineCount(ev(-120, 0), 2, { partial: 0 })).toBe(-2);
    expect(wheelEventToLineCount(ev(99999, 0), 24, { partial: 0 })).toBe(24);
  });

  it("returns zero for a zero delta", () => {
    expect(wheelEventToLineCount(ev(0, 0), 24, { partial: 0 })).toBe(0);
  });

  it("carries the sub-line remainder forward instead of discarding it per event", () => {
    // Two 0.5-line (10px) events net one whole line and leave no stray remainder
    // — the accumulator is preserved across events, not reset or truncated each
    // time, so slow scrolling still moves instead of being damped to nothing.
    const carry = { partial: 0 };
    expect(wheelEventToLineCount(ev(10, 0), 24, carry)).toBe(0); // 10px -> 0
    expect(wheelEventToLineCount(ev(10, 0), 24, carry)).toBe(1); // 20px -> 1
    expect(carry.partial).toBeCloseTo(0);
  });

  it("preserves the pixel accumulator across line-mode and page-mode events", () => {
    // Line/page modes return before touching the accumulator, so a partial pixel
    // scroll in progress is neither flushed nor cleared by them — it resumes.
    const carry = { partial: 10 };
    expect(wheelEventToLineCount(ev(3, 1), 24, carry)).toBe(3);
    expect(wheelEventToLineCount(ev(1, 2), 24, carry)).toBe(24);
    expect(carry.partial).toBe(10);
    // 10px carried + 10px now = one line.
    expect(wheelEventToLineCount(ev(10, 0), 24, carry)).toBe(1);
  });

  it("drops a clamped fling's overflow instead of stranding it as a backlog", () => {
    // A huge coalesced burst clamps to one screenful; the un-emitted overflow
    // must NOT pile up in the accumulator, or the terminal would keep scrolling
    // for thousands of lines after the gesture. The next event scrolls only its
    // own distance.
    const carry = { partial: 0 };
    expect(wheelEventToLineCount(ev(99999, 0), 24, carry)).toBe(24);
    expect(wheelEventToLineCount(ev(20, 0), 24, carry)).toBe(1);
  });

  it("sums many small same-direction events to the true gesture distance", () => {
    // A momentum stream of eight 5px deltas covers 40px = exactly two lines, so
    // the run must report two in total — not zero from per-event truncation, nor
    // a flat amount per event. Proportionality across a realistic sequence, and
    // a guard against the float-stranding that pre-divided fractions would cause.
    const carry = { partial: 0 };
    let total = 0;
    for (let i = 0; i < 8; i++) total += wheelEventToLineCount(ev(5, 0), 24, carry);
    expect(total).toBe(2);
  });

  it("registers a reversal immediately instead of cancelling stale forward motion", () => {
    // Forward half a line (no whole line yet), then reverse a full line. Without
    // dropping the stale +0.5 remainder the reversal would net -0.5 → 0 (a dead
    // zone); the sign-change reset makes the reverse line register as -1.
    const carry = { partial: 0 };
    expect(wheelEventToLineCount(ev(10, 0), 24, carry)).toBe(0);
    expect(wheelEventToLineCount(ev(-20, 0), 24, carry)).toBe(-1);
  });
});
