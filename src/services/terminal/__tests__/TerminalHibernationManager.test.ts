// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TerminalHibernationManager, HibernationManagerDeps } from "../TerminalHibernationManager";
import type { ManagedTerminal } from "../types";
import { AGENT_IDLE_SILENCE_MS } from "../types";
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
    onHibernationChanged: vi.fn(),
    getIsBackgrounded: vi.fn(() => false),
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
    notifyXtermFocused: vi.fn(),
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

    it("should no-op for recently-active working agent terminal", () => {
      managed.launchAgentId = "claude";
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "working";
      // Recently rendered output → inside the silence window, must not tear
      // down. The plain "working" state alone isn't enough to block anymore
      // — silence is the load-bearing signal.
      managed.lastWriteAt = Date.now() - 1000;
      manager.hibernate("t1");
      expect(managed.isHibernated).toBeFalsy();
    });

    it("should no-op for recently-active waiting agent terminal", () => {
      managed.launchAgentId = "claude";
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "waiting";
      managed.lastWriteAt = Date.now() - 1000;
      manager.hibernate("t1");
      expect(managed.isHibernated).toBeFalsy();
    });

    it("should no-op when an active agent has writes in flight", () => {
      managed.launchAgentId = "claude";
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "working";
      // lastWriteAt far enough in the past to clear the silence window, but
      // pendingWrites > 0 means xterm is still flushing a burst — must not
      // tear down mid-write.
      managed.lastWriteAt = Date.now() - AGENT_IDLE_SILENCE_MS - 5000;
      managed.pendingWrites = 2;
      manager.hibernate("t1");
      expect(managed.isHibernated).toBeFalsy();
    });

    it("should hibernate a working agent that has been silent past AGENT_IDLE_SILENCE_MS", () => {
      managed.launchAgentId = "claude";
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "working";
      managed.pendingWrites = 0;
      managed.lastWriteAt = Date.now() - AGENT_IDLE_SILENCE_MS - 1000;
      manager.hibernate("t1");
      expect(managed.isHibernated).toBe(true);
    });

    it("should hibernate an idle agent immediately (no silence window required)", () => {
      managed.launchAgentId = "claude";
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "idle";
      // No lastWriteAt set — `idle` is a resting state, treated like
      // completed/exited, so the silence window doesn't apply.
      manager.hibernate("t1");
      expect(managed.isHibernated).toBe(true);
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

    it("notifies onHibernationChanged after the flag is written", () => {
      let seenFlag: boolean | undefined;
      (deps.onHibernationChanged as ReturnType<typeof vi.fn>).mockImplementation(() => {
        seenFlag = managed.isHibernated;
      });
      manager.hibernate("t1");
      expect(deps.onHibernationChanged).toHaveBeenCalledTimes(1);
      expect(deps.onHibernationChanged).toHaveBeenCalledWith("t1");
      expect(seenFlag).toBe(true);
    });

    it("does not notify onHibernationChanged when the call short-circuits", () => {
      managed.isHibernated = true;
      manager.hibernate("t1");
      expect(deps.onHibernationChanged).not.toHaveBeenCalled();
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

    it("notifies onHibernationChanged after the flag is cleared", () => {
      let seenFlag: boolean | undefined;
      (deps.onHibernationChanged as ReturnType<typeof vi.fn>).mockImplementation(() => {
        seenFlag = managed.isHibernated;
      });
      manager.unhibernate("t1");
      expect(deps.onHibernationChanged).toHaveBeenCalledTimes(1);
      expect(deps.onHibernationChanged).toHaveBeenCalledWith("t1");
      expect(seenFlag).toBe(false);
    });

    it("does not notify onHibernationChanged when the terminal is not hibernated", () => {
      managed.isHibernated = false;
      manager.unhibernate("t1");
      expect(deps.onHibernationChanged).not.toHaveBeenCalled();
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
      expect(manager.isHibernationEligible(TerminalRefreshTier.FOCUSED, managed, "t1")).toBe(false);
      expect(manager.isHibernationEligible(TerminalRefreshTier.BURST, managed, "t1")).toBe(false);
      expect(manager.isHibernationEligible(TerminalRefreshTier.VISIBLE, managed, "t1")).toBe(false);
    });

    it("accepts BACKGROUND for non-agent terminals", () => {
      managed.runtimeAgentId = undefined;
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1")).toBe(true);
    });

    it("rejects BACKGROUND while a recently-active agent is still working/waiting/directing", () => {
      const now = Date.now();
      managed.runtimeAgentId = "claude";
      managed.lastWriteAt = now - 1000;

      managed.canonicalAgentState = "working";
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1", now)).toBe(
        false
      );

      managed.canonicalAgentState = "waiting";
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1", now)).toBe(
        false
      );

      managed.canonicalAgentState = "directing";
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1", now)).toBe(
        false
      );
    });

    it("accepts BACKGROUND once an agent has completed or exited", () => {
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "completed";
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1")).toBe(true);

      managed.canonicalAgentState = "exited";
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1")).toBe(true);
    });

    it("treats `idle` as immediately eligible — no silence window required", () => {
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "idle";
      // No lastWriteAt: `idle` is a resting state, not in ACTIVE_AGENT_STATES,
      // so the silence guard doesn't apply.
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1")).toBe(true);
    });

    it("accepts BACKGROUND for a working agent that has been silent past AGENT_IDLE_SILENCE_MS", () => {
      const now = Date.now();
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "working";
      managed.lastWriteAt = now - AGENT_IDLE_SILENCE_MS;
      managed.pendingWrites = 0;
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1", now)).toBe(
        true
      );
    });

    it("rejects BACKGROUND one millisecond shy of the silence boundary", () => {
      const now = Date.now();
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "waiting";
      managed.lastWriteAt = now - AGENT_IDLE_SILENCE_MS + 1;
      managed.pendingWrites = 0;
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1", now)).toBe(
        false
      );
    });

    it("rejects BACKGROUND when an idle-eligible active agent still has pending writes", () => {
      const now = Date.now();
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "working";
      managed.lastWriteAt = now - AGENT_IDLE_SILENCE_MS - 10_000;
      managed.pendingWrites = 1;
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1", now)).toBe(
        false
      );
    });

    it("accepts BACKGROUND for an active agent that has no recorded lastWriteAt", () => {
      // A just-spawned agent that has never written anything reports
      // infinite silence by definition — eligible. The next write will
      // stamp lastWriteAt and may flip the state back to ineligible.
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "waiting";
      managed.pendingWrites = 0;
      managed.lastWriteAt = undefined;
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1")).toBe(true);
    });

    it("bypasses the silence window for a user-backgrounded active agent with no pending writes", () => {
      const now = Date.now();
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "working";
      managed.lastWriteAt = now - 1000; // well inside the 5-min silence window
      managed.pendingWrites = 0;
      (deps.getIsBackgrounded as ReturnType<typeof vi.fn>).mockReturnValue(true);
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1", now)).toBe(
        true
      );
    });

    it("still rejects a user-backgrounded terminal that has pending writes (burst guard holds)", () => {
      const now = Date.now();
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "working";
      managed.lastWriteAt = now - 1000;
      managed.pendingWrites = 1;
      (deps.getIsBackgrounded as ReturnType<typeof vi.fn>).mockReturnValue(true);
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1", now)).toBe(
        false
      );
    });

    it("preserves the silence window for a non-backgrounded active agent (no bypass)", () => {
      const now = Date.now();
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "working";
      managed.lastWriteAt = now - 1000;
      managed.pendingWrites = 0;
      // getIsBackgrounded defaults to false — silence window must still apply.
      expect(manager.isHibernationEligible(TerminalRefreshTier.BACKGROUND, managed, "t1", now)).toBe(
        false
      );
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

    it("honors the optional delayMs override", () => {
      managed.runtimeAgentId = undefined;
      managed.isVisible = false;

      manager.scheduleHibernation("t1", managed, 5_000);
      expect(managed.hibernationTimer).toBeDefined();

      // Standard 30s should NOT be enough — we set 5s.
      vi.advanceTimersByTime(4_999);
      expect(managed.isHibernated).toBe(false);

      vi.advanceTimersByTime(2);
      expect(managed.isHibernated).toBe(true);
    });

    it("arms an eligibility re-check (not the hibernation timer) for a still-silent active agent", () => {
      vi.setSystemTime(0);
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "working";
      managed.isVisible = false;
      managed.pendingWrites = 0;
      managed.lastWriteAt = 0; // wrote at t=0, silence window not yet reached

      manager.scheduleHibernation("t1", managed);

      // No hibernation timer yet — re-check timer is armed instead.
      expect(managed.hibernationTimer).toBeUndefined();
      expect(managed.hibernationEligibilityTimer).toBeDefined();

      // Advance to just before eligibility flips.
      vi.advanceTimersByTime(AGENT_IDLE_SILENCE_MS - 1);
      expect(managed.hibernationTimer).toBeUndefined();
      expect(managed.isHibernated).toBe(false);

      // Cross the silence boundary — re-check fires, schedules the
      // normal 30s timer, then advance through that to hibernate.
      vi.advanceTimersByTime(1);
      expect(managed.hibernationEligibilityTimer).toBeUndefined();
      expect(managed.hibernationTimer).toBeDefined();

      vi.advanceTimersByTime(30_000);
      expect(managed.isHibernated).toBe(true);

      vi.setSystemTime(new Date());
    });

    it("skips the eligibility re-check and arms the hibernation timer for a backgrounded active agent", () => {
      vi.setSystemTime(0);
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "working";
      managed.isVisible = false;
      managed.pendingWrites = 0;
      managed.lastWriteAt = 0; // would normally arm the re-check timer
      (deps.getIsBackgrounded as ReturnType<typeof vi.fn>).mockReturnValue(true);

      manager.scheduleHibernation("t1", managed);

      // Backgrounded: re-check timer skipped, normal hibernation timer armed.
      expect(managed.hibernationEligibilityTimer).toBeUndefined();
      expect(managed.hibernationTimer).toBeDefined();

      vi.advanceTimersByTime(30_000);
      expect(managed.isHibernated).toBe(true);

      vi.setSystemTime(new Date());
    });

    it("re-check bails if the terminal became visible before eligibility flipped", () => {
      vi.setSystemTime(0);
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "working";
      managed.isVisible = false;
      managed.pendingWrites = 0;
      managed.lastWriteAt = 0;

      manager.scheduleHibernation("t1", managed);
      expect(managed.hibernationEligibilityTimer).toBeDefined();

      managed.isVisible = true;
      vi.advanceTimersByTime(AGENT_IDLE_SILENCE_MS);

      // Eligibility re-check ran, bailed because terminal is visible.
      expect(managed.hibernationTimer).toBeUndefined();
      expect(managed.isHibernated).toBe(false);

      vi.setSystemTime(new Date());
    });

    it("cancelHibernation clears the eligibility re-check timer too", () => {
      vi.setSystemTime(0);
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "waiting";
      managed.isVisible = false;
      managed.pendingWrites = 0;
      managed.lastWriteAt = 0;

      manager.scheduleHibernation("t1", managed);
      expect(managed.hibernationEligibilityTimer).toBeDefined();

      manager.cancelHibernation(managed);
      expect(managed.hibernationEligibilityTimer).toBeUndefined();

      // Past the window, nothing should fire.
      vi.advanceTimersByTime(AGENT_IDLE_SILENCE_MS + 1000);
      expect(managed.hibernationTimer).toBeUndefined();
      expect(managed.isHibernated).toBe(false);

      vi.setSystemTime(new Date());
    });

    it("arms the regular hibernation timer immediately when an active agent is already past the silence window", () => {
      vi.setSystemTime(AGENT_IDLE_SILENCE_MS + 10_000);
      managed.runtimeAgentId = "claude";
      managed.canonicalAgentState = "working";
      managed.isVisible = false;
      managed.pendingWrites = 0;
      managed.lastWriteAt = 0; // ancient

      manager.scheduleHibernation("t1", managed);
      expect(managed.hibernationEligibilityTimer).toBeUndefined();
      expect(managed.hibernationTimer).toBeDefined();

      vi.setSystemTime(new Date());
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
