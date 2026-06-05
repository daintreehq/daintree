// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";
import {
  __resetSidebarLayoutTransitionLockForTests,
  lockSidebarLayoutTransition,
} from "@/lib/layoutTransitionLock";
import {
  TerminalReconciliationWatchdog,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_MAX_HEAVY_REPAIRS_PER_TICK,
  WATCHDOG_REPAIR_COOLDOWN_MS,
  isXtermRenderPaused,
  type ReconciliationWatchdogDeps,
} from "../TerminalReconciliationWatchdog";
import type { ManagedTerminal } from "../types";

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
      modes: { synchronizedOutputMode: false },
    } as unknown as ManagedTerminal["terminal"],
    kind: "terminal",
    hostElement,
    isOpened: true,
    isVisible: true,
    isFocused: false,
    isHibernated: false,
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
    isWebGLActive: vi.fn(() => true),
    shouldHaveWebGL: vi.fn(() => false),
    ensureWebGL: vi.fn(),
    unhibernate: vi.fn(),
    forceReflow: vi.fn(),
    isStoreBackgrounded: vi.fn(() => false),
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
  });

  afterEach(() => {
    watchdog?.dispose();
    watchdog = undefined;
    delete document.documentElement.dataset.dragging;
    document.body.innerHTML = "";
    __resetSidebarLayoutTransitionLockForTests();
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
    it("unhibernates an on-screen hibernated terminal", () => {
      instances.set("t1", makeManaged({ isHibernated: true, isVisible: false }));
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.unhibernate).toHaveBeenCalledWith("t1");
      // One repair per terminal per tick — visibility waits for the next sweep.
      expect(deps.setVisible).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalled();
    });

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

    it("floors the repair tier to VISIBLE when the computed tier itself is BACKGROUND", () => {
      instances.set(
        "t1",
        makeManaged({
          lastAppliedTier: TerminalRefreshTier.VISIBLE,
          getRefreshTier: () => TerminalRefreshTier.BACKGROUND,
        })
      );
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.applyRendererPolicy).toHaveBeenCalledWith("t1", TerminalRefreshTier.VISIBLE);
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

    it("reflows a terminal whose xterm render service is paused", () => {
      const managed = makeManaged();
      setRenderPaused(managed, true);
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.forceReflow).toHaveBeenCalledWith(managed.terminal.element);
    });

    it("does not reflow a paused alt-buffer (TUI) terminal", () => {
      const managed = makeManaged({ isAltBuffer: true });
      setRenderPaused(managed, true);
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.forceReflow).not.toHaveBeenCalled();
    });

    it("does not reflow while DEC 2026 synchronized output is active", () => {
      const managed = makeManaged();
      (
        managed.terminal as unknown as { modes: { synchronizedOutputMode: boolean } }
      ).modes.synchronizedOutputMode = true;
      setRenderPaused(managed, true);
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.forceReflow).not.toHaveBeenCalled();
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
      instances.set("t1", managed);
      const deps = makeDeps(instances);
      watchdog = new TerminalReconciliationWatchdog(deps);

      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(deps.setVisible).not.toHaveBeenCalled();
      expect(deps.applyRendererPolicy).not.toHaveBeenCalled();
      expect(deps.reassertActiveBackendTier).not.toHaveBeenCalled();
      expect(deps.resumeFlush).not.toHaveBeenCalled();
      expect(deps.forceReflow).not.toHaveBeenCalled();
      expect(deps.ensureWebGL).not.toHaveBeenCalled();
      expect(deps.unhibernate).not.toHaveBeenCalled();
      expect(managed.lastWatchdogRepairAt).toBeUndefined();
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

    it("does not count light repairs against the heavy budget", () => {
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
      expect(deps.forceReflow).toHaveBeenCalledTimes(3);
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
      expect(deps.unhibernate).not.toHaveBeenCalled();
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
