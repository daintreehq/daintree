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
import type { AgentEvent } from "./services/AgentStateMachine.js";
import type {
  PtyHostEvent,
  PtyHostTerminalSnapshot,
  TerminalFlowStatus,
} from "../shared/types/pty-host.js";

// Validate we're running in UtilityProcess context
if (!process.parentPort) {
  throw new Error("[PtyHost] Must run in UtilityProcess context");
}

const port = process.parentPort as unknown as MessagePort;

// Global error handlers to prevent silent crashes
process.on("uncaughtException", (err) => {
  console.error("[PtyHost] Uncaught Exception:", err);
  sendEvent({ type: "error", id: "system", error: err.message });
});

process.on("unhandledRejection", (reason) => {
  console.error("[PtyHost] Unhandled Rejection:", reason);
  sendEvent({
    type: "error",
    id: "system",
    error: String(reason instanceof Error ? reason.message : reason),
  });
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const v8 = require("v8");
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

// Initialize services
const ptyManager = new PtyManager();
const processTreeCache = new ProcessTreeCache(1000);
let ptyPool: PtyPool | null = null;
const resourceGovernor = new ResourceGovernor();

// Zero-copy ring buffers for terminal I/O (set via init-buffers message)
// Visual buffer: consumed by renderer (xterm.js) - critical path
// Analysis buffer: consumed by Web Worker - best-effort, can drop frames
let visualBuffer: SharedRingBuffer | null = null;
let analysisBuffer: SharedRingBuffer | null = null;
const packetFramer = new PacketFramer();
const textDecoder = new TextDecoder();

// Track terminals paused due to ring buffer backpressure
// Maps terminal ID to the interval timer used for resume checking
const pausedTerminals = new Map<string, ReturnType<typeof setInterval>>();

// Track terminal pause start times for duration calculation
const pauseStartTimes = new Map<string, number>();

// Track current terminal flow status to avoid duplicate events
const terminalStatuses = new Map<string, TerminalFlowStatus>();

// Resume threshold - use hysteresis to prevent rapid pause/resume oscillation
const BACKPRESSURE_RESUME_THRESHOLD = 80; // Resume when buffer drops below 80%
const BACKPRESSURE_CHECK_INTERVAL_MS = 100; // Check every 100ms during backpressure
const BACKPRESSURE_MAX_PAUSE_MS = 5000; // Force resume after 5 seconds to prevent indefinite pause

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

// MessagePort for direct Renderer ↔ Pty Host communication (bypasses Main)
// Note: This variable holds the port reference so the message handler stays active
// @ts-expect-error - stored to keep port reference alive
let rendererPort: MessagePort | null = null;

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
  // ---------------------------------------------------------------------------
  // PRIORITY 1: VISUAL RENDERER (Zero-Latency Path)
  // Write to SharedArrayBuffer immediately before doing ANY processing.
  // This ensures terminal output reaches xterm.js with minimal latency.
  // ---------------------------------------------------------------------------
  let visualWritten = false;

  if (visualBuffer) {
    const packet = packetFramer.frame(id, data);
    if (packet) {
      const bytesWritten = visualBuffer.write(packet);
      visualWritten = bytesWritten > 0;

      if (bytesWritten === 0) {
        // Ring buffer is full - apply backpressure by pausing the PTY
        if (!pausedTerminals.has(id)) {
          const utilization = visualBuffer.getUtilization();
          console.warn(
            `[PtyHost] Visual buffer full (${utilization.toFixed(1)}% utilized). Pausing PTY ${id} for backpressure.`
          );

          const terminal = ptyManager.getTerminal(id);
          if (!terminal?.ptyProcess) {
            console.warn(
              `[PtyHost] Cannot apply backpressure: missing PTY process for ${id}. Falling back to IPC.`
            );
            sendEvent({ type: "data", id, data: toStringForIpc(data) });
            return;
          }
          try {
            terminal.ptyProcess.pause();
          } catch (error) {
            console.error(`[PtyHost] Failed to pause PTY ${id}:`, error);
            // If pause fails, fall back to IPC to avoid data loss
            sendEvent({ type: "data", id, data: toStringForIpc(data) });
            return;
          }

          // Track when we started pausing for timeout safety
          const pauseStartTime = Date.now();
          pauseStartTimes.set(id, pauseStartTime);

          // Emit status event for UI
          emitTerminalStatus(id, "paused-backpressure", utilization);

          // Start monitoring for buffer clearance
          const checkInterval = setInterval(() => {
            if (!visualBuffer) {
              // Buffer disappeared - resume PTY if still exists
              const terminal = ptyManager.getTerminal(id);
              if (terminal?.ptyProcess) {
                try {
                  terminal.ptyProcess.resume();
                  console.log(`[PtyHost] Visual buffer removed. Resumed PTY ${id}`);
                  // Emit resume status
                  const pauseDuration = Date.now() - (pauseStartTimes.get(id) ?? pauseStartTime);
                  emitTerminalStatus(id, "running", undefined, pauseDuration);
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
              return;
            }

            const currentUtilization = visualBuffer.getUtilization();
            const pauseDuration = Date.now() - pauseStartTime;

            // Force resume if paused too long (safety against indefinite pause)
            if (pauseDuration > BACKPRESSURE_MAX_PAUSE_MS) {
              const terminal = ptyManager.getTerminal(id);
              if (terminal?.ptyProcess) {
                try {
                  terminal.ptyProcess.resume();
                  console.warn(
                    `[PtyHost] Force resumed PTY ${id} after ${pauseDuration}ms (buffer at ${currentUtilization.toFixed(1)}%). ` +
                      `Consumer may be stalled.`
                  );
                  // Emit resume status with duration
                  emitTerminalStatus(id, "running", currentUtilization, pauseDuration);
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
              const terminal = ptyManager.getTerminal(id);
              if (terminal?.ptyProcess) {
                try {
                  terminal.ptyProcess.resume();
                  console.log(
                    `[PtyHost] Buffer cleared to ${currentUtilization.toFixed(1)}%. Resumed PTY ${id}`
                  );
                  // Emit resume status with duration
                  emitTerminalStatus(id, "running", currentUtilization, pauseDuration);
                } catch (error) {
                  console.error(`[PtyHost] Failed to resume PTY ${id}:`, error);
                }
              }
              clearInterval(checkInterval);
              pausedTerminals.delete(id);
              pauseStartTimes.delete(id);
            }
          }, BACKPRESSURE_CHECK_INTERVAL_MS);

          pausedTerminals.set(id, checkInterval);
        }
        // Data is dropped during backpressure - acceptable, PTY is paused
        return;
      }
    } else {
      // Packet framing failed (ID too long or data >64KB) - fall back to IPC
      console.warn(`[PtyHost] Packet framing failed for terminal ${id}, using IPC fallback`);
    }
  }

  // Fallback: If ring buffer failed or isn't set up, use IPC
  if (!visualWritten) {
    sendEvent({ type: "data", id, data: toStringForIpc(data) });
  }

  // ---------------------------------------------------------------------------
  // PRIORITY 2: BACKGROUND TASKS (Deferred Processing)
  // Now that pixels are on their way to the screen, we can do heavy work.
  // ---------------------------------------------------------------------------

  // Semantic Analysis (Worker) - best-effort, can drop frames
  // Only write to analysis buffer if terminal has analysis enabled (agent terminals)
  const terminalInfo = ptyManager.getTerminal(id);
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
port.on("message", (rawMsg: any) => {
  // Electron/Node might wrap the message in { data: ..., ports: [] }
  const msg = rawMsg?.data ? rawMsg.data : rawMsg;
  const ports = rawMsg?.ports || [];

  try {
    switch (msg.type) {
      case "connect-port":
        // Receive MessagePort for direct Renderer ↔ Pty Host communication
        if (ports && ports.length > 0) {
          const receivedPort = ports[0];
          rendererPort = receivedPort;
          receivedPort.start();
          console.log("[PtyHost] MessagePort received from Main, starting listener...");

          receivedPort.on("message", (event: any) => {
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
          });

          console.log("[PtyHost] MessagePort listener installed");
        } else {
          console.warn("[PtyHost] connect-port message received but no ports provided");
        }
        break;

      case "init-buffers": {
        const visualOk = msg.visualBuffer instanceof SharedArrayBuffer;
        const analysisOk = msg.analysisBuffer instanceof SharedArrayBuffer;

        if (visualOk) {
          visualBuffer = new SharedRingBuffer(msg.visualBuffer);
          ptyManager.setSabMode(true);
        } else {
          console.warn("[PtyHost] init-buffers: visualBuffer is not SharedArrayBuffer (IPC mode)");
        }

        if (analysisOk) {
          analysisBuffer = new SharedRingBuffer(msg.analysisBuffer);
        } else {
          console.warn("[PtyHost] init-buffers: analysisBuffer is not SharedArrayBuffer");
        }

        console.log(
          `[PtyHost] Buffers initialized: visual=${visualOk ? "SAB" : "IPC"} analysis=${
            analysisOk ? "SAB" : "disabled"
          } sabMode=${ptyManager.isSabMode()}`
        );
        break;
      }

      case "spawn":
        ptyManager.spawn(msg.id, msg.options);
        break;

      case "write":
        ptyManager.write(msg.id, msg.data, msg.traceId);
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

      case "flush-buffer":
        ptyManager.flushBuffer(msg.id);
        break;

      case "acknowledge-data":
        ptyManager.acknowledgeData(msg.id, msg.charCount);
        break;

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
                type: terminal.type,
                title: terminal.title,
                cwd: terminal.cwd,
                worktreeId: terminal.worktreeId,
                agentState: terminal.agentState,
                spawnedAt: terminal.spawnedAt,
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

            // Calculate pause duration if we have a start time
            const pauseStart = pauseStartTimes.get(msg.id);
            const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
            pauseStartTimes.delete(msg.id);

            // Emit resume status
            emitTerminalStatus(msg.id, "running", visualBuffer?.getUtilization(), pauseDuration);
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

  // Stop resource governor
  resourceGovernor.dispose();

  // Clear all backpressure monitoring intervals
  for (const [id, checkInterval] of pausedTerminals) {
    clearInterval(checkInterval);
    console.log(`[PtyHost] Cleared backpressure monitor for terminal ${id}`);
  }
  pausedTerminals.clear();
  pauseStartTimes.clear();
  terminalStatuses.clear();

  // Stop process tree cache
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

    // Notify Main that we're ready after cache is initialized
    sendEvent({ type: "ready" });
    console.log("[PtyHost] Initialized and ready (accepting IPC)");

    // Initialize pool
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
    // Even on error, we might want to stay alive to report it
  }
}

// Start initialization
initialize().catch((err) => {
  console.error("[PtyHost] Fatal initialization error:", err);
});
