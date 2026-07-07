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
import {
  AnalysisWorkerPool,
  analysisWorkersDisabled,
  defaultAnalysisPoolSize,
} from "./services/pty/analysis/AnalysisWorkerPool.js";
import { PtyPool, getPtyPool, shouldEnablePtyPool } from "./services/PtyPool.js";
import { ProcessTreeCache } from "./services/ProcessTreeCache.js";
import { ImagePathProbe } from "./services/pty/ImagePathProbe.js";
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
  type TerminalWorkerConnection,
} from "./pty-host/handlers/index.js";
import { PORT_BATCH_INTERACTIVE_INPUT_WINDOW_MS } from "./services/pty/types.js";
import { isSmokeTestTerminalId } from "../shared/utils/smokeTestTerminals.js";
import { startEventLoopMonitor } from "./pty-host/eventLoopMonitor.js";
import { SCROLLBACK_MIN } from "../shared/config/scrollback.js";
import { formatErrorMessage } from "../shared/utils/errorMessage.js";
import { PERF_MARKS } from "../shared/perf/marks.js";
import { markHostPerformance } from "./utils/hostPerformance.js";

// First user-code statement after all imports settle. ESM hoists native
// module dlopen (node-pty, ProcessTreeCache native deps) ahead of any
// statement here, so this is the earliest feasible proxy for "native modules
// loaded". The exact dlopen instant is not reachable from ESM.
markHostPerformance(PERF_MARKS.PTY_HOST_NATIVE_MODULE_READY);

// Validate we're running in UtilityProcess context
if (!process.parentPort) {
  emergencyLogFatal("FATAL_INIT_NO_PARENT_PORT", new Error("Must run in UtilityProcess context"));
  throw new Error("[PtyHost] Must run in UtilityProcess context");
}

const port = process.parentPort as unknown as MessagePort;

appendEmergencyLog(`[${new Date().toISOString()}] [START] pid=${process.pid}\n`);

// Loop-lag self-measurement for the "why am I slow?" flow-control snapshot —
// this process is where multi-terminal parse load lands, and the main
// process's lag monitor can't see it.
startEventLoopMonitor();

// Global error handlers to prevent silent crashes
process.on("uncaughtException", (err) => {
  console.error("[PtyHost] Uncaught Exception:", err);
  emergencyLogFatal("UNCAUGHT_EXCEPTION", err);
  try {
    sendEvent({ type: "error", id: "system", error: err.message });
  } catch {
    // ignore
  }
  // Exit on next tick so Mojo IPC can flush the error event before the process dies.
  // Without this, the parent never sees `child-process-gone` and the host stays a zombie.
  setImmediate(() => process.exit(1));
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
  // Electron 37+ no longer crashes on unhandled rejection by default — exit explicitly
  // so the parent's child-process-gone supervision path triggers.
  setImmediate(() => process.exit(1));
});

const ptyManager = new PtyManager();

// Analysis worker pool: moves the per-chunk analysis stack (headless xterm
// mirror + ActivityMonitor) off this thread so the pty-host event loop only
// does I/O (node-pty reads, batching/backpressure, forwarding). Kill switch:
// DAINTREE_DISABLE_ANALYSIS_WORKERS=1 restores the legacy in-thread path.
let analysisWorkerPool: AnalysisWorkerPool | null = null;
if (!analysisWorkersDisabled()) {
  const analysisPoolSize = defaultAnalysisPoolSize();
  analysisWorkerPool = new AnalysisWorkerPool(analysisPoolSize);
  ptyManager.setAnalysisWorkerPool(analysisWorkerPool);
  console.log(`[PtyHost] Analysis worker pool enabled (max ${analysisPoolSize} workers)`);
} else {
  console.log("[PtyHost] Analysis workers disabled; running analysis in-thread");
}

// 1.5s base poll interval. With 2-poll hysteresis in ProcessDetector, that's
// ~3s to commit an agent/process change. Short enough for "I just ran claude
// and want to see the chrome flip" to feel responsive, long enough to filter
// `claude --version`-style blips. Adaptive backoff (see ProcessTreeCache)
// stretches this out when the tree is quiet.
const processTreeCache = new ProcessTreeCache(1500);
// Image-path identity signal — defeats `process.title`/`setproctitle` rewrites
// where comm/argv have been clobbered but the on-disk binary path still
// identifies the agent. Shared across all terminals so the per-PID cache is
// reused when a process appears in multiple detection passes. #8790
const imagePathProbe = new ImagePathProbe();
const terminalResourceMonitor = new TerminalResourceMonitor(
  processTreeCache,
  ptyManager,
  sendEvent
);
let ptyPool: PtyPool | null = null;
// True when the boot-time homedir pool warm was deferred because main
// signalled an imminent project restore (DAINTREE_PTY_DEFER_POOL_WARM).
// Consumed by the first set-active-project / project-switch handler.
let initialPoolWarmDeferred = false;

// Zero-copy ring buffers for terminal I/O (set via init-buffers message)
// Visual buffers: consumed by renderer (xterm.js) - critical path, sharded for isolation
// Analysis buffer: consumed by Web Worker - best-effort, can drop frames
let visualBuffers: SharedRingBuffer[] = [];
let visualSignalView: Int32Array | null = null;
let analysisBuffer: SharedRingBuffer | null = null;
const packetFramer = new PacketFramer();
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

// Throughput-rate gauge: accumulates per-terminal raw PTY byte/packet counts
// between ResourceGovernor ticks. Double-buffer swap at tick boundary avoids
// iterator invalidation during Map iteration.
let throughputAccumulator = new Map<string, { totalBytes: number; packetCount: number }>();

// Pause-duration gauge: closure-scoped map of `terminalId → set of pause
// sources currently holding the terminal`. Aggregated across SAB, IPC, and
// per-window MessagePort pause sources. The `Set` is keyed by source id
// (`"sab"`, `"ipc"`, `"port-{windowId}"`) so a `pause-end` from one path
// only clears that path's hold — a terminal paused by both IPC and a port
// window stays in the map until BOTH paths resume. Each pause source
// also records its own start time so the renderer-facing `heldDurationMs`
// reflects the oldest still-held start (the user-meaningful "how long has
// this been paused?" answer).
type PauseSource = "sab" | "ipc" | `port-${number}` | `port-worker-${number}`;
interface PauseSourceEntry {
  startTime: number;
}
const pausedTerminals = new Map<string, Map<PauseSource, PauseSourceEntry>>();

/**
 * Add a pause source to the per-terminal tracking set. Records the
 * pause-start time for the source (later start times are ignored —
 * the first source to pause owns the held-duration clock).
 */
function addPauseSource(terminalId: string, source: PauseSource, startTime: number): void {
  let sources = pausedTerminals.get(terminalId);
  if (!sources) {
    sources = new Map();
    pausedTerminals.set(terminalId, sources);
  }
  if (!sources.has(source)) {
    sources.set(source, { startTime });
  }
}

/**
 * Remove a pause source from the per-terminal tracking set. Returns
 * `true` if the terminal still has other sources holding (kept in the
 * map), `false` if all sources cleared (terminal removed from map).
 */
function removePauseSource(terminalId: string, source: PauseSource): boolean {
  const sources = pausedTerminals.get(terminalId);
  if (!sources) return false;
  sources.delete(source);
  if (sources.size === 0) {
    pausedTerminals.delete(terminalId);
    return false;
  }
  return true;
}

/**
 * Remove all pause sources for a terminal (used by terminal-exit
 * cleanup, where any pending sources are stale and the panel is gone).
 */
function clearAllPauseSources(terminalId: string): void {
  pausedTerminals.delete(terminalId);
}

/**
 * Per-paused-terminal held duration, aggregated across SAB, IPC, and per-window
 * MessagePort pause sources via the `pausedTerminals` map. A terminal is
 * included as long as ANY source is still holding; the held duration uses the
 * OLDEST start time across sources (the user-meaningful "how long has this been
 * paused?" answer). Shared by the streaming `pause-duration-gauge` and the
 * on-demand flow-control snapshot so both see the same authoritative durations —
 * the live IPC/port paths keep their own start times outside
 * `backpressureManager.pauseStartTimes` (which only the dead SAB path writes).
 */
function getPausedDurationsSnapshot(): Array<{ terminalId: string; heldDurationMs: number }> {
  if (pausedTerminals.size === 0) return [];
  const now = Date.now();
  const out: Array<{ terminalId: string; heldDurationMs: number }> = [];
  for (const [terminalId, sources] of pausedTerminals) {
    let oldestStart = Number.POSITIVE_INFINITY;
    for (const { startTime } of sources.values()) {
      if (startTime < oldestStart) oldestStart = startTime;
    }
    out.push({ terminalId, heldDurationMs: Math.max(0, now - oldestStart) });
  }
  return out;
}

/**
 * Reliabilty-metric types whose wire emission is required for UI correctness
 * (recovery affordances, Tier-3 escalations) and therefore MUST bypass the
 * `DAINTREE_TERMINAL_METRICS` opt-in flag. The flag is preserved for the
 * high-volume, per-tick gauges (throughput-rate, queue-depth-gauge,
 * pending-bytes-gauge, data-loss-count) that exist purely for diagnostic
 * telemetry — splitting the two keeps the user-facing recovery surfaces
 * live in production while leaving diagnostic noise opt-in.
 *
 * Add new metric types here only when the renderer needs them to surface
 * a recovery affordance. Diagnostic-only metrics stay gated.
 */
import { isLoadBearingReliabilityMetric } from "./pty-host/loadBearingMetrics.js";

// Data-loss counter: closure-scoped accumulator of dropped-bytes and
// drop-event counts since the last snapshot. The counter is incremented
// unconditionally at the drop site so regression detection is observable
// even when metrics are gated off; the wire emission itself is gated by
// `metricsEnabled()` in `emitDataLossCount`. Reset semantics: the counter
// is reset on EVERY tick (not just on the gated emit path) so toggling
// metrics on doesn't dump the entire historical backlog as a single
// false "regression" on the first emit after the gate opens.
let dropAccumulator = { droppedBytes: 0, dataLossCount: 0 };

// Per-terminal drop attribution for the on-demand flow-control snapshot
// ("why is this terminal slow / missing output?"). The streaming
// `data-loss-count` gauge only carries process-wide deltas, so a support
// bundle could see THAT bytes were dropped but not WHOSE. Bounded: entries
// are removed on terminal exit and the map is capped by evicting the
// oldest-drop entry — a diagnostic tally must never become its own leak.
// Updated only at drop sites (rare by construction), so it costs nothing on
// the healthy hot path.
interface TerminalDropTally {
  droppedBytes: number;
  dropCount: number;
  lastDropAt: number;
}
const MAX_DROP_TALLY_TERMINALS = 256;
const terminalDropTallies = new Map<string, TerminalDropTally>();

function recordTerminalDrop(terminalId: string, droppedBytes: number): void {
  const existing = terminalDropTallies.get(terminalId);
  if (existing) {
    existing.droppedBytes += droppedBytes;
    existing.dropCount += 1;
    existing.lastDropAt = Date.now();
    return;
  }
  if (terminalDropTallies.size >= MAX_DROP_TALLY_TERMINALS) {
    let oldestId: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, tally] of terminalDropTallies) {
      if (tally.lastDropAt < oldestAt) {
        oldestAt = tally.lastDropAt;
        oldestId = id;
      }
    }
    if (oldestId !== null) terminalDropTallies.delete(oldestId);
  }
  terminalDropTallies.set(terminalId, {
    droppedBytes,
    dropCount: 1,
    lastDropAt: Date.now(),
  });
}

/**
 * Canonical funnel for terminal reliability-metric events. Wraps the
 * `backpressureManager.emitReliabilityMetric` call (which is wired into
 * every queue manager, the inline SAB-path emits, and now the
 * `BackpressureManager` itself via a constructor dep) so we can observe
 * `pause-start` / `pause-end` pairs to maintain the `pausedTerminals`
 * map. The `forceEmit` escape hatch on the underlying call still works
 * (passthrough) for the data-loss pulse that bypasses the metric gate.
 *
 * `source` identifies the pause source so multi-source attribution
 * works (e.g., a port-window disconnect only removes the
 * `port-{windowId}` source — if IPC is also pausing the same terminal,
 * the terminal stays in the map).
 */
function emitReliabilityMetricWithTracking(
  payload: import("../shared/types/pty-host.js").TerminalReliabilityMetricPayload,
  source: PauseSource | null,
  forceEmit = false
): void {
  if (source !== null) {
    if (payload.metricType === "pause-start") {
      addPauseSource(payload.terminalId, source, payload.timestamp);
    } else if (payload.metricType === "pause-end" || payload.metricType === "suspend") {
      removePauseSource(payload.terminalId, source);
    }
  } else if (
    // `null` source + `pause-end`/`suspend` = user/system force-resume
    // (e.g., the `pause-end` emitted by the force-resume handler at
    // `electron/pty-host/handlers/backpressure.ts:215` after `clearQueue`
    // tore down the queue managers' internal pause maps). Clear ALL
    // sources for the terminal — attribution is moot when the user has
    // explicitly asked for a full resume.
    payload.metricType === "pause-end" ||
    payload.metricType === "suspend"
  ) {
    // For `null`-source `pause-end`/`suspend`, populate `durationMs` from the
    // oldest recorded pause-start across sources — matches the gauge
    // semantics at `getPausedDurationsSnapshot` (the user-meaningful
    // "how long has this been paused?" answer). The `force-resume` handler
    // previously read from `backpressureManager.getPauseStartTime()`, a
    // SAB-only map that production pauses never populate. Computing the
    // duration here from the closure map is the multi-source-of-truth path
    // and makes the wire event correct in production (issue #9898).
    if (payload.durationMs === undefined) {
      const sources = pausedTerminals.get(payload.terminalId);
      if (sources && sources.size > 0) {
        let oldestStart = Number.POSITIVE_INFINITY;
        for (const { startTime } of sources.values()) {
          if (startTime < oldestStart) oldestStart = startTime;
        }
        payload.durationMs = Math.max(0, Date.now() - oldestStart);
      }
    }
    clearAllPauseSources(payload.terminalId);
  }
  // This funnel TERMINATES the chain: emit the wire event directly. We must
  // NOT call `backpressureManager.emitReliabilityMetric` here — in production
  // the manager is constructed with its `emitReliabilityMetric` dep wired
  // back to this funnel (see construction below), so re-entering it would
  // route straight back here and recurse until the stack overflows. The gate
  // splits: load-bearing recovery signals (pause-start/pause-end/suspend/
  // pause-duration-gauge) emit unconditionally so UI recovery affordances
  // work in production; `forceEmit` still bypasses the gate for the
  // data-loss pulse; the rest of the metrics (throughput-rate,
  // queue-depth-gauge, pending-bytes-gauge, data-loss-count) stay gated on
  // `DAINTREE_TERMINAL_METRICS=1` to keep diagnostic noise opt-in.
  if (!forceEmit && !isLoadBearingReliabilityMetric(payload.metricType) && !metricsEnabled()) {
    return;
  }
  sendEvent({
    type: "terminal-reliability-metric",
    payload,
  });
}

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
// Dedicated worker-ingest ports (issue #10960), keyed windowId → terminalId.
// Engaged entries take over that terminal's output routing for that window;
// everything else in the window stays on the shared per-window port.
const terminalWorkerConnections = new Map<number, Map<string, TerminalWorkerConnection>>();
const windowProjectMap = new Map<number, string | null>();
// Per-window UI-focused terminal id (from the renderer's focusedId). Read by
// each window's PortQueueManager/PortBatcher to prioritize the focused pane.
const windowFocusedTerminalMap = new Map<number, string | null>();

// Helper to send events to Main process
function sendEvent(event: PtyHostEvent): void {
  port.postMessage(event);
}

// Instantiate managers with dependency injection
// `backpressureManager.emitReliabilityMetric` is the canonical funnel
// for SAB-path emissions. Routing through it (via the `emitReliabilityMetric`
// dep) means the closure-scoped per-source pause-tracking map stays in
// sync with every reliability-metric event the manager emits — including
// the internal `suspend` from `suspendVisualStream`'s safety-timeout
// path. Source is `null` for these internal calls (we don't attribute
// SAB-path sources to a specific window) — only the IPC and port queue
// paths carry real source ids.
const backpressureManager = new BackpressureManager({
  getTerminal: (id) => ptyManager.getTerminal(id),
  getPauseCoordinator,
  sendEvent,
  metricsEnabled,
  emitReliabilityMetric: (payload, forceEmit) =>
    emitReliabilityMetricWithTracking(payload, null, forceEmit),
});

const ipcQueueManager = new IpcQueueManager({
  getTerminal: (id) => ptyManager.getTerminal(id),
  getPauseCoordinator,
  sendEvent,
  metricsEnabled,
  emitTerminalStatus: (...args) => backpressureManager.emitTerminalStatus(...args),
  emitReliabilityMetric: (payload) => emitReliabilityMetricWithTracking(payload, "ipc"),
});

// PortQueueManager deps factory — creates per-window instances with unique pause tokens
function createPortQueueManager(windowId: number): PortQueueManager {
  return new PortQueueManager({
    getTerminal: (id) => ptyManager.getTerminal(id),
    getPauseCoordinator,
    sendEvent,
    metricsEnabled,
    emitTerminalStatus: (...args) => backpressureManager.emitTerminalStatus(...args),
    emitReliabilityMetric: (payload) =>
      emitReliabilityMetricWithTracking(payload, `port-${windowId}` as PauseSource),
    pauseToken: `port-queue-${windowId}`,
    getFocusedTerminalId: () => windowFocusedTerminalMap.get(windowId) ?? null,
  });
}

// Per-(window, terminal) queue manager for a dedicated worker-ingest port.
// Same watermark/pause machinery as the window queue, scoped to one terminal;
// a worker-ingested terminal is BACKGROUND-tier by definition, so it never
// claims the focused-terminal exemption.
function createTerminalWorkerPortQueueManager(
  windowId: number,
  terminalId: string
): PortQueueManager {
  return new PortQueueManager({
    getTerminal: (id) => ptyManager.getTerminal(id),
    getPauseCoordinator,
    sendEvent,
    metricsEnabled,
    emitTerminalStatus: (...args) => backpressureManager.emitTerminalStatus(...args),
    emitReliabilityMetric: (payload) =>
      emitReliabilityMetricWithTracking(payload, `port-worker-${windowId}` as PauseSource),
    pauseToken: `port-queue-worker-${windowId}-${terminalId}`,
    getFocusedTerminalId: () => null,
  });
}

/**
 * Force-activate the terminals of the project that just became foreground for
 * some window (#10857). Scoped to `nextProjectId` only — terminals belonging
 * to other projects, or with no project, are left untouched, preserving
 * whatever tier TerminalRendererPolicy's own "set-activity-tier" IPC last set
 * for them instead of bouncing every terminal in every project back to the
 * expensive 50ms poll on each project switch.
 *
 * Never demotes anything (`nextProjectId === null` is a no-op): the visual
 * byte stream is unconditional regardless of tier (see the isBackgrounded
 * gate below), so the only effect of this function is ActivityMonitor's
 * polling cadence — demoting on switch-away would just be redundant with
 * the renderer's own background-tier push, while skipping it here keeps the
 * hibernation-removal invariant (#10805/#10807) intact: nothing ever goes
 * stale, so there is nothing to lossily resync on wake.
 */
function recomputeActivityTiers(nextProjectId: string | null): void {
  if (nextProjectId === null) return;
  for (const id of ptyManager.getTerminalsForProject(nextProjectId)) {
    const tier = "active" as const;
    backpressureManager.setActivityTier(id, tier, "recompute-activity-tiers");
    ptyManager.setActivityMonitorTier(id, tier, 50);

    // Reconcile the renderer's dedupe baseline. The host rewrites the tier
    // here unilaterally, but TerminalRendererPolicy.setBackendTier dedupes
    // outbound tier messages against its last-known tier — so without this
    // push the renderer can believe a terminal is still "active" while the
    // producer gate suppresses its bytes, leaving the pane frozen (issue
    // #9778). Posted on the same per-window MessagePort as data so it stays
    // FIFO-ordered ahead of any subsequently gated chunk. Projects are
    // filtered exactly like the data path.
    for (const [windowId, conn] of rendererConnections) {
      const windowProject = windowProjectMap.get(windowId) ?? null;
      if (windowProject !== null && nextProjectId !== windowProject) continue;
      try {
        conn.port.postMessage({ type: "tier-changed", id, tier });
      } catch {
        // Port closing between iteration and post — disconnect handles cleanup.
      }
    }
  }
}

/**
 * Disconnect one dedicated worker-ingest port and clean up its resources.
 * Mirrors disconnectWindow's teardown discipline at (window, terminal) scope:
 * batched-but-unflushed bytes are accounted as data loss (the wake/restore
 * snapshot is the recovery path), pause holds release before disposal, and
 * the port itself is closed — never left to GC (#6283).
 */
function disconnectTerminalWorkerPort(windowId: number, terminalId: string, reason: string): void {
  const perWindow = terminalWorkerConnections.get(windowId);
  const conn = perWindow?.get(terminalId);
  if (!perWindow || !conn) return;

  try {
    conn.port.removeListener("message", conn.handler);
  } catch {
    // ignore
  }
  for (const { id, bytes } of conn.batcher.getPendingByteSnapshot()) {
    dropAccumulator.droppedBytes += bytes;
    dropAccumulator.dataLossCount += 1;
    recordTerminalDrop(id, bytes);
  }
  conn.batcher.dispose();
  const pausedByThisPort = [...conn.portQueueManager.getPausedTerminalIds()];
  conn.portQueueManager.resumeAll();
  for (const pausedId of pausedByThisPort) {
    removePauseSource(pausedId, `port-worker-${windowId}` as PauseSource);
  }
  conn.portQueueManager.dispose();
  try {
    conn.port.close();
  } catch {
    // ignore
  }

  perWindow.delete(terminalId);
  if (perWindow.size === 0) {
    terminalWorkerConnections.delete(windowId);
  }
  console.log(
    `[PtyHost] Worker-ingest port disconnected for terminal ${terminalId} (window ${windowId}, ${reason})`
  );
}

/** Disconnect a window's renderer port and clean up its resources */
function disconnectWindow(windowId: number, reason: string): void {
  // Dedicated worker-ingest ports die with the window connection — routing
  // for them is meaningless once the window port is gone, and a leaked
  // producer port queues unboundedly (#6283). Runs before the early return:
  // dedicated entries can outlive a window port that failed first.
  const workerConns = terminalWorkerConnections.get(windowId);
  if (workerConns) {
    for (const terminalId of [...workerConns.keys()]) {
      disconnectTerminalWorkerPort(windowId, terminalId, `window-${reason}`);
    }
  }

  const conn = rendererConnections.get(windowId);
  if (!conn) return;

  try {
    conn.port.removeListener("message", conn.handler);
  } catch {
    // ignore
  }
  // Batched-but-unflushed bytes die with the port — account them as data loss
  // (they were headed to a renderer that will never receive them; the wake/
  // restore snapshot is the recovery path). dispose() below discards the
  // chunks without any bookkeeping of its own.
  for (const { id, bytes } of conn.batcher.getPendingByteSnapshot()) {
    dropAccumulator.droppedBytes += bytes;
    dropAccumulator.dataLossCount += 1;
    recordTerminalDrop(id, bytes);
  }
  // Dispose batcher (drops buffered data — port is closing)
  conn.batcher.dispose();
  // Snapshot the paused set BEFORE resumeAll: resumeAll clears the manager's
  // pause map, and `getPausedTerminalIds()` is a live iterator over that map —
  // iterating it after resumeAll visits nothing, leaking this window's
  // per-source pause-tracking entries (stale `heldDurationMs` gauges for a
  // window that no longer exists).
  const pausedByThisWindow = [...conn.portQueueManager.getPausedTerminalIds()];
  // Release port-queue pause holds before disposing
  conn.portQueueManager.resumeAll();
  // Clear this window's per-source pause-tracking entries. Multi-source
  // attribution: a terminal paused by BOTH the port window and the IPC
  // queue must NOT lose its held-duration tracking when just the window
  // disconnects — `removePauseSource` keeps the entry alive while the
  // IPC path still holds. The renderer is informed via the queue
  // manager's own resume flow + tier-changed message.
  for (const terminalId of pausedByThisWindow) {
    removePauseSource(terminalId, `port-${windowId}` as PauseSource);
  }
  conn.portQueueManager.dispose();
  try {
    conn.port.close();
  } catch {
    // ignore
  }

  rendererConnections.delete(windowId);
  // Keep the active project mapping across transient renderer-port failures.
  // Without it, a multi-view window whose MessagePort just failed falls back
  // to the single-consumer SAB path and another cached view can consume/drop
  // the active terminal's bytes. Explicit window teardown is the only case
  // that should forget the project context.
  if (reason === "explicit-disconnect") {
    windowProjectMap.delete(windowId);
    windowFocusedTerminalMap.delete(windowId);
  }
  // A disconnect never grows scope (no project gains a viewer), so this is
  // intentionally a no-op today — kept as the single chokepoint all 3
  // recompute call sites route through, for discoverability.
  recomputeActivityTiers(null);
  console.log(`[PtyHost] Window ${windowId} disconnected (${reason})`);
}

const resourceGovernor = new ResourceGovernor({
  getTerminalIds: () => ptyManager.getAll().map((t) => t.id),
  getPauseCoordinator,
  getTerminalCount: () => ptyManager.getActiveTerminalIds().length,
  incrementPauseCount: (count) => {
    backpressureManager.stats.pauseCount += count;
  },
  sendEvent,
  emitTerminalStatus: (...args) => backpressureManager.emitTerminalStatus(...args),
  getTerminalActivity: () =>
    ptyManager.getAll().map((t) => ({
      id: t.id,
      lastOutputTime: t.lastOutputTime,
      lastInputTime: t.lastInputTime,
      agentState: t.agentState,
    })),
  trimBuffers: () => ptyManager.trimScrollback(SCROLLBACK_MIN),
  getTerminalBufferSizes: () => ptyManager.getTerminalBufferSizes(),
  // Worker-isolate memory self-reports: the governor's own process.memoryUsage()
  // cannot see the analysis workers' heaps or xterm buffer backing stores
  // (separate V8 isolates). Empty in in-thread mode, where the base signal
  // already covers the mirrors.
  getWorkerMemoryAccounting: () => analysisWorkerPool?.getMemoryAccounting() ?? [],
  trimBuffersTargeted: (targets) => {
    for (const [id, targetLines] of targets) {
      try {
        ptyManager.trimTerminalScrollback(id, targetLines);
      } catch (err) {
        console.warn("[PtyHost] trimTerminalScrollback failed for", id, err);
      }
    }
  },
  getPendingBytesSnapshot: () => {
    // Merge SAB-path, IPC-path, and per-window MessagePort-path queue depths so
    // the reliability gauge captures every in-flight byte the pty-host is holding.
    // totalPendingBytes is an exact sum across paths. The perTerminal array may
    // contain duplicate entries for a terminal that streams to multiple windows
    // simultaneously (one entry per window's port queue) — that's intentional
    // for the reliability gauge, which wants per-path attribution rather than a
    // collapsed per-terminal view.
    const sab = backpressureManager.getPendingBytesSnapshot();
    const ipc = ipcQueueManager.getQueueSnapshot();
    let totalPendingBytes = sab.totalPendingBytes + ipc.totalPendingBytes;
    const perTerminal = [...sab.perTerminal, ...ipc.perTerminal];
    for (const conn of rendererConnections.values()) {
      const port = conn.portQueueManager.getQueueSnapshot();
      totalPendingBytes += port.totalPendingBytes;
      perTerminal.push(...port.perTerminal);
    }
    return { totalPendingBytes, perTerminal };
  },
  getThroughputSnapshot: () => {
    // Clear the accumulator on every tick so stale entries from toggled-off
    // intervals aren't replayed with misleading elapsed times later.
    const acc = throughputAccumulator;
    throughputAccumulator = new Map();
    if (!metricsEnabled()) return null;
    let totalBytes = 0;
    let totalPackets = 0;
    if (acc.size === 0) return null;
    const perTerminal: Array<{ terminalId: string; byteCount: number; packetCount: number }> = [];
    for (const [terminalId, entry] of acc) {
      totalBytes += entry.totalBytes;
      totalPackets += entry.packetCount;
      perTerminal.push({
        terminalId,
        byteCount: entry.totalBytes,
        packetCount: entry.packetCount,
      });
    }
    return {
      timestamp: Date.now(),
      totalBytes,
      totalPackets,
      perTerminal,
      pauseCount: backpressureManager.stats.pauseCount,
    };
  },
  getPausedDurationsSnapshot,
  getQueueDepthSnapshot: () => {
    // Live IPC + per-window MessagePort paths only. The FUTURE_SAB path is
    // dead in production (SharedArrayBuffer is not supported in
    // Electron UtilityProcess) and is intentionally excluded so the
    // dead-code and live paths stay independently observable. Each entry
    // carries the path `layer` so consumers can split per-transport
    // attribution in one pass.
    const out: Array<{
      terminalId: string;
      layer: "ipc" | "port";
      pendingBytes: number;
    }> = [];
    const ipc = ipcQueueManager.getQueueSnapshot();
    for (const { terminalId, pendingBytes } of ipc.perTerminal) {
      if (pendingBytes > 0) out.push({ terminalId, layer: "ipc", pendingBytes });
    }
    for (const conn of rendererConnections.values()) {
      const port = conn.portQueueManager.getQueueSnapshot();
      for (const { terminalId, pendingBytes } of port.perTerminal) {
        if (pendingBytes > 0) out.push({ terminalId, layer: "port", pendingBytes });
      }
    }
    return out;
  },
  getDropSnapshot: () => {
    // Snapshot-and-reset. Mirrors `getThroughputSnapshot` so a tick with
    // no drops produces a zero-delta payload and the gated emission site
    // correctly skips the wire event. Counter itself is incremented
    // unconditionally at the drop site (independent of this function).
    const snapshot = {
      droppedBytesDelta: dropAccumulator.droppedBytes,
      dataLossCountDelta: dropAccumulator.dataLossCount,
    };
    dropAccumulator = { droppedBytes: 0, dataLossCount: 0 };
    return snapshot;
  },
});

// Helper to convert data to string for IPC fallback (IPC events expect string)
function toStringForIpc(data: string | Uint8Array): string {
  return typeof data === "string" ? data : textDecoder.decode(data);
}

// Wire up PtyManager events
ptyManager.on("data", (id: string, data: string | Uint8Array) => {
  // Throughput-rate gauge accumulation — raw PTY byte/packet counts before
  // any path routing, suspension gating, or chunk wrapping. Gated so the hot
  // path is untouched when metrics are disabled (the default).
  if (metricsEnabled()) {
    const rawByteCount =
      typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
    let acc = throughputAccumulator.get(id);
    if (!acc) {
      acc = { totalBytes: 0, packetCount: 0 };
      throughputAccumulator.set(id, acc);
    }
    acc.totalBytes += rawByteCount;
    acc.packetCount += 1;
  }

  // Terminal output always updates headless state; visual streaming can be suspended under backpressure.
  const isSuspended = backpressureManager.isSuspended(id);
  const terminalInfo = ptyManager.getTerminal(id);

  // Every chunk mutates the headless buffer regardless of routing — bump the
  // epoch unconditionally so a suppressed/suspended/dropped chunk invalidates
  // the wake no-change skip for every window.
  if (terminalInfo) {
    terminalInfo.contentEpoch++;
  }

  // EXPERIMENT (hibernation teardown step 1 — #10807): visual streaming is
  // unconditional with respect to the background tier. recomputeActivityTiers no
  // longer demotes terminals to "background", and as belt-and-suspenders we hard-
  // pin this gate off so a stray "background" tier from any other path can never
  // suppress the live visual byte stream. The isSuspended (backpressure) gate and
  // the project-routing filter below are unchanged; analysis/headless buffer
  // writes and agent-state detection still run. See
  // docs/HIBERNATION-REMOVAL-EXPERIMENT.md.
  const isBackgrounded = false;
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
    const termProject = terminalInfo?.projectId ?? null;
    const targets: Array<{ windowId: number; conn: RendererConnection }> = [];
    for (const [windowId, conn] of rendererConnections) {
      const windowProject = windowProjectMap.get(windowId) ?? null;
      const filtered = windowProject !== null && termProject !== windowProject;
      if (filtered) continue;
      targets.push({ windowId, conn });
    }

    // Encode only when a target window remains after project filtering — a
    // fully-filtered chunk falls through to the IPC fallback's original string.
    if (targets.length > 0) {
      // Carry raw bytes on the hot MessagePort path so the renderer receives a
      // transferred ArrayBuffer instead of a structured-cloned UTF-8 string.
      // TextEncoder encodes strings into a standalone, exactly-sized buffer in
      // one pass; the `new Uint8Array(...)` wrap on the bytes branch escapes
      // node-pty's Buffer pool slab — each batcher will copy these chunks into
      // a fresh isolated buffer at flush time before they land in the
      // postMessage transfer list.
      const chunk = typeof data === "string" ? textEncoder.encode(data) : new Uint8Array(data);
      const byteCount = chunk.byteLength;

      // The chunk's ArrayBuffer can only be transferred zero-copy when exactly one
      // batcher receives it: a transfer detaches the buffer, and per-batcher flush
      // timing is independent, so with 2+ targets any flush would neuter the chunk
      // out from under siblings still waiting to copy it. Sole target → owned.
      const owned = targets.length === 1;
      // Output landing within the input window is likely keystroke echo — let
      // the batcher accelerate a pending throughput flush so typing into a
      // flooding terminal isn't held a frame behind the flood.
      const interactive =
        terminalInfo !== undefined &&
        Date.now() - terminalInfo.lastInputTime < PORT_BATCH_INTERACTIVE_INPUT_WINDOW_MS;
      const saturated: RendererConnection[] = [];
      for (const { windowId, conn } of targets) {
        // An engaged worker-ingest terminal routes to its dedicated port —
        // bytes land in the renderer's parse worker without touching its main
        // thread. Exactly one sink per (window, terminal): the window port is
        // never written for an engaged terminal, so nothing double-delivers.
        const workerConn = terminalWorkerConnections.get(windowId)?.get(id);
        const sink = workerConn?.engaged ? workerConn : conn;
        if (sink.batcher.write(id, chunk, byteCount, owned, interactive)) {
          visualWritten = true;
        } else {
          // The data-loss pulse rides the WINDOW port either way — the
          // renderer's terminal-status subscribers only listen there.
          saturated.push(conn);
        }
      }

      // A window whose batcher rejected this chunk only truly loses it when a
      // SIBLING window's batcher accepted it — i.e. `visualWritten` is now true,
      // which suppresses the shared SAB/IPC fallback below. If NO window accepted,
      // `visualWritten` stays false and the IPC fallback broadcasts the chunk to
      // every window (the renderer's onData subscribes to both the MessagePort and
      // the IPC path), so nothing is actually lost — no pulse needed there.
      //
      // For the genuinely-starved windows we can't lean on the IPC fallback:
      // `sendEvent` broadcasts to every window and would falsely flag the ones
      // that received the data on their own port (issue #9891). So account the
      // loss and deliver a `data-loss` pulse on each starved window's own port,
      // FIFO-ordered with its data, letting the next wake snapshot resync it.
      //
      // Mirrored terminals are no exception: the IPC data mirror below is
      // Main-process-only (`data-mirror` is never re-broadcast to renderers),
      // so a starved window really does lose the chunk and needs the pulse.
      if (visualWritten && saturated.length > 0) {
        for (const conn of saturated) {
          // Counter is unconditional — regression detection must work even when
          // metrics are gated off (mirrors the IPC at-capacity path).
          dropAccumulator.droppedBytes += byteCount;
          dropAccumulator.dataLossCount += 1;
          recordTerminalDrop(id, byteCount);
          try {
            conn.port.postMessage({
              type: "terminal-status",
              id,
              status: "data-loss",
              droppedBytes: byteCount,
              timestamp: Date.now(),
            });
          } catch {
            // Port closing between iteration and post — disconnect handles cleanup.
          }
        }
      }
    }
    // If at capacity on all ports, fall through to SAB or IPC fallback
  }

  // PRIORITY 2: SHARED ARRAY BUFFER (Zero-Copy Fallback)
  // FUTURE_SAB: This entire branch is unreachable in production. SharedArrayBuffer
  // is not supported in Electron UtilityProcess (PtyClient.getSharedBuffers()
  // returns empty arrays, isSharedBufferEnabled() returns false). The init-buffers
  // message that populates visualBuffers is only sent from adversarial tests.
  // Production always routes through the MessagePort path (Priority 1).
  //
  // The skeleton is preserved for a potential Worker-thread migration that could
  // revive the SAB zero-copy data path with per-consumer isolation.
  //
  // Original design intent: Used when no MessagePort renderer connections are
  // available (e.g., during startup before port handshake completes). SAB is
  // single-consumer — safe only when one view is reading. SAB has one shared
  // read pointer, so it is only safe before the app enters project-view routing.
  const sabFallbackSafe = windowProjectMap.size === 0;
  if (
    !visualWritten &&
    !isSuspended &&
    !isBackgrounded &&
    visualBuffers.length > 0 &&
    sabFallbackSafe
  ) {
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

          let safetyTimeout: ReturnType<typeof setTimeout> | undefined;
          let committed = false;
          try {
            bpCoordinator.pause("backpressure");

            // Track when we started pausing for timeout safety
            const pauseStartTime = Date.now();
            backpressureManager.setPauseStartTime(id, pauseStartTime);

            // Emit status event for UI
            backpressureManager.emitTerminalStatus(id, "paused-backpressure", utilization);

            // Emit metrics for pause-start
            emitReliabilityMetricWithTracking(
              {
                terminalId: id,
                metricType: "pause-start",
                timestamp: pauseStartTime,
                bufferUtilization: utilization,
                shardIndex,
              },
              "sab"
            );

            // Safety timeout: if ack-driven resume doesn't clear backpressure in time,
            // suspend the stream and rely on wake to restore state.
            safetyTimeout = setTimeout(() => {
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
                emitReliabilityMetricWithTracking(
                  {
                    terminalId: id,
                    metricType: "pause-end",
                    timestamp: Date.now(),
                    durationMs: dur,
                    bufferUtilization: util,
                  },
                  "sab"
                );
              }
            }, BACKPRESSURE_SAFETY_TIMEOUT_MS);

            backpressureManager.setPausedInterval(id, safetyTimeout);
            committed = true;
          } catch (error) {
            console.error(`[PtyHost] Failed to pause SAB PTY ${id}:`, error);
          } finally {
            // If we threw between bpCoordinator.pause() and the final
            // setPausedInterval, release the token and any orphaned bookkeeping
            // so the PTY is not permanently held with no recovery path. See #7641.
            if (!committed) {
              if (safetyTimeout !== undefined) clearTimeout(safetyTimeout);
              backpressureManager.deletePauseStartTime(id);
              bpCoordinator.resume("backpressure");
            }
          }
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

  // IPC Data Mirror: send a Main-process-only copy for terminals that need
  // main-process monitoring (e.g., UrlDetector for dev preview URL detection),
  // even when the visual path already delivered the chunk. Background
  // terminals still need this mirror because their visual stream is
  // intentionally suppressed. Sent as `data-mirror`, not `data`: the renderer
  // already has the chunk (or the background gate suppressed it on purpose),
  // so a `data` event here would be re-broadcast to every WebContents and
  // dispatched into the same xterm a second time. The genuinely-undelivered
  // case (visualWritten false, not backgrounded) falls through to the
  // accounted IPC fallback below, which UrlDetector also receives.
  if (ipcDataMirrorTerminals.has(id) && !isSuspended && (visualWritten || isBackgrounded)) {
    sendEvent({ type: "data-mirror", id, data: toStringForIpc(data) });
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
      // Counter is unconditional — regression detection must work even
      // when metrics are gated off. The wire emission of the gauge is
      // gated separately in ResourceGovernor.emitDataLossCount.
      dropAccumulator.droppedBytes += dataBytes;
      dropAccumulator.dataLossCount += 1;
      recordTerminalDrop(id, dataBytes);
      // `ipc-cap-drop` is a data-path telemetry pulse, not a pause-source
      // transition — the funnel forwards it to the wire without touching
      // the per-source tracking map (a `suspend`/`pause-end` with `null`
      // source would be read as a force-resume and wipe the terminal's
      // entry while the IPC backpressure pause is still held; #9902).
      // The map entry is removed by the corresponding `pause-end` from
      // the IPC queue's own backpressure path. `forceEmit` bypasses the
      // metric gate — data-loss pulses must reach the wire even when
      // metrics are gated off.
      emitReliabilityMetricWithTracking(
        {
          terminalId: id,
          metricType: "ipc-cap-drop",
          timestamp: Date.now(),
          bufferUtilization: utilization,
        },
        null,
        true
      );
      // Surface the drop to the renderer so a discontinuity marker is shown.
      // Bypasses BackpressureManager.emitTerminalStatus() because each drop
      // is a distinct pulse — the dedup guard there would silently swallow
      // repeated data-loss events on the same terminal.
      sendEvent({
        type: "terminal-status",
        id,
        status: "data-loss",
        bufferUtilization: utilization,
        droppedBytes: dataBytes,
        timestamp: Date.now(),
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

ptyManager.on(
  "exit",
  (id: string, exitCode: number, signal?: number, launchGeneration?: number) => {
    // Release all pause holds and remove coordinator for this terminal
    const coordinator = pauseCoordinators.get(id);
    if (coordinator) {
      coordinator.forceReleaseAll();
      pauseCoordinators.delete(id);
    }

    // Drop any tracked pause-duration sources for this terminal so the next
    // `pause-duration-gauge` tick doesn't emit a stale `heldDurationMs`
    // for a terminal that no longer exists. Cleanup paths (this one,
    // `disconnectWindow`, `clearQueue`, `dispose`) bypass the funnel
    // because they don't carry a wire emission — a disconnected window
    // or torn-down queue manager shouldn't trigger a "pause-end" wire
    // event. The renderer is informed separately via terminal-exit /
    // disconnect flows.
    clearAllPauseSources(id);

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
    // Dedicated worker-ingest ports for this terminal die with it. Flush the
    // final batched bytes to the worker first — the exit message races the
    // last output otherwise — then tear the connection down.
    for (const [windowId, perWindow] of terminalWorkerConnections) {
      if (!perWindow.has(id)) continue;
      try {
        perWindow.get(id)!.batcher.flushTerminal(id);
      } catch {
        // Port may already be closed — safe to ignore
      }
      disconnectTerminalWorkerPort(windowId, id, "terminal-exit");
    }

    // Clean up IPC data mirror state
    ipcDataMirrorTerminals.delete(id);

    // Drop-tally entry dies with the terminal — the flow-control snapshot only
    // reports live terminals, and the map stays bounded across long sessions.
    terminalDropTallies.delete(id);

    sendEvent({ type: "exit", id, exitCode, signal, launchGeneration });
  }
);

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
      // Exit metadata on completed/exited transitions. Omit when absent so the
      // wire stays minimal; exitCode may legitimately be null (signal kill), so
      // forward on presence rather than truthiness. #10638
      ...(payload.exitCode !== undefined ? { exitCode: payload.exitCode } : {}),
      ...(payload.exitSignal !== undefined ? { exitSignal: payload.exitSignal } : {}),
      // Live temperature fields (only populated when the activity detector
      // drove the transition). Omit when absent so the wire stays minimal.
      ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
      ...(payload.heatAdded !== undefined ? { heatAdded: payload.heatAdded } : {}),
      ...(payload.changedChars !== undefined ? { changedChars: payload.changedChars } : {}),
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

events.on("agent:state-transition-dropped", (payload) => {
  // Cross-process relay: emit the dropped event on the main-side bus via the
  // wire protocol. The bridge in `electron/services/pty/PtyEventsBridge.ts`
  // re-emits it on the bus so the diagnostics event inspector can surface it.
  if (payload.terminalId) {
    sendEvent({
      type: "agent-state-transition-dropped",
      id: payload.terminalId,
      ...(payload.agentId ? { agentId: payload.agentId } : {}),
      ...(payload.worktreeId ? { worktreeId: payload.worktreeId } : {}),
      outcome: payload.outcome,
      currentState: payload.currentState,
      ...(payload.attemptedState !== undefined ? { attemptedState: payload.attemptedState } : {}),
      ...(payload.trigger !== undefined ? { trigger: payload.trigger } : {}),
      ...(payload.confidence !== undefined ? { confidence: payload.confidence } : {}),
      ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
      ...(payload.spawnedAt !== undefined ? { spawnedAt: payload.spawnedAt } : {}),
      ...(payload.terminalSpawnedAt !== undefined
        ? { terminalSpawnedAt: payload.terminalSpawnedAt }
        : {}),
      ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      ...(payload.validationErrors !== undefined
        ? { validationErrors: payload.validationErrors }
        : {}),
      ...(payload.traceId !== undefined ? { traceId: payload.traceId } : {}),
      timestamp: payload.timestamp,
    });
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

events.on("agent-session:captured", (payload) => {
  sendEvent({
    type: "agent-session-captured",
    terminalId: payload.terminalId,
    launchGeneration: payload.launchGeneration,
    record: payload.record,
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
  emitReliabilityMetricWithTracking(
    {
      terminalId: id,
      metricType: "pause-end",
      timestamp: Date.now(),
      durationMs: pauseDuration,
      bufferUtilization: utilization,
    },
    "sab"
  );

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
  terminalWorkerConnections,
  windowProjectMap,
  windowFocusedTerminalMap,
  ipcDataMirrorTerminals,
  analysisWorkerPool,
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
  get initialPoolWarmDeferred() {
    return initialPoolWarmDeferred;
  },
  set initialPoolWarmDeferred(value: boolean) {
    initialPoolWarmDeferred = value;
  },
  sendEvent,
  getPauseCoordinator,
  getOrCreatePauseCoordinator,
  disconnectWindow,
  disconnectTerminalWorkerPort,
  recomputeActivityTiers,
  tryReplayAndResume,
  resumePausedTerminal,
  createPortQueueManager,
  createTerminalWorkerPortQueueManager,
  getPausedDurationsSnapshot,
  getDropTallySnapshot: () =>
    Array.from(terminalDropTallies, ([terminalId, tally]) => ({
      terminalId,
      droppedBytes: tally.droppedBytes,
      dropCount: tally.dropCount,
      lastDropAt: tally.lastDropAt,
    })),
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
  imagePathProbe.dispose();

  if (ptyPool) {
    ptyPool.dispose();
    ptyPool = null;
  }

  ptyManager.dispose();

  // Workers are persistent by design (never terminated — Electron 37+
  // flush_tasks_ assertion); dispose only drops bookkeeping. The unref'd
  // threads die with the process.
  analysisWorkerPool?.dispose();

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
    ptyManager.setImagePathProbe(imagePathProbe);
    console.log("[PtyHost] ProcessTreeCache started");

    // Notify Main that we're ready (after cache is initialized, before pool is warmed)
    markHostPerformance(PERF_MARKS.PTY_HOST_READY_POSTED);
    sendEvent({ type: "ready" });
    console.log("[PtyHost] Initialized and ready (accepting IPC)");

    if (shouldEnablePtyPool()) {
      ptyPool = getPtyPool({ poolSize: 2, maxEntries: 8 });

      if (process.env.DAINTREE_PTY_DEFER_POOL_WARM === "1") {
        // Project-restoring boot: the set-active-project that follows ready
        // drains the pool to the project path, so a homedir warm here would
        // only spawn shells for the drain to kill. The set-active-project
        // handler performs the warm instead — project drain, or a homedir
        // fallback when the restore fell through (#10393).
        initialPoolWarmDeferred = true;
        console.log("[PtyHost] Initial pool warm deferred to set-active-project");
      } else {
        // Warm pool in background
        ptyPool
          .warmPool(os.homedir())
          .then(() => {
            console.log("[PtyHost] PTY pool warmed in background");
          })
          .catch((err) => {
            console.error("[PtyHost] Failed to warm pool:", err);
          });
      }

      ptyManager.setPtyPool(ptyPool);
    } else {
      console.log("[PtyHost] PTY pool disabled on Windows; terminals will spawn directly");
    }
  } catch (error) {
    console.error("[PtyHost] Initialization failed:", error);
    emergencyLogFatal("INIT_ERROR", error);
    setImmediate(() => process.exit(1));
  }
}

initialize().catch((err) => {
  console.error("[PtyHost] Fatal initialization error:", err);
  emergencyLogFatal("FATAL_INIT_ERROR", err);
  setImmediate(() => process.exit(1));
});
