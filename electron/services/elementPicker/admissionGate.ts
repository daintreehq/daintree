import { ElementPickerHostError } from "./errors.js";

/**
 * Resolves running at once, across every workspace. Each holds a job in the
 * host and its reads in main; a few at a time keeps selections responsive
 * without letting a burst of them queue up parses nobody will wait for.
 */
export const MAX_CONCURRENT_RESOLVES = 4;

/**
 * Resolves waiting for a slot. Past this the request is refused rather than
 * queued: a queue that grows faster than it drains only serves answers to
 * selections the user has already moved on from.
 */
export const MAX_QUEUED_RESOLVES = 32;

export interface AdmissionLimits {
  concurrent: number;
  queued: number;
}

/** Bounds how much work runs at once; a waiter whose signal aborts leaves the queue. */
export class AdmissionGate {
  private running = 0;
  private readonly waiting: Array<{ resolve: () => void; reject: (reason: unknown) => void }> = [];

  constructor(
    private readonly limits: AdmissionLimits = {
      concurrent: MAX_CONCURRENT_RESOLVES,
      queued: MAX_QUEUED_RESOLVES,
    }
  ) {}

  /** Resolves with the release for the slot it took. */
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.running < this.limits.concurrent) {
      this.running += 1;
      return this.releaser();
    }
    if (this.waiting.length >= this.limits.queued) {
      throw new ElementPickerHostError("HOST_BUSY", "too many requests are already queued");
    }
    // The waiter inherits the slot the releasing resolve held, so `running`
    // never dips between the two and a fresh caller cannot slip in past the cap.
    let detach: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const waiter = { resolve, reject };
        this.waiting.push(waiter);
        const onAbort = () => {
          const index = this.waiting.indexOf(waiter);
          if (index === -1) return;
          this.waiting.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detach = () => signal.removeEventListener("abort", onAbort);
      });
    } finally {
      detach?.();
    }
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        next.resolve();
        return;
      }
      this.running -= 1;
    };
  }
}
