// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";
import type { ManagedTerminal } from "../types";
import {
  installTerminalBoundListeners,
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
