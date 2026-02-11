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
import { PtyManager } from "./services/PtyManager.js";
import { PtyPool, getPtyPool } from "./services/PtyPool.js";
import { ProcessTreeCache } from "./services/ProcessTreeCache.js";
import { events } from "./services/events.js";
import { SharedRingBuffer, PacketFramer } from "../shared/utils/SharedRingBuffer.js";
import { selectShard } from "../shared/utils/shardSelection.js";
import type { AgentEvent } from "./services/AgentStateMachine.js";
import type { PtyHostEvent, SpawnResult } from "../shared/types/pty-host.js";
import {
  appendEmergencyLog,
  emergencyLogFatal,
  ResourceGovernor,
  BackpressureManager,
  IpcQueueManager,
  metricsEnabled,
  parseSpawnError,
  toHostSnapshot,
  MAX_PACKET_PAYLOAD,
  STREAM_STALL_SUSPEND_MS,
  BACKPRESSURE_RESUME_THRESHOLD,
  BACKPRESSURE_CHECK_INTERVAL_MS,
  BACKPRESSURE_MAX_PAUSE_MS,
} from "./pty-host/index.js";

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

const ptyManager = new PtyManager();
const processTreeCache = new ProcessTreeCache(2500); // 2.5s poll interval (reduced CPU load)
let ptyPool: PtyPool | null = null;

// Zero-copy ring buffers for terminal I/O (set via init-buffers message)
// Visual buffers: consumed by renderer (xterm.js) - critical path, sharded for isolation
// Analysis buffer: consumed by Web Worker - best-effort, can drop frames
let visualBuffers: SharedRingBuffer[] = [];
let visualSignalView: Int32Array | null = null;
let analysisBuffer: SharedRingBuffer | null = null;
const packetFramer = new PacketFramer();
const textDecoder = new TextDecoder();

// Terminals that need IPC data mirroring (e.g., dev-preview sessions that
// need main-process URL detection even when SharedArrayBuffer is active)
const ipcDataMirrorTerminals = new Set<string>();

// MessagePort for direct Renderer ↔ Pty Host communication (bypasses Main)
// Note: This variable holds the port reference so the message handler stays active
let rendererPort: MessagePort | null = null;
let rendererPortMessageHandler: ((event: any) => void) | null = null;

// Helper to send events to Main process
function sendEvent(event: PtyHostEvent): void {
  port.postMessage(event);
}

// Instantiate managers with dependency injection
const backpressureManager = new BackpressureManager({
  getTerminal: (id) => ptyManager.getTerminal(id),
  sendEvent,
  metricsEnabled,
});

const ipcQueueManager = new IpcQueueManager({
  getTerminal: (id) => ptyManager.getTerminal(id),
  sendEvent,
  metricsEnabled,
  emitTerminalStatus: (...args) => backpressureManager.emitTerminalStatus(...args),
  emitReliabilityMetric: (payload) => backpressureManager.emitReliabilityMetric(payload),
});

const resourceGovernor = new ResourceGovernor({
  getTerminals: () => ptyManager.getAll(),
  incrementPauseCount: (count) => {
    backpressureManager.stats.pauseCount += count;
  },
  sendEvent,
});

// Helper to convert data to string for IPC fallback (IPC events expect string)
function toStringForIpc(data: string | Uint8Array): string {
  return typeof data === "string" ? data : textDecoder.decode(data);
}

// Wire up PtyManager events
ptyManager.on("data", (id: string, data: string | Uint8Array) => {
  // Terminal output always updates headless state; visual streaming can be suspended under backpressure.
  const isSuspended = backpressureManager.isSuspended(id);
  const terminalInfo = ptyManager.getTerminal(id);

  // Background tier: suppress visual streaming entirely (wake snapshots will resync state)
  // Analysis buffer writes still occur for agent state detection
  const activityTier = backpressureManager.getActivityTier(id);
  const isBackgrounded = activityTier === "background";
  // PRIORITY 1: VISUAL RENDERER (Zero-Latency Path)
  // Write to SharedArrayBuffer immediately before doing ANY processing.
  // This ensures terminal output reaches xterm.js with minimal latency.
  // Skip visual writes if suspended, but continue to analysis buffer for agent state detection.
  let visualWritten = isSuspended;

  if (!isSuspended && !isBackgrounded && visualBuffers.length > 0) {
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
        const queued = backpressureManager.enqueuePendingSegment(id, { data: dataBytes, offset });
        visualWritten = true; // partial write counts as handled

        if (!queued) {
          const utilization = shard.getUtilization();
          const pauseStart = backpressureManager.getPauseStartTime(id);
          const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
          backpressureManager.suspendVisualStream(
            id,
            "pending cap exceeded",
            utilization,
            pauseDuration,
            shardIndex
          );
        } else if (!backpressureManager.isPaused(id)) {
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
          backpressureManager.setPauseStartTime(id, pauseStartTime);

          // Emit status event for UI
          backpressureManager.emitTerminalStatus(id, "paused-backpressure", utilization);

          // Emit metrics for pause-start
          backpressureManager.emitReliabilityMetric({
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
                  const pauseDuration =
                    Date.now() - (backpressureManager.getPauseStartTime(id) ?? pauseStartTime);
                  backpressureManager.emitTerminalStatus(id, "running", undefined, pauseDuration);

                  // Emit metrics for pause-end
                  backpressureManager.emitReliabilityMetric({
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
              backpressureManager.deletePausedInterval(id);
              backpressureManager.deletePauseStartTime(id);
              backpressureManager.clearPendingVisual(id);
              return;
            }

            const shardIndex = selectShard(id, visualBuffers.length);
            const shard = visualBuffers[shardIndex];
            const currentUtilization = shard.getUtilization();
            const pauseDuration = Date.now() - pauseStartTime;

            // If the stream is stalled for too long, stop streaming for this terminal
            // and rely on headless state + explicit wake to restore fidelity.
            if (pauseDuration > STREAM_STALL_SUSPEND_MS) {
              backpressureManager.suspendVisualStream(
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
                  if (backpressureManager.hasPendingSegments(id)) {
                    backpressureManager.suspendVisualStream(
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
                    backpressureManager.emitTerminalStatus(
                      id,
                      "running",
                      currentUtilization,
                      pauseDuration
                    );

                    // Emit metrics for pause-end (force resume path)
                    backpressureManager.emitReliabilityMetric({
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
              backpressureManager.deletePausedInterval(id);
              backpressureManager.deletePauseStartTime(id);
              return;
            }

            // Resume when buffer drops below threshold (hysteresis to prevent rapid pause/resume)
            if (currentUtilization < BACKPRESSURE_RESUME_THRESHOLD) {
              const pending = backpressureManager.getPendingSegments(id);
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
                      backpressureManager.consumePendingBytes(id, remaining);
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
                    backpressureManager.consumePendingBytes(id, pendingChunk.length);
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
                  backpressureManager.clearPendingVisual(id);
                }
              }

              if (!backpressureManager.hasPendingSegments(id)) {
                const terminal = ptyManager.getTerminal(id);
                if (terminal?.ptyProcess) {
                  try {
                    terminal.ptyProcess.resume();
                    console.log(
                      `[PtyHost] Buffer cleared to ${currentUtilization.toFixed(1)}%. Resumed PTY ${id}`
                    );
                    // Emit resume status with duration
                    backpressureManager.emitTerminalStatus(
                      id,
                      "running",
                      currentUtilization,
                      pauseDuration
                    );

                    // Emit metrics for pause-end (normal resume path)
                    backpressureManager.emitReliabilityMetric({
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
                backpressureManager.deletePausedInterval(id);
                backpressureManager.deletePauseStartTime(id);
              }
            }
          }, BACKPRESSURE_CHECK_INTERVAL_MS);

          backpressureManager.setPausedInterval(id, checkInterval);
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

  // IPC Data Mirror: Always send data via IPC for terminals that need main-process
  // monitoring (e.g., UrlDetector for dev preview URL detection), even when SAB write succeeded.
  // Skip mirroring for suspended/backgrounded terminals to respect backpressure semantics.
  if (visualWritten && ipcDataMirrorTerminals.has(id) && !isSuspended && !isBackgrounded) {
    sendEvent({ type: "data", id, data: toStringForIpc(data) });
  }

  // Fallback: If ring buffer failed or isn't set up, use IPC with backpressure
  // Skip IPC fallback for backgrounded or suspended terminals (wake will resync via snapshot)
  if (!visualWritten && !isBackgrounded && !isSuspended) {
    const dataString = toStringForIpc(data);
    const dataBytes = Buffer.byteLength(dataString, "utf8");

    // Enforce hard cap: drop data if adding it would exceed max queue size
    // This prevents unbounded memory growth when renderer is stalled
    if (ipcQueueManager.isAtCapacity(id, dataBytes)) {
      const utilization = ipcQueueManager.getUtilization(id);
      console.warn(
        `[PtyHost] IPC queue full (${utilization.toFixed(1)}%). Dropping ${dataBytes} bytes for terminal ${id}`
      );
      backpressureManager.emitReliabilityMetric({
        terminalId: id,
        metricType: "suspend",
        timestamp: Date.now(),
        bufferUtilization: utilization,
      });
      return; // Drop this chunk to prevent OOM
    }

    ipcQueueManager.addBytes(id, dataBytes);
    const utilization = ipcQueueManager.getUtilization(id);

    // Send the data via IPC
    sendEvent({ type: "data", id, data: dataString });

    // Apply backpressure if queue exceeds high watermark
    ipcQueueManager.applyBackpressure(id, utilization);
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
  backpressureManager.cleanupTerminal(id);

  // Clean up IPC backpressure state
  ipcQueueManager.clearQueue(id);

  // Clean up IPC data mirror state
  ipcDataMirrorTerminals.delete(id);

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
      agentId: payload.agentId,
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
        ptyManager.onProjectSwitch(msg.projectId, (id, tier) => {
          backpressureManager.setActivityTier(id, tier);
        });
        ptyManager.setActiveProject(msg.projectId);
        break;
      }

      case "spawn": {
        let spawnResult: SpawnResult;
        try {
          ptyManager.spawn(msg.id, msg.options);
          spawnResult = { success: true, id: msg.id };

          const terminalInfo = ptyManager.getTerminal(msg.id);
          const pid = terminalInfo?.ptyProcess?.pid;
          if (pid !== undefined) {
            sendEvent({ type: "terminal-pid", id: msg.id, pid });
          }
        } catch (error) {
          console.error(`[PtyHost] Spawn failed for terminal ${msg.id}:`, error);
          spawnResult = {
            success: false,
            id: msg.id,
            error: parseSpawnError(error),
          };
        }

        sendEvent({ type: "spawn-result", id: msg.id, result: spawnResult });
        break;
      }

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
        backpressureManager.setActivityTier(msg.id, tier);

        // Clear any stall suspension and unblock the PTY
        backpressureManager.clearSuspended(msg.id);
        backpressureManager.clearPendingVisual(msg.id);

        const checkInterval = backpressureManager.getPausedInterval(msg.id);
        const wasPaused = checkInterval !== undefined;
        if (checkInterval) {
          clearInterval(checkInterval);
          backpressureManager.deletePausedInterval(msg.id);
        }

        const pauseStart = backpressureManager.getPauseStartTime(msg.id);
        const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
        backpressureManager.deletePauseStartTime(msg.id);

        const terminal = ptyManager.getTerminal(msg.id);
        if (terminal?.ptyProcess) {
          try {
            terminal.ptyProcess.resume();
          } catch {
            // ignore
          }

          // Apply tier-driven ActivityMonitor polling: 50ms active, 500ms background
          const pollingInterval = tier === "active" ? 50 : 500;
          ptyManager.setActivityMonitorTier(msg.id, pollingInterval);
        }

        backpressureManager.emitTerminalStatus(msg.id, "running");

        // Emit metrics for pause-end (set-activity-tier unpause path)
        if (wasPaused && pauseDuration !== undefined) {
          backpressureManager.emitReliabilityMetric({
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
        backpressureManager.setActivityTier(msg.id, "active");
        backpressureManager.clearSuspended(msg.id);
        backpressureManager.clearPendingVisual(msg.id);

        // Clear any active pause interval and timing, and resume the PTY
        const checkInterval = backpressureManager.getPausedInterval(msg.id);
        const wasPaused = checkInterval !== undefined;
        if (checkInterval) {
          clearInterval(checkInterval);
          backpressureManager.deletePausedInterval(msg.id);
        }
        backpressureManager.deletePauseStartTime(msg.id);

        // Apply active tier polling (50ms) and resume PTY when waking
        const terminal = ptyManager.getTerminal(msg.id);
        if (terminal) {
          ptyManager.setActivityMonitorTier(msg.id, 50);

          // Resume PTY if it was paused for backpressure
          if (wasPaused && terminal.ptyProcess) {
            try {
              terminal.ptyProcess.resume();
            } catch {
              // ignore
            }
          }
        }

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

        backpressureManager.emitTerminalStatus(msg.id, "running");

        // Emit wake latency metrics (only if enabled to avoid overhead)
        if (metricsEnabled() && state) {
          const { Buffer } = await import("node:buffer");
          const serializedStateBytes = Buffer.byteLength(state, "utf8");
          backpressureManager.emitReliabilityMetric({
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
        ipcQueueManager.removeBytes(msg.id, acknowledgedBytes);

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

      case "set-ipc-data-mirror":
        if (typeof msg.id === "string" && typeof msg.enabled === "boolean") {
          if (msg.enabled) {
            ipcDataMirrorTerminals.add(msg.id);
          } else {
            ipcDataMirrorTerminals.delete(msg.id);
          }
        }
        break;

      case "get-snapshot":
        sendEvent({
          type: "snapshot",
          id: msg.id,
          requestId: msg.requestId,
          snapshot: toHostSnapshot(ptyManager, msg.id),
        });
        break;

      case "get-all-snapshots":
        sendEvent({
          type: "all-snapshots",
          requestId: msg.requestId,
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
        // Compute hasPty dynamically since it's not stored on TerminalInfo.
        // A terminal has an active PTY when it hasn't been killed and hasn't exited.
        const hasPty = terminal ? !terminal.wasKilled && !terminal.isExited : false;
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
                activityTier: ptyManager.getActivityTier(msg.id),
                hasPty,
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
            const checkInterval = backpressureManager.getPausedInterval(msg.id);
            if (checkInterval) {
              clearInterval(checkInterval);
              backpressureManager.deletePausedInterval(msg.id);
            }
            backpressureManager.clearPendingVisual(msg.id);

            // Calculate pause duration if we have a start time
            const pauseStart = backpressureManager.getPauseStartTime(msg.id);
            const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
            backpressureManager.deletePauseStartTime(msg.id);

            // Clear suspended flag to allow output to flow again
            backpressureManager.clearSuspended(msg.id);

            // Emit resume status
            const utilization =
              visualBuffers.length > 0
                ? visualBuffers[selectShard(msg.id, visualBuffers.length)].getUtilization()
                : undefined;
            backpressureManager.emitTerminalStatus(msg.id, "running", utilization, pauseDuration);

            // Emit metrics for pause-end (user force-resume path)
            if (pauseDuration !== undefined) {
              backpressureManager.emitReliabilityMetric({
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

      case "get-available-terminals": {
        const terminals = ptyManager.getAvailableTerminals();
        sendEvent({
          type: "available-terminals",
          requestId: msg.requestId,
          terminals: terminals.map((t) => ({
            id: t.id,
            projectId: t.projectId,
            kind: t.kind,
            type: t.type,
            agentId: t.agentId,
            title: t.title,
            cwd: t.cwd,
            worktreeId: t.worktreeId,
            agentState: t.agentState,
            lastStateChange: t.lastStateChange,
            spawnedAt: t.spawnedAt,
            isTrashed: t.isTrashed,
            trashExpiresAt: t.trashExpiresAt,
            activityTier: ptyManager.getActivityTier(t.id),
            hasPty: !t.wasKilled && !t.isExited,
          })),
        });
        break;
      }

      case "get-terminals-by-state": {
        const terminals = ptyManager.getTerminalsByState(msg.state);
        sendEvent({
          type: "terminals-by-state",
          requestId: msg.requestId,
          terminals: terminals.map((t) => ({
            id: t.id,
            projectId: t.projectId,
            kind: t.kind,
            type: t.type,
            agentId: t.agentId,
            title: t.title,
            cwd: t.cwd,
            worktreeId: t.worktreeId,
            agentState: t.agentState,
            lastStateChange: t.lastStateChange,
            spawnedAt: t.spawnedAt,
            isTrashed: t.isTrashed,
            trashExpiresAt: t.trashExpiresAt,
            activityTier: ptyManager.getActivityTier(t.id),
            hasPty: !t.wasKilled && !t.isExited,
          })),
        });
        break;
      }

      case "get-all-terminals": {
        const terminals = ptyManager.getAll();
        sendEvent({
          type: "all-terminals",
          requestId: msg.requestId,
          terminals: terminals.map((t) => ({
            id: t.id,
            projectId: t.projectId,
            kind: t.kind,
            type: t.type,
            agentId: t.agentId,
            title: t.title,
            cwd: t.cwd,
            worktreeId: t.worktreeId,
            agentState: t.agentState,
            lastStateChange: t.lastStateChange,
            spawnedAt: t.spawnedAt,
            isTrashed: t.isTrashed,
            trashExpiresAt: t.trashExpiresAt,
            activityTier: ptyManager.getActivityTier(t.id),
            hasPty: !t.wasKilled && !t.isExited,
          })),
        });
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

  backpressureManager.dispose();
  ipcQueueManager.dispose();

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
