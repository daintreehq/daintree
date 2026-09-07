import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useProjectStore } from "@/store/projectStore";
import type { DevServerError } from "../../shared/utils/devServerErrors";
import type { DevPreviewSessionState } from "../../shared/types/ipc/devPreview";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

export type DevPreviewStatus =
  "stopped" | "starting" | "installing" | "running" | "stopping" | "error" | "restored-stopped";

export interface UseDevServerOptions {
  panelId: string;
  devCommand: string;
  cwd: string;
  worktreeId?: string;
  env?: Record<string, string>;
  turbopackEnabled?: boolean;
}

export interface UseDevServerState {
  status: DevPreviewStatus;
  url: string | null;
  terminalId: string | null;
  error: DevServerError | null;
  phaseLabel?: "Compiling";
}

export interface UseDevServerReturn extends UseDevServerState {
  start: () => Promise<void>;
  stop: () => void;
  restart: () => Promise<void>;
  isRestarting: boolean;
  /**
   * Escalation level while the server is stuck in `starting`. 0 = not stuck,
   * 1 = ambient (6s), 2 = warning banner (20s), 3 = error banner (45s).
   * Resets to 0 whenever status leaves `starting`. Tier 2 is suppressed when
   * `phaseLabel === "Compiling"` — a confirmed compile in progress is not
   * "no signal," and Tier 3 still fires at 45s if the compile drags on.
   */
  stuckTier: DevServerStuckTier;
  forceKilled?: boolean;
  /**
   * True when the PTY-layer crash-loop guard halted auto-respawn after repeated
   * fast install→crash cycles. Pairs with `status === "stopped"` to surface a
   * recoverable banner; an explicit restart clears it.
   */
  crashLoopStopped?: boolean;
}

/**
 * Staged stuck-start escalation thresholds (#8276, retuned #9099). When the
 * dev server stays in `starting` past each threshold, `stuckTier` advances so
 * the UI can surface a progressively stronger, user-driven signal instead of
 * silently restarting (which wiped the logs explaining the stall). The
 * thresholds were rescaled in #9099 from 6/12/25s to 6/20/45s after measured
 * cold-start data (Vite cold monorepo 15–45s, Next.js webpack medium ~45s,
 * webpack enterprise 45–90s) showed the old values fired false alarms on
 * realistic projects. Tier 1 still sits past the 5s post-spawn URL poll
 * window so it never fires for fast-starting servers.
 */
const STUCK_TIER1_MS = 6000;
const STUCK_TIER2_MS = 20000;
const STUCK_TIER3_MS = 45000;

export type DevServerStuckTier = 0 | 1 | 2 | 3;

/**
 * Module-level cache that persists the last successful ensure configKey across
 * React unmount/remount cycles (e.g. dock ↔ grid transitions). Keyed by panelId.
 */
const persistedEnsureCache = new Map<string, string>();

export function _resetPersistedEnsureCacheForTests(): void {
  persistedEnsureCache.clear();
}

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
  turbopackEnabled?: boolean;
}): string {
  return [
    params.projectId,
    params.panelId,
    params.cwd,
    params.worktreeId ?? "",
    params.devCommand.trim(),
    params.envSignature,
    (params.turbopackEnabled ?? true) ? "turbo:on" : "turbo:off",
  ].join("|");
}

export function useDevServer({
  panelId,
  devCommand,
  cwd,
  worktreeId,
  env,
  turbopackEnabled,
}: UseDevServerOptions): UseDevServerReturn {
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const [status, setStatus] = useState<DevPreviewStatus>("stopped");
  const [url, setUrl] = useState<string | null>(null);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [error, setError] = useState<DevServerError | null>(null);
  const [phaseLabel, setPhaseLabel] = useState<"Compiling" | undefined>(undefined);
  const [isRestarting, setIsRestarting] = useState(false);
  // Gates the auto-ensure effect until the first getState() resolves so it acts
  // on the panel's real status rather than the synchronous-mount "stopped"
  // default. A "restored-stopped" panel then auto-starts intentionally (the dev
  // server comes back when the project reopens); the gate only guards against
  // ensuring twice — once on the stale default, once on the hydrated status.
  // Sticky: once true it stays true (restored-stopped only ever surfaces on the
  // initial launch).
  const [initialStateResolved, setInitialStateResolved] = useState(false);
  const [stuckTier, setStuckTier] = useState<DevServerStuckTier>(0);
  const [forceKilled, setForceKilled] = useState<boolean | undefined>(undefined);
  const [crashLoopStopped, setCrashLoopStopped] = useState<boolean | undefined>(undefined);
  const latestSessionRef = useRef<{
    status: DevPreviewStatus;
    url: string | null;
    terminalId: string | null;
    phaseLabel: "Compiling" | undefined;
  }>({
    status: "stopped",
    url: null,
    terminalId: null,
    phaseLabel: undefined,
  });
  const isMountedRef = useRef(true);
  const isEnsuringRef = useRef(false);
  const lastEnsureConfigRef = useRef<string>("");
  const pendingEnsureConfigRef = useRef<string | null>(null);
  const requestVersionRef = useRef(0);

  const latestContextRef = useRef<{
    panelId: string;
    projectId: string | null;
    cwd: string;
    worktreeId?: string;
    devCommand: string;
    env?: Record<string, string>;
    turbopackEnabled?: boolean;
  }>({
    panelId,
    projectId: currentProjectId,
    cwd,
    worktreeId,
    devCommand,
    env,
    turbopackEnabled,
  });

  const envSignature = useMemo(() => serializeEnv(env), [env]);

  latestContextRef.current = {
    panelId,
    projectId: currentProjectId,
    cwd,
    worktreeId,
    devCommand,
    env,
    turbopackEnabled,
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
      phaseLabel: state.phaseLabel,
    };
    setStatus(state.status);
    setUrl(state.url);
    setTerminalId(state.terminalId);
    setError(state.error ?? null);
    setPhaseLabel(state.phaseLabel);
    setIsRestarting(state.isRestarting);
    setForceKilled(state.forceKilled);
    setCrashLoopStopped(state.crashLoopStopped);
  }, []);

  const applyInvokeError = useCallback((err: unknown) => {
    if (!isMountedRef.current) return;
    // IPC rejections are opaque — formatErrorMessage produces a user-facing
    // string; if the main process ever sends structured DevServerError rejects,
    // this path would need deserialization to preserve type/port/module.
    const message = formatErrorMessage(err, "Dev server request failed");
    latestSessionRef.current = {
      status: "error",
      url: null,
      terminalId: null,
      phaseLabel: undefined,
    };
    setStatus("error");
    setError({ type: "unknown", message });
    setTerminalId(null);
    setPhaseLabel(undefined);
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
          turbopackEnabled: latest.turbopackEnabled,
        });

        if (isRequestCurrent(requestVersion, requestProjectId, requestPanelId)) {
          applyState(nextState);
          persistedEnsureCache.set(requestPanelId, configKey);
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
          safeFireAndForget(ensureLatestConfig(pendingConfig), {
            context: "Re-running queued dev preview ensure",
          });
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
      turbopackEnabled: latest.turbopackEnabled,
    });
    await ensureLatestConfig(configKey);
  }, [applyInvokeError, ensureLatestConfig]);

  const stop = useCallback(() => {
    const latest = latestContextRef.current;
    if (!latest.projectId) return;
    persistedEnsureCache.delete(latest.panelId);
    lastEnsureConfigRef.current = "";
    const requestVersion = requestVersionRef.current;
    const requestProjectId = latest.projectId;
    const requestPanelId = latest.panelId;
    // Rejection routes to applyInvokeError (UI-state recovery) — no
    // safeFireAndForget needed; the .catch terminates the chain.
    window.electron.devPreview
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

    persistedEnsureCache.delete(latest.panelId);
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
  }, [panelId, currentProjectId, cwd, worktreeId, devCommand, envSignature, turbopackEnabled]);

  useEffect(() => {
    if (!currentProjectId) {
      latestSessionRef.current = {
        status: "stopped",
        url: null,
        terminalId: null,
        phaseLabel: undefined,
      };
      setStatus("stopped");
      setUrl(null);
      setTerminalId(null);
      setError(null);
      setPhaseLabel(undefined);
      setIsRestarting(false);
      lastEnsureConfigRef.current = "";
      pendingEnsureConfigRef.current = null;
      persistedEnsureCache.delete(panelId);
      setInitialStateResolved(true);
      return;
    }

    let cancelled = false;
    window.electron.devPreview
      .getState({ panelId, projectId: currentProjectId })
      .then((state) => {
        if (!cancelled) applyState(state);
      })
      .catch((err) => {
        if (!cancelled) applyInvokeError(err);
      })
      .finally(() => {
        if (!cancelled) setInitialStateResolved(true);
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
      if (
        state.status === "error" ||
        state.status === "stopped" ||
        state.status === "restored-stopped"
      ) {
        persistedEnsureCache.delete(panelId);
      }
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
    persistedEnsureCache.delete(panelId);
    window.electron.devPreview
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
    // Wait for the first getState() to resolve before auto-spawning so this
    // effect reconciles to the panel's real status before deciding to ensure(),
    // rather than firing on the synchronous mount with the stale "stopped"
    // default. A "restored-stopped" panel (dev server was running when Daintree
    // closed) then auto-starts like any other dev preview — reopening a project,
    // whether by cold launch or live switch, brings its dev server back.
    if (!initialStateResolved) return;

    const configKey = buildEnsureConfigKey({
      projectId: currentProjectId,
      panelId,
      cwd,
      worktreeId,
      devCommand,
      envSignature,
      turbopackEnabled,
    });

    if (lastEnsureConfigRef.current === configKey) return;

    // Cross-remount guard: skip ensure() if a previous mount already ensured
    // this exact config. The onStateChanged subscription handles crash propagation
    // independently, and getState() hydrates current state on mount.
    const cachedKey = persistedEnsureCache.get(panelId);
    if (cachedKey === configKey) {
      lastEnsureConfigRef.current = configKey;
      return;
    }

    safeFireAndForget(ensureLatestConfig(configKey), {
      context: "Ensuring dev preview config matches latest",
    });
  }, [
    panelId,
    currentProjectId,
    cwd,
    worktreeId,
    devCommand,
    envSignature,
    turbopackEnabled,
    ensureLatestConfig,
    initialStateResolved,
  ]);

  // Staged stuck-start escalation (#8276, retuned #9099). Replaces the
  // old silent auto-restart: instead of firing `devPreview.restart()`
  // once at 10s (which wiped the logs explaining the stall), we advance
  // `stuckTier` at 6s/20s/45s so the UI can surface a user-driven signal.
  // The user now drives any recovery explicitly via the banner actions.
  useEffect(() => {
    if (status !== "starting" || !currentProjectId || !terminalId || url || isRestarting) {
      // `installing` and every other non-starting state falls through here,
      // which keeps banners suppressed during long first-run installs.
      setStuckTier(0);
      return;
    }

    const requestVersion = requestVersionRef.current;
    const requestProjectId = currentProjectId;
    const requestPanelId = panelId;

    const advanceTier = (tier: DevServerStuckTier) => {
      const latestContext = latestContextRef.current;
      const latestSession = latestSessionRef.current;

      if (!isMountedRef.current) return;
      if (requestVersion !== requestVersionRef.current) return;
      if (latestContext.projectId !== requestProjectId) return;
      if (latestContext.panelId !== requestPanelId) return;
      if (latestSession.status !== "starting" || latestSession.url || !latestSession.terminalId)
        return;
      // #9099: Tier 2 means "no signal yet" — once the backend has emitted
      // `phaseLabel === "Compiling"`, that IS a signal, so suppress the
      // warning banner. Tier 3 still fires at 45s even mid-compile because
      // a 45s compile is itself worth surfacing.
      if (tier === 2 && latestSession.phaseLabel === "Compiling") return;

      setStuckTier((prev) => (tier > prev ? tier : prev));
    };

    const timers = [
      window.setTimeout(() => advanceTier(1), STUCK_TIER1_MS),
      window.setTimeout(() => advanceTier(2), STUCK_TIER2_MS),
      window.setTimeout(() => advanceTier(3), STUCK_TIER3_MS),
    ];

    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [panelId, currentProjectId, status, terminalId, url, isRestarting]);

  // When the backend signals a compile is in progress, downgrade any
  // existing Tier 2 "no signal yet" banner to Tier 1 (benign pulse). The
  // compile IS the signal — the user doesn't need both warnings.
  // Kept in a separate effect so timer starts from the main effect aren't
  // reset when phaseLabel toggles (Tier 3 at 45s must still fire).
  useEffect(() => {
    if (phaseLabel === "Compiling") {
      // Only Tier 2 downgrades. Tier 3 means the server has been starting for
      // 45s, which a compile signal explains but does not excuse — collapsing
      // it to Tier 1 here erased the warning the main effect had just raised.
      setStuckTier((prev) => (prev === 2 ? 1 : prev));
    }
  }, [phaseLabel]);

  return {
    status,
    url,
    terminalId,
    error,
    phaseLabel,
    start,
    stop,
    restart,
    isRestarting,
    stuckTier,
    forceKilled,
    crashLoopStopped,
  };
}
