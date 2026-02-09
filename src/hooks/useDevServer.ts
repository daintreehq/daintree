import { useState, useCallback, useEffect, useRef } from "react";
import { terminalClient } from "../clients/terminalClient";
import { useTerminalStore } from "../store/terminalStore";
import type { DevServerErrorType } from "../../shared/utils/devServerErrors";

export type DevPreviewStatus = "stopped" | "starting" | "installing" | "running" | "error";

export interface UseDevServerOptions {
  panelId: string;
  devCommand: string;
  cwd: string;
  worktreeId?: string;
  env?: Record<string, string>;
}

export interface UseDevServerState {
  status: DevPreviewStatus;
  url: string | null;
  terminalId: string | null;
  error: { type: DevServerErrorType; message: string } | null;
}

export interface UseDevServerReturn extends UseDevServerState {
  start: () => Promise<void>;
  stop: () => void;
}

export function useDevServer({
  panelId,
  devCommand,
  cwd,
  worktreeId,
  env,
}: UseDevServerOptions): UseDevServerReturn {
  const terminalStore = useTerminalStore();
  const panel = terminalStore.getTerminal(panelId);

  // Initialize from persisted state or default to stopped
  const [status, setStatus] = useState<DevPreviewStatus>(panel?.devServerStatus ?? "stopped");
  const [url, setUrl] = useState<string | null>(panel?.devServerUrl ?? null);
  const [terminalId, setTerminalId] = useState<string | null>(panel?.devServerTerminalId ?? null);
  const [error, setError] = useState<{ type: DevServerErrorType; message: string } | null>(
    panel?.devServerError ?? null
  );

  const cleanupRef = useRef<(() => void) | null>(null);
  const terminalIdRef = useRef<string | null>(panel?.devServerTerminalId ?? null);
  const isStartingRef = useRef(false);
  const isMountedRef = useRef(true);

  const disconnect = useCallback(() => {
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    disconnect();

    if (terminalIdRef.current) {
      terminalClient.kill(terminalIdRef.current).catch((err) => {
        console.error("[useDevServer] Failed to kill terminal:", err);
      });
    }

    setStatus("stopped");
    setUrl(null);
    setTerminalId(null);
    terminalIdRef.current = null;
    setError(null);

    // Clear persisted state
    terminalStore.setDevServerState(panelId, "stopped", null, null, null);
  }, [disconnect, panelId, terminalStore]);

  const start = useCallback(async () => {
    if (isStartingRef.current) {
      return;
    }

    isStartingRef.current = true;
    const sessionId = Date.now();
    const sessionIdRef = { current: sessionId };

    // Clean up any existing listeners
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }

    if (!devCommand.trim()) {
      const errorObj = { type: "unknown" as const, message: "No dev command configured" };
      setError(errorObj);
      setStatus("error");
      terminalStore.setDevServerState(panelId, "error", null, errorObj, null);
      isStartingRef.current = false;
      return;
    }

    // Try to reconnect to existing terminal first
    const persistedTerminalId = panel?.devServerTerminalId;
    let id: string | null = null;
    let reconnected = false;

    if (persistedTerminalId && persistedTerminalId === terminalIdRef.current) {
      try {
        const reconnectResult = await terminalClient.reconnect(persistedTerminalId);
        if (reconnectResult?.id && reconnectResult.exists && reconnectResult.hasPty) {
          id = reconnectResult.id;
          reconnected = true;
          console.log(`[useDevServer] Reconnected to existing terminal: ${id}`);
        }
      } catch (err) {
        console.log(`[useDevServer] Reconnect failed, will spawn new terminal:`, err);
      }
    }

    // Check if still mounted after reconnect attempt
    if (!isMountedRef.current || sessionIdRef.current !== sessionId) {
      isStartingRef.current = false;
      return;
    }

    setStatus("starting");
    setError(null);

    const listeners: Array<() => void> = [];

    try {
      // If reconnection failed or no persisted terminal, spawn a new one
      if (!reconnected) {
        // Kill any orphaned terminal
        if (terminalIdRef.current) {
          terminalClient.kill(terminalIdRef.current).catch(() => {});
          terminalIdRef.current = null;
        }

        setUrl(null);
        setTerminalId(null);

        id = await terminalClient.spawn({
          id: panelId,
          command: devCommand,
          cwd,
          worktreeId,
          kind: "dev-preview",
          cols: 80,
          rows: 30,
          restore: false,
          env,
        });

        console.log(`[useDevServer] Spawned new terminal: ${id}`);
      }

      // Check if still mounted after spawn
      if (!isMountedRef.current || sessionIdRef.current !== sessionId) {
        if (id && !reconnected) {
          terminalClient.kill(id).catch(() => {});
        }
        isStartingRef.current = false;
        return;
      }

      setTerminalId(id);
      terminalIdRef.current = id;

      const statusRef = { current: "starting" as DevPreviewStatus };

      // Assign cleanup early to prevent leak if unmount happens during listener setup
      cleanupRef.current = () => {
        window.electron.devPreview.unsubscribe(id!).catch((err) => {
          console.error("[useDevServer] Failed to unsubscribe:", err);
        });
        listeners.forEach((unsub) => unsub());
      };

      const unsubscribeUrl = window.electron.devPreview.onUrlDetected((payload) => {
        if (payload.terminalId === id && isMountedRef.current && sessionIdRef.current === sessionId) {
          setUrl(payload.url);
          setStatus("running");
          statusRef.current = "running";
          setError(null);
          terminalStore.setDevServerState(panelId, "running", payload.url, null, id);
        }
      });
      listeners.push(unsubscribeUrl);

      const unsubscribeError = window.electron.devPreview.onErrorDetected((payload) => {
        if (payload.terminalId === id && isMountedRef.current && sessionIdRef.current === sessionId) {
          const newStatus = payload.error.type === "missing-dependencies" ? "installing" : "error";
          const errorObj = { type: payload.error.type, message: payload.error.message };
          setError(errorObj);
          setStatus(newStatus);
          statusRef.current = newStatus;
          terminalStore.setDevServerState(panelId, newStatus, null, errorObj, id);
        }
      });
      listeners.push(unsubscribeError);

      const unsubscribeExit = window.electron.terminal.onExit(
        (termId: string, exitCode: number) => {
          if (termId === id && isMountedRef.current && sessionIdRef.current === sessionId) {
            if (statusRef.current === "starting" || statusRef.current === "installing") {
              const errorObj = {
                type: "unknown" as const,
                message: `Dev server exited with code ${exitCode}`,
              };
              setError(errorObj);
              setStatus("error");
              statusRef.current = "error";
              setTerminalId(null);
              terminalIdRef.current = null;
              terminalStore.setDevServerState(panelId, "error", null, errorObj, null);
            } else {
              setStatus("stopped");
              statusRef.current = "stopped";
              setTerminalId(null);
              terminalIdRef.current = null;
              terminalStore.setDevServerState(panelId, "stopped", null, null, null);
            }
          }
        }
      );
      listeners.push(unsubscribeExit);

      // Check if still mounted before subscribe
      if (!isMountedRef.current || sessionIdRef.current !== sessionId) {
        cleanupRef.current();
        cleanupRef.current = null;
        isStartingRef.current = false;
        return;
      }

      await window.electron.devPreview.subscribe(id);

      // Persist initial state
      if (isMountedRef.current && sessionIdRef.current === sessionId) {
        terminalStore.setDevServerState(panelId, "starting", null, null, id);
      }

      isStartingRef.current = false;
    } catch (err) {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      listeners.forEach((unsub) => unsub());

      if (id && !reconnected) {
        terminalClient.kill(id).catch(() => {});
      }

      if (isMountedRef.current && sessionIdRef.current === sessionId) {
        const errorObj = {
          type: "unknown" as const,
          message: err instanceof Error ? err.message : String(err),
        };
        setError(errorObj);
        setStatus("error");
        setTerminalId(null);
        terminalIdRef.current = null;
        terminalStore.setDevServerState(panelId, "error", null, errorObj, null);
      }
      isStartingRef.current = false;
    }
  }, [panelId, devCommand, cwd, worktreeId, env, panel, terminalStore]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // Only disconnect listeners, don't kill the terminal
      disconnect();
    };
  }, [disconnect]);

  return {
    status,
    url,
    terminalId,
    error,
    start,
    stop,
  };
}
