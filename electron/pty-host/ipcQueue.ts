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

export interface IpcQueueDeps {
  getTerminal: (
    id: string
  ) => { ptyProcess?: { pause: () => void; resume: () => void } } | undefined;
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

  constructor(private readonly deps: IpcQueueDeps) {}

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

    const terminal = this.deps.getTerminal(id);
    if (!terminal?.ptyProcess) {
      console.warn(
        `[PtyHost] Cannot apply IPC backpressure: missing PTY process for ${id}. Queue at ${utilization.toFixed(1)}%`
      );
      return false;
    }

    try {
      terminal.ptyProcess.pause();
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
      const safetyTimeout = setTimeout(() => {
        this.pausedTerminals.delete(id);
        this.pauseStartTimes.delete(id);

        const currentUtilization = this.getUtilization(id);
        const pauseDuration = Date.now() - pauseStartTime;

        const terminal = this.deps.getTerminal(id);
        if (terminal?.ptyProcess) {
          try {
            terminal.ptyProcess.resume();
            console.warn(
              `[PtyHost] Force resumed IPC PTY ${id} after ${pauseDuration}ms (queue at ${currentUtilization.toFixed(1)}%). Consumer may be stalled.`
            );
            this.deps.emitTerminalStatus(id, "running", currentUtilization, pauseDuration);
            this.deps.emitReliabilityMetric({
              terminalId: id,
              metricType: "pause-end",
              timestamp: Date.now(),
              durationMs: pauseDuration,
              bufferUtilization: currentUtilization,
            });
          } catch (error) {
            console.error(`[PtyHost] Failed to force resume IPC PTY ${id}:`, error);
          }
        }
      }, IPC_MAX_PAUSE_MS);

      this.pausedTerminals.set(id, safetyTimeout);
      return true;
    } catch (error) {
      console.error(`[PtyHost] Failed to pause IPC PTY ${id}:`, error);
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

    const terminal = this.deps.getTerminal(id);
    if (terminal?.ptyProcess) {
      try {
        terminal.ptyProcess.resume();
        console.log(
          `[PtyHost] IPC queue cleared to ${utilization.toFixed(1)}%. Resumed PTY ${id}`
        );
        this.deps.emitTerminalStatus(id, "running", utilization, pauseDuration);
        this.deps.emitReliabilityMetric({
          terminalId: id,
          metricType: "pause-end",
          timestamp: Date.now(),
          durationMs: pauseDuration,
          bufferUtilization: utilization,
        });
      } catch (error) {
        console.error(`[PtyHost] Failed to resume IPC PTY ${id}:`, error);
      }
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

  dispose(): void {
    for (const [id, safetyTimeout] of this.pausedTerminals) {
      clearTimeout(safetyTimeout);
      console.log(`[PtyHost] Cleared IPC backpressure monitor for terminal ${id}`);
    }
    this.pausedTerminals.clear();
    this.pauseStartTimes.clear();
    this.queuedBytes.clear();
  }
}
