import { appClient, terminalClient, worktreeClient, projectClient, systemClient } from "@/clients";
import { suppressMruRecording } from "@/store/worktreeStore";
import { terminalConfigClient } from "@/clients/terminalConfigClient";
import {
  useLayoutConfigStore,
  useScrollbackStore,
  usePerformanceModeStore,
  useTerminalInputStore,
} from "@/store";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import type {
  TerminalType,
  AgentState,
  TerminalKind,
  TerminalReconnectError,
  TabGroup,
} from "@/types";
import { keybindingService } from "@/services/KeybindingService";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { generateAgentCommand, buildResumeCommand } from "@shared/types";
import { normalizeScrollbackLines } from "@shared/config/scrollback";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { isTerminalWarmInProjectSwitchCache } from "@/services/projectSwitchRendererCache";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { isSmokeTestTerminalId } from "@shared/utils/smokeTestTerminals";
import { logDebug, logInfo, logWarn, logError } from "@/utils/logger";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance, withRendererSpan } from "@/utils/performance";
import { isCanopyEnvEnabled } from "@/utils/env";

const RECONNECT_TIMEOUT_MS = 2000;
const RESTORE_CONCURRENCY = 8;
const RESTORE_SPAWN_BATCH_SIZE = 3;
const RESTORE_SPAWN_BATCH_DELAY_MS = 100;
const DEFERRED_RESTORE_IDLE_TIMEOUT_MS = 1200;
const DEFERRED_RESTORE_FALLBACK_DELAY_MS = 32;
const CLIPBOARD_DIR_NAME = "canopy-clipboard";
const VERBOSE_HYDRATION_LOGGING = isCanopyEnvEnabled("CANOPY_VERBOSE");

function logHydrationInfo(message: string, context?: Record<string, unknown>): void {
  if (!VERBOSE_HYDRATION_LOGGING) return;
  logInfo(message, context);
}

let hydrationBootstrapPromise: Promise<void> | null = null;

interface TerminalRestoreTask {
  terminalId: string;
  label: string;
  worktreeId?: string;
  location: "grid" | "dock";
}

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

function splitSnapshotRestoreTasks(
  tasks: TerminalRestoreTask[],
  activeWorktreeId: string | null,
  enableDeferredRestore: boolean
): { criticalTasks: TerminalRestoreTask[]; deferredTasks: TerminalRestoreTask[] } {
  if (!enableDeferredRestore || tasks.length <= 1) {
    return { criticalTasks: tasks, deferredTasks: [] };
  }

  const criticalTasks: TerminalRestoreTask[] = [];
  const deferredTasks: TerminalRestoreTask[] = [];

  for (const task of tasks) {
    const isDockTask = task.location === "dock";
    const isProjectScopedTask = task.worktreeId == null;
    const isActiveWorktreeTask = task.worktreeId === activeWorktreeId;

    if (isDockTask || isProjectScopedTask || isActiveWorktreeTask) {
      criticalTasks.push(task);
    } else {
      deferredTasks.push(task);
    }
  }

  if (criticalTasks.length === 0 && deferredTasks.length > 0) {
    const fallbackTask = deferredTasks.shift();
    if (fallbackTask) {
      criticalTasks.push(fallbackTask);
    }
  }

  return { criticalTasks, deferredTasks };
}

function scheduleDeferredSnapshotRestore(runRestore: () => Promise<void>): void {
  const execute = () => {
    void runRestore().catch((error) => {
      logWarn("Deferred terminal snapshot restore failed", { error });
    });
  };

  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => execute(), {
      timeout: DEFERRED_RESTORE_IDLE_TIMEOUT_MS,
    });
    return;
  }

  setTimeout(execute, DEFERRED_RESTORE_FALLBACK_DELAY_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runInBatches<T>(
  items: T[],
  batchSize: number,
  delayMs: number,
  runner: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(runner));
    if (i + batchSize < items.length) {
      await delay(delayMs);
    }
  }
}

async function restoreTerminalSnapshots(
  tasks: TerminalRestoreTask[],
  isCurrent: () => boolean,
  switchId?: string
): Promise<void> {
  if (tasks.length === 0) {
    return;
  }

  let serializedStateBatch: Record<string, string | null> | null = null;
  try {
    serializedStateBatch = await withRendererSpan(
      PERF_MARKS.HYDRATE_GET_SERIALIZED_STATES,
      () => terminalClient.getSerializedStates(tasks.map((task) => task.terminalId)),
      { switchId: switchId ?? null }
    );
  } catch (batchError) {
    logWarn("Batch serialized state fetch failed; falling back to per-terminal requests", {
      error: batchError,
    });
  }

  let nextIndex = 0;
  const workerCount = Math.min(RESTORE_CONCURRENCY, tasks.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        if (!isCurrent()) return;

        const currentIndex = nextIndex;
        if (currentIndex >= tasks.length) {
          return;
        }
        nextIndex += 1;

        const task = tasks[currentIndex];
        try {
          if (serializedStateBatch) {
            const hasSerializedState = Object.prototype.hasOwnProperty.call(
              serializedStateBatch,
              task.terminalId
            );

            if (hasSerializedState) {
              const serializedState = serializedStateBatch[task.terminalId];
              const restored = await terminalInstanceService.restoreFetchedState(
                task.terminalId,
                serializedState
              );
              if (!restored && serializedState === null) {
                await terminalInstanceService.fetchAndRestore(task.terminalId);
              }
            } else {
              await terminalInstanceService.fetchAndRestore(task.terminalId);
            }
          } else {
            await terminalInstanceService.fetchAndRestore(task.terminalId);
          }
        } catch (snapshotError) {
          logWarn(`Serialized state restore failed for ${task.label}`, {
            error: snapshotError,
          });
        }
      }
    })
  );
}

export interface HydrationOptions {
  addTerminal: (options: {
    kind?: TerminalKind;
    type?: TerminalType;
    agentId?: string;
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
    browserHistory?: import("@shared/types/domain").BrowserHistory;
    browserZoom?: number;
    notePath?: string; // Path to note file (kind === 'notes')
    noteId?: string; // Note ID (kind === 'notes')
    scope?: "worktree" | "project"; // Note scope (kind === 'notes')
    createdAt?: number; // Note creation timestamp (kind === 'notes')
    devCommand?: string; // Dev command override for dev-preview panels
    devServerStatus?: "stopped" | "starting" | "installing" | "running" | "error";
    devServerUrl?: string | null;
    devServerError?: { type: string; message: string } | null;
    devServerTerminalId?: string | null;
    browserConsoleOpen?: boolean;
    devPreviewConsoleOpen?: boolean;
    exitBehavior?: import("@shared/types/domain").PanelExitBehavior;
    agentSessionId?: string;
    agentLaunchFlags?: string[];
    restore?: boolean;
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
  hydrateActionMru?: (list: string[]) => void;
}

export async function hydrateAppState(
  options: HydrationOptions,
  _switchId?: string,
  isCurrent?: () => boolean
): Promise<void> {
  const { addTerminal, setActiveWorktree, loadRecipes, openDiagnosticsDock } = options;
  const hydrationStartedAt = Date.now();
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

    // Batch fetch initial state
    const [hydrateResult, tmpDir] = await Promise.all([
      withRendererSpan(PERF_MARKS.HYDRATE_APP_CLIENT, () => appClient.hydrate(), {
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

    // Hydrate terminal config (scrollback, performance mode) BEFORE restoring terminals
    try {
      if (terminalConfig?.scrollbackLines !== undefined) {
        const { scrollbackLines } = terminalConfig;
        const normalizedScrollback = normalizeScrollbackLines(scrollbackLines);

        if (normalizedScrollback !== scrollbackLines) {
          logHydrationInfo(
            `Normalizing scrollback from ${scrollbackLines} to ${normalizedScrollback}`
          );
          terminalConfigClient.setScrollback(normalizedScrollback).catch((err) => {
            logWarn("Failed to persist scrollback normalization", { error: err });
          });
        }

        useScrollbackStore.getState().setScrollbackLines(normalizedScrollback);
      }
      if (terminalConfig?.performanceMode !== undefined) {
        usePerformanceModeStore.getState().setPerformanceMode(terminalConfig.performanceMode);
      }
      if (terminalConfig) {
        useTerminalInputStore
          .getState()
          .setHybridInputEnabled(terminalConfig.hybridInputEnabled ?? true);
        useTerminalInputStore
          .getState()
          .setHybridInputAutoFocus(terminalConfig.hybridInputAutoFocus ?? true);
      }
    } catch (error) {
      logWarn("Failed to hydrate terminal config", { error });
    }

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

    const recipeLoadPromise = currentProjectId
      ? loadRecipes(currentProjectId).catch((error) => {
          logWarn("Failed to load recipes", { error });
        })
      : null;

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

        if (isCanopyEnvEnabled("CANOPY_VERBOSE")) {
          logDebug(`Project: ${currentProjectId.slice(0, 8)}`);
          logDebug("Backend terminals", {
            terminals: backendTerminals.map((t) => ({
              id: t.id.slice(0, 8),
              kind: t.kind,
              agentId: t.agentId,
              projectId: t.projectId?.slice(0, 8),
            })),
          });
        }

        // Build a map of backend terminals by ID for quick lookup
        const backendTerminalMap = new Map(backendTerminals.map((t) => [t.id, t]));

        // Fetch terminal sizes for restoration
        const terminalSizes = await terminalSizesPromise;
        if (!checkCurrent()) return;

        // Restore all panels in saved order (mix of PTY reconnects and non-PTY recreations)
        if (appState.terminals && appState.terminals.length > 0) {
          panelRestoreStartedAt = Date.now();
          panelRestoreCount = appState.terminals.length;
          markRendererPerformance(PERF_MARKS.HYDRATE_RESTORE_PANELS_START, {
            panelCount: panelRestoreCount,
          });
          logHydrationInfo(`Restoring ${appState.terminals.length} saved panel(s)`);

          // Collect panel restore tasks with priority for staggered spawning.
          // Priority 0 = active worktree panels (restore first for instant interactivity)
          // Priority 1 = all other panels (staggered in batches)
          const activeWorktreeId = appState.activeWorktreeId ?? null;

          interface PanelRestoreTaskEntry {
            priority: number;
            isPty: boolean;
            execute: () => Promise<void>;
          }

          const panelTasks: PanelRestoreTaskEntry[] = [];

          for (const saved of appState.terminals) {
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
              let inferredKind: TerminalKind = saved.kind ?? "terminal";
              if (!saved.kind) {
                if (saved.browserUrl !== undefined) {
                  inferredKind = "browser";
                } else if (saved.notePath !== undefined || saved.noteId !== undefined) {
                  inferredKind = "notes";
                } else if (saved.title === "Assistant" || saved.title?.startsWith("Assistant")) {
                  inferredKind = "assistant";
                } else if (!saved.cwd && !saved.command) {
                  inferredKind = "assistant";
                }
              }
              taskIsPty = inferredKind === "assistant" ? false : panelKindHasPty(inferredKind);
            }

            panelTasks.push({
              priority,
              isPty: taskIsPty,
              execute: async () => {
                if (backendTerminal) {
                  // PTY terminal - reconnect to existing backend process
                  logHydrationInfo(`Reconnecting to terminal: ${saved.id}`);

                  const cwd = backendTerminal.cwd || projectRoot || "";
                  const currentAgentState = backendTerminal.agentState;
                  const backendLastStateChange = backendTerminal.lastStateChange;
                  let agentId =
                    backendTerminal.agentId ??
                    (backendTerminal.type && isRegisteredAgent(backendTerminal.type)
                      ? backendTerminal.type
                      : undefined);

                  if (!agentId && backendTerminal.kind === "agent") {
                    const titleLower = (backendTerminal.title ?? "").toLowerCase();
                    if (titleLower.includes("claude")) {
                      agentId = "claude";
                    } else if (titleLower.includes("gemini")) {
                      agentId = "gemini";
                    } else if (titleLower.includes("codex")) {
                      agentId = "codex";
                    } else if (titleLower.includes("opencode")) {
                      agentId = "opencode";
                    } else {
                      logWarn(
                        `Backend agent terminal ${backendTerminal.id} missing agentId and title doesn't match known agents: "${backendTerminal.title}"`
                      );
                    }
                  }

                  const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";

                  logHydrationInfo(`[HYDRATION] Adding terminal from backend:`, {
                    id: backendTerminal.id,
                    kind: backendTerminal.kind ?? (agentId ? "agent" : "terminal"),
                    agentId,
                    location,
                    worktreeId: backendTerminal.worktreeId,
                    title: backendTerminal.title,
                  });

                  const isDevPreview = backendTerminal.kind === "dev-preview";
                  const devCommand = isDevPreview ? saved.command?.trim() : undefined;
                  const restoredTerminalId = await addTerminal({
                    kind: backendTerminal.kind ?? (agentId ? "agent" : "terminal"),
                    type: backendTerminal.type,
                    agentId,
                    title: backendTerminal.title,
                    cwd,
                    worktreeId: backendTerminal.worktreeId,
                    location,
                    existingId: backendTerminal.id,
                    agentState: currentAgentState,
                    lastStateChange: backendLastStateChange,
                    devCommand,
                    browserUrl: isDevPreview ? saved.browserUrl : undefined,
                    browserHistory: isDevPreview ? saved.browserHistory : undefined,
                    browserZoom: isDevPreview ? saved.browserZoom : undefined,
                    devPreviewConsoleOpen: isDevPreview ? saved.devPreviewConsoleOpen : undefined,
                    exitBehavior: saved.exitBehavior,
                    agentSessionId: saved.agentSessionId,
                    agentLaunchFlags: saved.agentLaunchFlags,
                  });

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

                  const shouldSkipSnapshotRestore =
                    Boolean(_switchId) &&
                    Boolean(currentProjectId) &&
                    isTerminalWarmInProjectSwitchCache(currentProjectId, backendTerminal.id) &&
                    Boolean(terminalInstanceService.get(backendTerminal.id));

                  if (!shouldSkipSnapshotRestore) {
                    restoreTasks.push({
                      terminalId: restoredTerminalId,
                      label: saved.id,
                      worktreeId: backendTerminal.worktreeId,
                      location,
                    });
                  }

                  backendTerminalMap.delete(saved.id);
                } else {
                  let kind: TerminalKind = saved.kind ?? "terminal";
                  if (!saved.kind) {
                    if (saved.browserUrl !== undefined) {
                      kind = "browser";
                    } else if (saved.notePath !== undefined || saved.noteId !== undefined) {
                      kind = "notes";
                    } else if (
                      saved.title === "Assistant" ||
                      saved.title?.startsWith("Assistant")
                    ) {
                      kind = "assistant";
                    } else if (!saved.cwd && !saved.command) {
                      kind = "assistant";
                    }
                  }

                  if (kind === "assistant") {
                    logHydrationInfo(`Skipping legacy assistant panel: ${saved.id}`);
                    return;
                  }

                  const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";

                  if (panelKindHasPty(kind)) {
                    let reconnectedTerminal: Awaited<
                      ReturnType<typeof terminalClient.reconnect>
                    > | null = null;
                    let reconnectTimedOut = false;

                    try {
                      logHydrationInfo(`Trying reconnect fallback for ${saved.id} (kind: ${kind})`);

                      const reconnectPromise = terminalClient.reconnect(saved.id);
                      const timeoutPromise = new Promise<null>((_, reject) =>
                        setTimeout(
                          () => reject(new Error("Reconnection timeout")),
                          RECONNECT_TIMEOUT_MS
                        )
                      );

                      reconnectedTerminal = await Promise.race([reconnectPromise, timeoutPromise]);

                      if (reconnectedTerminal?.exists && reconnectedTerminal.hasPty) {
                        logHydrationInfo(
                          `Reconnect fallback succeeded for ${saved.id} - terminal exists in backend but was missed by getForProject`
                        );
                      } else {
                        logHydrationInfo(
                          `Reconnect fallback: terminal ${saved.id} not found (exists=${reconnectedTerminal?.exists}, hasPty=${reconnectedTerminal?.hasPty})`
                        );
                      }
                    } catch (reconnectError) {
                      const isTimeout =
                        reconnectError instanceof Error &&
                        reconnectError.message === "Reconnection timeout";
                      reconnectTimedOut = isTimeout;

                      if (isTimeout) {
                        logWarn(
                          `Reconnect timed out for ${saved.id} after ${RECONNECT_TIMEOUT_MS}ms`
                        );
                      } else {
                        logWarn(`Reconnect fallback failed for ${saved.id}`, {
                          error: reconnectError,
                        });
                      }
                      reconnectedTerminal = null;
                    }

                    if (reconnectedTerminal?.exists && reconnectedTerminal.hasPty) {
                      const cwd = reconnectedTerminal.cwd || saved.cwd || projectRoot || "";
                      const currentAgentState = reconnectedTerminal.agentState;
                      const backendLastStateChange = reconnectedTerminal.lastStateChange;
                      let agentId =
                        reconnectedTerminal.agentId ??
                        saved.agentId ??
                        (reconnectedTerminal.type && isRegisteredAgent(reconnectedTerminal.type)
                          ? reconnectedTerminal.type
                          : saved.type && isRegisteredAgent(saved.type)
                            ? saved.type
                            : undefined);

                      const reconnectedKind = reconnectedTerminal.kind ?? saved.kind;
                      if (!agentId && reconnectedKind === "agent") {
                        const title = reconnectedTerminal.title ?? saved.title ?? "";
                        const titleLower = title.toLowerCase();
                        if (titleLower.includes("claude")) {
                          agentId = "claude";
                        } else if (titleLower.includes("gemini")) {
                          agentId = "gemini";
                        } else if (titleLower.includes("codex")) {
                          agentId = "codex";
                        } else if (titleLower.includes("opencode")) {
                          agentId = "opencode";
                        } else {
                          logWarn(
                            `Reconnected agent panel ${saved.id} missing agentId and title doesn't match known agents: "${title}"`
                          );
                        }
                      }

                      const isDevPreview = reconnectedKind === "dev-preview";
                      const devCommand = isDevPreview ? saved.command?.trim() : undefined;
                      const restoredTerminalId = await addTerminal({
                        kind: reconnectedKind ?? (agentId ? "agent" : "terminal"),
                        type: reconnectedTerminal.type ?? saved.type,
                        agentId,
                        title: reconnectedTerminal.title ?? saved.title,
                        cwd,
                        worktreeId: reconnectedTerminal.worktreeId ?? saved.worktreeId,
                        location,
                        existingId: reconnectedTerminal.id,
                        agentState: currentAgentState,
                        lastStateChange: backendLastStateChange,
                        devCommand,
                        browserUrl: isDevPreview ? saved.browserUrl : undefined,
                        browserHistory: isDevPreview ? saved.browserHistory : undefined,
                        browserZoom: isDevPreview ? saved.browserZoom : undefined,
                        devPreviewConsoleOpen: isDevPreview
                          ? saved.devPreviewConsoleOpen
                          : undefined,
                        exitBehavior: saved.exitBehavior,
                        agentSessionId: saved.agentSessionId,
                        agentLaunchFlags: saved.agentLaunchFlags,
                      });

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

                      const shouldSkipSnapshotRestore =
                        Boolean(_switchId) &&
                        Boolean(currentProjectId) &&
                        isTerminalWarmInProjectSwitchCache(currentProjectId, restoredTerminalId) &&
                        Boolean(terminalInstanceService.get(restoredTerminalId));

                      if (!shouldSkipSnapshotRestore) {
                        restoreTasks.push({
                          terminalId: restoredTerminalId,
                          label: saved.id,
                          worktreeId: reconnectedTerminal.worktreeId ?? saved.worktreeId,
                          location,
                        });
                      }
                    } else {
                      let effectiveAgentId =
                        saved.agentId ??
                        (saved.type && isRegisteredAgent(saved.type) ? saved.type : undefined);

                      if (!effectiveAgentId && kind === "agent") {
                        const titleLower = (saved.title ?? "").toLowerCase();
                        if (titleLower.includes("claude")) {
                          effectiveAgentId = "claude";
                        } else if (titleLower.includes("gemini")) {
                          effectiveAgentId = "gemini";
                        } else if (titleLower.includes("codex")) {
                          effectiveAgentId = "codex";
                        } else if (titleLower.includes("opencode")) {
                          effectiveAgentId = "opencode";
                        } else {
                          logWarn(
                            `Agent panel ${saved.id} missing agentId and title doesn't match known agents: "${saved.title}" - respawning as terminal`
                          );
                        }
                      }

                      const isAgentPanel = kind === "agent" || Boolean(effectiveAgentId);
                      const agentId = effectiveAgentId;
                      let command = saved.command?.trim() || undefined;

                      if (agentId) {
                        if (saved.agentSessionId) {
                          const resumeCmd = buildResumeCommand(
                            agentId,
                            saved.agentSessionId,
                            saved.agentLaunchFlags
                          );
                          if (resumeCmd) {
                            command = resumeCmd;
                          } else if (agentSettings) {
                            const agentConfig = getAgentConfig(agentId);
                            const baseCommand = agentConfig?.command || agentId;
                            command = generateAgentCommand(
                              baseCommand,
                              agentSettings.agents?.[agentId] ?? {},
                              agentId,
                              { clipboardDirectory }
                            );
                          }
                        } else if (agentSettings) {
                          const agentConfig = getAgentConfig(agentId);
                          const baseCommand = agentConfig?.command || agentId;
                          command = generateAgentCommand(
                            baseCommand,
                            agentSettings.agents?.[agentId] ?? {},
                            agentId,
                            { clipboardDirectory }
                          );
                        }
                      }

                      const respawnKind = isAgentPanel ? "agent" : kind;
                      const isDevPreview = kind === "dev-preview";

                      logHydrationInfo(
                        `Respawning PTY panel: ${saved.id} (${isAgentPanel ? "agent" : "terminal"})`
                      );

                      logHydrationInfo(`[HYDRATION-RESPAWN] Adding terminal:`, {
                        id: saved.id,
                        kind: respawnKind,
                        agentId,
                        location,
                        savedLocation: saved.location,
                        worktreeId: saved.worktreeId,
                        title: saved.title,
                      });

                      const restoredTerminalId = await addTerminal({
                        kind: respawnKind,
                        type: saved.type,
                        agentId,
                        title: saved.title,
                        cwd: saved.cwd || projectRoot || "",
                        worktreeId: saved.worktreeId,
                        location,
                        requestedId: reconnectTimedOut ? undefined : saved.id,
                        command: isAgentPanel ? command : saved.command?.trim() || undefined,
                        isInputLocked: saved.isInputLocked,
                        devCommand: isDevPreview ? command : undefined,
                        browserUrl: isDevPreview ? saved.browserUrl : undefined,
                        browserHistory: isDevPreview ? saved.browserHistory : undefined,
                        browserZoom: isDevPreview ? saved.browserZoom : undefined,
                        devPreviewConsoleOpen: isDevPreview
                          ? saved.devPreviewConsoleOpen
                          : undefined,
                        exitBehavior: isAgentPanel ? undefined : saved.exitBehavior,
                        agentLaunchFlags: saved.agentLaunchFlags,
                        restore: true,
                      });

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
                    logHydrationInfo(`Recreating ${kind} panel: ${saved.id}`);

                    const devCommandCandidate =
                      kind === "dev-preview" ? saved.devCommand?.trim() : undefined;
                    const devCommand =
                      kind === "dev-preview"
                        ? devCommandCandidate || saved.command?.trim() || undefined
                        : undefined;

                    await addTerminal({
                      kind,
                      title: saved.title,
                      cwd: saved.cwd || projectRoot || "",
                      worktreeId: saved.worktreeId,
                      location,
                      requestedId: saved.id,
                      browserUrl: saved.browserUrl,
                      browserHistory: saved.browserHistory,
                      browserZoom: saved.browserZoom,
                      browserConsoleOpen: kind === "browser" ? saved.browserConsoleOpen : undefined,
                      notePath: saved.notePath,
                      noteId: saved.noteId,
                      scope: saved.scope as "worktree" | "project" | undefined,
                      createdAt: saved.createdAt,
                      devCommand,
                      devPreviewConsoleOpen:
                        kind === "dev-preview" ? saved.devPreviewConsoleOpen : undefined,
                      exitBehavior: saved.exitBehavior,
                    });
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

          // Restore all non-PTY panels concurrently (browser, notes, dev-preview).
          // These only perform synchronous store mutations, so no throttling is needed.
          if (nonPtyTasks.length > 0) {
            logHydrationInfo(`Restoring ${nonPtyTasks.length} non-PTY panel(s) concurrently`);
            await Promise.allSettled(
              nonPtyTasks.map(async (task) => {
                try {
                  await task.execute();
                } catch (error) {
                  logWarn("Failed to restore non-PTY panel", { error });
                }
              })
            );
          }

          if (!checkCurrent()) return;

          // Restore priority PTY panels sequentially (active worktree, for instant interactivity)
          for (const task of ptyPriorityTasks) {
            try {
              await task.execute();
            } catch (error) {
              logWarn("Failed to restore priority panel", { error });
            }
          }

          if (!checkCurrent()) return;

          // Restore background PTY panels in staggered batches
          if (ptyBackgroundTasks.length > 0) {
            logHydrationInfo(
              `Staggering ${ptyBackgroundTasks.length} background PTY panel(s) in batches of ${RESTORE_SPAWN_BATCH_SIZE}`
            );
            await runInBatches(
              ptyBackgroundTasks,
              RESTORE_SPAWN_BATCH_SIZE,
              RESTORE_SPAWN_BATCH_DELAY_MS,
              async (task) => {
                try {
                  await task.execute();
                } catch (error) {
                  logWarn("Failed to restore background panel", { error });
                }
              }
            );
          }
        }

        if (!checkCurrent()) return;

        // Restore any orphaned backend terminals not in saved state (append at end)
        const orphanedTerminals = Array.from(backendTerminalMap.values());
        if (orphanedTerminals.length > 0) {
          logHydrationInfo(
            `${orphanedTerminals.length} orphaned terminal(s) not in saved order, appending at end`
          );

          await runInBatches(
            orphanedTerminals,
            RESTORE_SPAWN_BATCH_SIZE,
            RESTORE_SPAWN_BATCH_DELAY_MS,
            async (terminal) => {
              try {
                logHydrationInfo(`Reconnecting to orphaned terminal: ${terminal.id}`);

                const cwd = terminal.cwd || projectRoot || "";
                const currentAgentState = terminal.agentState;
                const backendLastStateChange = terminal.lastStateChange;
                let agentId =
                  terminal.agentId ??
                  (terminal.type && isRegisteredAgent(terminal.type) ? terminal.type : undefined);

                if (!agentId && terminal.kind === "agent") {
                  const titleLower = (terminal.title ?? "").toLowerCase();
                  if (titleLower.includes("claude")) {
                    agentId = "claude";
                  } else if (titleLower.includes("gemini")) {
                    agentId = "gemini";
                  } else if (titleLower.includes("codex")) {
                    agentId = "codex";
                  } else if (titleLower.includes("opencode")) {
                    agentId = "opencode";
                  } else {
                    logWarn(
                      `Orphaned agent terminal ${terminal.id} missing agentId and title doesn't match known agents: "${terminal.title}"`
                    );
                  }
                }

                const restoredTerminalId = await addTerminal({
                  kind: terminal.kind ?? (agentId ? "agent" : "terminal"),
                  type: terminal.type,
                  agentId,
                  title: terminal.title,
                  cwd,
                  worktreeId: terminal.worktreeId,
                  location: "grid",
                  existingId: terminal.id,
                  agentState: currentAgentState,
                  lastStateChange: backendLastStateChange,
                });

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

                const shouldSkipSnapshotRestore =
                  Boolean(_switchId) &&
                  Boolean(currentProjectId) &&
                  isTerminalWarmInProjectSwitchCache(currentProjectId, terminal.id) &&
                  Boolean(terminalInstanceService.get(terminal.id));

                if (!shouldSkipSnapshotRestore) {
                  restoreTasks.push({
                    terminalId: restoredTerminalId,
                    label: terminal.id,
                    worktreeId: terminal.worktreeId,
                    location: "grid",
                  });
                }
              } catch (error) {
                logWarn(`Failed to reconnect to orphaned terminal ${terminal.id}`, { error });
              }
            }
          );
        }

        const { criticalTasks, deferredTasks } = splitSnapshotRestoreTasks(
          restoreTasks,
          appState.activeWorktreeId ?? null,
          shouldDeferSnapshotRestore
        );

        await withRendererSpan(
          PERF_MARKS.HYDRATE_RESTORE_SNAPSHOTS_CRITICAL,
          () => restoreTerminalSnapshots(criticalTasks, checkCurrent, _switchId ?? undefined),
          { switchId: _switchId ?? null, criticalCount: criticalTasks.length }
        );
        if (!checkCurrent()) return;

        if (deferredTasks.length > 0) {
          markRendererPerformance("hydrate_restore_snapshots_deferred_scheduled", {
            deferredSnapshotCount: deferredTasks.length,
            switchId: _switchId ?? null,
          });

          scheduleDeferredSnapshotRestore(async () => {
            if (!checkCurrent()) return;
            await restoreTerminalSnapshots(deferredTasks, checkCurrent, _switchId ?? undefined);
            if (!checkCurrent()) return;

            markRendererPerformance("hydrate_restore_snapshots_deferred_complete", {
              deferredSnapshotCount: deferredTasks.length,
              switchId: _switchId ?? null,
            });
          });
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
      const { cleanupOrphanedTerminals } = await import("@/store/worktreeDataStore");
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
        const fallbackWorktree = sortedWorktrees[0];
        logHydrationInfo(
          `Active worktree ${savedActiveId ?? "(none)"} not found, falling back to: ${fallbackWorktree.name}`
        );
        setActiveWorktree(fallbackWorktree.id);
      }
    }
    // If no worktrees exist, we don't set any active worktree (handled gracefully)

    // Recipe load starts earlier to overlap with hydration work.
    // During project switch we don't block switch completion on recipes.
    if (recipeLoadPromise) {
      if (_switchId) {
        void recipeLoadPromise;
      } else {
        await recipeLoadPromise;
      }
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
  }
}
