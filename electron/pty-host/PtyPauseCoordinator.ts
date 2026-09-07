export type PauseToken =
  | "resource-governor"
  | "backpressure"
  | "ipc-queue"
  | "port-queue"
  | `port-queue-${number}`
  // Dedicated worker-ingest queue for one (window, terminal) pair (#10960).
  | `port-queue-worker-${number}-${string}`
  | "system-sleep";

export class PtyPauseCoordinator {
  private readonly holds = new Set<PauseToken>();

  constructor(
    private readonly raw: {
      pause: () => void;
      resume: () => void;
    }
  ) {}

  pause(token: PauseToken): void {
    const wasEmpty = this.holds.size === 0;
    this.holds.add(token);
    if (wasEmpty) {
      try {
        this.raw.pause();
      } catch {
        // PTY process may already be dead
      }
    }
  }

  resume(token: PauseToken): boolean {
    if (!this.holds.delete(token) || this.holds.size !== 0) return false;
    try {
      this.raw.resume();
    } catch {
      // PTY process may already be dead
    }
    return true;
  }

  forceReleaseAll(): void {
    if (this.holds.size === 0) return;
    this.holds.clear();
    try {
      this.raw.resume();
    } catch {
      // PTY process may already be dead
    }
  }

  get isPaused(): boolean {
    return this.holds.size > 0;
  }

  get heldTokens(): ReadonlySet<PauseToken> {
    return this.holds;
  }

  hasToken(token: PauseToken): boolean {
    return this.holds.has(token);
  }

  // True when any backpressure-class hold is active: the live queue tokens
  // ("ipc-queue", "port-queue", "port-queue-${windowId}") or the FUTURE_SAB
  // "backpressure" token.
  hasAnyBackpressureToken(): boolean {
    for (const token of this.holds) {
      if (token === "ipc-queue" || token === "backpressure" || token.startsWith("port-queue")) {
        return true;
      }
    }
    return false;
  }
}
