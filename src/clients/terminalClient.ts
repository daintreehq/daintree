import type {
  TerminalSpawnOptions,
  AgentStateChangePayload,
  AgentDetectedPayload,
  AgentExitedPayload,
  TerminalActivityPayload,
  BackendTerminalInfo,
  TerminalReconnectResult,
  TerminalStatusPayload,
  SpawnResult,
} from "@shared/types";
import type { PtyHostToRendererMessage } from "@shared/types/pty-host";
import { logDebug, logWarn } from "@/utils/logger";

let messagePort: MessagePort | null = null;
let expectedToken: string | null = null;
let pendingPort: MessagePort | null = null;
let pendingToken: string | null = null;
let messagePortConnected = false;

const dataCallbacks = new Map<string, Set<(data: string | Uint8Array) => void>>();
const earlyDataBuffer = new Map<string, Array<string | Uint8Array>>();
const MAX_EARLY_BUFFER_CHUNKS = 500;

function installPortDataHandler(port: MessagePort): void {
  port.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as PtyHostToRendererMessage;
    if (msg?.type === "data" && typeof msg.id === "string") {
      // Send ack immediately on receipt — before dispatching to callbacks or buffering.
      // This ensures the PTY host queue drains even for early-buffered data,
      // preventing the high watermark from triggering before callbacks register.
      const byteCount = msg.bytes ?? 0;
      try {
        port.postMessage({ type: "ack", id: msg.id, bytes: byteCount });
      } catch {
        // Port closed — ack lost, safety timeout will resume PTY
      }

      const cbs = dataCallbacks.get(msg.id);
      if (cbs) {
        for (const cb of cbs) {
          cb(msg.data);
        }
      } else {
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
  messagePortConnected = true;
  installPortDataHandler(port);
  port.addEventListener("close", () => {
    if (messagePort === port) {
      messagePort = null;
      messagePortConnected = false;
      logDebug("[TerminalClient] MessagePort closed, falling back to IPC");
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
        messagePortConnected = false;
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

  resize: (id: string, cols: number, rows: number): void => {
    if (messagePort) {
      try {
        messagePort.postMessage({ type: "resize", id, cols, rows });
      } catch (error) {
        logWarn("[TerminalClient] MessagePort resize failed, clearing port", { error });
        messagePort = null;
        messagePortConnected = false;
        window.electron.terminal.resize(id, cols, rows);
      }
    } else {
      window.electron.terminal.resize(id, cols, rows);
    }
  },

  kill: (id: string): Promise<void> => {
    earlyDataBuffer.delete(id);
    return window.electron.terminal.kill(id);
  },

  gracefulKill: (id: string): Promise<string | null> => {
    earlyDataBuffer.delete(id);
    return window.electron.terminal.gracefulKill(id);
  },

  trash: (id: string): Promise<void> => {
    earlyDataBuffer.delete(id);
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

    // IPC fallback: skip dispatch when MessagePort is delivering data
    const ipcCleanup = window.electron.terminal.onData(id, (data: string | Uint8Array) => {
      if (messagePortConnected) return;
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
   * Acknowledge processed data bytes to the backend (Flow Control).
   */
  acknowledgeData: (id: string, length: number): void => {
    window.electron.terminal.acknowledgeData(id, length);
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
  getSerializedStates: (terminalIds: string[]): Promise<Record<string, string | null>> => {
    return window.electron.terminal.getSerializedStates(terminalIds);
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
