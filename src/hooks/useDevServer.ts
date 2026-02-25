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

const STUCK_START_RECOVERY_MS = 10000;
const MAX_AUTO_RECOVERY_ATTEMPTS = 1;

function serializeEnv(env?: Record<string, string>): string {
  if (!env) return "";
  return Object.keys(env)
    .sort()
    .map((key) => `${key}\u0000${env[key]}`)
    .join("\u0001");
}

function buildEnsureConfigKey(params: {
  projectId: string;
  panelId: string;
  cwd: string;
  worktreeId?: string;
  devCommand: string;
  envSignature: string;
}): string {
  return [
    params.projectId,
    params.panelId,
    params.cwd,
    params.worktreeId ?? "",
    params.devCommand.trim(),
    params.envSignature,
  ].join("|");
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
  const latestSessionRef = useRef<{
    status: DevPreviewStatus;
    url: string | null;
    terminalId: string | null;
  }>({
    status: "stopped",
    url: null,
    terminalId: null,
  });
  const isMountedRef = useRef(true);
  const isEnsuringRef = useRef(false);
  const lastEnsureConfigRef = useRef<string>("");
  const pendingEnsureConfigRef = useRef<string | null>(null);
  const requestVersionRef = useRef(0);
  const autoRecoveryAttemptsRef = useRef<{ starting: number }>({
    starting: 0,
  });

  const latestContextRef = useRef<{
    panelId: string;
    projectId: string | null;
    cwd: string;
    worktreeId?: string;
    devCommand: string;
    env?: Record<string, string>;
  }>({
    panelId,
    projectId: currentProjectId,
    cwd,
    worktreeId,
    devCommand,
    env,
  });

  const envSignature = useMemo(() => serializeEnv(env), [env]);

  latestContextRef.current = {
    panelId,
    projectId: currentProjectId,
    cwd,
    worktreeId,
    devCommand,
    env,
  };

  const isRequestCurrent = useCallback(
    (requestVersion: number, requestProjectId: string, requestPanelId: string): boolean => {
      const latest = latestContextRef.current;
      return (
        isMountedRef.current &&
        requestVersion === requestVersionRef.current &&
        latest.projectId === requestProjectId &&
        latest.panelId === requestPanelId
      );
    },
    []
  );

  const applyState = useCallback((state: DevPreviewSessionState) => {
    if (!isMountedRef.current) return;
    latestSessionRef.current = {
      status: state.status,
      url: state.url,
      terminalId: state.terminalId,
    };
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
    latestSessionRef.current = {
      status: "error",
      url: null,
      terminalId: null,
    };
    setStatus("error");
    setError({ type: "unknown", message });
    setTerminalId(null);
    setIsRestarting(false);
  }, []);

  const ensureLatestConfig = useCallback(
    async (configKey: string) => {
      if (isEnsuringRef.current) {
        pendingEnsureConfigRef.current = configKey;
        return;
      }

      const latest = latestContextRef.current;
      const requestProjectId = latest.projectId;
      if (!requestProjectId) return;

      const trimmedCommand = latest.devCommand.trim();
      if (!trimmedCommand) return;

      const requestPanelId = latest.panelId;
      const requestVersion = requestVersionRef.current;

      isEnsuringRef.current = true;
      lastEnsureConfigRef.current = configKey;

      try {
        const nextState = await window.electron.devPreview.ensure({
          panelId: requestPanelId,
          projectId: requestProjectId,
          cwd: latest.cwd,
          devCommand: latest.devCommand,
          worktreeId: latest.worktreeId,
          env: latest.env,
        });

        if (isRequestCurrent(requestVersion, requestProjectId, requestPanelId)) {
          applyState(nextState);
        }
      } catch (err) {
        if (isRequestCurrent(requestVersion, requestProjectId, requestPanelId)) {
          applyInvokeError(err);
        }
      } finally {
        isEnsuringRef.current = false;
        const pendingConfig = pendingEnsureConfigRef.current;
        if (pendingConfig && pendingConfig !== configKey) {
          pendingEnsureConfigRef.current = null;
          void ensureLatestConfig(pendingConfig);
        } else if (pendingConfig === configKey) {
          pendingEnsureConfigRef.current = null;
        }
      }
    },
    [applyInvokeError, applyState, isRequestCurrent]
  );

  const start = useCallback(async () => {
    const latest = latestContextRef.current;
    if (!latest.projectId) {
      applyInvokeError(new Error("No active project"));
      return;
    }
    if (!latest.devCommand.trim()) {
      applyInvokeError(new Error("No dev command configured"));
      return;
    }

    const configKey = buildEnsureConfigKey({
      projectId: latest.projectId,
      panelId: latest.panelId,
      cwd: latest.cwd,
      worktreeId: latest.worktreeId,
      devCommand: latest.devCommand,
      envSignature: serializeEnv(latest.env),
    });
    await ensureLatestConfig(configKey);
  }, [applyInvokeError, ensureLatestConfig]);

  const stop = useCallback(() => {
    const latest = latestContextRef.current;
    if (!latest.projectId) return;
    const requestVersion = requestVersionRef.current;
    const requestProjectId = latest.projectId;
    const requestPanelId = latest.panelId;
    void window.electron.devPreview
      .stop({ panelId: requestPanelId, projectId: requestProjectId })
      .then((state) => {
        if (isRequestCurrent(requestVersion, requestProjectId, requestPanelId)) {
          applyState(state);
        }
      })
      .catch((err) => {
        if (isRequestCurrent(requestVersion, requestProjectId, requestPanelId)) {
          applyInvokeError(err);
        }
      });
  }, [applyInvokeError, applyState, isRequestCurrent]);

  const restart = useCallback(async () => {
    const latest = latestContextRef.current;
    if (!latest.projectId) {
      applyInvokeError(new Error("No active project"));
      return;
    }

    const requestVersion = requestVersionRef.current;
    const requestProjectId = latest.projectId;
    const requestPanelId = latest.panelId;

    try {
      const nextState = await window.electron.devPreview.restart({
        panelId: requestPanelId,
        projectId: requestProjectId,
      });
      if (isRequestCurrent(requestVersion, requestProjectId, requestPanelId)) {
        applyState(nextState);
      }
    } catch (err) {
      if (isRequestCurrent(requestVersion, requestProjectId, requestPanelId)) {
        applyInvokeError(err);
      }
    }
  }, [applyInvokeError, applyState, isRequestCurrent]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    requestVersionRef.current += 1;
    autoRecoveryAttemptsRef.current = { starting: 0 };
  }, [panelId, currentProjectId, cwd, worktreeId, devCommand, envSignature]);

  useEffect(() => {
    if (!currentProjectId) {
      latestSessionRef.current = {
        status: "stopped",
        url: null,
        terminalId: null,
      };
      setStatus("stopped");
      setUrl(null);
      setTerminalId(null);
      setError(null);
      setIsRestarting(false);
      lastEnsureConfigRef.current = "";
      pendingEnsureConfigRef.current = null;
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
    if (devCommand.trim()) return;

    const requestVersion = requestVersionRef.current;
    const requestProjectId = currentProjectId;
    const requestPanelId = panelId;

    lastEnsureConfigRef.current = "";
    pendingEnsureConfigRef.current = null;
    void window.electron.devPreview
      .stop({ panelId: requestPanelId, projectId: requestProjectId })
      .then((state) => {
        if (isRequestCurrent(requestVersion, requestProjectId, requestPanelId)) {
          applyState(state);
        }
      })
      .catch((err) => {
        if (isRequestCurrent(requestVersion, requestProjectId, requestPanelId)) {
          applyInvokeError(err);
        }
      });
  }, [panelId, currentProjectId, devCommand, applyState, applyInvokeError, isRequestCurrent]);

  useEffect(() => {
    if (!currentProjectId) return;
    if (!devCommand.trim()) return;

    const configKey = buildEnsureConfigKey({
      projectId: currentProjectId,
      panelId,
      cwd,
      worktreeId,
      devCommand,
      envSignature,
    });

    if (lastEnsureConfigRef.current === configKey) return;
    void ensureLatestConfig(configKey);
  }, [panelId, currentProjectId, cwd, worktreeId, devCommand, envSignature, ensureLatestConfig]);

  useEffect(() => {
    if (status !== "starting") {
      autoRecoveryAttemptsRef.current = { starting: 0 };
      return;
    }
    if (!currentProjectId || !terminalId || url || isRestarting) return;
    const currentAttempts = autoRecoveryAttemptsRef.current[status];
    if (currentAttempts >= MAX_AUTO_RECOVERY_ATTEMPTS) return;

    const requestVersion = requestVersionRef.current;
    const requestProjectId = currentProjectId;
    const requestPanelId = panelId;
    const requestStatus = status;

    const timeout = window.setTimeout(() => {
      const latestContext = latestContextRef.current;
      const latestSession = latestSessionRef.current;

      if (!isMountedRef.current) return;
      if (autoRecoveryAttemptsRef.current[requestStatus] >= MAX_AUTO_RECOVERY_ATTEMPTS) return;
      if (requestVersion !== requestVersionRef.current) return;
      if (latestContext.projectId !== requestProjectId) return;
      if (latestContext.panelId !== requestPanelId) return;
      if (latestSession.status !== requestStatus || latestSession.url || !latestSession.terminalId)
        return;

      autoRecoveryAttemptsRef.current[requestStatus] += 1;
      void window.electron.devPreview
        .restart({ panelId: requestPanelId, projectId: requestProjectId })
        .then((nextState) => {
          if (isRequestCurrent(requestVersion, requestProjectId, requestPanelId)) {
            applyState(nextState);
          }
        })
        .catch((err) => {
          if (isRequestCurrent(requestVersion, requestProjectId, requestPanelId)) {
            applyInvokeError(err);
          }
        });
    }, STUCK_START_RECOVERY_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    panelId,
    currentProjectId,
    status,
    terminalId,
    url,
    isRestarting,
    applyState,
    applyInvokeError,
    isRequestCurrent,
  ]);

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
