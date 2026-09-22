export type PauseToken =
  | "resource-governor"
  | "backpressure"
  | "ipc-queue"
  | "port-queue"
  | `port-queue-${number}`
  // Dedicated worker-ingest queue for one (window, terminal) pair (#10960).
  | `port-queue-worker-${number}-${string}`
  | "system-sleep";

/**
 * A token with its per-window / per-worker suffix dropped, so diagnostics that
 * name which holds were in play stay bounded however many windows exist.
 */
export type PauseTokenFamily =
  | "resource-governor"
  | "backpressure"
  | "ipc-queue"
  | "port-queue"
  | "port-queue-worker"
  | "system-sleep";

export function pauseTokenFamily(token: PauseToken): PauseTokenFamily {
  if (token.startsWith("port-queue-worker-")) return "port-queue-worker";
  if (token.startsWith("port-queue")) return "port-queue";
  return token as PauseTokenFamily;
}

export class PtyPauseCoordinator {
  private readonly holds = new Set<PauseToken>();
  private rawPaused = false;
  private capturing = false;
  private readonly suppressedFamilies = new Set<PauseTokenFamily>();

  constructor(
    private readonly raw: {
      pause: () => void;
      resume: () => void;
    }
  ) {}

  pause(token: PauseToken): void {
    this.holds.add(token);
    if (this.capturing && token !== "system-sleep") {
      this.suppressedFamilies.add(pauseTokenFamily(token));
    }
    this.syncRaw();
  }

  resume(token: PauseToken): boolean {
    if (!this.holds.delete(token)) return false;
    this.syncRaw();
    return this.holds.size === 0;
  }

  forceReleaseAll(): void {
    if (this.holds.size === 0) return;
    this.holds.clear();
    this.syncRaw();
  }

  /**
   * Graceful-shutdown capture (#12432): the teardown is waiting on this PTY's
   * output, so only a system-sleep hold may stop its reads until
   * {@link exitCaptureMode}. Every other hold is still RECORDED — owners keep
   * their own bookkeeping and release their tokens as usual — so whatever is
   * still held when capture ends takes effect again without any owner having
   * to re-assert it, and a hold released meanwhile is simply gone.
   *
   * Sleep stays enforced: the OS suspension contract outranks a quit handshake,
   * which is deadline-bound and can time out instead.
   */
  enterCaptureMode(): void {
    if (this.capturing) return;
    this.capturing = true;
    this.suppressedFamilies.clear();
    for (const token of this.holds) {
      if (token !== "system-sleep") this.suppressedFamilies.add(pauseTokenFamily(token));
    }
    this.syncRaw();
  }

  /**
   * Returns the hold families that capture kept from pausing reads, whether
   * they were already held at entry or requested during capture.
   */
  exitCaptureMode(): PauseTokenFamily[] {
    if (!this.capturing) return [];
    this.capturing = false;
    const suppressed = [...this.suppressedFamilies].sort();
    this.suppressedFamilies.clear();
    this.syncRaw();
    return suppressed;
  }

  get isCapturing(): boolean {
    return this.capturing;
  }

  /** At least one owner has asked for this PTY to be held, enforced or not. */
  get isPaused(): boolean {
    return this.holds.size > 0;
  }

  /** Whether the underlying PTY's reads are actually stopped right now. */
  get isReadPaused(): boolean {
    return this.rawPaused;
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

  private syncRaw(): void {
    const shouldPause = this.capturing ? this.holds.has("system-sleep") : this.holds.size > 0;
    if (shouldPause === this.rawPaused) return;
    this.rawPaused = shouldPause;
    try {
      if (shouldPause) {
        this.raw.pause();
      } else {
        this.raw.resume();
      }
    } catch {
      // PTY process may already be dead
    }
  }
}
