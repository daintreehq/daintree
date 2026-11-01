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
  IdleHeapCompactor,
  IDLE_HEAP_COMPACT_CHECK_INTERVAL_MS,
  resolveExposedGc,
} from "./services/pty/analysis/idleHeapCompactor.js";
import {
  AnalysisWorkerPool,
  analysisWorkersDisabled,
  defaultAnalysisPoolSize,
} from "./services/pty/analysis/AnalysisWorkerPool.js";
import { PtyPool, getPtyPool, shouldEnablePtyPool } from "./services/PtyPool.js";
import { ProcessTreeCache } from "./services/ProcessTreeCache.js";
import {
  TerminalLineageLedger,
  beginTeardownProbeWindow,
  lineageFilePath,
} from "./services/TerminalLineageLedger.js";
import { ImagePathProbe } from "./services/pty/ImagePathProbe.js";
import { TerminalResourceMonitor } from "./services/pty/TerminalResourceMonitor.js";
import { events } from "./services/events.js";
import { SharedRingBuffer, PacketFramer } from "../shared/utils/SharedRingBuffer.js";
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
} from "./pty-host/index.js";
import {
  createPtyHostMessageDispatcher,
  type HostContext,
  type RendererConnection,
  type TerminalWorkerConnection,
} from "./pty-host/handlers/index.js";
import { PluginPtyProcessManager } from "./pty-host/services/PluginPtyProcessManager.js";
import { createVisualOutputRouter } from "./pty-host/visualOutputRouter.js";
import {
  beginWindowsExitBatch,
  flushWindowsExitBatch,
  flushWindowsExitBatchAsync,
  ProcessTreeKiller,
  type WindowsExitBatchOutcome,
} from "./services/pty/ProcessTreeKiller.js";
import { onWindowsTreeKillUnavailable } from "./utils/windowsTreeKill.js";
import { identityMicros } from "./utils/windowsProcessTree.js";
import { prewarmWindowsShell } from "./services/pty/terminalShell.js";

const WINDOWS_SHELL_READY_WAIT_MS = 2_000;
import { GracefulCaptureTracker } from "./pty-host/GracefulCaptureTracker.js";
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

// Idle heap compaction for this (main) isolate: terminal output churns
// transient strings through node-pty, forensics slicing, and port batching on
// every chunk, and the committed-heap slack otherwise lingers for minutes
// after a burst. Poll-based on a slow unref'd timer — the hot data path is
// untouched. Worker isolates run their own compactor (analysisWorker.ts).
const idleHeapCompactor = new IdleHeapCompactor(resolveExposedGc());
let idleCompactLastTerminalCount = -1;
const idleHeapCompactTimer = setInterval(() => {
  const signal = ptyManager.getActivitySignal();
  idleHeapCompactor.observeActivityAt(signal.latestActivityAt);
  if (signal.terminalCount !== idleCompactLastTerminalCount) {
    // Terminal churn (spawn/close) is activity too — closing terminals frees
    // registry state worth compacting once things settle.
    idleCompactLastTerminalCount = signal.terminalCount;
    idleHeapCompactor.noteActivity();
  }
  idleHeapCompactor.maybeCompact();
}, IDLE_HEAP_COMPACT_CHECK_INTERVAL_MS);
idleHeapCompactTimer.unref?.();

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
// stretches this out when the tree is quiet. This is only the boot cadence:
// main's resource-profile push, replayed on every ready, replaces it with the
// profile's interval.
const processTreeCache = new ProcessTreeCache(1500);
// Records every descendant ever seen under a PTY shell so teardown can still
// reach the ones that reparented to PID 1 before it ran (#12203). Persisted
// per shard — each shard is its own process with its own terminals, and the
// write is a whole-file replace.
const lineageLedger = new TerminalLineageLedger(
  process.env.DAINTREE_USER_DATA
    ? lineageFilePath(process.env.DAINTREE_USER_DATA, process.env.DAINTREE_PTY_SHARD_SERVICE)
    : null,
  process.env.DAINTREE_PTY_SHARD_SERVICE ?? "daintree-pty-host"
);
processTreeCache.attachLineageLedger(lineageLedger);
if (process.platform === "win32") {
  // Main knows a terminal's shell only by PID, and once this host is gone
  // nothing pins that PID: its crash cleanup needs the shell's identity to
  // refuse a process that has taken the number over.
  lineageLedger.setRootIdentityListener((pid, startTime, origin) => {
    const micros = identityMicros(startTime);
    if (origin?.kind !== "terminal" || micros === undefined) return;
    sendEvent({ type: "terminal-identity", id: origin.id, pid, startTime: micros });
  });
  // Main tells the user, once per session; this host only reports it.
  onWindowsTreeKillUnavailable((reason) => sendEvent({ type: "tree-kill-unavailable", reason }));
}
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
// Analysis buffer: best-effort, can drop frames; no renderer consumer since #12886
let visualBuffers: SharedRingBuffer[] = [];
let visualSignalView: Int32Array | null = null;
let analysisBuffer: SharedRingBuffer | null = null;
const packetFramer = new PacketFramer();

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

// Terminals whose graceful-shutdown quit handshake is waiting on their output
// (#12432). TerminalProcess opens and closes the windows through PtyManager.
const gracefulCaptureTracker = new GracefulCaptureTracker({
  getPauseCoordinator,
  getOrCreatePauseCoordinator,
  isTerminalLive: (id) => {
    const terminal = ptyManager.getTerminal(id);
    return terminal !== undefined && !terminal.wasKilled && !terminal.isExited;
  },
  emitDataLoss: (id, droppedBytes) =>
    sendEvent({
      type: "terminal-status",
      id,
      status: "data-loss",
      droppedBytes,
      timestamp: Date.now(),
    }),
});
ptyManager.setGracefulCaptureHost(gracefulCaptureTracker);

// Per-window MessagePort connections for direct Renderer ↔ Pty Host communication
const rendererConnections = new Map<number, RendererConnection>();
// Dedicated worker-ingest ports (issue #10960), keyed windowId → terminalId.
// Engaged entries take over that terminal's output routing for that window;
// everything else in the window stays on the shared per-window port.
const terminalWorkerConnections = new Map<number, Map<string, TerminalWorkerConnection>>();
const windowProjectMap = new Map<number, string | null>();

// Projects with at least one view that holds no MessagePort, pushed by Main
// (#12557) — a cached duplicate, or a view mid-transport-handoff. A window's
// single connection belongs to whichever view is active, so the project-scoped
// IPC fallback is the only remaining transport for the others — but
// `visualWritten` suppresses that fallback as soon as ANY window's batcher
// accepts the chunk. Without this set the host cannot tell a project whose
// every consumer is already fed from one that still has a starving view, so it
// suppressed both alike.
const fallbackEligibleProjects = new Set<string>();
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
    if (conn.closeHandler) conn.port.removeListener("close", conn.closeHandler);
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
    if (conn.closeHandler) conn.port.removeListener("close", conn.closeHandler);
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
  // Tell Main the view that held this port no longer has one (#12557). Without
  // it a window whose port failed keeps counting as reachable, and a sibling
  // window accepting the chunk suppresses the fallback its view now depends
  // on — the same starvation this issue fixed, narrowed to a failed port.
  sendEvent({
    type: "port-disconnected",
    windowId,
    reason,
    holderWebContentsId: conn.holderWebContentsId,
  });
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

// Visual-output fanout for every PTY chunk: per-window MessagePorts (or an
// engaged worker-ingest port), the FUTURE_SAB ring buffers, and the IPC
// fallback and data mirror to Main.
const visualOutputRouter = createVisualOutputRouter({
  getTerminal: (id) => ptyManager.getTerminal(id),
  backpressureManager,
  ipcQueueManager,
  rendererConnections,
  terminalWorkerConnections,
  windowProjectMap,
  fallbackEligibleProjects,
  ipcDataMirrorTerminals,
  packetFramer,
  getVisualBuffers: () => visualBuffers,
  getVisualSignalView: () => visualSignalView,
  getAnalysisBuffer: () => analysisBuffer,
  getPauseCoordinator,
  getOrCreatePauseCoordinator,
  recordDrop: (terminalId, droppedBytes) => {
    dropAccumulator.droppedBytes += droppedBytes;
    dropAccumulator.dataLossCount += 1;
    recordTerminalDrop(terminalId, droppedBytes);
  },
  emitReliabilityMetric: emitReliabilityMetricWithTracking,
  sendEvent,
  metricsEnabled,
});

const resourceGovernor = new ResourceGovernor({
  getTerminalIds: () => ptyManager.getAll().map((t) => t.id),
  getPauseCoordinator,
  getFdOwners: () => ({
    terminals: ptyManager.getLivePtyCount(),
    pooledPtys: ptyPool?.getPoolSize() ?? 0,
    pluginPtys: pluginPtyManager.getLiveCount(),
    analysisWorkers:
      analysisWorkerPool?.getMemoryAccounting().filter((slot) => slot.alive).length ?? 0,
  }),
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
    // Dedicated worker-ingest queues (#10960) hold in-flight bytes too — a
    // stalled worker must not be invisible to the reliability gauge.
    for (const perWindow of terminalWorkerConnections.values()) {
      for (const conn of perWindow.values()) {
        const port = conn.portQueueManager.getQueueSnapshot();
        totalPendingBytes += port.totalPendingBytes;
        perTerminal.push(...port.perTerminal);
      }
    }
    return { totalPendingBytes, perTerminal };
  },
  getThroughputSnapshot: () => {
    // Clear the accumulator on every tick so stale entries from toggled-off
    // intervals aren't replayed with misleading elapsed times later.
    const acc = visualOutputRouter.takeThroughputAccumulator();
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
    // Dedicated worker-ingest queues (#10960) share the "port" layer — same
    // transport, per-terminal scope.
    for (const perWindow of terminalWorkerConnections.values()) {
      for (const conn of perWindow.values()) {
        const port = conn.portQueueManager.getQueueSnapshot();
        for (const { terminalId, pendingBytes } of port.perTerminal) {
          if (pendingBytes > 0) out.push({ terminalId, layer: "port", pendingBytes });
        }
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

// Wire up PtyManager events
ptyManager.on("data", (id: string, data: string | Uint8Array, _routing, streamEnd) => {
  visualOutputRouter.routeOutput(id, data, streamEnd);
});

ptyManager.on(
  "exit",
  (
    id: string,
    exitCode: number,
    signal?: number,
    launchGeneration?: number,
    preserveSession?: boolean,
    spawnedAt?: number
  ) => {
    // Release all pause holds and remove coordinator for this terminal
    const coordinator = pauseCoordinators.get(id);
    if (coordinator) {
      coordinator.forceReleaseAll();
      // Before the delete: the lease is only recognised against the
      // coordinator it was opened on.
      gracefulCaptureTracker.end(id, "terminal-exit");
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

    sendEvent({
      type: "exit",
      id,
      exitCode,
      signal,
      launchGeneration,
      ...(spawnedAt !== undefined && { spawnedAt }),
      ...(preserveSession && { preserveSession }),
    });
  }
);

// A replaced incarnation's exit: no per-id cleanup here, the id is its successor's.
ptyManager.on(
  "superseded-exit",
  (
    id: string,
    exitCode: number,
    signal: number | undefined,
    launchGeneration: number | undefined,
    spawnedAt: number
  ) => {
    sendEvent({ type: "superseded-exit", id, exitCode, signal, launchGeneration, spawnedAt });
  }
);

ptyManager.on("error", (id: string, error: string) => {
  sendEvent({ type: "error", id, error });
});

// Submit-lane status (#11875). Only fires for submits that cross a threshold
// or fail, so this is a rare event, not a per-submit pulse.
ptyManager.on(
  "submit-status",
  (id: string, state: import("../shared/types/pty-host.js").TerminalSubmitStatusState) => {
    sendEvent({ type: "submit-status", id, state });
  }
);

// Carries prompt text (#15521): straight to Main, never logged or onto a bus.
ptyManager.on(
  "first-prompt-written",
  (
    id: string,
    launchGeneration: number | undefined,
    firstPrompt: import("../shared/types/panel.js").TerminalFirstPrompt
  ) => {
    sendEvent({ type: "first-prompt-written", id, launchGeneration, firstPrompt });
  }
);

ptyManager.on(
  "resize-result",
  (id: string, result: import("../shared/types/pty-host.js").TerminalResizeResult) => {
    sendEvent({ type: "resize-result", id, result });
  }
);

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
      ...(payload.agentIncarnation !== undefined
        ? { agentIncarnation: payload.agentIncarnation }
        : {}),
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
      // Parsed on this host at the settle, so the event is the only way it
      // reaches main or a renderer's panel store (#12488).
      ...(payload.lastHandback ? { lastHandback: payload.lastHandback } : {}),
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

events.on("agent:handback-observed", (payload) => {
  sendEvent({
    type: "agent-handback-observed",
    terminalId: payload.terminalId,
    handback: payload.handback,
    ...(payload.code !== undefined ? { code: payload.code } : {}),
    ...(payload.lastStateChange !== undefined ? { lastStateChange: payload.lastStateChange } : {}),
    timestamp: payload.timestamp,
  });
});

events.on("agent:rate-limit-observed", (payload) => {
  sendEvent({
    type: "agent-rate-limit-observed",
    terminalId: payload.terminalId,
    observedAt: payload.observedAt,
    timestamp: payload.timestamp,
  });
});

events.on("agent:fallback-triggered", (payload) => {
  sendEvent({
    type: "agent-fallback-triggered",
    payload: {
      terminalId: payload.terminalId,
      agentId: payload.agentId,
      fromPresetId: payload.fromPresetId,
      ...(payload.originalPresetId !== undefined
        ? { originalPresetId: payload.originalPresetId }
        : {}),
      reason: payload.reason,
      ...(payload.exitCode !== undefined ? { exitCode: payload.exitCode } : {}),
      timestamp: payload.timestamp,
    },
  });
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
    ...(payload.agentIncarnation !== undefined
      ? { agentIncarnation: payload.agentIncarnation }
      : {}),
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
    ...(payload.agentEnd ? { agentEnd: payload.agentEnd } : {}),
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

events.on("terminal:trash-cleared", (payload) => {
  sendEvent({
    type: "terminal-trash-cleared",
    id: payload.id,
    expiresAt: payload.expiresAt,
  });
});

events.on("agent-session:captured", (payload) => {
  sendEvent({
    type: "agent-session-captured",
    terminalId: payload.terminalId,
    launchGeneration: payload.launchGeneration,
    boundary: payload.boundary,
    record: payload.record,
  });
});

// Build the message dispatcher with a stable HostContext that exposes the
// reassignable buffer/pool fields via getter/setter pairs. Handler modules
// always read the current value through the getter, so `init-buffers` and
// `initialize()` reassignments propagate without each module having to
// re-bind a local snapshot.
// Raw plugin PTYs (#11300) live alongside — never inside — the terminal
// PtyManager, so they inherit its crash isolation without any of its
// panel semantics.
// They do share the terminals' tree teardown (#13173): the same census and
// lineage ledger, so a plugin's dev server dies with it and a crash leaves a
// persisted record for the next launch to reap.
const pluginPtyManager = new PluginPtyProcessManager(
  sendEvent,
  (target, origin) => new ProcessTreeKiller(target, processTreeCache, lineageLedger, origin)
);

const hostContext: HostContext = {
  ptyManager,
  pluginPtyManager,
  processTreeCache,
  lineageLedger,
  terminalResourceMonitor,
  backpressureManager,
  ipcQueueManager,
  resourceGovernor,
  packetFramer,
  pauseCoordinators,
  rendererConnections,
  terminalWorkerConnections,
  windowProjectMap,
  fallbackEligibleProjects,
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
  tryReplayAndResume: visualOutputRouter.tryReplayAndResume,
  resumePausedTerminal: visualOutputRouter.resumePausedTerminal,
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
      shutdownHost();
      return;
    }
    // The teardown can wait on the tree-kill helper; nothing may start on a
    // host that is already taking its terminals down.
    if (cleanedUp) return;
    await dispatchMessage(msg, ports);
  } catch (error) {
    console.error("[PtyHost] Error handling message:", error);
  }
});

let cleanedUp = false;

/**
 * The teardown up to and including the terminals' disposal. On Windows their
 * tree kills are queued in the exit batch, which is still open when this
 * returns — whether or not disposal threw — for the caller to flush before
 * {@link finishCleanup}.
 */
function beginCleanup(): { error: unknown } | null {
  console.log("[PtyHost] Disposing resources...");

  // One synchronous `ps` budget for the whole teardown. Every terminal's
  // disposal below can run two verification passes, and Main SIGKILLs this
  // host if it has not exited a few seconds after asking.
  beginTeardownProbeWindow();

  // Disconnect all renderer windows
  for (const windowId of Array.from(rendererConnections.keys())) {
    disconnectWindow(windowId, "cleanup");
  }

  resourceGovernor.dispose();

  gracefulCaptureTracker.dispose();
  for (const coordinator of pauseCoordinators.values()) {
    coordinator.forceReleaseAll();
  }
  pauseCoordinators.clear();

  backpressureManager.dispose();
  ipcQueueManager.dispose();

  terminalResourceMonitor.dispose();
  processTreeCache.stop();
  // Disposed after ptyManager.dispose() below would be too late: that call
  // tears down every terminal and needs the ledger to reach detached
  // descendants. Detach it from the census now, drop its state afterwards.
  processTreeCache.attachLineageLedger(null);
  imagePathProbe.dispose();

  // Windows: every tree kill below is queued and run as one helper request
  // when the batch is flushed — one kill per terminal would not fit Main's
  // force-kill deadline. Pseudoconsoles are released after that kill. No-op
  // elsewhere.
  beginWindowsExitBatch();
  try {
    // Release every plugin PTY's native handle through its teardown chokepoint —
    // a bare process exit would leak the master fd for any still-running one.
    pluginPtyManager.disposeAll();

    if (ptyPool) {
      ptyPool.dispose();
      ptyPool = null;
    }

    ptyManager.dispose();
    return null;
  } catch (error) {
    return { error };
  }
}

function finishCleanup(): void {
  lineageLedger.dispose();

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

/**
 * The teardown for `process.on("exit")`, and on macOS and Linux for every
 * shutdown: synchronous, so the exit follows in the same tick. On Windows the
 * exit batch runs on a blocking one-shot helper here.
 */
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  const failed = beginCleanup();
  flushWindowsExitBatch();
  if (failed) throw failed.error;
  finishCleanup();
}

/**
 * How long a host that handed unfinished tree kills to Main waits before
 * exiting, so the message is on its way before the process goes.
 */
const TREE_KILL_HANDOFF_DELIVERY_MS = 50;
let treeKillsHandedOff = false;

/**
 * The teardown Main asks for, on Windows. The exit batch goes to the warm
 * tree-kill helper when one is running and is awaited within the batch's
 * budget: a cold PowerShell start alone took most of it, and at quit the
 * blocking run kept missing it, leaving every tree to the census-failure path.
 *
 * Resolves with whether every tree was confirmed ended. The helper dies with
 * this host, so whatever the batch could not confirm — a request stuck behind
 * a slow run, or a run cut off at the deadline — is handed to Main by identity
 * before the host exits, and the exit is not a clean one.
 */
async function cleanupAsync(): Promise<boolean> {
  if (cleanedUp) return true;
  cleanedUp = true;
  const failed = beginCleanup();
  const outcome = await flushWindowsExitBatchAsync();
  const confirmed = handOffUnfinishedTreeKills(outcome);
  if (failed) throw failed.error;
  finishCleanup();
  return confirmed;
}

/** Hand Main the roots the exit batch left unconfirmed. Returns whether there were none. */
function handOffUnfinishedTreeKills(outcome: WindowsExitBatchOutcome): boolean {
  if (outcome.unfinished.length > 0) {
    console.warn(
      `[PtyHost] handing ${outcome.unfinished.length} unconfirmed tree kill(s) to Main: pid=${outcome.unfinished.map((root) => root.pid).join(", ")}`
    );
    try {
      sendEvent({ type: "tree-kill-handoff", roots: outcome.unfinished });
      treeKillsHandedOff = true;
    } catch (error) {
      console.warn("[PtyHost] tree-kill handoff failed:", error);
    }
  }
  if (outcome.abandoned > 0) {
    console.warn(
      `[PtyHost] ${outcome.abandoned} terminal tree(s) with no recorded identity were not confirmed ended and cannot be handed on`
    );
  }
  return outcome.unfinished.length === 0 && outcome.abandoned === 0;
}

let shutdown: Promise<boolean> | null = null;

/**
 * Finish the teardown, then exit. The explicit exit is load-bearing: the
 * message port keeps the event loop alive, so a host that only cleans up never
 * exits and Main is left waiting on its force-kill deadline. Main treats a
 * clean exit as proof every terminal was reached (#13167), so a teardown that
 * threw, or left a tree it could not confirm, exits non-zero.
 *
 * macOS and Linux tear down synchronously and exit in the same tick. Windows
 * awaits its exit batch, and a second request while the first is still
 * tearing down waits for it rather than exiting under it.
 */
function shutdownHost(exitCode = 0): void {
  if (process.platform !== "win32") {
    try {
      cleanup();
    } catch (error) {
      // Main reads a clean exit as "every terminal was reached"; a teardown that
      // threw part way must not claim that.
      console.error("[PtyHost] Teardown failed:", error);
      exitCode = exitCode || 1;
    }
    process.exit(exitCode);
    return;
  }
  shutdown ??= cleanupAsync();
  shutdown.then(
    (confirmed) => {
      if (confirmed) {
        process.exit(exitCode);
        return;
      }
      setTimeout(() => process.exit(exitCode || 1), TREE_KILL_HANDOFF_DELIVERY_MS);
    },
    (error: unknown) => {
      console.error("[PtyHost] Teardown failed:", error);
      if (!treeKillsHandedOff) {
        process.exit(exitCode || 1);
        return;
      }
      setTimeout(() => process.exit(exitCode || 1), TREE_KILL_HANDOFF_DELIVERY_MS);
    }
  );
}

// Handle process exit
process.on("exit", () => {
  cleanup();
});

// Node's default SIGTERM action skips the `exit` handler, so a terminate
// request would otherwise abandon every terminal teardown had not reached.
// Exits with the conventional 128 + 15 so Main still classifies it as signalled.
process.on("SIGTERM", () => {
  shutdownHost(143);
});

// Initialize pool asynchronously
async function initialize(): Promise<void> {
  try {
    // The default shell is searched for asynchronously (a PATH entry on a dead
    // share must not stall this loop); start now so the first terminal gets it.
    const windowsShellReady =
      process.platform === "win32" ? prewarmWindowsShell().catch(() => undefined) : undefined;

    // Start the resource governor for proactive memory monitoring
    resourceGovernor.start();

    // Start the process tree cache (shared across all terminals)
    processTreeCache.start();
    ptyManager.setProcessTreeCache(processTreeCache);
    ptyManager.setLineageLedger(lineageLedger);
    ptyManager.setImagePathProbe(imagePathProbe);
    console.log("[PtyHost] ProcessTreeCache started");

    // Session restore spawns terminals the moment Main hears "ready". Wait
    // (briefly — the search takes milliseconds on a healthy PATH) so they open
    // in PowerShell 7 rather than the in-box fallback used while it is pending.
    if (windowsShellReady) {
      await Promise.race([
        windowsShellReady,
        new Promise<void>((resolve) => setTimeout(resolve, WINDOWS_SHELL_READY_WAIT_MS).unref()),
      ]);
    }

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
