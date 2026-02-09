import { useState, useCallback, useEffect, useRef } from "react";
import { terminalClient } from "../clients/terminalClient";
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
  const [status, setStatus] = useState<DevPreviewStatus>("stopped");
  const [url, setUrl] = useState<string | null>(null);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [error, setError] = useState<{ type: DevServerErrorType; message: string } | null>(null);

  const cleanupRef = useRef<(() => void) | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const isStartingRef = useRef(false);

  const stop = useCallback(() => {
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }

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
  }, []);

  const start = useCallback(async () => {
    if (isStartingRef.current) {
      return;
    }

    isStartingRef.current = true;

    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }

    if (terminalIdRef.current) {
      terminalClient.kill(terminalIdRef.current).catch(() => {});
      terminalIdRef.current = null;
    }

    if (!devCommand.trim()) {
      setError({ type: "unknown", message: "No dev command configured" });
      setStatus("error");
      isStartingRef.current = false;
      return;
    }

    setStatus("starting");
    setError(null);
    setUrl(null);
    setTerminalId(null);

    let id: string | null = null;
    const listeners: Array<() => void> = [];

    try {
      id = await terminalClient.spawn({
        id: panelId,
        command: devCommand,
        cwd,
        worktreeId,
        kind: "dev-preview",
        cols: 80,
        rows: 30,
        restore: false,
        isEphemeral: true,
        env,
      });

      setTerminalId(id);
      terminalIdRef.current = id;

      const statusRef = { current: "starting" as DevPreviewStatus };

      const unsubscribeUrl = window.electron.devPreview.onUrlDetected((payload) => {
        if (payload.terminalId === id) {
          setUrl(payload.url);
          setStatus("running");
          statusRef.current = "running";
          setError(null);
        }
      });
      listeners.push(unsubscribeUrl);

      const unsubscribeError = window.electron.devPreview.onErrorDetected((payload) => {
        if (payload.terminalId === id) {
          const newStatus = payload.error.type === "missing-dependencies" ? "installing" : "error";
          setError({ type: payload.error.type, message: payload.error.message });
          setStatus(newStatus);
          statusRef.current = newStatus;
        }
      });
      listeners.push(unsubscribeError);

      const unsubscribeExit = window.electron.terminal.onExit(
        (termId: string, exitCode: number) => {
          if (termId === id) {
            if (statusRef.current === "starting" || statusRef.current === "installing") {
              setError({
                type: "unknown",
                message: `Dev server exited with code ${exitCode}`,
              });
              setStatus("error");
              statusRef.current = "error";
            } else {
              setStatus("stopped");
              statusRef.current = "stopped";
            }
          }
        }
      );
      listeners.push(unsubscribeExit);

      await window.electron.devPreview.subscribe(id);

      cleanupRef.current = () => {
        window.electron.devPreview.unsubscribe(id!).catch((err) => {
          console.error("[useDevServer] Failed to unsubscribe:", err);
        });
        listeners.forEach((unsub) => unsub());
      };

      isStartingRef.current = false;
    } catch (err) {
      listeners.forEach((unsub) => unsub());

      if (id) {
        terminalClient.kill(id).catch(() => {});
      }

      setError({
        type: "unknown",
        message: err instanceof Error ? err.message : String(err),
      });
      setStatus("error");
      setTerminalId(null);
      terminalIdRef.current = null;
      isStartingRef.current = false;
    }
  }, [panelId, devCommand, cwd, worktreeId, env]);

  useEffect(() => {
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
      }
    };
  }, []);

  return {
    status,
    url,
    terminalId,
    error,
    start,
    stop,
  };
}
