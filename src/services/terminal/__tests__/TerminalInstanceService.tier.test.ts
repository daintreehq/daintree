// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";

// Captured at service construction so tests can drive the host→renderer tier
// reconciliation path even after vi.clearAllMocks() wipes spy call history.
let capturedTierChangedCb: ((id: string, tier: "active" | "background") => void) | null = null;

const mockTerminalClient = {
  onData: vi.fn(() => vi.fn()),
  onExit: vi.fn(() => vi.fn()),
  onTierChanged: vi.fn((cb: (id: string, tier: "active" | "background") => void) => {
    capturedTierChangedCb = cb;
    return vi.fn();
  }),
  setActivityTier: vi.fn(),
  // The background→active foreground transition now runs a plain repaint whose
  // handlePostWake reaches resize() for default-strategy panes.
  resize: vi.fn(),
  wake: vi.fn(),
  getSerializedState: vi.fn(),
  getSharedBuffer: vi.fn(() => null),
  acknowledgePortData: vi.fn(),
  discardPortAcks: vi.fn(),
  acknowledgeData: vi.fn(),
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

type TierTestService = {
  instances: Map<string, Record<string, unknown>>;
  applyRendererPolicy: (id: string, tier: TerminalRefreshTier) => void;
  prewarmTerminal: (
    id: string,
    type: string,
    options: Record<string, unknown>,
    params?: Record<string, unknown>
  ) => Record<string, unknown>;
  destroy: (id: string) => void;
  updateOptions: (id: string, options: Record<string, unknown>) => void;
  applyAgentPromotion: (id: string, agentId: string) => void;
  clearAgentPromotion: (id: string) => void;
  writeController: { write: (id: string, data: string | Uint8Array) => void };
};

function makeMockManaged(overrides: Record<string, unknown> = {}) {
  return {
    terminal: {
      options: { scrollback: 5000, cursorBlink: true },
      rows: 24,
      cols: 80,
      buffer: {
        active: { length: 100, type: "normal", baseY: 0, viewportY: 0 },
        onBufferChange: vi.fn(() => ({ dispose: vi.fn() })),
      },
      refresh: vi.fn(),
      loadAddon: vi.fn(),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      hasSelection: vi.fn(() => false),
      dispose: vi.fn(),
      write: vi.fn(),
    },
    type: "terminal",
    kind: "terminal",
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    imageAddon: { dispose: vi.fn() } as { dispose: ReturnType<typeof vi.fn> } | null,
    searchAddon: {},
    fileLinksDisposable: { dispose: vi.fn() } as { dispose: ReturnType<typeof vi.fn> } | null,
    webLinksAddon: { dispose: vi.fn() } as { dispose: ReturnType<typeof vi.fn> } | null,
    // The foreground (background→active) transition now runs a plain repaint that
    // measures the host; jsdom's div lacks checkVisibility. Stub it false so the
    // geometry path bails cleanly — these tests cover addon/cursorBlink/tier
    // behavior, not layout.
    hostElement: Object.assign(document.createElement("div"), {
      checkVisibility: () => false,
    }),
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
    ...overrides,
  };
}

describe("TerminalInstanceService - Activity Tier", () => {
  let service: TierTestService;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: TierTestService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Tier Mapping", () => {
    it("should map TerminalRefreshTier.BACKGROUND to backend background tier", () => {
      expect(TerminalRefreshTier.BACKGROUND).toBe(1000);
    });

    it("should map active refresh tiers to backend active tier", () => {
      expect(TerminalRefreshTier.BURST).toBe(16);
      expect(TerminalRefreshTier.FOCUSED).toBe(100);
      expect(TerminalRefreshTier.VISIBLE).toBe(200);
    });
  });

  describe("Addon Lifecycle on Tier Transitions", () => {
    it("keeps content addons live when transitioning to BACKGROUND (hibernation removed)", () => {
      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.FOCUSED });
      const imageDispose = managed.imageAddon!.dispose;
      const fileLinksDispose = managed.fileLinksDisposable!.dispose;
      const webLinksDispose = managed.webLinksAddon!.dispose;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      // Downgrade has 500ms hysteresis
      vi.advanceTimersByTime(600);

      // Background panes stay fully live — image/link addons are NOT torn down.
      // (WebGL context release is the only visibility-gated optimization kept.)
      expect(imageDispose).not.toHaveBeenCalled();
      expect(fileLinksDispose).not.toHaveBeenCalled();
      expect(webLinksDispose).not.toHaveBeenCalled();
      expect(managed.imageAddon).not.toBeNull();
      expect(managed.fileLinksDisposable).not.toBeNull();
      expect(managed.webLinksAddon).not.toBeNull();
    });

    it("should recreate addons when transitioning from BACKGROUND to VISIBLE", async () => {
      const { createImageAddon, createFileLinksAddon, createWebLinksAddon } =
        await import("../TerminalAddonManager");

      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        imageAddon: null,
        fileLinksDisposable: null,
        webLinksAddon: null,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      // Upgrade from BACKGROUND to VISIBLE is immediate (no hysteresis)
      service.applyRendererPolicy("t1", TerminalRefreshTier.VISIBLE);

      expect(createImageAddon).toHaveBeenCalled();
      expect(createFileLinksAddon).toHaveBeenCalled();
      expect(createWebLinksAddon).toHaveBeenCalled();
      // The link providers attach synchronously; the lazy ImageAddon (#10840)
      // resolves a microtask later, so flush before asserting its slot is set.
      await Promise.resolve();
      await Promise.resolve();
      expect(managed.imageAddon).not.toBeNull();
      expect(managed.fileLinksDisposable).not.toBeNull();
      expect(managed.webLinksAddon).not.toBeNull();
    });

    it("should recreate addons when transitioning from BACKGROUND to FOCUSED", async () => {
      const { createImageAddon, createFileLinksAddon, createWebLinksAddon } =
        await import("../TerminalAddonManager");

      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        imageAddon: null,
        fileLinksDisposable: null,
        webLinksAddon: null,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.FOCUSED);

      expect(createImageAddon).toHaveBeenCalled();
      expect(createFileLinksAddon).toHaveBeenCalled();
      expect(createWebLinksAddon).toHaveBeenCalled();
    });

    it("should not dispose already-null addons", () => {
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        imageAddon: null,
        fileLinksDisposable: null,
        webLinksAddon: null,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600);

      // Should not throw — null addons are handled gracefully
      expect(managed.imageAddon).toBeNull();
      expect(managed.fileLinksDisposable).toBeNull();
      expect(managed.webLinksAddon).toBeNull();
    });

    it("should not recreate addons that already exist on upgrade", async () => {
      const { createImageAddon, createFileLinksAddon, createWebLinksAddon } =
        await import("../TerminalAddonManager");
      vi.mocked(createImageAddon).mockClear();
      vi.mocked(createFileLinksAddon).mockClear();
      vi.mocked(createWebLinksAddon).mockClear();

      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        // Addons already exist (shouldn't happen normally but tests guard condition)
        imageAddon: { dispose: vi.fn() },
        fileLinksDisposable: { dispose: vi.fn() },
        webLinksAddon: { dispose: vi.fn() },
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.VISIBLE);

      expect(createImageAddon).not.toHaveBeenCalled();
      expect(createFileLinksAddon).not.toHaveBeenCalled();
      expect(createWebLinksAddon).not.toHaveBeenCalled();
    });

    it("keeps content addons live and sets lastAppliedTier for terminals created at BACKGROUND tier", async () => {
      const managed = await service.prewarmTerminal("t-bg", "terminal", {});
      const m = managed as unknown as {
        imageAddon: unknown;
        fileLinksDisposable: unknown;
        webLinksAddon: unknown;
        lastAppliedTier: TerminalRefreshTier;
      };

      // Finding 3 of the teardown: a pane created at BACKGROUND stays fully
      // content-live — its addons are NOT torn down — while lastAppliedTier still
      // records BACKGROUND so WebGL stays released until foreground.
      expect(m.imageAddon).not.toBeNull();
      expect(m.fileLinksDisposable).not.toBeNull();
      expect(m.webLinksAddon).not.toBeNull();
      expect(m.lastAppliedTier).toBe(TerminalRefreshTier.BACKGROUND);
    });

    it("should handle destroy on background-tier terminal with null addons", () => {
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        imageAddon: null,
        fileLinksDisposable: null,
        webLinksAddon: null,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      // Should not throw
      expect(() => service.destroy("t1")).not.toThrow();
    });
  });

  describe("initializeBackendTier", () => {
    it("should be documented as part of the hydration flow", () => {
      // Unit tests for the actual logic are in TerminalRendererPolicy.test.ts
      expect(true).toBe(true);
    });
  });

  describe("host-pushed tier reconciliation (issue #9778)", () => {
    it("subscribes to terminalClient.onTierChanged on first terminal creation", async () => {
      // The subscription is installed lazily (alongside onData/onExit) so that
      // merely constructing the singleton never reaches into terminalClient —
      // keeping it out of unrelated component tests' import graph.
      await service.prewarmTerminal("warm", "terminal", {});
      expect(capturedTierChangedCb).toBeTypeOf("function");
    });

    it("re-arms the outbound dedupe baseline when the host pushes a background demotion (#9778)", async () => {
      // Create a terminal so the lazy onTierChanged subscription is installed.
      await service.prewarmTerminal("warm", "terminal", {});

      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.VISIBLE });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      // Establish the renderer's outbound baseline as "active".
      service.applyRendererPolicy("t1", TerminalRefreshTier.FOCUSED);
      expect(mockTerminalClient.setActivityTier).toHaveBeenCalledWith("t1", "active", 50);
      mockTerminalClient.setActivityTier.mockClear();
      managed.lastAppliedTier = TerminalRefreshTier.FOCUSED;

      // The host's recomputeActivityTiers silently demotes this terminal and
      // pushes the tier-changed control message over the MessagePort. It must
      // funnel into rendererPolicy.initializeBackendTier and re-arm the baseline
      // to "background" — WITHOUT setting needsWake (which no longer exists).
      capturedTierChangedCb?.("t1", "background");

      // The next reactivation must RESEND "active" instead of dedupe-dropping it
      // as a redundant same-tier call (the #9778 trap that stranded the producer
      // gate suppressing bytes while the pane looked active).
      service.applyRendererPolicy("t1", TerminalRefreshTier.BURST);
      expect(mockTerminalClient.setActivityTier).toHaveBeenCalledWith("t1", "active", 50);
    });

    it("does not arm needsWake on a host-pushed tier (the field is permanently false)", async () => {
      await service.prewarmTerminal("warm", "terminal", {});

      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        needsWake: false,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      capturedTierChangedCb?.("t1", "background");
      expect(managed.needsWake).toBe(false);

      capturedTierChangedCb?.("t1", "active");
      expect(managed.needsWake).toBe(false);
    });
  });

  describe("cursorBlink Tier Toggle (plain terminals)", () => {
    it("disables cursorBlink for plain terminals on transition to BACKGROUND", () => {
      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.FOCUSED });
      // Plain terminal: no runtimeAgentId
      managed.terminal.options.cursorBlink = true;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600);

      expect(managed.terminal.options.cursorBlink).toBe(false);
    });

    it("disables cursorBlink for plain terminals on transition to VISIBLE", () => {
      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.FOCUSED });
      managed.terminal.options.cursorBlink = true;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      // VISIBLE is not focused/burst — pane is in a non-focused split, blink off
      service.applyRendererPolicy("t1", TerminalRefreshTier.VISIBLE);
      vi.advanceTimersByTime(600);

      expect(managed.terminal.options.cursorBlink).toBe(false);
    });

    it("enables cursorBlink for plain terminals on transition to FOCUSED", () => {
      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.BACKGROUND });
      managed.terminal.options.cursorBlink = false;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.FOCUSED);

      expect(managed.terminal.options.cursorBlink).toBe(true);
    });

    it("enables cursorBlink for plain terminals on transition to BURST", () => {
      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.VISIBLE });
      managed.terminal.options.cursorBlink = false;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BURST);

      expect(managed.terminal.options.cursorBlink).toBe(true);
    });

    it("does not touch cursorBlink for agent terminals (left at create-time false)", () => {
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        runtimeAgentId: "claude",
        launchAgentId: "claude",
      });
      managed.terminal.options.cursorBlink = false;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.FOCUSED);

      // Agent terminal: blink stays off regardless of tier
      expect(managed.terminal.options.cursorBlink).toBe(false);
    });

    it("updateOptions does not re-enable cursorBlink on a backgrounded plain terminal", () => {
      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.BACKGROUND });
      managed.terminal.options.cursorBlink = false;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      // Simulate a theme update flowing through BASE_TERMINAL_OPTIONS, which
      // always carries cursorBlink:true. Avoid font-metric keys so the
      // resize-controller refit path is not taken (jsdom lacks
      // hostElement.checkVisibility).
      service.updateOptions("t1", { cursorBlink: true });

      expect(managed.terminal.options.cursorBlink).toBe(false);
    });

    it("applyAgentPromotion forces cursorBlink off on a runtime-detected agent", () => {
      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.FOCUSED });
      managed.terminal.options.cursorBlink = true;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyAgentPromotion("t1", "codex");

      expect(managed.terminal.options.cursorBlink).toBe(false);
    });

    it("clearAgentPromotion re-evaluates blink policy for the now-plain terminal", () => {
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        runtimeAgentId: "codex",
      });
      managed.terminal.options.cursorBlink = false;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.clearAgentPromotion("t1");

      // Plain at FOCUSED → blink on.
      expect(managed.terminal.options.cursorBlink).toBe(true);
    });
  });

  describe("Write-driven BURST tier", () => {
    it("promotes a FOCUSED terminal to BURST on first PTY write", () => {
      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.FOCUSED });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.writeController.write("t1", "hello");

      expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.BURST);
    });

    it("decays back to the panel's current tier after the idle window", () => {
      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.FOCUSED });
      managed.getRefreshTier = () => TerminalRefreshTier.FOCUSED;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.writeController.write("t1", "hello");
      expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.BURST);

      // 500ms write-burst decay + 500ms downgrade hysteresis in the policy.
      vi.advanceTimersByTime(1100);

      expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.FOCUSED);
    });

    it("rapid-fire writes do not churn the decay timer (deadline extension is O(1))", () => {
      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.FOCUSED });
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      const setSpy = vi.spyOn(globalThis, "setTimeout");
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      // 100 back-to-back writes — naive per-write clearTimeout/setTimeout
      // would produce ~200 timer-table touches. The deadline-timestamp
      // pattern caps it at the single decay timer (≤ 2) regardless of
      // write count, which is the load-bearing perf invariant.
      const setCallsBefore = setSpy.mock.calls.length;
      const clearCallsBefore = clearSpy.mock.calls.length;
      for (let i = 0; i < 100; i++) {
        service.writeController.write("t1", "x");
      }
      const setCallsAfter = setSpy.mock.calls.length;
      const clearCallsAfter = clearSpy.mock.calls.length;

      // Lower bound: at least the single decay timer must be armed,
      // otherwise the test would pass even on a no-op implementation.
      expect(setCallsAfter - setCallsBefore).toBeGreaterThanOrEqual(1);
      expect(setCallsAfter - setCallsBefore).toBeLessThanOrEqual(2);
      expect(clearCallsAfter - clearCallsBefore).toBe(0);

      clearSpy.mockRestore();
      setSpy.mockRestore();
    });

    it("writes during an active burst cancel a pending downgrade timer", () => {
      // Regression: previously the deadline-gated re-promotion skipped
      // applyRendererPolicy(BURST) for in-window writes, so a
      // focus-loss-scheduled downgrade fired unopposed and stranded the
      // terminal at the lower tier mid-stream. Writes must always
      // re-assert BURST so the policy's tier===currentApplied early-return
      // cancels any pending tierChangeTimer.
      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.FOCUSED });
      managed.getRefreshTier = () => TerminalRefreshTier.VISIBLE;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.writeController.write("t1", "x");
      expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.BURST);

      // Simulate focus loss: schedule a downgrade to VISIBLE. This arms
      // the policy's tierChangeTimer with 500ms hysteresis.
      service.applyRendererPolicy("t1", TerminalRefreshTier.VISIBLE);
      const pendingTier = (managed as unknown as { pendingTier?: TerminalRefreshTier }).pendingTier;
      expect(pendingTier).toBe(TerminalRefreshTier.VISIBLE);

      // A new write 200ms later (still inside the burst window) must
      // cancel that pending downgrade.
      vi.advanceTimersByTime(200);
      service.writeController.write("t1", "y");

      expect(
        (managed as unknown as { pendingTier?: TerminalRefreshTier }).pendingTier
      ).toBeUndefined();
      expect((managed as unknown as { tierChangeTimer?: number }).tierChangeTimer).toBeUndefined();
      expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.BURST);

      // Confirm: advancing past the original 500ms hysteresis does NOT
      // drop to VISIBLE, since the timer was cancelled.
      vi.advanceTimersByTime(400);
      expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.BURST);
    });

    it("does not arm a write-burst timer on the deferred-restore path", () => {
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        isSerializedRestoreInProgress: true,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.writeController.write("t1", "x");

      expect((managed as unknown as { writeBurstTimer?: number }).writeBurstTimer).toBeUndefined();
      expect(
        (managed as unknown as { writeBurstDeadline?: number }).writeBurstDeadline
      ).toBeUndefined();
      expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.FOCUSED);
    });

    it("isolates write-burst state across terminals", () => {
      const t1 = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.FOCUSED });
      const t2 = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.FOCUSED });
      service.instances.set("t1", t1 as unknown as Record<string, unknown>);
      service.instances.set("t2", t2 as unknown as Record<string, unknown>);

      service.writeController.write("t1", "x");

      expect(t1.lastAppliedTier).toBe(TerminalRefreshTier.BURST);
      expect(t2.lastAppliedTier).toBe(TerminalRefreshTier.FOCUSED);
      expect((t1 as unknown as { writeBurstTimer?: number }).writeBurstTimer).toBeDefined();
      expect((t2 as unknown as { writeBurstTimer?: number }).writeBurstTimer).toBeUndefined();
    });

    it("focus-only tier changes do not manufacture BURST (regression guard)", () => {
      // Before this refactor, focus events promoted to BURST. The fix is
      // that BURST is exclusively write-driven; a pure focus transition
      // must land at FOCUSED, not BURST.
      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.VISIBLE });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.FOCUSED);

      expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.FOCUSED);
      expect((managed as unknown as { writeBurstTimer?: number }).writeBurstTimer).toBeUndefined();
    });

    it("re-arms the decay timer when writes extend the deadline mid-flight", () => {
      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.FOCUSED });
      managed.getRefreshTier = () => TerminalRefreshTier.FOCUSED;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.writeController.write("t1", "x"); // arms 500ms timer
      vi.advanceTimersByTime(400); // 400ms in, 100ms to go
      service.writeController.write("t1", "y"); // bumps deadline to t+900

      vi.advanceTimersByTime(150); // t=550, original timer fires, re-arms for 350ms
      // Tier must NOT have decayed yet — the write extended the window.
      expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.BURST);

      // Advance past the new deadline + policy hysteresis.
      vi.advanceTimersByTime(900);
      expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.FOCUSED);
    });

    it("destroy clears the pending write-burst timer", () => {
      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.FOCUSED });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.writeController.write("t1", "x");
      const writeBurstTimer = (managed as unknown as { writeBurstTimer?: number }).writeBurstTimer;
      expect(writeBurstTimer).toBeDefined();

      service.destroy("t1");

      expect((managed as unknown as { writeBurstTimer?: number }).writeBurstTimer).toBeUndefined();
      expect(
        (managed as unknown as { writeBurstDeadline?: number }).writeBurstDeadline
      ).toBeUndefined();

      // Advancing past the original window must not throw or re-touch the tier.
      const tierAtDestroy = managed.lastAppliedTier;
      vi.advanceTimersByTime(1100);
      expect(managed.lastAppliedTier).toBe(tierAtDestroy);
    });
  });

  describe("Scrollback Reduce Cooldown", () => {
    it("clears lastScrollbackReduceAt on tier upgrade", () => {
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        lastScrollbackReduceAt: 12345,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.FOCUSED);

      expect(
        (managed as unknown as { lastScrollbackReduceAt: number | undefined })
          .lastScrollbackReduceAt
      ).toBeUndefined();
    });
  });
});

// A separate top-level block: these tests mutate the real panelStore singleton,
// so each one resets modules to get a fresh store and a fresh service singleton
// rather than leaking flowStatus/backgroundedTerminals across cases.
type InputWakeService = {
  instances: Map<string, Record<string, unknown>>;
  onUserInput: (id: string, data: string) => void;
  wake: (id: string) => boolean;
};

type PanelStoreModule = {
  usePanelStore: {
    getState: () => Record<string, unknown>;
    setState: (partial: Record<string, unknown>) => void;
  };
};

describe("TerminalInstanceService - onUserInput wake for paused-backpressure", () => {
  let service: InputWakeService;
  let panelStore: PanelStoreModule["usePanelStore"];
  let wakeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.clearAllMocks();

    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: InputWakeService;
      });
    ({ usePanelStore: panelStore } =
      (await import("@/store/panelStore")) as unknown as PanelStoreModule);

    // wake() is now a plain repaint (no host snapshot wake) reporting whether it
    // painted. Stub it as a landed repaint so these tests assert the onUserInput
    // ROUTING decision (which panes get an unstick reveal on type) without
    // driving the real geometry/repaint path.
    wakeSpy = vi.spyOn(service, "wake").mockImplementation(() => true);

    service.instances.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    service.instances.clear();
  });

  function setStore(flowStatus: string, backgrounded: boolean) {
    panelStore.setState({
      panelsById: { t1: { kind: "terminal", flowStatus } },
      backgroundedTerminals: backgrounded ? new Map([["t1", {}]]) : new Map(),
    });
  }

  it("reveals a visible paused-backpressure terminal on user input", () => {
    service.instances.set("t1", makeMockManaged() as unknown as Record<string, unknown>);
    setStore("paused-backpressure", false);

    service.onUserInput("t1", "a");

    expect(wakeSpy).toHaveBeenCalledTimes(1);
    expect(wakeSpy).toHaveBeenCalledWith("t1");
  });

  it("does not reveal a backgrounded paused-backpressure terminal", () => {
    service.instances.set("t1", makeMockManaged() as unknown as Record<string, unknown>);
    setStore("paused-backpressure", true);

    service.onUserInput("t1", "a");

    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it("does not reveal a running terminal on user input", () => {
    service.instances.set("t1", makeMockManaged() as unknown as Record<string, unknown>);
    setStore("running", false);

    service.onUserInput("t1", "a");

    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it("does not reveal a paused-resource-governor terminal on user input", () => {
    // The backpressure-only exclusion is intentional and locked by this test:
    // resource-governor pauses are not unstuck by a reveal.
    service.instances.set("t1", makeMockManaged() as unknown as Record<string, unknown>);
    setStore("paused-resource-governor", false);

    service.onUserInput("t1", "a");

    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it("does not reveal when the panel is not a PTY panel", () => {
    // flowStatus is a PtyPanelData field; the isPtyPanel guard keeps the
    // condition type-safe against the BrowserPanelData branch of the union.
    service.instances.set("t1", makeMockManaged() as unknown as Record<string, unknown>);
    panelStore.setState({
      panelsById: { t1: { kind: "browser", flowStatus: "paused-backpressure" } },
      backgroundedTerminals: new Map(),
    });

    service.onUserInput("t1", "a");

    expect(wakeSpy).not.toHaveBeenCalled();
  });
});
