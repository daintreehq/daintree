import type { TerminalSubmitStatusState } from "../../../shared/types/pty-host.js";

/**
 * How long one submit may hold the composer before we say so. Reporting only —
 * the submit keeps the lane (see {@link WriteQueue}).
 */
const SUBMIT_SLOW_THRESHOLD_MS = 3000;

/**
 * Total in-flight time after which a submit is treated as stuck rather than
 * merely slow, and the renderer escalates from an ambient pill to a banner
 * with a recovery action.
 */
const SUBMIT_STALLED_THRESHOLD_MS = 30000;

export interface WriteQueueOptions {
  /** True once the underlying PTY has exited; aborts the output-settle wait. */
  isExited: () => boolean;
  /** Current `lastOutputTime` accessor used by `waitForOutputSettle`. */
  lastOutputTime: () => number;
  /** Per-text submit handler — owns all shell-side-effect bookkeeping. */
  performSubmit: (text: string) => Promise<void>;
  /** Optional sink for synchronous PTY write errors. */
  onWriteError?: (error: unknown, context: { operation: string }) => void;
  /**
   * Optional sink for submit-lane status transitions (#11875). Only called for
   * submits that cross a threshold or fail; a normal fast submit reports
   * nothing. Must not throw — it is invoked from a timer callback.
   */
  onSubmitStatus?: (state: TerminalSubmitStatusState) => void;
}

export interface OutputSettleOptions {
  debounceMs: number;
  maxWaitMs: number;
  pollMs: number;
}

/**
 * Serialises async submit jobs against one terminal so a second submission
 * cannot interleave its body/Enter writes with an earlier one's output-settle
 * wait.
 *
 * The invariant is composer ownership, not byte pacing: `performSubmit` writes
 * its body before its first await, so from that moment the agent's composer
 * holds text that cannot be withdrawn. Whatever happens next, the next submit
 * must not write until the current one is done — otherwise the second body
 * appends to the first and a single Enter submits both as one merged prompt.
 *
 * This is why the slow-submit timer is report-only. It used to be a
 * `Promise.race`, which released the in-flight slot when it fired but did
 * nothing to stop the writer, so the abandoned submit's trailing Enter landed
 * after the next submit's body (#11875). A submit that never settles now
 * blocks that terminal's submit lane, and that is the correct trade: starting
 * the next submit is the unsafe action, and there is no rollback for bytes
 * already in a composer.
 *
 * Byte-level pacing used to live here too — a 50-byte chunk queue on a 5ms
 * interval, copied from VS Code as a workaround for microsoft/vscode#38137, a
 * race writing to the FD. node-pty fixed that upstream in microsoft/node-pty#831
 * and VS Code deleted its throttle two days later (microsoft/vscode#283065);
 * node-pty now runs its own FIFO write queue against the raw fd and reschedules
 * on EAGAIN. We pin 1.2.0-beta.14, which carries the fix, so the pacing was
 * deleted rather than retuned. Writes go straight to `ptyProcess.write()`.
 *
 * Shell-capture side effects (`suppressNextShellSubmitSignal`,
 * `markShellCommandSubmitted`, activity-monitor notification) stay in
 * `TerminalProcess`; the queue's job is purely serialisation.
 */
export class WriteQueue {
  private submitQueue: string[] = [];
  private submitInFlight = false;
  private disposed = false;
  /**
   * At most one submit is ever in flight, so a single handle is enough. It is
   * re-armed rather than paired with a second timer so escalation lands at
   * SUBMIT_STALLED_THRESHOLD_MS total, not slow+stalled.
   */
  private submitStatusTimer: NodeJS.Timeout | undefined;
  /** Whether the current submit has already reported slow/stalled — decides
   *  whether its completion is worth a `settled` event. */
  private submitStatusReported = false;

  constructor(private readonly options: WriteQueueOptions) {}

  /**
   * Serialise an async submit. The first caller wins the in-flight slot and
   * runs `options.performSubmit(text)`; subsequent calls queue behind it and
   * drain in FIFO order. The in-flight flag is set synchronously before the
   * first await so two callers cannot both pass the guard.
   */
  submit(text: string): void {
    if (this.disposed) return;
    this.submitQueue.push(text);
    if (this.submitInFlight) return;
    this.submitInFlight = true;
    void this.drainSubmitQueue();
  }

  /**
   * Wait for PTY output to fall idle for `debounceMs` (used by the submit
   * path on terminals without bracketed-paste support so the pre-Enter
   * payload has time to render before Enter fires). Bounded by `maxWaitMs`.
   */
  async waitForOutputSettle(opts: OutputSettleOptions): Promise<void> {
    const startWait = Date.now();
    while (true) {
      if (this.disposed || this.options.isExited()) return;
      const settleFrom = Math.max(startWait, this.options.lastOutputTime());
      const timeSinceOutput = Date.now() - settleFrom;
      if (timeSinceOutput >= opts.debounceMs) return;
      if (Date.now() - startWait > opts.maxWaitMs) return;
      await new Promise((r) => setTimeout(r, opts.pollMs));
    }
  }

  /**
   * Drop everything queued and stop reporting on the in-flight submit, WITHOUT
   * disposing: the queue stays usable afterwards. The reusable half of
   * {@link dispose}, added for the graceful-shutdown input lock (#11851).
   *
   * `submitInFlight` is deliberately left alone. It is owned by the running
   * `drainSubmitQueue` loop, which clears it in its own `finally`; forcing it
   * false here would let a second submit start while the first is still
   * awaiting, which is the exact interleaving the flag exists to prevent.
   * Draining the queue is enough — the in-flight submit finds nothing left to
   * do, and `TerminalInputController`'s generation check stops it writing.
   *
   * The status timer is cleared because the caller is tearing this terminal's
   * input down: escalating a submit to "stalled" mid-shutdown would report a
   * problem the user can do nothing about.
   *
   * Note this cannot recall bytes already handed to node-pty — its own write
   * queue owns them. What it stops is everything Daintree has not yet written.
   */
  cancelPendingInput(): void {
    if (this.disposed) return;
    this.submitQueue = [];
    this.clearSubmitStatusTimer();
  }

  /**
   * Drop pending submits, stop status reporting, and mark the queue disposed.
   * Idempotent. Any in-flight `waitForOutputSettle` resolves on its next poll
   * because the `disposed` flag short-circuits the loop — without this, an
   * in-flight `performSubmit` mid-settle would deadlock and leak
   * `submitInFlight`.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.submitQueue = [];
    this.clearSubmitStatusTimer();
  }

  /** Deliver a status transition without letting a throwing sink escape into a
   *  timer callback and take down the pty-host. */
  private emitSubmitStatus(state: TerminalSubmitStatusState): void {
    try {
      this.options.onSubmitStatus?.(state);
    } catch {
      // Reporting is best-effort; the submit itself is unaffected.
    }
  }

  private clearSubmitStatusTimer(): void {
    if (this.submitStatusTimer !== undefined) {
      clearTimeout(this.submitStatusTimer);
      this.submitStatusTimer = undefined;
    }
  }

  /**
   * Arm the single status handle. `unref()` keeps a slow submit from holding
   * the pty-host UtilityProcess open on its own, and the identity check makes a
   * timer that fires after being superseded (or after dispose) a no-op.
   */
  private armSubmitStatusTimer(delayMs: number, onFire: () => void): void {
    const timer = setTimeout(() => {
      if (this.disposed || this.submitStatusTimer !== timer) return;
      this.submitStatusTimer = undefined;
      onFire();
    }, delayMs);
    timer.unref?.();
    this.submitStatusTimer = timer;
  }

  private armSlowSubmitReporting(): void {
    this.armSubmitStatusTimer(SUBMIT_SLOW_THRESHOLD_MS, () => {
      this.submitStatusReported = true;
      this.emitSubmitStatus("slow");
      // Remainder of the window, not another full one: escalation belongs at
      // SUBMIT_STALLED_THRESHOLD_MS total.
      this.armSubmitStatusTimer(SUBMIT_STALLED_THRESHOLD_MS - SUBMIT_SLOW_THRESHOLD_MS, () => {
        this.emitSubmitStatus("stalled");
      });
    });
  }

  private async drainSubmitQueue(): Promise<void> {
    try {
      while (!this.disposed && this.submitQueue.length > 0) {
        const next = this.submitQueue.shift();
        if (next === undefined) continue;
        this.submitStatusReported = false;
        try {
          // Await the submit itself — never a race against the timer. The timer
          // reports; it does not release the lane (#11875).
          const work = this.options.performSubmit(next);
          this.armSlowSubmitReporting();
          await work;
          if (this.submitStatusReported) {
            this.emitSubmitStatus("settled");
          }
        } catch (error) {
          // A rejected submit is over — it will never write again — so the lane
          // drains normally and the exclusive-ownership invariant still holds.
          // It still surfaces, because the body may already be sitting in the
          // composer with no Enter behind it.
          this.emitSubmitStatus("failed");
          this.options.onWriteError?.(error, { operation: "performSubmit" });
        } finally {
          this.clearSubmitStatusTimer();
        }
      }
    } finally {
      this.submitInFlight = false;
    }
  }
}
