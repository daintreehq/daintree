// @vitest-environment jsdom
//
// Regression for #10632 — "agent terminals don't auto-redraw on project
// switch-back". This recreates the BROKEN state the issue describes and proves
// the closed-loop watchdog recovery converges it WITHOUT a manual Redraw.
//
// It drives the REAL TerminalReconciliationWatchdog against a deterministic fake
// of a live agent CLI (DEC 2026 synchronized output, optionally on the alternate
// screen — the same class of process the deleted
// `e2e/fixtures/fake-claude-agent.cjs` modelled). The fake's container CHANGES
// COLUMN COUNT while the project is backgrounded, so on switch-back its xterm
// grid wraps at the wrong width (the "garbled line flow") and its renderer is
// left paused — exactly the two halves a manual Redraw fixes.
//
// Both buffer modes take the geometry-convergence branch. An alt-screen pane
// (#16359) gets its xterm and PTY moved together and the app's own SIGWINCH
// redraw repaints the frame; the fake records what xterm held at the moment
// each PTY resize reached the app.
//
// The `reconcileRevealGeometry` dep mirrors what the real
// TerminalInstanceService does, and its geometry half IS the real
// `TerminalResizeController.reconcileGeometryFresh`, which only succeeds
// against a foreground-renderable host (checkVisibility + non-zero box), so a
// repaint is never issued into an occluded surface. That is what makes the
// "dead zone" assertions meaningful.
//
// WEBGL-LANE CAVEAT (documented per the issue's hard requirement; ACCEPTED as a
// follow-up, not part of this fix): E2E runs the DOM renderer with WebGL OFF, so
// the stale-atlas variant (#9679/#9894) is invisible to it. Here `atlasRepairs`
// is a STAND-IN for the local glyph-model repair
// (`TerminalWebGLManager.repairAtlasForReactivation`) and we assert it ran AFTER
// the host became foreground-presenting — the ordering invariant. A true
// stale-atlas-recurrence assertion still needs a WebGL-ON pixel lane with
// framebuffer readback (`gl.readPixels` / Electron `capturePage` of the pane
// rect) comparing presented glyph cells to expected text; that cannot run in
// jsdom and is tracked as separate infra work, NOT covered by this test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";
import {
  TerminalReconciliationWatchdog,
  WATCHDOG_INTERVAL_MS,
  type ReconciliationWatchdogDeps,
} from "../TerminalReconciliationWatchdog";
import { TerminalResizeController } from "../TerminalResizeController";
import {
  __resetSidebarHydrationLockForTests,
  unlockSidebarHydration,
} from "@/lib/layoutTransitionLock";
import type { ManagedTerminal } from "../types";

const { ptyResizeMock } = vi.hoisted(() => ({ ptyResizeMock: vi.fn() }));

vi.mock("@/clients", () => ({
  terminalClient: { resize: ptyResizeMock },
}));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

interface FakeAgent {
  /** xterm grid the buffer is currently wrapping at. */
  cols: number;
  rows: number;
  /** What the (now-resized) container can actually hold — proposeDimensions(). */
  containerCols: number;
  containerRows: number;
  /** xterm core render-service paused flag (set while the view was occluded). */
  paused: boolean;
  /** Inside an open DEC 2026 synchronized-output block. */
  synchronized: boolean;
  /** Foreground-presented (true) vs occluded behind the warm bridge / on another project (false). */
  onScreen: boolean;
  /** Count of local atlas repairs (the WebGL stale-glyph-model reset). */
  atlasRepairs: number;
  /**
   * Every PTY resize the app received, with the grid xterm already held when
   * the SIGWINCH arrived — the grid the app's redraw lands in.
   */
  sigwinch: Array<{ cols: number; rows: number; xtermCols: number; xtermRows: number }>;
}

function newAgent(): FakeAgent {
  return {
    cols: 120,
    rows: 40,
    containerCols: 120,
    containerRows: 40,
    paused: false,
    synchronized: false,
    onScreen: true,
    atlasRepairs: 0,
    sigwinch: [],
  };
}

function buildManaged(agent: FakeAgent, isAltBuffer: boolean): ManagedTerminal {
  const hostElement = document.createElement("div");
  const termEl = document.createElement("div");
  hostElement.appendChild(termEl);
  document.body.appendChild(hostElement);

  // Warm path: the host is ALWAYS connected to the live (cached) document — the
  // renderer/store are never torn down. Only its layout box changes between
  // foreground (measurable) and occluded (zero box / checkVisibility false).
  hostElement.getBoundingClientRect = () =>
    agent.onScreen
      ? ({ width: 800, height: 600, top: 0, bottom: 600, left: 0, right: 800 } as DOMRect)
      : ({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 } as DOMRect);
  (hostElement as unknown as { checkVisibility: () => boolean }).checkVisibility = () =>
    agent.onScreen;
  Object.defineProperty(hostElement, "clientWidth", { get: () => (agent.onScreen ? 800 : 0) });
  Object.defineProperty(hostElement, "clientHeight", { get: () => (agent.onScreen ? 600 : 0) });

  const terminal = {
    element: termEl,
    modes: {
      get synchronizedOutputMode() {
        return agent.synchronized;
      },
    },
    get cols() {
      return agent.cols;
    },
    get rows() {
      return agent.rows;
    },
    resize: vi.fn((cols: number, rows: number) => {
      agent.cols = cols;
      agent.rows = rows;
    }),
    scrollToBottom: vi.fn(),
    refresh: vi.fn(),
    _core: {
      _renderService: {
        get _isPaused() {
          return agent.paused;
        },
        // Writable, because that is how the pause is actually cleared (#11800):
        // xterm only ever writes this from its own IntersectionObserver, so the
        // repair forces the flag and repaints.
        set _isPaused(next: boolean) {
          agent.paused = next;
        },
      },
    },
  } as unknown as ManagedTerminal["terminal"];

  const fitAddon = {
    proposeDimensions: () => ({ cols: agent.containerCols, rows: agent.containerRows }),
    fit: vi.fn(),
  } as unknown as ManagedTerminal["fitAddon"];

  return {
    terminal,
    fitAddon,
    hostElement,
    kind: "terminal",
    isOpened: true,
    isVisible: true,
    isFocused: false,
    isAttaching: false,
    isDetached: false,
    isResizeSuppressed: false,
    isUserScrolledBack: false,
    isAltBuffer,
    lastActiveTime: Date.now(),
    lastWidth: 0,
    lastHeight: 0,
    lastAttachAt: 0,
    lastDetachAt: 0,
    latestCols: agent.cols,
    latestRows: agent.rows,
    latestWasAtBottom: true,
    listeners: [],
    exitSubscribers: new Set(),
    agentStateSubscribers: new Set(),
    altBufferListeners: new Set(),
    writeChain: Promise.resolve(),
    restoreGeneration: 0,
    isSerializedRestoreInProgress: false,
    deferredOutput: [],
    scrollbackRestoreState: "none",
    attachGeneration: 0,
    attachRevealToken: 0,
    keyHandlerInstalled: false,
    ipcListenerCount: 0,
    lastAppliedTier: TerminalRefreshTier.VISIBLE,
    getRefreshTier: () => TerminalRefreshTier.VISIBLE,
  } as unknown as ManagedTerminal;
}

function buildDeps(
  instances: Map<string, ManagedTerminal>,
  agents: Map<string, FakeAgent>
): ReconciliationWatchdogDeps {
  const resizeController = new TerminalResizeController({
    getInstance: (id) => instances.get(id),
    dataBuffer: {
      getQueuedBytes: () => 0,
      flushForTerminal: vi.fn(),
      resetForTerminal: vi.fn(),
      resumeFlush: vi.fn(),
    } as unknown as ConstructorParameters<typeof TerminalResizeController>[0]["dataBuffer"],
  });
  ptyResizeMock.mockImplementation((id: string, cols: number, rows: number) => {
    const agent = agents.get(id);
    if (agent) agent.sigwinch.push({ cols, rows, xtermCols: agent.cols, xtermRows: agent.rows });
  });
  return {
    getInstances: () => instances.entries(),
    setVisible: vi.fn(),
    applyRendererPolicy: vi.fn(),
    reassertActiveBackendTier: vi.fn(),
    getBackendTier: vi.fn(() => "active" as const),
    getStalledBytes: vi.fn(() => 0),
    getQueuedBytes: vi.fn(() => 0),
    resumeFlush: vi.fn(),
    hasInFlightWake: vi.fn(() => false),
    hasPendingWake: vi.fn(() => false),
    isResizeTransitioning: vi.fn(() => false),
    isWebGLActive: vi.fn(() => true),
    shouldHaveWebGL: vi.fn(() => false),
    ensureWebGL: vi.fn(),
    // Mirror TerminalInstanceService.reconcileRevealGeometry: the real
    // reconcileGeometryFresh (atomic xterm+PTY re-fit to the FRESH container
    // measurement, refused on an occluded box) and then a local atlas repair.
    // A false keeps the watchdog's obligation and never repaints into a culled
    // surface.
    reconcileRevealGeometry: vi.fn((id: string) => {
      const agent = agents.get(id);
      if (!agent) return false;
      if (!resizeController.reconcileGeometryFresh(id)) return false;
      agent.atlasRepairs += 1;
      return true;
    }),
    isStoreBackgrounded: vi.fn(() => false),
    isStoreHidden: vi.fn(() => false),
    repairStoreVisibility: vi.fn(),
  };
}

function setDocumentVisible(): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
}

describe("#10632 switch-back redraw — closed-loop convergence", () => {
  let watchdog: TerminalReconciliationWatchdog | undefined;
  let instances: Map<string, ManagedTerminal>;
  let agents: Map<string, FakeAgent>;
  let deps: ReconciliationWatchdogDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    setDocumentVisible();
    instances = new Map();
    agents = new Map();
    // #10827: the watchdog gates on the one-shot hydration lock, which starts
    // locked at module init. Release it so ticks run their repairs.
    __resetSidebarHydrationLockForTests();
    unlockSidebarHydration();
  });

  afterEach(() => {
    watchdog?.dispose();
    watchdog = undefined;
    document.body.innerHTML = "";
    __resetSidebarHydrationLockForTests();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function mount(id: string, { altBuffer = false } = {}): FakeAgent {
    const agent = newAgent();
    agents.set(id, agent);
    instances.set(id, buildManaged(agent, altBuffer));
    return agent;
  }

  it("path A (warm view swap): converges a garbled, paused main-buffer CLI on switch-back with no manual Redraw", () => {
    const agent = mount("claude");
    deps = buildDeps(instances, agents);
    watchdog = new TerminalReconciliationWatchdog(deps);

    // Steady state on project A — nothing to repair.
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
    expect(agent.cols).toBe(120);

    // --- Switch A -> B. While A is occluded, its container is reflowed narrower
    // (a window resize / sidebar change happens against project B) and Chromium
    // pauses A's culled renderer. A's xterm grid can't follow while occluded.
    agent.onScreen = false;
    agent.containerCols = 90; // container now holds fewer columns
    agent.paused = true;

    // BROKEN STATE — what the user would see on switch-back before this fix:
    // the grid still wraps at 120 though the container holds 90 (garbled), and
    // the renderer is paused (stale).
    expect(agent.cols).toBe(120);
    expect(agent.cols).not.toBe(agent.containerCols);
    expect(agent.paused).toBe(true);

    // A tick while still occluded must NOT repair into the culled surface
    // (present-ordering) — the watchdog only acts on on-screen geometry.
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
    expect(agent.cols).toBe(120);
    expect(agent.paused).toBe(true);

    // --- Switch B -> A. The cached view is foreground-presented (host
    // measurable). The warm re-attach bumps the attach generation. NO manual
    // Redraw is issued.
    agent.onScreen = true;
    instances.get("claude")!.attachGeneration += 1;

    // One watchdog tick is the closed loop: it sees the grid disagrees with the
    // container, runs the atomic reconcile, and unpauses — single tick.
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    expect(deps.reconcileRevealGeometry).toHaveBeenCalledWith("claude");
    expect(agent.cols).toBe(90); // grid converged to the container — no garble
    expect(agent.paused).toBe(false); // renderer resumed
    expect(agent.atlasRepairs).toBeGreaterThan(0); // local atlas repaired (WebGL path stand-in)
  });

  it("path A (alt-screen TUI): a switch-back with a size change moves both grids, xterm first (#16359)", () => {
    // Same switch-back as path A, but the pane is a live full-screen TUI
    // (Crush, htop in a shell pane). Its container narrowed while the project
    // was hidden; on return xterm and the PTY must both land on the new size,
    // with xterm already holding it when the SIGWINCH reaches the app, so the
    // app's own redraw is what repaints the frame.
    const agent = mount("crush", { altBuffer: true });
    const managed = instances.get("crush")!;
    deps = buildDeps(instances, agents);
    watchdog = new TerminalReconciliationWatchdog(deps);

    agent.onScreen = false;
    agent.containerCols = 90;
    agent.containerRows = 30;
    agent.paused = true;
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(agent.sigwinch).toEqual([]);

    agent.onScreen = true;
    managed.attachGeneration += 1;
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    expect(agent.cols).toBe(90);
    expect(agent.rows).toBe(30);
    expect(agent.sigwinch).toEqual([{ cols: 90, rows: 30, xtermCols: 90, xtermRows: 30 }]);
    expect(agent.paused).toBe(false);
    expect(agent.atlasRepairs).toBeGreaterThan(0);
    // A live TUI's viewport is never scrolled; the frame is the app's.
    expect(managed.terminal.scrollToBottom).not.toHaveBeenCalled();

    // Converged means quiet: no further resizes, and no breaker state left over.
    for (let i = 0; i < 6; i++) vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(agent.sigwinch).toHaveLength(1);
    expect(managed.geometryRepairGaveUp).toBeFalsy();
  });

  it("path B (alt-screen TUI, long dwell): the background-resize obligation lands the real size on foreground", () => {
    // The window was resized while the project sat hidden. The background
    // path does not size a full-screen TUI to its window-ratio estimate; it
    // leaves the obligation (#16359), and the watchdog discharges it against
    // real layout once the pane is back on screen.
    const agent = mount("htop", { altBuffer: true });
    const managed = instances.get("htop")!;
    deps = buildDeps(instances, agents);
    watchdog = new TerminalReconciliationWatchdog(deps);

    agent.onScreen = false;
    agent.containerCols = 150;
    agent.containerRows = 50;
    managed.isDetached = true;
    managed.revealPendingRepair = true;
    managed.revealPendingGeneration = managed.attachGeneration;

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(managed.revealPendingRepair).toBe(true);
    expect(agent.sigwinch).toEqual([]);

    agent.onScreen = true;
    managed.isDetached = false;
    managed.attachGeneration += 1;
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    expect(agent.cols).toBe(150);
    expect(agent.rows).toBe(50);
    expect(agent.sigwinch).toEqual([{ cols: 150, rows: 50, xtermCols: 150, xtermRows: 50 }]);
    expect(managed.revealPendingRepair).toBe(false);
  });

  it("rapid switches inside the suppression window: the watchdog resizes an alt-screen pane once, to the final size", () => {
    // Watchdog lane only: each switch-away arms the project-switch suppression
    // (as `detachTerminalsForProjectSwitch` does) and each return lands inside
    // it, so the watchdog must not chase intermediate sizes the user never sees
    // settle. Once the last suppression clears, both grids land on the final
    // container in one resize. The reveal sweep and the suppression-clear
    // redraw are separate lanes, covered by their own suites.
    const agent = mount("goose", { altBuffer: true });
    const managed = instances.get("goose")!;
    deps = buildDeps(instances, agents);
    watchdog = new TerminalReconciliationWatchdog(deps);

    for (const cols of [90, 140, 100]) {
      managed.isResizeSuppressed = true;
      agent.onScreen = false;
      agent.containerCols = cols;
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      agent.onScreen = true;
      managed.attachGeneration += 1;
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(agent.sigwinch).toEqual([]);
    }
    expect(agent.cols).toBe(120);

    managed.isResizeSuppressed = false;
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    expect(agent.cols).toBe(100);
    expect(agent.sigwinch).toEqual([{ cols: 100, rows: 40, xtermCols: 100, xtermRows: 40 }]);
  });

  it("alt-screen TUI: never resizes into an open synchronized-output block", () => {
    const agent = mount("crush", { altBuffer: true });
    deps = buildDeps(instances, agents);
    watchdog = new TerminalReconciliationWatchdog(deps);

    agent.containerCols = 80;
    agent.synchronized = true;
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(agent.sigwinch).toEqual([]);
    expect(agent.cols).toBe(120);

    agent.synchronized = false;
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(agent.sigwinch).toEqual([{ cols: 80, rows: 40, xtermCols: 80, xtermRows: 40 }]);
  });

  it("path B (long dwell): the guaranteed redraw obligation survives the off-screen dead zone and discharges on foreground", () => {
    const agent = mount("codex");
    deps = buildDeps(instances, agents);
    watchdog = new TerminalReconciliationWatchdog(deps);
    const managed = instances.get("codex")!;

    // Switch away, dwell past the 10s project-switch suppression window. In the
    // real flow `suppressResizesDuringProjectSwitch`'s timer fires while the
    // terminal is still detached/occluded, so resetRenderer can't run — the
    // obligation is handed to the watchdog via the reveal-pending flag instead
    // of being silently spent on a zero-box host.
    agent.onScreen = false;
    agent.containerCols = 100;
    agent.paused = true;
    managed.isDetached = true;
    managed.revealPendingRepair = true;
    managed.revealPendingGeneration = managed.attachGeneration;

    // Dead zone: while still off-screen the obligation must be PRESERVED, not
    // spent, and no repair issued into the occluded surface.
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
    expect(managed.revealPendingRepair).toBe(true);

    // Switch back: foreground-presented, warm re-attach (generation bump).
    agent.onScreen = true;
    managed.isDetached = false;
    managed.attachGeneration += 1;

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    expect(deps.reconcileRevealGeometry).toHaveBeenCalledWith("codex");
    expect(agent.cols).toBe(100); // converged
    expect(agent.paused).toBe(false); // unpaused in the same tick
    expect(managed.revealPendingRepair).toBe(false); // obligation discharged
    expect(managed.revealPendingGeneration).toBeUndefined();
  });

  it("never repaints into an open DEC 2026 synchronized-output block (defers until it closes)", () => {
    const agent = mount("gemini");
    deps = buildDeps(instances, agents);
    watchdog = new TerminalReconciliationWatchdog(deps);

    // On-screen, garbled, paused — but mid synchronized-output block.
    agent.containerCols = 80;
    agent.paused = true;
    agent.synchronized = true;

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    // Deferred: a repaint now would interleave with the buffered range.
    expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
    expect(agent.paused).toBe(true);
    expect(agent.cols).toBe(120);

    // Block closes — next tick converges.
    agent.synchronized = false;
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(deps.reconcileRevealGeometry).toHaveBeenCalledWith("gemini");
    expect(agent.cols).toBe(80);
    expect(agent.paused).toBe(false);
  });
});
