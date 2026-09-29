import type { ManagedTerminal } from "./types";
import { WRITE_BURST_DECAY_MS } from "./types";
import { TerminalRefreshTier } from "@/types";

// BURST-tier hold after a wheel scroll before reverting to the computed tier —
// matches the keystroke input-burst decay so a scroll feels just as responsive.
const WHEEL_BURST_DECAY_MS = 1000;

// Background-drain hold window for a pending keystroke echo. An echo normally
// lands within a frame or two; the cap only bounds the hold when no echo comes
// back at all (wedged pty, remote shell lag) so sibling drains can't starve.
const ECHO_PENDING_HOLD_MAX_MS = 150;

export interface TerminalBurstControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  applyRendererPolicy: (id: string, tier: TerminalRefreshTier) => void;
  /**
   * Whether nobody can see this view — cached (#12514) or its window hidden
   * (#12798). Output there earns no burst.
   */
  isViewSuppressed?: () => boolean;
  // Keep this pane's existing WebGL context through a DOM-mode flip while it
  // is being scrolled (TerminalWebGLManager.holdForScroll).
  holdWebGLForScroll: (id: string, durationMs: number) => void;
}

/**
 * Owns the wheel-scroll and write-driven BURST-tier boosts, plus the
 * per-terminal WebGL scroll hold.
 *
 * Every boost here is scoped to the terminal being interacted with. Scrolling
 * used to ask the main process to lift the global resource profile off
 * efficiency, and with the pressure score unchanged each lift was followed by a
 * full transition back — freeze/thaw of every cached view, host reconfiguration,
 * worker trims — per scroll burst (#12518).
 */
export class TerminalBurstController {
  // Every terminal with a live alt-buffer wheel gesture (id → last wheel
  // wall-clock), pruned lazily against the decay window. A Map rather than a
  // single last-wheeled slot: scrolling several mouse-reporting TUIs at once
  // (split panes, fleet review) must not let each pane's wheel put the OTHER
  // actively-scrolled panes' redraw streams on the background-drain hold —
  // that serializes the very gestures the hold exists to protect. Uses the
  // same decay window as the BURST tier so "gesture over" is one consistent
  // notion across the renderer.
  private activeWheelAt = new Map<string, number>();
  // Keystroke-echo round trip in flight: input left for the PTY and its echo
  // has not been delivered yet. While set (bounded by ECHO_PENDING_HOLD_MAX_MS),
  // the ingest service holds background drains so the echo's port delivery,
  // parse, and render aren't queued behind sibling parse slices (#10948-class
  // "focused terminal stops responding under load" regressions).
  private echoPendingId: string | null = null;
  private echoPendingAt = 0;
  private echoPendingGen = 0;

  constructor(private deps: TerminalBurstControllerDeps) {}

  /** Keyboard input left for this terminal's PTY — arm the echo-pending hold. */
  onEchoPendingInput(id: string): void {
    this.echoPendingId = id;
    this.echoPendingAt = Date.now();
    this.echoPendingGen++;
  }

  /**
   * Data arrived for the echo-pending terminal. Release siblings one frame
   * later so the echo's own render gets scheduled ahead of the backlog their
   * drains are about to enqueue. The generation guard keeps a release scheduled
   * for keystroke N from clearing a hold re-armed by keystroke N+1.
   */
  onEchoData(id: string): void {
    if (this.echoPendingId !== id) return;
    const gen = this.echoPendingGen;
    requestAnimationFrame(() => {
      if (this.echoPendingGen === gen && this.echoPendingId === id) {
        this.echoPendingId = null;
      }
    });
  }

  // Which terminal has a keystroke echo in flight (bounded by
  // ECHO_PENDING_HOLD_MAX_MS), for the ingest service's background-drain hold.
  getEchoPendingHoldId(): string | null {
    return this.echoPendingId !== null && Date.now() - this.echoPendingAt < ECHO_PENDING_HOLD_MAX_MS
      ? this.echoPendingId
      : null;
  }

  // Whether ANY wheel-driven BURST gesture is still within its decay window.
  // Consumed by the ingest data buffer to decide that a background-drain hold
  // regime is in effect at all.
  hasActiveWheelGesture(): boolean {
    const now = Date.now();
    for (const [id, at] of this.activeWheelAt) {
      if (now - at < WHEEL_BURST_DECAY_MS) return true;
      this.activeWheelAt.delete(id);
    }
    return false;
  }

  // Whether THIS terminal has a live wheel gesture — a hold participant whose
  // own redraw stream must drain inline (holding it would stall the gesture).
  isWheelActive(id: string): boolean {
    const at = this.activeWheelAt.get(id);
    if (at === undefined) return false;
    if (Date.now() - at >= WHEEL_BURST_DECAY_MS) {
      this.activeWheelAt.delete(id);
      return false;
    }
    return true;
  }

  /**
   * Active wheel scroll in a focused full-screen mouse-reporting TUI. Scrolling
   * such a TUI is an app-owned PTY round-trip per line, and a focused-but-idle
   * pane sits at FOCUSED (10fps): without this the first flick repaints slowly
   * until the TUI's own redraw output happens to bump the tier. We lift the
   * renderer to BURST (60fps) for the scroll — reusing the input-burst decay
   * timer, since a scroll wants the same ~1s revert as a keystroke.
   *
   * The other two halves need nothing from here. The wheel reports are PTY
   * input, so the pty-host's recent-input batch window already keeps this
   * terminal's redraws off efficiency's stretched 40ms batch delay; and a
   * mouse-reporting TUI runs in the alt buffer, whose WebGL pin outlasts any
   * DOM-mode flip.
   */
  onActiveWheel(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    this.activeWheelAt.set(id, Date.now());

    this.deps.applyRendererPolicy(id, TerminalRefreshTier.BURST);
    if (managed.inputBurstTimer !== undefined) {
      clearTimeout(managed.inputBurstTimer);
    }
    managed.inputBurstTimer = window.setTimeout(() => {
      const current = this.deps.getInstance(id);
      if (!current) return;
      current.inputBurstTimer = undefined;
      this.deps.applyRendererPolicy(id, current.getRefreshTier());
    }, WHEEL_BURST_DECAY_MS);
  }

  /**
   * Ordinary scrollback wheel/key scrolling (not mouse-reporting forwarding).
   * A WebGL-threshold drop mid-scroll — a genuine profile downgrade, another
   * pane becoming visible — can force the scrolled terminal onto the DOM
   * renderer right under the user's wheel (#10858), so hold its current
   * context until the gesture is over. Plain scrollback is client-side xterm
   * rendering with no PTY round-trip per line, so there's no renderer-tier
   * boost to apply here.
   */
  onUserScrollIntent(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    this.deps.holdWebGLForScroll(id, WHEEL_BURST_DECAY_MS);
  }

  /**
   * Write-driven BURST tier: each PTY write extends the burst window in O(1)
   * by bumping `writeBurstDeadline`. A single self-rearming timer handles
   * decay — it re-checks the deadline on fire and either reschedules for the
   * remaining time (if a write extended the window while it was pending) or
   * reverts the tier via the panel's current `getRefreshTier()`.
   *
   * Avoiding per-write clearTimeout/setTimeout matters: at 60fps+ output the
   * naive pattern thrashes Chromium's timer queue and produces GC pressure.
   *
   * `applyRendererPolicy(BURST)` is called on every write: when BURST is
   * already applied the policy returns early (line 50 of
   * TerminalRendererPolicy) and as a load-bearing side-effect clears any
   * pending tierChangeTimer — that cancellation is what prevents a
   * concurrent focus-loss-scheduled downgrade from firing unopposed and
   * stranding the terminal at FOCUSED/VISIBLE/BACKGROUND mid-stream.
   */
  onPtyWrite(id: string): void {
    // A streaming agent nobody can see would otherwise re-request BURST and
    // re-arm the decay timer on every chunk, only for the policy to clamp it.
    if (this.deps.isViewSuppressed?.() === true) return;
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    managed.writeBurstDeadline = Date.now() + WRITE_BURST_DECAY_MS;
    this.deps.applyRendererPolicy(id, TerminalRefreshTier.BURST);

    if (managed.writeBurstTimer === undefined) {
      this.scheduleWriteBurstDecay(id, WRITE_BURST_DECAY_MS);
    }
  }

  private scheduleWriteBurstDecay(id: string, delayMs: number): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;
    managed.writeBurstTimer = window.setTimeout(() => {
      const current = this.deps.getInstance(id);
      if (!current) return;
      current.writeBurstTimer = undefined;
      const deadline = current.writeBurstDeadline;
      const nowFire = Date.now();
      if (deadline !== undefined && nowFire < deadline) {
        this.scheduleWriteBurstDecay(id, deadline - nowFire);
        return;
      }
      current.writeBurstDeadline = undefined;
      this.deps.applyRendererPolicy(id, current.getRefreshTier());
    }, delayMs);
  }

  // Clears the wheel-burst and write-burst timers for a destroyed terminal.
  // Called from `TerminalInstanceService.destroy()`.
  destroy(id: string): void {
    this.activeWheelAt.delete(id);
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    if (managed.inputBurstTimer !== undefined) {
      clearTimeout(managed.inputBurstTimer);
      managed.inputBurstTimer = undefined;
    }
    if (managed.writeBurstTimer !== undefined) {
      clearTimeout(managed.writeBurstTimer);
      managed.writeBurstTimer = undefined;
    }
    managed.writeBurstDeadline = undefined;
  }
}
