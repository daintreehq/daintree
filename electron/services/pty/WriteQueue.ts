import { WRITE_INTERVAL_MS } from "./types.js";
import { chunkInput } from "./terminalInput.js";

export interface WriteQueueOptions {
  /** Raw byte sink for paced chunks. May throw on PTY errors. */
  writeToPty: (data: string) => void;
  /** True once the underlying PTY has exited; aborts pacing and drain waits. */
  isExited: () => boolean;
  /** Current `lastOutputTime` accessor used by `waitForOutputSettle`. */
  lastOutputTime: () => number;
  /** Per-text submit handler — owns all shell-side-effect bookkeeping. */
  performSubmit: (text: string) => Promise<void>;
  /** Optional sink for synchronous PTY write errors. */
  onWriteError?: (error: unknown, context: { operation: string }) => void;
}

export interface OutputSettleOptions {
  debounceMs: number;
  maxWaitMs: number;
  pollMs: number;
}

/**
 * Owns the two write-pacing state machines that used to live inline on
 * `TerminalProcess`:
 *
 * 1. The chunked input queue + interval timer (paces large payloads through
 *    the PTY at `WRITE_INTERVAL_MS` to avoid overwhelming TUI parsers).
 * 2. The submit queue + in-flight guard (serialises async submit jobs so a
 *    second submission cannot interleave its body/Enter writes with an
 *    earlier one's output-settle wait).
 *
 * Shell-capture side effects (`suppressNextShellSubmitSignal`,
 * `markShellCommandSubmitted`, activity-monitor notification) stay in
 * `TerminalProcess`; the queue's job is purely serialisation and pacing.
 */
export class WriteQueue {
  private inputWriteQueue: string[] = [];
  private inputWriteTimeout: NodeJS.Timeout | null = null;
  private submitQueue: string[] = [];
  private submitInFlight = false;
  private disposed = false;

  constructor(private readonly options: WriteQueueOptions) {}

  /**
   * Split `data` into PTY-sized chunks and enqueue for paced delivery. Does
   * nothing after `dispose()`; an empty payload is a no-op.
   */
  enqueueChunked(data: string): void {
    if (this.disposed) return;
    const chunks = chunkInput(data);
    if (chunks.length === 0) return;
    this.inputWriteQueue.push(...chunks);
    this.startWrite();
  }

  /** True while pacing is in flight (queued chunks or pending timer). */
  hasPendingWrites(): boolean {
    return this.inputWriteQueue.length > 0 || this.inputWriteTimeout !== null;
  }

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
   * Resolves once the chunked input queue is fully drained, the PTY has
   * exited, or the queue has been disposed. Polling preserves the existing
   * semantics; the `disposed` check is the teardown termination condition
   * that prevents `performSubmit` from deadlocking when `dispose()` fires
   * mid-drain.
   */
  async waitForInputWriteDrain(): Promise<void> {
    if (!this.hasPendingWrites()) return;
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (this.disposed || this.options.isExited()) {
          resolve();
          return;
        }
        if (!this.hasPendingWrites()) {
          resolve();
          return;
        }
        setTimeout(check, 0);
      };
      check();
    });
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
   * Cancel the pacing timer, drop pending chunks and submits, and mark the
   * queue disposed. Idempotent. Any in-flight `waitForInputWriteDrain` /
   * `waitForOutputSettle` resolves immediately on the next poll because the
   * `disposed` flag short-circuits both loops — without this, an in-flight
   * `performSubmit` mid-`await waitForInputWriteDrain()` would deadlock and
   * leak `submitInFlight`.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.inputWriteTimeout) {
      clearTimeout(this.inputWriteTimeout);
      this.inputWriteTimeout = null;
    }
    this.inputWriteQueue = [];
    this.submitQueue = [];
  }

  private startWrite(): void {
    if (this.disposed) return;
    if (this.inputWriteTimeout !== null || this.inputWriteQueue.length === 0) {
      return;
    }

    this.doWrite();

    if (this.inputWriteQueue.length > 0) {
      this.inputWriteTimeout = setTimeout(() => {
        if (this.disposed) return;
        this.inputWriteTimeout = null;
        this.startWrite();
      }, WRITE_INTERVAL_MS);
    }
  }

  private doWrite(): void {
    if (this.disposed) return;
    if (this.inputWriteQueue.length === 0) return;

    const chunk = this.inputWriteQueue.shift()!;
    if (this.options.isExited()) return;

    try {
      this.options.writeToPty(chunk);
    } catch (error) {
      this.options.onWriteError?.(error, { operation: "write(chunk)" });
    }
  }

  private async drainSubmitQueue(): Promise<void> {
    try {
      while (!this.disposed && this.submitQueue.length > 0) {
        const next = this.submitQueue.shift();
        if (next === undefined) continue;
        try {
          await this.options.performSubmit(next);
        } catch (error) {
          // Don't let a single submit failure abandon the rest of the queue
          // or escape as an unhandled rejection from the void caller above.
          this.options.onWriteError?.(error, { operation: "performSubmit" });
        }
      }
    } finally {
      this.submitInFlight = false;
    }
  }
}
