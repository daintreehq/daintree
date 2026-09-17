import { createLogger } from "../utils/logger.js";
import type { GracefulCaptureHost, GracefulCaptureLease } from "../services/pty/types.js";
import {
  pauseTokenFamily,
  type PauseTokenFamily,
  type PtyPauseCoordinator,
} from "./PtyPauseCoordinator.js";

const logger = createLogger("pty-host:GracefulCapture");

export interface GracefulCaptureDeps {
  getPauseCoordinator: (id: string) => PtyPauseCoordinator | undefined;
  getOrCreatePauseCoordinator: (id: string) => PtyPauseCoordinator | undefined;
  /** Present, not killed, not exited — i.e. the close did not take. */
  isTerminalLive: (id: string) => boolean;
  emitDataLoss: (id: string, droppedBytes: number) => void;
}

export type GracefulCaptureEndCause = "settled" | "terminal-exit";

interface CaptureState {
  id: string;
  // The lease belongs to one coordinator, i.e. one incarnation of the id. A
  // respawn replaces the coordinator, and the new terminal must not inherit it.
  coordinator: PtyPauseCoordinator;
  startedAt: number;
  heldAtEntry: PauseTokenFamily[];
  readPausedAtEntry: boolean;
  discardedBytes: number;
}

/**
 * Host side of a graceful-shutdown capture window (#12432). While a terminal's
 * quit handshake is waiting on its output, its pause holds stop gating reads
 * (see `PtyPauseCoordinator.enterCaptureMode`), and the lease decides what
 * happens to the output that is now read despite them.
 *
 * While no owner wants the terminal held, output flows as usual. Once one does
 * — a renderer queue past its watermark, a governor under memory pressure —
 * the chunk is discarded by the terminal's pipeline, exactly as if the hold
 * had kept it unread: nothing is delivered, analysed, or mirrored, so the
 * exemption adds no work downstream. The teardown's own listener has still
 * seen it. If the close does not take, one `data-loss` pulse marks the gap.
 */
export class GracefulCaptureTracker implements GracefulCaptureHost {
  private readonly leases = new Map<string, CaptureState>();

  constructor(private readonly deps: GracefulCaptureDeps) {}

  open(id: string): GracefulCaptureLease | null {
    // One window per terminal: a second opener would be able to close the
    // first one's exemption out from under it.
    if (this.currentState(id)) return null;
    const coordinator = this.deps.getOrCreatePauseCoordinator(id);
    if (!coordinator) return null;

    const heldAtEntry = new Set<PauseTokenFamily>();
    for (const token of coordinator.heldTokens) heldAtEntry.add(pauseTokenFamily(token));
    const state: CaptureState = {
      id,
      coordinator,
      startedAt: Date.now(),
      heldAtEntry: [...heldAtEntry].sort(),
      readPausedAtEntry: coordinator.isReadPaused,
      discardedBytes: 0,
    };
    coordinator.enterCaptureMode();
    this.leases.set(id, state);

    return {
      shouldDiscard: (data) => this.shouldDiscard(state, data),
      close: () => this.finish(state, "settled"),
    };
  }

  isCapturing(id: string): boolean {
    return this.currentState(id) !== undefined;
  }

  /** Retires whatever window is open on `id`, e.g. because the terminal exited. */
  end(id: string, cause: GracefulCaptureEndCause): void {
    const state = this.currentState(id);
    if (state) this.finish(state, cause);
  }

  dispose(): void {
    this.leases.clear();
  }

  private shouldDiscard(state: CaptureState, data: string | Uint8Array): boolean {
    if (!this.isCurrent(state) || !state.coordinator.isPaused) return false;
    state.discardedBytes +=
      typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
    return true;
  }

  private finish(state: CaptureState, cause: GracefulCaptureEndCause): void {
    if (!this.isCurrent(state)) return;
    this.leases.delete(state.id);

    const { id, coordinator } = state;
    const suppressed = coordinator.exitCaptureMode();
    const survived = cause === "settled" && this.deps.isTerminalLive(id);
    if (survived && state.discardedBytes > 0) {
      try {
        this.deps.emitDataLoss(id, state.discardedBytes);
      } catch {
        // Parent port closing — nothing left to mark the gap on.
      }
    }

    // One line per capture, never per chunk, and nothing the terminal printed.
    logger.info("Graceful capture drain ended", {
      terminalId: id,
      cause,
      durationMs: Date.now() - state.startedAt,
      heldAtEntry: state.heldAtEntry,
      readPausedAtEntry: state.readPausedAtEntry,
      suppressed,
      sleepHeld: coordinator.hasToken("system-sleep"),
      discardedBytes: state.discardedBytes,
      survived,
      readPausedAfter: survived ? coordinator.isReadPaused : undefined,
    });
  }

  private isCurrent(state: CaptureState): boolean {
    return this.currentState(state.id) === state;
  }

  private currentState(id: string): CaptureState | undefined {
    const state = this.leases.get(id);
    if (!state) return undefined;
    if (this.deps.getPauseCoordinator(id) !== state.coordinator) {
      this.leases.delete(id);
      return undefined;
    }
    return state;
  }
}
