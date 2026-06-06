// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";
import { AGENT_IDLE_SILENCE_MS, HIBERNATION_DELAY_MS } from "../types";

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

type HibernationTestService = {
  instances: Map<string, Record<string, unknown>>;
  applyRendererPolicy: (id: string, tier: TerminalRefreshTier) => void;
  getOrCreate: (
    id: string,
    type: string,
    options: Record<string, unknown>,
    getRefreshTier?: () => TerminalRefreshTier,
    onInput?: (data: string) => void
  ) => Record<string, unknown>;
  hibernate: (id: string) => void;
  unhibernate: (id: string) => void;
  isHibernated: (id: string) => boolean;
  destroy: (id: string) => void;
  attach: (id: string, container: HTMLElement) => Record<string, unknown> | null;
  wake: (id: string) => void;
  focus: (id: string) => void;
  scrollToBottom: (id: string) => void;
  scrollToLastActivity: (id: string) => void;
  resetRenderer: (id: string) => void;
  setVisible: (id: string, visible: boolean) => void;
  setInputLocked: (id: string, locked: boolean) => void;
  accelerateHibernation: (level: 1 | 2) => void;
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
    hibernationTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    hibernationEligibilityTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    isInputLocked: false,
    ipcListenerCount: 0,
    ...overrides,
  };
  const runtimeManaged = managed as typeof managed & {
    runtimeAgentId?: string;
    launchAgentId?: string;
  };
  if (
    runtimeManaged.runtimeAgentId === undefined &&
    typeof runtimeManaged.launchAgentId === "string"
  ) {
    runtimeManaged.runtimeAgentId = runtimeManaged.launchAgentId;
  }
  return runtimeManaged;
}

describe("TerminalInstanceService - Hibernation", () => {
  let service: HibernationTestService;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Mock window.electron for title state reporting and observed-title updates
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

    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: HibernationTestService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("hibernate()", () => {
    it("should set isHibernated and dispose terminal", () => {
      const managed = makeMockManaged();
      const terminalDispose = managed.terminal.dispose;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.hibernate("t1");

      expect(managed.isHibernated).toBe(true);
      expect(managed.isOpened).toBe(false);
      expect(managed.keyHandlerInstalled).toBe(false);
      expect(terminalDispose).toHaveBeenCalled();
    });

    it("should dispose addons", () => {
      const managed = makeMockManaged();
      const imageDispose = managed.imageAddon!.dispose;
      const fileLinksDispose = managed.fileLinksDisposable!.dispose;
      const webLinksDispose = managed.webLinksAddon!.dispose;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.hibernate("t1");

      expect(imageDispose).toHaveBeenCalled();
      expect(fileLinksDispose).toHaveBeenCalled();
      expect(webLinksDispose).toHaveBeenCalled();
      expect(managed.imageAddon).toBeNull();
      expect(managed.fileLinksDisposable).toBeNull();
      expect(managed.webLinksAddon).toBeNull();
    });

    it("should keep the ManagedTerminal entry in the instances map", () => {
      const managed = makeMockManaged();
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.hibernate("t1");

      expect(service.instances.has("t1")).toBe(true);
      expect(service.isHibernated("t1")).toBe(true);
    });

    it("should never hibernate recently-active working agent terminals", () => {
      // The eligibility check now uses lastWriteAt as the load-bearing
      // signal; the plain "working" state alone is no longer permanent
      // immunity. A recent write proves the agent is still live.
      const managed = makeMockManaged({
        kind: "terminal",
        launchAgentId: "claude",
        canonicalAgentState: "working",
        lastWriteAt: Date.now() - 1000,
        pendingWrites: 0,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.hibernate("t1");

      expect(managed.isHibernated).toBeFalsy();
      expect(managed.terminal.dispose).not.toHaveBeenCalled();
    });

    it("should never hibernate recently-active waiting agent terminals", () => {
      const managed = makeMockManaged({
        kind: "terminal",
        launchAgentId: "claude",
        canonicalAgentState: "waiting",
        lastWriteAt: Date.now() - 1000,
        pendingWrites: 0,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.hibernate("t1");

      expect(managed.isHibernated).toBeFalsy();
      expect(managed.terminal.dispose).not.toHaveBeenCalled();
    });

    it("should hibernate completed agent terminals", () => {
      const managed = makeMockManaged({
        kind: "terminal",
        launchAgentId: "claude",
        canonicalAgentState: "completed",
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.hibernate("t1");

      expect(managed.isHibernated).toBe(true);
      expect(managed.terminal.dispose).toHaveBeenCalled();
    });

    it("should be idempotent — second call is a no-op", () => {
      const managed = makeMockManaged();
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.hibernate("t1");
      const disposeCalls = (managed.terminal.dispose as ReturnType<typeof vi.fn>).mock.calls.length;

      service.hibernate("t1");
      // dispose should not be called again
      expect(managed.terminal.dispose).toHaveBeenCalledTimes(disposeCalls);
    });

    it("should clear pending hibernation timer", () => {
      const managed = makeMockManaged();
      managed.hibernationTimer = setTimeout(() => {}, 30000);
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.hibernate("t1");

      expect(managed.hibernationTimer).toBeUndefined();
    });

    it("should keep hostElement in DOM for reuse during unhibernation", () => {
      const managed = makeMockManaged();
      const container = document.createElement("div");
      container.appendChild(managed.hostElement);
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.hibernate("t1");

      expect(managed.hostElement.parentElement).toBe(container);
    });
  });

  describe("unhibernate()", () => {
    it("should create a fresh Terminal and clear isHibernated", () => {
      const managed = makeMockManaged({ isHibernated: true, isOpened: false });
      const oldTerminal = managed.terminal;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.unhibernate("t1");

      expect(managed.isHibernated).toBe(false);
      expect(managed.terminal).not.toBe(oldTerminal);
    });

    it("should create fresh addons", () => {
      const managed = makeMockManaged({
        isHibernated: true,
        imageAddon: null,
        fileLinksDisposable: null,
        webLinksAddon: null,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.unhibernate("t1");

      expect(managed.fitAddon).toBeDefined();
      expect(managed.serializeAddon).toBeDefined();
    });

    it("should reuse existing hostElement", () => {
      const managed = makeMockManaged({ isHibernated: true });
      const oldHostElement = managed.hostElement;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.unhibernate("t1");

      expect(managed.hostElement).toBe(oldHostElement);
    });

    it("should be a no-op for non-hibernated terminals", () => {
      const managed = makeMockManaged({ isHibernated: false });
      const oldTerminal = managed.terminal;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.unhibernate("t1");

      expect(managed.terminal).toBe(oldTerminal);
    });

    it("should increment restoreGeneration", () => {
      const managed = makeMockManaged({ isHibernated: true, restoreGeneration: 5 });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.unhibernate("t1");

      expect(managed.restoreGeneration).toBe(6);
    });
  });

  describe("Hibernation timer via tier transitions", () => {
    it("should start hibernation timer when an offscreen terminal drops to BACKGROUND", () => {
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        isVisible: false,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600); // past hysteresis

      expect(managed.hibernationTimer).toBeDefined();
    });

    it("should NOT start hibernation timer while terminal is visible on screen", () => {
      // A non-focused split-view terminal goes BACKGROUND but stays on screen.
      // We must not hibernate it — the user is looking at it.
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        isVisible: true,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600); // past hysteresis
      vi.advanceTimersByTime(HIBERNATION_DELAY_MS);

      expect(managed.hibernationTimer).toBeUndefined();
      expect(managed.isHibernated).toBeFalsy();
    });

    it("should hibernate an offscreen terminal after HIBERNATION_DELAY_MS in BACKGROUND", () => {
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        isVisible: false,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600); // past hysteresis
      vi.advanceTimersByTime(HIBERNATION_DELAY_MS);

      expect(managed.isHibernated).toBe(true);
    });

    it("should NOT start hibernation timer for recently-active agent terminals", () => {
      // With idle-aware eligibility, an active-state agent is only excluded
      // while its silence window is unmet. Setting a recent lastWriteAt
      // pins this terminal inside that window so the regular timer must
      // not fire — though the eligibility re-check timer is allowed.
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        isVisible: false,
        kind: "terminal",
        launchAgentId: "claude",
        canonicalAgentState: "working",
        lastWriteAt: Date.now() - 1000,
        pendingWrites: 0,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600); // past hysteresis

      expect(managed.hibernationTimer).toBeUndefined();
    });

    it("arms the eligibility re-check timer for a recently-active agent dropping to BACKGROUND", () => {
      // Regression guard for the issue that motivated this feature: a
      // recently-active working agent backgrounded by tier transition must
      // arm the silence-window re-check (not the regular timer, not
      // nothing). Without this re-check, the agent would be permanently
      // exempt from hibernation, leaking memory indefinitely.
      const startTime = Date.now();
      vi.setSystemTime(startTime);
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        isVisible: false,
        kind: "terminal",
        launchAgentId: "claude",
        canonicalAgentState: "working",
        lastWriteAt: startTime - 1000,
        pendingWrites: 0,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600); // past hysteresis

      expect(managed.hibernationTimer).toBeUndefined();
      expect(managed.hibernationEligibilityTimer).toBeDefined();

      vi.setSystemTime(new Date());
    });

    it("hibernates a recently-active agent after silence window + regular delay elapses", () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        isVisible: false,
        kind: "terminal",
        launchAgentId: "claude",
        canonicalAgentState: "working",
        lastWriteAt: startTime - 1000,
        pendingWrites: 0,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600); // past hysteresis

      // Cross the silence window (re-check fires, schedules regular timer).
      vi.advanceTimersByTime(AGENT_IDLE_SILENCE_MS);
      expect(managed.hibernationTimer).toBeDefined();

      // Cross the regular 30s delay.
      vi.advanceTimersByTime(HIBERNATION_DELAY_MS);
      expect(managed.isHibernated).toBe(true);

      vi.setSystemTime(new Date());
    });

    it("clears the eligibility re-check timer when tier upgrades out of BACKGROUND", () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        isVisible: false,
        kind: "terminal",
        launchAgentId: "claude",
        canonicalAgentState: "working",
        lastWriteAt: startTime - 1000,
        pendingWrites: 0,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600);
      expect(managed.hibernationEligibilityTimer).toBeDefined();

      // User comes back: tier upgrades to FOCUSED before silence window
      // expires. The re-check must be cancelled, otherwise it would fire
      // 5 minutes later and the callback's stale managed-ref might still
      // arm a regular timer despite the terminal being visible.
      service.applyRendererPolicy("t1", TerminalRefreshTier.FOCUSED);
      expect(managed.hibernationEligibilityTimer).toBeUndefined();

      vi.advanceTimersByTime(AGENT_IDLE_SILENCE_MS + HIBERNATION_DELAY_MS);
      expect(managed.isHibernated).toBeFalsy();

      vi.setSystemTime(new Date());
    });

    it("should start hibernation timer for offscreen completed agent terminals in BACKGROUND", () => {
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        isVisible: false,
        kind: "terminal",
        launchAgentId: "claude",
        canonicalAgentState: "completed",
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600); // past hysteresis

      expect(managed.hibernationTimer).toBeDefined();
    });

    it("should hibernate offscreen completed agent after HIBERNATION_DELAY_MS in BACKGROUND", () => {
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        isVisible: false,
        kind: "terminal",
        launchAgentId: "claude",
        canonicalAgentState: "completed",
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600); // past hysteresis
      vi.advanceTimersByTime(HIBERNATION_DELAY_MS);

      expect(managed.isHibernated).toBe(true);
    });

    it("should cancel hibernation timer when upgraded from BACKGROUND", () => {
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        isVisible: false,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      // Downgrade to BACKGROUND
      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600); // past hysteresis
      expect(managed.hibernationTimer).toBeDefined();

      // Upgrade to FOCUSED before hibernation fires
      service.applyRendererPolicy("t1", TerminalRefreshTier.FOCUSED);

      expect(managed.hibernationTimer).toBeUndefined();

      // Advance past hibernation delay — should NOT hibernate
      vi.advanceTimersByTime(HIBERNATION_DELAY_MS);
      expect(managed.isHibernated).toBeFalsy();
    });

    it("should schedule hibernation when a BACKGROUND terminal becomes invisible", () => {
      // Simulates: non-focused split-view terminal (BACKGROUND, visible) → user
      // switches panels away, so it goes offscreen. Timer must start now.
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        isVisible: true,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.setVisible("t1", false);

      expect(managed.hibernationTimer).toBeDefined();

      vi.advanceTimersByTime(HIBERNATION_DELAY_MS);
      expect(managed.isHibernated).toBe(true);
    });

    it("should cancel hibernation when an offscreen terminal becomes visible again", () => {
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        isVisible: false,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600);
      expect(managed.hibernationTimer).toBeDefined();

      service.setVisible("t1", true);

      expect(managed.hibernationTimer).toBeUndefined();

      vi.advanceTimersByTime(HIBERNATION_DELAY_MS);
      expect(managed.isHibernated).toBeFalsy();
    });
  });

  describe("Guards on hibernated terminals", () => {
    it("attach should unhibernate before proceeding", () => {
      // Mock matchMedia for xterm's Terminal.open() in jsdom
      window.matchMedia = vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      });

      const managed = makeMockManaged({ isHibernated: true, isOpened: false });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);
      const container = document.createElement("div");

      service.attach("t1", container);

      expect(managed.isHibernated).toBe(false);
    });

    it("focus should be a no-op when hibernated", () => {
      const managed = makeMockManaged({ isHibernated: true });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      // Should not throw
      expect(() => service.focus("t1")).not.toThrow();
    });

    it("setVisible should be a no-op when hibernated", () => {
      const managed = makeMockManaged({ isHibernated: true });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      expect(() => service.setVisible("t1", true)).not.toThrow();
    });

    it("scrollToBottom should be a no-op when hibernated", () => {
      const managed = makeMockManaged({ isHibernated: true });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      expect(() => service.scrollToBottom("t1")).not.toThrow();
    });

    it("scrollToLastActivity should be a no-op when hibernated", () => {
      const managed = makeMockManaged({ isHibernated: true });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      expect(() => service.scrollToLastActivity("t1")).not.toThrow();
    });

    it("resetRenderer should be a no-op when hibernated", () => {
      const managed = makeMockManaged({ isHibernated: true });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      expect(() => service.resetRenderer("t1")).not.toThrow();
    });

    it("setInputLocked should store lock state but not access terminal when hibernated", () => {
      const managed = makeMockManaged({ isHibernated: true });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.setInputLocked("t1", true);

      expect(managed.isInputLocked).toBe(true);
    });

    it("wake should unhibernate before proceeding", () => {
      const managed = makeMockManaged({ isHibernated: true, isOpened: false });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.wake("t1");

      expect(managed.isHibernated).toBe(false);
    });
  });

  describe("destroy() with hibernated terminals", () => {
    it("should handle destroying a hibernated terminal without errors", () => {
      const managed = makeMockManaged({ isHibernated: true });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      expect(() => service.destroy("t1")).not.toThrow();
      expect(service.instances.has("t1")).toBe(false);
    });

    it("should clear hibernation timer on destroy", () => {
      const managed = makeMockManaged({ isVisible: false });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      // Start hibernation timer (offscreen terminal dropping to BACKGROUND)
      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600);
      expect(managed.hibernationTimer).toBeDefined();

      service.destroy("t1");

      // Timer should have been cleared (no lingering setTimeout)
      expect(managed.hibernationTimer).toBeUndefined();
    });

    it("should clear the eligibility re-check timer on destroy", () => {
      // Without this cleanup, the re-check could run for up to 5 minutes
      // post-destroy. The callback's getInstance(id) guard prevents
      // mutation of a recreated terminal, but the leak itself is the bug.
      const startTime = Date.now();
      vi.setSystemTime(startTime);
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        isVisible: false,
        kind: "terminal",
        launchAgentId: "claude",
        canonicalAgentState: "working",
        lastWriteAt: startTime - 1000,
        pendingWrites: 0,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600);
      expect(managed.hibernationEligibilityTimer).toBeDefined();

      service.destroy("t1");
      expect(managed.hibernationEligibilityTimer).toBeUndefined();

      vi.setSystemTime(new Date());
    });

    it("should detach the host element from the shared hidden container (#9909)", () => {
      // A hibernated terminal's host may have been parked in the shared
      // offscreen container by detach()/detachForProjectSwitch() — a raw
      // child of hiddenContainer, not a per-id slot. Destroy must still
      // remove it, otherwise long multi-project sessions accumulate empty
      // host divs in the shared container.
      const managed = makeMockManaged({ isHibernated: true });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      const offscreen = (
        service as unknown as {
          offscreenManager: { ensureHiddenContainer: () => HTMLElement | null };
        }
      ).offscreenManager.ensureHiddenContainer();
      expect(offscreen).not.toBeNull();
      offscreen!.appendChild(managed.hostElement);
      expect(offscreen!.contains(managed.hostElement)).toBe(true);

      service.destroy("t1");

      expect(managed.hostElement.parentElement).toBeNull();
      expect(offscreen!.contains(managed.hostElement)).toBe(false);
    });

    it("should still detach the host for a non-hibernated terminal parked in the hidden container", () => {
      // Locks in that moving the host removal out of the !isHibernated guard
      // didn't break the pre-existing non-hibernated path: a terminal that
      // is destroyed mid-detach (e.g. via detachForProjectSwitch()) also
      // gets its host cleaned up.
      const managed = makeMockManaged({ isHibernated: false });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      const offscreen = (
        service as unknown as {
          offscreenManager: { ensureHiddenContainer: () => HTMLElement | null };
        }
      ).offscreenManager.ensureHiddenContainer();
      expect(offscreen).not.toBeNull();
      offscreen!.appendChild(managed.hostElement);

      service.destroy("t1");

      expect(managed.hostElement.parentElement).toBeNull();
      expect(offscreen!.contains(managed.hostElement)).toBe(false);
    });

    it("should be a safe no-op when the host has no parent", () => {
      // Locks in the `if (managed.hostElement.parentElement)` guard so a
      // future refactor that drops it doesn't start throwing NotFoundError
      // on already-detached hosts.
      const managed = makeMockManaged();
      service.instances.set("t1", managed as unknown as Record<string, unknown>);
      expect(managed.hostElement.parentElement).toBeNull();

      expect(() => service.destroy("t1")).not.toThrow();
      expect(managed.hostElement.parentElement).toBeNull();
    });
  });

  describe("Listener leak prevention", () => {
    it("should not grow listeners array through hibernate/unhibernate cycles", () => {
      const managed = makeMockManaged({ ipcListenerCount: 2 });
      // Simulate 2 IPC listeners + 5 terminal-bound listeners
      managed.listeners = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.hibernate("t1");
      // After hibernate: only IPC listeners (2) should remain
      expect(managed.listeners.length).toBe(2);

      service.unhibernate("t1");
      // After unhibernate: IPC listeners + new terminal-bound listeners
      const afterFirstCycle = managed.listeners.length;

      service.hibernate("t1");
      expect(managed.listeners.length).toBe(2);

      service.unhibernate("t1");
      // Same count as after first cycle — no growth
      expect(managed.listeners.length).toBe(afterFirstCycle);

      // Third cycle — still no growth
      service.hibernate("t1");
      service.unhibernate("t1");
      expect(managed.listeners.length).toBe(afterFirstCycle);
    });
  });

  describe("Full hibernation cycle", () => {
    it("should support hibernate → unhibernate → hibernate cycle", () => {
      const managed = makeMockManaged();
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      // First cycle
      service.hibernate("t1");
      expect(managed.isHibernated).toBe(true);

      service.unhibernate("t1");
      expect(managed.isHibernated).toBe(false);

      // Second cycle
      service.hibernate("t1");
      expect(managed.isHibernated).toBe(true);

      service.unhibernate("t1");
      expect(managed.isHibernated).toBe(false);

      expect(service.instances.has("t1")).toBe(true);
    });
  });

  describe("Agent listener reinstallation after unhibernate", () => {
    it("should install more listeners for agent terminals with titleStatePatterns than non-agent", () => {
      mockGetEffectiveAgentConfig.mockReturnValue({
        detection: {
          titleStatePatterns: {
            working: ["\u2726"],
            waiting: ["\u25C7"],
          },
        },
      });

      // Non-agent terminal
      const nonAgent = makeMockManaged({
        isHibernated: true,
        isOpened: false,
        kind: "terminal",
        type: "terminal",
        ipcListenerCount: 0,
      });
      nonAgent.listeners = [];
      service.instances.set("t1", nonAgent as unknown as Record<string, unknown>);
      service.unhibernate("t1");
      const nonAgentListenerCount = nonAgent.listeners.length;

      // Runtime agent terminal. Listener scaffolding is installed for every
      // terminal; runtime identity only decides whether the listeners act.
      const agent = makeMockManaged({
        isHibernated: true,
        isOpened: false,
        kind: "terminal",
        launchAgentId: "claude",
        runtimeAgentId: "claude",
        ipcListenerCount: 0,
      });
      agent.listeners = [];
      service.instances.set("t2", agent as unknown as Record<string, unknown>);
      service.unhibernate("t2");
      const agentListenerCount = agent.listeners.length;

      expect(agentListenerCount).toBe(nonAgentListenerCount);
    });

    it("should install enter-key listener but not title listener when no titleStatePatterns", () => {
      mockGetEffectiveAgentConfig.mockReturnValue(undefined);

      // Non-agent baseline
      const nonAgent = makeMockManaged({
        isHibernated: true,
        isOpened: false,
        kind: "terminal",
        type: "terminal",
        ipcListenerCount: 0,
      });
      nonAgent.listeners = [];
      service.instances.set("t1", nonAgent as unknown as Record<string, unknown>);
      service.unhibernate("t1");
      const nonAgentListenerCount = nonAgent.listeners.length;

      // Runtime agent without title patterns. It still has the same dormant
      // scaffolding as a standard terminal.
      const agent = makeMockManaged({
        isHibernated: true,
        isOpened: false,
        kind: "terminal",
        launchAgentId: "claude",
        runtimeAgentId: "claude",
        ipcListenerCount: 0,
      });
      agent.listeners = [];
      service.instances.set("t2", agent as unknown as Record<string, unknown>);
      service.unhibernate("t2");
      const agentListenerCount = agent.listeners.length;

      expect(agentListenerCount).toBe(nonAgentListenerCount);
    });

    it("should preserve onInput callback on ManagedTerminal through unhibernate", () => {
      const onInputMock = vi.fn();
      const managed = makeMockManaged({
        isHibernated: true,
        isOpened: false,
        onInput: onInputMock,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.unhibernate("t1");

      // onInput should still be on the managed instance
      expect((managed as Record<string, unknown>).onInput).toBe(onInputMock);
    });

    it("should not grow listeners across hibernate/unhibernate cycles for agent terminals", () => {
      mockGetEffectiveAgentConfig.mockReturnValue({
        detection: {
          titleStatePatterns: {
            working: ["\u2726"],
            waiting: ["\u25C7"],
          },
        },
      });

      const managed = makeMockManaged({
        ipcListenerCount: 2,
        kind: "terminal",
        launchAgentId: "claude",
        canonicalAgentState: "completed",
        onInput: vi.fn(),
      });
      managed.listeners = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.hibernate("t1");
      expect(managed.listeners.length).toBe(2);

      service.unhibernate("t1");
      const afterFirstCycle = managed.listeners.length;
      // Agent terminals should have more listeners than just IPC (title + key + standard)
      expect(afterFirstCycle).toBeGreaterThan(2);

      service.hibernate("t1");
      expect(managed.listeners.length).toBe(2);

      service.unhibernate("t1");
      expect(managed.listeners.length).toBe(afterFirstCycle);

      // Third cycle
      service.hibernate("t1");
      service.unhibernate("t1");
      expect(managed.listeners.length).toBe(afterFirstCycle);
    });
  });

  describe("accelerateHibernation() under memory pressure", () => {
    it("compresses a BACKGROUND offscreen terminal's hibernation timer at tier 1", () => {
      const managed = makeMockManaged({
        isVisible: false,
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.accelerateHibernation(1);

      expect(managed.hibernationTimer).toBeDefined();

      // Standard 30s window must NOT apply — tier 1 is 5s.
      vi.advanceTimersByTime(4_999);
      expect(managed.isHibernated).toBe(false);

      vi.advanceTimersByTime(2);
      expect(managed.isHibernated).toBe(true);
    });

    it("hibernates a BACKGROUND offscreen terminal immediately at tier 2", () => {
      const managed = makeMockManaged({
        isVisible: false,
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.accelerateHibernation(2);

      // Tier 2 schedules with delay 0 — flush the macrotask queue.
      vi.advanceTimersByTime(0);
      expect(managed.isHibernated).toBe(true);
    });

    it("ignores terminals that are not in BACKGROUND tier", () => {
      const managed = makeMockManaged({
        isVisible: false,
        lastAppliedTier: TerminalRefreshTier.VISIBLE,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.accelerateHibernation(2);
      vi.advanceTimersByTime(10_000);

      expect(managed.hibernationTimer).toBeUndefined();
      expect(managed.isHibernated).toBeFalsy();
    });

    it("ignores visible terminals even in BACKGROUND tier", () => {
      // A non-focused split-view terminal can be BACKGROUND-tier and still
      // on screen. Tearing it down under memory pressure would visibly
      // collapse the user's view — never do this.
      const managed = makeMockManaged({
        isVisible: true,
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.accelerateHibernation(2);
      vi.advanceTimersByTime(10_000);

      expect(managed.hibernationTimer).toBeUndefined();
      expect(managed.isHibernated).toBeFalsy();
    });

    it("skips terminals that are already hibernated", () => {
      const managed = makeMockManaged({
        isVisible: false,
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        isHibernated: true,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.accelerateHibernation(2);
      vi.advanceTimersByTime(10_000);

      // Already-hibernated terminals stay hibernated; no new timer.
      expect(managed.hibernationTimer).toBeUndefined();
    });

    it("does not tear down a recently-active agent terminal at tier 2", () => {
      // Tier 2 fires immediately, but the hibernate() safety guard still
      // protects an agent that has recent output — the silence window must
      // pass first. The pending re-check timer takes over.
      const managed = makeMockManaged({
        isVisible: false,
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        launchAgentId: "claude",
        canonicalAgentState: "working",
        lastWriteAt: Date.now() - 1000, // very recent write
        pendingWrites: 0,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.accelerateHibernation(2);
      vi.advanceTimersByTime(0);

      // Must NOT have hibernated — silence window unmet.
      expect(managed.isHibernated).toBeFalsy();
    });

    it("arms the eligibility re-check (not the regular timer) when accelerating a recently-active agent", () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);
      const managed = makeMockManaged({
        isVisible: false,
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        launchAgentId: "claude",
        canonicalAgentState: "working",
        lastWriteAt: startTime - 1000,
        pendingWrites: 0,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.accelerateHibernation(1);

      // accelerateHibernation cancels any existing timer and calls
      // scheduleHibernation with a shorter delay — but for a silent-but-
      // not-yet-idle agent that means arming the eligibility re-check,
      // not the regular timer. The accelerated delay is delivered to
      // the second scheduleHibernation call from inside the re-check.
      expect(managed.hibernationTimer).toBeUndefined();
      expect(managed.hibernationEligibilityTimer).toBeDefined();

      vi.setSystemTime(new Date());
    });

    it("replaces an existing regular timer with the accelerated delay", () => {
      const managed = makeMockManaged({
        isVisible: false,
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600); // past hysteresis — regular timer armed
      expect(managed.hibernationTimer).toBeDefined();

      service.accelerateHibernation(1);

      // Tier 1 = 5s; the original 30s timer must have been cancelled and
      // replaced — otherwise the 5s acceleration is a no-op.
      vi.advanceTimersByTime(5_001);
      expect(managed.isHibernated).toBe(true);
    });

    it("does not hibernate a non-BACKGROUND terminal even with idle agent state", () => {
      const managed = makeMockManaged({
        isVisible: false,
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        launchAgentId: "claude",
        canonicalAgentState: "idle",
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.accelerateHibernation(2);
      vi.advanceTimersByTime(10_000);

      // The renderer policy owns when to hibernate based on tier; the
      // accelerator only compresses the timer for already-BACKGROUND
      // terminals. A FOCUSED idle agent is still on the user's screen.
      expect(managed.isHibernated).toBeFalsy();
    });
  });
});
