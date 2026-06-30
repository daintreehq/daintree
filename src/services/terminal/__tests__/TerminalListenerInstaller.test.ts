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

  describe("wheel amplification for mouse-tracking TUIs", () => {
    // Wire a real host > xterm element pair so the capture-phase amplifier can
    // intercept a physical wheel and re-dispatch synthetic reports onto the
    // xterm element, exactly as it does in production.

    // The amplifier dispatches one single-line synthetic event per line the
    // helper computes; assert against it so these survive WHEEL_LINES_PER_NOTCH
    // tuning instead of restating the value.
    const NOTCH_REPORTS = Math.abs(
      wheelEventToLineCount({ deltaY: 120, deltaMode: 0 } as WheelEvent, 16, 24, { partial: 0 })
    );

    function setupAmplifier(opts: {
      mouseTrackingMode: string;
      isAltBuffer: boolean;
      fontSize?: number;
      runtimeAgentId?: string;
    }) {
      const captured: CapturedCallbacks = { onTitleChangeHandlers: [] };
      const terminal = makeMockTerminal(captured);
      // The normalizer gate does NOT depend on runtimeAgentId (a plain
      // lazygit/btop terminal must amplify too); default to an agent but let
      // callers clear it to cover the no-agent case.
      const runtimeAgentId = "runtimeAgentId" in opts ? opts.runtimeAgentId : "grok";
      const managed = makeMockManaged({ runtimeAgentId });
      const deps = makeDeps();

      const xtermEl = document.createElement("div");
      managed.hostElement.appendChild(xtermEl);
      (terminal as { element: HTMLElement }).element = xtermEl;
      (terminal.options as Record<string, number>).fontSize = opts.fontSize ?? 16;
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
        xtermEl,
        dispatch: (init: WheelEventInit, target: HTMLElement = managed.hostElement) => {
          const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
          const notCancelled = target.dispatchEvent(ev);
          return { defaultPrevented: !notCancelled };
        },
        runCleanups: () => {
          for (const cleanup of managed.listeners) cleanup();
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
      expect(defaultPrevented).toBe(true);
    });

    it("emits single-line synthetic events in the scroll direction (downward)", () => {
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: -120, deltaMode: 0 });
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
      expect(h.getReports()).toBe(NOTCH_REPORTS);
    });

    it("accumulates fine/trackpad motion instead of dropping it", () => {
      // 8px against a 16px row = half a line per event; xterm would damp this to
      // zero and send nothing. One event registers nothing yet, but the carried
      // remainder makes the second cross a line boundary — every scroll counts.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 8, deltaMode: 0 });
      expect(h.getReports()).toBe(0);
      h.dispatch({ deltaY: 8, deltaMode: 0 });
      expect(h.getReports()).toBe(1);
    });

    it("caps a page-mode fling at one screenful of lines", () => {
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 1, deltaMode: 2 });
      expect(h.getReports()).toBe(24); // terminal.rows
    });

    it("does not intervene when the app has no mouse tracking", () => {
      const h = setupAmplifier({ mouseTrackingMode: "none", isAltBuffer: true });
      const { defaultPrevented } = h.dispatch({ deltaY: 120, deltaMode: 0 });
      expect(h.getReports()).toBe(0);
      expect(defaultPrevented).toBe(false);
    });

    it("does not intervene in the normal buffer", () => {
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: false });
      const { defaultPrevented } = h.dispatch({ deltaY: 120, deltaMode: 0 });
      expect(h.getReports()).toBe(0);
      // The physical wheel is left intact so xterm's viewport scrollback runs.
      expect(defaultPrevented).toBe(false);
    });

    it("passes modified wheels (ctrl-zoom etc.) through unchanged", () => {
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      const { defaultPrevented } = h.dispatch({ deltaY: 120, deltaMode: 0, ctrlKey: true });
      expect(h.getReports()).toBe(0);
      expect(defaultPrevented).toBe(false);
    });

    it("leaves x10 (click-only) mode alone so synthetic wheels can't become arrow keys", () => {
      // x10 reports mousedown only; xterm drops wheel reports for it, so taking
      // over would route synthetic wheels through the arrow-key fallback.
      const h = setupAmplifier({ mouseTrackingMode: "x10", isAltBuffer: true });
      const { defaultPrevented } = h.dispatch({ deltaY: 120, deltaMode: 0 });
      expect(h.getReports()).toBe(0);
      expect(defaultPrevented).toBe(false);
    });

    it("suppresses the physical wheel and forwards only synthetic reports (no leak/recursion)", () => {
      // Dispatch the physical event from the xterm element itself: the capture
      // listener on the host must stop it before it reaches xterm's own
      // bubble-phase listener, while the tagged synthetic events still arrive.
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.dispatch({ deltaY: 120, deltaMode: 0 }, h.xtermEl);
      expect(h.getReports()).toBe(NOTCH_REPORTS); // one single-line report per line
      expect(h.getLeakedOriginal()).toBe(false); // original pixel-mode event was stopped
    });

    it("stops intercepting once the listeners are cleaned up", () => {
      const h = setupAmplifier({ mouseTrackingMode: "any", isAltBuffer: true });
      h.runCleanups();
      const { defaultPrevented } = h.dispatch({ deltaY: 120, deltaMode: 0 });
      expect(h.getReports()).toBe(0);
      expect(defaultPrevented).toBe(false);
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
    expect(wheelEventToLineCount(ev(3, 1), 16, 24, { partial: 0 })).toBe(3);
    expect(wheelEventToLineCount(ev(1, 1), 16, 24, { partial: 0 })).toBe(1);
  });

  it("scrolls a full page for DOM_DELTA_PAGE deltas", () => {
    expect(wheelEventToLineCount(ev(1, 2), 16, 24, { partial: 0 })).toBe(24);
  });

  it("scrolls the tuned lines-per-notch for a discrete pixel notch", () => {
    // A ~120px detent is one notch; pixel mode carries no OS lines signal, so we
    // emit a fixed number of lines (6 — double the conventional default) rather
    // than crawling one. This is the canonical value; the tests below pin the
    // surrounding invariants relationally so they survive retuning.
    expect(wheelEventToLineCount(ev(120, 0), 16, 24, { partial: 0 })).toBe(6);
  });

  it("scrolls clearly more than a single line per notch (the dead-scroll fix)", () => {
    // The whole point of the change: a notch must move more than one line so it
    // doesn't feel like only every few clicks register. Relationship, not literal.
    expect(wheelEventToLineCount(ev(120, 0), 16, 24, { partial: 0 })).toBeGreaterThan(1);
  });

  it("scrolls the same line count for any notch magnitude (magnitude ignored)", () => {
    // One physical detent is one notch whether Chromium reports 40px or 2000px;
    // the count must not scale with pixels — asserting all-equal is the invariant.
    const counts = [40, 120, 240, 2000].map((d) =>
      wheelEventToLineCount(ev(d, 0), 16, 24, { partial: 0 })
    );
    expect(new Set(counts).size).toBe(1);
  });

  it("preserves scroll direction symmetrically (down === -up)", () => {
    const up = wheelEventToLineCount(ev(120, 0), 16, 24, { partial: 0 });
    const down = wheelEventToLineCount(ev(-120, 0), 16, 24, { partial: 0 });
    expect(down).toBe(-up);
  });

  it("clamps a notch to at most one screenful of lines, both directions", () => {
    // A full notch scrolls several lines, but never past a short viewport.
    expect(Math.abs(wheelEventToLineCount(ev(120, 0), 16, 24, { partial: 0 }))).toBeGreaterThan(2);
    expect(wheelEventToLineCount(ev(120, 0), 16, 2, { partial: 0 })).toBe(2);
    expect(wheelEventToLineCount(ev(-120, 0), 16, 2, { partial: 0 })).toBe(-2);
  });

  it("returns zero for a zero delta", () => {
    expect(wheelEventToLineCount(ev(0, 0), 16, 24, { partial: 0 })).toBe(0);
  });

  it("caps a single event at one screenful of lines", () => {
    expect(wheelEventToLineCount(ev(1, 2), 16, 10, { partial: 0 })).toBe(10);
  });

  it("accumulates sub-line (trackpad) motion across events rather than dropping it", () => {
    // 8px against a 16px row = 0.5 line per event. The first event yields no
    // whole line; the carried remainder makes the second cross a line boundary,
    // so slow scrolling still moves instead of being discarded.
    const carry = { partial: 0 };
    expect(wheelEventToLineCount(ev(8, 0), 16, 24, carry)).toBe(0);
    expect(wheelEventToLineCount(ev(8, 0), 16, 24, carry)).toBe(1);
  });

  it("resets the trackpad accumulator when a notch interrupts a swipe", () => {
    const carry = { partial: 0.5 };
    // The notch still reports (value-agnostic), and crucially clears the stale
    // sub-line remainder so it can't smear the next fine scroll.
    expect(wheelEventToLineCount(ev(120, 0), 16, 24, carry)).toBeGreaterThan(0);
    expect(carry.partial).toBe(0);
  });

  it("registers a reversal immediately instead of cancelling stale forward motion", () => {
    // Forward half a line (no whole line yet), then reverse a full line. Without
    // dropping the stale +0.5 remainder the reversal would net -0.5 → 0 (a dead
    // zone); the sign-change reset makes the reverse line register as -1.
    const carry = { partial: 0 };
    expect(wheelEventToLineCount(ev(8, 0), 16, 24, carry)).toBe(0);
    expect(wheelEventToLineCount(ev(-16, 0), 16, 24, carry)).toBe(-1);
  });
});
