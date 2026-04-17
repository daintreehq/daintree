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

// Silence EPIPE on stdout/stderr — the main process may close the pipe
// at any time during shutdown or host restart.
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === "function") {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") return;
      throw err;
    });
  }
}

import { MessagePort } from "node:worker_threads";
import os from "node:os";
import { PtyManager } from "./services/PtyManager.js";
import { PtyPool, getPtyPool } from "./services/PtyPool.js";
import { ProcessTreeCache } from "./services/ProcessTreeCache.js";
import { TerminalResourceMonitor } from "./services/pty/TerminalResourceMonitor.js";
import { RESOURCE_PROFILE_CONFIGS, type ResourceProfile } from "../shared/types/resourceProfile.js";
import { events } from "./services/events.js";
import { SharedRingBuffer, PacketFramer } from "../shared/utils/SharedRingBuffer.js";
import { selectShard } from "../shared/utils/shardSelection.js";
import type { AgentEvent } from "./services/AgentStateMachine.js";
import type { PtyHostEvent, SpawnResult } from "../shared/types/pty-host.js";
import { normalizeScrollbackLines } from "../shared/config/scrollback.js";
import { setSessionPersistSuppressed } from "./services/pty/terminalSessionPersistence.js";
import {
  appendEmergencyLog,
  emergencyLogFatal,
  PtyPauseCoordinator,
  ResourceGovernor,
  BackpressureManager,
  IpcQueueManager,
  PortQueueManager,
  PortBatcher,
  metricsEnabled,
  parseSpawnError,
  toHostSnapshot,
  MAX_PACKET_PAYLOAD,
  BACKPRESSURE_SAFETY_TIMEOUT_MS,
} from "./pty-host/index.js";
import { isSmokeTestTerminalId } from "../shared/utils/smokeTestTerminals.js";

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
const terminalResourceMonitor = new TerminalResourceMonitor(
  processTreeCache,
  ptyManager,
  sendEvent
);
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

// Per-terminal pause coordinators: the single source of truth for PTY flow control
const pauseCoordinators = new Map<string, PtyPauseCoordinator>();

function getPauseCoordinator(id: string): PtyPauseCoordinator | undefined {
  return pauseCoordinators.get(id);
}

function getOrCreatePauseCoordinator(id: string): PtyPauseCoordinator | undefined {
  let coordinator = pauseCoordinators.get(id);
  if (coordinator) return coordinator;
  const terminal = ptyManager.getTerminal(id);
  if (!terminal?.ptyProcess) return undefined;
  coordinator = new PtyPauseCoordinator({
    pause: () => terminal.ptyProcess.pause(),
    resume: () => terminal.ptyProcess.resume(),
  });
  pauseCoordinators.set(id, coordinator);
  return coordinator;
}

// Per-window MessagePort connections for direct Renderer ↔ Pty Host communication
interface RendererConnection {
  port: MessagePort;
  handler: (e: MessageEvent) => void;
  portQueueManager: PortQueueManager;
  batcher: PortBatcher;
}
const rendererConnections = new Map<number, RendererConnection>();
const windowProjectMap = new Map<number, string | null>();

// Helper to send events to Main process
function sendEvent(event: PtyHostEvent): void {
  port.postMessage(event);
}

// Instantiate managers with dependency injection
const backpressureManager = new BackpressureManager({
  getTerminal: (id) => ptyManager.getTerminal(id),
  getPauseCoordinator,
  sendEvent,
  metricsEnabled,
});

const ipcQueueManager = new IpcQueueManager({
  getTerminal: (id) => ptyManager.getTerminal(id),
  getPauseCoordinator,
  sendEvent,
  metricsEnabled,
  emitTerminalStatus: (...args) => backpressureManager.emitTerminalStatus(...args),
  emitReliabilityMetric: (payload) => backpressureManager.emitReliabilityMetric(payload),
});

// PortQueueManager deps factory — creates per-window instances with unique pause tokens
function createPortQueueManager(windowId: number): PortQueueManager {
  return new PortQueueManager({
    getTerminal: (id) => ptyManager.getTerminal(id),
    getPauseCoordinator,
    sendEvent,
    metricsEnabled,
    emitTerminalStatus: (...args) => backpressureManager.emitTerminalStatus(...args),
    emitReliabilityMetric: (payload) => backpressureManager.emitReliabilityMetric(payload),
    pauseToken: `port-queue-${windowId}`,
  });
}

/** Recompute activity tiers for all terminals based on union of connected windows' projects */
function recomputeActivityTiers(): void {
  const activeProjects = new Set<string>();
  for (const projectId of windowProjectMap.values()) {
    if (projectId !== null) activeProjects.add(projectId);
  }

  for (const terminal of ptyManager.getAll()) {
    const isActiveInAnyWindow =
      activeProjects.size === 0 ||
      (terminal.projectId !== undefined && activeProjects.has(terminal.projectId));
    const tier = isActiveInAnyWindow ? "active" : "background";
    backpressureManager.setActivityTier(terminal.id, tier);
    ptyManager.setActivityMonitorTier(terminal.id, tier === "active" ? 50 : 500);
  }
}

/** Disconnect a window's renderer port and clean up its resources */
function disconnectWindow(windowId: number, reason: string): void {
  const conn = rendererConnections.get(windowId);
  if (!conn) return;

  try {
    conn.port.removeListener("message", conn.handler);
  } catch {
    // ignore
  }
  // Dispose batcher (drops buffered data — port is closing)
  conn.batcher.dispose();
  // Release port-queue pause holds before disposing
  conn.portQueueManager.resumeAll();
  conn.portQueueManager.dispose();
  try {
    conn.port.close();
  } catch {
    // ignore
  }

  rendererConnections.delete(windowId);
  windowProjectMap.delete(windowId);
  recomputeActivityTiers();
  console.log(`[PtyHost] Window ${windowId} disconnected (${reason})`);
}

const resourceGovernor = new ResourceGovernor({
  getTerminalIds: () => ptyManager.getAll().map((t) => t.id),
  getPauseCoordinator,
  getTerminalPids: () => ptyManager.getAll().map((t) => ({ id: t.id, pid: t.ptyProcess.pid })),
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
  // PRIORITY 1: MESSAGEPORT (Per-Window Routed Path)
  // Send data directly to renderer windows via MessagePort with per-window project filtering.
  // MessagePort is primary because SharedArrayBuffer ring buffers use a single shared read pointer
  // (single-consumer design). With per-project WebContentsViews, multiple SAB workers race on the
  // same read pointer, causing data meant for one view to be consumed by another view's worker
  // and silently dropped. MessagePort avoids this by routing data to the correct project view.
  // Skip MessagePort for smoke test terminals — the smoke test monitors data via PtyClient
  // (IPC events in the main process), so these must always use the IPC fallback path.
  let visualWritten = isSuspended;

  if (
    !isSuspended &&
    !isBackgrounded &&
    rendererConnections.size > 0 &&
    !isSmokeTestTerminalId(id)
  ) {
    const dataString = toStringForIpc(data);
    const byteCount = Buffer.byteLength(dataString, "utf8");

    for (const [windowId, conn] of rendererConnections) {
      const windowProject = windowProjectMap.get(windowId) ?? null;
      const termProject = terminalInfo?.projectId ?? null;
      const filtered = windowProject !== null && termProject !== windowProject;

      if (filtered) continue;

      if (conn.batcher.write(id, dataString, byteCount)) {
        visualWritten = true;
      }
    }
    // If at capacity on all ports, fall through to SAB or IPC fallback
  }

  // PRIORITY 2: SHARED ARRAY BUFFER (Zero-Copy Fallback)
  // Used when no MessagePort renderer connections are available (e.g., during startup before
  // port handshake completes). SAB is single-consumer — safe only when one view is reading.
  if (!visualWritten && !isSuspended && !isBackgrounded && visualBuffers.length > 0) {
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

          const bpCoordinator = getOrCreatePauseCoordinator(id);
          if (!bpCoordinator) {
            console.warn(
              `[PtyHost] Cannot apply backpressure: missing PTY process for ${id}. Falling back to IPC.`
            );
            break;
          }
          bpCoordinator.pause("backpressure");

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

          // Safety timeout: if ack-driven resume doesn't clear backpressure in time,
          // suspend the stream and rely on wake to restore state.
          const safetyTimeout = setTimeout(() => {
            backpressureManager.deletePausedInterval(id);
            backpressureManager.deletePauseStartTime(id);

            const si = visualBuffers.length > 0 ? selectShard(id, visualBuffers.length) : 0;
            const s = visualBuffers[si];
            const util = s ? s.getUtilization() : 0;
            const dur = Date.now() - pauseStartTime;

            if (backpressureManager.hasPendingSegments(id)) {
              backpressureManager.suspendVisualStream(id, `${dur}ms ack timeout`, util, dur, si);
            } else {
              // No pending segments — just resume via coordinator
              const timeoutCoord = getPauseCoordinator(id);
              timeoutCoord?.resume("backpressure");
              if (!timeoutCoord?.isPaused) {
                backpressureManager.emitTerminalStatus(id, "running", util, dur);
              }
              backpressureManager.emitReliabilityMetric({
                terminalId: id,
                metricType: "pause-end",
                timestamp: Date.now(),
                durationMs: dur,
                bufferUtilization: util,
              });
            }
          }, BACKPRESSURE_SAFETY_TIMEOUT_MS);

          backpressureManager.setPausedInterval(id, safetyTimeout);
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
      if (analysisWritten === 0 && process.env.DAINTREE_VERBOSE) {
        console.log(`[PtyHost] Analysis buffer full - dropping frame for terminal ${id}`);
      }
    }
  }
});

ptyManager.on("exit", (id: string, exitCode: number) => {
  // Release all pause holds and remove coordinator for this terminal
  const coordinator = pauseCoordinators.get(id);
  if (coordinator) {
    coordinator.forceReleaseAll();
    pauseCoordinators.delete(id);
  }

  // Clean up any active backpressure monitoring for this terminal
  backpressureManager.cleanupTerminal(id);

  // Flush pending batched data for exiting terminal, then clean up backpressure state
  ipcQueueManager.clearQueue(id);
  for (const conn of rendererConnections.values()) {
    try {
      conn.batcher.flushTerminal(id);
    } catch {
      // Port may already be closed — safe to ignore
    }
    conn.portQueueManager.clearQueue(id);
  }

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
      cwd: payload.cwd,
      waitingReason: payload.waitingReason,
      sessionCost: payload.sessionCost,
      sessionTokens: payload.sessionTokens,
    });

    if (
      payload.state === "waiting" ||
      payload.state === "completed" ||
      payload.state === "exited"
    ) {
      ptyManager.flushAgentSnapshot(payload.terminalId);
    }
  }
});

events.on("agent:detected", (payload) => {
  sendEvent({
    type: "agent-detected",
    terminalId: payload.terminalId,
    agentType: payload.agentType,
    processIconId: payload.processIconId,
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

// Ack-driven backpressure helpers for SAB path
function tryReplayAndResume(id: string): void {
  const segments = backpressureManager.getPendingSegments(id);
  if (!segments || segments.length === 0) {
    resumePausedTerminal(id);
    return;
  }

  if (visualBuffers.length === 0) return;

  const shardIndex = selectShard(id, visualBuffers.length);
  const shard = visualBuffers[shardIndex];
  if (!shard) return;

  let wroteAny = false;
  while (segments.length > 0) {
    const segment = segments[0];
    const remaining = segment.data.length - segment.offset;
    if (remaining <= 0) {
      segments.shift();
      continue;
    }

    const nextOffset = Math.min(segment.offset + MAX_PACKET_PAYLOAD, segment.data.length);
    const chunk = segment.data.subarray(segment.offset, nextOffset);
    const packet = packetFramer.frame(id, chunk);
    if (!packet) break;

    const bytesWritten = shard.write(packet);
    if (bytesWritten === 0) {
      return; // Still full, wait for more acks
    }

    wroteAny = true;
    const consumed = nextOffset - segment.offset;
    backpressureManager.consumePendingBytes(id, consumed);
    segment.offset = nextOffset;

    if (segment.offset >= segment.data.length) {
      segments.shift();
    }
  }

  if (wroteAny && visualSignalView) {
    Atomics.add(visualSignalView, 0, 1);
    Atomics.notify(visualSignalView, 0, 1);
  }

  // All pending segments drained — resume the PTY
  if (segments.length === 0) {
    backpressureManager.clearPendingVisual(id);
    resumePausedTerminal(id);
  }
}

function resumePausedTerminal(id: string): void {
  const safetyTimeout = backpressureManager.getPausedInterval(id);
  if (safetyTimeout) {
    clearTimeout(safetyTimeout);
    backpressureManager.deletePausedInterval(id);
  }

  const pauseStart = backpressureManager.getPauseStartTime(id);
  const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
  backpressureManager.deletePauseStartTime(id);

  const coordinator = getPauseCoordinator(id);
  coordinator?.resume("backpressure");

  const shardIndex = visualBuffers.length > 0 ? selectShard(id, visualBuffers.length) : 0;
  const s = visualBuffers[shardIndex];
  const utilization = s ? s.getUtilization() : 0;

  // Only emit "running" if no other subsystem still holds a pause
  if (!coordinator?.isPaused) {
    backpressureManager.emitTerminalStatus(id, "running", utilization, pauseDuration);
  }
  backpressureManager.emitReliabilityMetric({
    terminalId: id,
    metricType: "pause-end",
    timestamp: Date.now(),
    durationMs: pauseDuration,
    bufferUtilization: utilization,
  });

  backpressureManager.stats.resumeCount++;
}

// Handle requests from Main
port.on("message", async (rawMsg: any) => {
  // Electron/Node might wrap the message in { data: ..., ports: [] }
  const msg = rawMsg?.data ? rawMsg.data : rawMsg;
  const ports = rawMsg?.ports || [];

  try {
    switch (msg.type) {
      case "connect-port": {
        // Receive MessagePort for direct Renderer ↔ Pty Host communication (per-window)
        const windowId: number | undefined = msg.windowId;
        if (typeof windowId !== "number") {
          console.warn("[PtyHost] connect-port missing windowId, ignoring");
          break;
        }

        if (ports && ports.length > 0) {
          const receivedPort = ports[0] as MessagePort;
          const existing = rendererConnections.get(windowId);

          // Duplicate port check
          if (existing?.port === receivedPort) {
            try {
              receivedPort.start();
            } catch {
              // ignore
            }
            console.log(
              `[PtyHost] MessagePort already connected for window ${windowId}, ignoring duplicate`
            );
            break;
          }

          // Replace existing connection for this window
          if (existing) {
            disconnectWindow(windowId, "port-replace");
          }

          const perWindowQueueManager = createPortQueueManager(windowId);
          const perWindowBatcher = new PortBatcher({
            portQueueManager: perWindowQueueManager,
            postMessage: (id, data, bytes) => {
              receivedPort.postMessage({ type: "data", id, data, bytes });
            },
            onError: () => {
              disconnectWindow(windowId, "postMessage-error");
            },
          });
          receivedPort.start();
          console.log(
            `[PtyHost] MessagePort received from Main for window ${windowId}, starting listener...`
          );

          const handler = (event: MessageEvent) => {
            const portMsg = event?.data ? event.data : event;

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
              } else if (
                portMsg.type === "ack" &&
                typeof portMsg.id === "string" &&
                typeof portMsg.bytes === "number"
              ) {
                perWindowQueueManager.removeBytes(portMsg.id, portMsg.bytes);
                perWindowQueueManager.tryResume(portMsg.id);
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

          receivedPort.on("message", handler);

          receivedPort.on("close", () => {
            // Guard: only disconnect if this port is still the active one for this window
            const current = rendererConnections.get(windowId);
            if (current?.port === receivedPort) {
              disconnectWindow(windowId, "port-close");
            }
          });

          rendererConnections.set(windowId, {
            port: receivedPort,
            handler,
            portQueueManager: perWindowQueueManager,
            batcher: perWindowBatcher,
          });
          console.log(`[PtyHost] MessagePort listener installed for window ${windowId}`);
        } else {
          console.warn("[PtyHost] connect-port message received but no ports provided");
        }
        break;
      }

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
        windowProjectMap.set(msg.windowId, msg.projectId);
        recomputeActivityTiers();
        if (msg.projectPath && ptyPool) {
          ptyPool.drainAndRefill(msg.projectPath).catch((err) => {
            console.error("[PtyHost] drainAndRefill failed:", err);
          });
        }
        break;
      }

      case "project-switch": {
        windowProjectMap.set(msg.windowId, msg.projectId);
        recomputeActivityTiers();
        if (msg.projectPath && ptyPool) {
          ptyPool.drainAndRefill(msg.projectPath).catch((err) => {
            console.error("[PtyHost] drainAndRefill failed:", err);
          });
        }
        break;
      }

      case "disconnect-port": {
        disconnectWindow(msg.windowId, "explicit-disconnect");
        break;
      }

      case "spawn": {
        let spawnResult: SpawnResult;
        try {
          // Remove stale coordinator before spawn (handles ID respawn)
          const staleCoord = pauseCoordinators.get(msg.id);
          if (staleCoord) {
            staleCoord.forceReleaseAll();
            pauseCoordinators.delete(msg.id);
          }

          ptyManager.spawn(msg.id, msg.options);
          spawnResult = { success: true, id: msg.id };

          // Eagerly create coordinator so all subsystems can pause from the start
          getOrCreatePauseCoordinator(msg.id);

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

      case "kill": {
        const termInfo = ptyManager.getTerminal(msg.id);
        const killedPid = termInfo?.ptyProcess.pid;
        ptyManager.kill(msg.id, msg.reason);
        if (killedPid !== undefined) {
          resourceGovernor.trackKilledPid(killedPid);
        }
        break;
      }

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
          clearTimeout(checkInterval);
          backpressureManager.deletePausedInterval(msg.id);
        }

        const pauseStart = backpressureManager.getPauseStartTime(msg.id);
        const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
        backpressureManager.deletePauseStartTime(msg.id);

        // Release backpressure hold (respects other holds like resource-governor or system-sleep)
        const atCoordinator = getPauseCoordinator(msg.id);
        atCoordinator?.resume("backpressure");

        const terminal = ptyManager.getTerminal(msg.id);
        if (terminal) {
          // Apply tier-driven ActivityMonitor polling: 50ms active, 500ms background
          const pollingInterval = tier === "active" ? 50 : 500;
          ptyManager.setActivityMonitorTier(msg.id, pollingInterval);
        }

        if (!atCoordinator?.isPaused) {
          backpressureManager.emitTerminalStatus(msg.id, "running");
        }

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
          clearTimeout(checkInterval);
          backpressureManager.deletePausedInterval(msg.id);
        }
        backpressureManager.deletePauseStartTime(msg.id);

        // Release backpressure hold via coordinator (respects other holds)
        const wakeCoordinator = getPauseCoordinator(msg.id);
        if (wasPaused) {
          wakeCoordinator?.resume("backpressure");
        }

        // Apply active tier polling (50ms) when waking
        const terminal = ptyManager.getTerminal(msg.id);
        if (terminal) {
          ptyManager.setActivityMonitorTier(msg.id, 50);
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

        if (!wakeCoordinator?.isPaused) {
          backpressureManager.emitTerminalStatus(msg.id, "running");
        }

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

      case "graceful-kill": {
        const agentSessionId = await ptyManager.gracefulKill(msg.id);
        sendEvent({
          type: "graceful-kill-result",
          requestId: msg.requestId,
          id: msg.id,
          agentSessionId,
        });
        break;
      }

      case "graceful-kill-by-project": {
        const results = await ptyManager.gracefulKillByProject(msg.projectId);
        sendEvent({
          type: "graceful-kill-by-project-result",
          requestId: msg.requestId,
          results,
        });
        break;
      }

      case "get-project-stats": {
        const stats = ptyManager.getProjectStats(msg.projectId);
        sendEvent({ type: "project-stats", requestId: msg.requestId, stats });
        break;
      }

      case "acknowledge-data": {
        const acknowledgedBytes = msg.charCount ?? 0;
        ipcQueueManager.removeBytes(msg.id, acknowledgedBytes);
        ipcQueueManager.tryResume(msg.id);

        // SAB ack-driven resume: try replaying pending segments or just resume if none left
        if (backpressureManager.isPaused(msg.id)) {
          if (backpressureManager.hasPendingSegments(msg.id)) {
            tryReplayAndResume(msg.id);
          } else {
            resumePausedTerminal(msg.id);
          }
        }

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

      case "trim-state": {
        const targetLines = normalizeScrollbackLines(msg.targetLines);
        ptyManager.trimScrollback(targetLines);
        setTimeout(() => {
          if (global.gc) global.gc();
        }, 100);
        break;
      }

      case "set-session-persist-suppressed": {
        setSessionPersistSuppressed(msg.suppressed);
        break;
      }

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
            agentId: s.agentId,
            agentState: s.agentState,
            lastStateChange: s.lastStateChange,
            spawnedAt: s.spawnedAt,
          })),
        });
        break;

      case "mark-checked":
        ptyManager.markChecked(msg.id);
        break;

      case "update-observed-title":
        ptyManager.updateObservedTitle(msg.id, msg.title);
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
            | "exit"
            | "title",
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
          const coordinator = getOrCreatePauseCoordinator(terminal.id);
          if (coordinator) {
            coordinator.pause("system-sleep");
            pausedCount++;
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
          getPauseCoordinator(terminal.id)?.resume("system-sleep");
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
                agentState: terminal.agentState,
                waitingReason: terminal.waitingReason,
                lastStateChange: terminal.lastStateChange,
                spawnedAt: terminal.spawnedAt,
                isTrashed: terminal.isTrashed,
                trashExpiresAt: terminal.trashExpiresAt,
                activityTier: ptyManager.getActivityTier(msg.id),
                hasPty,
                agentSessionId: terminal.agentSessionId,
                agentLaunchFlags: terminal.agentLaunchFlags,
                agentModelId: terminal.agentModelId,
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
        const coordinator = getPauseCoordinator(msg.id);
        if (coordinator) {
          coordinator.forceReleaseAll();
          console.log(`[PtyHost] Force resumed PTY ${msg.id} via user request`);

          // Clean up any pending backpressure monitoring
          const checkInterval = backpressureManager.getPausedInterval(msg.id);
          if (checkInterval) {
            clearTimeout(checkInterval);
            backpressureManager.deletePausedInterval(msg.id);
          }
          backpressureManager.clearPendingVisual(msg.id);

          // Calculate pause duration if we have a start time
          const pauseStart = backpressureManager.getPauseStartTime(msg.id);
          const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
          backpressureManager.deletePauseStartTime(msg.id);

          // Clear suspended flag to allow output to flow again
          backpressureManager.clearSuspended(msg.id);

          // Also clear IPC queue backpressure state
          ipcQueueManager.clearQueue(msg.id);

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
            agentState: t.agentState,
            waitingReason: t.waitingReason,
            lastStateChange: t.lastStateChange,
            spawnedAt: t.spawnedAt,
            isTrashed: t.isTrashed,
            trashExpiresAt: t.trashExpiresAt,
            activityTier: ptyManager.getActivityTier(t.id),
            hasPty: !t.wasKilled && !t.isExited,
            agentSessionId: t.agentSessionId,
            agentLaunchFlags: t.agentLaunchFlags,
            agentModelId: t.agentModelId,
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
            agentState: t.agentState,
            waitingReason: t.waitingReason,
            lastStateChange: t.lastStateChange,
            spawnedAt: t.spawnedAt,
            isTrashed: ptyManager.isInTrash(t.id),
            trashExpiresAt: t.trashExpiresAt,
            activityTier: ptyManager.getActivityTier(t.id),
            hasPty: !t.wasKilled && !t.isExited,
            agentSessionId: t.agentSessionId,
            agentLaunchFlags: t.agentLaunchFlags,
            agentModelId: t.agentModelId,
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
            agentState: t.agentState,
            waitingReason: t.waitingReason,
            lastStateChange: t.lastStateChange,
            spawnedAt: t.spawnedAt,
            isTrashed: ptyManager.isInTrash(t.id),
            trashExpiresAt: t.trashExpiresAt,
            activityTier: ptyManager.getActivityTier(t.id),
            hasPty: !t.wasKilled && !t.isExited,
            agentSessionId: t.agentSessionId,
            agentLaunchFlags: t.agentLaunchFlags,
            agentModelId: t.agentModelId,
          })),
        });
        break;
      }

      case "set-resource-monitoring":
        terminalResourceMonitor.setEnabled(msg.enabled === true);
        break;

      case "set-resource-profile": {
        const profileConfig = RESOURCE_PROFILE_CONFIGS[msg.profile as ResourceProfile];
        if (profileConfig) {
          processTreeCache.setPollInterval(profileConfig.processTreePollInterval);
          console.log(
            `[PtyHost] Resource profile set to: ${msg.profile} (processTree poll: ${profileConfig.processTreePollInterval}ms)`
          );
        }
        break;
      }

      case "set-process-tree-poll-interval": {
        if (typeof msg.ms === "number" && msg.ms > 0) {
          processTreeCache.setPollInterval(msg.ms);
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

  // Disconnect all renderer windows
  for (const windowId of Array.from(rendererConnections.keys())) {
    disconnectWindow(windowId, "cleanup");
  }

  resourceGovernor.dispose();

  for (const coordinator of pauseCoordinators.values()) {
    coordinator.forceReleaseAll();
  }
  pauseCoordinators.clear();

  backpressureManager.dispose();
  ipcQueueManager.dispose();

  terminalResourceMonitor.dispose();
  processTreeCache.stop();

  if (ptyPool) {
    ptyPool.dispose();
    ptyPool = null;
  }

  ptyManager.dispose();

  // Release SharedArrayBuffer references so V8 can GC shared memory regions
  visualBuffers = [];
  visualSignalView = null;
  analysisBuffer = null;
  ipcDataMirrorTerminals.clear();

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
    const homedir = os.homedir();

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
