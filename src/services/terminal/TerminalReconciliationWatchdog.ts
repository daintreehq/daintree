import { Terminal } from "@xterm/xterm";
import { TerminalRefreshTier } from "@/types";
import { isSidebarMeasurementLocked } from "@/lib/layoutTransitionLock";
import { logDebug, logWarn } from "@/utils/logger";
import { REVEAL_REWRAP_QUIESCENT_MS } from "./TerminalResizeController";
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

// Consecutive geometry-convergence repairs allowed for one terminal before the
// circuit breaker trips (#10909). The cooldown spaces repairs ~2 ticks apart but
// never caps them, so a pane whose proposeDimensions() never converges (a stable
// off-by-one, e.g. a scrollbar-gutter width step it can't reach) would re-wrap its
// full scrollback — renderer xterm plus the 10000-line headless copy — every
// cooldown window indefinitely. After this many issued repairs still fail to
// converge, stop repairing and log once, matching TerminalWebGLManager's
// LOSS_THRESHOLD one-way-trip pattern. Reset on genuine convergence or re-attach.
export const WATCHDOG_MAX_GEOMETRY_REPAIR_ATTEMPTS = 3;

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
  forceReflow: (element: HTMLElement) => void;
  /**
   * Repair (#10632): alt-buffer-safe atomic reveal reconcile — a FRESH fit
   * (xterm + PTY resized together) plus a local WebGL-atlas repair, with NO
   * mid-block reflow. Returns false on an unmeasurable / occluded box so the
   * obligation is kept and retried on a later tick (present-ordering: never
   * repaint into a surface that isn't foreground-presenting).
   */
  reconcileRevealGeometry: (id: string) => boolean;
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
    // Mid-drag, mid-layout-animation, and pre-hydration (#10827) geometry is
    // not ground truth, and repairs during any of them would fight legitimate
    // transient suppression.
    if (document.documentElement.dataset.dragging === "true") return;
    if (isSidebarMeasurementLocked()) return;

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
   * divergence reaching here is real, not transient. This call itself only
   * logs (DEV) — the actual repair is the geometry-convergence branch in
   * {@link reconcile} (#10632) — so a silently-wrong grid is both loud during
   * local development and reconciled on the same tick.
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
   * first divergence found, ordered by causal depth: service visibility →
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

    // Bytes stranded in the ingest queue with no drain in flight. The wake/resync
    // machinery is gone (terminals stay live in the background), so these guards
    // are always satisfied now — kept so the flush still defers if a future
    // buffer-resetting path ever re-arms one (#8371).
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

    // A DEC 2026 synchronized-output block is open: a repaint/reflow now would
    // interleave a paint with the buffered range, so DEFER every render-level
    // repair (reveal-pending, geometry, unpause) to a later tick once the block
    // closes (#10632). Structural repairs above already ran; the synchronized
    // window is short, so the next 3s tick converges.
    const inSynchronizedBlock = managed.terminal.modes?.synchronizedOutputMode === true;
    const element = managed.terminal.element;

    // Reveal-pending guaranteed redraw (#10632). The project-switch suppression
    // window cleared while this host was still detached/occluded, so its one-shot
    // resetRenderer was deferred to the watchdog rather than spent on a zero-box
    // host (TerminalInstanceService.suppressResizesDuringProjectSwitch). DOM
    // geometry now proves the pane on-screen, so run the alt-buffer-safe atomic
    // repair — this is the closed-loop "is it correct now" recovery the open-loop
    // rAF/1s/3s/10s backstops never reliably delivered. The obligation is owned
    // by the attachGeneration it was armed under: a later re-attach that already
    // re-ran its own reveal supersedes it. Cleared ONLY on a successful reconcile
    // (false = unmeasurable/occluded box → keep the flag and retry next tick).
    if (managed.revealPendingRepair && !inSynchronizedBlock) {
      if (
        managed.revealPendingGeneration !== undefined &&
        managed.revealPendingGeneration > managed.attachGeneration
      ) {
        // Generation ran backwards (only possible via a fresh instance reusing
        // the id) — the obligation can't belong to this incarnation; drop it.
        managed.revealPendingRepair = false;
        managed.revealPendingGeneration = undefined;
      } else {
        if (heavyBudget <= 0) return 0;
        managed.lastWatchdogRepairAt = now;
        logWarn(
          "[TerminalReconciliationWatchdog] reveal-pending redraw for on-screen terminal — reconciling",
          {
            id,
            revealPendingGeneration: managed.revealPendingGeneration,
            attachGeneration: managed.attachGeneration,
          }
        );
        if (this.deps.reconcileRevealGeometry(id)) {
          // Full click-equivalent: now that geometry is re-fit AND we are not in
          // a synchronized block, also unpause so convergence completes in one
          // tick (resetRenderer reflows too). Safe here — the synchronized guard
          // above is the only mid-block hazard.
          this.unpauseIfNeeded(managed, element);
          managed.revealPendingRepair = false;
          managed.revealPendingGeneration = undefined;
        }
        return 1;
      }
    }

    // Geometry convergence (#10632). An on-screen terminal whose xterm grid
    // (`terminal.cols/rows`) disagrees with what the container can hold
    // (`fitAddon.proposeDimensions()`) is rendering its buffer at the wrong width
    // — the exact "garbled line flow" users see after a warm switch-back, and the
    // failure mode the watchdog previously only DIAGNOSED (DEV log) while
    // excluding agent TUIs entirely. Now repair it for EVERY on-screen terminal,
    // alt-buffer/DEC-2026 agents included, with the atomic alt-buffer-safe
    // reconcile (no mid-block reflow). This is the verifier half: the divergence
    // IS the proof the pane converged wrong, and the watchdog ticks until it
    // matches. Bounded by the heavy-repair budget (== REVEAL_CONCURRENCY) so a
    // grid that all diverges at once never lands as a single long task.
    if (!inSynchronizedBlock) {
      const proposal = managed.fitAddon.proposeDimensions?.();
      if (proposal && proposal.cols > 1 && proposal.rows > 1) {
        const diverged =
          proposal.cols !== managed.terminal.cols || proposal.rows !== managed.terminal.rows;
        if (!diverged) {
          // Converged: the grid now matches what the container can hold. Re-arm the
          // circuit breaker (#10909) so a pane that self-corrected — e.g. a resize
          // moved the container to a reachable width — isn't permanently barred from
          // future repairs. reconcileRevealGeometry's boolean is measurability, not
          // convergence, so this proposeDimensions comparison is the only real signal.
          if (managed.geometryRepairAttempts || managed.geometryRepairGaveUp) {
            managed.geometryRepairAttempts = 0;
            managed.geometryRepairGaveUp = false;
          }
        } else {
          // A fresh incarnation reusing this id must start with a clean counter —
          // the old instance's give-up state can't apply to new geometry (mirrors
          // the revealPendingGeneration guard above).
          if (managed.geometryRepairGeneration !== managed.attachGeneration) {
            managed.geometryRepairGeneration = managed.attachGeneration;
            managed.geometryRepairAttempts = 0;
            managed.geometryRepairGaveUp = false;
          }
          // Breaker tripped: stop re-wrapping this pane's scrollback. Fall through so
          // the cheaper render-pause / WebGL layers below still reconcile — the
          // breaker disables only the expensive geometry repair, not the whole chain.
          // A main-buffer pane that wrote within the reveal quiescence window
          // will have its reconcile deferred by reconcileGeometryFresh's
          // streaming gate (#10863) — that's a deferred tick, not a failed
          // convergence, so don't issue the repair or burn a breaker attempt
          // on it; retry once the stream pauses. Main-buffer only: the gate in
          // reconcileGeometryFresh sits after the alt-buffer early-return, so
          // an alt-buffer reconcile is never deferred by writes. Fall through
          // (not return) so the render-pause / WebGL layers below still run —
          // a streaming pane with a paused renderer needs that unpause.
          const streamingDeferred =
            !managed.isAltBuffer && now - (managed.lastWriteAt ?? 0) < REVEAL_REWRAP_QUIESCENT_MS;
          if (!managed.geometryRepairGaveUp && !streamingDeferred) {
            const attempts = managed.geometryRepairAttempts ?? 0;
            if (attempts >= WATCHDOG_MAX_GEOMETRY_REPAIR_ATTEMPTS) {
              managed.geometryRepairGaveUp = true;
              logWarn(
                "[TerminalReconciliationWatchdog] geometry never converged after repeated repairs — giving up (circuit breaker)",
                {
                  id,
                  attempts,
                  limit: WATCHDOG_MAX_GEOMETRY_REPAIR_ATTEMPTS,
                  xtermCols: managed.terminal.cols,
                  xtermRows: managed.terminal.rows,
                  proposedCols: proposal.cols,
                  proposedRows: proposal.rows,
                  isAltBuffer: managed.isAltBuffer === true,
                }
              );
            } else {
              // Count only issued repairs — a budget-deferred tick wasn't a failed
              // convergence, just an untried one, so the check gates before the bump.
              if (heavyBudget <= 0) return 0;
              managed.geometryRepairAttempts = attempts + 1;
              managed.lastWatchdogRepairAt = now;
              logWarn(
                "[TerminalReconciliationWatchdog] geometry divergence for on-screen terminal — reconciling",
                {
                  id,
                  attempt: managed.geometryRepairAttempts,
                  limit: WATCHDOG_MAX_GEOMETRY_REPAIR_ATTEMPTS,
                  xtermCols: managed.terminal.cols,
                  xtermRows: managed.terminal.rows,
                  proposedCols: proposal.cols,
                  proposedRows: proposal.rows,
                  isAltBuffer: managed.isAltBuffer === true,
                }
              );
              if (this.deps.reconcileRevealGeometry(id)) {
                this.unpauseIfNeeded(managed, element);
              }
              return 1;
            }
          }
        }
      }
    }

    // xterm render service paused on an on-screen terminal — force an IO
    // re-evaluation so a renderer paused while the view was occluded resumes
    // drawing. This now covers alt-buffer agent TUIs too (#10632): the old
    // `!managed.isAltBuffer` exclusion was over-broad — the real hazard is
    // interleaving a paint into an open DEC 2026 synchronized-output block, which
    // `inSynchronizedBlock` already guards. A paused renderer repaints from
    // NOTHING until unpaused, so excluding the very agent TUIs that break was the
    // structural gap behind the recurring switch-back garble.
    if (
      element &&
      element.isConnected &&
      !inSynchronizedBlock &&
      isXtermRenderPaused(managed.terminal)
    ) {
      managed.lastWatchdogRepairAt = now;
      logWarn(
        "[TerminalReconciliationWatchdog] xterm render service paused for on-screen terminal — reflowing",
        { id, isAltBuffer: managed.isAltBuffer === true }
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
   * Unpause a still-paused renderer right after a successful reveal reconcile
   * (#10632). Only called from the reveal-pending / geometry branches, which
   * have already established we are NOT inside a DEC 2026 synchronized-output
   * block — so the reflow can't interleave a paint with a buffered range. This
   * is what makes the watchdog's reveal recovery single-tick (geometry re-fit +
   * unpause together), matching a manual Redraw rather than dribbling the two
   * halves across separate cooldown windows.
   */
  private unpauseIfNeeded(managed: ManagedTerminal, element: HTMLElement | undefined): void {
    if (!element || !element.isConnected) return;
    if (!isXtermRenderPaused(managed.terminal)) return;
    this.deps.forceReflow(element);
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
