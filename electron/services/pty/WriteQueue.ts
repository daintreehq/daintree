import type { TerminalSubmitStatusState } from "../../../shared/types/pty-host.js";
import {
  MAX_RETAINED_SUBMISSIONS,
  type TerminalSubmissionPhase,
  type TerminalSubmissionRecord,
} from "../../../shared/types/terminalSubmission.js";

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

/**
 * Handed to `performSubmit` so it can report the one thing the queue cannot
 * observe from the outside: that the trailing Enter reached node-pty (#12337).
 *
 * A resolved `performSubmit` is NOT that signal — it also resolves on every
 * path that abandons the Enter (shutdown lock, superseding generation, a pty
 * that vanished mid-submit), which is exactly the silent loss this tracking
 * exists to surface.
 */
export interface SubmitExecutionContext {
  /**
   * Stamp the tracked submission `pty_written`. Called synchronously the
   * instant the final write returns, not after the await unwinds: a
   * cancellation landing in that gap would otherwise overwrite a hand-off that
   * genuinely happened. Idempotent, and a no-op for an untracked submit.
   */
  markPtyWritten: () => void;
}

/** One queued submission plus the caller's optional correlation token. */
interface SubmitJob {
  text: string;
  token?: string;
}

export interface WriteQueueOptions {
  /** True once the underlying PTY has exited; aborts the output-settle wait. */
  isExited: () => boolean;
  /** Current `lastOutputTime` accessor used by `waitForOutputSettle`. */
  lastOutputTime: () => number;
  /** Per-text submit handler — owns all shell-side-effect bookkeeping. */
  performSubmit: (text: string, ctx: SubmitExecutionContext) => Promise<void>;
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
  private submitQueue: SubmitJob[] = [];
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
  /**
   * Tokened submissions that have not reached a final phase — one queued or
   * in-flight entry per token (#12337). Kept separate from the finalised ring
   * so a burst of queued work can never evict a record that has not been
   * answered yet.
   */
  private readonly pendingSubmissions = new Map<string, TerminalSubmissionRecord>();
  /**
   * Finalised outcomes, oldest first, capped at MAX_RETAINED_SUBMISSIONS.
   * Only tokened submits land here, so in-app typing and fleet broadcast
   * (which pass no token) cost nothing.
   */
  private readonly finalizedSubmissions: TerminalSubmissionRecord[] = [];

  constructor(private readonly options: WriteQueueOptions) {}

  /**
   * Serialise an async submit. The first caller wins the in-flight slot and
   * runs `options.performSubmit(text)`; subsequent calls queue behind it and
   * drain in FIFO order. The in-flight flag is set synchronously before the
   * first await so two callers cannot both pass the guard.
   */
  submit(text: string, token?: string): void {
    if (this.disposed) {
      // A tracked submit into a disposed queue is answered rather than
      // forgotten: `cancelled` says Daintree dropped it, where silence would
      // read back as `unknown` and leave the caller unable to tell a dropped
      // submission from one this incarnation never saw.
      if (token !== undefined) this.noteRejectedSubmission(token);
      return;
    }
    // A token already in flight keeps its own record: overwriting would push a
    // live `writing` back to `queued` and answer the earlier submission with
    // the later one's phase.
    //
    // A token names ONE submission. `sendCommand` mints a fresh UUID per call,
    // so reuse only reaches here through a direct IPC caller, and it is that
    // caller's error. The text is still submitted either way; only the record
    // is ambiguous — reuse after the first finished replaces the record
    // (`retainFinalized` keeps one per token), while reuse mid-flight leaves it
    // describing the submission already writing. Refusing to queue the second
    // would be worse: that silently drops text the caller asked to send.
    if (token !== undefined && !this.pendingSubmissions.has(token)) {
      this.pendingSubmissions.set(token, { token, phase: "queued", at: Date.now() });
    }
    this.submitQueue.push({ text, token });
    if (this.submitInFlight) return;
    this.submitInFlight = true;
    void this.drainSubmitQueue();
  }

  /**
   * Look up one submission by the token its caller minted. Pending entries win
   * over finalised ones — a token cannot be in both — and a copy is returned so
   * a reader cannot mutate the ledger.
   *
   * `undefined` means this incarnation holds no record: never accepted here,
   * aged out of the retained window, or lost to a pty-host restart. The read
   * surface reports that as `unknown` rather than inventing an outcome.
   */
  getSubmission(token: string): TerminalSubmissionRecord | undefined {
    const pending = this.pendingSubmissions.get(token);
    if (pending !== undefined) return { ...pending };
    const finalized = this.finalizedSubmissions.find((record) => record.token === token);
    return finalized === undefined ? undefined : { ...finalized };
  }

  /**
   * Record a tracked submission that was refused before it reached the lane —
   * an input-locked or already-exited terminal. Without it the caller would
   * read `unknown`, which says "no record here" and cannot be told apart from
   * a token this incarnation never saw.
   */
  noteRejectedSubmission(token: string): void {
    if (this.pendingSubmissions.has(token)) {
      this.finalizeIfPending(token, "cancelled");
      return;
    }
    if (this.finalizedSubmissions.some((record) => record.token === token)) return;
    this.retainFinalized(token, "cancelled");
  }

  /** Advance a still-pending submission. No-op once it has been finalised. */
  private advanceSubmission(token: string, phase: TerminalSubmissionPhase): void {
    const record = this.pendingSubmissions.get(token);
    if (record === undefined) return;
    record.phase = phase;
    record.at = Date.now();
  }

  /**
   * Move a submission to its final phase, but ONLY while it is still pending.
   *
   * Pending membership is the whole guard, and it has to be, because the
   * retained ring is not a reliable record of what has already finished. A
   * submission that completed can be evicted by 32 later ones before its own
   * drain continuation resumes; checking the ring would then find nothing and
   * happily write a second, contradicting outcome — reporting a delivered
   * submission as `cancelled`. Deleting from the pending map is the one
   * operation that can only succeed once.
   */
  private finalizeIfPending(token: string, phase: TerminalSubmissionPhase): void {
    if (this.pendingSubmissions.delete(token) === false) return;
    this.retainFinalized(token, phase);
  }

  /**
   * Append to the retained ring, keeping at most one record per token so a
   * reused token cannot leave two answers behind for `getSubmission` to pick
   * the wrong one of.
   */
  private retainFinalized(token: string, phase: TerminalSubmissionPhase): void {
    const existing = this.finalizedSubmissions.findIndex((record) => record.token === token);
    if (existing !== -1) this.finalizedSubmissions.splice(existing, 1);
    this.finalizedSubmissions.push({ token, phase, at: Date.now() });
    while (this.finalizedSubmissions.length > MAX_RETAINED_SUBMISSIONS) {
      this.finalizedSubmissions.shift();
    }
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
      const now = Date.now();
      const settleFrom = Math.max(startWait, this.options.lastOutputTime());
      const timeSinceOutput = now - settleFrom;
      if (timeSinceOutput >= opts.debounceMs) return;
      const timeSinceStart = now - startWait;
      if (timeSinceStart >= opts.maxWaitMs) return;
      const nextPollMs = Math.min(
        opts.pollMs,
        opts.debounceMs - timeSinceOutput,
        opts.maxWaitMs - timeSinceStart
      );
      await new Promise((r) => setTimeout(r, nextPollMs));
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
   * problem the user can do nothing about. If a status was already reported,
   * it is retracted in the same breath — dropping the timer without a closing
   * event would strand the pill or banner on a submit nothing is tracking any
   * more.
   *
   * Note this cannot recall bytes already handed to node-pty — its own write
   * queue owns them. What it stops is everything Daintree has not yet written.
   */
  cancelPendingInput(): void {
    if (this.disposed) return;
    this.discardQueuedSubmissions();
    this.clearSubmitStatusTimer();
    if (this.submitStatusReported) {
      this.submitStatusReported = false;
      this.emitSubmitStatus("settled");
    }
  }

  /**
   * Drop pending submits, stop threshold reporting, and mark the queue
   * disposed. Idempotent. Any in-flight `waitForOutputSettle` resolves on its
   * next poll because the `disposed` flag short-circuits the loop — without
   * this, an in-flight `performSubmit` mid-settle would deadlock and leak
   * `submitInFlight`.
   *
   * This stops the slow/stalled TIMERS, not the terminal event: a submit still
   * running at dispose will emit its `settled`/`failed` when it unwinds. That
   * is deliberate — the closing event is what clears the renderer, so
   * suppressing it would be the one way to strand a pill. `PtyManager` drops
   * events from a superseded incarnation, so a late one cannot land on a
   * restarted terminal.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.discardQueuedSubmissions();
    this.clearSubmitStatusTimer();
  }

  /**
   * Drop everything still queued, recording each tracked entry as `cancelled`.
   *
   * Only the QUEUE is drained — the in-flight submit is deliberately left to
   * the drain loop, which is the only place that knows whether its trailing
   * Enter got out. Finalising it here would report `cancelled` for a submission
   * that had already reached the pty.
   */
  private discardQueuedSubmissions(): void {
    const queued = this.submitQueue;
    this.submitQueue = [];
    for (const job of queued) {
      if (job.token !== undefined) this.finalizeIfPending(job.token, "cancelled");
    }
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

  /**
   * `startedAt` is captured by the caller before `performSubmit` runs, so the
   * escalation lands at SUBMIT_STALLED_THRESHOLD_MS measured from the submit's
   * actual start. Re-arming for a fixed remainder instead would drift: if a
   * blocked event loop delayed the slow callback, "stalled" would fire that
   * much late on top.
   */
  private armSlowSubmitReporting(startedAt: number): void {
    this.armSubmitStatusTimer(SUBMIT_SLOW_THRESHOLD_MS, () => {
      this.submitStatusReported = true;
      this.emitSubmitStatus("slow");
      const remaining = Math.max(0, startedAt + SUBMIT_STALLED_THRESHOLD_MS - Date.now());
      this.armSubmitStatusTimer(remaining, () => {
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
        const token = next.token;
        if (token !== undefined) this.advanceSubmission(token, "writing");
        try {
          // Await the submit itself — never a race against the timer. The timer
          // reports; it does not release the lane (#11875).
          const startedAt = Date.now();
          const work = this.options.performSubmit(next.text, {
            markPtyWritten: () => {
              if (token !== undefined) this.finalizeIfPending(token, "pty_written");
            },
          });
          this.armSlowSubmitReporting(startedAt);
          await work;
          if (this.submitStatusReported) {
            this.emitSubmitStatus("settled");
          }
          // Resolving proves nothing on its own: performSubmit returns normally
          // from every path that abandons the Enter. Still pending here means
          // `markPtyWritten` never fired, so the submission was dropped rather
          // than handed over (#12337).
          if (token !== undefined) this.finalizeIfPending(token, "cancelled");
        } catch (error) {
          // A rejected submit is over — it will never write again — so the lane
          // drains normally and the exclusive-ownership invariant still holds.
          // It still surfaces, because the body may already be sitting in the
          // composer with no Enter behind it.
          this.emitSubmitStatus("failed");
          if (token !== undefined) this.finalizeIfPending(token, "failed");
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
