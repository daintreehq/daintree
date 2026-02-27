import { appClient, terminalClient, worktreeClient, projectClient } from "@/clients";
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
import { generateAgentFlags } from "@shared/types";
import { normalizeScrollbackLines } from "@shared/config/scrollback";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { isTerminalWarmInProjectSwitchCache } from "@/services/projectSwitchRendererCache";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { logDebug, logInfo, logWarn, logError } from "@/utils/logger";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "@/utils/performance";

const RECONNECT_TIMEOUT_MS = 10000;
const RESTORE_CONCURRENCY = 8;
const DEFERRED_RESTORE_IDLE_TIMEOUT_MS = 1200;
const DEFERRED_RESTORE_FALLBACK_DELAY_MS = 32;

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

async function restoreTerminalSnapshots(
  tasks: TerminalRestoreTask[],
  isCurrent: () => boolean
): Promise<void> {
  if (tasks.length === 0) {
    return;
  }

  let serializedStateBatch: Record<string, string | null> | null = null;
  try {
    serializedStateBatch = await terminalClient.getSerializedStates(
      tasks.map((task) => task.terminalId)
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
    devPreviewConsoleOpen?: boolean;
    exitBehavior?: import("@shared/types/domain").PanelExitBehavior;
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

  try {
    await ensureHydrationBootstrap();
    if (!checkCurrent()) return;

    // Batch fetch initial state
    const {
      appState,
      terminalConfig,
      project: currentProject,
      agentSettings,
    } = await appClient.hydrate();
    if (!checkCurrent()) return;

    // Hydrate terminal config (scrollback, performance mode) BEFORE restoring terminals
    try {
      if (terminalConfig?.scrollbackLines !== undefined) {
        const { scrollbackLines } = terminalConfig;
        const normalizedScrollback = normalizeScrollbackLines(scrollbackLines);

        if (normalizedScrollback !== scrollbackLines) {
          logInfo(`Normalizing scrollback from ${scrollbackLines} to ${normalizedScrollback}`);
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
        const backendTerminals = await terminalClient.getForProject(currentProjectId);
        if (!checkCurrent()) return;

        logInfo(
          `Found ${backendTerminals.length} running terminals for project ${currentProjectId}`
        );

        if (
          typeof process !== "undefined" &&
          typeof process.env !== "undefined" &&
          process.env.CANOPY_VERBOSE === "1"
        ) {
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
          logInfo(`Restoring ${appState.terminals.length} saved panel(s)`);

          for (const saved of appState.terminals) {
            try {
              const backendTerminal = backendTerminalMap.get(saved.id);

              if (backendTerminal) {
                // PTY terminal - reconnect to existing backend process
                logInfo(`Reconnecting to terminal: ${saved.id}`);

                const cwd = backendTerminal.cwd || projectRoot || "";
                const currentAgentState = backendTerminal.agentState;
                const backendLastStateChange = backendTerminal.lastStateChange;
                let agentId =
                  backendTerminal.agentId ??
                  (backendTerminal.type && isRegisteredAgent(backendTerminal.type)
                    ? backendTerminal.type
                    : undefined);

                // If kind is "agent" but agentId is missing, try to infer from title
                // Only set a default if we can confidently match, otherwise leave undefined
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
                    // Don't force a default - leave undefined if we can't match
                    logWarn(
                      `Backend agent terminal ${backendTerminal.id} missing agentId and title doesn't match known agents: "${backendTerminal.title}"`
                    );
                  }
                }

                const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";

                logInfo(`[HYDRATION] Adding terminal from backend:`, {
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
                });

                // Initialize frontend tier state from backend to ensure proper wake behavior
                // after project switch. Without this, frontend defaults to "active" which prevents
                // proper wake when transitioning from background to active tier.
                if (backendTerminal.activityTier) {
                  terminalInstanceService.initializeBackendTier(
                    restoredTerminalId,
                    backendTerminal.activityTier
                  );
                }

                // Restore terminal dimensions if available
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

                // Mark as restored
                backendTerminalMap.delete(saved.id);
              } else {
                // Non-PTY panel or PTY panel that no longer exists in backend - try to recreate
                // Infer kind from panel properties if missing (defense-in-depth for legacy data)
                // Note: TerminalSnapshot uses 'command' field for both regular terminals and dev-preview.
                // Without 'kind', we can't distinguish them, so we default to 'terminal'.
                let kind: TerminalKind = saved.kind ?? "terminal";
                if (!saved.kind) {
                  if (saved.browserUrl !== undefined) {
                    kind = "browser";
                  } else if (saved.notePath !== undefined || saved.noteId !== undefined) {
                    kind = "notes";
                  } else if (saved.title === "Assistant" || saved.title?.startsWith("Assistant")) {
                    // Legacy assistant panels from before kind was always set - skip these
                    // Match "Assistant", "Assistant (renamed)", etc.
                    kind = "assistant";
                  } else if (!saved.cwd && !saved.command) {
                    // Non-PTY panel with no PTY markers and not browser/notes - likely legacy assistant
                    kind = "assistant";
                  }
                  // Note: dev-preview detection removed since 'devCommand' isn't in TerminalSnapshot.
                  // Dev-preview panels should always have 'kind' set during persistence.
                }

                // Skip assistant panels (they're now global, not panel-based)
                if (kind === "assistant") {
                  console.log(`[StateHydration] Skipping legacy assistant panel: ${saved.id}`);
                  continue;
                }

                const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";

                if (panelKindHasPty(kind)) {
                  // RECONNECT FALLBACK: Before respawning, try to reconnect directly by ID.
                  // This handles cases where getForProject missed the terminal due to project
                  // ID mismatch or stale project association. The terminal may still be running
                  // in the backend but wasn't returned by getForProject.
                  // Uses panelKindHasPty to include dev-preview panels which have PTY processes.
                  let reconnectedTerminal: Awaited<
                    ReturnType<typeof terminalClient.reconnect>
                  > | null = null;
                  let reconnectTimedOut = false;

                  try {
                    // Always log reconnect attempts to help diagnose project switch issues
                    logInfo(`Trying reconnect fallback for ${saved.id} (kind: ${kind})`);

                    // Race reconnect against timeout to prevent indefinite waiting
                    const reconnectPromise = terminalClient.reconnect(saved.id);
                    const timeoutPromise = new Promise<null>((_, reject) =>
                      setTimeout(
                        () => reject(new Error("Reconnection timeout")),
                        RECONNECT_TIMEOUT_MS
                      )
                    );

                    reconnectedTerminal = await Promise.race([reconnectPromise, timeoutPromise]);

                    if (reconnectedTerminal?.exists && reconnectedTerminal.hasPty) {
                      logInfo(
                        `Reconnect fallback succeeded for ${saved.id} - terminal exists in backend but was missed by getForProject`
                      );
                    } else {
                      logInfo(
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
                    // Terminal exists in backend - reconnect instead of respawning
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

                    // If kind is "agent" but agentId is missing, try to infer from title
                    // Only set if we can confidently match, otherwise leave undefined
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
                        // Don't force a default - leave undefined if we can't match
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
                      devPreviewConsoleOpen: isDevPreview ? saved.devPreviewConsoleOpen : undefined,
                      exitBehavior: saved.exitBehavior,
                    });

                    // Initialize frontend tier state from backend
                    if (reconnectedTerminal.activityTier) {
                      terminalInstanceService.initializeBackendTier(
                        restoredTerminalId,
                        reconnectedTerminal.activityTier
                      );
                    }

                    // Restore terminal dimensions if available
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
                    // Terminal doesn't exist in backend or timed out - respawn
                    let effectiveAgentId =
                      saved.agentId ??
                      (saved.type && isRegisteredAgent(saved.type) ? saved.type : undefined);

                    // If kind is "agent" but we couldn't determine agentId, try to infer from title
                    // This handles cases where agentId wasn't persisted (legacy data or bug)
                    // WARNING: For respawn path, only set agentId if we can confidently match
                    // Otherwise we'll regenerate the wrong command
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
                        // Don't force a default for respawn - we'll generate wrong command
                        // Keep kind as "terminal" instead
                        logWarn(
                          `Agent panel ${saved.id} missing agentId and title doesn't match known agents: "${saved.title}" - respawning as terminal`
                        );
                      }
                    }

                    const isAgentPanel = kind === "agent" || Boolean(effectiveAgentId);
                    const agentId = effectiveAgentId;
                    let command = saved.command?.trim() || undefined;

                    if (agentId && agentSettings) {
                      const agentConfig = getAgentConfig(agentId);
                      const baseCommand = agentConfig?.command || agentId;
                      const flags = generateAgentFlags(
                        agentSettings.agents?.[agentId] ?? {},
                        agentId
                      );
                      command =
                        flags.length > 0 ? `${baseCommand} ${flags.join(" ")}` : baseCommand;
                    }

                    // Preserve the original kind (dev-preview, terminal, etc.) unless it's an agent
                    const respawnKind = isAgentPanel ? "agent" : kind;
                    const isDevPreview = kind === "dev-preview";

                    // Silently spawn a fresh session for all terminal types
                    // No error messages - just start fresh
                    logInfo(
                      `Respawning PTY panel: ${saved.id} (${isAgentPanel ? "agent" : "terminal"})`
                    );

                    logInfo(`[HYDRATION-RESPAWN] Adding terminal:`, {
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
                      // Don't reuse ID on timeout - could kill a slow-to-respond live session
                      requestedId: reconnectTimedOut ? undefined : saved.id,
                      command: isAgentPanel ? command : saved.command?.trim() || undefined,
                      // Execute command at spawn for all agents (grid and dock)
                      // Docked agents just run in background - same behavior, different location
                      isInputLocked: saved.isInputLocked,
                      devCommand: isDevPreview ? command : undefined,
                      browserUrl: isDevPreview ? saved.browserUrl : undefined,
                      browserHistory: isDevPreview ? saved.browserHistory : undefined,
                      browserZoom: isDevPreview ? saved.browserZoom : undefined,
                      devPreviewConsoleOpen: isDevPreview ? saved.devPreviewConsoleOpen : undefined,
                      exitBehavior: isAgentPanel ? undefined : saved.exitBehavior,
                    });

                    // Restore terminal dimensions if available
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
                  logInfo(`Recreating ${kind} panel: ${saved.id}`);

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
            } catch (error) {
              logWarn(`Failed to restore panel ${saved.id}`, { error });
            }
          }
        }

        // Restore any orphaned backend terminals not in saved state (append at end)
        const orphanedTerminals = Array.from(backendTerminalMap.values());
        if (orphanedTerminals.length > 0) {
          logInfo(
            `${orphanedTerminals.length} orphaned terminal(s) not in saved order, appending at end`
          );

          for (const terminal of orphanedTerminals) {
            try {
              logInfo(`Reconnecting to orphaned terminal: ${terminal.id}`);

              const cwd = terminal.cwd || projectRoot || "";
              const currentAgentState = terminal.agentState;
              const backendLastStateChange = terminal.lastStateChange;
              let agentId =
                terminal.agentId ??
                (terminal.type && isRegisteredAgent(terminal.type) ? terminal.type : undefined);

              // If kind is "agent" but agentId is missing, try to infer from title
              // Only set if we can confidently match, otherwise leave undefined
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
                  // Don't force a default - leave undefined if we can't match
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

              // Initialize frontend tier state from backend to ensure proper wake behavior
              if (terminal.activityTier) {
                terminalInstanceService.initializeBackendTier(
                  restoredTerminalId,
                  terminal.activityTier
                );
              }

              // Restore terminal dimensions if available
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
        }

        const { criticalTasks, deferredTasks } = splitSnapshotRestoreTasks(
          restoreTasks,
          appState.activeWorktreeId ?? null,
          shouldDeferSnapshotRestore
        );

        await restoreTerminalSnapshots(criticalTasks, checkCurrent);
        if (!checkCurrent()) return;

        if (deferredTasks.length > 0) {
          markRendererPerformance("hydrate_restore_snapshots_deferred_scheduled", {
            deferredSnapshotCount: deferredTasks.length,
            switchId: _switchId ?? null,
          });

          scheduleDeferredSnapshotRestore(async () => {
            if (!checkCurrent()) return;
            await restoreTerminalSnapshots(deferredTasks, checkCurrent);
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
              logInfo(`Restoring ${tabGroups.length} tab group(s)`);
            } else {
              logInfo("Clearing stale tab groups (no groups for project)");
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
        logInfo(
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
  } catch (error) {
    logError("Failed to hydrate app state", error);
    throw error;
  } finally {
    markRendererPerformance(PERF_MARKS.HYDRATE_COMPLETE, {
      switchId: _switchId ?? null,
      durationMs: Date.now() - hydrationStartedAt,
      panelCount: panelRestoreCount,
      tabGroupCount: tabGroupRestoreCount,
    });
  }
}
