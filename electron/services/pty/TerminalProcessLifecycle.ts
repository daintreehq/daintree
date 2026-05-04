import type { ExitReason, PtyState } from "./types.js";

/**
 * Owns the `alive → shutting-down → exited → disposed` state machine for a
 * single TerminalProcess. `transition()` returns `false` for any illegal
 * progression — that's what makes `teardown()`, `kill()`, and `dispose()`
 * idempotent (the second caller sees the no-op return and bails).
 *
 * Teardown of collaborators (process detector, activity monitor, identity
 * watcher, write queue, process-tree killer) is NOT owned here — it stays
 * on TerminalProcess so the host can decide ordering. This module only
 * tracks the state itself.
 */
export class TerminalProcessLifecycle {
  private state: PtyState = { kind: "alive" };

  getState(): PtyState {
    return this.state;
  }

  get isAlive(): boolean {
    return this.state.kind === "alive";
  }

  get isExited(): boolean {
    return this.state.kind === "exited" || this.state.kind === "disposed";
  }

  get isDisposed(): boolean {
    return this.state.kind === "disposed";
  }

  /**
   * Replace the lifecycle state. Returns `false` (no-op) when the requested
   * transition is illegal — most importantly when something tries to enter
   * `shutting-down` while we are already past `alive`. Callers rely on this
   * to make their entry path idempotent.
   */
  transition(next: PtyState): boolean {
    const current = this.state;
    if (current.kind === next.kind) {
      return false;
    }

    let valid = false;
    switch (current.kind) {
      case "alive":
        valid = next.kind === "shutting-down";
        break;
      case "shutting-down":
        valid = next.kind === "exited" || next.kind === "disposed";
        break;
      case "exited":
        valid = next.kind === "disposed";
        break;
      case "disposed":
        valid = false;
        break;
    }

    if (!valid) {
      return false;
    }

    this.state = next;
    return true;
  }

  /**
   * Force the state to `exited`. Used by `setupPtyHandlers.onExit` after
   * teardown when the terminal is preserved (agent terminal, exit code 0).
   * Asserts the prior state is `shutting-down` — natural exits go through
   * teardown first, which performs the `alive → shutting-down` transition.
   */
  setExited(args: { code: number; signal?: number; reason: ExitReason }): void {
    this.state = {
      kind: "exited",
      code: args.code,
      signal: args.signal,
      reason: args.reason,
    };
  }

  /**
   * Force the state to `disposed`. Used by `dispose()` and the natural-exit
   * non-preserve path. Idempotent — already-disposed is a no-op.
   */
  setDisposed(reason: ExitReason): void {
    if (this.state.kind === "disposed") return;
    this.state = { kind: "disposed", reason };
  }

  /**
   * Read the exit reason captured by the most recent transition past
   * `alive`. Returns `null` for terminals that are still alive — used by
   * `dispose()` after a prior `kill()` or natural exit to preserve the
   * original reason in the final `disposed` state.
   */
  getExitReason(): ExitReason | null {
    const s = this.state;
    if (s.kind === "shutting-down" || s.kind === "exited" || s.kind === "disposed") {
      return s.reason;
    }
    return null;
  }
}
