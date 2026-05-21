// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";
import { preloadMockWebglAddon } from "./_preloadWebglAddon";

const mockTerminalClient = {
  onData: vi.fn(() => vi.fn()),
  onExit: vi.fn(() => vi.fn()),
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
  webGLManager: {
    isActive: (id: string) => boolean;
    ensureContext: (id: string, managed: unknown) => void;
    releaseContext: (id: string) => void;
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
    isHibernated: false,
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
    hibernationTimer: undefined as ReturnType<typeof setTimeout> | undefined,
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

  it("setVisible(true) does not call terminal.refresh on the show path", () => {
    // The pre-debounce rAF + the post-ensureContext refresh both painted
    // stale DOM rows during the WebGL transition, producing the flash.
    // WebglAddon.onLoad self-schedules its first frame; forceXtermReflow
    // covers IntersectionObserver recovery. Removed in #6802.
    const managed = makeMockManaged({ isVisible: false });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);
    (managed.terminal.refresh as ReturnType<typeof vi.fn>).mockClear();

    service.setVisible("t1", true);
    vi.advanceTimersByTime(100);

    expect(managed.terminal.refresh).not.toHaveBeenCalled();
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

  it("standard (non-agent) terminal does not acquire WebGL on show", () => {
    const managed = makeMockManaged({
      isVisible: false,
      runtimeAgentId: undefined,
      launchAgentId: undefined,
    });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.setVisible("t1", true);
    vi.advanceTimersByTime(100);

    expect(service.webGLManager.isActive("t1")).toBe(false);
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

  it("hibernated terminal short-circuits — no WebGL changes", () => {
    const managed = makeMockManaged({ isHibernated: true });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.setVisible("t1", false);
    service.setVisible("t1", true);
    vi.advanceTimersByTime(100);

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

  it("agent demotion during debounce window cancels WebGL restore", () => {
    const managed = makeMockManaged({ isVisible: false });
    service.instances.set("t1", managed as unknown as Record<string, unknown>);

    service.setVisible("t1", true);
    expect(service.webGLManager.isActive("t1")).toBe(false);

    // Demotion happens inside the debounce window — runtimeAgentId clears.
    managed.runtimeAgentId = undefined;

    vi.advanceTimersByTime(100);

    // shouldRestoreWebGL re-checks runtimeAgentId in the timer callback,
    // so the deferred restore must not fire after demotion.
    expect(service.webGLManager.isActive("t1")).toBe(false);
  });
});
