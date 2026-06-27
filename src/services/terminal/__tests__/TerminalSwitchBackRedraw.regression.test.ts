// @vitest-environment jsdom
//
// Regression for #10632 — "agent terminals don't auto-redraw on project
// switch-back". This recreates the BROKEN state the issue describes and proves
// the closed-loop watchdog recovery converges it WITHOUT a manual Redraw.
//
// It drives the REAL TerminalReconciliationWatchdog against a deterministic fake
// of a live agent TUI (alt-buffer + DEC 2026 synchronized output — the same
// class of process the deleted `e2e/fixtures/fake-claude-agent.cjs` modelled).
// The fake's container CHANGES COLUMN COUNT while the project is backgrounded,
// so on switch-back its xterm grid wraps at the wrong width (the "garbled line
// flow") and its renderer is left paused — exactly the two halves a manual
// Redraw fixes.
//
// The `reconcileRevealGeometry` / `forceReflow` deps mirror what the real
// TerminalInstanceService does, INCLUDING the present-ordering guarantee:
// reconcileGeometryFresh only succeeds against a foreground-renderable host
// (checkVisibility + non-zero box), so a repaint is never issued into an
// occluded surface. That is what makes the "dead zone" assertions meaningful.
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
import type { ManagedTerminal } from "../types";

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
  };
}

function buildManaged(agent: FakeAgent): ManagedTerminal {
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
    refresh: vi.fn(),
    _core: {
      _renderService: {
        get _isPaused() {
          return agent.paused;
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
    isHibernated: false,
    isAttaching: false,
    isDetached: false,
    isResizeSuppressed: false,
    isUserScrolledBack: false,
    // The defining trait of the panes that break: a live agent TUI on the alt
    // buffer using DEC 2026 synchronized output — exactly what the watchdog used
    // to exclude from recovery.
    isAltBuffer: true,
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
    isWebGLActive: vi.fn(() => true),
    shouldHaveWebGL: vi.fn(() => false),
    ensureWebGL: vi.fn(),
    forceReflow: vi.fn((_element: HTMLElement) => {
      // Unpause: the IO re-evaluation resumes the paused renderer. We can't know
      // which agent the element belongs to cheaply, so unpause any agent whose
      // host owns it.
      for (const agent of agents.values()) agent.paused = false;
    }),
    // Mirror TerminalInstanceService.reconcileRevealGeometry +
    // TerminalResizeController.reconcileGeometryFresh: atomic xterm+PTY re-fit to
    // the FRESH container measurement plus a local atlas repair — but ONLY when
    // the host is foreground-renderable. Returns false on an occluded box so the
    // watchdog keeps the obligation and never repaints into a culled surface.
    reconcileRevealGeometry: vi.fn((id: string) => {
      const agent = agents.get(id);
      if (!agent) return false;
      if (!agent.onScreen) return false; // present-ordering guarantee
      agent.cols = agent.containerCols;
      agent.rows = agent.containerRows;
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
  });

  afterEach(() => {
    watchdog?.dispose();
    watchdog = undefined;
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function mount(id: string): FakeAgent {
    const agent = newAgent();
    agents.set(id, agent);
    instances.set(id, buildManaged(agent));
    return agent;
  }

  it("path A (warm view swap): converges a garbled, paused agent TUI on switch-back with no manual Redraw", () => {
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
    expect(deps.forceReflow).not.toHaveBeenCalled();
    expect(agent.cols).toBe(120);

    // Block closes — next tick converges.
    agent.synchronized = false;
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(deps.reconcileRevealGeometry).toHaveBeenCalledWith("gemini");
    expect(agent.cols).toBe(80);
    expect(agent.paused).toBe(false);
  });
});
