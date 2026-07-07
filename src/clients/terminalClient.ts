import type {
  TerminalSpawnOptions,
  AgentStateChangePayload,
  AgentDetectedPayload,
  AgentExitedPayload,
  AgentFallbackTriggeredPayload,
  TerminalActivityPayload,
  BackendTerminalInfo,
  TerminalReconnectResult,
  TerminalStatusPayload,
  BroadcastWriteResultPayload,
  SpawnResult,
} from "@shared/types";
import type {
  PtyHostToRendererMessage,
  TerminalReliabilityMetricPayload,
} from "@shared/types/pty-host";
import { PERF_MARKS } from "@shared/perf/marks";
import { logDebug, logWarn } from "@/utils/logger";
import { isRendererPerfCaptureEnabled, markRendererPerformance } from "@/utils/performance";

let messagePort: MessagePort | null = null;
let expectedToken: string | null = null;
let pendingPort: MessagePort | null = null;
let pendingToken: string | null = null;

const dataCallbacks = new Map<string, Set<(data: string | Uint8Array) => void>>();
const earlyDataBuffer = new Map<string, Array<string | Uint8Array>>();
const earlyDataBufferBytes = new Map<string, number>();
const pendingPortAckBytes = new Map<string, number[]>();
// The early buffer only needs to cover the spawn→attach race window — late
// attachers recover full history through the serialized-state restore path.
// Cap both chunk count and retained bytes, evicting the OLDEST chunks: the
// dropped head is recoverable from the host snapshot, the live tail is not,
// and without a byte cap a never-attached terminal (e.g. a dev server whose
// console pane is never opened) retains up to 500 × 64KB batches for the
// whole app session.
const MAX_EARLY_BUFFER_CHUNKS = 500;
const MAX_EARLY_BUFFER_BYTES = 512 * 1024;

function earlyChunkSize(data: string | Uint8Array): number {
  return typeof data === "string" ? data.length : data.byteLength;
}

// Single global subscriber set — the host pushes tier-changed reconciliation
// messages for any terminal, and the lone consumer (TerminalInstanceService)
// routes by id internally. No per-terminal map and no ACK accounting: these
// control messages carry no byte count and must never enter pendingPortAckBytes.
const tierChangedCallbacks = new Set<(id: string, tier: "active" | "background") => void>();

// Engage-barrier markers from the host (issue #10960): the routing switch to a
// terminal's dedicated worker-ingest port completed, FIFO behind the final
// window-routed chunk. Control pulses — no ACK accounting. The lone consumer
// (the live worker-ingest controller) routes by id internally.
const workerIngestEngagedCallbacks = new Set<(id: string) => void>();

// Pending dedicated worker-port requests (issue #10960). The IPC invoke
// returns a handshake token; the port itself arrives via a
// `terminal-worker-port` window message carrying the same token — either can
// land first, so both halves park here until they pair (or the timeout fires).
interface PendingWorkerPortRequest {
  token: string | null;
  port: MessagePort | null;
  portToken: string | null;
  resolve: (port: MessagePort | null) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingWorkerPortRequests = new Map<string, PendingWorkerPortRequest>();
const WORKER_PORT_REQUEST_TIMEOUT_MS = 5000;

function settleWorkerPortRequest(id: string, port: MessagePort | null): void {
  const pending = pendingWorkerPortRequests.get(id);
  if (!pending) {
    if (port) {
      try {
        port.close();
      } catch {
        // already closed
      }
    }
    return;
  }
  pendingWorkerPortRequests.delete(id);
  clearTimeout(pending.timeout);
  if (port === null && pending.port) {
    try {
      pending.port.close();
    } catch {
      // already closed
    }
  }
  pending.resolve(port);
}

// Per-window terminal-status pulses delivered on the MessagePort (currently the
// `data-loss` signal for a saturated window in the multi-window fan-out case,
// issue #9891). The Main-process `onStatus` broadcast can't target one window,
// so these ride the saturated window's own port and are dispatched to the same
// `onStatus` subscribers as the IPC path. No ACK, no byte accounting — pulses.
const terminalStatusCallbacks = new Set<(data: TerminalStatusPayload) => void>();

// Sampled keystroke→echo probe (DAINTREE_PERF_CAPTURE only): ~1/32 port
// writes stamp performance.now(); the next port data chunk for the same
// terminal closes the pair as INPUT_ECHO_LATENCY. Pairs older than 250ms are
// discarded — that's ambient output, not echo. Env is fixed per session, so
// the gate is read once; when disabled the write path pays one boolean check.
let echoProbeEnabled: boolean | null = null;
let echoProbeCounter = 0;
const pendingEchoProbes = new Map<string, number>();
const ECHO_PROBE_SAMPLE_INTERVAL = 32;
const ECHO_PROBE_MAX_PAIR_MS = 250;

function maybeStartEchoProbe(id: string): void {
  echoProbeEnabled ??= isRendererPerfCaptureEnabled();
  if (!echoProbeEnabled) return;
  if (++echoProbeCounter % ECHO_PROBE_SAMPLE_INTERVAL !== 0) return;
  if (pendingEchoProbes.has(id)) return;
  pendingEchoProbes.set(id, performance.now());
}

function maybeFinishEchoProbe(id: string): void {
  if (pendingEchoProbes.size === 0) return;
  const startedAt = pendingEchoProbes.get(id);
  if (startedAt === undefined) return;
  pendingEchoProbes.delete(id);
  const latencyMs = performance.now() - startedAt;
  if (latencyMs > ECHO_PROBE_MAX_PAIR_MS) return;
  markRendererPerformance(PERF_MARKS.INPUT_ECHO_LATENCY, { terminalId: id, latencyMs });
}

function installPortDataHandler(port: MessagePort): void {
  port.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as PtyHostToRendererMessage;
    if (msg?.type === "tier-changed" && typeof msg.id === "string") {
      // Host-pushed tier reconciliation — no ACK, no byte accounting.
      for (const cb of tierChangedCallbacks) {
        cb(msg.id, msg.tier);
      }
      return;
    }
    if (msg?.type === "worker-ingest-engaged" && typeof msg.id === "string") {
      // Engage-barrier marker — no ACK, no byte accounting.
      for (const cb of workerIngestEngagedCallbacks) {
        cb(msg.id);
      }
      return;
    }
    if (msg?.type === "terminal-status" && typeof msg.id === "string") {
      // Per-window flow-status pulse (e.g. data-loss for a saturated window).
      // Routed to the same subscribers as the IPC broadcast path.
      for (const cb of terminalStatusCallbacks) {
        cb({
          id: msg.id,
          status: msg.status,
          bufferUtilization: msg.bufferUtilization,
          droppedBytes: msg.droppedBytes,
          timestamp: msg.timestamp,
        });
      }
      return;
    }
    if (msg?.type === "data" && typeof msg.id === "string") {
      maybeFinishEchoProbe(msg.id);
      const byteCount = msg.bytes ?? 0;

      const cbs = dataCallbacks.get(msg.id);
      if (cbs) {
        // Live-callback path: defer ACK until xterm write callback fires.
        // Queue the original byte count so acknowledgePortData() uses the pty-host's
        // UTF-8 byte count (msg.bytes) rather than JS string.length.
        let queue = pendingPortAckBytes.get(msg.id);
        if (!queue) {
          queue = [];
          pendingPortAckBytes.set(msg.id, queue);
        }
        queue.push(byteCount);

        for (const cb of cbs) {
          cb(msg.data);
        }
      } else {
        // Early-buffer path: no xterm write will happen yet, ACK immediately
        // to keep the PTY host queue draining during startup.
        try {
          port.postMessage({ type: "ack", id: msg.id, bytes: byteCount });
        } catch {
          // Port closed — ack lost, safety timeout will resume PTY
        }

        let buf = earlyDataBuffer.get(msg.id);
        if (!buf) {
          buf = [];
          earlyDataBuffer.set(msg.id, buf);
        }
        buf.push(msg.data);
        let bytes = (earlyDataBufferBytes.get(msg.id) ?? 0) + earlyChunkSize(msg.data);
        // Evict oldest-first so the buffer holds the most recent output; the
        // attach-time flush is best-effort anyway and the serialized restore
        // replays anything older.
        while (buf.length > MAX_EARLY_BUFFER_CHUNKS || bytes > MAX_EARLY_BUFFER_BYTES) {
          if (buf.length === 1) break;
          bytes -= earlyChunkSize(buf.shift()!);
        }
        earlyDataBufferBytes.set(msg.id, bytes);
      }
    }
  });
}

function activatePort(port: MessagePort): void {
  if (messagePort) {
    messagePort.close();
  }
  // Port-generation boundary: the pending-ack FIFO describes chunks delivered
  // on the OUTGOING port, whose host-side ledger is being torn down with it
  // (disconnectWindow disposes that window's PortQueueManager). Carrying the
  // entries across would let stale xterm write completions settle them against
  // the NEW port's ledger — debiting bytes the fresh generation actually has
  // in flight and permanently misaligning the per-chunk FIFO. Stale write
  // callbacks that fire after this clear degrade to no-op acks instead
  // (acknowledgePortData shifts at most what is queued).
  pendingPortAckBytes.clear();
  messagePort = port;
  installPortDataHandler(port);
  port.addEventListener("close", () => {
    if (messagePort === port) {
      messagePort = null;
    }
  });
  port.start();
}

if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    if (window.top !== window) return;
    if (event.source !== window) {
      return;
    }

    const eventOrigin = event.origin;
    const windowOrigin = window.location.origin;
    const isFile = window.location.protocol === "file:";
    const originOk =
      eventOrigin === windowOrigin || (isFile && eventOrigin === "null" && windowOrigin === "null");

    if (!originOk) {
      return;
    }

    if (event.data?.type === "terminal-port-token" && typeof event.data?.token === "string") {
      expectedToken = event.data.token;

      if (pendingPort && pendingToken === expectedToken) {
        activatePort(pendingPort);
        pendingPort = null;
        pendingToken = null;
        expectedToken = null;
        logDebug("[TerminalClient] MessagePort acquired via postMessage (out-of-order)");
      }
      return;
    }

    if (event.data?.type === "terminal-port" && event.ports?.[0]) {
      const receivedToken = event.data?.token;

      if (!receivedToken) {
        if (event.ports[0]) event.ports[0].close();
        return;
      }

      if (!expectedToken) {
        if (pendingPort) pendingPort.close();
        pendingPort = event.ports[0];
        pendingToken = receivedToken;
        return;
      }

      if (receivedToken !== expectedToken) {
        if (event.ports[0]) event.ports[0].close();
        return;
      }

      activatePort(event.ports[0]);
      expectedToken = null;
      logDebug("[TerminalClient] MessagePort acquired via postMessage");
      return;
    }

    if (event.data?.type === "terminal-worker-port" && event.ports?.[0]) {
      const port = event.ports[0];
      const terminalId = event.data?.terminalId;
      const receivedToken = event.data?.token;
      if (typeof terminalId !== "string" || typeof receivedToken !== "string") {
        port.close();
        return;
      }
      const pending = pendingWorkerPortRequests.get(terminalId);
      if (!pending) {
        // Unsolicited (request already timed out or released) — never adopt.
        port.close();
        return;
      }
      if (pending.token === null) {
        // Port beat the invoke result; park it until the token arrives.
        if (pending.port) pending.port.close();
        pending.port = port;
        pending.portToken = receivedToken;
        return;
      }
      if (pending.token !== receivedToken) {
        port.close();
        return;
      }
      settleWorkerPortRequest(terminalId, port);
    }
  });

  try {
    window.postMessage({ type: "terminal-port-ready" }, window.location.origin);
  } catch {
    // Non-fatal: IPC/SAB fallbacks still work if the ready handshake cannot be posted.
  }
}

export const terminalClient = {
  spawn: (options: TerminalSpawnOptions): Promise<string> => {
    return window.electron.terminal.spawn(options);
  },

  write: (id: string, data: string): void => {
    if (messagePort) {
      maybeStartEchoProbe(id);
      try {
        messagePort.postMessage({ type: "write", id, data });
      } catch (error) {
        logWarn("[TerminalClient] MessagePort write failed, clearing port", { error });
        messagePort = null;

        window.electron.terminal.write(id, data);
      }
    } else {
      window.electron.terminal.write(id, data);
    }
  },

  /**
   * Submit text as a command to the terminal.
   * This handles bracketed paste wrapping and CR timing on the backend
   * for reliable command execution across all CLIs.
   */
  submit: (id: string, text: string): Promise<void> => {
    return window.electron.terminal.submit(id, text);
  },

  /**
   * Send a single key chord to the terminal (e.g. "escape", "ctrl+c").
   */
  sendKey: (id: string, key: string): void => {
    window.electron.terminal.sendKey(id, key);
  },

  /**
   * Send a double-Escape to each terminal in the batch, with a per-PTY delay
   * scheduled inside the PTY host utility process. Used by fleet.interrupt to
   * drop each armed agent out of sub-menus/dialogs without the sub-10ms
   * timing collapse that renderer-side setTimeout exhibits under IPC jitter.
   */
  batchDoubleEscape: (ids: string[]): void => {
    if (ids.length === 0) return;
    window.electron.terminal.batchDoubleEscape(ids);
  },

  /**
   * Fan one data payload to every armed PTY in a single IPC round-trip.
   * Used by fleet broadcast: for each keystroke we send one main→host
   * message, the host writes to each PTY in a tight loop. Keeps renderer
   * latency bounded regardless of fleet size.
   */
  broadcast: (ids: string[], data: string): void => {
    if (ids.length === 0 || data.length === 0) return;
    window.electron.terminal.broadcastWrite(ids, data);
  },

  /**
   * Listen for per-target results emitted after every fleet broadcast write.
   * Used by `fleetRawInputBroadcast` to surface the failure chip and to
   * auto-disarm targets whose pty is permanently gone (EPIPE/EIO/EBADF/
   * ECONNRESET).
   */
  onBroadcastResult: (callback: (data: BroadcastWriteResultPayload) => void): (() => void) => {
    return window.electron.terminal.onBroadcastWriteResult(callback);
  },

  resize: (id: string, cols: number, rows: number): void => {
    if (messagePort) {
      try {
        messagePort.postMessage({ type: "resize", id, cols, rows });
      } catch (error) {
        logWarn("[TerminalClient] MessagePort resize failed, clearing port", { error });
        messagePort = null;

        window.electron.terminal.resize(id, cols, rows);
      }
    } else {
      window.electron.terminal.resize(id, cols, rows);
    }
  },

  kill: (id: string): Promise<void> => {
    earlyDataBuffer.delete(id);
    earlyDataBufferBytes.delete(id);
    pendingPortAckBytes.delete(id);
    pendingEchoProbes.delete(id);
    settleWorkerPortRequest(id, null);
    return window.electron.terminal.kill(id);
  },

  gracefulKill: (id: string): Promise<string | null> => {
    earlyDataBuffer.delete(id);
    earlyDataBufferBytes.delete(id);
    pendingPortAckBytes.delete(id);
    pendingEchoProbes.delete(id);
    settleWorkerPortRequest(id, null);
    return window.electron.terminal.gracefulKill(id);
  },

  trash: (id: string): Promise<void> => {
    earlyDataBuffer.delete(id);
    earlyDataBufferBytes.delete(id);
    pendingPortAckBytes.delete(id);
    pendingEchoProbes.delete(id);
    settleWorkerPortRequest(id, null);
    return window.electron.terminal.trash(id);
  },

  restore: (id: string): Promise<boolean> => {
    return window.electron.terminal.restore(id);
  },

  onData: (id: string, callback: (data: string | Uint8Array) => void): (() => void) => {
    // Register in per-terminal callback set for MessagePort data dispatch
    let cbs = dataCallbacks.get(id);
    if (!cbs) {
      cbs = new Set();
      dataCallbacks.set(id, cbs);
    }
    cbs.add(callback);

    // Flush any data that arrived before callbacks were registered
    const buffered = earlyDataBuffer.get(id);
    if (buffered) {
      earlyDataBuffer.delete(id);
      earlyDataBufferBytes.delete(id);
      for (const data of buffered) {
        callback(data);
      }
    }

    // IPC fallback: always dispatch IPC data. The pty-host ensures each data chunk is sent
    // through exactly ONE visual path (MessagePort, SAB, or IPC) via a `visualWritten` flag,
    // so there is no double-delivery risk. Previously this path was suppressed when
    // messagePortConnected was true, but that caused data loss when the pty-host's per-window
    // project filter routed data through IPC instead of MessagePort (e.g., during project
    // switch when windowProjectMap hasn't updated yet).
    const ipcCleanup = window.electron.terminal.onData(id, (data: string | Uint8Array) => {
      callback(data);
    });

    return () => {
      const set = dataCallbacks.get(id);
      if (set) {
        set.delete(callback);
        if (set.size === 0) dataCallbacks.delete(id);
      }
      ipcCleanup();
    };
  },

  /**
   * Subscribe to host-pushed activity-tier reconciliation messages.
   * The PTY host emits these whenever it rewrites a terminal's tier on its own
   * (window connect/disconnect/project switch) so the renderer can re-arm its
   * dedupe baseline (TerminalRendererPolicy.initializeBackendTier) before the
   * producer gate suppresses output. Rides the per-window MessagePort, so it is
   * FIFO-ordered ahead of subsequent data chunks. Returns a cleanup function.
   */
  onTierChanged: (callback: (id: string, tier: "active" | "background") => void): (() => void) => {
    tierChangedCallbacks.add(callback);
    return () => {
      tierChangedCallbacks.delete(callback);
    };
  },

  /**
   * Request a dedicated worker-ingest MessagePort for one terminal (issue
   * #10960). Resolves with the port — which the caller must transfer into the
   * parse worker WITHOUT reading — or null (no pty client, window teardown,
   * timeout). One request in flight per terminal.
   */
  requestWorkerIngestPort: (id: string): Promise<MessagePort | null> => {
    if (pendingWorkerPortRequests.has(id)) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const pending: PendingWorkerPortRequest = {
        token: null,
        port: null,
        portToken: null,
        resolve,
        timeout: setTimeout(
          () => settleWorkerPortRequest(id, null),
          WORKER_PORT_REQUEST_TIMEOUT_MS
        ),
      };
      pendingWorkerPortRequests.set(id, pending);
      window.electron.terminal
        .requestWorkerIngestPort(id)
        .then((result) => {
          if (pendingWorkerPortRequests.get(id) !== pending) return;
          if (!result?.token) {
            settleWorkerPortRequest(id, null);
            return;
          }
          pending.token = result.token;
          if (!pending.port) return;
          if (pending.portToken === result.token) {
            settleWorkerPortRequest(id, pending.port);
          } else {
            // Token mismatch — spoofed or stale delivery. Drop the port and
            // let the timeout settle the request.
            try {
              pending.port.close();
            } catch {
              // already closed
            }
            pending.port = null;
            pending.portToken = null;
          }
        })
        .catch(() => {
          if (pendingWorkerPortRequests.get(id) === pending) {
            settleWorkerPortRequest(id, null);
          }
        });
    });
  },

  /**
   * Release a terminal's dedicated worker-ingest port: settles any pending
   * request as null and tells Main to close the pair (the pty-host tears its
   * side down via the port-close event).
   */
  releaseWorkerIngestPort: (id: string): void => {
    settleWorkerPortRequest(id, null);
    void window.electron.terminal.releaseWorkerIngestPort(id).catch(() => {
      // Main-side cleanup is best-effort; the host's port-close handler is
      // the backstop.
    });
  },

  /** Ask the host to route this terminal's bytes to its dedicated port. */
  sendWorkerIngestEngage: (id: string): boolean => {
    if (!messagePort) return false;
    try {
      messagePort.postMessage({ type: "worker-ingest-engage", id });
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Ask the host to route this terminal's bytes back to the window port. The
   * host answers with an `ingest-detached` sentinel (carrying `drainId`) on
   * the dedicated port, which the worker converts to a `port-drained` response.
   */
  sendWorkerIngestRelease: (id: string, drainId: number): boolean => {
    if (!messagePort) return false;
    try {
      messagePort.postMessage({ type: "worker-ingest-release", id, drainId });
      return true;
    } catch {
      return false;
    }
  },

  /** Subscribe to engage-barrier markers (see sendWorkerIngestEngage). */
  onWorkerIngestEngaged: (callback: (id: string) => void): (() => void) => {
    workerIngestEngagedCallbacks.add(callback);
    return () => {
      workerIngestEngagedCallbacks.delete(callback);
    };
  },

  onExit: (callback: (id: string, exitCode: number) => void): (() => void) => {
    return window.electron.terminal.onExit(callback);
  },

  onAgentStateChanged: (callback: (data: AgentStateChangePayload) => void): (() => void) => {
    return window.electron.terminal.onAgentStateChanged(callback);
  },

  onAgentDetected: (callback: (data: AgentDetectedPayload) => void): (() => void) => {
    return window.electron.terminal.onAgentDetected(callback);
  },

  onAgentExited: (callback: (data: AgentExitedPayload) => void): (() => void) => {
    return window.electron.terminal.onAgentExited(callback);
  },

  onFallbackTriggered: (callback: (data: AgentFallbackTriggeredPayload) => void): (() => void) => {
    return window.electron.terminal.onFallbackTriggered(callback);
  },

  onActivity: (callback: (data: TerminalActivityPayload) => void): (() => void) => {
    return window.electron.terminal.onActivity(callback);
  },

  onTrashed: (callback: (data: { id: string; expiresAt: number }) => void): (() => void) => {
    return window.electron.terminal.onTrashed(callback);
  },

  onRestored: (callback: (data: { id: string }) => void): (() => void) => {
    return window.electron.terminal.onRestored(callback);
  },

  setActivityTier: (
    id: string,
    tier: "active" | "background",
    pollingIntervalMs?: number
  ): void => {
    window.electron.terminal.setActivityTier(id, tier, pollingIntervalMs);
  },

  /**
   * Report the UI-focused terminal (or null) to the backend so the pty-host
   * can prioritize it in per-window backpressure and output batching. A soft
   * hint — fire-and-forget, deduped upstream by the focus subscription.
   */
  setFocusedTerminal: (id: string | null): void => {
    window.electron.terminal.setFocused(id);
  },

  /**
   * Acknowledge processed data bytes to the backend (Flow Control — IPC path).
   */
  acknowledgeData: (id: string, length: number): void => {
    window.electron.terminal.acknowledgeData(id, length);
  },

  /**
   * Acknowledge processed data bytes via the MessagePort (Flow Control — port path).
   * Called from TerminalInstanceService.writeToTerminal() after xterm consumes the chunk.
   * Uses the original pty-host byte counts queued by installPortDataHandler, not the
   * caller's byte count, to avoid UTF-16 vs UTF-8 length mismatches.
   * `chunkCount` is how many host-sent chunks the completed write coalesced —
   * that many FIFO entries are settled and summed into ONE ack message (the
   * host's removeBytes accepts aggregate counts, same as discardPortAcks).
   * Shifts at most what is queued: entries for IPC or early-buffer-flushed
   * data never exist, so over-counted requests degrade to a no-op.
   */
  acknowledgePortData: (id: string, _bytes: number, chunkCount = 1): void => {
    if (!messagePort) return;
    const queue = pendingPortAckBytes.get(id);
    if (!queue || queue.length === 0) return;
    const take = Math.min(chunkCount, queue.length);
    let bytes = 0;
    for (let i = 0; i < take; i++) {
      bytes += queue[i]!;
    }
    queue.splice(0, take);
    // Clean up empty queue to prevent unbounded map growth
    if (queue.length === 0) {
      pendingPortAckBytes.delete(id);
    }
    if (bytes === 0) return;
    try {
      messagePort.postMessage({ type: "ack", id, bytes });
    } catch {
      // Port closed — ack lost, safety timeout will resume PTY
    }
  },

  /**
   * Drain the entire pending port-ack FIFO for a terminal as one batched ack.
   * Called when a queued port chunk is dropped without ever reaching xterm
   * (renderer-side destroy without a prior kill — project close, LRU
   * eviction) — the pty-host's queuedBytes ledger still counts them, so
   * dropping the queue without acking leaves a permanent deficit that degrades
   * every backpressure pause to the 10s safety timeout (#9910). The FIFO entry
   * is always deleted, even when the port is gone or postMessage throws: stale
   * entries would be re-summed into phantom acks on the next discard.
   */
  discardPortAcks: (id: string): void => {
    const queue = pendingPortAckBytes.get(id);
    if (!queue) return;
    pendingPortAckBytes.delete(id);
    if (!messagePort) return;
    let bytes = 0;
    for (const entry of queue) {
      bytes += entry;
    }
    if (bytes === 0) return;
    try {
      messagePort.postMessage({ type: "ack", id, bytes });
    } catch {
      // Port closed — ack lost, safety timeout will resume PTY
    }
  },

  /**
   * Query backend for terminals belonging to a specific project.
   * Used during state hydration to reconcile UI with backend processes.
   */
  getForProject: (projectId: string): Promise<BackendTerminalInfo[]> => {
    return window.electron.terminal.getForProject(projectId);
  },

  /**
   * Reconnect to an existing terminal process in the backend.
   * Returns the terminal info if it exists, error otherwise.
   */
  reconnect: (terminalId: string): Promise<TerminalReconnectResult> => {
    return window.electron.terminal.reconnect(terminalId);
  },

  /**
   * Probe reconnect state for many terminals in a single round-trip.
   * Returns a map keyed by terminal ID; missing/failed IDs report
   * `{ exists: false }`. Used by the cold-boot panel-restore prefetch.
   */
  reconnectBulk: (terminalIds: string[]): Promise<Record<string, TerminalReconnectResult>> => {
    return window.electron.terminal.reconnectBulk(terminalIds);
  },

  /**
   * Replay terminal history from backend semantic buffer.
   * Used after reconnecting to restore terminal output.
   */
  replayHistory: (terminalId: string, maxLines?: number): Promise<{ replayed: number }> => {
    return window.electron.terminal.replayHistory(terminalId, maxLines);
  },

  /**
   * Get serialized terminal state from headless xterm backend.
   * Returns full terminal state including colors, formatting, cursor position.
   * Used for fast restoration on app reload.
   */
  getSerializedState: (terminalId: string): Promise<string | null> => {
    return window.electron.terminal.getSerializedState(terminalId);
  },

  /**
   * Get serialized terminal states in a single round-trip.
   * Returns a map keyed by terminal ID with null for missing states.
   */
  getSerializedStates: (panelIds: string[]): Promise<Record<string, string | null>> => {
    return window.electron.terminal.getSerializedStates(panelIds);
  },

  /**
   * Get SharedArrayBuffers for zero-copy terminal I/O.
   * Returns empty arrays if SharedArrayBuffer is unavailable (fallback to IPC).
   */
  getSharedBuffers: (): Promise<{
    visualBuffers: SharedArrayBuffer[];
    signalBuffer: SharedArrayBuffer | null;
  }> => {
    return window.electron.terminal.getSharedBuffers();
  },

  /**
   * Force resume a terminal that may be paused due to backpressure.
   * User-initiated action to unblock a terminal.
   */
  forceResume: (id: string): Promise<void> => {
    return window.electron.terminal.forceResume(id);
  },

  /**
   * Listen for terminal status changes (flow control state).
   *
   * Subscribes to both delivery paths: the Main-process IPC broadcast and the
   * per-window MessagePort pulses (data-loss for a saturated window in the
   * multi-window fan-out, issue #9891). A window only receives port pulses meant
   * for it, so the discontinuity marker lands in the right place.
   */
  onStatus: (callback: (data: TerminalStatusPayload) => void): (() => void) => {
    terminalStatusCallbacks.add(callback);
    const ipcCleanup = window.electron.terminal.onStatus(callback);
    return () => {
      terminalStatusCallbacks.delete(callback);
      ipcCleanup();
    };
  },

  /**
   * Listen for terminal reliability metrics (pause-start/end, suspend,
   * pending-bytes-gauge, throughput-rate, pause-duration-gauge,
   * queue-depth-gauge, data-loss-count). Emitted by the host's
   * `ResourceGovernor` tick and the queue managers' pause/resume paths.
   */
  onReliabilityMetric: (
    callback: (data: TerminalReliabilityMetricPayload) => void
  ): (() => void) => {
    return window.electron.terminal.onReliabilityMetric(callback);
  },

  /**
   * Listen for backend crash events.
   */
  onBackendCrashed: (
    callback: (data: {
      crashType: string;
      code: number | null;
      signal: string | null;
      timestamp: number;
    }) => void
  ): (() => void) => {
    return window.electron.terminal.onBackendCrashed(callback);
  },

  /**
   * Listen for backend recovering events (during auto-restart backoff).
   */
  onBackendRecovering: (
    callback: (data: {
      crashType: string;
      code: number | null;
      signal: string | null;
      timestamp: number;
    }) => void
  ): (() => void) => {
    return window.electron.terminal.onBackendRecovering(callback);
  },

  /**
   * Listen for backend ready events (after crash recovery).
   */
  onBackendReady: (callback: () => void): (() => void) => {
    return window.electron.terminal.onBackendReady(callback);
  },

  /**
   * Listen for spawn result events (success or failure).
   * This is emitted for every spawn attempt with the result.
   */
  onSpawnResult: (callback: (id: string, result: SpawnResult) => void): (() => void) => {
    return window.electron.terminal.onSpawnResult(callback);
  },

  onReduceScrollback: (
    callback: (data: { terminalIds: string[]; targetLines: number }) => void
  ): (() => void) => {
    return window.electron.terminal.onReduceScrollback(callback);
  },

  onRestoreScrollback: (callback: (data: { terminalIds: string[] }) => void): (() => void) => {
    return window.electron.terminal.onRestoreScrollback(callback);
  },

  restartService: (): Promise<void> => {
    return window.electron.terminal.restartService();
  },
} as const;
