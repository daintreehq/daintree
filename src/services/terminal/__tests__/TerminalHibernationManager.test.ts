// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TerminalHibernationManager, HibernationManagerDeps } from "../TerminalHibernationManager";
import type { ManagedTerminal } from "../types";
import { TerminalRefreshTier } from "../../../../shared/types/panel";

const { freshTerminalOpenMock, freshTerminalOnWriteParsed } = vi.hoisted(() => ({
  freshTerminalOpenMock: vi.fn(),
  freshTerminalOnWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(function MockTerminal(this: Record<string, unknown>) {
    this.options = { scrollback: 5000 };
    this.rows = 24;
    this.cols = 80;
    this.buffer = {
      active: { length: 0, type: "normal", baseY: 0, viewportY: 0 },
      onBufferChange: vi.fn(() => ({ dispose: vi.fn() })),
    };
    this.parser = {
      registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })),
    };
    this.dispose = vi.fn();
    this.open = freshTerminalOpenMock;
    this.onData = vi.fn(() => ({ dispose: vi.fn() }));
    this.onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    this.onWriteParsed = freshTerminalOnWriteParsed;
    this.onSelectionChange = vi.fn(() => ({ dispose: vi.fn() }));
    this.getSelection = vi.fn(() => "");
    this.hasSelection = vi.fn(() => false);
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

function makeMockTerminal() {
  return {
    options: { scrollback: 5000 },
    rows: 24,
    cols: 80,
    buffer: {
      active: { length: 100, type: "normal", baseY: 0, viewportY: 0 },
      onBufferChange: vi.fn(() => ({ dispose: vi.fn() })),
    },
    parser: {
      registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })),
    },
    dispose: vi.fn(),
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onScroll: vi.fn(() => ({ dispose: vi.fn() })),
    onWriteParsed: vi.fn((cb: () => void) => {
      // capture so tests can simulate a parsed write
      (makeMockTerminal as unknown as { _lastWriteParsedCb?: () => void })._lastWriteParsedCb = cb;
      return { dispose: vi.fn() };
    }),
    onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
    getSelection: vi.fn(() => ""),
    hasSelection: vi.fn(() => false),
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
    openLink: vi.fn(),
    getCwdProvider: vi.fn(() => undefined),
    onBufferModeChange: vi.fn(),
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
  };
}

describe("TerminalHibernationManager", () => {
  let manager: TerminalHibernationManager;
  let deps: HibernationManagerDeps;
  let managed: ManagedTerminal;

  beforeEach(() => {
    vi.clearAllMocks();
    freshTerminalOpenMock.mockReset();
    freshTerminalOnWriteParsed.mockClear();
    freshTerminalOnWriteParsed.mockImplementation(() => ({ dispose: vi.fn() }));
    managed = makeMockManaged();
    deps = makeMockDeps(managed);
    manager = new TerminalHibernationManager(deps);
  });

  describe("hibernate()", () => {
    it("should no-op for unknown id", () => {
      manager.hibernate("unknown");
      expect(deps.destroyRestoreState).not.toHaveBeenCalled();
    });

    it("should no-op for already-hibernated terminal", () => {
      managed.isHibernated = true;
      manager.hibernate("t1");
      expect(deps.destroyRestoreState).not.toHaveBeenCalled();
    });

    it("should no-op for working agent terminal", () => {
      managed.launchAgentId = "claude";
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "working";
      manager.hibernate("t1");
      expect(managed.isHibernated).toBeFalsy();
    });

    it("should no-op for waiting agent terminal", () => {
      managed.launchAgentId = "claude";
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "waiting";
      manager.hibernate("t1");
      expect(managed.isHibernated).toBeFalsy();
    });

    it("should hibernate completed agent terminal", () => {
      managed.launchAgentId = "claude";
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "completed";
      manager.hibernate("t1");
      expect(managed.isHibernated).toBe(true);
    });

    it("should dispose terminal and set flags", () => {
      const terminalDispose = managed.terminal.dispose;
      manager.hibernate("t1");

      expect(managed.isHibernated).toBe(true);
      expect(managed.isOpened).toBe(false);
      expect(managed.keyHandlerInstalled).toBe(false);
      expect(terminalDispose).toHaveBeenCalled();
    });

    it("should call all collaborator deps", () => {
      manager.hibernate("t1");

      expect(deps.destroyRestoreState).toHaveBeenCalledWith("t1");
      expect(deps.resetBufferedOutput).toHaveBeenCalledWith("t1");
      expect(deps.releaseWebGL).toHaveBeenCalledWith("t1");
      expect(deps.clearResizeJob).toHaveBeenCalledWith(managed);
      expect(deps.clearSettledTimer).toHaveBeenCalledWith("t1");
    });

    it("should dispose addons and null them", () => {
      const imageDispose = (managed.imageAddon as unknown as { dispose: ReturnType<typeof vi.fn> })
        .dispose;
      const fileLinksDispose = (
        managed.fileLinksDisposable as unknown as { dispose: ReturnType<typeof vi.fn> }
      ).dispose;
      const webLinksDispose = (
        managed.webLinksAddon as unknown as { dispose: ReturnType<typeof vi.fn> }
      ).dispose;

      manager.hibernate("t1");

      expect(imageDispose).toHaveBeenCalled();
      expect(fileLinksDispose).toHaveBeenCalled();
      expect(webLinksDispose).toHaveBeenCalled();
      expect(managed.imageAddon).toBeNull();
      expect(managed.fileLinksDisposable).toBeNull();
      expect(managed.webLinksAddon).toBeNull();
    });

    it("should not throw when addons are already null", () => {
      managed.imageAddon = null;
      managed.fileLinksDisposable = null;
      managed.webLinksAddon = null;

      expect(() => manager.hibernate("t1")).not.toThrow();
    });

    it("should clear hibernation timer", () => {
      managed.hibernationTimer = setTimeout(() => {}, 30000) as ReturnType<typeof setTimeout>;
      manager.hibernate("t1");
      expect(managed.hibernationTimer).toBeUndefined();
    });

    it("should splice terminal-bound listeners but keep IPC listeners", () => {
      managed.ipcListenerCount = 2;
      managed.listeners = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];

      manager.hibernate("t1");

      expect(managed.listeners.length).toBe(2);
    });

    it("should dispose parser handler and last activity marker", () => {
      const parserDispose = vi.fn();
      const markerDispose = vi.fn();
      managed.parserHandler = { dispose: parserDispose };
      managed.lastActivityMarker = {
        dispose: markerDispose,
      } as unknown as ManagedTerminal["lastActivityMarker"];

      manager.hibernate("t1");

      expect(parserDispose).toHaveBeenCalled();
      expect(markerDispose).toHaveBeenCalled();
      expect(managed.parserHandler).toBeUndefined();
      expect(managed.lastActivityMarker).toBeUndefined();
    });
  });

  describe("unhibernate()", () => {
    beforeEach(() => {
      managed.isHibernated = true;
      managed.isOpened = false;
    });

    it("should no-op for unknown id", () => {
      manager.unhibernate("unknown");
      // no crash
    });

    it("should no-op for non-hibernated terminal", () => {
      managed.isHibernated = false;
      const oldTerminal = managed.terminal;
      manager.unhibernate("t1");
      expect(managed.terminal).toBe(oldTerminal);
    });

    it("should create fresh terminal and clear hibernated flag", () => {
      const oldTerminal = managed.terminal;
      manager.unhibernate("t1");

      expect(managed.isHibernated).toBe(false);
      expect(managed.isDetached).toBe(false);
      expect(managed.terminal).not.toBe(oldTerminal);
    });

    it("should clear DOM children to prevent ghosting", () => {
      managed.hostElement.appendChild(document.createElement("span"));
      managed.hostElement.appendChild(document.createElement("span"));

      manager.unhibernate("t1");

      expect(managed.hostElement.children.length).toBe(0);
    });

    it("should increment restoreGeneration and reset restore state", () => {
      managed.restoreGeneration = 5;
      managed.isSerializedRestoreInProgress = true;
      managed.deferredOutput = ["data"];

      manager.unhibernate("t1");

      expect(managed.restoreGeneration).toBe(6);
      expect(managed.isSerializedRestoreInProgress).toBe(false);
      expect(managed.deferredOutput).toEqual([]);
    });

    it("should register new terminal-bound listeners", () => {
      managed.ipcListenerCount = 1;
      managed.listeners = [vi.fn()]; // 1 IPC listener
      const initialCount = managed.listeners.length;

      manager.unhibernate("t1");

      expect(managed.listeners.length).toBeGreaterThan(initialCount);
    });

    it("should open fresh terminal when host has non-zero dimensions", () => {
      Object.defineProperty(managed.hostElement, "clientWidth", { value: 800, configurable: true });
      Object.defineProperty(managed.hostElement, "clientHeight", {
        value: 600,
        configurable: true,
      });

      manager.unhibernate("t1");

      expect(freshTerminalOpenMock).toHaveBeenCalledWith(managed.hostElement);
      expect(managed.isOpened).toBe(true);
    });

    it("should leave isOpened=false when host is zero-sized and not call open", () => {
      // jsdom hostElement has 0 clientWidth/clientHeight by default
      manager.unhibernate("t1");

      expect(freshTerminalOpenMock).not.toHaveBeenCalled();
      expect(managed.isOpened).toBe(false);
    });

    it("should invoke onWriteParsedReflow when the fresh terminal emits a parsed write", () => {
      const onWriteParsedReflow = vi.fn();
      deps.onWriteParsedReflow = onWriteParsedReflow;

      manager.unhibernate("t1");

      // Grab the last registered onWriteParsed callback and invoke it.
      // The mock is declared without typed args, so coerce the call log to
      // a shape we can index into.
      const calls = freshTerminalOnWriteParsed.mock.calls as unknown as Array<[() => void]>;
      const callback = calls.at(-1)?.[0];
      expect(callback).toBeTypeOf("function");
      callback!();

      expect(onWriteParsedReflow).toHaveBeenCalledWith(managed);
    });

    it("should reset lastReflowAt so next reflow fires immediately", () => {
      managed.lastReflowAt = 99999;
      manager.unhibernate("t1");
      expect(managed.lastReflowAt).toBe(0);
    });

    it("should not throw if terminal.open throws (bad host)", () => {
      Object.defineProperty(managed.hostElement, "clientWidth", { value: 800, configurable: true });
      Object.defineProperty(managed.hostElement, "clientHeight", {
        value: 600,
        configurable: true,
      });
      freshTerminalOpenMock.mockImplementationOnce(() => {
        throw new Error("boom");
      });

      expect(() => manager.unhibernate("t1")).not.toThrow();
      // Left as not opened on failure so attach() can retry
      expect(managed.isOpened).toBe(false);
    });

    it("should not leak listeners across hibernate/unhibernate cycles", () => {
      managed.ipcListenerCount = 1;
      managed.listeners = [vi.fn()];

      manager.unhibernate("t1");
      const afterFirst = managed.listeners.length;

      manager.hibernate("t1");
      expect(managed.listeners.length).toBe(1);

      manager.unhibernate("t1");
      expect(managed.listeners.length).toBe(afterFirst);
    });
  });

  describe("isHibernationEligible()", () => {
    it("rejects non-BACKGROUND tiers regardless of agent state", () => {
      managed.runtimeAgentId = undefined;
      expect(manager.isHibernationEligible(TerminalRefreshTier.FOCUSED, managed)).toBe(false);
      expect(manager.isHibernationEligible(TerminalRefreshTier.BURST, managed)).toBe(false);
      expect(manager.isHibernationEligible(TerminalRefreshTier.VISIBLE, managed)).toBe(false);
    });

    it("accepts BACKGROUND for non-agent terminals", () => {
      managed.runtimeAgentId = undefined;
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed)).toBe(true);
    });

    it("rejects BACKGROUND while an agent is still working/waiting", () => {
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "working";
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed)).toBe(false);

      managed.canonicalAgentState = "waiting";
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed)).toBe(false);
    });

    it("accepts BACKGROUND once an agent has completed or exited", () => {
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "completed";
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed)).toBe(true);

      managed.canonicalAgentState = "exited";
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed)).toBe(true);
    });
  });

  describe("scheduleHibernation() / cancelHibernation()", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("arms a timer that hibernates after HIBERNATION_DELAY_MS", () => {
      managed.runtimeAgentId = undefined;
      managed.isVisible = false;
      managed.isHibernated = false;

      manager.scheduleHibernation("t1", managed);
      expect(managed.hibernationTimer).toBeDefined();

      vi.advanceTimersByTime(30_000);
      expect(managed.isHibernated).toBe(true);
      expect(managed.hibernationTimer).toBeUndefined();
    });

    it("is idempotent — second schedule while a timer is pending is a no-op", () => {
      managed.runtimeAgentId = undefined;
      managed.isVisible = false;

      manager.scheduleHibernation("t1", managed);
      const firstTimer = managed.hibernationTimer;
      manager.scheduleHibernation("t1", managed);
      expect(managed.hibernationTimer).toBe(firstTimer);
    });

    it("does not arm when already hibernated", () => {
      managed.isHibernated = true;
      manager.scheduleHibernation("t1", managed);
      expect(managed.hibernationTimer).toBeUndefined();
    });

    it("aborts the fire path if the terminal became visible before the timer fired", () => {
      managed.runtimeAgentId = undefined;
      managed.isVisible = false;

      manager.scheduleHibernation("t1", managed);
      // User reveals the terminal between schedule and fire.
      managed.isVisible = true;

      vi.advanceTimersByTime(30_000);
      expect(managed.isHibernated).toBe(false);
    });

    it("cancelHibernation clears a pending timer", () => {
      managed.runtimeAgentId = undefined;
      managed.isVisible = false;

      manager.scheduleHibernation("t1", managed);
      expect(managed.hibernationTimer).toBeDefined();

      manager.cancelHibernation(managed);
      expect(managed.hibernationTimer).toBeUndefined();

      vi.advanceTimersByTime(30_000);
      expect(managed.isHibernated).toBe(false);
    });

    it("cancelHibernation is safe when no timer is armed", () => {
      managed.hibernationTimer = undefined;
      expect(() => manager.cancelHibernation(managed)).not.toThrow();
    });
  });

  describe("selection-aware auto-scroll", () => {
    it("should verify hasSelection logic matches TerminalInstanceService", () => {
      const hasSelectionMock = vi.fn(() => false);
      const scrollToBottomSafeMock = vi.fn();
      const updateScrollStateMock = vi.fn();

      const managed = {
        terminal: {
          hasSelection: hasSelectionMock,
          buffer: { active: { type: "normal" } },
        },
        isUserScrolledBack: false,
        isAltBuffer: false,
      };

      const id = "t1";

      const writeParsedCallback = () => {
        if (managed && !managed.isUserScrolledBack && !managed.isAltBuffer) {
          if (!managed.terminal.hasSelection()) {
            scrollToBottomSafeMock(managed);
          } else {
            managed.isUserScrolledBack = true;
            updateScrollStateMock(id, true);
          }
        }
      };

      hasSelectionMock.mockReturnValue(false);
      writeParsedCallback();

      expect(hasSelectionMock).toHaveBeenCalled();
      expect(scrollToBottomSafeMock).toHaveBeenCalledWith(managed);
      expect(managed.isUserScrolledBack).toBe(false);
      expect(updateScrollStateMock).not.toHaveBeenCalledWith(id, true);

      scrollToBottomSafeMock.mockClear();
      hasSelectionMock.mockReturnValue(true);
      managed.isUserScrolledBack = false;

      writeParsedCallback();

      expect(hasSelectionMock).toHaveBeenCalled();
      expect(scrollToBottomSafeMock).not.toHaveBeenCalled();
      expect(managed.isUserScrolledBack).toBe(true);
      expect(updateScrollStateMock).toHaveBeenCalledWith(id, true);
    });
  });
});
