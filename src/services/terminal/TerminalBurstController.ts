import type { ManagedTerminal } from "./types";
import { WRITE_BURST_DECAY_MS } from "./types";
import { TerminalRefreshTier } from "@/types";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

// BURST-tier hold after a wheel scroll before reverting to the computed tier —
// matches the keystroke input-burst decay so a scroll feels just as responsive.
const WHEEL_BURST_DECAY_MS = 1000;

// Background-drain hold window for a pending keystroke echo. An echo normally
// lands within a frame or two; the cap only bounds the hold when no echo comes
// back at all (wedged pty, remote shell lag) so sibling drains can't starve.
const ECHO_PENDING_HOLD_MAX_MS = 150;

// Interactive resource-profile override (symptom B): while actively scrolling a
// full-screen TUI, ask the main process to hold the profile off efficiency.
// DURATION must exceed THROTTLE so re-requests overlap and the hold never lapses
// mid-scroll; both are short so the hold self-expires soon after scrolling stops.
const INTERACTIVE_OVERRIDE_DURATION_MS = 1500;
const INTERACTIVE_OVERRIDE_THROTTLE_MS = 500;

export interface TerminalBurstControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  applyRendererPolicy: (id: string, tier: TerminalRefreshTier) => void;
}

/**
 * Owns the wheel-scroll and write-driven BURST-tier boosts, plus the
 * interactive resource-profile override IPC throttle.
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
  // Throttle for the interactive resource-profile override IPC (see onActiveWheel).
  private lastInteractiveOverrideRequestAt = 0;
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
   * until the TUI's own redraw output happens to bump the tier. We (1) lift the
   * renderer to BURST (60fps) for the scroll — reusing the input-burst decay
   * timer, since a scroll wants the same ~1s revert as a keystroke — and (2) ask
   * the main process to hold the resource profile at ≥ balanced, so efficiency
   * mode's stretched port-batch delay (40ms vs 16ms) can't throttle the
   * returned-redraw stream mid-scroll ("gets slow and stays slow", symptom B).
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

    this.requestInteractiveProfileOverride();
  }

  /**
   * Ordinary scrollback wheel/key scrolling (not mouse-reporting forwarding).
   * Holds the resource profile off efficiency for the same reason as
   * `onActiveWheel` — a profile downgrade mid-scroll drops the WebGL upper
   * threshold and can force the visible terminal onto the DOM renderer right
   * as the user is scrolling it (#10858). Unlike `onActiveWheel`, plain
   * scrollback is client-side xterm rendering with no PTY round-trip per
   * line, so there's no renderer-tier boost to apply here.
   */
  onUserScrollIntent(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    this.requestInteractiveProfileOverride();
  }

  /**
   * Fire-and-forget request that the main process keep the resource profile off
   * efficiency while the user is actively scrolling. Throttled hard because a
   * trackpad momentum stream calls this dozens of times/sec; the override window
   * (INTERACTIVE_OVERRIDE_DURATION_MS) is longer than the throttle so the hold
   * never lapses between requests, and self-expires shortly after scrolling stops.
   */
  private requestInteractiveProfileOverride(): void {
    const now = Date.now();
    if (now - this.lastInteractiveOverrideRequestAt < INTERACTIVE_OVERRIDE_THROTTLE_MS) return;
    this.lastInteractiveOverrideRequestAt = now;
    try {
      // safeFireAndForget swallows the ASYNC rejection (channel skew during a
      // reload, future validation), which a bare synchronous try/catch around a
      // Promise-returning IPC call would miss; the try/catch still guards a
      // synchronous throw if `window.electron.system` is absent. Either way the
      // renderer-side BURST boost above already applied — this is non-critical.
      safeFireAndForget(
        window.electron.system.requestInteractiveOverride(INTERACTIVE_OVERRIDE_DURATION_MS),
        { context: "terminal.requestInteractiveProfileOverride" }
      );
    } catch {
      // window.electron.system unavailable — non-critical.
    }
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
