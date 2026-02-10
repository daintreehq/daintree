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
  restart: () => Promise<void>;
  isRestarting: boolean;
}

const isBenignMissingTerminalError = (err: unknown): boolean => {
  const errorMessage = err instanceof Error ? err.message : String(err);
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("not found") ||
    normalized.includes("does not exist") ||
    normalized.includes("terminal not found") ||
    normalized.includes("unknown terminal")
  );
};

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
    (panel?.devServerError as { type: DevServerErrorType; message: string }) ?? null
  );

  const [isRestarting, setIsRestarting] = useState(false);

  const cleanupRef = useRef<(() => void) | null>(null);
  const terminalIdRef = useRef<string | null>(panel?.devServerTerminalId ?? null);
  const pendingDevPreviewUnsubscribeRef = useRef<Promise<void> | null>(null);
  const isStartingRef = useRef(false);
  const isRestartingRef = useRef(false);
  const forceFreshSpawnRef = useRef(false);
  const isMountedRef = useRef(true);
  const needsTransitionRecoveryRef = useRef(
    panel?.devServerStatus === "starting" || panel?.devServerStatus === "installing"
  );

  const resetToStopped = useCallback(() => {
    if (!isMountedRef.current) return;
    setStatus("stopped");
    setUrl(null);
    setTerminalId(null);
    terminalIdRef.current = null;
    setError(null);
    terminalStore.setDevServerState(panelId, "stopped", null, null, null);
  }, [panelId, terminalStore]);

  const disconnect = useCallback(() => {
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
  }, []);

  const unsubscribeDevPreview = useCallback(async (id: string): Promise<void> => {
    try {
      await window.electron.devPreview.unsubscribe(id);
    } catch (err) {
      console.warn("[useDevServer] Failed to unsubscribe dev preview:", err);
    }
  }, []);

  const queueDevPreviewUnsubscribe = useCallback(
    (id: string): Promise<void> => {
      const queued = unsubscribeDevPreview(id).finally(() => {
        if (pendingDevPreviewUnsubscribeRef.current === queued) {
          pendingDevPreviewUnsubscribeRef.current = null;
        }
      });
      pendingDevPreviewUnsubscribeRef.current = queued;
      return queued;
    },
    [unsubscribeDevPreview]
  );

  const waitForTerminalGone = useCallback(
    async (id: string, timeoutMs = 8000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const reconnectResult = await terminalClient.reconnect(id);
          if (!reconnectResult?.exists || !reconnectResult.hasPty) {
            return true;
          }
        } catch {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    },
    []
  );

  const killTerminalAndWait = useCallback(
    async (id: string, context: string): Promise<void> => {
      try {
        await terminalClient.kill(id);
      } catch (err) {
        if (!isBenignMissingTerminalError(err)) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to kill terminal (${context}): ${errorMessage}`);
        }
      }

      const didStop = await waitForTerminalGone(id);
      if (!didStop) {
        throw new Error(
          `Timed out waiting for terminal ${id} to stop (${context}). Refusing to spawn duplicate dev server.`
        );
      }
    },
    [waitForTerminalGone]
  );

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
    const forceFreshSpawn = forceFreshSpawnRef.current;
    forceFreshSpawnRef.current = false;
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

    if (!forceFreshSpawn && persistedTerminalId && persistedTerminalId === terminalIdRef.current) {
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
          try {
            await killTerminalAndWait(terminalIdRef.current, "orphan cleanup");
          } catch (killErr) {
            if (isMountedRef.current && sessionIdRef.current === sessionId) {
              const errorObj = {
                type: "unknown" as const,
                message: killErr instanceof Error ? killErr.message : String(killErr),
              };
              setError(errorObj);
              setStatus("error");
              setTerminalId(null);
              terminalIdRef.current = null;
              terminalStore.setDevServerState(panelId, "error", null, errorObj, null);
            }
            isStartingRef.current = false;
            return;
          }
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
        if (id) {
          void queueDevPreviewUnsubscribe(id);
        }
        listeners.forEach((unsub) => unsub());
      };

      const unsubscribeUrl = window.electron.devPreview.onUrlDetected((payload) => {
        if (
          payload.terminalId === id &&
          isMountedRef.current &&
          sessionIdRef.current === sessionId
        ) {
          setUrl(payload.url);
          setStatus("running");
          statusRef.current = "running";
          setError(null);
          terminalStore.setDevServerState(panelId, "running", payload.url, null, id);
        }
      });
      listeners.push(unsubscribeUrl);

      const unsubscribeError = window.electron.devPreview.onErrorDetected((payload) => {
        if (
          payload.terminalId === id &&
          isMountedRef.current &&
          sessionIdRef.current === sessionId
        ) {
          const newStatus = payload.error.type === "missing-dependencies" ? "installing" : "error";
          const errorObj = { type: payload.error.type, message: payload.error.message };

          // During an explicit hard restart, transient detector errors can arrive
          // before the new server announces its URL. Keep startup state and wait
          // for either URL detection or process exit to decide final status.
          if (isRestartingRef.current && newStatus === "error") {
            setError(errorObj);
            setStatus("starting");
            statusRef.current = "starting";
            terminalStore.setDevServerState(panelId, "starting", null, errorObj, id);
            return;
          }

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
        if (cleanupRef.current) cleanupRef.current();
        cleanupRef.current = null;
        isStartingRef.current = false;
        return;
      }

      if (pendingDevPreviewUnsubscribeRef.current) {
        await pendingDevPreviewUnsubscribeRef.current;
      }

      // Ensure a fresh detector subscription state for this terminal ID.
      await unsubscribeDevPreview(id!);
      await window.electron.devPreview.subscribe(id!);
      // Backfill output that may have been emitted before subscription attached.
      await terminalClient.replayHistory(id!, 300).catch((err) => {
        console.warn("[useDevServer] Failed to replay history after subscribe:", err);
      });

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
  }, [
    panelId,
    devCommand,
    cwd,
    worktreeId,
    env,
    panel,
    terminalStore,
    killTerminalAndWait,
    queueDevPreviewUnsubscribe,
    unsubscribeDevPreview,
  ]);

  const restart = useCallback(async () => {
    if (isRestartingRef.current || isStartingRef.current) {
      return;
    }

    isRestartingRef.current = true;
    forceFreshSpawnRef.current = true;
    setIsRestarting(true);

    // Stop the current server
    disconnect();
    if (pendingDevPreviewUnsubscribeRef.current) {
      await pendingDevPreviewUnsubscribeRef.current;
    }
    const terminalToKill = terminalIdRef.current ?? panel?.devServerTerminalId;
    if (terminalToKill) {
      await unsubscribeDevPreview(terminalToKill);

      try {
        await killTerminalAndWait(terminalToKill, "restart");
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorObj = {
          type: "unknown" as const,
          message: `Failed to stop previous dev server: ${errorMessage}`,
        };
        setError(errorObj);
        setStatus("error");
        terminalStore.setDevServerState(panelId, "error", null, errorObj, null);
        isRestartingRef.current = false;
        setIsRestarting(false);
        return;
      }
    }

    setStatus("stopped");
    setUrl(null);
    setTerminalId(null);
    terminalIdRef.current = null;
    setError(null);
    terminalStore.setDevServerState(panelId, "stopped", null, null, null);

    isStartingRef.current = false;

    try {
      await start();
    } finally {
      // Keep restart state until a definitive status (running/error) arrives.
    }
  }, [
    disconnect,
    panelId,
    terminalStore,
    start,
    panel,
    killTerminalAndWait,
    unsubscribeDevPreview,
  ]);

  useEffect(() => {
    if (!isRestartingRef.current) return;
    if (status !== "running" && status !== "error") return;

    isRestartingRef.current = false;
    if (isMountedRef.current) {
      setIsRestarting(false);
    }
  }, [status]);

  // Transitional states are not reliable across unmount/project-switch boundaries.
  // If we rehydrate in "starting"/"installing", force a clean restart path.
  useEffect(() => {
    if (!needsTransitionRecoveryRef.current) return;
    if (status !== "starting" && status !== "installing") return;

    needsTransitionRecoveryRef.current = false;
    let cancelled = false;

    const reconcileTransitionState = async () => {
      const persistedId = terminalIdRef.current;
      if (!persistedId) {
        if (!cancelled) resetToStopped();
        return;
      }

      try {
        const reconnectResult = await terminalClient.reconnect(persistedId);
        if (cancelled || !isMountedRef.current) return;

        // Always reset transitional states so the pane can re-run start(),
        // re-subscribe listeners, and avoid stale perpetual spinners.
        if (!reconnectResult?.exists || !reconnectResult.hasPty) {
          resetToStopped();
          return;
        }
        resetToStopped();
      } catch (err) {
        console.warn("[useDevServer] Failed to reconcile transitional status:", err);
        if (!cancelled) {
          resetToStopped();
        }
      }
    };

    void reconcileTransitionState();

    return () => {
      cancelled = true;
    };
  }, [status, resetToStopped]);

  // Legacy snapshot recovery: if we have a running state but no terminal ID,
  // try panelId (historically used as the dev server PTY ID) before forcing a restart.
  useEffect(() => {
    if (status !== "running") return;
    if (terminalIdRef.current) return;

    let cancelled = false;

    const recoverMissingTerminalId = async () => {
      try {
        const reconnectResult = await terminalClient.reconnect(panelId);
        if (cancelled || !isMountedRef.current) return;

        if (reconnectResult?.exists && reconnectResult.hasPty && reconnectResult.id) {
          setTerminalId(reconnectResult.id);
          terminalIdRef.current = reconnectResult.id;
          terminalStore.setDevServerState(panelId, "running", url, error, reconnectResult.id);
          return;
        }
      } catch (err) {
        console.warn("[useDevServer] Failed to recover missing terminal ID:", err);
      }

      if (!cancelled) {
        resetToStopped();
      }
    };

    void recoverMissingTerminalId();

    return () => {
      cancelled = true;
    };
  }, [status, panelId, terminalStore, url, error, resetToStopped]);

  // Validate that persisted running terminal still exists after project switches.
  useEffect(() => {
    if (status !== "running") return;
    if (!url) {
      resetToStopped();
      return;
    }
    if (!terminalIdRef.current) return;

    let cancelled = false;
    const idToValidate = terminalIdRef.current;

    const validateRunningTerminal = async () => {
      try {
        const reconnectResult = await terminalClient.reconnect(idToValidate);
        if (cancelled || !isMountedRef.current) return;

        if (!reconnectResult?.exists || !reconnectResult.hasPty) {
          resetToStopped();
        }
      } catch (err) {
        console.warn("[useDevServer] Failed to validate running terminal:", err);
        if (!cancelled) {
          resetToStopped();
        }
      }
    };

    void validateRunningTerminal();

    return () => {
      cancelled = true;
    };
  }, [status, terminalId, url, resetToStopped]);

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
    restart,
    isRestarting,
  };
}
