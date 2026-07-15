// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";
import { preloadMockWebglAddon } from "./_preloadWebglAddon";

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
  systemClient: { openExternal: vi.fn() },
  appClient: { getHydrationState: vi.fn() },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function () {
    return {
      dispose: vi.fn(),
      onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
    };
  }),
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

type WebGLVisibilityService = {
  instances: Map<string, Record<string, unknown>>;
  setVisible: (id: string, visible: boolean, expectedGeneration?: number) => void;
  destroy: (id: string) => void;
  applyRendererPolicy: (id: string, tier: TerminalRefreshTier) => void;
  applyAgentPromotion: (id: string, agentId: string) => void;
  clearAgentPromotion: (id: string) => void;
  webGLManager: {
    isActive: (id: string) => boolean;
    ensureContext: (id: string, managed: unknown) => void;
    releaseContext: (id: string) => void;
    getMode: () => "webgl" | "dom";
    getPinnedId: () => string | null;
    getWantsSize: () => number;
    pinAltBuffer: (id: string, managed: unknown) => void;
    unpinAltBuffer: (id: string) => void;
    isAltBufferPinned: (id: string) => boolean;
  };
};

function makeMockManaged(overrides: Record<string, unknown> = {}) {
  const terminal = {
    rows: 24,
    cols: 80,
    refresh: vi.fn(),
    loadAddon: vi.fn(),
    dispose: vi.fn(),
    hasSelection: vi.fn(() => false),
    options: { scrollback: 1000 },
    buffer: { active: { length: 24 } },
    element: document.createElement("div"),
  };

  const hostElement = document.createElement("div");
  Object.defineProperty(hostElement, "getBoundingClientRect", {
    value: () => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 }),
  });

  const managed = {
    terminal,
    type: "terminal",
    kind: "terminal",
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    imageAddon: null,
    searchAddon: {},
    fileLinksDisposable: null,
    webLinksAddon: null,
    hostElement,
    isOpened: true,
    isVisible: true,
    isFocused: false,
    isAttaching: false,
    isUserScrolledBack: false,
    isAltBuffer: false,
    runtimeAgentId: "claude" as string | undefined,
    launchAgentId: "claude",
    lastActiveTime: Date.now(),
    lastWidth: 800,
    lastHeight: 600,
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
    webGLRestoreTimer: undefined as number | undefined,
    webGLHideTimer: undefined as number | undefined,
    isInputLocked: false,
    ipcListenerCount: 0,
    attachGeneration: 0,
    attachRevealToken: 0,
    scrollbackRestoreState: "none" as const,
    ...overrides,
  };
  return managed;
}

describe("TerminalInstanceService - visibility-driven WebGL lease", () => {
  let service: WebGLVisibilityService;

  beforeEach(async () => {
    vi.useFakeTimers();
    // useFakeTimers replaces requestAnimationFrame with its own queue; the
    // WebGL manager's drain queue needs sync rAF for these tests'
    // ensureContext()→isActive() inline expectations.
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      cb(0);
      return 0;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
    vi.clearAllMocks();
    vi.resetModules();

    (window as unknown as Record<string, unknown>).electron = {
      terminal: { reportTitleState: vi.fn() },
    };

    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: WebGLVisibilityService;
      });
    service.instances.clear();
    await preloadMockWebglAddon();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("setVisible(false) holds the WebGL context for the dwell window, then releases", () => {
    const managed = makeMockManaged();
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);
    expect(service.webGLManager.isActive("t1")).toBe(true);

    service.setVisible("t1", false);

    // Within the dwell window — context still held.
    vi.advanceTimersByTime(499);
    expect(service.webGLManager.isActive("t1")).toBe(true);

    // Dwell elapses — context released.
    vi.advanceTimersByTime(1);
    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("setVisible(true) within dwell window cancels the hide timer and keeps WebGL", () => {
    const managed = makeMockManaged();
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);

    service.setVisible("t1", false);
    expect(service.webGLManager.isActive("t1")).toBe(true);

    service.setVisible("t1", true);
    vi.advanceTimersByTime(500);

    // Hide timer was cancelled on show — context still held.
    expect(service.webGLManager.isActive("t1")).toBe(true);
  });

  it("setVisible(false) does not call terminal.refresh after WebGL release", () => {
    // Calling refresh on the hide path forces the DOM renderer to paint a
    // freshly-empty frame for an offscreen terminal — the visible flash on
    // next show. Removed in #6802.
    const managed = makeMockManaged();
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);
    (managed.terminal.refresh as ReturnType<typeof vi.fn>).mockClear();

    service.setVisible("t1", false);

    expect(managed.terminal.refresh).not.toHaveBeenCalled();
  });

  it("setVisible(false) does not refresh when no WebGL was active", () => {
    const managed = makeMockManaged();
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    // Never acquired WebGL
    (managed.terminal.refresh as ReturnType<typeof vi.fn>).mockClear();

    service.setVisible("t1", false);

    expect(managed.terminal.refresh).not.toHaveBeenCalled();
  });

  it("setVisible(true) restores WebGL after the debounce window", () => {
    const managed = makeMockManaged({ isVisible: false });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    expect(service.webGLManager.isActive("t1")).toBe(false);

    service.setVisible("t1", true);

    // Restore is debounced — not active yet
    expect(service.webGLManager.isActive("t1")).toBe(false);

    vi.advanceTimersByTime(100);
    expect(service.webGLManager.isActive("t1")).toBe(true);
  });

  it("setVisible(true) refreshes after the DOM-to-WebGL swap", () => {
    // WebglAddon.onLoad activates the renderer but does not repaint existing
    // buffer rows. After the debounced restore, TerminalWebGLManager performs
    // one full-buffer refresh so terminals revealed after bulk open are not
    // left blank until the next write/focus/resize event.
    const managed = makeMockManaged({ isVisible: false });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    (managed.terminal.refresh as ReturnType<typeof vi.fn>).mockClear();

    service.setVisible("t1", true);
    vi.advanceTimersByTime(100);

    expect(managed.terminal.refresh).toHaveBeenCalledTimes(1);
    expect(managed.terminal.refresh).toHaveBeenCalledWith(0, managed.terminal.rows - 1);
  });

  it("rapid hide→show→hide keeps context held through dwell, then releases", () => {
    const managed = makeMockManaged();
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);

    service.setVisible("t1", false);
    // Hide dwell in flight — context still held.
    expect(service.webGLManager.isActive("t1")).toBe(true);

    service.setVisible("t1", true);
    // Show cancels the hide timer — context never lost.
    expect(service.webGLManager.isActive("t1")).toBe(true);

    service.setVisible("t1", false);
    // Restore timer cancelled and a new hide dwell scheduled — still held.
    expect(service.webGLManager.isActive("t1")).toBe(true);

    vi.advanceTimersByTime(500);
    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("standard (non-agent) unfocused visible terminal acquires WebGL on show (#11193)", () => {
    // Parity with agents: a visible-but-unfocused standard terminal at VISIBLE
    // tier keeps a WebGL context so blur no longer visibly shifts it to the DOM
    // renderer (mangled block/box-drawing glyphs).
    const managed = makeMockManaged({
      isVisible: false,
      isFocused: false,
      runtimeAgentId: undefined,
      launchAgentId: undefined,
      lastAppliedTier: TerminalRefreshTier.VISIBLE,
      getRefreshTier: () => TerminalRefreshTier.VISIBLE,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.setVisible("t1", true);
    vi.advanceTimersByTime(100);

    expect(service.webGLManager.isActive("t1")).toBe(true);
  });

  it("standard (non-agent) focused terminal acquires WebGL on show", () => {
    const managed = makeMockManaged({
      isVisible: false,
      runtimeAgentId: undefined,
      launchAgentId: undefined,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.setVisible("t1", true);
    vi.advanceTimersByTime(100);

    expect(service.webGLManager.isActive("t1")).toBe(true);
  });

  it("show while attaching defers WebGL restore (no addon load)", () => {
    const managed = makeMockManaged({ isVisible: false, isAttaching: true });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.setVisible("t1", true);
    vi.advanceTimersByTime(100);

    // setVisible's isAttaching branch returns early — no restore timer scheduled
    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("show while in BACKGROUND tier does not restore WebGL", () => {
    const managed = makeMockManaged({
      isVisible: false,
      lastAppliedTier: TerminalRefreshTier.BACKGROUND,
      getRefreshTier: () => TerminalRefreshTier.BACKGROUND,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.setVisible("t1", true);
    vi.advanceTimersByTime(100);

    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("destroy clears the pending WebGL restore timer", () => {
    const managed = makeMockManaged({ isVisible: false });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.setVisible("t1", true);
    expect(managed.webGLRestoreTimer).toBeDefined();

    service.destroy("t1");

    // Timer cleared (won't fire and won't crash)
    vi.advanceTimersByTime(200);
    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("stale generation cleanup does not release WebGL", () => {
    const managed = makeMockManaged({ attachGeneration: 5 });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);

    // Stale generation from a previous mount — should be ignored entirely
    service.setVisible("t1", false, 4);
    vi.advanceTimersByTime(500);
    expect(service.webGLManager.isActive("t1")).toBe(true);

    // Matching generation — release proceeds (deferred by the dwell window).
    service.setVisible("t1", false, 5);
    vi.advanceTimersByTime(500);
    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("tier demotion while hidden does not refresh (project-switch flash)", () => {
    // Project switches simultaneously hide terminals and demote their tier.
    // Refreshing an offscreen DOM produces a stale frame that flashes on
    // next show — the same root cause as the setVisible() refresh removals.
    const managed = makeMockManaged({
      isVisible: false,
      lastAppliedTier: TerminalRefreshTier.FOCUSED,
      getRefreshTier: () => TerminalRefreshTier.BACKGROUND,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);
    (managed.terminal.refresh as ReturnType<typeof vi.fn>).mockClear();

    service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
    // Downgrades go through a hysteresis timer (TIER_DOWNGRADE_HYSTERESIS_MS).
    vi.advanceTimersByTime(500);

    expect(service.webGLManager.isActive("t1")).toBe(false);
    expect(managed.terminal.refresh).not.toHaveBeenCalled();
  });

  it("tier demotion while visible keeps WebGL active (no release, no refresh)", () => {
    // Per #6801: keep WebGL while visible on tier transitions to avoid a
    // one-frame renderer gap. The release+refresh path only runs when not
    // visible, so a visible terminal sees no churn here.
    const managed = makeMockManaged({
      isVisible: true,
      lastAppliedTier: TerminalRefreshTier.FOCUSED,
      getRefreshTier: () => TerminalRefreshTier.BACKGROUND,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);
    (managed.terminal.refresh as ReturnType<typeof vi.fn>).mockClear();

    service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
    vi.advanceTimersByTime(500);

    expect(service.webGLManager.isActive("t1")).toBe(true);
    expect(managed.terminal.refresh).not.toHaveBeenCalled();
  });

  it("standard terminal tier demotion while visible keeps WebGL active (#11193)", () => {
    // Identity parity: a visible standard pane demoted to an ineligible tier
    // must not release its context — an ineligible tier while still on-screen is
    // a no-op, not a release. Guards against a reintroduced !runtimeAgentId
    // release exception, which the agent-only test above would not catch.
    const managed = makeMockManaged({
      isVisible: true,
      isFocused: false,
      runtimeAgentId: undefined,
      launchAgentId: undefined,
      lastAppliedTier: TerminalRefreshTier.FOCUSED,
      getRefreshTier: () => TerminalRefreshTier.BACKGROUND,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);
    (managed.terminal.refresh as ReturnType<typeof vi.fn>).mockClear();

    service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
    vi.advanceTimersByTime(500);

    expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.BACKGROUND);
    expect(service.webGLManager.isActive("t1")).toBe(true);
    expect(managed.terminal.refresh).not.toHaveBeenCalled();
  });

  it("standard terminal blur (FOCUSED → VISIBLE) keeps WebGL, no DOM swap (#11193)", () => {
    // The core fix: a standard pane that loses focus but stays visible drops
    // from FOCUSED to VISIBLE. Pre-#11193 this released the context and forced a
    // full-buffer refresh onto the DOM renderer (the visible glyph shift). Now
    // VISIBLE is eligible for standard terminals, so the context is retained and
    // no refresh runs.
    const managed = makeMockManaged({
      isVisible: true,
      isFocused: false,
      runtimeAgentId: undefined,
      launchAgentId: undefined,
      lastAppliedTier: TerminalRefreshTier.FOCUSED,
      getRefreshTier: () => TerminalRefreshTier.VISIBLE,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);
    expect(service.webGLManager.isActive("t1")).toBe(true);
    (managed.terminal.refresh as ReturnType<typeof vi.fn>).mockClear();

    // FOCUSED → VISIBLE is a downgrade, applied through the tier hysteresis.
    service.applyRendererPolicy("t1", TerminalRefreshTier.VISIBLE);
    vi.advanceTimersByTime(500);

    // Prove the downgrade actually fired (otherwise active/no-refresh would pass
    // vacuously if the hysteresis callback never ran).
    expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.VISIBLE);
    expect(service.webGLManager.isActive("t1")).toBe(true);
    expect(managed.terminal.refresh).not.toHaveBeenCalled();
  });

  it("a grid of visible standard terminals all hold WebGL; hiding one releases only it (#11193)", () => {
    // Issue-shaped multi-pane check: a focused standard pane plus two visible-
    // but-unfocused standard siblings all hold WebGL at once (no unfocused pane
    // stranded on the DOM renderer). Hiding one sibling releases only it, after
    // the dwell, while the visible panes keep their contexts.
    const mk = (tier: TerminalRefreshTier, isFocused: boolean) =>
      makeMockManaged({
        isVisible: true,
        isFocused,
        runtimeAgentId: undefined,
        launchAgentId: undefined,
        lastAppliedTier: tier,
        getRefreshTier: () => tier,
      });
    const focused = mk(TerminalRefreshTier.FOCUSED, true);
    const sibA = mk(TerminalRefreshTier.VISIBLE, false);
    const sibB = mk(TerminalRefreshTier.VISIBLE, false);
    service.instances.set("focused", focused as unknown as Record<string, unknown>);
    service.instances.set("sibA", sibA as unknown as Record<string, unknown>);
    service.instances.set("sibB", sibB as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("focused", focused);
    service.webGLManager.ensureContext("sibA", sibA);
    service.webGLManager.ensureContext("sibB", sibB);

    expect(service.webGLManager.isActive("focused")).toBe(true);
    expect(service.webGLManager.isActive("sibA")).toBe(true);
    expect(service.webGLManager.isActive("sibB")).toBe(true);

    service.setVisible("sibA", false);
    vi.advanceTimersByTime(500);

    expect(service.webGLManager.isActive("sibA")).toBe(false);
    expect(service.webGLManager.isActive("focused")).toBe(true);
    expect(service.webGLManager.isActive("sibB")).toBe(true);
  });

  it("destroy cancels the pending WebGL hide-dwell timer", () => {
    const managed = makeMockManaged();
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);

    service.setVisible("t1", false);
    expect(managed.webGLHideTimer).toBeDefined();

    service.destroy("t1");

    // Timer cleared (won't fire and won't crash after instances.delete)
    vi.advanceTimersByTime(500);
    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("tier demotion during hide-dwell releases WebGL and leaves no dangling timer", () => {
    // Tier demotion is an authoritative signal — when it fires (via the
    // TIER_DOWNGRADE_HYSTERESIS_MS=500 timer) the onTierApplied BACKGROUND
    // branch calls cancelWebGLHideTimer + releaseContext. Both the hide-dwell
    // (500ms) and the tier-hysteresis (500ms) timers are scheduled in the
    // same tick, so the cancel here is the defensive guarantee that the dwell
    // timer can't fire later on a stale pool slot.
    const managed = makeMockManaged({
      lastAppliedTier: TerminalRefreshTier.FOCUSED,
      getRefreshTier: () => TerminalRefreshTier.BACKGROUND,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);

    service.setVisible("t1", false);
    expect(service.webGLManager.isActive("t1")).toBe(true);
    expect(managed.webGLHideTimer).toBeDefined();

    service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
    vi.advanceTimersByTime(500);

    expect(service.webGLManager.isActive("t1")).toBe(false);
    expect(managed.webGLHideTimer).toBeUndefined();
  });

  it("runtimeAgentId cleared during the restore debounce does not cancel WebGL restore for a visible pane (#11193)", () => {
    const managed = makeMockManaged({
      isVisible: false,
      lastAppliedTier: TerminalRefreshTier.VISIBLE,
      getRefreshTier: () => TerminalRefreshTier.VISIBLE,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.setVisible("t1", true);
    expect(service.webGLManager.isActive("t1")).toBe(false);

    // The agent identity clears inside the restore debounce window (e.g. the
    // agent exits mid-reveal). Eligibility is identity-neutral now: VISIBLE
    // keeps both an agent and a plain terminal eligible, so the restore timer's
    // shouldRestoreWebGL re-check must NOT revoke the pending restore.
    managed.runtimeAgentId = undefined;

    vi.advanceTimersByTime(100);

    expect(service.webGLManager.isActive("t1")).toBe(true);
  });

  it("clearAgentPromotion keeps WebGL for a visible unfocused (VISIBLE) pane (#11193)", () => {
    // The real demotion path: agent→plain on a visible-but-unfocused pane.
    // Pre-#11193 a plain terminal was ineligible at VISIBLE, so demotion
    // released the context; now it stays WebGL-eligible, so the method must
    // keep (re-ensure) the context rather than churn it through a release.
    const managed = makeMockManaged({
      isVisible: true,
      isFocused: false,
      runtimeAgentId: "claude",
      launchAgentId: "claude",
      lastAppliedTier: TerminalRefreshTier.VISIBLE,
      getRefreshTier: () => TerminalRefreshTier.VISIBLE,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);
    expect(service.webGLManager.isActive("t1")).toBe(true);

    service.clearAgentPromotion("t1");

    expect(managed.runtimeAgentId).toBeUndefined();
    expect(service.webGLManager.isActive("t1")).toBe(true);
  });

  // #10671: off-screen agent terminals must not register a fleet-wide WebGL
  // want. The want set is per project view, so enough hidden streaming agents
  // would trip the count-based mode switch and drop the visible fleet to DOM.
  it("hidden agent at BURST tier does not acquire WebGL (#10671)", () => {
    const managed = makeMockManaged({
      isVisible: false,
      lastAppliedTier: TerminalRefreshTier.VISIBLE,
      getRefreshTier: () => TerminalRefreshTier.VISIBLE,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    // A PTY write while off-screen drives the pane to BURST. The tier still
    // applies (backpressure cadence), but the want must not be registered.
    service.applyRendererPolicy("t1", TerminalRefreshTier.BURST);

    expect(service.webGLManager.isActive("t1")).toBe(false);
    expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.BURST);
  });

  // #10671 is now identity-neutral (#11193): the off-screen guard must reject a
  // hidden standard terminal at BURST exactly as it does a hidden agent, so a
  // streaming background build/log pane can't inflate the fleet-wide want set.
  it("hidden standard terminal at BURST tier does not acquire WebGL (#10671, #11193)", () => {
    const managed = makeMockManaged({
      isVisible: false,
      runtimeAgentId: undefined,
      launchAgentId: undefined,
      lastAppliedTier: TerminalRefreshTier.VISIBLE,
      getRefreshTier: () => TerminalRefreshTier.VISIBLE,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.applyRendererPolicy("t1", TerminalRefreshTier.BURST);

    expect(service.webGLManager.isActive("t1")).toBe(false);
    expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.BURST);
  });

  it("visible agent at BURST tier still acquires WebGL (no regression)", () => {
    const managed = makeMockManaged({
      isVisible: true,
      lastAppliedTier: TerminalRefreshTier.FOCUSED,
      getRefreshTier: () => TerminalRefreshTier.FOCUSED,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.applyRendererPolicy("t1", TerminalRefreshTier.BURST);

    expect(service.webGLManager.isActive("t1")).toBe(true);
  });

  it("applyAgentPromotion on a hidden terminal does not acquire WebGL (#10671)", () => {
    const managed = makeMockManaged({
      isVisible: false,
      runtimeAgentId: undefined,
      launchAgentId: undefined,
      lastAppliedTier: TerminalRefreshTier.VISIBLE,
      getRefreshTier: () => TerminalRefreshTier.VISIBLE,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.applyAgentPromotion("t1", "claude");

    expect(managed.runtimeAgentId).toBe("claude");
    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("applyAgentPromotion on a visible terminal acquires WebGL", () => {
    const managed = makeMockManaged({
      isVisible: true,
      runtimeAgentId: undefined,
      launchAgentId: undefined,
      lastAppliedTier: TerminalRefreshTier.VISIBLE,
      getRefreshTier: () => TerminalRefreshTier.VISIBLE,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.applyAgentPromotion("t1", "claude");

    expect(service.webGLManager.isActive("t1")).toBe(true);
  });

  it("hidden agent revealed via setVisible(true) re-acquires WebGL (#10671)", () => {
    const managed = makeMockManaged({
      isVisible: false,
      lastAppliedTier: TerminalRefreshTier.VISIBLE,
      getRefreshTier: () => TerminalRefreshTier.VISIBLE,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    // Off-screen: even at an eligible tier the want is withheld.
    service.applyRendererPolicy("t1", TerminalRefreshTier.BURST);
    expect(service.webGLManager.isActive("t1")).toBe(false);

    // Reveal re-acquires through the debounced restore path.
    service.setVisible("t1", true);
    vi.advanceTimersByTime(100);
    expect(service.webGLManager.isActive("t1")).toBe(true);
  });

  it("hidden agent streaming at BURST keeps WebGL through the hide dwell, then releases (#10671)", () => {
    // A visible agent that goes off-screen mid-stream must keep its context for
    // the WEBGL_HIDE_DWELL_MS window (anti-churn for hide→show toggles) even
    // though wantsWebGLAtTier now returns false off-screen — the webGLHideTimer
    // guard in onTierApplied preserves the dwell instead of releasing on the
    // next write's tier apply.
    const managed = makeMockManaged({
      isVisible: true,
      lastAppliedTier: TerminalRefreshTier.FOCUSED,
      getRefreshTier: () => TerminalRefreshTier.FOCUSED,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    service.webGLManager.ensureContext("t1", managed);
    expect(service.webGLManager.isActive("t1")).toBe(true);

    service.setVisible("t1", false);

    // Streaming continues while off-screen — drives BURST during the dwell.
    service.applyRendererPolicy("t1", TerminalRefreshTier.BURST);
    vi.advanceTimersByTime(499);
    expect(service.webGLManager.isActive("t1")).toBe(true);

    // Dwell elapses — context released, no longer consuming the fleet budget.
    vi.advanceTimersByTime(1);
    expect(service.webGLManager.isActive("t1")).toBe(false);
  });

  it("hidden streaming agents do not inflate the fleet want count or flip to DOM (#10671)", () => {
    // The literal #10671 scenario: a handful of visible agents plus many hidden
    // background-worktree agents all streaming at BURST. Pre-fix, each hidden
    // agent registered a want; 3 visible + 15 hidden = 18 wants would exceed the
    // upper threshold and flip the whole fleet to DOM. Post-fix, only the
    // visible agents contribute wants, so the fleet stays in WebGL.
    for (let i = 0; i < 3; i++) {
      const id = `vis-${i}`;
      service.instances.set(
        id,
        makeMockManaged({
          isVisible: true,
          lastAppliedTier: TerminalRefreshTier.FOCUSED,
          getRefreshTier: () => TerminalRefreshTier.FOCUSED,
        }) as unknown as Record<string, unknown>
      );
      service.applyRendererPolicy(id, TerminalRefreshTier.BURST);
    }

    for (let i = 0; i < 15; i++) {
      const id = `hid-${i}`;
      service.instances.set(
        id,
        makeMockManaged({
          isVisible: false,
          lastAppliedTier: TerminalRefreshTier.VISIBLE,
          getRefreshTier: () => TerminalRefreshTier.VISIBLE,
        }) as unknown as Record<string, unknown>
      );
      service.applyRendererPolicy(id, TerminalRefreshTier.BURST);
    }

    expect(service.webGLManager.getWantsSize()).toBe(3);
    expect(service.webGLManager.getMode()).toBe("webgl");
    for (let i = 0; i < 3; i++) {
      expect(service.webGLManager.isActive(`vis-${i}`)).toBe(true);
    }
  });

  it("agent promoted while hidden re-acquires WebGL only after reveal (#10671)", () => {
    const managed = makeMockManaged({
      isVisible: false,
      runtimeAgentId: undefined,
      launchAgentId: undefined,
      lastAppliedTier: TerminalRefreshTier.VISIBLE,
      getRefreshTier: () => TerminalRefreshTier.VISIBLE,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    // Background detection promotes the off-screen pane — want is withheld.
    service.applyAgentPromotion("t1", "claude");
    expect(managed.runtimeAgentId).toBe("claude");
    expect(service.webGLManager.isActive("t1")).toBe(false);

    // Reveal drives the debounced restore, which now passes the visibility gate.
    service.setVisible("t1", true);
    vi.advanceTimersByTime(100);
    expect(service.webGLManager.isActive("t1")).toBe(true);
  });

  describe("WebGL DOM-mode fallback eligibility (W3)", () => {
    function callShouldRestore(managed: unknown): boolean {
      return (
        service as unknown as { webGLPolicy: { shouldRestoreWebGL: (m: unknown) => boolean } }
      ).webGLPolicy.shouldRestoreWebGL(managed);
    }
    function callShouldHaveActive(managed: unknown): boolean {
      return (
        service as unknown as {
          webGLPolicy: { shouldHaveActiveWebGL: (m: unknown) => boolean };
        }
      ).webGLPolicy.shouldHaveActiveWebGL(managed);
    }

    it("keeps a non-pinned DOM pane RESTORE-eligible so it stays in the manager's wants set", () => {
      vi.spyOn(service.webGLManager, "getMode").mockReturnValue("dom");
      vi.spyOn(service.webGLManager, "getPinnedId").mockReturnValue("pinned-other");
      const managed = makeMockManaged({ id: "t1" });

      // The reveal/visibility restore path must still call ensureContext for this
      // pane — that keeps it in `wants`, so a later focus change can pin+attach it
      // immediately instead of waiting on the watchdog.
      expect(callShouldRestore(managed)).toBe(true);
    });

    it("withholds WATCHDOG repair for a non-pinned pane while in DOM-mode fallback", () => {
      vi.spyOn(service.webGLManager, "getMode").mockReturnValue("dom");
      vi.spyOn(service.webGLManager, "getPinnedId").mockReturnValue("pinned-other");
      const managed = makeMockManaged({ id: "t1" });

      // In DOM mode the manager only ever attaches the pinned pane; the watchdog
      // must not burn a heavy-repair slot retrying a context it will never get.
      expect(callShouldHaveActive(managed)).toBe(false);
    });

    it("still repairs the focus-pinned pane while in DOM-mode fallback", () => {
      vi.spyOn(service.webGLManager, "getMode").mockReturnValue("dom");
      vi.spyOn(service.webGLManager, "getPinnedId").mockReturnValue("t1");
      const managed = makeMockManaged({ id: "t1" });

      expect(callShouldHaveActive(managed)).toBe(true);
    });

    it("still repairs an alt-buffer-pinned pane while in DOM-mode fallback (#10768)", () => {
      vi.spyOn(service.webGLManager, "getMode").mockReturnValue("dom");
      vi.spyOn(service.webGLManager, "getPinnedId").mockReturnValue("pinned-other");
      vi.spyOn(service.webGLManager, "isAltBufferPinned").mockReturnValue(true);
      const managed = makeMockManaged({ id: "t1" });

      // Alt-buffer pins keep a context in DOM mode just like the focus pin, so
      // the watchdog must treat a missing context as a real fault to repair.
      expect(callShouldHaveActive(managed)).toBe(true);
    });

    it("does not withhold watchdog repair outside DOM-mode fallback", () => {
      vi.spyOn(service.webGLManager, "getMode").mockReturnValue("webgl");
      vi.spyOn(service.webGLManager, "getPinnedId").mockReturnValue("pinned-other");
      const managed = makeMockManaged({ id: "t1" });

      expect(callShouldHaveActive(managed)).toBe(true);
    });
  });

  describe("alt-buffer pin wiring (#10768)", () => {
    function handleBufferModeChange(id: string, isAltBuffer: boolean): void {
      (
        service as unknown as {
          handleBufferModeChange: (id: string, isAltBuffer: boolean) => void;
        }
      ).handleBufferModeChange(id, isAltBuffer);
    }

    it("entering the alt-buffer pins the terminal in the WebGL manager", () => {
      const managed = makeMockManaged({ id: "t1" });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);
      const pinSpy = vi.spyOn(service.webGLManager, "pinAltBuffer");

      handleBufferModeChange("t1", true);

      expect(pinSpy).toHaveBeenCalledWith("t1", managed);
      expect(service.webGLManager.isAltBufferPinned("t1")).toBe(true);
    });

    it("returning to the normal buffer unpins the terminal", () => {
      const managed = makeMockManaged({ id: "t1" });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);
      const unpinSpy = vi.spyOn(service.webGLManager, "unpinAltBuffer");

      handleBufferModeChange("t1", true);
      handleBufferModeChange("t1", false);

      expect(unpinSpy).toHaveBeenCalledWith("t1");
      expect(service.webGLManager.isAltBufferPinned("t1")).toBe(false);
    });
  });

  describe("shouldRestoreWebGL — trust DOM visibility on reveal (W1)", () => {
    function callShouldRestore(managed: unknown, opts?: { trustDomVisibility?: boolean }): boolean {
      return (
        service as unknown as {
          webGLPolicy: {
            shouldRestoreWebGL: (m: unknown, o?: { trustDomVisibility?: boolean }) => boolean;
          };
        }
      ).webGLPolicy.shouldRestoreWebGL(managed, opts);
    }

    it("withholds restore for a stale isVisible=false pane by default", () => {
      const managed = makeMockManaged({ id: "t1", isVisible: false });
      expect(callShouldRestore(managed)).toBe(false);
    });

    it("restores a stale isVisible=false pane when DOM truth is trusted (reveal path)", () => {
      const managed = makeMockManaged({ id: "t1", isVisible: false });
      // repaintForReveal proves the pane on-screen from DOM truth before it
      // reattaches WebGL, so a stale reactive isVisible=false must not veto the
      // want — otherwise non-focused agent panes sit on the DOM renderer (mangled
      // block glyphs) until the watchdog heals (#10632 item 4 / W1). The guard is
      // threaded through wantsWebGLAtTier, which gates on isVisible too.
      expect(callShouldRestore(managed, { trustDomVisibility: true })).toBe(true);
    });
  });
});
