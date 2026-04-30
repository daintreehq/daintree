import {
  IPC_MAX_QUEUE_BYTES,
  IPC_HIGH_WATERMARK_PERCENT,
  IPC_LOW_WATERMARK_PERCENT,
  IPC_MAX_PAUSE_MS,
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
}

export class PortQueueManager {
  private readonly queuedBytes = new Map<string, number>();
  private readonly pausedTerminals = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pauseStartTimes = new Map<string, number>();
  private readonly pauseToken: PauseToken;

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
    return next;
  }

  removeBytes(id: string, bytes: number): void {
    const current = this.queuedBytes.get(id) ?? 0;
    const next = Math.max(0, current - bytes);
    if (next === 0) {
      this.queuedBytes.delete(id);
    } else {
      this.queuedBytes.set(id, next);
    }
  }

  getQueuedBytes(id: string): number {
    return this.queuedBytes.get(id) ?? 0;
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

    if (currentBytes < highWatermarkBytes || this.pausedTerminals.has(id)) {
      return false;
    }

    const coordinator = this.deps.getPauseCoordinator(id);
    if (!coordinator) {
      console.warn(
        `[PtyHost] Cannot apply port backpressure: missing pause coordinator for ${id}. Queue at ${utilization.toFixed(1)}%`
      );
      return false;
    }

    try {
      coordinator.pause(this.pauseToken);
      console.warn(
        `[PtyHost] Port queue high (${utilization.toFixed(1)}%). Pausing PTY ${id} for backpressure.`
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

      const safetyTimeout = setTimeout(() => {
        // Capture utilization BEFORE clearing queuedBytes so the reliability
        // metric reports the at-resume queue depth, not the post-clear 0%.
        const currentUtilization = this.getUtilization(id);
        const pauseDuration = Date.now() - pauseStartTime;

        this.pausedTerminals.delete(id);
        this.pauseStartTimes.delete(id);
        // Drop stale byte accounting alongside the pause maps. Without this,
        // the next addBytes call immediately re-triggers applyBackpressure
        // and the pause loop wedges across the entire renderer reload (#6244).
        this.queuedBytes.delete(id);

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
      }, IPC_MAX_PAUSE_MS);

      this.pausedTerminals.set(id, safetyTimeout);
      return true;
    } catch (error) {
      console.error(`[PtyHost] Failed to pause port PTY ${id}:`, error);
      return false;
    }
  }

  tryResume(id: string): void {
    if (!this.pausedTerminals.has(id)) return;

    const lowWatermarkBytes = (IPC_MAX_QUEUE_BYTES * IPC_LOW_WATERMARK_PERCENT) / 100;
    const currentBytes = this.queuedBytes.get(id) ?? 0;
    if (currentBytes >= lowWatermarkBytes) return;

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
    this.queuedBytes.delete(id);
    const safetyTimeout = this.pausedTerminals.get(id);
    if (safetyTimeout) {
      clearTimeout(safetyTimeout);
      this.pausedTerminals.delete(id);
    }
    this.pauseStartTimes.delete(id);
  }

  resumeAll(): void {
    for (const [id, safetyTimeout] of this.pausedTerminals) {
      clearTimeout(safetyTimeout);
      const coordinator = this.deps.getPauseCoordinator(id);
      if (coordinator) {
        coordinator.resume(this.pauseToken);
      }
    }
    this.pausedTerminals.clear();
    this.pauseStartTimes.clear();
  }

  dispose(): void {
    for (const [id, safetyTimeout] of this.pausedTerminals) {
      clearTimeout(safetyTimeout);
      console.log(`[PtyHost] Cleared port backpressure monitor for terminal ${id}`);
    }
    this.pausedTerminals.clear();
    this.pauseStartTimes.clear();
    this.queuedBytes.clear();
  }
}
