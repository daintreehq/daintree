import { Terminal } from "@xterm/xterm";
import { TerminalRefreshTier } from "@/types";
import { isSidebarLayoutTransitionLocked } from "@/lib/layoutTransitionLock";
import { logDebug, logWarn } from "@/utils/logger";
import type { ManagedTerminal } from "./types";

// Sweep cadence. Matches the TerminalReflowController heartbeat — slow enough
// that batched getBoundingClientRect reads are free, fast enough that a frozen
// visible terminal recovers within one "is it stuck?" human reaction window.
export const WATCHDOG_INTERVAL_MS = 3000;

// Per-terminal cooldown after any repair. Two full ticks: if a repair didn't
// take, the next attempt happens on the third tick rather than every tick, so
// a persistently-diverging layer surfaces as periodic log entries instead of
// a repair loop fighting whatever keeps breaking it.
export const WATCHDOG_REPAIR_COOLDOWN_MS = 6000;

// Heavy repairs (anything that can trigger wake/restore IPC or a WebGL
// context attach) allowed per tick. Light repairs (flush, reflow) are uncapped.
export const WATCHDOG_MAX_HEAVY_REPAIRS_PER_TICK = 2;

/** Narrow structural type for the private xterm.js render-pause flag. */
interface XtermCoreRenderPause {
  _renderService?: { _isPaused?: boolean };
}

/**
 * Whether xterm's core RenderService is currently paused. xterm 6 has no
 * public API for this — the IntersectionObserver-driven `_isPaused` flag is
 * the same `_core` escape hatch `getXtermCellDimensions` uses. If the private
 * field disappears in a future xterm, this returns false and the watchdog
 * simply skips the render-pause check (the other layers still reconcile).
 */
export function isXtermRenderPaused(terminal: Terminal): boolean {
  try {
    return (
      (terminal as Terminal & { _core?: XtermCoreRenderPause })._core?._renderService?._isPaused ===
      true
    );
  } catch {
    return false;
  }
}

export interface ReconciliationWatchdogDeps {
  getInstances: () => Iterable<[string, ManagedTerminal]>;
  /** Repair: store/service visibility diverged — force-set isVisible true. */
  setVisible: (id: string) => void;
  /** Repair: computed/applied tier stuck at BACKGROUND for an on-screen terminal. */
  applyRendererPolicy: (id: string, tier: TerminalRefreshTier) => void;
  /** Repair: backend tier diverged to "background" while the applied tier is active. */
  reassertActiveBackendTier: (id: string) => void;
  getBackendTier: (id: string) => "active" | "background" | undefined;
  /** Bytes stranded in the ingest queue with no in-flight drain to rescue them. */
  getStalledBytes: (id: string) => number;
  /** Total held ingest bytes — diagnostic snapshot only. */
  getQueuedBytes: (id: string) => number;
  resumeFlush: (id: string) => void;
  hasInFlightWake: (id: string) => boolean;
  /** Wake requested but not started yet (retry-scheduled or rate-limit coalesced). */
  hasPendingWake: (id: string) => boolean;
  isWebGLActive: (id: string) => boolean;
  shouldHaveWebGL: (managed: ManagedTerminal) => boolean;
  ensureWebGL: (id: string, managed: ManagedTerminal) => void;
  unhibernate: (id: string) => void;
  forceReflow: (element: HTMLElement) => void;
  isStoreBackgrounded: (id: string) => boolean;
  /** Store-side panel.isVisible === false — the one store state DOM geometry can prove wrong. */
  isStoreHidden: (id: string) => boolean;
  /** Repair: store visibility poisoned to false for a genuinely on-screen terminal. */
  repairStoreVisibility: (id: string) => void;
}

/**
 * Last-resort reconciler for the "visible terminal stopped rendering" failure
 * mode (#9781). At least five independent suppression layers can each freeze
 * a visible terminal (pty-host producer gate, renderer ingest hold, store
 * visibility/tier misclassification, xterm render pause / WebGL loss,
 * hibernation), and visibility/tier state has many writers across three
 * processes. Every few seconds this takes fresh DOM geometry as ground truth
 * and verifies the full chain for each genuinely on-screen terminal,
 * repairing divergence narrowly and logging every mismatch so the remaining
 * root causes surface instead of being silently masked.
 *
 * It also owns the click-time diagnostic: a document-level capture-phase
 * pointerdown listener snapshots the same chain state for the clicked
 * terminal before any focus/wake recovery runs (capture on `document`
 * precedes React's root-container capture handlers and xterm's own
 * listeners), so a single click on a frozen terminal names the guilty layer.
 */
export class TerminalReconciliationWatchdog {
  private deps: ReconciliationWatchdogDeps;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;

  private readonly _onVisibilityChange = (): void => {
    // The moment the document becomes visible again is when stale state is
    // most likely (intervals are throttled while hidden) and the most
    // user-visible failure moment — sweep immediately instead of waiting out
    // the remainder of the interval.
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    this.tick();
  };

  private readonly _onPointerDownCapture = (event: PointerEvent): void => {
    try {
      const target = event.target;
      if (!(target instanceof Node)) return;
      for (const [id, managed] of this.deps.getInstances()) {
        if (!managed.hostElement.contains(target)) continue;
        this.logPointerDownSnapshot(id, managed);
        return;
      }
    } catch {
      // Diagnostic only — never interfere with the click.
    }
  };

  constructor(deps: ReconciliationWatchdogDeps) {
    this.deps = deps;

    if (typeof setInterval === "function") {
      this.intervalTimer = setInterval(() => this.tick(), WATCHDOG_INTERVAL_MS);
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this._onVisibilityChange);
      // Capture phase, registered on document: runs before React's
      // root-container capture handlers (which start focus/wake recovery via
      // setFocused) and before xterm's own element-level listeners, so the
      // snapshot reflects the pre-recovery state. Read-only — no
      // preventDefault/stopPropagation.
      document.addEventListener("pointerdown", this._onPointerDownCapture, { capture: true });
    }
  }

  /**
   * One reconciliation sweep. Phase 1 batches all DOM geometry reads (rects
   * are pure reads; no repair writes layout until the read pass completes).
   * Phase 2 walks the on-screen set and repairs at most one divergence per
   * terminal — chain layers cascade (fixing visibility re-applies tier, wake,
   * flush, and reflow), so the narrowest single repair plus the next tick's
   * re-verification beats issuing several at once.
   */
  tick(): void {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    // Mid-drag and mid-layout-animation geometry is not ground truth, and
    // repairs during either would fight legitimate transient suppression.
    if (document.documentElement.dataset.dragging === "true") return;
    if (isSidebarLayoutTransitionLocked()) return;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const onScreen: Array<{ id: string; managed: ManagedTerminal }> = [];
    for (const [id, managed] of this.deps.getInstances()) {
      // Per-terminal legitimate-suppression gates: attach/detach transitions
      // and project-switch resize suppression all have their own
      // reconciliation paths that the watchdog must not race.
      if (managed.isAttaching || managed.isDetached || managed.isResizeSuppressed) continue;
      if (managed.isSerializedRestoreInProgress) continue;
      // Explicitly user-backgrounded terminals (dock close) live in an
      // offscreen container whose `content-visibility: hidden` host still has
      // viewport-passing rect geometry — DOM geometry lies there, and their
      // BACKGROUND tier is intentional policy, not divergence.
      if (this.deps.isStoreBackgrounded(id)) continue;
      const host = managed.hostElement;
      if (!host.isConnected) continue;
      const rect = host.getBoundingClientRect();
      const isOnScreen =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top < viewportHeight &&
        rect.bottom > 0 &&
        rect.left < viewportWidth &&
        rect.right > 0;
      // Genuinely scrolled-out or zero-sized terminals are left alone.
      if (isOnScreen) onScreen.push({ id, managed });
    }

    let heavyBudget = WATCHDOG_MAX_HEAVY_REPAIRS_PER_TICK;
    const now = Date.now();
    for (const { id, managed } of onScreen) {
      this.diagnoseGeometryDivergence(id, managed);
      if (now - (managed.lastWatchdogRepairAt ?? 0) < WATCHDOG_REPAIR_COOLDOWN_MS) continue;
      heavyBudget -= this.reconcile(id, managed, now, heavyBudget);
    }
  }

  /**
   * Dev-only diagnostic for the project-switch garble bug: an on-screen,
   * settled terminal whose xterm grid (`terminal.cols/rows`) disagrees with the
   * dimensions the container can actually hold (`fitAddon.proposeDimensions()`)
   * is rendering its buffer at the wrong width — the exact "garbled line flow"
   * users see after switching back to a project. The watchdog already gated out
   * drags, layout transitions, and resize-suppressed/attaching terminals, so a
   * divergence reaching here is real, not transient. This does not repair —
   * the reveal backstops and the suppression-clear redraw own recovery — it
   * just makes a silently-wrong grid loud during local development.
   */
  private diagnoseGeometryDivergence(id: string, managed: ManagedTerminal): void {
    if (!import.meta.env?.DEV) return;
    if (managed.isHibernated) return;
    try {
      const proposal = managed.fitAddon.proposeDimensions?.();
      if (!proposal || proposal.cols <= 1 || proposal.rows <= 1) return;
      const { cols, rows } = managed.terminal;
      if (proposal.cols !== cols || proposal.rows !== rows) {
        logWarn(
          "[TerminalReconciliationWatchdog] geometry divergence: xterm grid disagrees with container (garble risk)",
          {
            id,
            xtermCols: cols,
            xtermRows: rows,
            proposedCols: proposal.cols,
            proposedRows: proposal.rows,
          }
        );
      }
    } catch {
      // Diagnostic only — never let a measurement throw break the sweep.
    }
  }

  /**
   * Verify the rendering chain for one on-screen terminal and repair the
   * first divergence found, ordered by causal depth: hibernation (nothing
   * else exists without a live xterm instance) → service visibility →
   * computed/applied tier → backend tier → stranded ingest bytes → xterm
   * render pause → WebGL context. Returns the heavy-repair budget consumed
   * (0 or 1). A heavy repair skipped for budget is retried next tick — the
   * cooldown is only stamped when a repair is actually issued.
   */
  private reconcile(
    id: string,
    managed: ManagedTerminal,
    now: number,
    heavyBudget: number
  ): number {
    if (managed.isHibernated) {
      if (heavyBudget <= 0) return 0;
      managed.lastWatchdogRepairAt = now;
      logWarn("[TerminalReconciliationWatchdog] on-screen terminal is hibernated — restoring", {
        id,
      });
      this.deps.unhibernate(id);
      return 1;
    }

    if (!managed.isVisible) {
      if (heavyBudget <= 0) return 0;
      managed.lastWatchdogRepairAt = now;
      logWarn(
        "[TerminalReconciliationWatchdog] on-screen terminal has isVisible=false — repairing",
        { id, appliedTier: managed.lastAppliedTier }
      );
      this.deps.setVisible(id);
      return 1;
    }

    const computedTier = managed.getRefreshTier?.();
    const appliedTier = managed.lastAppliedTier;
    if (
      computedTier === TerminalRefreshTier.BACKGROUND ||
      appliedTier === TerminalRefreshTier.BACKGROUND
    ) {
      const storeHidden = this.deps.isStoreHidden(id);
      // A BACKGROUND computed tier with store visibility intact is store
      // policy (completed/exited agent, exited process, PTY-less panel) —
      // hibernation eligibility, not divergence. Repairing it would fight
      // the policy on every tick, forever (#10416). Applies regardless of
      // appliedTier: when both tiers sit at BACKGROUND the applied state
      // already matches policy, and an applied-only BACKGROUND divergence
      // (computed tier active) skips this guard and repairs below.
      if (computedTier === TerminalRefreshTier.BACKGROUND && !storeHidden) return 0;
      if (heavyBudget <= 0) return 0;
      managed.lastWatchdogRepairAt = now;
      // DOM geometry and service state prove the terminal on-screen, so a
      // store-side isVisible=false is a stale write (e.g. an unguarded
      // cleanup racing a warm-swap reattach) — repair it at the source so
      // the computed tier re-derives and reconciliation converges instead
      // of re-detecting the same divergence every tick (#10416).
      if (storeHidden) this.deps.repairStoreVisibility(id);
      const refreshedTier = storeHidden ? managed.getRefreshTier?.() : computedTier;
      const repairTier =
        refreshedTier !== undefined && refreshedTier !== TerminalRefreshTier.BACKGROUND
          ? refreshedTier
          : TerminalRefreshTier.VISIBLE;
      logWarn(
        "[TerminalReconciliationWatchdog] on-screen terminal at BACKGROUND tier — repairing",
        {
          id,
          computedTier,
          appliedTier,
          repairTier,
          storeHidden,
        }
      );
      this.deps.applyRendererPolicy(id, repairTier);
      return 1;
    }

    if (this.deps.getBackendTier(id) === "background") {
      if (heavyBudget <= 0) return 0;
      managed.lastWatchdogRepairAt = now;
      logWarn(
        "[TerminalReconciliationWatchdog] backend tier is background for active on-screen terminal — repairing",
        { id, appliedTier }
      );
      this.deps.reassertActiveBackendTier(id);
      return 1;
    }

    // Bytes stranded in the ingest queue with no drain in flight. Never flush
    // while a wake is needed, pending, or in flight — wakeAndRestore resets
    // the buffer during replay and flushing first would write held bytes into
    // a pre-reset terminal (#8371); the wake path flushes itself on completion.
    const stalledBytes = this.deps.getStalledBytes(id);
    if (
      stalledBytes > 0 &&
      managed.needsWake !== true &&
      !this.deps.hasInFlightWake(id) &&
      !this.deps.hasPendingWake(id)
    ) {
      managed.lastWatchdogRepairAt = now;
      logWarn(
        "[TerminalReconciliationWatchdog] stalled ingest bytes for on-screen terminal — flushing",
        {
          id,
          stalledBytes,
        }
      );
      this.deps.resumeFlush(id);
      return 0;
    }

    // Mirror TerminalReflowController.maybeReflow's eligibility guards:
    // alt-buffer TUIs repaint from live PTY data, and a reflow mid
    // DEC 2026 synchronized-output block would interleave a paint with the
    // buffered range.
    const element = managed.terminal.element;
    if (
      element &&
      element.isConnected &&
      !managed.isAltBuffer &&
      managed.terminal.modes?.synchronizedOutputMode !== true &&
      isXtermRenderPaused(managed.terminal)
    ) {
      managed.lastWatchdogRepairAt = now;
      logWarn(
        "[TerminalReconciliationWatchdog] xterm render service paused for on-screen terminal — reflowing",
        { id }
      );
      this.deps.forceReflow(element);
      return 0;
    }

    if (this.deps.shouldHaveWebGL(managed) && !this.deps.isWebGLActive(id)) {
      if (heavyBudget <= 0) return 0;
      managed.lastWatchdogRepairAt = now;
      logWarn(
        "[TerminalReconciliationWatchdog] WebGL context missing for eligible on-screen terminal — reattaching",
        { id, appliedTier }
      );
      this.deps.ensureWebGL(id, managed);
      return 1;
    }

    return 0;
  }

  /**
   * Click-time diagnostic: synchronous, read-only snapshot of the full
   * rendering chain for the clicked terminal, logged before any focus/wake
   * recovery mutates it. A click on a frozen terminal is the natural "it was
   * frozen" marker — `setFocused`'s unconditional wake repairs the freeze and
   * destroys the evidence, so this is the one record of which layer broke.
   */
  private logPointerDownSnapshot(id: string, managed: ManagedTerminal): void {
    logDebug("[TerminalReconciliationWatchdog] pointerdown chain snapshot", {
      id,
      serviceVisible: managed.isVisible,
      storeBackgrounded: this.deps.isStoreBackgrounded(id),
      storeHidden: this.deps.isStoreHidden(id),
      computedTier: managed.getRefreshTier?.(),
      appliedTier: managed.lastAppliedTier,
      pendingTier: managed.pendingTier,
      backendTier: this.deps.getBackendTier(id),
      queuedBytes: this.deps.getQueuedBytes(id),
      stalledBytes: this.deps.getStalledBytes(id),
      pendingWrites: managed.pendingWrites,
      needsWake: managed.needsWake,
      inFlightWake: this.deps.hasInFlightWake(id),
      pendingWake: this.deps.hasPendingWake(id),
      webglActive: this.deps.isWebGLActive(id),
      isHibernated: managed.isHibernated === true,
      xtermPaused: managed.isHibernated ? undefined : isXtermRenderPaused(managed.terminal),
      isFocused: managed.isFocused,
      isAttaching: managed.isAttaching === true,
      isDetached: managed.isDetached === true,
      isResizeSuppressed: managed.isResizeSuppressed === true,
    });
  }

  dispose(): void {
    if (this.intervalTimer !== undefined) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
      document.removeEventListener("pointerdown", this._onPointerDownCapture, { capture: true });
    }
  }
}
