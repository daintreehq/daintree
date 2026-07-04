import {
  IPC_MAX_QUEUE_BYTES,
  IPC_HIGH_WATERMARK_PERCENT,
  IPC_LOW_WATERMARK_PERCENT,
  IPC_MAX_PAUSE_MS,
  IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES,
  IPC_TOTAL_QUEUE_LOW_WATERMARK_BYTES,
} from "../services/pty/types.js";
import type {
  PtyHostEvent,
  TerminalFlowStatus,
  TerminalReliabilityMetricPayload,
} from "../../shared/types/pty-host.js";
import type { PtyPauseCoordinator, PauseToken } from "./PtyPauseCoordinator.js";

export interface PortQueueDeps {
  getTerminal: (
    id: string
  ) => { ptyProcess?: { pause: () => void; resume: () => void } } | undefined;
  getPauseCoordinator: (id: string) => PtyPauseCoordinator | undefined;
  sendEvent: (event: PtyHostEvent) => void;
  metricsEnabled: () => boolean;
  emitTerminalStatus: (
    id: string,
    status: TerminalFlowStatus,
    bufferUtilization?: number,
    pauseDuration?: number
  ) => void;
  emitReliabilityMetric: (payload: TerminalReliabilityMetricPayload) => void;
  pauseToken?: PauseToken;
  /**
   * The UI-focused terminal id for this window, or null when none is focused.
   * The focused terminal is exempt from the aggregate (window-level) pause
   * trigger — its own per-terminal watermark still applies unconditionally —
   * and is resumed first when the aggregate drains. Optional: when absent the
   * manager behaves exactly as before (no terminal is treated as focused).
   */
  getFocusedTerminalId?: () => string | null;
}

export class PortQueueManager {
  private readonly queuedBytes = new Map<string, number>();
  private readonly pausedTerminals = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pauseStartTimes = new Map<string, number>();
  private readonly pauseToken: PauseToken;
  private totalQueuedBytes = 0;

  constructor(private readonly deps: PortQueueDeps) {
    this.pauseToken = deps.pauseToken ?? "port-queue";
  }

  getUtilization(id: string): number {
    const bytes = this.queuedBytes.get(id) ?? 0;
    return (bytes / IPC_MAX_QUEUE_BYTES) * 100;
  }

  addBytes(id: string, bytes: number): number {
    const current = this.queuedBytes.get(id) ?? 0;
    const next = current + bytes;
    this.queuedBytes.set(id, next);
    this.totalQueuedBytes += bytes;
    return next;
  }

  removeBytes(id: string, bytes: number): void {
    const current = this.queuedBytes.get(id) ?? 0;
    // Clamp the aggregate delta to the per-terminal balance to prevent
    // underflow when callers over-remove (the per-terminal value is
    // already clamped via Math.max below).
    const removed = Math.min(bytes, current);
    const next = current - removed;
    if (next === 0) {
      this.queuedBytes.delete(id);
    } else {
      this.queuedBytes.set(id, next);
    }
    const previousTotal = this.totalQueuedBytes;
    this.totalQueuedBytes = Math.max(0, this.totalQueuedBytes - removed);
    this.sweepAggregateResume(previousTotal);
  }

  /**
   * Aggregate-gate resume sweep: a terminal paused by the window-level
   * watermark may have an empty queue of its own, so no further acks (and
   * therefore no tryResume calls) ever arrive for it. When the aggregate
   * crosses back below the low watermark, re-check every paused terminal.
   * Called from every path that shrinks the aggregate — acks (removeBytes),
   * the safety-timeout force-resume, and clearQueue — because any of them can
   * be the drain event that frees the window; sweeping only on acks left
   * aggregate-paused siblings stranded until their own safety timeouts when
   * the drain came from a timeout or a terminal teardown instead.
   */
  private sweepAggregateResume(previousTotal: number): void {
    if (
      previousTotal < IPC_TOTAL_QUEUE_LOW_WATERMARK_BYTES ||
      this.totalQueuedBytes >= IPC_TOTAL_QUEUE_LOW_WATERMARK_BYTES
    ) {
      return;
    }
    // Resume the focused terminal first so the pane the user is watching
    // recovers ahead of its siblings. tryResume reads only totalQueuedBytes
    // and per-terminal bytes (neither mutated by a resume), so visiting the
    // focused id first is order-independent for correctness — it only changes
    // which coordinator.resume() fires first. Every other paused terminal is
    // still swept, so no producer is starved (#7030).
    const focusedId = this.deps.getFocusedTerminalId?.() ?? null;
    if (focusedId !== null && this.pausedTerminals.has(focusedId)) {
      this.tryResume(focusedId);
    }
    for (const pausedId of [...this.pausedTerminals.keys()]) {
      if (pausedId === focusedId) continue;
      this.tryResume(pausedId);
    }
  }

  getQueuedBytes(id: string): number {
    return this.queuedBytes.get(id) ?? 0;
  }

  getTotalQueuedBytes(): number {
    return this.totalQueuedBytes;
  }

  getQueueSnapshot(): {
    totalPendingBytes: number;
    perTerminal: Array<{ terminalId: string; pendingBytes: number }>;
  } {
    const perTerminal: Array<{ terminalId: string; pendingBytes: number }> = [];
    for (const [terminalId, pendingBytes] of this.queuedBytes) {
      perTerminal.push({ terminalId, pendingBytes });
    }
    return { totalPendingBytes: this.totalQueuedBytes, perTerminal };
  }

  isAtCapacity(id: string, additionalBytes: number): boolean {
    const current = this.queuedBytes.get(id) ?? 0;
    return current + additionalBytes > IPC_MAX_QUEUE_BYTES;
  }

  isPaused(id: string): boolean {
    return this.pausedTerminals.has(id);
  }

  /**
   * Iterator over the terminal IDs currently held by this port-queue
   * manager's pause tokens. Used by the host's `disconnectWindow` path
   * to clear per-source pause-tracking entries scoped to the
   * disconnecting window — multi-source attribution means the IPC
   * queue may still hold the same terminal and we must not clobber
   * that path's tracking.
   */
  getPausedTerminalIds(): IterableIterator<string> {
    return this.pausedTerminals.keys();
  }

  applyBackpressure(id: string, utilization: number): boolean {
    const highWatermarkBytes = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    const currentBytes = this.queuedBytes.get(id) ?? 0;

    // Two pause triggers: this terminal's own queue crossing its watermark,
    // or the window-level aggregate crossing the total watermark (a
    // simultaneous multi-agent burst can otherwise put N × ~2MB in flight to
    // one renderer before any single terminal trips its own gate). The
    // aggregate trigger pauses the currently producing terminal — under a
    // fleet burst every active producer reaches here within one batch flush.
    const overOwnWatermark = currentBytes >= highWatermarkBytes;
    // The focused terminal is exempt from the aggregate trigger: it is paused
    // LAST under a fleet burst, staying live while its siblings absorb the
    // window-level backpressure. Its OWN watermark still applies (above), so
    // its queue can never grow unbounded — a runaway focused terminal still
    // pauses on its own gate and the saturated/data-loss fallback is unchanged.
    const focusedId = this.deps.getFocusedTerminalId?.() ?? null;
    const overAggregateWatermark =
      currentBytes > 0 &&
      id !== focusedId &&
      this.totalQueuedBytes >= IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES;
    if ((!overOwnWatermark && !overAggregateWatermark) || this.pausedTerminals.has(id)) {
      return false;
    }

    const coordinator = this.deps.getPauseCoordinator(id);
    if (!coordinator) {
      console.warn(
        `[PtyHost] Cannot apply port backpressure: missing pause coordinator for ${id}. Queue at ${utilization.toFixed(1)}%`
      );
      return false;
    }

    let safetyTimeout: ReturnType<typeof setTimeout> | undefined;
    let committed = false;
    try {
      coordinator.pause(this.pauseToken);
      console.warn(
        overOwnWatermark
          ? `[PtyHost] Port queue high (${utilization.toFixed(1)}%). Pausing PTY ${id} for backpressure.`
          : `[PtyHost] Aggregate port queue high (${this.totalQueuedBytes} bytes). Pausing PTY ${id} for backpressure.`
      );

      const pauseStartTime = Date.now();
      this.pauseStartTimes.set(id, pauseStartTime);

      this.deps.emitTerminalStatus(id, "paused-backpressure", utilization);
      this.deps.emitReliabilityMetric({
        terminalId: id,
        metricType: "pause-start",
        timestamp: pauseStartTime,
        bufferUtilization: utilization,
      });

      safetyTimeout = setTimeout(() => {
        // Capture utilization BEFORE clearing queuedBytes so the reliability
        // metric reports the at-resume queue depth, not the post-clear 0%.
        const currentUtilization = this.getUtilization(id);
        const pauseDuration = Date.now() - pauseStartTime;

        this.pausedTerminals.delete(id);
        this.pauseStartTimes.delete(id);
        // Drop stale byte accounting alongside the pause maps. Without this,
        // the next addBytes call immediately re-triggers applyBackpressure
        // and the pause loop wedges across the entire renderer reload (#6244).
        const droppedBytes = this.queuedBytes.get(id) ?? 0;
        this.queuedBytes.delete(id);
        const previousTotal = this.totalQueuedBytes;
        this.totalQueuedBytes = Math.max(0, this.totalQueuedBytes - droppedBytes);

        const coordinator = this.deps.getPauseCoordinator(id);
        if (coordinator) {
          coordinator.resume(this.pauseToken);
          console.warn(
            `[PtyHost] Force resumed port PTY ${id} after ${pauseDuration}ms (queue at ${currentUtilization.toFixed(1)}%). Consumer may be stalled.`
          );
          if (!coordinator.isPaused) {
            this.deps.emitTerminalStatus(id, "running", currentUtilization, pauseDuration);
          }
          this.deps.emitReliabilityMetric({
            terminalId: id,
            metricType: "pause-end",
            timestamp: Date.now(),
            durationMs: pauseDuration,
            bufferUtilization: currentUtilization,
          });
        }

        // The force-resume dropped this terminal's byte accounting — if that
        // took the aggregate below its low watermark, siblings paused by the
        // window-level gate (with empty queues of their own, so no acks are
        // coming) must be re-checked here or they stay stranded until each of
        // their own safety timeouts fires.
        this.sweepAggregateResume(previousTotal);
      }, IPC_MAX_PAUSE_MS);

      this.pausedTerminals.set(id, safetyTimeout);
      committed = true;
      return true;
    } catch (error) {
      console.error(`[PtyHost] Failed to pause port PTY ${id}:`, error);
      return false;
    } finally {
      // If we threw between coordinator.pause() and the final pausedTerminals.set,
      // release the token and any orphaned safety timeout so the PTY is not
      // permanently held with no recovery path. See #7641.
      if (!committed) {
        if (safetyTimeout !== undefined) clearTimeout(safetyTimeout);
        this.pauseStartTimes.delete(id);
        coordinator.resume(this.pauseToken);
      }
    }
  }

  tryResume(id: string): void {
    if (!this.pausedTerminals.has(id)) return;

    const lowWatermarkBytes = (IPC_MAX_QUEUE_BYTES * IPC_LOW_WATERMARK_PERCENT) / 100;
    const currentBytes = this.queuedBytes.get(id) ?? 0;
    if (currentBytes >= lowWatermarkBytes) return;
    // Hold the pause while the window-level aggregate is still over its low
    // watermark — resuming a producer into a swamped window just re-grows the
    // backlog. The removeBytes sweep re-runs this check when the aggregate
    // drains; the IPC_MAX_PAUSE_MS safety timeout bounds the worst case.
    if (this.totalQueuedBytes >= IPC_TOTAL_QUEUE_LOW_WATERMARK_BYTES) return;

    const pauseStart = this.pauseStartTimes.get(id);
    const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
    const utilization = this.getUtilization(id);

    const coordinator = this.deps.getPauseCoordinator(id);
    if (coordinator) {
      coordinator.resume(this.pauseToken);
      console.log(`[PtyHost] Port queue cleared to ${utilization.toFixed(1)}%. Resumed PTY ${id}`);
      if (!coordinator.isPaused) {
        this.deps.emitTerminalStatus(id, "running", utilization, pauseDuration);
      }
      this.deps.emitReliabilityMetric({
        terminalId: id,
        metricType: "pause-end",
        timestamp: Date.now(),
        durationMs: pauseDuration,
        bufferUtilization: utilization,
      });
    }

    const safetyTimeout = this.pausedTerminals.get(id);
    if (safetyTimeout) {
      clearTimeout(safetyTimeout);
    }
    this.pausedTerminals.delete(id);
    this.pauseStartTimes.delete(id);
  }

  clearQueue(id: string): void {
    const wasPaused = this.pausedTerminals.has(id);
    const safetyTimeout = this.pausedTerminals.get(id);
    if (safetyTimeout) {
      clearTimeout(safetyTimeout);
    }
    // Release the coordinator hold before clearing internal maps so any
    // re-entrant applyBackpressure sees a clean state. resume() is a no-op
    // when the token isn't held, so guarding on wasPaused is purely an
    // optimization to avoid a useless coordinator lookup. See #7008.
    if (wasPaused) {
      this.deps.getPauseCoordinator(id)?.resume(this.pauseToken);
    }
    const removed = this.queuedBytes.get(id) ?? 0;
    this.queuedBytes.delete(id);
    const previousTotal = this.totalQueuedBytes;
    this.totalQueuedBytes = Math.max(0, this.totalQueuedBytes - removed);
    this.pausedTerminals.delete(id);
    this.pauseStartTimes.delete(id);
    // A cleared terminal (exit, force-resume) can be the terminal holding most
    // of the window aggregate — sweep so aggregate-paused siblings don't wait
    // out their safety timeouts for bytes that will never be acked.
    this.sweepAggregateResume(previousTotal);
  }

  resumeAll(): void {
    for (const [id, safetyTimeout] of this.pausedTerminals) {
      clearTimeout(safetyTimeout);
      const coordinator = this.deps.getPauseCoordinator(id);
      if (!coordinator) continue;
      coordinator.resume(this.pauseToken);
      // Surface the release. resumeAll runs when this manager's window goes
      // away (disconnect/replace/dispose) — without an emission here the
      // shared status map keeps "paused-backpressure" and any other window
      // still showing this terminal wears a stale paused pill until some
      // unrelated transition overwrites it. The pause-end metric also clears
      // this window's entry in the host's per-source pause-duration tracking
      // (the funnel maps this manager's metrics to its own `port-<windowId>`
      // source), so multi-source attribution survives: a terminal also held
      // by the IPC queue stays tracked by that source. Emission is
      // best-effort: this path runs during window teardown where sendEvent
      // can race a dying parent channel, and a throw here must not abort the
      // remaining releases or leave the pause maps stale.
      try {
        const pauseStart = this.pauseStartTimes.get(id);
        const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
        if (!coordinator.isPaused) {
          this.deps.emitTerminalStatus(id, "running", this.getUtilization(id), pauseDuration);
        }
        this.deps.emitReliabilityMetric({
          terminalId: id,
          metricType: "pause-end",
          timestamp: Date.now(),
          durationMs: pauseDuration,
          bufferUtilization: this.getUtilization(id),
        });
      } catch (error) {
        console.warn(`[PtyHost] resumeAll emission failed for ${id}:`, error);
      }
    }
    this.pausedTerminals.clear();
    this.pauseStartTimes.clear();
  }

  dispose(): void {
    // Release any held pause tokens before tearing down so the coordinator
    // doesn't outlive this manager with a stale hold.
    for (const id of this.pausedTerminals.keys()) {
      console.log(`[PtyHost] Cleared port backpressure monitor for terminal ${id}`);
    }
    this.resumeAll();
    this.queuedBytes.clear();
    this.totalQueuedBytes = 0;
  }
}
