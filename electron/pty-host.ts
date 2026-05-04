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

// Dead-fd errnos that must not propagate on GUI launch (AppImage/Wayland, no
// terminal). EPIPE is a closed pipe; EIO is a disconnected pty (the primary
// errno for AppImage desktop launches where fd 2 points to an orphaned pty
// slave); EBADF is a closed fd; ECONNRESET is a socket-backed stdio reset.
// ENOSPC is intentionally NOT swallowed — it's a real error condition.
const STDIO_DEAD_CODES = new Set(["EPIPE", "EIO", "EBADF", "ECONNRESET"]);
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === "function") {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code && STDIO_DEAD_CODES.has(err.code)) return;
      throw err;
    });
  }
}

import nodeV8 from "node:v8";
// Ask V8 to auto-dump up to two heap snapshots when this utility process is
// genuinely close to its --max-old-space-size limit. Snapshot path is governed
// by the parent's `--diagnostic-dir` execArgv (set in PtyClient).
nodeV8.setHeapSnapshotNearHeapLimit(2);

import { MessagePort } from "node:worker_threads";
import os from "node:os";
import { PtyManager } from "./services/PtyManager.js";
import { PtyPool, getPtyPool } from "./services/PtyPool.js";
import { ProcessTreeCache } from "./services/ProcessTreeCache.js";
import { TerminalResourceMonitor } from "./services/pty/TerminalResourceMonitor.js";
import { events } from "./services/events.js";
import { SharedRingBuffer, PacketFramer } from "../shared/utils/SharedRingBuffer.js";
import { selectShard } from "../shared/utils/shardSelection.js";
import type { PtyHostEvent } from "../shared/types/pty-host.js";
import {
  appendEmergencyLog,
  emergencyLogFatal,
  PtyPauseCoordinator,
  ResourceGovernor,
  BackpressureManager,
  IpcQueueManager,
  PortQueueManager,
  metricsEnabled,
  MAX_PACKET_PAYLOAD,
  BACKPRESSURE_SAFETY_TIMEOUT_MS,
} from "./pty-host/index.js";
import {
  createPtyHostMessageDispatcher,
  type HostContext,
  type RendererConnection,
} from "./pty-host/handlers/index.js";
import { isSmokeTestTerminalId } from "../shared/utils/smokeTestTerminals.js";
import { formatErrorMessage } from "../shared/utils/errorMessage.js";

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
      error: formatErrorMessage(reason, "Unhandled rejection in PTY host"),
    });
  } catch {
    // ignore
  }
});

const ptyManager = new PtyManager();
// 1.5s base poll interval. With 2-poll hysteresis in ProcessDetector, that's
// ~3s to commit an agent/process change. Short enough for "I just ran claude
// and want to see the chrome flip" to feel responsive, long enough to filter
// `claude --version`-style blips. Adaptive backoff (see ProcessTreeCache)
// stretches this out when the tree is quiet.
const processTreeCache = new ProcessTreeCache(1500);
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
  getPendingBytesSnapshot: () => backpressureManager.getPendingBytesSnapshot(),
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
    // Carry raw bytes on the hot MessagePort path so the renderer receives a
    // transferred ArrayBuffer instead of a structured-cloned UTF-8 string.
    // Wrap with `new Uint8Array(...)` to escape node-pty's Buffer pool slab —
    // each batcher will copy these chunks into a fresh isolated buffer at
    // flush time before they land in the postMessage transfer list.
    const chunk =
      typeof data === "string" ? new Uint8Array(Buffer.from(data, "utf8")) : new Uint8Array(data);
    const byteCount = chunk.byteLength;

    for (const [windowId, conn] of rendererConnections) {
      const windowProject = windowProjectMap.get(windowId) ?? null;
      const termProject = terminalInfo?.projectId ?? null;
      const filtered = windowProject !== null && termProject !== windowProject;

      if (filtered) continue;

      if (conn.batcher.write(id, chunk, byteCount)) {
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
    defaultTitle: payload.defaultTitle,
    timestamp: payload.timestamp,
  });
});

events.on("agent:exited", (payload) => {
  sendEvent({
    type: "agent-exited",
    terminalId: payload.terminalId,
    agentType: payload.agentType,
    defaultTitle: payload.defaultTitle,
    timestamp: payload.timestamp,
    exitKind: payload.exitKind,
  });
});

events.on("agent:spawned", (payload) => {
  sendEvent({
    type: "agent-spawned",
    payload: {
      agentId: payload.agentId,
      terminalId: payload.terminalId,
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

// Build the message dispatcher with a stable HostContext that exposes the
// reassignable buffer/pool fields via getter/setter pairs. Handler modules
// always read the current value through the getter, so `init-buffers` and
// `initialize()` reassignments propagate without each module having to
// re-bind a local snapshot.
const hostContext: HostContext = {
  ptyManager,
  processTreeCache,
  terminalResourceMonitor,
  backpressureManager,
  ipcQueueManager,
  resourceGovernor,
  packetFramer,
  pauseCoordinators,
  rendererConnections,
  windowProjectMap,
  ipcDataMirrorTerminals,
  get visualBuffers() {
    return visualBuffers;
  },
  set visualBuffers(value: SharedRingBuffer[]) {
    visualBuffers = value;
  },
  get visualSignalView() {
    return visualSignalView;
  },
  set visualSignalView(value: Int32Array | null) {
    visualSignalView = value;
  },
  get analysisBuffer() {
    return analysisBuffer;
  },
  set analysisBuffer(value: SharedRingBuffer | null) {
    analysisBuffer = value;
  },
  get ptyPool() {
    return ptyPool;
  },
  set ptyPool(value: PtyPool | null) {
    ptyPool = value;
  },
  sendEvent,
  getPauseCoordinator,
  getOrCreatePauseCoordinator,
  disconnectWindow,
  recomputeActivityTiers,
  tryReplayAndResume,
  resumePausedTerminal,
  createPortQueueManager,
};

const dispatchMessage = createPtyHostMessageDispatcher(hostContext);

// Handle requests from Main
port.on("message", async (rawMsg: any) => {
  // Electron/Node might wrap the message in { data: ..., ports: [] }
  const msg = rawMsg?.data ? rawMsg.data : rawMsg;
  const ports = rawMsg?.ports || [];

  try {
    if (msg?.type === "dispose") {
      cleanup();
      return;
    }
    await dispatchMessage(msg, ports);
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
