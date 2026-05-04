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
}

function makeMockTerminal(captured: CapturedCallbacks) {
  return {
    options: { scrollback: 5000 },
    rows: 24,
    cols: 80,
    modes: { bracketedPasteMode: false },
    buffer: {
      active: { length: 0, type: "normal", baseY: 0, viewportY: 0 },
      onBufferChange: vi.fn(() => ({ dispose: vi.fn() })),
    },
    parser: {
      registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })),
    },
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
});
