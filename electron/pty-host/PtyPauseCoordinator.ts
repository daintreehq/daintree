export type PauseToken = "resource-governor" | "backpressure" | "ipc-queue" | "system-sleep";

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

  resume(token: PauseToken): void {
    if (!this.holds.delete(token)) return;
    if (this.holds.size === 0) {
      try {
        this.raw.resume();
      } catch {
        // PTY process may already be dead
      }
    }
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
}
