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
import type { PtyHostToRendererMessage } from "@shared/types/pty-host";
import { logDebug, logWarn } from "@/utils/logger";

let messagePort: MessagePort | null = null;
let expectedToken: string | null = null;
let pendingPort: MessagePort | null = null;
let pendingToken: string | null = null;

const dataCallbacks = new Map<string, Set<(data: string | Uint8Array) => void>>();
const earlyDataBuffer = new Map<string, Array<string | Uint8Array>>();
const pendingPortAckBytes = new Map<string, number[]>();
const MAX_EARLY_BUFFER_CHUNKS = 500;

function installPortDataHandler(port: MessagePort): void {
  port.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as PtyHostToRendererMessage;
    if (msg?.type === "data" && typeof msg.id === "string") {
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
        if (buf.length < MAX_EARLY_BUFFER_CHUNKS) {
          buf.push(msg.data);
        }
      }
    }
  });
}

function activatePort(port: MessagePort): void {
  if (messagePort) messagePort.close();
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
    }
  });
}

export const terminalClient = {
  spawn: (options: TerminalSpawnOptions): Promise<string> => {
    return window.electron.terminal.spawn(options);
  },

  write: (id: string, data: string): void => {
    if (messagePort) {
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
    pendingPortAckBytes.delete(id);
    return window.electron.terminal.kill(id);
  },

  gracefulKill: (id: string): Promise<string | null> => {
    earlyDataBuffer.delete(id);
    pendingPortAckBytes.delete(id);
    return window.electron.terminal.gracefulKill(id);
  },

  trash: (id: string): Promise<void> => {
    earlyDataBuffer.delete(id);
    pendingPortAckBytes.delete(id);
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

  setActivityTier: (id: string, tier: "active" | "background"): void => {
    window.electron.terminal.setActivityTier(id, tier);
  },

  wake: (id: string): Promise<{ state: string | null; warnings?: string[] }> => {
    return window.electron.terminal.wake(id);
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
   * Uses the original pty-host byte count queued by installPortDataHandler, not the
   * caller's byte count, to avoid UTF-16 vs UTF-8 length mismatches.
   * No-op when the queue is empty (data came via IPC or early-buffer flush).
   */
  acknowledgePortData: (id: string, _bytes: number): void => {
    if (!messagePort) return;
    const queue = pendingPortAckBytes.get(id);
    if (!queue || queue.length === 0) return;
    const bytes = queue.shift()!;
    // Clean up empty queue to prevent unbounded map growth
    if (queue.length === 0) {
      pendingPortAckBytes.delete(id);
    }
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
  forceResume: (id: string): Promise<{ success: boolean; error?: string }> => {
    return window.electron.terminal.forceResume(id);
  },

  /**
   * Listen for terminal status changes (flow control state).
   */
  onStatus: (callback: (data: TerminalStatusPayload) => void): (() => void) => {
    return window.electron.terminal.onStatus(callback);
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
