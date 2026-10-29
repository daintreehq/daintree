import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useProjectStore } from "@/store/projectStore";
import type { DevServerError } from "../../shared/utils/devServerErrors";
import type { DevPreviewSessionState } from "../../shared/types/ipc/devPreview";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { onHostResync } from "@/store/hostResyncSignal";
import { onDevPreviewResume } from "@/store/devPreviewResumeSignal";

export type DevPreviewStatus =
  "stopped" | "starting" | "installing" | "running" | "stopping" | "error" | "restored-stopped";

export interface UseDevServerOptions {
  panelId: string;
  devCommand: string;
  cwd: string;
  worktreeId?: string;
  env?: Record<string, string>;
  turbopackEnabled?: boolean;
  /**
   * Set (even to null) for a panel that previews the worktree's resource
   * endpoint instead of running devCommand (#13688); null while no endpoint is
   * ready. Undefined keeps the panel on its dev command.
   */
  endpoint?: string | null;
  /**
   * Endpoint panels only: cycles the resource and reports its fresh endpoint.
   * Restart runs it first because neither pause nor resume refreshes it.
   */
  refreshEndpoint?: () => Promise<string | null>;
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
  /**
   * True while an endpoint restart is cycling its resource (#13688). Unlike a
   * backend restart this one can still be called off, so Stop stays usable.
   */
  isCyclingEndpoint: boolean;
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

// Module scope, not the hook: a panel in a worktree that isn't on screen has no
// mounted hook to hear the resume, and its cached key would otherwise skip the
// ensure on its next mount even though Main dropped the session (#15002).
const offDevPreviewResume = onDevPreviewResume(({ panelIds }) => {
  for (const panelId of panelIds) persistedEnsureCache.delete(panelId);
});

if (import.meta.hot) {
  import.meta.hot.dispose(offDevPreviewResume);
}

function serializeEnv(env?: Record<string, string>): string {
  if (!env) return "";
  return Object.keys(env)
    .sort()
    .map((key) => `${key}\u0000${env[key]}`)
    .join("\u0001");
}

/** What the panel launches: its endpoint in endpoint mode, else its dev command. Empty means nothing. */
function launchTarget(devCommand: string, endpoint: string | null | undefined): string {
  return endpoint === undefined ? devCommand.trim() : (endpoint?.trim() ?? "");
}

function buildEnsureConfigKey(params: {
  projectId: string;
  panelId: string;
  cwd: string;
  worktreeId?: string;
  devCommand: string;
  endpoint?: string | null;
  envSignature: string;
  turbopackEnabled?: boolean;
}): string {
  return [
    params.projectId,
    params.panelId,
    params.cwd,
    params.worktreeId ?? "",
    params.endpoint === undefined ? "" : `endpoint:${params.endpoint ?? ""}`,
    params.devCommand.trim(),
    params.envSignature,
    (params.turbopackEnabled ?? true) ? "turbo:on" : "turbo:off",
  ].join("|");
}

/** The key of the config an ensure sends from this context; null without a project. */
function ensureKeyFor(context: {
  projectId: string | null;
  panelId: string;
  cwd: string;
  worktreeId?: string;
  devCommand: string;
  endpoint?: string | null;
  env?: Record<string, string>;
  turbopackEnabled?: boolean;
}): string | null {
  if (!context.projectId) return null;
  return buildEnsureConfigKey({
    projectId: context.projectId,
    panelId: context.panelId,
    cwd: context.cwd,
    worktreeId: context.worktreeId,
    devCommand: context.devCommand,
    endpoint: context.endpoint,
    envSignature: serializeEnv(context.env),
    turbopackEnabled: context.turbopackEnabled,
  });
}

export function useDevServer({
  panelId,
  devCommand,
  cwd,
  worktreeId,
  env,
  turbopackEnabled,
  endpoint,
  refreshEndpoint,
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
  /** State changes heard for this panel, so a host resync's answer can tell it was overtaken. */
  const stateEventsRef = useRef(0);
  /** The latest host resync's ask; an older one's answer is dropped. */
  const resyncAskRef = useRef(0);
  const lastEnsureConfigRef = useRef<string>("");
  const pendingEnsureRef = useRef<{ resume: boolean; force: boolean } | null>(null);
  /** Callers of forced ensures queued behind the one in flight, settled once theirs has gone out or been called off. */
  const queuedForceWaitersRef = useRef<Array<() => void>>([]);
  const userStoppedRef = useRef(false);
  // Bumped by every endpoint restart and every Stop. A restart whose resource
  // cycle finishes after its number moved on was superseded and must not connect.
  const endpointCycleRef = useRef(0);
  const endpointCyclingRef = useRef(false);
  const [isCyclingEndpoint, setIsCyclingEndpoint] = useState(false);
  const requestVersionRef = useRef(0);

  const latestContextRef = useRef<{
    panelId: string;
    projectId: string | null;
    cwd: string;
    worktreeId?: string;
    devCommand: string;
    endpoint?: string | null;
    refreshEndpoint?: () => Promise<string | null>;
    env?: Record<string, string>;
    turbopackEnabled?: boolean;
  }>({
    panelId,
    projectId: currentProjectId,
    cwd,
    worktreeId,
    devCommand,
    endpoint,
    refreshEndpoint,
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
    endpoint,
    refreshEndpoint,
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
    userStoppedRef.current = state.userStopped === true;
    // A Stop from outside this panel (palette, worktree menu) reaches it only as
    // state; it still calls off an endpoint restart waiting on its resource.
    if (userStoppedRef.current && endpointCyclingRef.current) {
      endpointCycleRef.current += 1;
      endpointCyclingRef.current = false;
      setIsCyclingEndpoint(false);
    }
    setStatus(state.status);
    setUrl(state.url);
    setTerminalId(state.terminalId);
    setError(state.error ?? null);
    setPhaseLabel(state.phaseLabel);
    setIsRestarting(state.isRestarting || endpointCyclingRef.current);
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

  // `resume` marks an explicit Start: only that may lift a user Stop in Main.
  // Automatic ensures (mount, remount, config edits) leave a stopped panel
  // stopped, so a queued Start keeps its resume through later config changes
  // and always drains; only a Stop cancels it. `force` re-sends an unchanged
  // config without lifting a user Stop, for a server Main dropped behind the
  // panel's back (#15002). A forced call that queues still resolves only once
  // its ensure has gone out, so a worktree delete retried meanwhile can't stop
  // the server before the restart reaches Main.
  const ensureLatestConfig = useCallback(
    async (resume = false, force = false): Promise<void> => {
      if (isEnsuringRef.current) {
        pendingEnsureRef.current = {
          resume: resume || (pendingEnsureRef.current?.resume ?? false),
          force: force || (pendingEnsureRef.current?.force ?? false),
        };
        if (!force) return;
        return new Promise<void>((resolve) => {
          queuedForceWaitersRef.current.push(resolve);
        });
      }

      const latest = latestContextRef.current;
      const requestProjectId = latest.projectId;
      const sentKey = ensureKeyFor(latest);
      if (!requestProjectId || !sentKey) return;

      if (!launchTarget(latest.devCommand, latest.endpoint)) return;
      const endpointMode = latest.endpoint !== undefined;

      const requestPanelId = latest.panelId;
      const requestVersion = requestVersionRef.current;

      isEnsuringRef.current = true;
      lastEnsureConfigRef.current = sentKey;
      // Nothing is settled until this lands, so switching back to the last
      // settled config mid-ensure queues instead of hitting the cache.
      persistedEnsureCache.delete(requestPanelId);

      try {
        const nextState = await window.electron.devPreview.ensure({
          panelId: requestPanelId,
          projectId: requestProjectId,
          cwd: latest.cwd,
          devCommand: endpointMode ? "" : latest.devCommand,
          ...(endpointMode && latest.endpoint ? { endpoint: latest.endpoint.trim() } : {}),
          worktreeId: latest.worktreeId,
          env: latest.env,
          turbopackEnabled: latest.turbopackEnabled,
          ...(resume && { resumeUserStopped: true }),
        });

        if (isRequestCurrent(requestVersion, requestProjectId, requestPanelId)) {
          applyState(nextState);
          persistedEnsureCache.set(requestPanelId, sentKey);
        }
      } catch (err) {
        if (isRequestCurrent(requestVersion, requestProjectId, requestPanelId)) {
          applyInvokeError(err);
        }
      } finally {
        isEnsuringRef.current = false;
        const pending = pendingEnsureRef.current;
        pendingEnsureRef.current = null;
        const forceWaiters = queuedForceWaitersRef.current;
        queuedForceWaitersRef.current = [];
        const settleForceWaiters = () => {
          for (const settle of forceWaiters) settle();
        };
        // Drain against the config as it is now, not as it was when queued: a
        // switch away and back mid-ensure leaves nothing new to send. An
        // unmounted hook leaves config catch-up to whichever mount replaced it,
        // but still delivers a Start the user clicked.
        const drains = pending !== null && (isMountedRef.current || pending.resume);
        const nextKey = drains ? ensureKeyFor(latestContextRef.current) : null;
        if (pending && nextKey && (nextKey !== sentKey || pending.resume || pending.force)) {
          safeFireAndForget(
            ensureLatestConfig(pending.resume, pending.force).finally(settleForceWaiters),
            { context: "Re-running queued dev preview ensure" }
          );
        } else {
          settleForceWaiters();
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
    if (!launchTarget(latest.devCommand, latest.endpoint)) {
      applyInvokeError(
        new Error(
          latest.endpoint === undefined
            ? "No dev command configured"
            : "The resource environment has no ready endpoint"
        )
      );
      return;
    }

    await ensureLatestConfig(true);
  }, [applyInvokeError, ensureLatestConfig]);

  const stop = useCallback(() => {
    const latest = latestContextRef.current;
    if (!latest.projectId) return;
    persistedEnsureCache.delete(latest.panelId);
    lastEnsureConfigRef.current = "";
    // A Start queued behind an in-flight ensure must not resume after this Stop,
    // nor an endpoint restart still cycling its resource.
    pendingEnsureRef.current = null;
    endpointCycleRef.current += 1;
    endpointCyclingRef.current = false;
    setIsCyclingEndpoint(false);
    setIsRestarting(false);
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

    // A resource endpoint is restarted through the resource, and neither pause
    // nor resume refreshes the endpoint: cycle it, take the fresh endpoint from
    // its status, and reconnect to that (#13688).
    if (latest.endpoint !== undefined && latest.refreshEndpoint) {
      if (endpointCyclingRef.current) return;
      const cycle = ++endpointCycleRef.current;
      endpointCyclingRef.current = true;
      setIsCyclingEndpoint(true);
      setIsRestarting(true);
      let fresh: string | null;
      try {
        fresh = await latest.refreshEndpoint();
      } catch (err) {
        if (cycle === endpointCycleRef.current) applyInvokeError(err);
        return;
      } finally {
        if (cycle === endpointCycleRef.current) {
          endpointCyclingRef.current = false;
          if (isMountedRef.current) {
            setIsCyclingEndpoint(false);
            setIsRestarting(false);
          }
        }
      }
      if (!isMountedRef.current || cycle !== endpointCycleRef.current) return;
      latestContextRef.current = { ...latestContextRef.current, endpoint: fresh };
      persistedEnsureCache.delete(latest.panelId);
      await start();
      return;
    }

    // Main still holds the config from before the Stop (automatic ensures were
    // refused since), so a restart would relaunch stale settings — start with
    // the current ones instead.
    if (userStoppedRef.current) {
      await start();
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
  }, [applyInvokeError, applyState, isRequestCurrent, start]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    requestVersionRef.current += 1;
  }, [
    panelId,
    currentProjectId,
    cwd,
    worktreeId,
    devCommand,
    endpoint,
    envSignature,
    turbopackEnabled,
  ]);

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
      pendingEnsureRef.current = null;
      userStoppedRef.current = false;
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

  // A state change sent while the link to the host was down is lost: ask again
  // once it's back. Only the latest ask applies, and only if no state change
  // for this panel arrived while it was out: that one is newer than the answer.
  useEffect(() => {
    if (!currentProjectId) return;
    let live = true;
    const off = onHostResync(() => {
      const ask = ++resyncAskRef.current;
      const eventsBefore = stateEventsRef.current;
      window.electron.devPreview.getState({ panelId, projectId: currentProjectId }).then(
        (state) => {
          if (!live || ask !== resyncAskRef.current) return;
          if (stateEventsRef.current !== eventsBefore) return;
          applyState(state);
        },
        () => {}
      );
    });
    return () => {
      live = false;
      off();
    };
  }, [panelId, currentProjectId, applyState]);

  useEffect(() => {
    if (!currentProjectId) return;
    return window.electron.devPreview.onStateChanged((payload) => {
      const { state } = payload;
      if (state.panelId !== panelId) return;
      if (state.projectId !== currentProjectId) return;
      stateEventsRef.current += 1;
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

  // A worktree delete stopped this panel's server and was then abandoned, so
  // the worktree is still here (#15002). Main dropped the session and the
  // config hasn't changed, so the auto-start below won't fire again by itself.
  // Not a Start: a Stop the user made since still holds in Main.
  useEffect(() => {
    if (!currentProjectId) return;
    return onDevPreviewResume(({ worktreeId: resumedWorktreeId, panelIds }) => {
      if (!panelIds.has(panelId)) return;
      if (latestContextRef.current.worktreeId !== resumedWorktreeId) return;
      // An endpoint restart reconnects by itself once its resource cycle ends.
      if (endpointCyclingRef.current) return;
      return ensureLatestConfig(false, true);
    });
  }, [panelId, currentProjectId, ensureLatestConfig]);

  const target = launchTarget(devCommand, endpoint);

  useEffect(() => {
    if (!currentProjectId) return;
    if (target) return;

    const requestVersion = requestVersionRef.current;
    const requestProjectId = currentProjectId;
    const requestPanelId = panelId;

    lastEnsureConfigRef.current = "";
    pendingEnsureRef.current = null;
    persistedEnsureCache.delete(panelId);
    window.electron.devPreview
      .stop({ panelId: requestPanelId, projectId: requestProjectId, reason: "configuration" })
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
  }, [panelId, currentProjectId, target, applyState, applyInvokeError, isRequestCurrent]);

  useEffect(() => {
    if (!currentProjectId) return;
    if (!target) return;
    // Wait for the first getState() to resolve before auto-spawning so this
    // effect reconciles to the panel's real status before deciding to ensure(),
    // rather than firing on the synchronous mount with the stale "stopped"
    // default. A "restored-stopped" panel (dev server was running when Daintree
    // closed) then auto-starts like any other dev preview — reopening a project,
    // whether by cold launch or live switch, brings its dev server back. A panel
    // the user stopped is not: Main refuses this (non-resume) ensure (#13169).
    if (!initialStateResolved) return;
    // An endpoint restart is mid-cycle: the endpoint it reconnects to comes from its
    // own fresh status check, not from whatever the store reported on the way.
    if (endpointCyclingRef.current) return;

    const configKey = buildEnsureConfigKey({
      projectId: currentProjectId,
      panelId,
      cwd,
      worktreeId,
      devCommand,
      endpoint,
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

    safeFireAndForget(ensureLatestConfig(), {
      context: "Ensuring dev preview config matches latest",
    });
  }, [
    panelId,
    currentProjectId,
    cwd,
    worktreeId,
    devCommand,
    endpoint,
    target,
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
    isCyclingEndpoint,
  };
}
