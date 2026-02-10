import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useProjectStore } from "@/store/projectStore";
import type { DevServerErrorType } from "../../shared/utils/devServerErrors";
import type { DevPreviewSessionState } from "../../shared/types/ipc/devPreview";

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

function serializeEnv(env?: Record<string, string>): string {
  if (!env) return "";
  return Object.keys(env)
    .sort()
    .map((key) => `${key}\u0000${env[key]}`)
    .join("\u0001");
}

export function useDevServer({
  panelId,
  devCommand,
  cwd,
  worktreeId,
  env,
}: UseDevServerOptions): UseDevServerReturn {
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const [status, setStatus] = useState<DevPreviewStatus>("stopped");
  const [url, setUrl] = useState<string | null>(null);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [error, setError] = useState<{ type: DevServerErrorType; message: string } | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const isMountedRef = useRef(true);
  const isEnsuringRef = useRef(false);
  const lastEnsureConfigRef = useRef<string>("");

  const envSignature = useMemo(() => serializeEnv(env), [env]);

  const applyState = useCallback((state: DevPreviewSessionState) => {
    if (!isMountedRef.current) return;
    setStatus(state.status);
    setUrl(state.url);
    setTerminalId(state.terminalId);
    setError(
      state.error
        ? ({ type: state.error.type, message: state.error.message } as {
            type: DevServerErrorType;
            message: string;
          })
        : null
    );
    setIsRestarting(state.isRestarting);
  }, []);

  const applyInvokeError = useCallback((err: unknown) => {
    if (!isMountedRef.current) return;
    const message = err instanceof Error ? err.message : String(err);
    setStatus("error");
    setError({ type: "unknown", message });
    setTerminalId(null);
    setIsRestarting(false);
  }, []);

  const start = useCallback(async () => {
    if (isEnsuringRef.current) return;
    if (!currentProjectId) {
      applyInvokeError(new Error("No active project"));
      return;
    }
    if (!devCommand.trim()) {
      applyInvokeError(new Error("No dev command configured"));
      return;
    }

    isEnsuringRef.current = true;
    try {
      const nextState = await window.electron.devPreview.ensure({
        panelId,
        projectId: currentProjectId,
        cwd,
        devCommand,
        worktreeId,
        env,
      });
      applyState(nextState);
    } catch (err) {
      applyInvokeError(err);
    } finally {
      isEnsuringRef.current = false;
    }
  }, [panelId, currentProjectId, cwd, devCommand, worktreeId, env, applyState, applyInvokeError]);

  const stop = useCallback(() => {
    if (!currentProjectId) return;
    void window.electron.devPreview
      .stop({ panelId, projectId: currentProjectId })
      .then(applyState)
      .catch(applyInvokeError);
  }, [panelId, currentProjectId, applyState, applyInvokeError]);

  const restart = useCallback(async () => {
    if (!currentProjectId) {
      applyInvokeError(new Error("No active project"));
      return;
    }
    try {
      const nextState = await window.electron.devPreview.restart({
        panelId,
        projectId: currentProjectId,
      });
      applyState(nextState);
    } catch (err) {
      applyInvokeError(err);
    }
  }, [panelId, currentProjectId, applyState, applyInvokeError]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!currentProjectId) {
      setStatus("stopped");
      setUrl(null);
      setTerminalId(null);
      setError(null);
      setIsRestarting(false);
      return;
    }

    let cancelled = false;
    void window.electron.devPreview
      .getState({ panelId, projectId: currentProjectId })
      .then((state) => {
        if (!cancelled) applyState(state);
      })
      .catch((err) => {
        if (!cancelled) applyInvokeError(err);
      });

    return () => {
      cancelled = true;
    };
  }, [panelId, currentProjectId, applyState, applyInvokeError]);

  useEffect(() => {
    if (!currentProjectId) return;
    return window.electron.devPreview.onStateChanged((payload) => {
      const { state } = payload;
      if (state.panelId !== panelId) return;
      if (state.projectId !== currentProjectId) return;
      applyState(state);
    });
  }, [panelId, currentProjectId, applyState]);

  useEffect(() => {
    if (!currentProjectId) return;
    if (!devCommand.trim()) return;

    const configKey = [
      currentProjectId,
      panelId,
      cwd,
      worktreeId ?? "",
      devCommand.trim(),
      envSignature,
    ].join("|");

    if (lastEnsureConfigRef.current === configKey) return;
    lastEnsureConfigRef.current = configKey;
    void start();
  }, [panelId, currentProjectId, cwd, worktreeId, devCommand, envSignature, start]);

  useEffect(() => {
    if (!currentProjectId) return;
    if (!devCommand.trim()) return;
    if (isRestarting) return;
    if (status !== "stopped") return;
    void start();
  }, [currentProjectId, devCommand, status, isRestarting, start]);

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
