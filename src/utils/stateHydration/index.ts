import { appClient, terminalClient, worktreeClient, projectClient, systemClient } from "@/clients";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { suppressMruRecording } from "@/store/worktreeStore";
import { useLayoutConfigStore } from "@/store";
import type {
  AgentState,
  PanelKind,
  PanelSnapshot,
  TerminalReconnectError,
  TabGroup,
} from "@/types";
import type { ActionFrecencyEntry } from "@shared/types/actions";
import { panelPersistence } from "@/store/persistence/panelPersistence";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { logDebug, logInfo, logWarn, logError } from "@/utils/logger";
import { PERF_MARKS } from "@shared/perf/marks";
import {
  markRendererPerformance,
  withRendererSpan,
  isRendererPerfCaptureEnabled,
  RENDERER_T0,
} from "@/utils/performance";
import { isDaintreeEnvEnabled } from "@/utils/env";
import { useSafeModeStore } from "@/store/safeModeStore";
import type { AgentPreset } from "@/config/agents";
import { splitSnapshotRestoreTasks } from "./batchScheduler";
import type { HydrationBatchToken } from "@/store/slices/panelRegistry/types";
import { normalizeAndApplyScrollback } from "./scrollbackConfig";
import { ensureHydrationBootstrap } from "./bootstrapGuard";
import { dispatchRecoveryNotifications } from "./recoveryNotifications";
import { scheduleScrollbackRestore } from "./scrollbackRestoreScheduler";
import { restorePanelsPhase } from "./panelRestorePhase";

const CLIPBOARD_DIR_NAME = "daintree-clipboard";
const VERBOSE_HYDRATION_LOGGING = isDaintreeEnvEnabled("DAINTREE_VERBOSE");

function logHydrationInfo(message: string, context?: Record<string, unknown>): void {
  if (!VERBOSE_HYDRATION_LOGGING) return;
  logInfo(message, context);
}

export interface HydrationOptions {
  addPanel: (options: {
    kind?: PanelKind;
    launchAgentId?: string;
    title?: string;
    cwd: string;
    worktreeId?: string;
    location?: "grid" | "dock";
    command?: string;
    agentState?: AgentState;
    lastStateChange?: number;
    existingId?: string; // Pass to reconnect to existing backend process
    requestedId?: string; // Pass to spawn with a stable ID
    skipCommandExecution?: boolean; // Store command but don't execute on spawn
    isInputLocked?: boolean; // Restore input lock state
    browserUrl?: string; // URL for browser panes
    browserHistory?: import("@shared/types/browser").BrowserHistory;
    browserZoom?: number;
    devCommand?: string; // Dev command override for dev-preview panels
    devServerStatus?: "stopped" | "starting" | "installing" | "running" | "error";
    devServerUrl?: string | null;
    devServerError?: { type: string; message: string } | null;
    devServerTerminalId?: string | null;
    browserConsoleOpen?: boolean;
    devPreviewConsoleOpen?: boolean;
    exitBehavior?: import("@shared/types/panel").PanelExitBehavior;
    agentSessionId?: string;
    agentLaunchFlags?: string[];
    agentModelId?: string;
    agentPresetId?: string;
    agentPresetColor?: string;
    originalPresetId?: string;
    isUsingFallback?: boolean;
    fallbackChainIndex?: number;
    env?: Record<string, string>;
    extensionState?: Record<string, unknown>;
    pluginId?: string;
    restore?: boolean;
    bypassLimits?: boolean;
  }) => Promise<string>;
  setActiveWorktree: (id: string | null) => void;
  loadRecipes: (projectId: string) => Promise<void>;
  openDiagnosticsDock: (tab?: "problems" | "logs" | "events") => void;
  setFocusMode?: (
    focusMode: boolean,
    focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean }
  ) => void;
  setReconnectError?: (id: string, error: TerminalReconnectError) => void;
  hydrateTabGroups?: (tabGroups: TabGroup[], options?: { skipPersist?: boolean }) => void;
  hydrateMru?: (list: string[]) => void;
  hydrateActionMru?: (list: ActionFrecencyEntry[] | string[]) => void;
  restoreTerminalOrder?: (orderedIds: string[]) => void;
  /**
   * Optional hydration-batch hooks. When both are provided, each restore phase is
   * wrapped in a begin/flush pair so the N `addPanel` mutations within the phase
   * collapse into a single store commit. Leaving them undefined keeps the legacy
   * per-panel commit behavior (tests and callers that don't care about render
   * reduction don't need to pass these).
   */
  beginHydrationBatch?: () => HydrationBatchToken;
  flushHydrationBatch?: (token: HydrationBatchToken) => void;
}

export async function hydrateAppState(
  options: HydrationOptions,
  _switchId?: string,
  isCurrent?: () => boolean,
  prefetchedHydrateResult?: import("@shared/types/ipc/app").HydrateResult
): Promise<void> {
  const {
    addPanel,
    setActiveWorktree,
    loadRecipes,
    openDiagnosticsDock,
    beginHydrationBatch,
    flushHydrationBatch,
  } = options;
  const hydrationStartedAt = Date.now();

  /**
   * Wrap a restore phase in a hydration batch so every `addPanel` call inside `run`
   * collapses into a single store commit when the phase completes. If the caller
   * didn't wire the batch hooks (e.g. tests), fall through to the legacy per-panel
   * commit behavior.
   */
  const withHydrationBatch = async (run: () => Promise<void>): Promise<void> => {
    if (!beginHydrationBatch || !flushHydrationBatch) {
      await run();
      return;
    }
    const token = beginHydrationBatch();
    try {
      await run();
    } finally {
      flushHydrationBatch(token);
    }
  };
  let panelRestoreStartedAt: number | null = null;
  let panelRestoreCount = 0;
  let tabGroupRestoreCount = 0;

  markRendererPerformance(PERF_MARKS.HYDRATE_START, {
    switchId: _switchId ?? null,
  });

  // Helper to check if this hydration is still current (not superseded by newer switch)
  const checkCurrent = (): boolean => {
    if (!isCurrent) return true;
    return isCurrent();
  };

  suppressMruRecording(true);
  try {
    await withRendererSpan(PERF_MARKS.HYDRATE_BOOTSTRAP, () => ensureHydrationBootstrap(), {
      switchId: _switchId ?? null,
    });
    if (!checkCurrent()) return;

    // Use pre-fetched hydration data from the project switch payload when available,
    // eliminating a ~50-150ms IPC round-trip. Fall back to the IPC pull model for
    // initial app load or when the switch payload didn't include hydration data.
    const [hydrateResult, tmpDir] = await Promise.all([
      prefetchedHydrateResult
        ? Promise.resolve(prefetchedHydrateResult)
        : withRendererSpan(PERF_MARKS.HYDRATE_APP_CLIENT, () => appClient.hydrate(), {
            switchId: _switchId ?? null,
          }),
      systemClient.getTmpDir().catch(() => ""),
    ]);
    const {
      appState,
      terminalConfig,
      project: currentProject,
      agentSettings,
      gpuWebGLHardware,
    } = hydrateResult;
    const clipboardDirectory = tmpDir ? `${tmpDir}/${CLIPBOARD_DIR_NAME}` : undefined;
    if (!checkCurrent()) return;

    terminalInstanceService.setGPUHardwareAvailable(gpuWebGLHardware ?? true);

    if (hydrateResult.safeMode) {
      useSafeModeStore.getState().setSafeMode(true, {
        crashCount: hydrateResult.crashCount,
        skippedPanelCount: hydrateResult.skippedPanelCount,
        lastCrashAt: hydrateResult.lastCrashAt,
      });
    } else {
      // Clear stale state when the main process has exited safe mode
      // (e.g. stability timer fired or user restarted normally).
      useSafeModeStore.getState().setSafeMode(false);
    }

    dispatchRecoveryNotifications(hydrateResult);

    normalizeAndApplyScrollback(terminalConfig, logHydrationInfo);

    if (!appState) {
      logWarn("App state returned undefined during hydration, using defaults");
      return;
    }

    // Discover running terminals from the backend
    // Terminals stay running across project switches - we just reconnect to them
    const currentProjectId = currentProject?.id;
    const projectRoot = currentProject?.path;
    const shouldDeferSnapshotRestore = Boolean(_switchId);

    const worktreesPromise = worktreeClient.getAll().catch((error) => {
      logWarn("Failed to prefetch worktrees during hydration", { error });
      return null;
    });

    const tabGroupsPromise =
      currentProjectId && options.hydrateTabGroups
        ? projectClient
            .getTabGroups(currentProjectId)
            .then((tabGroups) => tabGroups ?? [])
            .catch((error) => {
              logWarn("Failed to prefetch tab groups", { error });
              return null;
            })
        : null;

    type TerminalSizeMap = Record<string, { cols: number; rows: number }>;
    const emptyTerminalSizes: TerminalSizeMap = {};
    const terminalSizesPromise: Promise<TerminalSizeMap> = currentProjectId
      ? projectClient
          .getTerminalSizes(currentProjectId)
          .then((sizes) => sizes ?? emptyTerminalSizes)
          .catch((error) => {
            logWarn("Failed to prefetch terminal sizes", { error });
            return emptyTerminalSizes;
          })
      : Promise.resolve(emptyTerminalSizes);

    const emptyDraftInputs: Record<string, string> = {};
    const draftInputsPromise: Promise<Record<string, string>> = currentProjectId
      ? projectClient
          .getDraftInputs(currentProjectId)
          .then((drafts) => drafts ?? emptyDraftInputs)
          .catch((error) => {
            logWarn("Failed to prefetch draft inputs", { error });
            return emptyDraftInputs;
          })
      : Promise.resolve(emptyDraftInputs);

    const emptyProjectPresets: Record<string, AgentPreset[]> = {};
    const projectPresetsPromise: Promise<Record<string, AgentPreset[]>> =
      currentProjectId && typeof projectClient.getInRepoPresets === "function"
        ? projectClient.getInRepoPresets(currentProjectId).catch((error) => {
            logWarn("Failed to prefetch project presets during hydration", { error });
            return emptyProjectPresets;
          })
        : Promise.resolve(emptyProjectPresets);

    const recipeLoadPromise = currentProjectId
      ? loadRecipes(currentProjectId).catch((error) => {
          logWarn("Failed to load recipes", { error });
        })
      : null;

    // Restore hybrid input bar draft inputs BEFORE terminal panels are created,
    // so HybridInputBar components pick up drafts from the store at mount time.
    if (currentProjectId) {
      try {
        const draftInputs = await draftInputsPromise;
        if (!checkCurrent()) return;
        if (Object.keys(draftInputs).length > 0) {
          useTerminalInputStore.getState().restoreProjectDraftInputs(currentProjectId, draftInputs);
        }
      } catch (error) {
        logWarn("Failed to restore draft inputs", { error });
      }
    }

    if (currentProjectId) {
      try {
        const backendTerminals = await withRendererSpan(
          PERF_MARKS.HYDRATE_GET_TERMINALS,
          () => terminalClient.getForProject(currentProjectId),
          { switchId: _switchId ?? null }
        );
        if (!checkCurrent()) return;

        logHydrationInfo(
          `Found ${backendTerminals.length} running terminals for project ${currentProjectId}`
        );

        if (isDaintreeEnvEnabled("DAINTREE_VERBOSE")) {
          logDebug(`Project: ${currentProjectId.slice(0, 8)}`);
          logDebug("Backend terminals", {
            terminals: backendTerminals.map((t) => ({
              id: t.id.slice(0, 8),
              kind: t.kind,
              agentId: t.launchAgentId,
              projectId: t.projectId?.slice(0, 8),
            })),
          });
        }

        // Build a map of backend terminals by ID for quick lookup
        const backendTerminalMap = new Map(backendTerminals.map((t) => [t.id, t]));

        // Fetch terminal sizes for restoration
        const terminalSizes = await terminalSizesPromise;
        if (!checkCurrent()) return;

        const activeWorktreeId = appState.activeWorktreeId ?? null;
        const projectPresetsByAgent = await projectPresetsPromise;
        if (!checkCurrent()) return;

        // Seed the persistence cache so the first save after launch can
        // preserve kind-specific fields for unregistered kinds (e.g., an
        // extension that hasn't re-registered yet). Without this priming,
        // a first save cycle would drop those fields — see issue #5201.
        // appState.terminals is TerminalState[] (IPC wire type, more
        // lenient); the on-disk data was written by panelToSnapshot so is
        // structurally PanelSnapshot[].
        if (currentProjectId && appState.terminals && appState.terminals.length > 0) {
          panelPersistence.primeProject(
            currentProjectId,
            appState.terminals as unknown as PanelSnapshot[]
          );
        }

        if (appState.terminals && appState.terminals.length > 0) {
          panelRestoreStartedAt = Date.now();
          panelRestoreCount = appState.terminals.length;
          markRendererPerformance(PERF_MARKS.HYDRATE_RESTORE_PANELS_START, {
            panelCount: panelRestoreCount,
          });
          logHydrationInfo(`Restoring ${appState.terminals.length} saved panel(s)`);
        }

        const { restoreTasks } = await restorePanelsPhase(appState.terminals, {
          addPanel,
          checkCurrent,
          withHydrationBatch,
          backendTerminalMap,
          terminalSizes,
          activeWorktreeId,
          projectRoot: projectRoot || "",
          agentSettings,
          clipboardDirectory,
          projectPresetsByAgent,
          _switchId,
          worktreesPromise,
          restoreTerminalOrder: options.restoreTerminalOrder,
          safeMode: hydrateResult.safeMode,
          logHydrationInfo,
        });

        if (!checkCurrent()) return;

        const { criticalTasks, deferredTasks } = splitSnapshotRestoreTasks(
          restoreTasks,
          appState.activeWorktreeId ?? null,
          shouldDeferSnapshotRestore
        );

        // Schedule critical scrollback restores at background priority —
        // no blocking IPC fetch on the critical path. The overlay can dismiss
        // immediately and scrollback fills in asynchronously.
        if (criticalTasks.length > 0) {
          markRendererPerformance(PERF_MARKS.HYDRATE_RESTORE_SNAPSHOTS_CRITICAL, {
            switchId: _switchId ?? null,
            criticalCount: criticalTasks.length,
          });
          scheduleScrollbackRestore(criticalTasks, checkCurrent, "background");
        }

        // Deferred terminals restore lazily on first scroll interaction
        if (deferredTasks.length > 0) {
          markRendererPerformance("hydrate_restore_snapshots_deferred_scheduled", {
            deferredSnapshotCount: deferredTasks.length,
            switchId: _switchId ?? null,
          });

          scheduleScrollbackRestore(deferredTasks, checkCurrent, "lazy");
        }

        if (panelRestoreStartedAt !== null) {
          markRendererPerformance(PERF_MARKS.HYDRATE_RESTORE_PANELS_END, {
            panelCount: panelRestoreCount,
            durationMs: Date.now() - panelRestoreStartedAt,
            criticalSnapshotCount: criticalTasks.length,
            deferredSnapshotCount: deferredTasks.length,
          });
        }
      } catch (error) {
        logWarn("Failed to query backend terminals", { error });
      }

      // Restore tab groups after terminals are restored
      if (options.hydrateTabGroups) {
        try {
          const tabGroups = tabGroupsPromise ? await tabGroupsPromise : [];
          if (!checkCurrent()) return;

          if (tabGroups === null) {
            options.hydrateTabGroups([], { skipPersist: true });
            tabGroupRestoreCount = 0;
            markRendererPerformance(PERF_MARKS.HYDRATE_RESTORE_TAB_GROUPS_END, {
              tabGroupCount: tabGroupRestoreCount,
              fallback: "prefetch-error-clear",
            });
          } else {
            // Always call hydrateTabGroups, even with empty array, to clear stale groups
            if (tabGroups.length > 0) {
              logHydrationInfo(`Restoring ${tabGroups.length} tab group(s)`);
            } else {
              logHydrationInfo("Clearing stale tab groups (no groups for project)");
            }
            tabGroupRestoreCount = tabGroups.length;
            options.hydrateTabGroups(tabGroups);
            markRendererPerformance(PERF_MARKS.HYDRATE_RESTORE_TAB_GROUPS_END, {
              tabGroupCount: tabGroupRestoreCount,
            });
          }
        } catch (error) {
          logWarn("Failed to restore tab groups", { error });
          // Check staleness before clearing to prevent race condition
          if (!checkCurrent()) return;
          // Clear tab groups on error to prevent stale state, but skip persist to avoid wiping storage
          options.hydrateTabGroups([], { skipPersist: true });
          tabGroupRestoreCount = 0;
          markRendererPerformance(PERF_MARKS.HYDRATE_RESTORE_TAB_GROUPS_END, {
            tabGroupCount: tabGroupRestoreCount,
            fallback: "error-clear",
          });
        }
      }
    }

    // Cleanup orphaned terminals after terminal hydration completes
    // This must run after terminals are restored to ensure we're checking the full terminal list
    try {
      const { cleanupOrphanedTerminals } = await import("@/store/createWorktreeStore");
      cleanupOrphanedTerminals();
    } catch (error) {
      logWarn("Failed to cleanup orphaned terminals", { error });
    }

    // Restore active worktree with validation.
    // Worktree fetch starts earlier to overlap with terminal restoration.
    const worktrees = await worktreesPromise;
    const savedActiveId = appState.activeWorktreeId;

    if (worktrees === null) {
      if (savedActiveId) {
        setActiveWorktree(savedActiveId);
      }
    } else if (worktrees.length > 0) {
      // Check if the saved active worktree still exists
      const worktreeExists = savedActiveId && worktrees.some((wt) => wt.id === savedActiveId);

      if (worktreeExists) {
        // Restore the saved active worktree
        setActiveWorktree(savedActiveId);
      } else {
        // Fallback to the first worktree (main worktree is typically first)
        const sortedWorktrees = [...worktrees].sort((a, b) => {
          if (a.isMainWorktree && !b.isMainWorktree) return -1;
          if (!a.isMainWorktree && b.isMainWorktree) return 1;
          return a.name.localeCompare(b.name);
        });
        const fallbackWorktree = sortedWorktrees[0]!;
        logHydrationInfo(
          `Active worktree ${savedActiveId ?? "(none)"} not found, falling back to: ${fallbackWorktree.name}`
        );
        setActiveWorktree(fallbackWorktree.id);
      }
    }
    // If no worktrees exist, we don't set any active worktree (handled gracefully)

    // Recipe load starts earlier to overlap with hydration work.
    // Recipes are non-critical for first paint; fire-and-forget on both initial load and project switch.
    if (recipeLoadPromise) {
      void recipeLoadPromise;
    }

    if (appState.developerMode?.enabled && appState.developerMode.autoOpenDiagnostics) {
      const tab = appState.developerMode.focusEventsTab ? "events" : undefined;
      openDiagnosticsDock(tab);
    }

    // Migration: read from new key, fallback to old key for backward compatibility
    const layoutConfig =
      appState.panelGridConfig ??
      (appState as unknown as { terminalGridConfig?: typeof appState.panelGridConfig })
        .terminalGridConfig;
    if (layoutConfig) {
      useLayoutConfigStore.getState().setLayoutConfig(layoutConfig);
    }

    // Restore focus mode from per-project state (hydrate returns per-project focus mode)
    if (options.setFocusMode && appState.focusMode !== undefined) {
      options.setFocusMode(appState.focusMode, appState.focusPanelState);
    }

    // Restore MRU list
    if (options.hydrateMru && Array.isArray(appState.mruList)) {
      options.hydrateMru(appState.mruList);
    }

    // Restore action MRU list
    if (options.hydrateActionMru && Array.isArray(appState.actionMruList)) {
      options.hydrateActionMru(appState.actionMruList);
    }
  } catch (error) {
    logError("Failed to hydrate app state", error);
    throw error;
  } finally {
    suppressMruRecording(false);
    markRendererPerformance(PERF_MARKS.HYDRATE_COMPLETE, {
      switchId: _switchId ?? null,
      durationMs: Date.now() - hydrationStartedAt,
      panelCount: panelRestoreCount,
      tabGroupCount: tabGroupRestoreCount,
    });

    if (isRendererPerfCaptureEnabled() && window.electron?.perf) {
      const marks = window.__DAINTREE_PERF_MARKS__ ?? [];
      window.electron.perf.flushMarks({
        marks,
        rendererTimeOrigin: performance.timeOrigin,
        rendererT0: RENDERER_T0,
      });
      window.__DAINTREE_PERF_MARKS__ = [];
    }
  }
}
