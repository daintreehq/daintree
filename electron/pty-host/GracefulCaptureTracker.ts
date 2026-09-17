import { createLogger } from "../utils/logger.js";
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

interface CaptureLease {
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
 * (see `PtyPauseCoordinator.enterCaptureMode`), and this decides what happens
 * to the output that is now read despite them.
 *
 * Output is delivered as usual while no owner wants the terminal held. Once
 * one does — a renderer queue past its watermark, a governor under memory
 * pressure — the chunk is dropped instead of being handed to a consumer that
 * asked for it to stop. The queues stay bounded because the hold that would
 * have paused the PTY now stops the posting instead, and the dropped bytes are
 * display output for a pane that is closing. If the close does not take, one
 * `data-loss` pulse makes the renderer resync what it missed.
 */
export class GracefulCaptureTracker {
  private readonly leases = new Map<string, CaptureLease>();

  constructor(private readonly deps: GracefulCaptureDeps) {}

  enter(id: string): void {
    if (this.liveLease(id)) return;
    const coordinator = this.deps.getOrCreatePauseCoordinator(id);
    if (!coordinator) return;
    const heldAtEntry = new Set<PauseTokenFamily>();
    for (const token of coordinator.heldTokens) heldAtEntry.add(pauseTokenFamily(token));
    const readPausedAtEntry = coordinator.isReadPaused;
    coordinator.enterCaptureMode();
    this.leases.set(id, {
      coordinator,
      startedAt: Date.now(),
      heldAtEntry: [...heldAtEntry].sort(),
      readPausedAtEntry,
      discardedBytes: 0,
    });
  }

  isCapturing(id: string): boolean {
    return this.liveLease(id) !== undefined;
  }

  /**
   * True when this chunk should be dropped rather than routed to any renderer,
   * mirror, or fallback transport.
   */
  shouldDiscardDelivery(id: string, data: string | Uint8Array): boolean {
    const lease = this.liveLease(id);
    if (!lease || !lease.coordinator.isPaused) return false;
    lease.discardedBytes +=
      typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
    return true;
  }

  end(id: string, cause: GracefulCaptureEndCause): void {
    const lease = this.liveLease(id);
    if (!lease) return;
    this.leases.delete(id);

    const suppressed = lease.coordinator.exitCaptureMode();
    const survived = cause === "settled" && this.deps.isTerminalLive(id);
    if (survived && lease.discardedBytes > 0) {
      try {
        this.deps.emitDataLoss(id, lease.discardedBytes);
      } catch {
        // Parent port closing — the renderer resyncs on its next wake anyway.
      }
    }

    // One line per capture, never per chunk, and nothing the terminal printed.
    logger.info("Graceful capture drain ended", {
      terminalId: id,
      cause,
      durationMs: Date.now() - lease.startedAt,
      heldAtEntry: lease.heldAtEntry,
      readPausedAtEntry: lease.readPausedAtEntry,
      suppressed,
      sleepHeld: lease.coordinator.hasToken("system-sleep"),
      discardedBytes: lease.discardedBytes,
      survived,
      readPausedAfter: survived ? lease.coordinator.isReadPaused : undefined,
    });
  }

  dispose(): void {
    this.leases.clear();
  }

  private liveLease(id: string): CaptureLease | undefined {
    const lease = this.leases.get(id);
    if (!lease) return undefined;
    if (this.deps.getPauseCoordinator(id) !== lease.coordinator) {
      this.leases.delete(id);
      return undefined;
    }
    return lease;
  }
}
