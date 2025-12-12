import type {
  TerminalSpawnOptions,
  AgentStateChangePayload,
  TerminalActivityPayload,
  BackendTerminalInfo,
  TerminalReconnectResult,
  TerminalStatusPayload,
} from "@shared/types";

let messagePort: MessagePort | null = null;

// Listen for MessagePort transferred from preload
if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    if (event.data?.type === "terminal-port" && event.ports?.[0]) {
      messagePort = event.ports[0];
      messagePort.start();
      console.log("[TerminalClient] MessagePort acquired via postMessage");
    }
  });

  // Check if port was already sent (unlikely given race, but good practice if we add handshake later)
  // For now, we rely on the event listener.
  // We can also call the deprecated method just to be safe if we reverted the preload change,
  // but since we controlled the preload change, we know it returns null.
}

export const terminalClient = {
  spawn: (options: TerminalSpawnOptions): Promise<string> => {
    return window.electron.terminal.spawn(options);
  },

  write: (id: string, data: string): void => {
    if (messagePort) {
      messagePort.postMessage({ type: "write", id, data });
    } else {
      window.electron.terminal.write(id, data);
    }
  },

  resize: (id: string, cols: number, rows: number): void => {
    if (messagePort) {
      messagePort.postMessage({ type: "resize", id, cols, rows });
    } else {
      window.electron.terminal.resize(id, cols, rows);
    }
  },

  kill: (id: string): Promise<void> => {
    return window.electron.terminal.kill(id);
  },

  trash: (id: string): Promise<void> => {
    return window.electron.terminal.trash(id);
  },

  restore: (id: string): Promise<boolean> => {
    return window.electron.terminal.restore(id);
  },

  onData: (id: string, callback: (data: string | Uint8Array) => void): (() => void) => {
    return window.electron.terminal.onData(id, callback);
  },

  onExit: (callback: (id: string, exitCode: number) => void): (() => void) => {
    return window.electron.terminal.onExit(callback);
  },

  onAgentStateChanged: (callback: (data: AgentStateChangePayload) => void): (() => void) => {
    return window.electron.terminal.onAgentStateChanged(callback);
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

  flush: (id: string): Promise<void> => {
    return window.electron.terminal.flush(id);
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
   * Get SharedArrayBuffer for zero-copy terminal I/O.
   * Returns null if SharedArrayBuffer is unavailable (fallback to IPC).
   */
  getSharedBuffer: (): Promise<SharedArrayBuffer | null> => {
    return window.electron.terminal.getSharedBuffer();
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
} as const;
