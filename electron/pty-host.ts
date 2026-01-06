/**
 * Pty Host - UtilityProcess entry point for terminal management.
 *
 * This process handles all terminal I/O and state tracking, keeping the
 * Main process responsive. It runs PtyManager and PtyPool in an isolated
 * context, communicating with Main via IPC messages.
 *
 * State detection uses activity-based monitoring (data flow) rather than
 * pattern matching or AI classification.
 */

import { MessagePort } from "node:worker_threads";
import os from "node:os";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { PtyManager } from "./services/PtyManager.js";
import { PtyPool, getPtyPool } from "./services/PtyPool.js";
import { ProcessTreeCache } from "./services/ProcessTreeCache.js";
import { events } from "./services/events.js";
import { SharedRingBuffer, PacketFramer } from "../shared/utils/SharedRingBuffer.js";
import { selectShard } from "../shared/utils/shardSelection.js";
import type { AgentEvent } from "./services/AgentStateMachine.js";
import type {
  PtyHostEvent,
  PtyHostTerminalSnapshot,
  TerminalFlowStatus,
  PtyHostActivityTier,
  TerminalReliabilityMetricPayload,
} from "../shared/types/pty-host.js";
import {
  IPC_MAX_QUEUE_BYTES,
  IPC_HIGH_WATERMARK_PERCENT,
  IPC_LOW_WATERMARK_PERCENT,
  IPC_BACKPRESSURE_CHECK_INTERVAL_MS,
  IPC_MAX_PAUSE_MS,
} from "./services/pty/types.js";

function getEmergencyLogPath(): string {
  const userData = process.env.CANOPY_USER_DATA;
  const logDir = userData
    ? path.join(userData, "logs")
    : process.env.NODE_ENV === "development"
      ? path.join(process.cwd(), "logs")
      : path.join(process.cwd(), "logs");
  return path.join(logDir, "pty-host.log");
}

function appendEmergencyLog(lines: string): void {
  try {
    const logFile = getEmergencyLogPath();
    mkdirSync(path.dirname(logFile), { recursive: true });
    appendFileSync(logFile, lines, "utf8");
  } catch {
    // best-effort only
  }
}

function emergencyLogFatal(kind: string, error: unknown): void {
  const timestamp = new Date().toISOString();
  const pid = process.pid;
  const uptimeMs = Math.round(process.uptime() * 1000);
  const memory = process.memoryUsage();
  const details =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) };

  appendEmergencyLog(
    [
      "============================================================",
      `[${timestamp}] [${kind}] pid=${pid} uptimeMs=${uptimeMs}`,
      `node=${process.version} platform=${process.platform} arch=${process.arch}`,
      `memory.rss=${memory.rss} heapUsed=${memory.heapUsed} heapTotal=${memory.heapTotal} external=${memory.external}`,
      `error=${JSON.stringify(details)}`,
      "",
    ].join("\n")
  );
}

// Validate we're running in UtilityProcess context
if (!process.parentPort) {
  emergencyLogFatal("FATAL_INIT_NO_PARENT_PORT", new Error("Must run in UtilityProcess context"));
  throw new Error("[PtyHost] Must run in UtilityProcess context");
}

const port = process.parentPort as unknown as MessagePort;

appendEmergencyLog(`[${new Date().toISOString()}] [START] pid=${process.pid}\n`);

// Global error handlers to prevent silent crashes
process.on("uncaughtException", (err) => {
  console.error("[PtyHost] Uncaught Exception:", err);
  emergencyLogFatal("UNCAUGHT_EXCEPTION", err);
  try {
    sendEvent({ type: "error", id: "system", error: err.message });
  } catch {
    // ignore
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("[PtyHost] Unhandled Rejection:", reason);
  emergencyLogFatal("UNHANDLED_REJECTION", reason);
  try {
    sendEvent({
      type: "error",
      id: "system",
      error: String(reason instanceof Error ? reason.message : reason),
    });
  } catch {
    // ignore
  }
});

// Resource Governor - monitors heap usage and applies backpressure proactively
class ResourceGovernor {
  private readonly MEMORY_LIMIT_PERCENT = 80; // Pause at 80% of max heap
  private readonly RESUME_THRESHOLD_PERCENT = 60; // Resume at 60% (hysteresis)
  private readonly FORCE_RESUME_MS = 10000; // Force resume after 10s to prevent indefinite pause
  private readonly CHECK_INTERVAL_MS = 2000; // Check every 2 seconds
  private isThrottling = false;
  private checkInterval: NodeJS.Timeout | null = null;
  private throttleStartTime = 0;

  start(): void {
    this.checkInterval = setInterval(() => this.checkResources(), this.CHECK_INTERVAL_MS);
    console.log("[ResourceGovernor] Started monitoring memory usage");
  }

  private checkResources(): void {
    const memory = process.memoryUsage();
    const heapUsedMb = memory.heapUsed / 1024 / 1024;
    // Use heap limit from V8, not heapTotal (which is current allocation, not max)
    const heapStats = v8.getHeapStatistics();
    const heapLimitMb = heapStats.heap_size_limit / 1024 / 1024;
    const utilizationPercent = (heapUsedMb / heapLimitMb) * 100;

    if (!this.isThrottling && utilizationPercent > this.MEMORY_LIMIT_PERCENT) {
      this.engageThrottle(heapUsedMb, utilizationPercent);
    } else if (this.isThrottling) {
      const throttleDuration = Date.now() - this.throttleStartTime;
      const shouldForceResume = throttleDuration > this.FORCE_RESUME_MS;
      const belowThreshold = utilizationPercent < this.RESUME_THRESHOLD_PERCENT;

      if (shouldForceResume || belowThreshold) {
        this.disengageThrottle(heapUsedMb, utilizationPercent, shouldForceResume);
      }
    }
  }

  private engageThrottle(currentUsageMb: number, percent: number): void {
    console.warn(
      `[ResourceGovernor] High memory usage (${Math.round(currentUsageMb)}MB, ${percent.toFixed(1)}%). Pausing all terminals.`
    );
    this.isThrottling = true;
    this.throttleStartTime = Date.now();

    // Pause all PTYs to stop new data from entering the heap
    const terminals = ptyManager.getAll();
    let pausedCount = 0;
    for (const term of terminals) {
      try {
        term.ptyProcess.pause();
        pausedCount++;
      } catch {
        // Ignore dead processes
      }
    }
    backpressureStats.pauseCount += pausedCount;
    console.log(`[ResourceGovernor] Paused ${pausedCount}/${terminals.length} terminals`);

    // Request aggressive GC if exposed
    if (global.gc) {
      global.gc();
    }

    sendEvent({
      type: "host-throttled",
      isThrottled: true,
      reason: `High memory usage: ${Math.round(currentUsageMb)}MB (${percent.toFixed(1)}%)`,
      timestamp: Date.now(),
    });
  }

  private disengageThrottle(currentUsageMb: number, percent: number, forced: boolean): void {
    const duration = Date.now() - this.throttleStartTime;
    console.log(
      `[ResourceGovernor] ${forced ? "Force resuming" : "Memory stabilized"} ` +
        `(${Math.round(currentUsageMb)}MB, ${percent.toFixed(1)}%). ` +
        `Resuming terminals after ${duration}ms.`
    );
    this.isThrottling = false;

    const terminals = ptyManager.getAll();
    let resumedCount = 0;
    for (const term of terminals) {
      try {
        term.ptyProcess.resume();
        resumedCount++;
      } catch {
        // Ignore dead processes
      }
    }
    console.log(`[ResourceGovernor] Resumed ${resumedCount}/${terminals.length} terminals`);

    sendEvent({
      type: "host-throttled",
      isThrottled: false,
      duration,
      timestamp: Date.now(),
    });
  }

  dispose(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log("[ResourceGovernor] Disposed");
  }
}

const ptyManager = new PtyManager();
const processTreeCache = new ProcessTreeCache(1000);
let ptyPool: PtyPool | null = null;
const resourceGovernor = new ResourceGovernor();

// Zero-copy ring buffers for terminal I/O (set via init-buffers message)
// Visual buffers: consumed by renderer (xterm.js) - critical path, sharded for isolation
// Analysis buffer: consumed by Web Worker - best-effort, can drop frames
let visualBuffers: SharedRingBuffer[] = [];
let visualSignalView: Int32Array | null = null;
let analysisBuffer: SharedRingBuffer | null = null;
const packetFramer = new PacketFramer();
const textDecoder = new TextDecoder();

// Track terminals paused due to ring buffer backpressure
// Maps terminal ID to the interval timer used for resume checking
const pausedTerminals = new Map<string, ReturnType<typeof setInterval>>();

// IPC flow control state
// Maps terminal ID to pending IPC data bytes and pause state
const ipcQueuedBytes = new Map<string, number>();
const ipcPausedTerminals = new Map<string, ReturnType<typeof setInterval>>();
const ipcPauseStartTimes = new Map<string, number>();

// PROTECTED INFRASTRUCTURE:
// SAB Backpressure System
// Pauses the PTY when the visual ring buffer is full to prevent memory explosions
// and UI overload. This is a critical stability guardrail.
//
// Debug stats
const backpressureStats = {
  pauseCount: 0,
  resumeCount: 0,
  suspendCount: 0,
  forceResumeCount: 0,
};

// Track terminal pause start times for duration calculation
const pauseStartTimes = new Map<string, number>();

// Track current terminal flow status to avoid duplicate events
const terminalStatuses = new Map<string, TerminalFlowStatus>();
const terminalActivityTiers = new Map<string, PtyHostActivityTier>();
const suspendedDueToStall = new Set<string>();
type PendingVisualSegment = {
  data: Uint8Array;
  offset: number;
};
const pendingVisualSegments = new Map<string, PendingVisualSegment[]>();
const pendingVisualBytes = new Map<string, number>();
let totalPendingVisualBytes = 0;

const MAX_PACKET_PAYLOAD = 65535;
const STREAM_STALL_SUSPEND_MS = 2000;
const MAX_PENDING_BYTES_PER_TERMINAL = 4 * 1024 * 1024;
const MAX_TOTAL_PENDING_BYTES = 16 * 1024 * 1024;

// Resume threshold - use hysteresis to prevent rapid pause/resume oscillation
const BACKPRESSURE_RESUME_THRESHOLD = 80; // Resume when buffer drops below 80%
const BACKPRESSURE_CHECK_INTERVAL_MS = 100; // Check every 100ms during backpressure
const BACKPRESSURE_MAX_PAUSE_MS = 5000; // Force resume after 5 seconds to prevent indefinite pause

// Helper to check if reliability metrics are enabled
function metricsEnabled(): boolean {
  return process.env.CANOPY_TERMINAL_METRICS === "1";
}

// Helper to emit terminal reliability metrics (gated by CANOPY_TERMINAL_METRICS)
function emitReliabilityMetric(payload: TerminalReliabilityMetricPayload): void {
  if (!metricsEnabled()) return;
  sendEvent({
    type: "terminal-reliability-metric",
    payload,
  });
}

// Helper to emit terminal status change (only on actual transitions)
function emitTerminalStatus(
  id: string,
  status: TerminalFlowStatus,
  bufferUtilization?: number,
  pauseDuration?: number
): void {
  const previousStatus = terminalStatuses.get(id);
  if (previousStatus === status) {
    return; // No change, don't emit
  }
  terminalStatuses.set(id, status);
  sendEvent({
    type: "terminal-status",
    id,
    status,
    bufferUtilization,
    pauseDuration,
    timestamp: Date.now(),
  });
}

function pendingBytesRemaining(segment: PendingVisualSegment): number {
  return Math.max(0, segment.data.length - segment.offset);
}

function enqueuePendingSegment(id: string, segment: PendingVisualSegment): boolean {
  const remaining = pendingBytesRemaining(segment);
  if (remaining <= 0) {
    return true;
  }

  const current = pendingVisualBytes.get(id) ?? 0;
  const nextTerminal = current + remaining;
  const nextTotal = totalPendingVisualBytes + remaining;

  if (nextTerminal > MAX_PENDING_BYTES_PER_TERMINAL || nextTotal > MAX_TOTAL_PENDING_BYTES) {
    return false;
  }

  const queue = pendingVisualSegments.get(id) ?? [];
  queue.push(segment);
  pendingVisualSegments.set(id, queue);
  pendingVisualBytes.set(id, nextTerminal);
  totalPendingVisualBytes = nextTotal;
  return true;
}

function consumePendingBytes(id: string, bytes: number): void {
  if (bytes <= 0) return;
  const current = pendingVisualBytes.get(id);
  if (current === undefined) return;
  const next = current - bytes;
  if (next <= 0) {
    pendingVisualBytes.delete(id);
  } else {
    pendingVisualBytes.set(id, next);
  }
  totalPendingVisualBytes = Math.max(0, totalPendingVisualBytes - bytes);
}

function clearPendingVisual(id: string): void {
  const pendingBytes = pendingVisualBytes.get(id);
  if (pendingBytes !== undefined) {
    totalPendingVisualBytes = Math.max(0, totalPendingVisualBytes - pendingBytes);
    pendingVisualBytes.delete(id);
  }
  pendingVisualSegments.delete(id);
}

// IPC flow control helpers
function getIpcQueueUtilization(id: string): number {
  const bytes = ipcQueuedBytes.get(id) ?? 0;
  return (bytes / IPC_MAX_QUEUE_BYTES) * 100;
}

function addIpcBytes(id: string, bytes: number): number {
  const current = ipcQueuedBytes.get(id) ?? 0;
  const next = current + bytes;
  ipcQueuedBytes.set(id, next);
  return next;
}

function removeIpcBytes(id: string, bytes: number): void {
  const current = ipcQueuedBytes.get(id) ?? 0;
  const next = Math.max(0, current - bytes);
  if (next === 0) {
    ipcQueuedBytes.delete(id);
  } else {
    ipcQueuedBytes.set(id, next);
  }
}

function clearIpcQueue(id: string): void {
  ipcQueuedBytes.delete(id);
  const checkInterval = ipcPausedTerminals.get(id);
  if (checkInterval) {
    clearInterval(checkInterval);
    ipcPausedTerminals.delete(id);
  }
  ipcPauseStartTimes.delete(id);
}

function suspendVisualStream(
  id: string,
  reason: string,
  utilization?: number,
  pauseDuration?: number,
  shardIndex?: number
): void {
  const terminal = ptyManager.getTerminal(id);
  if (terminal?.ptyProcess) {
    try {
      terminal.ptyProcess.resume();
    } catch {
      // ignore
    }
  }

  const checkInterval = pausedTerminals.get(id);
  if (checkInterval) {
    clearInterval(checkInterval);
    pausedTerminals.delete(id);
  }
  pauseStartTimes.delete(id);

  suspendedDueToStall.add(id);
  clearPendingVisual(id);

  emitTerminalStatus(id, "suspended", utilization, pauseDuration);

  if (utilization !== undefined) {
    console.warn(
      `[PtyHost] Suspended streaming for ${id} (${reason}) (buffer ${utilization.toFixed(1)}%).`
    );
  } else {
    console.warn(`[PtyHost] Suspended streaming for ${id} (${reason}).`);
  }

  emitReliabilityMetric({
    terminalId: id,
    metricType: "suspend",
    timestamp: Date.now(),
    durationMs: pauseDuration,
    bufferUtilization: utilization,
    shardIndex,
  });
}

// MessagePort for direct Renderer ↔ Pty Host communication (bypasses Main)
// Note: This variable holds the port reference so the message handler stays active
let rendererPort: MessagePort | null = null;
let rendererPortMessageHandler: ((event: any) => void) | null = null;

// Helper to send events to Main process
function sendEvent(event: PtyHostEvent): void {
  port.postMessage(event);
}

// Helper to convert data to string for IPC fallback (IPC events expect string)
function toStringForIpc(data: string | Uint8Array): string {
  return typeof data === "string" ? data : textDecoder.decode(data);
}

// Wire up PtyManager events
ptyManager.on("data", (id: string, data: string | Uint8Array) => {
  // Terminal output always updates headless state; visual streaming can be suspended under backpressure.
  const isSuspended = suspendedDueToStall.has(id);
  if (isSuspended) {
    return;
  }
  const terminalInfo = ptyManager.getTerminal(id);
  // Agent terminals use snapshot projection and do not consume the raw visual stream.
  // Writing agent output into the visual ring buffer would immediately backpressure the PTY.
  // Check kind, agentId, or type to determine if this is an agent terminal
  const skipVisualStream =
    terminalInfo?.kind === "agent" ||
    !!terminalInfo?.agentId ||
    (terminalInfo?.type && terminalInfo.type !== "terminal");
  // PRIORITY 1: VISUAL RENDERER (Zero-Latency Path)
  // Write to SharedArrayBuffer immediately before doing ANY processing.
  // This ensures terminal output reaches xterm.js with minimal latency.
  let visualWritten = false;

  if (!skipVisualStream && visualBuffers.length > 0) {
    const shardIndex = selectShard(id, visualBuffers.length);
    const shard = visualBuffers[shardIndex];

    const dataBytes = typeof data === "string" ? Buffer.from(data) : data;
    let wroteAny = false;
    let offset = 0;

    while (offset < dataBytes.length) {
      const nextOffset = Math.min(offset + MAX_PACKET_PAYLOAD, dataBytes.length);
      const chunk = dataBytes.subarray(offset, nextOffset);
      const packet = packetFramer.frame(id, chunk);

      if (!packet) {
        break;
      }

      const bytesWritten = shard.write(packet);

      if (bytesWritten === 0) {
        // Ring buffer is full - apply backpressure by pausing the PTY
        const queued = enqueuePendingSegment(id, { data: dataBytes, offset });
        visualWritten = true; // partial write counts as handled

        if (!queued) {
          const utilization = shard.getUtilization();
          const pauseStart = pauseStartTimes.get(id);
          const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
          suspendVisualStream(id, "pending cap exceeded", utilization, pauseDuration, shardIndex);
        } else if (!pausedTerminals.has(id)) {
          const utilization = shard.getUtilization();
          console.warn(
            `[PtyHost] Visual buffer full (${utilization.toFixed(1)}% utilized). Pausing PTY ${id} for backpressure.`
          );

          const terminal = ptyManager.getTerminal(id);
          if (!terminal?.ptyProcess) {
            console.warn(
              `[PtyHost] Cannot apply backpressure: missing PTY process for ${id}. Falling back to IPC.`
            );
            // Note: We already partially wrote to SAB, falling back to IPC for remainder is tricky/racy.
            // Since we buffered the remainder in pendingVisualSegments, we just stick to the pause logic.
            break;
          }
          try {
            terminal.ptyProcess.pause();
          } catch (error) {
            console.error(`[PtyHost] Failed to pause PTY ${id}:`, error);
            break;
          }

          // Track when we started pausing for timeout safety
          const pauseStartTime = Date.now();
          pauseStartTimes.set(id, pauseStartTime);

          // Emit status event for UI
          emitTerminalStatus(id, "paused-backpressure", utilization);

          // Emit metrics for pause-start
          emitReliabilityMetric({
            terminalId: id,
            metricType: "pause-start",
            timestamp: pauseStartTime,
            bufferUtilization: utilization,
            shardIndex,
          });

          // Start monitoring for buffer clearance
          const checkInterval = setInterval(() => {
            if (visualBuffers.length === 0) {
              // Buffer disappeared - resume PTY if still exists
              const terminal = ptyManager.getTerminal(id);
              if (terminal?.ptyProcess) {
                try {
                  terminal.ptyProcess.resume();
                  console.log(`[PtyHost] Visual buffers removed. Resumed PTY ${id}`);
                  // Emit resume status
                  const pauseDuration = Date.now() - (pauseStartTimes.get(id) ?? pauseStartTime);
                  emitTerminalStatus(id, "running", undefined, pauseDuration);

                  // Emit metrics for pause-end
                  emitReliabilityMetric({
                    terminalId: id,
                    metricType: "pause-end",
                    timestamp: Date.now(),
                    durationMs: pauseDuration,
                  });
                } catch (error) {
                  console.error(
                    `[PtyHost] Failed to resume PTY ${id} after buffer removal:`,
                    error
                  );
                }
              }
              clearInterval(checkInterval);
              pausedTerminals.delete(id);
              pauseStartTimes.delete(id);
              clearPendingVisual(id);
              return;
            }

            const shardIndex = selectShard(id, visualBuffers.length);
            const shard = visualBuffers[shardIndex];
            const currentUtilization = shard.getUtilization();
            const pauseDuration = Date.now() - pauseStartTime;

            // If the stream is stalled for too long, stop streaming for this terminal
            // and rely on headless state + explicit wake to restore fidelity.
            if (pauseDuration > STREAM_STALL_SUSPEND_MS) {
              suspendVisualStream(
                id,
                `${pauseDuration}ms stall`,
                currentUtilization,
                pauseDuration,
                shardIndex
              );
              return;
            }

            // Force resume if paused too long (safety against indefinite pause)
            if (pauseDuration > BACKPRESSURE_MAX_PAUSE_MS) {
              const terminal = ptyManager.getTerminal(id);
              if (terminal?.ptyProcess) {
                try {
                  // If we still can't flush the pending packet, stop streaming and rely on wake.
                  if (pendingVisualSegments.has(id)) {
                    suspendVisualStream(
                      id,
                      `${pauseDuration}ms max pause`,
                      currentUtilization,
                      pauseDuration,
                      shardIndex
                    );
                  } else {
                    terminal.ptyProcess.resume();
                    console.warn(
                      `[PtyHost] Force resumed PTY ${id} after ${pauseDuration}ms (buffer at ${currentUtilization.toFixed(1)}%). ` +
                        `Consumer may be stalled.`
                    );
                    // Emit resume status with duration
                    emitTerminalStatus(id, "running", currentUtilization, pauseDuration);

                    // Emit metrics for pause-end (force resume path)
                    emitReliabilityMetric({
                      terminalId: id,
                      metricType: "pause-end",
                      timestamp: Date.now(),
                      durationMs: pauseDuration,
                      bufferUtilization: currentUtilization,
                    });
                  }
                } catch (error) {
                  console.error(`[PtyHost] Failed to force resume PTY ${id}:`, error);
                }
              }
              clearInterval(checkInterval);
              pausedTerminals.delete(id);
              pauseStartTimes.delete(id);
              return;
            }

            // Resume when buffer drops below threshold (hysteresis to prevent rapid pause/resume)
            if (currentUtilization < BACKPRESSURE_RESUME_THRESHOLD) {
              const pending = pendingVisualSegments.get(id);
              if (pending && pending.length > 0) {
                let wrotePending = false;
                while (pending.length > 0) {
                  const segment = pending[0];
                  while (segment.offset < segment.data.length) {
                    const end = Math.min(segment.offset + MAX_PACKET_PAYLOAD, segment.data.length);
                    const pendingChunk = segment.data.subarray(segment.offset, end);
                    const pendingPacket = packetFramer.frame(id, pendingChunk);
                    if (!pendingPacket) {
                      const remaining = segment.data.length - segment.offset;
                      consumePendingBytes(id, remaining);
                      segment.offset = segment.data.length;
                      break;
                    }
                    const pendingWritten = shard.write(pendingPacket);
                    if (pendingWritten === 0) {
                      if (wrotePending && visualSignalView) {
                        Atomics.add(visualSignalView, 0, 1);
                        Atomics.notify(visualSignalView, 0, 1);
                      }
                      return; // Still full
                    }
                    wrotePending = true;
                    segment.offset = end;
                    consumePendingBytes(id, pendingChunk.length);
                  }

                  if (segment.offset >= segment.data.length) {
                    pending.shift();
                  } else {
                    break;
                  }
                }

                if (wrotePending && visualSignalView) {
                  Atomics.add(visualSignalView, 0, 1);
                  Atomics.notify(visualSignalView, 0, 1);
                }

                if (pending.length === 0) {
                  clearPendingVisual(id);
                }
              }

              if (!pendingVisualSegments.has(id)) {
                const terminal = ptyManager.getTerminal(id);
                if (terminal?.ptyProcess) {
                  try {
                    terminal.ptyProcess.resume();
                    console.log(
                      `[PtyHost] Buffer cleared to ${currentUtilization.toFixed(1)}%. Resumed PTY ${id}`
                    );
                    // Emit resume status with duration
                    emitTerminalStatus(id, "running", currentUtilization, pauseDuration);

                    // Emit metrics for pause-end (normal resume path)
                    emitReliabilityMetric({
                      terminalId: id,
                      metricType: "pause-end",
                      timestamp: Date.now(),
                      durationMs: pauseDuration,
                      bufferUtilization: currentUtilization,
                    });
                  } catch (error) {
                    console.error(`[PtyHost] Failed to resume PTY ${id}:`, error);
                  }
                }
                clearInterval(checkInterval);
                pausedTerminals.delete(id);
                pauseStartTimes.delete(id);
              }
            }
          }, BACKPRESSURE_CHECK_INTERVAL_MS);

          pausedTerminals.set(id, checkInterval);
        }
        break; // Stop writing packets
      }

      wroteAny = true;
      offset = nextOffset;
    }

    if (wroteAny) {
      visualWritten = true;
      if (visualSignalView) {
        Atomics.add(visualSignalView, 0, 1);
        Atomics.notify(visualSignalView, 0, 1);
      }
    }
  }

  // Fallback: If ring buffer failed or isn't set up, use IPC with backpressure
  if (!visualWritten) {
    const dataString = toStringForIpc(data);
    const dataBytes = Buffer.byteLength(dataString, "utf8");
    const currentQueuedBytes = ipcQueuedBytes.get(id) ?? 0;

    // Enforce hard cap: drop data if adding it would exceed max queue size
    // This prevents unbounded memory growth when renderer is stalled
    if (currentQueuedBytes + dataBytes > IPC_MAX_QUEUE_BYTES) {
      const utilization = getIpcQueueUtilization(id);
      console.warn(
        `[PtyHost] IPC queue full (${utilization.toFixed(1)}%). Dropping ${dataBytes} bytes for terminal ${id}`
      );
      emitReliabilityMetric({
        terminalId: id,
        metricType: "suspend",
        timestamp: Date.now(),
        bufferUtilization: utilization,
      });
      return; // Drop this chunk to prevent OOM
    }

    const totalQueued = addIpcBytes(id, dataBytes);
    const utilization = getIpcQueueUtilization(id);

    // Send the data via IPC
    sendEvent({ type: "data", id, data: dataString });

    // Apply backpressure if queue exceeds high watermark
    const highWatermarkBytes = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    if (totalQueued >= highWatermarkBytes && !ipcPausedTerminals.has(id)) {
      const terminal = ptyManager.getTerminal(id);
      if (!terminal?.ptyProcess) {
        console.warn(
          `[PtyHost] Cannot apply IPC backpressure: missing PTY process for ${id}. Queue at ${utilization.toFixed(1)}%`
        );
      } else {
        try {
          terminal.ptyProcess.pause();
          console.warn(
            `[PtyHost] IPC queue high (${utilization.toFixed(1)}%). Pausing PTY ${id} for backpressure.`
          );

          const pauseStartTime = Date.now();
          ipcPauseStartTimes.set(id, pauseStartTime);

          emitTerminalStatus(id, "paused-backpressure", utilization);
          emitReliabilityMetric({
            terminalId: id,
            metricType: "pause-start",
            timestamp: pauseStartTime,
            bufferUtilization: utilization,
          });

          // Monitor queue and resume when it drops below low watermark
          const checkInterval = setInterval(() => {
            const currentUtilization = getIpcQueueUtilization(id);
            const lowWatermarkBytes = (IPC_MAX_QUEUE_BYTES * IPC_LOW_WATERMARK_PERCENT) / 100;
            const currentBytes = ipcQueuedBytes.get(id) ?? 0;
            const pauseDuration = Date.now() - pauseStartTime;

            // Force resume if paused too long (safety against indefinite pause)
            if (pauseDuration > IPC_MAX_PAUSE_MS) {
              const terminal = ptyManager.getTerminal(id);
              if (terminal?.ptyProcess) {
                try {
                  terminal.ptyProcess.resume();
                  console.warn(
                    `[PtyHost] Force resumed IPC PTY ${id} after ${pauseDuration}ms (queue at ${currentUtilization.toFixed(1)}%). Consumer may be stalled.`
                  );
                  emitTerminalStatus(id, "running", currentUtilization, pauseDuration);
                  emitReliabilityMetric({
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
              clearInterval(checkInterval);
              ipcPausedTerminals.delete(id);
              ipcPauseStartTimes.delete(id);
              return;
            }

            // Resume when queue drops below low watermark
            if (currentBytes < lowWatermarkBytes) {
              const terminal = ptyManager.getTerminal(id);
              if (terminal?.ptyProcess) {
                try {
                  terminal.ptyProcess.resume();
                  console.log(
                    `[PtyHost] IPC queue cleared to ${currentUtilization.toFixed(1)}%. Resumed PTY ${id}`
                  );
                  emitTerminalStatus(id, "running", currentUtilization, pauseDuration);
                  emitReliabilityMetric({
                    terminalId: id,
                    metricType: "pause-end",
                    timestamp: Date.now(),
                    durationMs: pauseDuration,
                    bufferUtilization: currentUtilization,
                  });
                } catch (error) {
                  console.error(`[PtyHost] Failed to resume IPC PTY ${id}:`, error);
                }
              }
              clearInterval(checkInterval);
              ipcPausedTerminals.delete(id);
              ipcPauseStartTimes.delete(id);
            }
          }, IPC_BACKPRESSURE_CHECK_INTERVAL_MS);

          ipcPausedTerminals.set(id, checkInterval);
        } catch (error) {
          console.error(`[PtyHost] Failed to pause IPC PTY ${id}:`, error);
        }
      }
    }
  }

  // PRIORITY 2: BACKGROUND TASKS (Deferred Processing)
  // Now that pixels are on their way to the screen, we can do heavy work.

  // Semantic Analysis (Worker) - best-effort, can drop frames
  // Only write to analysis buffer if terminal has analysis enabled (agent terminals)
  if (analysisBuffer && terminalInfo?.analysisEnabled) {
    const analysisPacket = packetFramer.frame(id, data);
    if (analysisPacket) {
      const analysisWritten = analysisBuffer.write(analysisPacket);
      if (analysisWritten === 0 && process.env.CANOPY_VERBOSE) {
        console.log(`[PtyHost] Analysis buffer full - dropping frame for terminal ${id}`);
      }
    }
  }
});

ptyManager.on("exit", (id: string, exitCode: number) => {
  // Clean up any active backpressure monitoring for this terminal
  const checkInterval = pausedTerminals.get(id);
  if (checkInterval) {
    clearInterval(checkInterval);
    pausedTerminals.delete(id);
  }
  pauseStartTimes.delete(id);
  terminalStatuses.delete(id);
  terminalActivityTiers.delete(id);
  suspendedDueToStall.delete(id);
  clearPendingVisual(id);

  // Clean up IPC backpressure state
  clearIpcQueue(id);

  sendEvent({ type: "exit", id, exitCode });
});

ptyManager.on("error", (id: string, error: string) => {
  sendEvent({ type: "error", id, error });
});

// Forward internal event bus events to Main
events.on("agent:state-changed", (payload) => {
  // Only forward if terminalId is defined
  if (payload.terminalId) {
    sendEvent({
      type: "agent-state",
      id: payload.terminalId,
      state: payload.state,
      previousState: payload.previousState,
      timestamp: payload.timestamp,
      traceId: payload.traceId,
      trigger: payload.trigger,
      confidence: payload.confidence,
      worktreeId: payload.worktreeId,
    });
  }
});

events.on("agent:detected", (payload) => {
  sendEvent({
    type: "agent-detected",
    terminalId: payload.terminalId,
    agentType: payload.agentType,
    processName: payload.processName,
    timestamp: payload.timestamp,
  });
});

events.on("agent:exited", (payload) => {
  sendEvent({
    type: "agent-exited",
    terminalId: payload.terminalId,
    agentType: payload.agentType,
    timestamp: payload.timestamp,
  });
});

events.on("agent:spawned", (payload) => {
  sendEvent({
    type: "agent-spawned",
    payload: {
      agentId: payload.agentId,
      terminalId: payload.terminalId,
      type: payload.type,
      worktreeId: payload.worktreeId,
      timestamp: payload.timestamp,
    },
  });
});

events.on("agent:output", (payload) => {
  sendEvent({
    type: "agent-output",
    payload: {
      agentId: payload.agentId,
      data: payload.data,
      timestamp: payload.timestamp,
      traceId: payload.traceId,
      terminalId: payload.terminalId,
      worktreeId: payload.worktreeId,
    },
  });
});

events.on("agent:completed", (payload) => {
  sendEvent({
    type: "agent-completed",
    payload: {
      agentId: payload.agentId,
      exitCode: payload.exitCode,
      duration: payload.duration,
      timestamp: payload.timestamp,
      traceId: payload.traceId,
      terminalId: payload.terminalId,
      worktreeId: payload.worktreeId,
    },
  });
});

events.on("agent:failed", (payload) => {
  sendEvent({
    type: "agent-failed",
    payload: {
      agentId: payload.agentId,
      error: payload.error,
      timestamp: payload.timestamp,
      traceId: payload.traceId,
      terminalId: payload.terminalId,
      worktreeId: payload.worktreeId,
    },
  });
});

events.on("agent:killed", (payload) => {
  sendEvent({
    type: "agent-killed",
    payload: {
      agentId: payload.agentId,
      reason: payload.reason,
      timestamp: payload.timestamp,
      traceId: payload.traceId,
      terminalId: payload.terminalId,
      worktreeId: payload.worktreeId,
    },
  });
});

events.on("terminal:trashed", (payload) => {
  sendEvent({
    type: "terminal-trashed",
    id: payload.id,
    expiresAt: payload.expiresAt,
  });
});

events.on("terminal:restored", (payload) => {
  sendEvent({
    type: "terminal-restored",
    id: payload.id,
  });
});

// Convert internal terminal snapshot to IPC-safe format
function toHostSnapshot(id: string): PtyHostTerminalSnapshot | null {
  const snapshot = ptyManager.getTerminalSnapshot(id);
  if (!snapshot) return null;

  return {
    id: snapshot.id,
    lines: snapshot.lines,
    lastInputTime: snapshot.lastInputTime,
    lastOutputTime: snapshot.lastOutputTime,
    lastCheckTime: snapshot.lastCheckTime,
    type: snapshot.type,
    worktreeId: snapshot.worktreeId,
    agentId: snapshot.agentId,
    agentState: snapshot.agentState,
    lastStateChange: snapshot.lastStateChange,
    error: snapshot.error,
    spawnedAt: snapshot.spawnedAt,
  };
}

// Handle requests from Main
port.on("message", async (rawMsg: any) => {
  // Electron/Node might wrap the message in { data: ..., ports: [] }
  const msg = rawMsg?.data ? rawMsg.data : rawMsg;
  const ports = rawMsg?.ports || [];

  try {
    switch (msg.type) {
      case "connect-port":
        // Receive MessagePort for direct Renderer ↔ Pty Host communication
        if (ports && ports.length > 0) {
          const receivedPort = ports[0] as MessagePort;
          if (rendererPort === receivedPort && rendererPortMessageHandler) {
            try {
              receivedPort.start();
            } catch {
              // ignore
            }
            console.log("[PtyHost] MessagePort already connected, ignoring duplicate connect-port");
            break;
          }

          if (rendererPort) {
            if (rendererPortMessageHandler) {
              try {
                rendererPort.removeListener("message", rendererPortMessageHandler);
              } catch {
                // ignore
              }
            }
            try {
              rendererPort.close();
            } catch {
              // ignore
            }
          }

          rendererPort = receivedPort;
          receivedPort.start();
          console.log("[PtyHost] MessagePort received from Main, starting listener...");

          rendererPortMessageHandler = (event: any) => {
            const portMsg = event?.data ? event.data : event;

            // Validate message structure
            if (!portMsg || typeof portMsg !== "object") {
              console.warn("[PtyHost] Invalid MessagePort message:", portMsg);
              return;
            }

            try {
              if (
                portMsg.type === "write" &&
                typeof portMsg.id === "string" &&
                typeof portMsg.data === "string"
              ) {
                ptyManager.write(portMsg.id, portMsg.data, portMsg.traceId);
              } else if (
                portMsg.type === "resize" &&
                typeof portMsg.id === "string" &&
                typeof portMsg.cols === "number" &&
                typeof portMsg.rows === "number"
              ) {
                ptyManager.resize(portMsg.id, portMsg.cols, portMsg.rows);
              } else {
                console.warn(
                  "[PtyHost] Unknown or invalid MessagePort message type:",
                  portMsg.type
                );
              }
            } catch (error) {
              console.error("[PtyHost] Error handling MessagePort message:", error);
            }
          };

          receivedPort.on("message", rendererPortMessageHandler);

          console.log("[PtyHost] MessagePort listener installed");
        } else {
          console.warn("[PtyHost] connect-port message received but no ports provided");
        }
        break;

      case "init-buffers": {
        const visualOk =
          Array.isArray(msg.visualBuffers) &&
          msg.visualBuffers.every((b: unknown) => b instanceof SharedArrayBuffer);
        const analysisOk = msg.analysisBuffer instanceof SharedArrayBuffer;
        const signalOk = msg.visualSignalBuffer instanceof SharedArrayBuffer;

        if (visualOk) {
          visualBuffers = msg.visualBuffers.map(
            (buf: SharedArrayBuffer) => new SharedRingBuffer(buf)
          );
          ptyManager.setSabMode(true);
        } else {
          console.warn("[PtyHost] init-buffers: visualBuffers missing or invalid (IPC mode)");
        }

        if (signalOk) {
          visualSignalView = new Int32Array(msg.visualSignalBuffer);
        } else {
          console.warn("[PtyHost] init-buffers: visualSignalBuffer missing or invalid");
        }

        if (analysisOk) {
          analysisBuffer = new SharedRingBuffer(msg.analysisBuffer);
        } else {
          console.warn("[PtyHost] init-buffers: analysisBuffer is not SharedArrayBuffer");
        }

        console.log(
          `[PtyHost] Buffers initialized: visual=${visualOk ? `${visualBuffers.length} shards` : "IPC"} signal=${signalOk ? "SAB" : "disabled"} analysis=${
            analysisOk ? "SAB" : "disabled"
          } sabMode=${ptyManager.isSabMode()}`
        );
        break;
      }

      case "set-active-project": {
        ptyManager.setActiveProject(msg.projectId);
        break;
      }

      case "project-switch": {
        ptyManager.onProjectSwitch(msg.projectId);
        ptyManager.setActiveProject(msg.projectId);
        break;
      }

      case "spawn":
        ptyManager.spawn(msg.id, msg.options);
        {
          const terminalInfo = ptyManager.getTerminal(msg.id);
          const pid = terminalInfo?.ptyProcess?.pid;
          if (pid !== undefined) {
            sendEvent({ type: "terminal-pid", id: msg.id, pid });
          }
        }
        break;

      case "write":
        ptyManager.write(msg.id, msg.data, msg.traceId);
        break;

      case "submit":
        ptyManager.submit(msg.id, msg.text);
        break;

      case "resize":
        ptyManager.resize(msg.id, msg.cols, msg.rows);
        break;

      case "kill":
        ptyManager.kill(msg.id, msg.reason);
        break;

      case "trash":
        ptyManager.trash(msg.id);
        break;

      case "restore":
        ptyManager.restore(msg.id);
        break;

      case "set-activity-tier": {
        const tier = msg.tier === "background" ? "background" : "active";
        terminalActivityTiers.set(msg.id, tier);

        // If tier flips, clear any stall suspension and unblock the PTY.
        suspendedDueToStall.delete(msg.id);
        clearPendingVisual(msg.id);

        const checkInterval = pausedTerminals.get(msg.id);
        const wasPaused = checkInterval !== undefined;
        if (checkInterval) {
          clearInterval(checkInterval);
          pausedTerminals.delete(msg.id);
        }

        const pauseStart = pauseStartTimes.get(msg.id);
        const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
        pauseStartTimes.delete(msg.id);

        const terminal = ptyManager.getTerminal(msg.id);
        if (terminal?.ptyProcess) {
          try {
            terminal.ptyProcess.resume();
          } catch {
            // ignore
          }
        }

        emitTerminalStatus(msg.id, "running");

        // Emit metrics for pause-end (set-activity-tier unpause path)
        if (wasPaused && pauseDuration !== undefined) {
          emitReliabilityMetric({
            terminalId: msg.id,
            metricType: "pause-end",
            timestamp: Date.now(),
            durationMs: pauseDuration,
          });
        }
        break;
      }

      case "wake-terminal": {
        const wakeStartTime = Date.now();

        // Wake implies we want a faithful snapshot + resume streaming.
        terminalActivityTiers.set(msg.id, "active");
        suspendedDueToStall.delete(msg.id);
        clearPendingVisual(msg.id);

        // Clear any active pause interval and timing
        const checkInterval = pausedTerminals.get(msg.id);
        if (checkInterval) {
          clearInterval(checkInterval);
          pausedTerminals.delete(msg.id);
        }
        pauseStartTimes.delete(msg.id);

        // Best-effort warning: cwd missing
        const warnings: string[] = [];
        try {
          const terminal = ptyManager.getTerminal(msg.id);
          if (terminal?.cwd && typeof terminal.cwd === "string") {
            const fs = await import("node:fs");
            if (!fs.existsSync(terminal.cwd)) {
              warnings.push("cwd-missing");
            }
          }
        } catch {
          // ignore
        }

        let state: string | null = null;
        try {
          state = await ptyManager.getSerializedStateAsync(msg.id);
        } catch {
          state = ptyManager.getSerializedState(msg.id);
        }

        const wakeLatencyMs = Date.now() - wakeStartTime;

        emitTerminalStatus(msg.id, "running");

        // Emit wake latency metrics (only if enabled to avoid overhead)
        if (metricsEnabled() && state) {
          const { Buffer } = await import("node:buffer");
          const serializedStateBytes = Buffer.byteLength(state, "utf8");
          emitReliabilityMetric({
            terminalId: msg.id,
            metricType: "wake-latency",
            timestamp: Date.now(),
            wakeLatencyMs,
            serializedStateBytes,
          });
        }

        sendEvent({
          type: "wake-result",
          requestId: msg.requestId,
          id: msg.id,
          state,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
        break;
      }

      case "kill-by-project": {
        const killed = ptyManager.killByProject(msg.projectId);
        sendEvent({ type: "kill-by-project-result", requestId: msg.requestId, killed });
        break;
      }

      case "get-project-stats": {
        const stats = ptyManager.getProjectStats(msg.projectId);
        sendEvent({ type: "project-stats", requestId: msg.requestId, stats });
        break;
      }

      case "acknowledge-data": {
        // Acknowledge data consumption from renderer to manage IPC backpressure
        // Renderer now sends exact byte count (not character count) for accurate accounting
        const acknowledgedBytes = msg.charCount ?? 0;
        removeIpcBytes(msg.id, acknowledgedBytes);

        // Note: ptyManager.acknowledgeData is still a no-op for SAB mode compatibility
        ptyManager.acknowledgeData(msg.id, acknowledgedBytes);
        break;
      }

      case "set-analysis-enabled":
        if (typeof msg.id === "string" && typeof msg.enabled === "boolean") {
          ptyManager.setAnalysisEnabled(msg.id, msg.enabled);
        } else {
          console.warn("[PtyHost] Invalid set-analysis-enabled message:", msg);
        }
        break;

      case "get-snapshot":
        sendEvent({
          type: "snapshot",
          id: msg.id,
          snapshot: toHostSnapshot(msg.id),
        });
        break;

      case "get-all-snapshots":
        sendEvent({
          type: "all-snapshots",
          snapshots: ptyManager.getAllTerminalSnapshots().map((s) => ({
            id: s.id,
            lines: s.lines,
            lastInputTime: s.lastInputTime,
            lastOutputTime: s.lastOutputTime,
            lastCheckTime: s.lastCheckTime,
            type: s.type,
            worktreeId: s.worktreeId,
            agentId: s.agentId,
            agentState: s.agentState,
            lastStateChange: s.lastStateChange,
            error: s.error,
            spawnedAt: s.spawnedAt,
          })),
        });
        break;

      case "mark-checked":
        ptyManager.markChecked(msg.id);
        break;

      case "transition-state": {
        const success = ptyManager.transitionState(
          msg.id,
          msg.event as AgentEvent,
          msg.trigger as
            | "input"
            | "output"
            | "heuristic"
            | "ai-classification"
            | "timeout"
            | "exit",
          msg.confidence,
          msg.spawnedAt
        );
        sendEvent({ type: "transition-result", id: msg.id, requestId: msg.requestId, success });
        break;
      }

      case "health-check":
        sendEvent({ type: "pong" });
        break;

      case "pause-all": {
        console.log("[PtyHost] Pausing all PTY processes for system sleep");
        const terminals = ptyManager.getAll();
        let pausedCount = 0;

        for (const terminal of terminals) {
          try {
            terminal.ptyProcess.pause();
            pausedCount++;
          } catch {
            // Ignore errors - process may already be dead
          }
        }

        console.log(`[PtyHost] Paused ${pausedCount}/${terminals.length} PTY processes`);
        break;
      }

      case "resume-all": {
        console.log("[PtyHost] Resuming all PTY processes after system wake");
        const terminals = ptyManager.getAll();

        if (terminals.length === 0) {
          console.log("[PtyHost] No PTY processes to resume");
          break;
        }

        // Resume incrementally to prevent thundering herd
        // Stagger by 50ms to spread disk/CPU load
        const RESUME_STAGGER_MS = 50;
        let i = 0;

        const resumeInterval = setInterval(() => {
          if (i >= terminals.length) {
            clearInterval(resumeInterval);
            console.log(`[PtyHost] Resumed all ${terminals.length} PTY processes`);
            return;
          }

          const terminal = terminals[i++];
          try {
            terminal.ptyProcess.resume();
          } catch {
            // Ignore errors - process may be dead
          }
        }, RESUME_STAGGER_MS);
        break;
      }

      case "get-terminals-for-project":
        sendEvent({
          type: "terminals-for-project",
          requestId: msg.requestId,
          terminalIds: ptyManager.getTerminalsForProject(msg.projectId),
        });
        break;

      case "get-terminal": {
        const terminal = ptyManager.getTerminal(msg.id);
        sendEvent({
          type: "terminal-info",
          requestId: msg.requestId,
          terminal: terminal
            ? {
                id: terminal.id,
                projectId: terminal.projectId,
                kind: terminal.kind,
                type: terminal.type,
                agentId: terminal.agentId,
                title: terminal.title,
                cwd: terminal.cwd,
                worktreeId: terminal.worktreeId,
                agentState: terminal.agentState,
                lastStateChange: terminal.lastStateChange,
                spawnedAt: terminal.spawnedAt,
                isTrashed: terminal.isTrashed,
                trashExpiresAt: terminal.trashExpiresAt,
              }
            : null,
        });
        break;
      }

      case "replay-history": {
        const replayed = ptyManager.replayHistory(msg.id, msg.maxLines);
        sendEvent({
          type: "replay-history-result",
          requestId: msg.requestId,
          replayed,
        });
        break;
      }

      case "get-serialized-state": {
        (async () => {
          try {
            const serializedState = await ptyManager.getSerializedStateAsync(msg.id);
            sendEvent({
              type: "serialized-state",
              requestId: msg.requestId,
              id: msg.id,
              state: serializedState,
            });
          } catch (error) {
            console.error(`[PtyHost] Failed to serialize terminal ${msg.id}:`, error);
            sendEvent({
              type: "serialized-state",
              requestId: msg.requestId,
              id: msg.id,
              state: null,
            });
          }
        })();
        break;
      }

      case "get-terminal-info": {
        const info = ptyManager.getTerminalInfo(msg.id);
        sendEvent({
          type: "terminal-diagnostic-info",
          requestId: msg.requestId,
          info,
        });
        break;
      }

      case "force-resume": {
        const terminal = ptyManager.getTerminal(msg.id);
        if (terminal?.ptyProcess) {
          try {
            terminal.ptyProcess.resume();
            console.log(`[PtyHost] Force resumed PTY ${msg.id} via user request`);

            // Clean up any pending backpressure monitoring
            const checkInterval = pausedTerminals.get(msg.id);
            if (checkInterval) {
              clearInterval(checkInterval);
              pausedTerminals.delete(msg.id);
            }
            clearPendingVisual(msg.id);

            // Calculate pause duration if we have a start time
            const pauseStart = pauseStartTimes.get(msg.id);
            const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
            pauseStartTimes.delete(msg.id);

            // Emit resume status
            const utilization =
              visualBuffers.length > 0
                ? visualBuffers[selectShard(msg.id, visualBuffers.length)].getUtilization()
                : undefined;
            emitTerminalStatus(msg.id, "running", utilization, pauseDuration);

            // Emit metrics for pause-end (user force-resume path)
            if (pauseDuration !== undefined) {
              emitReliabilityMetric({
                terminalId: msg.id,
                metricType: "pause-end",
                timestamp: Date.now(),
                durationMs: pauseDuration,
                bufferUtilization: utilization,
              });
            }
          } catch (error) {
            console.error(`[PtyHost] Failed to force resume PTY ${msg.id}:`, error);
          }
        } else {
          console.warn(`[PtyHost] Cannot force resume - terminal ${msg.id} not found`);
        }
        break;
      }

      case "dispose":
        cleanup();
        break;

      default:
        console.warn("[PtyHost] Unknown message type:", (msg as { type: string }).type);
    }
  } catch (error) {
    console.error("[PtyHost] Error handling message:", error);
  }
});

function cleanup(): void {
  console.log("[PtyHost] Disposing resources...");

  resourceGovernor.dispose();

  // Clear all backpressure monitoring intervals
  for (const [id, checkInterval] of pausedTerminals) {
    clearInterval(checkInterval);
    console.log(`[PtyHost] Cleared backpressure monitor for terminal ${id}`);
  }
  pausedTerminals.clear();
  pauseStartTimes.clear();
  terminalStatuses.clear();

  // Clear all IPC backpressure monitoring intervals
  for (const [id, checkInterval] of ipcPausedTerminals) {
    clearInterval(checkInterval);
    console.log(`[PtyHost] Cleared IPC backpressure monitor for terminal ${id}`);
  }
  ipcPausedTerminals.clear();
  ipcPauseStartTimes.clear();
  ipcQueuedBytes.clear();

  // Clear all other per-terminal state to prevent memory leaks
  terminalActivityTiers.clear();
  suspendedDueToStall.clear();
  pendingVisualSegments.clear();
  pendingVisualBytes.clear();
  totalPendingVisualBytes = 0;

  processTreeCache.stop();

  if (ptyPool) {
    ptyPool.dispose();
    ptyPool = null;
  }

  ptyManager.dispose();
  events.removeAllListeners();

  console.log("[PtyHost] Disposed");
}

// Handle process exit
process.on("exit", () => {
  cleanup();
});

// Initialize pool asynchronously
async function initialize(): Promise<void> {
  try {
    // Start the resource governor for proactive memory monitoring
    resourceGovernor.start();

    // Start the process tree cache (shared across all terminals)
    processTreeCache.start();
    ptyManager.setProcessTreeCache(processTreeCache);
    console.log("[PtyHost] ProcessTreeCache started");

    // Notify Main that we're ready (after cache is initialized, before pool is warmed)
    sendEvent({ type: "ready" });
    console.log("[PtyHost] Initialized and ready (accepting IPC)");

    ptyPool = getPtyPool({ poolSize: 2 });
    const homedir = process.env.HOME || os.homedir();

    // Warm pool in background
    ptyPool
      .warmPool(homedir)
      .then(() => {
        console.log("[PtyHost] PTY pool warmed in background");
      })
      .catch((err) => {
        console.error("[PtyHost] Failed to warm pool:", err);
      });

    ptyManager.setPtyPool(ptyPool);
  } catch (error) {
    console.error("[PtyHost] Initialization failed:", error);
    emergencyLogFatal("INIT_ERROR", error);
    // Even on error, we might want to stay alive to report it
  }
}

initialize().catch((err) => {
  console.error("[PtyHost] Fatal initialization error:", err);
  emergencyLogFatal("FATAL_INIT_ERROR", err);
});
