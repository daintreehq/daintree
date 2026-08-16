// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";
import {
  __resetSidebarHydrationLockForTests,
  __resetSidebarLayoutTransitionLockForTests,
  lockSidebarLayoutTransition,
  unlockSidebarHydration,
} from "@/lib/layoutTransitionLock";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";
import {
  TerminalReconciliationWatchdog,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_MAX_GEOMETRY_REPAIR_ATTEMPTS,
  WATCHDOG_MAX_HEAVY_REPAIRS_PER_TICK,
  WATCHDOG_REPAIR_COOLDOWN_MS,
  isXtermRenderPaused,
  type ReconciliationWatchdogDeps,
} from "../TerminalReconciliationWatchdog";
import { MAX_RENDERER_UNPAUSE_ATTEMPTS } from "../TerminalReflowController";
import type { ManagedTerminal } from "../types";
import { MAX_TERMINAL_GRID_DIMENSION } from "@shared/types/terminal";

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { logDebug, logWarn } from "@/utils/logger";

type ManagedOverrides = Partial<ManagedTerminal> & { onScreen?: boolean };

function makeManaged(overrides: ManagedOverrides = {}): ManagedTerminal {
  const { onScreen = true, ...managedOverrides } = overrides;
  const hostElement = document.createElement("div");
  const termEl = document.createElement("div");
  hostElement.appendChild(termEl);
  document.body.appendChild(hostElement);

  hostElement.getBoundingClientRect = () =>
    onScreen
      ? ({ width: 400, height: 300, top: 10, bottom: 310, left: 10, right: 410 } as DOMRect)
      : ({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 } as DOMRect);

  const managed = {
    terminal: {
      element: termEl,
      rows: 24,
      refresh: vi.fn(),
      modes: { synchronizedOutputMode: false },
    } as unknown as ManagedTerminal["terminal"],
    kind: "terminal",
    hostElement,
    isOpened: true,
    isVisible: true,
    isFocused: false,
    isAttaching: false,
    isDetached: false,
    isResizeSuppressed: false,
    isUserScrolledBack: false,
    isAltBuffer: false,
    lastActiveTime: Date.now(),
    lastWidth: 0,
    lastHeight: 0,
    lastAttachAt: 0,
    lastDetachAt: 0,
    latestCols: 80,
    latestRows: 24,
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
    fitAddon: { fit: vi.fn() } as unknown as ManagedTerminal["fitAddon"],
    serializeAddon: { serialize: vi.fn() } as unknown as ManagedTerminal["serializeAddon"],
    imageAddon: null,
    searchAddon: {} as ManagedTerminal["searchAddon"],
    fileLinksDisposable: null,
    webLinksAddon: null,
    hoveredLink: null,
    ...managedOverrides,
  } as ManagedTerminal;
  return managed;
}

function setRenderPaused(managed: ManagedTerminal, paused: boolean): void {
  (managed.terminal as unknown as { _core: { _renderService: { _isPaused: boolean } } })._core = {
    _renderService: { _isPaused: paused },
  };
}

/**
 * Model the #11800 production case: the repair runs, but the renderer is paused
 * again by the time anyone looks. Backed by a setter that refuses to go false,
 * which is what a terminal whose IntersectionObserver keeps reporting
 * not-intersecting looks like from the outside.
 */
function setRenderPausedSticky(managed: ManagedTerminal): void {
  (managed.terminal as unknown as { _core: unknown })._core = {
    _renderService: {
      get _isPaused(): boolean {
        return true;
      },
      set _isPaused(_next: boolean) {
        // Swallowed — IO re-pauses it before the next observation.
      },
    },
  };
}

/** Count of full-grid repaints the real unpause primitive issued. */
function refreshCount(managed: ManagedTerminal): number {
  return (managed.terminal as unknown as { refresh: { mock: { calls: unknown[] } } }).refresh.mock
    .calls.length;
}

/**
 * Wire the xterm grid and the fit-addon proposal so the watchdog's geometry
 * convergence check (#10632) has real numbers. A mismatch models the garbled
 * "wrong column wrapping" a pane shows after a warm switch-back.
 */
function setGrid(
  managed: ManagedTerminal,
  grid: { cols: number; rows: number },
  proposal: { cols: number; rows: number }
): void {
  (managed.terminal as unknown as { cols: number; rows: number }).cols = grid.cols;
  (managed.terminal as unknown as { cols: number; rows: number }).rows = grid.rows;
  (
    managed.fitAddon as unknown as { proposeDimensions: () => { cols: number; rows: number } }
  ).proposeDimensions = () => proposal;
}

function makeDeps(
  instances: Map<string, ManagedTerminal>,
  overrides: Partial<ReconciliationWatchdogDeps> = {}
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
    isResizeTransitioning: vi.fn(() => false),
    isWebGLActive: vi.fn(() => true),
    shouldHaveWebGL: vi.fn(() => false),
    ensureWebGL: vi.fn(),
    reconcileRevealGeometry: vi.fn(() => true),
    isStoreBackgrounded: vi.fn(() => false),
    isStoreHidden: vi.fn(() => false),
    repairStoreVisibility: vi.fn(),
    ...overrides,
  };
}

function setDocumentVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

describe("TerminalReconciliationWatchdog", () => {
  let watchdog: TerminalReconciliationWatchdog | undefined;
  let instances: Map<string, ManagedTerminal>;

  beforeEach(() => {
    vi.useFakeTimers();
    instances = new Map();
    setDocumentVisibility("visible");
    __resetSidebarLayoutTransitionLockForTests();
    // #10827: the watchdog now also gates on the one-shot hydration lock, which
    // starts locked at module init. Release it so ticks run their repairs.
    __resetSidebarHydrationLockForTests();
    unlockSidebarHydration();
  });

  afterEach(() => {
    watchdog?.dispose();
    watchdog = undefined;
    delete document.documentElement.dataset.dragging;
    document.body.innerHTML = "";
    __resetSidebarLayoutTransitionLockForTests();
    __resetSidebarHydrationLockForTests();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("tick gating", () => {
    it("skips the tick while the document is hidden", () => {
      instances.set("t1", makeManaged({ isVisible: false }));
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      setDocumentVisibility("hidden");
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).not.toHaveBeenCalled();
    });

    it("skips the tick while a drag is active", () => {
      instances.set("t1", makeManaged({ isVisible: false }));
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      document.documentElement.dataset.dragging = "true";
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).not.toHaveBeenCalled();

      delete document.documentElement.dataset.dragging;
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).toHaveBeenCalledWith("t1");
    });

    it("skips the tick while the sidebar layout transition lock is held", () => {
      instances.set("t1", makeManaged({ isVisible: false }));
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      lockSidebarLayoutTransition(60_000);
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).not.toHaveBeenCalled();
    });

    it("skips the tick while the startup hydration lock is held, then resumes (issue #10827)", () => {
      // The production boot path: pre-hydration geometry is the default-width
      // sidebar, so reconciling against it would repair to the wrong size. Other
      // suites unlock hydration in beforeEach; this one re-arms it to exercise
      // the real first-load gate.
      __resetSidebarHydrationLockForTests();
      instances.set("t1", makeManaged({ isVisible: false }));
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).not.toHaveBeenCalled();

      unlockSidebarHydration();
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).toHaveBeenCalledWith("t1");
    });

    it("fires an immediate sweep when the document becomes visible again", () => {
      instances.set("t1", makeManaged({ isVisible: false }));
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      setDocumentVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(deps.setVisible).not.toHaveBeenCalled();

      setDocumentVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(deps.setVisible).toHaveBeenCalledWith("t1");
    });
  });

  describe("per-terminal gating", () => {
    it.each([
      ["isAttaching", { isAttaching: true }],
      ["isDetached", { isDetached: true }],
      ["isResizeSuppressed", { isResizeSuppressed: true }],
      ["isSerializedRestoreInProgress", { isSerializedRestoreInProgress: true }],
    ] as Array<[string, Partial<ManagedTerminal>]>)(
      "skips terminals with %s set",
      (_label, flags) => {
        instances.set("t1", makeManaged({ isVisible: false, ...flags }));
        const deps = makeDeps(instances);
        watchdog = new TerminalReconciliationWatchdog(deps);

        vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
        expect(deps.setVisible).not.toHaveBeenCalled();
      }
    );

    it("leaves off-screen terminals alone", () => {
      instances.set("t1", makeManaged({ isVisible: false, onScreen: false }));
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).not.toHaveBeenCalled();
    });

    it("leaves explicitly store-backgrounded terminals alone even when their rect passes", () => {
      // Docked-offscreen terminals live in a content-visibility:hidden fixed
      // container whose rect geometry still passes the viewport test — the
      // store-backgrounded gate is what keeps the watchdog from fighting the
      // dock's intentional BACKGROUND policy.
      instances.set(
        "t1",
        makeManaged({ isVisible: true, lastAppliedTier: TerminalRefreshTier.BACKGROUND })
      );
      const deps = makeDeps(instances, { isStoreBackgrounded: vi.fn(() => true) });
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.applyRendererPolicy).not.toHaveBeenCalled();
      expect(deps.setVisible).not.toHaveBeenCalled();
    });

    it("skips terminals whose host element is detached from the DOM", () => {
      const managed = makeManaged({ isVisible: false });
      managed.hostElement.remove();
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).not.toHaveBeenCalled();
    });
  });

  describe("repairs", () => {
    it("repairs isVisible=false via setVisible and logs the mismatch", () => {
      instances.set("t1", makeManaged({ isVisible: false }));
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).toHaveBeenCalledTimes(1);
      expect(deps.setVisible).toHaveBeenCalledWith("t1");
      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining("isVisible=false"),
        expect.objectContaining({ id: "t1" })
      );
    });

    it("re-applies the computed tier when the applied tier is stuck at BACKGROUND", () => {
      instances.set(
        "t1",
        makeManaged({
          lastAppliedTier: TerminalRefreshTier.BACKGROUND,
          getRefreshTier: () => TerminalRefreshTier.FOCUSED,
        })
      );
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.applyRendererPolicy).toHaveBeenCalledWith("t1", TerminalRefreshTier.FOCUSED);
    });

    it("leaves a computed BACKGROUND tier alone when store visibility is intact (policy)", () => {
      // Completed/exited agents and exited processes compute BACKGROUND by
      // design (hibernation eligibility) — repairing would loop forever (#10416).
      const managed = makeManaged({
        lastAppliedTier: TerminalRefreshTier.VISIBLE,
        getRefreshTier: () => TerminalRefreshTier.BACKGROUND,
      });
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 3);
      expect(deps.applyRendererPolicy).not.toHaveBeenCalled();
      expect(deps.repairStoreVisibility).not.toHaveBeenCalled();
      expect(logWarn).not.toHaveBeenCalled();
      expect(managed.lastWatchdogRepairAt).toBeUndefined();
    });

    it("leaves a policy BACKGROUND tier alone even when the applied tier is also BACKGROUND", () => {
      const managed = makeManaged({
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        getRefreshTier: () => TerminalRefreshTier.BACKGROUND,
      });
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 3);
      expect(deps.applyRendererPolicy).not.toHaveBeenCalled();
      expect(deps.repairStoreVisibility).not.toHaveBeenCalled();
      expect(managed.lastWatchdogRepairAt).toBeUndefined();
    });

    it("rate-limits via cooldown when the store repair fails to converge", () => {
      // If repairStoreVisibility doesn't take (store keeps reporting hidden),
      // the watchdog must degrade to periodic cooldown-spaced retries — the
      // pre-#10416 behavior — not a per-tick repair loop.
      const managed = makeManaged({
        lastAppliedTier: TerminalRefreshTier.VISIBLE,
        getRefreshTier: () => TerminalRefreshTier.BACKGROUND,
      });
      instances.set("t1", managed);
      const deps = makeDeps(instances, { isStoreHidden: vi.fn(() => true) });
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.repairStoreVisibility).toHaveBeenCalledTimes(1);
      expect(managed.lastWatchdogRepairAt).toBeGreaterThan(0);

      // Inside the cooldown window — no retry.
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.repairStoreVisibility).toHaveBeenCalledTimes(1);

      // Past the cooldown — the still-diverged store retries.
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.repairStoreVisibility).toHaveBeenCalledTimes(2);
    });

    it("repairs poisoned store visibility and applies the re-derived tier", () => {
      // The warm-swap split from #10416: store isVisible=false while service
      // and DOM agree the terminal is on-screen.
      let storeHidden = true;
      const managed = makeManaged({
        lastAppliedTier: TerminalRefreshTier.VISIBLE,
        getRefreshTier: () =>
          storeHidden ? TerminalRefreshTier.BACKGROUND : TerminalRefreshTier.FOCUSED,
      });
      instances.set("t1", managed);
      const deps = makeDeps(instances, {
        isStoreHidden: vi.fn(() => storeHidden),
        repairStoreVisibility: vi.fn(() => {
          storeHidden = false;
        }),
      });
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.repairStoreVisibility).toHaveBeenCalledWith("t1");
      expect(deps.applyRendererPolicy).toHaveBeenCalledWith("t1", TerminalRefreshTier.FOCUSED);
      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining("BACKGROUND tier"),
        expect.objectContaining({ id: "t1", storeHidden: true })
      );

      // Converges: once the store is repaired the divergence is gone — no
      // further repairs after the cooldown elapses.
      vi.clearAllMocks();
      vi.advanceTimersByTime(WATCHDOG_REPAIR_COOLDOWN_MS + WATCHDOG_INTERVAL_MS * 2);
      expect(deps.repairStoreVisibility).not.toHaveBeenCalled();
      expect(deps.applyRendererPolicy).not.toHaveBeenCalled();
    });

    it("floors to VISIBLE when the tier still computes BACKGROUND after the store repair", () => {
      // Store-hidden completed agent: the store repair lands but policy keeps
      // the computed tier at BACKGROUND — next tick treats it as intentional.
      let storeHidden = true;
      instances.set(
        "t1",
        makeManaged({
          lastAppliedTier: TerminalRefreshTier.VISIBLE,
          getRefreshTier: () => TerminalRefreshTier.BACKGROUND,
        })
      );
      const deps = makeDeps(instances, {
        isStoreHidden: vi.fn(() => storeHidden),
        repairStoreVisibility: vi.fn(() => {
          storeHidden = false;
        }),
      });
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.repairStoreVisibility).toHaveBeenCalledWith("t1");
      expect(deps.applyRendererPolicy).toHaveBeenCalledWith("t1", TerminalRefreshTier.VISIBLE);

      vi.clearAllMocks();
      vi.advanceTimersByTime(WATCHDOG_REPAIR_COOLDOWN_MS + WATCHDOG_INTERVAL_MS * 2);
      expect(deps.repairStoreVisibility).not.toHaveBeenCalled();
      expect(deps.applyRendererPolicy).not.toHaveBeenCalled();
    });

    it("reasserts the backend tier when it diverged to background", () => {
      instances.set("t1", makeManaged());
      const deps = makeDeps(instances, { getBackendTier: vi.fn(() => "background" as const) });
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reassertActiveBackendTier).toHaveBeenCalledWith("t1");
    });

    it("flushes stalled ingest bytes", () => {
      instances.set("t1", makeManaged());
      const deps = makeDeps(instances, { getStalledBytes: vi.fn(() => 4096) });
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.resumeFlush).toHaveBeenCalledWith("t1");
    });

    it("never flushes while a wake is needed, pending, or in flight", () => {
      instances.set("t1", makeManaged({ needsWake: true }));
      instances.set("t2", makeManaged());
      instances.set("t3", makeManaged());
      const deps = makeDeps(instances, {
        getStalledBytes: vi.fn(() => 4096),
        hasInFlightWake: vi.fn((id: string) => id === "t2"),
        hasPendingWake: vi.fn((id: string) => id === "t3"),
      });
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.resumeFlush).not.toHaveBeenCalled();
    });

    it("unpauses a terminal whose xterm render service is paused", () => {
      const managed = makeManaged();
      setRenderPaused(managed, true);
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(refreshCount(managed)).toBe(1);
    });

    it("unpauses a paused alt-buffer (agent TUI) terminal when no synchronized block is open (#10632)", () => {
      // Regression: the watchdog used to EXCLUDE alt-buffer agents from the
      // render-pause repair (`!managed.isAltBuffer`), so exactly the agent TUIs
      // that break on switch-back had no closed-loop recovery. The only real
      // hazard is a mid-synchronized-block paint, which is guarded separately.
      const managed = makeManaged({ isAltBuffer: true });
      setRenderPaused(managed, true);
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(refreshCount(managed)).toBe(1);
    });

    it("does not unpause while DEC 2026 synchronized output is active (alt-buffer included)", () => {
      const managed = makeManaged({ isAltBuffer: true });
      (
        managed.terminal as unknown as { modes: { synchronizedOutputMode: boolean } }
      ).modes.synchronizedOutputMode = true;
      setRenderPaused(managed, true);
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(refreshCount(managed)).toBe(0);
      expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
    });

    it("stops repairing a renderer that stays paused, after a bounded number of attempts (#11800)", () => {
      // The bug: the branch reissued the repair on every eligible tick forever,
      // logging success each time while the pane stayed blank. Sticky pause
      // models a renderer IO keeps re-pausing — the production case.
      const managed = makeManaged();
      setRenderPausedSticky(managed);
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 20);

      expect(refreshCount(managed)).toBe(MAX_RENDERER_UNPAUSE_ATTEMPTS);
      expect(managed.rendererUnpauseGaveUp).toBe(true);
      const giveUps = vi
        .mocked(logWarn)
        .mock.calls.filter(([msg]) => typeof msg === "string" && msg.includes("giving up"));
      expect(giveUps).toHaveLength(1);
    });

    it("keeps reconciling the WebGL layer after the unpause breaker trips", () => {
      // The breaker disables one repair, not the whole chain.
      const managed = makeManaged();
      setRenderPausedSticky(managed);
      instances.set("t1", managed);
      const deps = makeDeps(instances, {
        shouldHaveWebGL: vi.fn(() => true),
        isWebGLActive: vi.fn(() => false),
      });
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 20);

      expect(managed.rendererUnpauseGaveUp).toBe(true);
      expect(deps.ensureWebGL).toHaveBeenCalledWith("t1", managed);
    });

    it("re-arms the breaker once a later sweep observes the renderer unpaused", () => {
      // Recovery is only observable on a LATER sweep — re-reading the flag in the
      // same tick would just confirm the repair's own write.
      const managed = makeManaged();
      setRenderPaused(managed, true);
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(refreshCount(managed)).toBe(1);
      expect(managed.rendererUnpauseAttempts).toBe(1);
      // Same-tick: NOT yet reset, because that would be verifying our own write.
      expect(isXtermRenderPaused(managed.terminal)).toBe(false);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(managed.rendererUnpauseAttempts).toBe(0);
      expect(managed.rendererUnpauseGaveUp).toBe(false);
      expect(vi.mocked(logDebug).mock.calls.some(([msg]) => msg.includes("no longer set"))).toBe(
        true
      );

      // A fresh pause after recovery gets the full budget again.
      setRenderPaused(managed, true);
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 4);
      expect(refreshCount(managed)).toBe(2);
    });

    it("re-arms a genuinely latched breaker when the renderer is later seen unpaused", () => {
      // Distinct from the test above, which only ever reset attempts===1: this
      // one trips `rendererUnpauseGaveUp` first, then proves the latch clears.
      const managed = makeManaged();
      setRenderPausedSticky(managed);
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 20);
      expect(managed.rendererUnpauseGaveUp).toBe(true);
      const afterLatch = refreshCount(managed);

      // Whatever was re-pausing it stops; the renderer now reads unpaused.
      setRenderPaused(managed, false);
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(managed.rendererUnpauseGaveUp).toBe(false);
      expect(managed.rendererUnpauseAttempts).toBe(0);

      // And a fresh pause is repaired again rather than being permanently barred.
      setRenderPaused(managed, true);
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 4);
      expect(refreshCount(managed)).toBe(afterLatch + 1);
    });

    it("preserves accrued attempts when the private pause flag drifts away", () => {
      // isXtermRenderPaused collapses drift to `false`; if the observation used
      // it, a missing field would read as proof of recovery and wipe the counter.
      const managed = makeManaged();
      setRenderPaused(managed, true);
      instances.set("t1", managed);
      watchdog = new TerminalReconciliationWatchdog(makeDeps(instances));

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(managed.rendererUnpauseAttempts).toBe(1);

      // API drift: the field disappears entirely.
      delete (managed.terminal as unknown as { _core: { _renderService: { _isPaused?: boolean } } })
        ._core._renderService._isPaused;
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 4);
      expect(managed.rendererUnpauseAttempts).toBe(1);
    });

    it("keeps each terminal's breaker state independent", () => {
      const stuck = makeManaged();
      const recovers = makeManaged();
      setRenderPausedSticky(stuck);
      setRenderPaused(recovers, true);
      instances.set("stuck", stuck);
      instances.set("recovers", recovers);
      watchdog = new TerminalReconciliationWatchdog(makeDeps(instances));

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 20);

      expect(stuck.rendererUnpauseGaveUp).toBe(true);
      expect(recovers.rendererUnpauseGaveUp).toBe(false);
      expect(recovers.rendererUnpauseAttempts).toBe(0);
      expect(refreshCount(recovers)).toBe(1);
    });

    it("re-arms a latched breaker when the terminal re-attaches", () => {
      const managed = makeManaged();
      setRenderPausedSticky(managed);
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 20);
      expect(managed.rendererUnpauseGaveUp).toBe(true);

      // A new incarnation reusing this id must not inherit the give-up state.
      managed.attachGeneration += 1;
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(refreshCount(managed)).toBe(MAX_RENDERER_UNPAUSE_ATTEMPTS + 1);
      expect(managed.rendererUnpauseGaveUp).toBe(false);
    });

    it("counts an attempt even when the repair reports it could not run", () => {
      // A render service whose pause flag reads true but cannot be resumed —
      // refresh throws, so the primitive restores the flag and returns false. If
      // that did not consume the budget, the unbounded retry loop would be back.
      const managed = makeManaged();
      setRenderPaused(managed, true);
      (managed.terminal as unknown as { refresh: ReturnType<typeof vi.fn> }).refresh = vi.fn(() => {
        throw new Error("renderer gone");
      });
      instances.set("t1", managed);
      watchdog = new TerminalReconciliationWatchdog(makeDeps(instances));

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 20);

      expect(refreshCount(managed)).toBe(MAX_RENDERER_UNPAUSE_ATTEMPTS);
      expect(managed.rendererUnpauseGaveUp).toBe(true);
      const attemptLogs = vi
        .mocked(logWarn)
        .mock.calls.filter(([msg]) => typeof msg === "string" && msg.includes("forcing unpause"));
      expect(attemptLogs).toHaveLength(MAX_RENDERER_UNPAUSE_ATTEMPTS);
      // The log must report the real outcome, not assert success.
      expect(attemptLogs[0]?.[1]).toMatchObject({ repairIssued: false, attempt: 1 });
    });

    it("does not accept a same-turn sibling write as recovery", () => {
      // The reflow controller registers its visibilitychange listener first, so
      // on that event its repair lands immediately before the watchdog's sweep.
      // Treating that write as durable recovery would re-arm the breaker on a
      // renderer nothing actually fixed — the loop would never terminate.
      const managed = makeManaged();
      setRenderPaused(managed, true);
      instances.set("t1", managed);
      watchdog = new TerminalReconciliationWatchdog(makeDeps(instances));

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(managed.rendererUnpauseAttempts).toBe(1);

      // Stand in for the sibling: clear the flag, then sweep within the same
      // interval the repair was issued in.
      setRenderPaused(managed, false);
      watchdog.tick();
      expect(managed.rendererUnpauseAttempts).toBe(1);

      // A full sweep later, the same `false` IS believable.
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(managed.rendererUnpauseAttempts).toBe(0);
    });

    it("shares one attempt budget between the standalone branch and the reveal path", () => {
      // unpauseIfNeeded (reveal-pending / geometry) routes through the same cap.
      // Two independent budgets would let a stuck pane repaint twice as often.
      const managed = makeManaged({ revealPendingRepair: true });
      setRenderPausedSticky(managed);
      instances.set("t1", managed);
      watchdog = new TerminalReconciliationWatchdog(makeDeps(instances));

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 20);

      expect(refreshCount(managed)).toBe(MAX_RENDERER_UNPAUSE_ATTEMPTS);
      expect(managed.rendererUnpauseGaveUp).toBe(true);
    });

    it("reattaches a missing WebGL context for an eligible terminal", () => {
      const managed = makeManaged();
      instances.set("t1", managed);
      const deps = makeDeps(instances, {
        shouldHaveWebGL: vi.fn(() => true),
        isWebGLActive: vi.fn(() => false),
      });
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.ensureWebGL).toHaveBeenCalledWith("t1", managed);
    });

    it("issues no repair when the whole chain is consistent", () => {
      const managed = makeManaged();
      setRenderPaused(managed, false);
      setGrid(managed, { cols: 120, rows: 40 }, { cols: 120, rows: 40 });
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).not.toHaveBeenCalled();
      expect(deps.applyRendererPolicy).not.toHaveBeenCalled();
      expect(deps.reassertActiveBackendTier).not.toHaveBeenCalled();
      expect(deps.resumeFlush).not.toHaveBeenCalled();
      expect(refreshCount(managed)).toBe(0);
      expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
      expect(deps.ensureWebGL).not.toHaveBeenCalled();
      expect(managed.lastWatchdogRepairAt).toBeUndefined();
    });
  });

  describe("geometry convergence (#10632)", () => {
    it("defers geometry diagnosis and repair during a coordinated resize, then repairs once stable", () => {
      const managed = makeManaged({ isAltBuffer: false });
      setRenderPaused(managed, false);
      (managed.terminal as unknown as { cols: number; rows: number }).cols = 137;
      (managed.terminal as unknown as { cols: number; rows: number }).rows = 40;
      const proposeDimensions = vi.fn(() => ({ cols: 100, rows: 40 }));
      (
        managed.fitAddon as unknown as {
          proposeDimensions: () => { cols: number; rows: number };
        }
      ).proposeDimensions = proposeDimensions;
      managed.geometryRepairAttempts = 1;
      managed.geometryRepairGeneration = managed.attachGeneration;
      instances.set("t1", managed);
      let resizeTransitioning = true;
      const deps = makeDeps(instances, {
        isResizeTransitioning: vi.fn(() => resizeTransitioning),
      });
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(proposeDimensions).not.toHaveBeenCalled();
      expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
      expect(managed.geometryRepairAttempts).toBe(1);
      expect(managed.lastWatchdogRepairAt).toBeUndefined();
      expect(
        vi
          .mocked(logWarn)
          .mock.calls.some((call) => String(call[0]).includes("geometry divergence"))
      ).toBe(false);

      resizeTransitioning = false;
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).toHaveBeenCalledTimes(1);
      expect(managed.geometryRepairAttempts).toBe(2);
    });

    it("keeps a reveal repair pending while resize coordination owns the grid", () => {
      const managed = makeManaged({ isAltBuffer: true });
      managed.revealPendingRepair = true;
      managed.revealPendingGeneration = managed.attachGeneration;
      setGrid(managed, { cols: 100, rows: 40 }, { cols: 100, rows: 40 });
      instances.set("t1", managed);
      let resizeTransitioning = true;
      const deps = makeDeps(instances, {
        isResizeTransitioning: vi.fn(() => resizeTransitioning),
      });
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
      expect(managed.revealPendingRepair).toBe(true);
      expect(managed.lastWatchdogRepairAt).toBeUndefined();

      resizeTransitioning = false;
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).toHaveBeenCalledWith("t1");
      expect(managed.revealPendingRepair).toBe(false);
    });

    it("still runs non-geometry recovery during a coordinated resize", () => {
      const managed = makeManaged({ isAltBuffer: false });
      setRenderPaused(managed, true);
      setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
      instances.set("t1", managed);
      const deps = makeDeps(instances, {
        isResizeTransitioning: vi.fn(() => true),
      });
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
      expect(refreshCount(managed)).toBe(1);
    });

    it("reconciles an on-screen terminal whose grid disagrees with the container (garbled wrapping)", () => {
      // The exact switch-back failure: while backgrounded the container narrowed
      // (137 → 100 cols) but the xterm grid stayed at the old width, so the
      // buffer wraps at the wrong column. The watchdog repairs this, which it
      // previously only DIAGNOSED.
      const managed = makeManaged({ isAltBuffer: false });
      setRenderPaused(managed, false);
      setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).toHaveBeenCalledWith("t1");
      expect(managed.lastWatchdogRepairAt).toBeGreaterThan(0);
    });

    it("never spends a geometry repair on an alt-buffer pane, whose repair cannot converge (#11443)", () => {
      // reconcileGeometryFresh returns before touching geometry for an
      // alt-screen pane (#10805), so issuing the repair here can never close
      // the divergence. Left in the loop it burns a heavy-budget slot every
      // cooldown window and then latches the breaker permanently — which would
      // bar the pane's legitimate main-buffer repairs after it leaves the
      // alternate screen. An identical main-buffer pane is the control.
      const alt = makeManaged({ isAltBuffer: true });
      setRenderPaused(alt, false);
      setGrid(alt, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
      instances.set("alt", alt);
      // Diverged main-buffer controls, iterated after the alt pane. If the alt
      // pane merely skipped the call while still consuming a heavy-repair slot,
      // one control would be starved every tick.
      const controls: ManagedTerminal[] = [];
      for (let i = 0; i < WATCHDOG_MAX_HEAVY_REPAIRS_PER_TICK; i++) {
        const control = makeManaged({ isAltBuffer: false });
        setRenderPaused(control, false);
        setGrid(control, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
        instances.set(`control${i}`, control);
        controls.push(control);
      }
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      // Every control was repaired on the first tick — the alt pane took none
      // of the per-tick allowance.
      expect(
        vi
          .mocked(deps.reconcileRevealGeometry)
          .mock.calls.map(([id]) => id)
          .sort()
      ).toEqual(controls.map((_, i) => `control${i}`));

      // Far more ticks than the breaker needs to trip on a diverged pane.
      for (let i = 0; i < 12; i++) vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

      expect(vi.mocked(deps.reconcileRevealGeometry).mock.calls.some(([id]) => id === "alt")).toBe(
        false
      );
      expect(alt.geometryRepairAttempts ?? 0).toBe(0);
      expect(alt.geometryRepairGaveUp).toBeFalsy();
      // The controls prove the breaker still works on panes that CAN be
      // repaired, so the alt pane's clean counters aren't a dead watchdog.
      expect(controls.every((control) => control.geometryRepairGaveUp === true)).toBe(true);

      // Leaving the alternate screen restores repair eligibility, proving the
      // exclusion is keyed on live buffer mode and left no latched state.
      alt.isAltBuffer = false;
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(vi.mocked(deps.reconcileRevealGeometry).mock.calls.some(([id]) => id === "alt")).toBe(
        true
      );
      expect(alt.geometryRepairAttempts).toBe(1);
    });

    it("does not reconcile geometry while a synchronized-output block is open", () => {
      const managed = makeManaged({ isAltBuffer: false });
      (
        managed.terminal as unknown as { modes: { synchronizedOutputMode: boolean } }
      ).modes.synchronizedOutputMode = true;
      setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
    });

    it("caps geometry reconciles per tick at the heavy budget (== REVEAL_CONCURRENCY)", () => {
      for (let i = 0; i < WATCHDOG_MAX_HEAVY_REPAIRS_PER_TICK + 1; i++) {
        const managed = makeManaged({ isAltBuffer: false });
        setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
        instances.set(`t${i}`, managed);
      }
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).toHaveBeenCalledTimes(
        WATCHDOG_MAX_HEAVY_REPAIRS_PER_TICK
      );

      // The deferred terminal is picked up on the next tick — bounded, not dropped.
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).toHaveBeenCalledTimes(
        WATCHDOG_MAX_HEAVY_REPAIRS_PER_TICK + 1
      );
    });
  });

  describe("geometry circuit breaker (#10909)", () => {
    // A permanently-mismatched proposal where reconcileRevealGeometry keeps
    // returning true (box measurable) but the grid never actually converges —
    // the exact stable off-by-one that made the watchdog re-wrap forever.
    function makeDivergedTerminal(): ManagedTerminal {
      const managed = makeManaged({ isAltBuffer: false });
      setRenderPaused(managed, false);
      setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
      return managed;
    }

    function giveUpLogCount(): number {
      return vi.mocked(logWarn).mock.calls.filter((c) => String(c[0]).includes("giving up")).length;
    }

    it("stops repairing and logs once after the pane fails to converge repeatedly", () => {
      const managed = makeDivergedTerminal();
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      // Well past the point where the cooldown-spaced repairs would fire.
      for (let i = 0; i < 12; i++) vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

      expect(deps.reconcileRevealGeometry).toHaveBeenCalledTimes(
        WATCHDOG_MAX_GEOMETRY_REPAIR_ATTEMPTS
      );
      expect(managed.geometryRepairGaveUp).toBe(true);
      expect(giveUpLogCount()).toBe(1);
      // The logged attempt count must equal the repairs actually issued — proving
      // the counter tracks issued repairs, not divergence detections or budget skips.
      const giveUpLog = vi
        .mocked(logWarn)
        .mock.calls.find((c) => String(c[0]).includes("giving up"));
      expect(giveUpLog?.[1]).toMatchObject({
        attempts: vi.mocked(deps.reconcileRevealGeometry).mock.calls.length,
      });

      // Further ticks neither repair again nor re-log the give-up.
      for (let i = 0; i < 6; i++) vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).toHaveBeenCalledTimes(
        WATCHDOG_MAX_GEOMETRY_REPAIR_ATTEMPTS
      );
      expect(giveUpLogCount()).toBe(1);
    });

    it("re-arms when the grid converges again, so a self-corrected pane can repair later", () => {
      const managed = makeDivergedTerminal();
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      for (let i = 0; i < 12; i++) vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(managed.geometryRepairGaveUp).toBe(true);

      // Container reaches a width the grid matches — one success clears the breaker.
      setGrid(managed, { cols: 100, rows: 40 }, { cols: 100, rows: 40 });
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(managed.geometryRepairGaveUp).toBe(false);
      expect(managed.geometryRepairAttempts).toBe(0);

      // Divergence returns — repairs resume instead of staying permanently barred.
      vi.mocked(deps.reconcileRevealGeometry).mockClear();
      setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).toHaveBeenCalledTimes(1);
    });

    it("re-arms when the terminal re-attaches under a new attachGeneration", () => {
      const managed = makeDivergedTerminal();
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      for (let i = 0; i < 12; i++) vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(managed.geometryRepairGaveUp).toBe(true);

      // A fresh incarnation reusing the id must not inherit the give-up state.
      managed.attachGeneration += 1;
      vi.mocked(deps.reconcileRevealGeometry).mockClear();
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(managed.geometryRepairGaveUp).toBe(false);
      expect(deps.reconcileRevealGeometry).toHaveBeenCalledTimes(1);
    });

    it("does not count a budget-deferred tick as a repair attempt", () => {
      const panes: ManagedTerminal[] = [];
      for (let i = 0; i < WATCHDOG_MAX_HEAVY_REPAIRS_PER_TICK + 1; i++) {
        const managed = makeManaged({ isAltBuffer: false });
        setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
        instances.set(`t${i}`, managed);
        panes.push(managed);
      }
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      const repaired = panes[0];
      const deferred = panes[WATCHDOG_MAX_HEAVY_REPAIRS_PER_TICK];
      expect(repaired?.geometryRepairAttempts).toBe(1);
      // The pane skipped purely for heavy budget was never tried — no attempt spent.
      expect(deferred?.geometryRepairAttempts).toBe(0);
    });

    it("does not count a streaming-deferred tick as a repair attempt (#10863)", () => {
      // Main-buffer: the quiescence gate exists for main-buffer CLIs whose
      // committed scrollback a reconcile would re-wrap mid-paint.
      const managed = makeManaged({ isAltBuffer: false });
      setRenderPaused(managed, false);
      setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      // The pane writes continuously: keep lastWriteAt inside the quiescence
      // window at every tick. reconcileGeometryFresh would defer these, so the
      // watchdog must neither issue the repair nor spend a breaker attempt.
      for (let i = 0; i < 12; i++) {
        managed.lastWriteAt = Date.now() + WATCHDOG_INTERVAL_MS;
        vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      }
      expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
      expect(managed.geometryRepairAttempts ?? 0).toBe(0);
      expect(managed.geometryRepairGaveUp).toBeFalsy();

      // The stream pauses — the very next tick repairs normally.
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).toHaveBeenCalledTimes(1);
      expect(managed.geometryRepairAttempts).toBe(1);
    });

    it("does not count a still-parsing tick (pendingWrites) as a repair attempt", () => {
      // Same deferral as the lastWriteAt case, via the other streaming signal:
      // a queued-but-unparsed batch means reconcileGeometryFresh would defer,
      // so the watchdog must not issue the repair or spend a breaker attempt.
      const managed = makeManaged({ isAltBuffer: false });
      setRenderPaused(managed, false);
      setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
      managed.pendingWrites = 1;
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
      expect(managed.geometryRepairAttempts ?? 0).toBe(0);

      // The batch lands (and its lastWriteAt stamp ages out) — next tick repairs.
      managed.pendingWrites = 0;
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).toHaveBeenCalledTimes(1);
      expect(managed.geometryRepairAttempts).toBe(1);
    });

    it("falls through to the paused-render recovery on a streaming-deferred tick", () => {
      // Deferring the geometry repair must not starve the cheaper layers: a
      // streaming pane whose renderer is paused still needs the unpause.
      const managed = makeManaged({ isAltBuffer: false });
      setRenderPaused(managed, true);
      setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      managed.lastWriteAt = Date.now() + WATCHDOG_INTERVAL_MS;
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
      expect(refreshCount(managed)).toBe(1);
    });

    it("still issues the reveal-pending repair for a streaming ALT-buffer pane (quiescence gate is main-buffer only)", () => {
      // The geometry branch excludes alt panes outright (#11443), but the
      // reveal-pending obligation still belongs to them: its repair also
      // restores the WebGL atlas and unpauses the renderer, and
      // reconcileGeometryFresh's quiescence gate sits after the alt early
      // return, so writes must not defer it.
      const managed = makeManaged({ isAltBuffer: true });
      setRenderPaused(managed, false);
      setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
      managed.revealPendingRepair = true;
      managed.revealPendingGeneration = managed.attachGeneration;
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      managed.lastWriteAt = Date.now() + WATCHDOG_INTERVAL_MS;
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).toHaveBeenCalledTimes(1);
      expect(managed.revealPendingRepair).toBe(false);
      // The reveal obligation is not a convergence repair — it must not spend a
      // breaker attempt the alt pane can never win back.
      expect(managed.geometryRepairAttempts ?? 0).toBe(0);
    });

    it("neither advances nor resets the breaker while a synchronized-output block stays open", () => {
      const managed = makeManaged({ isAltBuffer: false });
      (
        managed.terminal as unknown as { modes: { synchronizedOutputMode: boolean } }
      ).modes.synchronizedOutputMode = true;
      setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
      // Seed a partial count so the assertion is breaker-specific: a synchronized
      // block skips the whole geometry branch, so it must neither increment the
      // count (repair path) nor clear it (convergence-reset path).
      managed.geometryRepairAttempts = 1;
      managed.geometryRepairGeneration = managed.attachGeneration;
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      for (let i = 0; i < 12; i++) vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
      expect(managed.geometryRepairGaveUp).toBeFalsy();
      expect(managed.geometryRepairAttempts).toBe(1);
    });
  });

  describe("reveal-pending guaranteed redraw (#10632)", () => {
    it("runs the deferred redraw once the host is on-screen and clears the obligation", () => {
      const managed = makeManaged({ isAltBuffer: true });
      managed.revealPendingRepair = true;
      managed.revealPendingGeneration = managed.attachGeneration;
      setGrid(managed, { cols: 100, rows: 40 }, { cols: 100, rows: 40 });
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).toHaveBeenCalledWith("t1");
      expect(managed.revealPendingRepair).toBe(false);
      expect(managed.revealPendingGeneration).toBeUndefined();
    });

    it("keeps the obligation when the reconcile reports an unmeasurable box", () => {
      const managed = makeManaged({ isAltBuffer: true });
      managed.revealPendingRepair = true;
      managed.revealPendingGeneration = managed.attachGeneration;
      setGrid(managed, { cols: 100, rows: 40 }, { cols: 100, rows: 40 });
      instances.set("t1", managed);
      // reconcile fails (box still occluded) → flag must survive for the retry.
      const deps = makeDeps(instances, { reconcileRevealGeometry: vi.fn(() => false) });
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).toHaveBeenCalledWith("t1");
      expect(managed.revealPendingRepair).toBe(true);
    });

    it("defers the reveal-pending redraw for a streaming main-buffer pane without stamping the cooldown", () => {
      // Issuing the reveal repair on a streaming pane is a guaranteed no-op
      // (reconcileGeometryFresh's quiescence gate defers it), so it must not
      // stamp the 6s cooldown or spend heavy budget — the obligation stays
      // armed and the very next quiet tick repairs.
      const managed = makeManaged({ isAltBuffer: false });
      managed.revealPendingRepair = true;
      managed.revealPendingGeneration = managed.attachGeneration;
      // Diverged grid: the exact case where reconcileGeometryFresh's streaming
      // gate WOULD defer the re-wrap, making the issued repair a no-op.
      setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
      managed.pendingWrites = 1;
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
      expect(managed.revealPendingRepair).toBe(true);
      expect(managed.lastWatchdogRepairAt).toBeUndefined();
      // The fall-through geometry-convergence branch must defer too — no
      // breaker attempt spent on the same streaming tick.
      expect(managed.geometryRepairAttempts ?? 0).toBe(0);

      // The stream drains — the next tick issues the repair and clears the flag.
      managed.pendingWrites = 0;
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).toHaveBeenCalledWith("t1");
      expect(managed.revealPendingRepair).toBe(false);
    });

    it("defers the reveal-pending redraw while a synchronized-output block is open", () => {
      const managed = makeManaged({ isAltBuffer: true });
      managed.revealPendingRepair = true;
      managed.revealPendingGeneration = managed.attachGeneration;
      (
        managed.terminal as unknown as { modes: { synchronizedOutputMode: boolean } }
      ).modes.synchronizedOutputMode = true;
      setGrid(managed, { cols: 100, rows: 40 }, { cols: 100, rows: 40 });
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
      expect(managed.revealPendingRepair).toBe(true);
    });
  });

  describe("cooldown", () => {
    it("does not repeat a repair within the cooldown window", () => {
      const managed = makeManaged({ isVisible: false });
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).toHaveBeenCalledTimes(1);
      expect(managed.lastWatchdogRepairAt).toBeGreaterThan(0);

      // Second tick lands inside the cooldown window.
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).toHaveBeenCalledTimes(1);

      // Third tick is past the cooldown — the still-diverged state repairs again.
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).toHaveBeenCalledTimes(2);
    });

    it("uses a long enough cooldown to span at least one full tick", () => {
      expect(WATCHDOG_REPAIR_COOLDOWN_MS).toBeGreaterThan(WATCHDOG_INTERVAL_MS);
    });
  });

  describe("heavy repair cap", () => {
    it("caps heavy repairs per tick and retries the deferred terminal next tick", () => {
      for (let i = 0; i < WATCHDOG_MAX_HEAVY_REPAIRS_PER_TICK + 1; i++) {
        instances.set(`t${i}`, makeManaged({ isVisible: false }));
      }
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).toHaveBeenCalledTimes(WATCHDOG_MAX_HEAVY_REPAIRS_PER_TICK);

      // The skipped terminal was not stamped with a cooldown — next tick picks it up.
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).toHaveBeenCalledTimes(WATCHDOG_MAX_HEAVY_REPAIRS_PER_TICK + 1);
    });

    it("does not count renderer-unpause repairs against the heavy budget", () => {
      // Three blank panes must all recover on the same tick. Charging the unpause
      // heavy would fix two and leave the third blank for another 3s (#11800).
      const pausedA = makeManaged();
      const pausedB = makeManaged();
      const pausedC = makeManaged();
      setRenderPaused(pausedA, true);
      setRenderPaused(pausedB, true);
      setRenderPaused(pausedC, true);
      instances.set("a", pausedA);
      instances.set("b", pausedB);
      instances.set("c", pausedC);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(refreshCount(pausedA)).toBe(1);
      expect(refreshCount(pausedB)).toBe(1);
      expect(refreshCount(pausedC)).toBe(1);
    });
  });

  describe("pointerdown diagnostic snapshot", () => {
    it("logs a chain snapshot for the clicked terminal without mutating state", () => {
      const managed = makeManaged({ needsWake: true });
      setRenderPaused(managed, true);
      instances.set("t1", managed);
      const deps = makeDeps(instances, {
        getQueuedBytes: vi.fn(() => 512),
        getBackendTier: vi.fn(() => "background" as const),
      });
      watchdog = new TerminalReconciliationWatchdog(deps);

      const termEl = managed.terminal.element as HTMLElement;
      termEl.dispatchEvent(new Event("pointerdown", { bubbles: true }));

      expect(logDebug).toHaveBeenCalledWith(
        expect.stringContaining("pointerdown chain snapshot"),
        expect.objectContaining({
          id: "t1",
          serviceVisible: true,
          backendTier: "background",
          queuedBytes: 512,
          needsWake: true,
          xtermPaused: true,
        })
      );
      // Diagnostic only — no repair side effects.
      expect(deps.setVisible).not.toHaveBeenCalled();
      expect(deps.resumeFlush).not.toHaveBeenCalled();
    });

    it("records the PTY half of the chain alongside xterm's grid (#11641)", () => {
      const managed = makeManaged();
      setGrid(managed, { cols: 80, rows: 24 }, { cols: 80, rows: 24 });
      managed.lastPtyResizeResult = {
        launchGeneration: 2,
        requestedCols: 120,
        requestedRows: 40,
        appliedCols: 120,
        appliedRows: 40,
        outcome: "applied",
      };
      managed.ptyGeometryDivergenceCount = 3;
      instances.set("t1", managed);
      watchdog = new TerminalReconciliationWatchdog(makeDeps(instances));

      (managed.terminal.element as HTMLElement).dispatchEvent(
        new Event("pointerdown", { bubbles: true })
      );

      // A pane wrapping at the wrong width is a broken layer like any other,
      // and the click is the only moment both grids are captured together —
      // `setFocused`'s wake destroys the evidence right after.
      expect(logDebug).toHaveBeenCalledWith(
        expect.stringContaining("pointerdown chain snapshot"),
        expect.objectContaining({
          xtermCols: 80,
          xtermRows: 24,
          ptyResizeOutcome: "applied",
          ptyAppliedCols: 120,
          ptyAppliedRows: 40,
          ptyGeometryDivergenceCount: 3,
        })
      );
    });

    it("ignores pointerdowns outside any terminal host element", () => {
      instances.set("t1", makeManaged());
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      const outside = document.createElement("div");
      document.body.appendChild(outside);
      outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));

      expect(logDebug).not.toHaveBeenCalledWith(
        expect.stringContaining("pointerdown chain snapshot"),
        expect.anything()
      );
    });

    it("does not cancel or stop the event", () => {
      const managed = makeManaged();
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      const bubbledTo = vi.fn();
      document.body.addEventListener("pointerdown", bubbledTo);
      const event = new Event("pointerdown", { bubbles: true, cancelable: true });
      (managed.terminal.element as HTMLElement).dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(bubbledTo).toHaveBeenCalled();
      document.body.removeEventListener("pointerdown", bubbledTo);
    });
  });

  describe("dispose", () => {
    it("stops the interval and removes listeners", () => {
      const managed = makeManaged({ isVisible: false });
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);
      watchdog.dispose();

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 3);
      expect(deps.setVisible).not.toHaveBeenCalled();

      (managed.terminal.element as HTMLElement).dispatchEvent(
        new Event("pointerdown", { bubbles: true })
      );
      expect(logDebug).not.toHaveBeenCalledWith(
        expect.stringContaining("pointerdown chain snapshot"),
        expect.anything()
      );

      document.dispatchEvent(new Event("visibilitychange"));
      expect(deps.setVisible).not.toHaveBeenCalled();

      watchdog = undefined;
    });
  });
});

describe("isXtermRenderPaused", () => {
  it("returns true only when the private flag is exactly true", () => {
    const managed = makeManaged();
    expect(isXtermRenderPaused(managed.terminal)).toBe(false);
    setRenderPaused(managed, true);
    expect(isXtermRenderPaused(managed.terminal)).toBe(true);
    setRenderPaused(managed, false);
    expect(isXtermRenderPaused(managed.terminal)).toBe(false);
  });
});

describe("TerminalReconciliationWatchdog — cached project view (#11212)", () => {
  let watchdog: TerminalReconciliationWatchdog | undefined;
  let instances: Map<string, ManagedTerminal>;
  let emitCached: () => void;
  let emitWarmActivated: () => void;
  let emitRevealed: () => void;
  let latchedCached = false;

  beforeEach(() => {
    latchedCached = false;
    vi.useFakeTimers();
    instances = new Map();
    // The bug's precondition: a cached view keeps reporting "visible", so the
    // existing gate never engages and its hosts still have real, on-screen rect
    // geometry — every pane in a hidden project classifies as on-screen.
    setDocumentVisibility("visible");
    __resetSidebarLayoutTransitionLockForTests();
    __resetSidebarHydrationLockForTests();
    unlockSidebarHydration();

    const cachedHandlers: Array<() => void> = [];
    const warmHandlers: Array<() => void> = [];
    const revealedHandlers: Array<() => void> = [];
    vi.stubGlobal("electron", {
      app: {
        onViewCached: (cb: () => void) => {
          cachedHandlers.push(cb);
          return vi.fn();
        },
        onViewWarmActivated: (cb: () => void) => {
          warmHandlers.push(cb);
          return vi.fn();
        },
        onViewRevealed: (cb: () => void) => {
          revealedHandlers.push(cb);
          return vi.fn();
        },
        // Preload's latch. Setting this before constructing reproduces the
        // switch-storm case where the view was already cached before this
        // module ever evaluated, so no "cached" phase is ever delivered.
        isViewCached: () => latchedCached,
      },
    });
    emitCached = () => cachedHandlers.forEach((h) => h());
    emitWarmActivated = () => warmHandlers.forEach((h) => h());
    emitRevealed = () => revealedHandlers.forEach((h) => h());
    // viewCacheState arms on first use and persists for the module's life.
    // Earlier describes in this file construct controllers before the stub
    // exists, arming it against no bridge — reset so this suite's
    // subscriptions bind to the emitters above.
    __resetProjectViewCacheStateForTests();
  });

  afterEach(() => {
    watchdog?.dispose();
    watchdog = undefined;
    __resetProjectViewCacheStateForTests();
    vi.stubGlobal("electron", undefined);
    document.body.innerHTML = "";
    __resetSidebarLayoutTransitionLockForTests();
    __resetSidebarHydrationLockForTests();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // One divergence per case. A single terminal carrying every divergence at
  // once proves nothing about the later branches: reconcile() repairs the first
  // divergence it finds and returns, so an isVisible=false pane short-circuits
  // at the visibility branch and the tier/backend/WebGL assertions would hold
  // even with no gate at all.
  it("repairs no divergent visibility for a cached view", () => {
    instances.set("t1", makeManaged({ isVisible: false }));
    const deps = makeDeps(instances);
    watchdog = new TerminalReconciliationWatchdog(deps);

    emitCached();
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 5);

    expect(deps.setVisible).not.toHaveBeenCalled();
  });

  it("repairs no BACKGROUND tier for a cached view", () => {
    instances.set(
      "t1",
      makeManaged({
        isVisible: true,
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        getRefreshTier: () => TerminalRefreshTier.VISIBLE,
      })
    );
    const deps = makeDeps(instances);
    watchdog = new TerminalReconciliationWatchdog(deps);

    emitCached();
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 5);

    expect(deps.applyRendererPolicy).not.toHaveBeenCalled();
  });

  it("reasserts no backend tier for a cached view", () => {
    instances.set(
      "t1",
      makeManaged({
        isVisible: true,
        lastAppliedTier: TerminalRefreshTier.VISIBLE,
        getRefreshTier: () => TerminalRefreshTier.VISIBLE,
      })
    );
    const deps = makeDeps(instances, { getBackendTier: vi.fn(() => "background" as const) });
    watchdog = new TerminalReconciliationWatchdog(deps);

    emitCached();
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 5);

    expect(deps.reassertActiveBackendTier).not.toHaveBeenCalled();
  });

  it("attaches no WebGL context for a cached view", () => {
    // A hidden view reattaching WebGL burns a slot from the fleet-wide context
    // cap that a pane the user is actually looking at needs (cf. #10671).
    instances.set(
      "t1",
      makeManaged({
        isVisible: true,
        lastAppliedTier: TerminalRefreshTier.VISIBLE,
        getRefreshTier: () => TerminalRefreshTier.VISIBLE,
      })
    );
    const deps = makeDeps(instances, {
      shouldHaveWebGL: vi.fn(() => true),
      isWebGLActive: vi.fn(() => false),
    });
    watchdog = new TerminalReconciliationWatchdog(deps);

    emitCached();
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 5);

    expect(deps.ensureWebGL).not.toHaveBeenCalled();
  });

  it("keeps a reveal-pending obligation armed across a cached window and discharges it on reveal", () => {
    // The obligation must survive the cache window intact — neither consumed by
    // a cached tick nor dropped — and reveal is what discharges it.
    const managed = makeManaged({
      isVisible: true,
      lastAppliedTier: TerminalRefreshTier.VISIBLE,
      getRefreshTier: () => TerminalRefreshTier.VISIBLE,
      revealPendingRepair: true,
      revealPendingGeneration: 0,
      attachGeneration: 0,
    });
    instances.set("t1", managed);
    const deps = makeDeps(instances);
    watchdog = new TerminalReconciliationWatchdog(deps);

    emitCached();
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 5);
    expect(deps.reconcileRevealGeometry).not.toHaveBeenCalled();
    expect(managed.revealPendingRepair).toBe(true);

    emitRevealed();

    expect(deps.reconcileRevealGeometry).toHaveBeenCalledWith("t1");
    expect(managed.revealPendingRepair).toBe(false);
  });

  it("retains a reveal-pending obligation when the reveal reconcile cannot measure", () => {
    const managed = makeManaged({
      isVisible: true,
      lastAppliedTier: TerminalRefreshTier.VISIBLE,
      getRefreshTier: () => TerminalRefreshTier.VISIBLE,
      revealPendingRepair: true,
      revealPendingGeneration: 0,
      attachGeneration: 0,
    });
    instances.set("t1", managed);
    const deps = makeDeps(instances, { reconcileRevealGeometry: vi.fn(() => false) });
    watchdog = new TerminalReconciliationWatchdog(deps);

    emitCached();
    emitRevealed();

    // An unmeasurable box keeps the obligation for a later tick.
    expect(managed.revealPendingRepair).toBe(true);
  });

  it("reads no DOM geometry for a cached view", () => {
    const managed = makeManaged({ isVisible: false });
    const rectSpy = vi.fn(() => new DOMRect(0, 0, 800, 600));
    managed.hostElement.getBoundingClientRect = rectSpy;
    instances.set("t1", managed);
    const deps = makeDeps(instances);
    watchdog = new TerminalReconciliationWatchdog(deps);

    emitCached();
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 5);

    // The sweep's forced layout is the cost even when no repair follows.
    expect(rectSpy).not.toHaveBeenCalled();
  });

  it("stops the interval while cached", () => {
    instances.set("t1", makeManaged({ isVisible: false }));
    const getInstances = vi.fn(() => instances.entries());
    const deps = makeDeps(instances, { getInstances });
    watchdog = new TerminalReconciliationWatchdog(deps);

    emitCached();
    getInstances.mockClear();
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 10);

    expect(getInstances).not.toHaveBeenCalled();
  });

  it("a direct tick() while cached is a no-op", () => {
    // tick() is reachable from visibilitychange and the reveal sweep, and a
    // cleared interval can't retract an already-dispatched callback — so the
    // guard has to live in the body, not only on the timer.
    instances.set("t1", makeManaged({ isVisible: false }));
    const deps = makeDeps(instances);
    watchdog = new TerminalReconciliationWatchdog(deps);

    emitCached();
    watchdog.tick();

    expect(deps.setVisible).not.toHaveBeenCalled();
  });

  it("rearms exactly one interval on warm activation", () => {
    instances.set("t1", makeManaged({ isVisible: false }));
    const deps = makeDeps(instances);
    watchdog = new TerminalReconciliationWatchdog(deps);

    emitCached();
    emitWarmActivated();
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    // Exactly once — a stacked second interval would repair twice per period.
    expect(deps.setVisible).toHaveBeenCalledTimes(1);
  });

  it("does not stack intervals when warm activation repeats", () => {
    instances.set("t1", makeManaged({ isVisible: false }));
    const deps = makeDeps(instances);
    watchdog = new TerminalReconciliationWatchdog(deps);

    emitWarmActivated();
    emitWarmActivated();
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    expect(deps.setVisible).toHaveBeenCalledTimes(1);
  });

  it("sweeps immediately on reveal instead of waiting out the interval", () => {
    instances.set("t1", makeManaged({ isVisible: false }));
    const deps = makeDeps(instances);
    watchdog = new TerminalReconciliationWatchdog(deps);

    emitCached();
    expect(deps.setVisible).not.toHaveBeenCalled();

    emitRevealed();

    // Reveal is when stale state is most likely and most user-visible.
    expect(deps.setVisible).toHaveBeenCalledWith("t1");
  });

  it("keeps document-hidden suppression independent of the cache signal", () => {
    instances.set("t1", makeManaged({ isVisible: false }));
    const deps = makeDeps(instances);
    watchdog = new TerminalReconciliationWatchdog(deps);

    emitWarmActivated();
    setDocumentVisibility("hidden");
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    expect(deps.setVisible).not.toHaveBeenCalled();
  });

  it("resumes normal reconciliation after a cached window ends", () => {
    instances.set("t1", makeManaged({ isVisible: false }));
    const deps = makeDeps(instances);
    watchdog = new TerminalReconciliationWatchdog(deps);

    emitCached();
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 3);
    expect(deps.setVisible).not.toHaveBeenCalled();

    emitWarmActivated();
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    expect(deps.setVisible).toHaveBeenCalledWith("t1");
  });

  it("does not arm the interval when constructed during a cached window", () => {
    // The switch-storm case: cached before this module evaluated, so the state
    // is seeded from preload's latch and no "cached" phase ever arrives.
    latchedCached = true;
    instances.set("t1", makeManaged({ isVisible: false }));
    const getInstances = vi.fn(() => instances.entries());
    const deps = makeDeps(instances, { getInstances });
    watchdog = new TerminalReconciliationWatchdog(deps);

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 10);

    expect(getInstances).not.toHaveBeenCalled();
    expect(deps.setVisible).not.toHaveBeenCalled();
  });

  it("arms the interval on activation after being constructed while cached", () => {
    latchedCached = true;
    instances.set("t1", makeManaged({ isVisible: false }));
    const deps = makeDeps(instances);
    watchdog = new TerminalReconciliationWatchdog(deps);

    emitWarmActivated();
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    expect(deps.setVisible).toHaveBeenCalledTimes(1);
  });

  it("dispose() stops responding to lifecycle events", () => {
    instances.set("t1", makeManaged({ isVisible: false }));
    const deps = makeDeps(instances);
    watchdog = new TerminalReconciliationWatchdog(deps);

    watchdog.dispose();
    watchdog = undefined;
    emitWarmActivated();
    emitRevealed();
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 5);

    expect(deps.setVisible).not.toHaveBeenCalled();
  });
});

describe("TerminalReconciliationWatchdog — applied-PTY geometry divergence (#11641)", () => {
  let watchdog: TerminalReconciliationWatchdog | undefined;
  let instances: Map<string, ManagedTerminal>;

  beforeEach(() => {
    vi.useFakeTimers();
    instances = new Map();
    setDocumentVisibility("visible");
    __resetSidebarLayoutTransitionLockForTests();
    __resetSidebarHydrationLockForTests();
    unlockSidebarHydration();
  });

  afterEach(() => {
    watchdog?.dispose();
    watchdog = undefined;
    document.body.innerHTML = "";
    __resetSidebarLayoutTransitionLockForTests();
    __resetSidebarHydrationLockForTests();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function ptyDivergenceWarnings() {
    return vi
      .mocked(logWarn)
      .mock.calls.filter((call) => String(call[0]).includes("PTY grid disagrees with xterm"));
  }

  function makeResult(
    overrides: Partial<ManagedTerminal["lastPtyResizeResult"] & object> = {}
  ): NonNullable<ManagedTerminal["lastPtyResizeResult"]> {
    return {
      launchGeneration: 1,
      requestedCols: 120,
      requestedRows: 40,
      appliedCols: 120,
      appliedRows: 40,
      outcome: "applied",
      ...overrides,
    };
  }

  it("reports a PTY grid that disagrees with the live xterm grid", () => {
    const managed = makeManaged();
    // The PTY wraps at 120 while xterm parses at 80 — cursor-addressed output
    // lands on the wrong rows and nothing recovers it.
    setGrid(managed, { cols: 80, rows: 40 }, { cols: 80, rows: 40 });
    managed.lastPtyResizeResult = makeResult();
    instances.set("t1", managed);
    watchdog = new TerminalReconciliationWatchdog(makeDeps(instances));

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    const warnings = ptyDivergenceWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toMatchObject({ appliedCols: 120, xtermCols: 80 });
    expect(managed.ptyGeometryDivergenceCount).toBe(1);
  });

  it("reports a persistent divergence once per episode, not once per sweep", () => {
    const managed = makeManaged();
    setGrid(managed, { cols: 80, rows: 40 }, { cols: 80, rows: 40 });
    managed.lastPtyResizeResult = makeResult();
    instances.set("t1", managed);
    watchdog = new TerminalReconciliationWatchdog(makeDeps(instances));

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 5);

    // An interval-driven sweep that logged every tick would flood the log
    // buffer for the entire life of a split pane.
    expect(ptyDivergenceWarnings()).toHaveLength(1);
    expect(managed.ptyGeometryDivergenceCount).toBe(1);
  });

  it("counts a new episode when the divergence changes shape", () => {
    const managed = makeManaged();
    setGrid(managed, { cols: 80, rows: 40 }, { cols: 80, rows: 40 });
    managed.lastPtyResizeResult = makeResult();
    instances.set("t1", managed);
    watchdog = new TerminalReconciliationWatchdog(makeDeps(instances));

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    managed.lastPtyResizeResult = makeResult({ appliedCols: 200, requestedCols: 200 });
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    expect(ptyDivergenceWarnings()).toHaveLength(2);
    expect(managed.ptyGeometryDivergenceCount).toBe(2);
  });

  it("re-reports a divergence that recurs after the grids agreed", () => {
    const managed = makeManaged();
    setGrid(managed, { cols: 80, rows: 40 }, { cols: 80, rows: 40 });
    managed.lastPtyResizeResult = makeResult();
    instances.set("t1", managed);
    watchdog = new TerminalReconciliationWatchdog(makeDeps(instances));

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    // Converged: the signature must clear so a recurrence is a fresh episode
    // rather than being swallowed as a duplicate forever.
    managed.lastPtyResizeResult = makeResult({ appliedCols: 80, requestedCols: 80 });
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(ptyDivergenceWarnings()).toHaveLength(1);

    managed.lastPtyResizeResult = makeResult();
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(ptyDivergenceWarnings()).toHaveLength(2);
    expect(managed.ptyGeometryDivergenceCount).toBe(2);
  });

  it("stays silent when the PTY and xterm grids agree", () => {
    const managed = makeManaged();
    setGrid(managed, { cols: 120, rows: 40 }, { cols: 120, rows: 40 });
    managed.lastPtyResizeResult = makeResult();
    instances.set("t1", managed);
    watchdog = new TerminalReconciliationWatchdog(makeDeps(instances));

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 3);

    expect(ptyDivergenceWarnings()).toHaveLength(0);
    expect(managed.ptyGeometryDivergenceCount).toBeUndefined();
  });

  it("stays silent when no live PTY geometry was reported", () => {
    const managed = makeManaged();
    setGrid(managed, { cols: 80, rows: 40 }, { cols: 80, rows: 40 });
    // An exited/rejected resize carries no applied geometry — there is nothing
    // to compare, so it must not be read as a divergence against 80x40.
    managed.lastPtyResizeResult = makeResult({
      outcome: "exited",
      appliedCols: null,
      appliedRows: null,
    });
    instances.set("t1", managed);
    watchdog = new TerminalReconciliationWatchdog(makeDeps(instances));

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    expect(ptyDivergenceWarnings()).toHaveLength(0);
  });

  it("compares against the live xterm grid, not a queued resize target", () => {
    const managed = makeManaged();
    setGrid(managed, { cols: 80, rows: 40 }, { cols: 80, rows: 40 });
    // latestCols names the target of a resize that has not committed. Reading
    // it as xterm's geometry would call a real split converged.
    managed.latestCols = 120;
    managed.latestRows = 40;
    managed.lastPtyResizeResult = makeResult();
    instances.set("t1", managed);
    watchdog = new TerminalReconciliationWatchdog(makeDeps(instances));

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    expect(ptyDivergenceWarnings()).toHaveLength(1);
  });
});

describe("TerminalReconciliationWatchdog — fit diagnostic in production (#11641)", () => {
  let watchdog: TerminalReconciliationWatchdog | undefined;
  let instances: Map<string, ManagedTerminal>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Vitest runs with import.meta.env.DEV === true, so without forcing it off
    // these tests would pass just as happily against the old
    // `if (!import.meta.env?.DEV) return;` gate — i.e. they would not actually
    // prove the diagnostic was promoted.
    vi.stubEnv("DEV", false);
    instances = new Map();
    setDocumentVisibility("visible");
    __resetSidebarLayoutTransitionLockForTests();
    __resetSidebarHydrationLockForTests();
    unlockSidebarHydration();
  });

  afterEach(() => {
    watchdog?.dispose();
    watchdog = undefined;
    document.body.innerHTML = "";
    __resetSidebarLayoutTransitionLockForTests();
    __resetSidebarHydrationLockForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function fitWarnings() {
    return vi
      .mocked(logWarn)
      .mock.calls.filter((call) => String(call[0]).includes("disagrees with container"));
  }

  it("reports a container/xterm divergence once per episode", () => {
    const managed = makeManaged();
    setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
    instances.set("t1", managed);
    watchdog = new TerminalReconciliationWatchdog(
      makeDeps(instances, { reconcileRevealGeometry: vi.fn() })
    );

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 4);

    expect(fitWarnings()).toHaveLength(1);
  });

  it("does not treat a proposal past the shared ceiling as a divergence", () => {
    const managed = makeManaged();
    // xterm cannot exceed the shared ceiling, so an unbounded proposal above it
    // would otherwise read as a permanent, unfixable disagreement.
    setGrid(
      managed,
      { cols: MAX_TERMINAL_GRID_DIMENSION, rows: 40 },
      { cols: MAX_TERMINAL_GRID_DIMENSION + 500, rows: 40 }
    );
    instances.set("t1", managed);
    watchdog = new TerminalReconciliationWatchdog(makeDeps(instances));

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    expect(fitWarnings()).toHaveLength(0);
  });

  it("keeps reporting after a measurement failure rather than treating it as convergence", () => {
    const managed = makeManaged();
    setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
    instances.set("t1", managed);
    watchdog = new TerminalReconciliationWatchdog(
      makeDeps(instances, { reconcileRevealGeometry: vi.fn() })
    );

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(fitWarnings()).toHaveLength(1);

    // A throwing measurement proves nothing about the grid. Clearing the
    // signature here would make the next tick re-report the same episode.
    // Models a detached element: the proposal resolves, reading it throws.
    setGrid(
      managed,
      { cols: 137, rows: 40 },
      {
        get cols(): number {
          throw new Error("element detached");
        },
        rows: 40,
      }
    );
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    setGrid(managed, { cols: 137, rows: 40 }, { cols: 100, rows: 40 });
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(fitWarnings()).toHaveLength(1);
  });
});
