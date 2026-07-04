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
import type { PtyPauseCoordinator } from "./PtyPauseCoordinator.js";

export interface IpcQueueDeps {
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
}

export class IpcQueueManager {
  private readonly queuedBytes = new Map<string, number>();
  private readonly pausedTerminals = new Map<string, ReturnType<typeof setInterval>>();
  private readonly pauseStartTimes = new Map<string, number>();
  private totalQueuedBytes = 0;

  constructor(private readonly deps: IpcQueueDeps) {}

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
   * Aggregate-gate resume sweep — mirrors PortQueueManager: a terminal paused
   * by the aggregate watermark may receive no further acks of its own, so
   * re-check every paused terminal whenever the total drains below the low
   * watermark. Runs on acks (removeBytes), the safety-timeout force-resume,
   * and clearQueue — any of them can be the drain event, and sweeping only on
   * acks left aggregate-paused siblings stranded until their own timeouts.
   */
  private sweepAggregateResume(previousTotal: number): void {
    if (
      previousTotal < IPC_TOTAL_QUEUE_LOW_WATERMARK_BYTES ||
      this.totalQueuedBytes >= IPC_TOTAL_QUEUE_LOW_WATERMARK_BYTES
    ) {
      return;
    }
    for (const pausedId of [...this.pausedTerminals.keys()]) {
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

  applyBackpressure(id: string, utilization: number): boolean {
    const highWatermarkBytes = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    const currentBytes = this.queuedBytes.get(id) ?? 0;

    // Pause on the per-terminal watermark OR the aggregate watermark — see
    // PortQueueManager.applyBackpressure for the multi-agent-burst rationale.
    const overOwnWatermark = currentBytes >= highWatermarkBytes;
    const overAggregateWatermark =
      currentBytes > 0 && this.totalQueuedBytes >= IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES;
    if ((!overOwnWatermark && !overAggregateWatermark) || this.pausedTerminals.has(id)) {
      return false;
    }

    const coordinator = this.deps.getPauseCoordinator(id);
    if (!coordinator) {
      console.warn(
        `[PtyHost] Cannot apply IPC backpressure: missing pause coordinator for ${id}. Queue at ${utilization.toFixed(1)}%`
      );
      return false;
    }

    let safetyTimeout: ReturnType<typeof setTimeout> | undefined;
    let committed = false;
    try {
      coordinator.pause("ipc-queue");
      console.warn(
        `[PtyHost] IPC queue high (${utilization.toFixed(1)}%). Pausing PTY ${id} for backpressure.`
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

      // Safety timeout: if ack-driven resume doesn't clear backpressure in time,
      // force resume to prevent permanent stall
      safetyTimeout = setTimeout(() => {
        // Capture utilization BEFORE clearing queuedBytes so the reliability
        // metric reports the at-resume queue depth, not the post-clear 0%.
        const currentUtilization = this.getUtilization(id);
        const pauseDuration = Date.now() - pauseStartTime;

        this.pausedTerminals.delete(id);
        this.pauseStartTimes.delete(id);
        // Drop stale byte accounting alongside the pause maps. Without this,
        // the next addBytes call immediately re-triggers applyBackpressure
        // and the pause loop wedges across the entire renderer reload
        // (mirrors the port-path fix in #6244).
        const droppedBytes = this.queuedBytes.get(id) ?? 0;
        this.queuedBytes.delete(id);
        const previousTotal = this.totalQueuedBytes;
        this.totalQueuedBytes = Math.max(0, this.totalQueuedBytes - droppedBytes);

        const coordinator = this.deps.getPauseCoordinator(id);
        if (coordinator) {
          coordinator.resume("ipc-queue");
          console.warn(
            `[PtyHost] Force resumed IPC PTY ${id} after ${pauseDuration}ms (queue at ${currentUtilization.toFixed(1)}%). Consumer may be stalled.`
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

        // Dropping this terminal's bytes may have drained the aggregate below
        // its low watermark — re-check siblings paused by the aggregate gate.
        this.sweepAggregateResume(previousTotal);
      }, IPC_MAX_PAUSE_MS);

      this.pausedTerminals.set(id, safetyTimeout);
      committed = true;
      return true;
    } catch (error) {
      console.error(`[PtyHost] Failed to pause IPC PTY ${id}:`, error);
      return false;
    } finally {
      // If we threw between coordinator.pause() and the final pausedTerminals.set,
      // release the token and any orphaned safety timeout so the PTY is not
      // permanently held with no recovery path. See #7641.
      if (!committed) {
        if (safetyTimeout !== undefined) clearTimeout(safetyTimeout);
        this.pauseStartTimes.delete(id);
        coordinator.resume("ipc-queue");
      }
    }
  }

  tryResume(id: string): void {
    if (!this.pausedTerminals.has(id)) return;

    const lowWatermarkBytes = (IPC_MAX_QUEUE_BYTES * IPC_LOW_WATERMARK_PERCENT) / 100;
    const currentBytes = this.queuedBytes.get(id) ?? 0;
    if (currentBytes >= lowWatermarkBytes) return;
    // Hold while the aggregate is over its low watermark — see
    // PortQueueManager.tryResume; bounded by the IPC_MAX_PAUSE_MS timeout.
    if (this.totalQueuedBytes >= IPC_TOTAL_QUEUE_LOW_WATERMARK_BYTES) return;

    const pauseStart = this.pauseStartTimes.get(id);
    const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
    const utilization = this.getUtilization(id);

    const coordinator = this.deps.getPauseCoordinator(id);
    if (coordinator) {
      coordinator.resume("ipc-queue");
      console.log(`[PtyHost] IPC queue cleared to ${utilization.toFixed(1)}%. Resumed PTY ${id}`);
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
      this.deps.getPauseCoordinator(id)?.resume("ipc-queue");
    }
    const removed = this.queuedBytes.get(id) ?? 0;
    this.queuedBytes.delete(id);
    const previousTotal = this.totalQueuedBytes;
    this.totalQueuedBytes = Math.max(0, this.totalQueuedBytes - removed);
    this.pausedTerminals.delete(id);
    this.pauseStartTimes.delete(id);
    // A cleared terminal (exit, force-resume) can be the one holding most of
    // the aggregate — sweep so aggregate-paused siblings resume now instead of
    // waiting out their safety timeouts.
    this.sweepAggregateResume(previousTotal);
  }

  dispose(): void {
    // Release any held pause tokens before tearing down so the coordinator
    // doesn't outlive this manager with a stale hold.
    for (const [id, safetyTimeout] of this.pausedTerminals) {
      clearTimeout(safetyTimeout);
      this.deps.getPauseCoordinator(id)?.resume("ipc-queue");
      console.log(`[PtyHost] Cleared IPC backpressure monitor for terminal ${id}`);
    }
    this.pausedTerminals.clear();
    this.pauseStartTimes.clear();
    this.queuedBytes.clear();
    this.totalQueuedBytes = 0;
  }
}
