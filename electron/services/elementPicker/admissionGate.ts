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

/** Bounds how many resolves run at once; a waiter whose signal aborts leaves the queue. */
export class AdmissionGate {
  private running = 0;
  private readonly waiting: Array<{ resolve: () => void; reject: (reason: unknown) => void }> = [];

  /** Resolves with the release for the slot it took. */
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.running < MAX_CONCURRENT_RESOLVES) {
      this.running += 1;
      return this.releaser();
    }
    if (this.waiting.length >= MAX_QUEUED_RESOLVES) {
      throw new ElementPickerHostError("HOST_BUSY", "too many resolves are already queued");
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
