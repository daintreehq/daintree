import { appClient, terminalClient, worktreeClient, projectClient, systemClient } from "@/clients";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { suppressMruRecording } from "@/store/worktreeStore";
import { useLayoutConfigStore } from "@/store";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import { notify } from "@/lib/notify";
import type {
  AgentState,
  PanelKind,
  PanelSnapshot,
  TerminalReconnectError,
  TabGroup,
} from "@/types";
import type { ActionFrecencyEntry } from "@shared/types/actions";
import { keybindingService } from "@/services/KeybindingService";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { panelPersistence } from "@/store/persistence/panelPersistence";
import { getPanelKindConfig, panelKindHasPty } from "@shared/config/panelKindRegistry";
import { isSmokeTestTerminalId } from "@shared/utils/smokeTestTerminals";
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
import {
  type TerminalRestoreTask,
  splitSnapshotRestoreTasks,
  scheduleBackgroundFetchAndRestore,
  registerLazyScrollRestore,
  RESTORE_SPAWN_BATCH_SIZE,
  RESTORE_SPAWN_BATCH_DELAY_MS,
  delay,
} from "./batchScheduler";
import type { HydrationBatchToken } from "@/store/slices/panelRegistry/types";
import { normalizeAndApplyScrollback } from "./scrollbackConfig";
import { reconnectWithTimeout } from "./reconnectManager";
import {
  inferKind,
  resolveAgentId,
  inferAgentIdFromTitle,
  buildArgsForBackendTerminal,
  buildArgsForReconnectedFallback,
  buildArgsForRespawn,
  buildArgsForNonPtyRecreation,
  buildArgsForOrphanedTerminal,
  inferWorktreeIdFromCwd,
} from "./statePatcher";
const CLIPBOARD_DIR_NAME = "daintree-clipboard";
const VERBOSE_HYDRATION_LOGGING = isDaintreeEnvEnabled("DAINTREE_VERBOSE");

function logHydrationInfo(message: string, context?: Record<string, unknown>): void {
  if (!VERBOSE_HYDRATION_LOGGING) return;
  logInfo(message, context);
}

let hydrationBootstrapPromise: Promise<void> | null = null;

async function ensureHydrationBootstrap(): Promise<void> {
  if (!hydrationBootstrapPromise) {
    hydrationBootstrapPromise = (async () => {
      await keybindingService.loadOverrides();
      await useUserAgentRegistryStore.getState().initialize();
    })().catch((error) => {
      hydrationBootstrapPromise = null;
      throw error;
    });
  }

  await hydrationBootstrapPromise;
}

function scheduleScrollbackRestore(
  tasks: TerminalRestoreTask[],
  isCurrent: () => boolean,
  mode: "background" | "lazy"
): void {
  for (const task of tasks) {
    const managed = terminalInstanceService.get(task.terminalId);
    if (!managed || managed.scrollbackRestoreState !== "none") continue;

    managed.scrollbackRestoreState = "pending";

    const doRestore = async () => {
      if (!isCurrent()) return;
      const current = terminalInstanceService.get(task.terminalId);
      if (!current || current !== managed) return;
      if (managed.scrollbackRestoreState !== "pending") return;

      managed.scrollbackRestoreState = "in-progress";
      try {
        await terminalInstanceService.fetchAndRestore(task.terminalId);
        managed.scrollbackRestoreState = "done";
      } catch (error) {
        managed.scrollbackRestoreState = "none";
        logWarn(`Scrollback restore failed for ${task.label}`, { error });
      }
    };

    if (mode === "lazy" && managed.hostElement) {
      const disposable = registerLazyScrollRestore(managed, doRestore);
      managed.scrollbackRestoreDisposable = disposable;
      managed.listeners.push(() => disposable.dispose());
    } else {
      scheduleBackgroundFetchAndRestore(doRestore);
    }
  }
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
  const restoreTasks: TerminalRestoreTask[] = [];

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
      useSafeModeStore.getState().setSafeMode(true);
    }

    if (hydrateResult.settingsRecovery) {
      const recovery = hydrateResult.settingsRecovery;
      const pathNote = recovery.quarantinedPath
        ? `\nCorrupt file preserved at: ${recovery.quarantinedPath}`
        : "";

      if (recovery.kind === "restored-from-backup") {
        notify({
          type: "warning",
          title: "Settings restored from backup",
          message: `Your settings file was corrupted and has been restored from a backup. Some recent changes may have been lost.${pathNote}`,
          priority: "high",
          duration: 8000,
        });
      } else {
        notify({
          type: "warning",
          title: "Settings reset to defaults",
          message: `Your settings file was corrupted and no backup was available. Settings have been reset to defaults.${pathNote}`,
          priority: "high",
          duration: 0,
        });
      }
    }

    if (hydrateResult.projectStateRecovery) {
      const { quarantinedPath } = hydrateResult.projectStateRecovery;
      notify({
        type: "warning",
        title: "Project state corrupted",
        message: `Your project state was corrupted and has been reset. The corrupt file is preserved at: ${quarantinedPath}`,
        priority: "high",
        duration: 0,
      });
    }

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

        // Restore all panels in saved order (mix of PTY reconnects and non-PTY recreations)
        if (appState.terminals && appState.terminals.length > 0) {
          // Seed the persistence cache so the first save after launch can
          // preserve kind-specific fields for unregistered kinds (e.g., an
          // extension that hasn't re-registered yet). Without this priming,
          // a first save cycle would drop those fields — see issue #5201.
          // appState.terminals is TerminalState[] (IPC wire type, more
          // lenient); the on-disk data was written by panelToSnapshot so is
          // structurally PanelSnapshot[].
          if (currentProjectId) {
            panelPersistence.primeProject(
              currentProjectId,
              appState.terminals as unknown as PanelSnapshot[]
            );
          }

          panelRestoreStartedAt = Date.now();
          panelRestoreCount = appState.terminals.length;
          markRendererPerformance(PERF_MARKS.HYDRATE_RESTORE_PANELS_START, {
            panelCount: panelRestoreCount,
          });
          logHydrationInfo(`Restoring ${appState.terminals.length} saved panel(s)`);

          // Collect panel restore tasks with priority for staggered spawning.
          // Priority 0 = active worktree panels (restore first for instant interactivity)
          // Priority 1 = all other panels (staggered in batches)

          interface PanelRestoreTaskEntry {
            priority: number;
            isPty: boolean;
            execute: () => Promise<void>;
          }

          const panelTasks: PanelRestoreTaskEntry[] = [];
          const restoredIdsByIndex = new Map<number, string>();

          for (let savedIndex = 0; savedIndex < appState.terminals.length; savedIndex++) {
            const saved = appState.terminals[savedIndex];
            if (saved === undefined) continue;
            if (isSmokeTestTerminalId(saved.id)) {
              logHydrationInfo(`Skipping smoke test terminal snapshot: ${saved.id}`);
              continue;
            }

            const savedWorktreeId = saved.worktreeId ?? null;
            const isActiveWorktree = savedWorktreeId === activeWorktreeId;
            const priority = isActiveWorktree ? 0 : 1;

            // Determine isPty at task-build time so we can partition tasks
            // for concurrent (non-PTY) vs staggered (PTY) execution.
            const backendTerminal = backendTerminalMap.get(saved.id);
            let taskIsPty: boolean;
            if (backendTerminal) {
              taskIsPty = true;
            } else {
              const inferredKind = inferKind(saved);
              taskIsPty = inferredKind === "assistant" ? false : panelKindHasPty(inferredKind);
            }

            const capturedIndex = savedIndex;
            panelTasks.push({
              priority,
              isPty: taskIsPty,
              execute: async () => {
                if (backendTerminal) {
                  // Skip dead agent backend terminals — they create phantom idle panels.
                  const isDeadAgentBackend =
                    backendTerminal.hasPty === false &&
                    resolveAgentId(backendTerminal.launchAgentId) !== undefined;
                  if (isDeadAgentBackend) {
                    logHydrationInfo(`Skipping dead agent backend terminal: ${backendTerminal.id}`);
                    backendTerminalMap.delete(saved.id);
                    return;
                  }

                  logHydrationInfo(`Reconnecting to terminal: ${saved.id}`);

                  const args = buildArgsForBackendTerminal(
                    backendTerminal,
                    saved,
                    projectRoot || ""
                  );
                  // Assign to active worktree if terminal has no worktreeId
                  if (!args.worktreeId && activeWorktreeId) {
                    args.worktreeId = activeWorktreeId;
                  }
                  const location = args.location as "grid" | "dock";

                  logHydrationInfo(`[HYDRATION] Adding terminal from backend:`, {
                    id: backendTerminal.id,
                    kind: args.kind,
                    launchAgentId: args.launchAgentId,
                    location,
                    worktreeId: args.worktreeId,
                    title: backendTerminal.title,
                  });

                  const restoredTerminalId = await addPanel(args);
                  restoredIdsByIndex.set(capturedIndex, restoredTerminalId);

                  if (backendTerminal.activityTier) {
                    terminalInstanceService.initializeBackendTier(
                      restoredTerminalId,
                      backendTerminal.activityTier
                    );
                  }

                  if (terminalSizes && typeof terminalSizes === "object") {
                    const savedSize = terminalSizes[restoredTerminalId];
                    if (
                      savedSize &&
                      Number.isFinite(savedSize.cols) &&
                      Number.isFinite(savedSize.rows) &&
                      savedSize.cols > 0 &&
                      savedSize.rows > 0
                    ) {
                      terminalInstanceService.setTargetSize(
                        restoredTerminalId,
                        savedSize.cols,
                        savedSize.rows
                      );
                    }
                  }

                  restoreTasks.push({
                    terminalId: restoredTerminalId,
                    label: saved.id,
                    worktreeId: args.worktreeId,
                    location,
                  });

                  backendTerminalMap.delete(saved.id);
                } else {
                  const kind = inferKind(saved);

                  if (kind === "assistant") {
                    logHydrationInfo(`Skipping legacy assistant panel: ${saved.id}`);
                    return;
                  }

                  const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";

                  if (panelKindHasPty(kind)) {
                    const reconnectOutcome = await reconnectWithTimeout(saved.id, logHydrationInfo);
                    const reconnectTimedOut = reconnectOutcome.status === "timeout";
                    const reconnectedTerminal =
                      reconnectOutcome.status === "found" ? reconnectOutcome.terminal : null;

                    if (reconnectedTerminal) {
                      const reconnectArgs = buildArgsForReconnectedFallback(
                        reconnectedTerminal,
                        saved,
                        projectRoot || ""
                      );
                      // Assign to active worktree when a legacy saved panel has
                      // no worktreeId (mirrors the matched-backend path).
                      if (!reconnectArgs.worktreeId && activeWorktreeId) {
                        reconnectArgs.worktreeId = activeWorktreeId;
                      }
                      const restoredTerminalId = await addPanel(reconnectArgs);
                      restoredIdsByIndex.set(capturedIndex, restoredTerminalId);

                      if (reconnectedTerminal.activityTier) {
                        terminalInstanceService.initializeBackendTier(
                          restoredTerminalId,
                          reconnectedTerminal.activityTier
                        );
                      }

                      if (terminalSizes && typeof terminalSizes === "object") {
                        const savedSize = terminalSizes[restoredTerminalId];
                        if (
                          savedSize &&
                          Number.isFinite(savedSize.cols) &&
                          Number.isFinite(savedSize.rows) &&
                          savedSize.cols > 0 &&
                          savedSize.rows > 0
                        ) {
                          terminalInstanceService.setTargetSize(
                            restoredTerminalId,
                            savedSize.cols,
                            savedSize.rows
                          );
                        }
                      }

                      restoreTasks.push({
                        terminalId: restoredTerminalId,
                        label: saved.id,
                        worktreeId: reconnectArgs.worktreeId,
                        location,
                      });
                    } else {
                      // During a live project switch (_switchId defined), don't respawn agent
                      // panels that no longer exist in the backend — they are phantoms.
                      // On cold app restart (_switchId undefined), not_found simply means the
                      // PTY process was killed on quit and needs to be respawned.
                      // Mirror buildArgsForRespawn's title-inference recovery so legacy
                      // `kind: "agent"` panels with cleared agentId still skip as phantoms.
                      const inferredAgentId = inferAgentIdFromTitle(
                        saved.title,
                        kind,
                        resolveAgentId(saved.launchAgentId),
                        saved.id,
                        "switch-guard"
                      );
                      const isAgentKind = inferredAgentId !== undefined;
                      if (
                        isAgentKind &&
                        reconnectOutcome.status === "not_found" &&
                        _switchId !== undefined
                      ) {
                        logHydrationInfo(
                          `Skipping phantom agent during project switch: ${saved.id}`
                        );
                        return;
                      }

                      const respawnArgs = buildArgsForRespawn(
                        saved,
                        kind,
                        projectRoot || "",
                        agentSettings,
                        reconnectTimedOut,
                        clipboardDirectory,
                        projectPresetsByAgent
                      );

                      // Assign to active worktree if the saved terminal has no worktreeId
                      if (!respawnArgs.worktreeId && activeWorktreeId) {
                        respawnArgs.worktreeId = activeWorktreeId;
                      }

                      logHydrationInfo(
                        `Respawning PTY panel: ${saved.id} (${respawnArgs.launchAgentId ? "agent" : "terminal"})`
                      );

                      logHydrationInfo(`[HYDRATION-RESPAWN] Adding terminal:`, {
                        id: saved.id,
                        kind: respawnArgs.kind,
                        launchAgentId: respawnArgs.launchAgentId,
                        location: respawnArgs.location,
                        savedLocation: saved.location,
                        worktreeId: saved.worktreeId,
                        title: saved.title,
                      });

                      const restoredTerminalId = await addPanel(respawnArgs);
                      restoredIdsByIndex.set(capturedIndex, restoredTerminalId);

                      if (terminalSizes && typeof terminalSizes === "object") {
                        const savedSize =
                          terminalSizes[saved.id] || terminalSizes[restoredTerminalId];
                        if (
                          savedSize &&
                          Number.isFinite(savedSize.cols) &&
                          Number.isFinite(savedSize.rows) &&
                          savedSize.cols > 0 &&
                          savedSize.rows > 0
                        ) {
                          terminalInstanceService.setTargetSize(
                            restoredTerminalId,
                            savedSize.cols,
                            savedSize.rows
                          );
                        }
                      }
                    }
                  } else {
                    // Unregistered kind. Restore when the panel carries a
                    // pluginId (current-format plugin panel) OR the kind string
                    // contains a dot (legacy pre-#5580 plugin panel whose kind
                    // was persisted as "${manifest.name}.${panel.id}" without a
                    // pluginId field). Both cases let the renderer surface a
                    // PluginMissingPanel placeholder (#5580) instead of silently
                    // dropping the panel. Non-dotted unregistered kinds (e.g.
                    // the "notes" built-in removed in #5616) are still skipped
                    // to avoid "Unknown Panel Type" ghosts.
                    if (!getPanelKindConfig(kind) && !saved.pluginId && !kind.includes(".")) {
                      logHydrationInfo(
                        `Skipping persisted panel with unregistered kind: ${saved.id} (${kind})`
                      );
                      return;
                    }
                    logHydrationInfo(`Recreating ${kind} panel: ${saved.id}`);
                    const nonPtyId = await addPanel(
                      buildArgsForNonPtyRecreation(saved, kind, projectRoot || "")
                    );
                    restoredIdsByIndex.set(capturedIndex, nonPtyId);
                  }
                }
              },
            });
          }

          // Execute panel restore tasks: non-PTY panels run concurrently (they only
          // do synchronous Zustand mutations with no IPC), then PTY panels restore
          // with priority ordering and staggered batching to throttle process spawning.
          const nonPtyTasks = panelTasks.filter((t) => !t.isPty);
          const ptyPriorityTasks = panelTasks.filter((t) => t.isPty && t.priority === 0);
          const ptyBackgroundTasks = panelTasks.filter((t) => t.isPty && t.priority === 1);

          // Restore all non-PTY panels concurrently (browser, dev-preview).
          // These only perform synchronous store mutations, so no throttling is needed.
          // The begin/flush wrapper collapses the N addPanel mutations into one store
          // commit, reducing this phase from N re-renders to 1.
          if (nonPtyTasks.length > 0) {
            logHydrationInfo(`Restoring ${nonPtyTasks.length} non-PTY panel(s) concurrently`);
            await withHydrationBatch(async () => {
              await Promise.allSettled(
                nonPtyTasks.map(async (task) => {
                  try {
                    await task.execute();
                  } catch (error) {
                    logWarn("Failed to restore non-PTY panel", { error });
                  }
                })
              );
            });
          }

          if (!checkCurrent()) return;

          // Restore priority PTY panels sequentially (active worktree, for instant
          // interactivity). Batched so the sequential `await`s — which normally break
          // React 19 auto-batching and cause one render per panel — collapse into a
          // single store commit at phase end.
          if (ptyPriorityTasks.length > 0) {
            await withHydrationBatch(async () => {
              for (const task of ptyPriorityTasks) {
                try {
                  await task.execute();
                } catch (error) {
                  logWarn("Failed to restore priority panel", { error });
                }
              }
            });
          }

          if (!checkCurrent()) return;

          // Restore background PTY panels in staggered batches. Each batch is its own
          // hydration batch: we still want staggered spawning to throttle PTY pressure,
          // but within a batch the N panels commit in one render rather than N.
          // N background panels -> ceil(N / RESTORE_SPAWN_BATCH_SIZE) renders instead of N.
          if (ptyBackgroundTasks.length > 0) {
            logHydrationInfo(
              `Staggering ${ptyBackgroundTasks.length} background PTY panel(s) in batches of ${RESTORE_SPAWN_BATCH_SIZE}`
            );
            for (let i = 0; i < ptyBackgroundTasks.length; i += RESTORE_SPAWN_BATCH_SIZE) {
              const batch = ptyBackgroundTasks.slice(i, i + RESTORE_SPAWN_BATCH_SIZE);
              await withHydrationBatch(async () => {
                await Promise.allSettled(
                  batch.map(async (task) => {
                    try {
                      await task.execute();
                    } catch (error) {
                      logWarn("Failed to restore background panel", { error });
                    }
                  })
                );
              });
              if (i + RESTORE_SPAWN_BATCH_SIZE < ptyBackgroundTasks.length) {
                await delay(RESTORE_SPAWN_BATCH_DELAY_MS);
              }
            }
          }

          // Restore saved panel order. The three-phase restore (non-PTY first, then
          // priority PTY, then background PTY) means panels end up in execution order
          // rather than saved order. Sort them back to match the saved state.
          if (options.restoreTerminalOrder && restoredIdsByIndex.size > 0) {
            const orderedIds = Array.from(restoredIdsByIndex.entries())
              .sort((a, b) => a[0] - b[0])
              .map(([, id]) => id);
            options.restoreTerminalOrder(orderedIds);
          }
        }

        if (!checkCurrent()) return;

        // Restore any orphaned backend terminals not in saved state (append at end).
        // When no panels were saved (brand-new project), skip the startup "default"
        // terminal — it belongs to the previous project's bootstrap sequence, not this one.
        // In safe mode, skip orphan reconnection entirely to ensure a clean slate.
        const hasSavedPanels = appState.terminals && appState.terminals.length > 0;
        const orphanedTerminals = hydrateResult.safeMode
          ? []
          : Array.from(backendTerminalMap.values()).filter(
              (t) => !(t.id.startsWith("default-") && !hasSavedPanels) && t.hasPty !== false
            );
        if (orphanedTerminals.length > 0) {
          logHydrationInfo(
            `${orphanedTerminals.length} orphaned terminal(s) not in saved order, appending at end`
          );

          // Resolve worktreeId for orphaned terminals by matching the terminal's
          // cwd against known worktree paths (longest-prefix wins). worktreesPromise
          // is awaited once; if it resolves to null or hasn't loaded, orphans fall
          // back to activeWorktreeId so they still appear in the grid.
          const worktreesForInfer = await worktreesPromise;

          const restoreOrphan = async (
            terminal: (typeof orphanedTerminals)[number]
          ): Promise<void> => {
            try {
              logHydrationInfo(`Reconnecting to orphaned terminal: ${terminal.id}`);

              const orphanArgs = buildArgsForOrphanedTerminal(terminal, projectRoot || "");
              // Orphaned backend terminals no longer carry worktreeId — infer it
              // from cwd against the loaded worktrees, then fall back to the
              // active worktree so the panel still appears in the grid filter.
              const inferred = inferWorktreeIdFromCwd(terminal.cwd, worktreesForInfer ?? undefined);
              if (inferred) {
                orphanArgs.worktreeId = inferred;
              } else if (activeWorktreeId) {
                orphanArgs.worktreeId = activeWorktreeId;
              }
              const restoredTerminalId = await addPanel(orphanArgs);

              if (terminal.activityTier) {
                terminalInstanceService.initializeBackendTier(
                  restoredTerminalId,
                  terminal.activityTier
                );
              }

              if (terminalSizes && typeof terminalSizes === "object") {
                const savedSize = terminalSizes[restoredTerminalId];
                if (
                  savedSize &&
                  Number.isFinite(savedSize.cols) &&
                  Number.isFinite(savedSize.rows) &&
                  savedSize.cols > 0 &&
                  savedSize.rows > 0
                ) {
                  terminalInstanceService.setTargetSize(
                    restoredTerminalId,
                    savedSize.cols,
                    savedSize.rows
                  );
                }
              }

              restoreTasks.push({
                terminalId: restoredTerminalId,
                label: terminal.id,
                worktreeId: orphanArgs.worktreeId,
                location: "grid",
              });
            } catch (error) {
              logWarn(`Failed to reconnect to orphaned terminal ${terminal.id}`, { error });
            }
          };

          // Same staggered-batch pattern as the background PTY phase: one hydration
          // batch per spawn batch so orphan restores commit once per batch rather
          // than once per terminal.
          for (let i = 0; i < orphanedTerminals.length; i += RESTORE_SPAWN_BATCH_SIZE) {
            const batch = orphanedTerminals.slice(i, i + RESTORE_SPAWN_BATCH_SIZE);
            await withHydrationBatch(async () => {
              await Promise.allSettled(batch.map(restoreOrphan));
            });
            if (i + RESTORE_SPAWN_BATCH_SIZE < orphanedTerminals.length) {
              await delay(RESTORE_SPAWN_BATCH_DELAY_MS);
            }
          }
        }

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
