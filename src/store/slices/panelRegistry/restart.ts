import type { PanelLocation } from "@/types";
import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import { terminalClient, agentSettingsClient, projectClient, systemClient } from "@/clients";
import {
  generateAgentCommand,
  buildAgentLaunchFlags,
  buildResumeCommand,
  buildLaunchCommandFromFlags,
} from "@shared/types";
import type { AgentSettingsEntry } from "@shared/types/agentSettings";
import type { AgentState } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { validateTerminalConfig } from "@/utils/terminalValidation";
import { getAgentConfig } from "@/config/agents";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { markTerminalRestarting, unmarkTerminalRestarting } from "@/store/restartExitSuppression";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";
import { saveNormalized } from "./persistence";
import { optimizeForDock } from "./layout";
import { deriveRuntimeStatus } from "./helpers";
import { logDebug, logWarn, logError } from "@/utils/logger";
import {
  buildAgentLaunchFlagsForRuntimeSettings,
  mergePresetArgsIntoLaunchFlags,
  resolveAgentRuntimeSettings,
  type AgentRuntimeSettingsResolution,
} from "@/utils/agentRuntimeSettings";
import { formatErrorMessage } from "@shared/utils/errorMessage";

// Lazy accessor to break circular dependency: restart -> projectStore -> panelPersistence -> core.
let _cachedProjectStore: typeof import("@/store/projectStore").useProjectStore | null = null;
async function resolveProjectStore() {
  if (!_cachedProjectStore) {
    const mod = await import("@/store/projectStore");
    _cachedProjectStore = mod.useProjectStore;
  }
  return _cachedProjectStore;
}

type Set = PanelRegistryStoreApi["setState"];
type Get = PanelRegistryStoreApi["getState"];

const INJECTION_TIMEOUT_MS = 30_000;

interface LoadedAgentRuntimeSettings {
  entry: AgentSettingsEntry;
  settings: AgentRuntimeSettingsResolution;
  tmpDir: string;
}

function mergeSpawnEnv(
  globalEnv: Record<string, string>,
  projectEnv: Record<string, string>,
  runtimeEnv: Record<string, string> | undefined
): Record<string, string> | undefined {
  const hasAny =
    Object.keys(globalEnv).length > 0 ||
    Object.keys(projectEnv).length > 0 ||
    Boolean(runtimeEnv && Object.keys(runtimeEnv).length > 0);
  return hasAny ? { ...globalEnv, ...projectEnv, ...(runtimeEnv ?? {}) } : undefined;
}

async function fetchGlobalEnv(): Promise<Record<string, string>> {
  if (typeof window === "undefined" || !window.electron?.globalEnv?.get) {
    return {};
  }
  return window.electron.globalEnv.get().catch((error: unknown) => {
    logWarn("[TerminalStore] Failed to fetch global environment variables", { error });
    return {} as Record<string, string>;
  });
}

async function buildRestartEnv(
  projectId: string | undefined,
  runtimeEnv: Record<string, string> | undefined,
  context: string
): Promise<Record<string, string> | undefined> {
  const [globalEnv, projectEnv] = await Promise.all([
    fetchGlobalEnv(),
    projectId
      ? projectClient
          .getSettings(projectId)
          .then((settings) => settings?.environmentVariables ?? ({} as Record<string, string>))
          .catch((error: unknown) => {
            logWarn(`[TerminalStore] Failed to fetch project env for ${context}`, { error });
            return {} as Record<string, string>;
          })
      : Promise.resolve({} as Record<string, string>),
  ]);
  return mergeSpawnEnv(globalEnv, projectEnv, runtimeEnv);
}

function scheduleHistoryInjection(id: string, history: string, worktreePath: string): void {
  const prompt = [
    "Here is the conversation history from your previous session in a different worktree:\n",
    "<previous-session-history>",
    history,
    "</previous-session-history>\n",
    `You have been moved to a new git worktree at ${worktreePath}. Continue where you left off.`,
  ].join("\n");

  let injected = false;
  let unsub: () => void = () => {};

  const inject = () => {
    if (injected) return;
    injected = true;
    unsub();
    terminalClient.submit(id, prompt).catch((err) => {
      logWarn("[TerminalStore] Failed to inject history prompt", { error: err });
    });
  };

  const timeout = setTimeout(() => {
    inject();
  }, INJECTION_TIMEOUT_MS);

  unsub = terminalInstanceService.addAgentStateListener(id, (state: AgentState) => {
    if (state === "idle" || state === "waiting") {
      clearTimeout(timeout);
      inject();
    }
  });
}

// Helper to update a single terminal field in the normalized store
function updateTerminal(
  state: PanelRegistrySlice,
  id: string,
  updater: (t: PanelRegistrySlice["panelsById"][string]) => PanelRegistrySlice["panelsById"][string]
): { panelsById: Record<string, PanelRegistrySlice["panelsById"][string]> } | typeof state {
  const terminal = state.panelsById[id];
  if (!terminal) return state;
  return { panelsById: { ...state.panelsById, [id]: updater(terminal) } };
}

export const createRestartActions = (
  set: Set,
  get: Get
): Pick<
  PanelRegistrySlice,
  | "restartTerminal"
  | "clearTerminalError"
  | "updateTerminalCwd"
  | "moveTerminalToWorktree"
  | "moveToNewWorktreeAndTransfer"
  | "updateFlowStatus"
  | "setRuntimeStatus"
  | "setInputLocked"
  | "toggleInputLocked"
  | "activateFallbackPreset"
> => ({
  restartTerminal: async (id) => {
    const terminal = get().panelsById[id];

    if (!terminal) {
      logWarn("[TerminalStore] Cannot restart: terminal not found", { id });
      return;
    }

    // Non-PTY panels don't have PTY processes to restart
    if (!panelKindHasPty(terminal.kind ?? "terminal")) {
      logWarn("[TerminalStore] Cannot restart non-PTY panel", { id });
      return;
    }

    // Guard against concurrent restart attempts
    if (terminal.isRestarting) {
      logWarn("[TerminalStore] Terminal is already restarting, ignoring", { id });
      return;
    }

    // Mark as restarting SYNCHRONOUSLY first to prevent exit event race condition.
    // This is checked in the onExit handler before the store state.
    markTerminalRestarting(id);

    // Also set the store flag for UI and other consumers
    set((state) =>
      updateTerminal(state, id, (t) => ({
        ...t,
        restartError: undefined,
        reconnectError: undefined,
        spawnError: undefined,
        isRestarting: true,
      }))
    );

    // Validate configuration before attempting restart
    let validation;
    try {
      validation = await validateTerminalConfig(terminal);
    } catch (error) {
      // Validation itself failed (e.g., IPC error)
      const restartError = {
        message: "Failed to validate terminal configuration",
        timestamp: Date.now(),
        recoverable: false,
        context: {
          failedCwd: terminal.cwd,
          validationError: formatErrorMessage(error, "Failed to validate terminal configuration"),
        },
      };

      unmarkTerminalRestarting(id);
      set((state) =>
        updateTerminal(state, id, (t) => ({ ...t, isRestarting: false, restartError }))
      );
      logError("[TerminalStore] Validation error for terminal", error, { id });
      return;
    }

    if (!validation.valid) {
      // Set error state instead of attempting doomed restart
      const primaryError = validation.errors.find((e) => !e.recoverable) || validation.errors[0];

      const restartError = {
        message: validation.errors.map((e) => e.message).join("; "),
        code: primaryError?.code,
        timestamp: Date.now(),
        recoverable: validation.errors.every((e) => e.recoverable),
        context: {
          failedCwd: terminal.cwd,
          errors: validation.errors,
        },
      };

      unmarkTerminalRestarting(id);
      set((state) =>
        updateTerminal(state, id, (t) => ({ ...t, isRestarting: false, restartError }))
      );
      logWarn("[TerminalStore] Restart validation failed for terminal", { id, restartError });
      return;
    }

    // Re-read terminal from state in case it was modified during async validation
    const currentTerminal = get().panelsById[id];

    if (!currentTerminal || currentTerminal.location === "trash") {
      // Terminal was removed or trashed while we were validating
      unmarkTerminalRestarting(id);
      set((state) => updateTerminal(state, id, (t) => ({ ...t, isRestarting: false })));
      logWarn("[TerminalStore] Terminal no longer exists or was trashed", { id });
      return;
    }

    const targetLocation = currentTerminal.location;

    // For agent terminals, regenerate command from current settings
    // For other terminals, use the saved command
    let commandToRun = currentTerminal.command;
    const effectiveAgentId = currentTerminal.launchAgentId;
    // Gate on launch intent (`effectiveAgentId`, derived from the sealed
    // `launchAgentId`) plus two demotion
    // signals:
    //   - `exitCode !== undefined` — the PTY has truly exited (onExit path).
    //   - `agentState === "exited"` — the FSM saw the detected agent quit
    //     to shell; this state is preserved across demoted restarts so
    //     subsequent restarts stay demoted (issue #5764).
    // `panelStoreListeners.onAgentExited` must NOT clear `agentId` — if it
    // did, a cold-launched agent that `/quit`s into its shell would lose its
    // launch identity and relaunch decisions would misclassify. #5807
    const isAgent =
      !!effectiveAgentId &&
      currentTerminal.agentState !== "exited" &&
      currentTerminal.exitCode === undefined;
    const isDemotedAgent = !!effectiveAgentId && !isAgent;
    let loadedRuntimeSettings: LoadedAgentRuntimeSettings | undefined;
    let runtimeSettingsLoaded = false;
    let nextAgentLaunchFlags = currentTerminal.agentLaunchFlags;
    let nextAgentPresetId = currentTerminal.agentPresetId;
    let nextAgentPresetColor = currentTerminal.agentPresetColor;
    let nextOriginalPresetId = currentTerminal.originalPresetId;

    const loadAgentRuntimeSettings = async (): Promise<LoadedAgentRuntimeSettings | undefined> => {
      if (!effectiveAgentId || runtimeSettingsLoaded) return loadedRuntimeSettings;
      runtimeSettingsLoaded = true;
      try {
        const [agentSettings, tmpDir] = await Promise.all([
          agentSettingsClient.get(),
          systemClient.getTmpDir().catch(() => ""),
        ]);
        const entry = (agentSettings?.agents?.[effectiveAgentId] ?? {}) as AgentSettingsEntry;
        const ccrPresets = useCcrPresetsStore.getState().ccrPresetsByAgent[effectiveAgentId];
        const projectPresets = useProjectPresetsStore.getState().presetsByAgent[effectiveAgentId];
        const settings = resolveAgentRuntimeSettings({
          agentId: effectiveAgentId,
          presetId: currentTerminal.agentPresetId,
          entry,
          ccrPresets,
          projectPresets,
        });
        loadedRuntimeSettings = { entry, settings, tmpDir };
        if (settings.presetWasStale) {
          nextAgentPresetId = undefined;
          nextAgentPresetColor = undefined;
          nextOriginalPresetId = undefined;
        } else if (settings.preset) {
          nextAgentPresetColor = settings.preset.color ?? currentTerminal.agentPresetColor;
        }
        return loadedRuntimeSettings;
      } catch (error) {
        logWarn("[TerminalStore] Failed to load agent runtime settings for restart", { error });
        return undefined;
      }
    };

    const runtimeForEnv = effectiveAgentId ? await loadAgentRuntimeSettings() : undefined;
    if (runtimeForEnv?.settings.presetWasStale && effectiveAgentId) {
      nextAgentLaunchFlags = buildAgentLaunchFlagsForRuntimeSettings(
        runtimeForEnv.settings.effectiveEntry,
        effectiveAgentId,
        undefined,
        { modelId: currentTerminal.agentModelId }
      );
    }

    if (isAgent && effectiveAgentId) {
      const presetForLaunchFlags = runtimeForEnv?.settings.preset;
      if (presetForLaunchFlags) {
        nextAgentLaunchFlags = mergePresetArgsIntoLaunchFlags(
          currentTerminal.agentLaunchFlags,
          presetForLaunchFlags
        );
      }
      const sessionId = currentTerminal.agentSessionId;
      if (sessionId) {
        const resumeCmd = buildResumeCommand(effectiveAgentId, sessionId, nextAgentLaunchFlags);
        if (resumeCmd) {
          commandToRun = resumeCmd;
        }
      }

      if (commandToRun === currentTerminal.command) {
        const persistedFlags = nextAgentLaunchFlags;
        let hasPersistedFlags = Boolean(persistedFlags && persistedFlags.length > 0);
        const agentConfig = getAgentConfig(effectiveAgentId);
        const baseCommand = agentConfig?.command || effectiveAgentId;
        const runtimeSettings = runtimeForEnv ?? (await loadAgentRuntimeSettings());
        if (!hasPersistedFlags && runtimeSettings) {
          nextAgentLaunchFlags = buildAgentLaunchFlagsForRuntimeSettings(
            runtimeSettings.settings.effectiveEntry,
            effectiveAgentId,
            runtimeSettings.settings.preset,
            { modelId: currentTerminal.agentModelId }
          );
          hasPersistedFlags = nextAgentLaunchFlags.length > 0;
        }

        if (hasPersistedFlags && effectiveAgentId !== "gemini") {
          // Sync fast path: non-Gemini agents have no runtime-dynamic flag
          // injection, so the persisted flags are the complete command.
          commandToRun = buildLaunchCommandFromFlags(
            baseCommand,
            effectiveAgentId,
            nextAgentLaunchFlags as string[]
          );
        } else {
          // Async path: either Gemini (needs clipboard directory re-injection)
          // or no persisted flags (needs settings-derived fallback).
          try {
            const runtimeSettings = runtimeForEnv ?? (await loadAgentRuntimeSettings());
            const tmpDir = runtimeSettings?.tmpDir ?? "";
            const clipboardDirectory = tmpDir ? `${tmpDir}/daintree-clipboard` : undefined;
            if (hasPersistedFlags) {
              const entry = runtimeSettings?.entry;
              const shareClipboardDirectory = entry?.shareClipboardDirectory as boolean | undefined;
              commandToRun = buildLaunchCommandFromFlags(
                baseCommand,
                effectiveAgentId,
                nextAgentLaunchFlags as string[],
                { clipboardDirectory, shareClipboardDirectory }
              );
            } else if (runtimeSettings) {
              commandToRun = generateAgentCommand(
                baseCommand,
                runtimeSettings.settings.effectiveEntry,
                effectiveAgentId,
                {
                  clipboardDirectory,
                  modelId: currentTerminal.agentModelId,
                  presetArgs: runtimeSettings.settings.preset?.args?.join(" "),
                }
              );
            }
          } catch (error) {
            logWarn(
              "[TerminalStore] Failed to load agent settings for restart, using saved command",
              {
                error,
              }
            );
          }
        }
      }
    }

    const spawnCommand = commandToRun;
    // Track session ID for restore-on-failure; resume command is transient,
    // so keep the original command as the durable stored command
    const consumedSessionId = currentTerminal.agentSessionId;
    const durableCommand = consumedSessionId ? currentTerminal.command : spawnCommand;

    try {
      // CAPTURE LIVE DIMENSIONS before destroying the frontend
      const managedInstance = terminalInstanceService.get(id);
      let spawnCols = currentTerminal.cols || 80;
      let spawnRows = currentTerminal.rows || 24;
      if (managedInstance?.terminal) {
        spawnCols = managedInstance.terminal.cols || spawnCols;
        spawnRows = managedInstance.terminal.rows || spawnRows;
      }

      // AGGRESSIVE TEARDOWN: Destroy frontend FIRST to prevent race condition
      terminalInstanceService.destroy(id);

      terminalInstanceService.suppressNextExit(id, 10000);

      try {
        await terminalClient.kill(id);
      } catch (error) {
        logWarn("[TerminalStore] kill failed during restart; continuing", { id, error });
      }

      // Update terminal in store: increment restartKey, reset agent state, update location
      set((state) => {
        const t = state.panelsById[id];
        if (!t) return state;
        const updated = {
          ...t,
          location: targetLocation,
          restartKey: (t.restartKey ?? 0) + 1,
          // Demoted panels keep `agentState: "exited"` so the guard above
          // stays true across repeated restarts (issue #5764).
          agentState: isAgent
            ? ("working" as const)
            : isDemotedAgent
              ? ("exited" as const)
              : undefined,
          lastStateChange: isAgent ? Date.now() : undefined,
          stateChangeTrigger: undefined,
          stateChangeConfidence: undefined,
          // Clear the stored agent command on demotion so a subsequent
          // restart falls through to the default shell.
          command: isDemotedAgent ? undefined : durableCommand,
          agentLaunchFlags: isAgent ? nextAgentLaunchFlags : t.agentLaunchFlags,
          agentPresetId: nextAgentPresetId,
          agentPresetColor: nextAgentPresetColor,
          originalPresetId: nextOriginalPresetId,
          agentSessionId: undefined,
          isRestarting: true,
          restartError: undefined,
          exitCode: undefined,
          startedAt: Date.now(),
        };
        const newById = { ...state.panelsById, [id]: updated };
        saveNormalized(newById, state.panelIds);
        return { panelsById: newById };
      });

      await terminalInstanceService.waitForInstance(id, { timeoutMs: 5000 });

      // Capture project ID before async work to avoid race conditions (issue #3690).
      const projectStore = await resolveProjectStore();
      const capturedProjectId = projectStore.getState().currentProject?.id;

      const restartEnv = await buildRestartEnv(
        capturedProjectId,
        runtimeForEnv?.settings.env,
        "restart"
      );

      await terminalClient.spawn({
        id,
        projectId: capturedProjectId,
        cwd: currentTerminal.cwd,
        cols: spawnCols,
        rows: spawnRows,
        // Demoted panels spawn as plain terminals — launchAgentId cleared so the
        // IPC handler does not treat them as agent spawns (issue #5764).
        kind: "terminal",
        launchAgentId: isAgent ? currentTerminal.launchAgentId : undefined,
        title: currentTerminal.title,
        command: isAgent ? spawnCommand : undefined,
        restore: false,
        env: restartEnv,
        agentLaunchFlags: isAgent ? nextAgentLaunchFlags : undefined,
        agentModelId: isAgent ? currentTerminal.agentModelId : undefined,
        agentPresetId: nextAgentPresetId,
        agentPresetColor: nextAgentPresetColor,
        originalAgentPresetId: nextOriginalPresetId ?? nextAgentPresetId,
      });

      if (targetLocation === "dock") {
        optimizeForDock(id);
      } else {
        terminalInstanceService.fit(id);
      }

      unmarkTerminalRestarting(id);
      set((state) => updateTerminal(state, id, (t) => ({ ...t, isRestarting: false })));
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to restart terminal");
      const errorCode = (error as { code?: string })?.code;

      let phase = "unknown";
      if (errorMessage.includes("frontend readiness timeout")) {
        phase = "frontend-readiness";
      } else if (errorMessage.includes("spawn")) {
        phase = "pty-spawn";
      } else if (errorMessage.includes("kill")) {
        phase = "pty-kill";
      } else if (errorMessage.includes("destroy")) {
        phase = "frontend-destroy";
      }

      const restartError = {
        message: errorMessage,
        code: errorCode,
        timestamp: Date.now(),
        recoverable: errorCode === "ENOENT" || phase === "frontend-readiness",
        context: {
          failedCwd: currentTerminal.cwd,
          command: commandToRun,
          phase,
          isAgent,
          agentId: effectiveAgentId,
        },
      };

      unmarkTerminalRestarting(id);
      set((state) =>
        updateTerminal(state, id, (t) => ({
          ...t,
          isRestarting: false,
          restartError,
          // Restore session ID so user can retry resume
          ...(consumedSessionId ? { agentSessionId: consumedSessionId } : {}),
        }))
      );

      logError("[TerminalStore] Failed to restart terminal", error, {
        id,
        phase,
        cwd: currentTerminal.cwd,
        command: commandToRun,
        isAgent,
        agentId: effectiveAgentId,
      });
    }
  },

  clearTerminalError: (id) => {
    set((state) => updateTerminal(state, id, (t) => ({ ...t, restartError: undefined })));
  },

  updateTerminalCwd: (id, cwd) => {
    set((state) => {
      const t = state.panelsById[id];
      if (!t) return state;
      const newById = {
        ...state.panelsById,
        [id]: { ...t, cwd, restartError: undefined, spawnError: undefined },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  moveTerminalToWorktree: (id, worktreeId) => {
    const terminal = get().panelsById[id];
    if (!terminal) {
      logWarn("[TerminalStore] Cannot move terminal: not found", { id });
      return;
    }

    if (terminal.worktreeId === worktreeId) {
      return;
    }

    // Check if terminal belongs to a group
    const group = get().getPanelGroup(id);
    if (group) {
      // Move entire group to maintain worktree invariant
      logDebug("[TabGroup] Panel is in group, moving entire group to worktree", {
        panelId: id,
        groupId: group.id,
        worktreeId,
      });
      const success = get().moveTabGroupToWorktree(group.id, worktreeId);
      if (!success) {
        logWarn("[TabGroup] Failed to move group to worktree (capacity exceeded)", {
          groupId: group.id,
          worktreeId,
        });
      }
      return;
    }

    // Terminal is not in a group - move it individually
    let movedToLocation: PanelLocation | null = null;

    set((state) => {
      const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
      let targetGridCount = 0;
      for (const tid of state.panelIds) {
        const t = state.panelsById[tid];
        if (
          t &&
          (t.worktreeId ?? null) === (worktreeId ?? null) &&
          t.location !== "trash" &&
          (t.location === "grid" || t.location === undefined)
        )
          targetGridCount++;
      }

      const newLocation: PanelLocation = targetGridCount >= maxCapacity ? "dock" : "grid";
      movedToLocation = newLocation;

      const t = state.panelsById[id];
      if (!t) return state;
      const newById = {
        ...state.panelsById,
        [id]: {
          ...t,
          worktreeId,
          location: newLocation,
          isVisible: newLocation === "grid" ? true : false,
          runtimeStatus: deriveRuntimeStatus(newLocation === "grid", t.flowStatus, t.runtimeStatus),
        },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });

    if (!movedToLocation) return;

    if (movedToLocation === "dock") {
      optimizeForDock(id);
      return;
    }

    terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
  },

  moveToNewWorktreeAndTransfer: (id) => {
    const terminal = get().panelsById[id];
    if (!terminal || terminal.location === "trash") return;
    if (terminal.isRestarting) return;

    // Determine if this is an agent terminal before any async work
    const effectiveAgentId = terminal.launchAgentId;
    const isAgent = !!effectiveAgentId;

    // Capture the terminal buffer BEFORE any teardown (xterm instance is still alive)
    const capturedHistory = isAgent ? terminalInstanceService.captureBufferText(id, 20000) : "";

    void import("@/store/worktreeStore")
      .then(({ useWorktreeSelectionStore }) => {
        useWorktreeSelectionStore.getState().openCreateDialog(null, {
          onCreated: async (worktreeId) => {
            let newCwd = terminal.cwd;
            try {
              const { worktreeClient } = await import("@/clients");
              const worktrees = await worktreeClient.getAll();
              const newWorktree = worktrees.find((w) => w.id === worktreeId);
              newCwd = newWorktree?.path ?? terminal.cwd;

              // Update cwd, worktreeId, and clear agentSessionId so restartTerminal
              // spawns fresh instead of attempting a broken session resume
              set((state) =>
                updateTerminal(state, id, (t) => ({
                  ...t,
                  cwd: newCwd,
                  worktreeId,
                  agentSessionId: undefined,
                  restartError: undefined,
                }))
              );

              await get().restartTerminal(id);

              // After restart, inject captured history as a first prompt for agent terminals
              const restarted = get().panelsById[id];
              if (isAgent && capturedHistory.trim().length > 0 && !restarted?.restartError) {
                scheduleHistoryInjection(id, capturedHistory, newCwd ?? "");
              }
            } catch (err) {
              logError("[TerminalStore] moveToNewWorktreeAndTransfer failed", err);
              set((state) =>
                updateTerminal(state, id, (t) => ({
                  ...t,
                  isRestarting: false,
                  restartError: {
                    message: formatErrorMessage(err, "Failed to move terminal to new worktree"),
                    timestamp: Date.now(),
                    recoverable: false,
                    context: {
                      failedCwd: newCwd,
                      phase: "move-to-new-worktree",
                    },
                  },
                }))
              );
            }
          },
        });
      })
      .catch((err) => {
        logError("[TerminalStore] Failed to load worktreeStore", err);
      });
  },

  updateFlowStatus: (id, status, timestamp) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      const prevTs = terminal.flowStatusTimestamp;
      if (prevTs !== undefined && timestamp < prevTs) return state;

      if (terminal.flowStatus === status && terminal.flowStatusTimestamp === timestamp) {
        return state;
      }

      const runtimeStatus = deriveRuntimeStatus(terminal.isVisible, status, terminal.runtimeStatus);

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, flowStatus: status, flowStatusTimestamp: timestamp, runtimeStatus },
        },
      };
    });
  },

  setRuntimeStatus: (id, status) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (terminal.runtimeStatus === status) return state;

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, runtimeStatus: status },
        },
      };
    });
  },

  setInputLocked: (id, locked) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (terminal.isInputLocked === locked) return state;

      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, isInputLocked: locked },
      };
      saveNormalized(newById, state.panelIds);
      if (panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalInstanceService.setInputLocked(id, locked);
      }
      return { panelsById: newById };
    });
  },

  toggleInputLocked: (id) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      const locked = !terminal.isInputLocked;
      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, isInputLocked: locked },
      };
      saveNormalized(newById, state.panelIds);
      if (panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalInstanceService.setInputLocked(id, locked);
      }
      return { panelsById: newById };
    });
  },

  activateFallbackPreset: async (id, nextPresetId, originalPresetId) => {
    const terminal = get().panelsById[id];
    if (!terminal) {
      return { success: false, error: "terminal not found" };
    }
    if (terminal.isRestarting) {
      return { success: false, error: "already restarting" };
    }

    const effectiveAgentId = terminal.launchAgentId;
    if (!effectiveAgentId) {
      return { success: false, error: "panel is not an agent" };
    }

    markTerminalRestarting(id);
    set((state) =>
      updateTerminal(state, id, (t) => ({
        ...t,
        restartError: undefined,
        spawnError: undefined,
        isRestarting: true,
      }))
    );

    // Snapshot pre-mutation preset fields for rollback on spawn failure.
    // Without this, a failed respawn leaves the panel permanently stamped as
    // "using fallback N" while no process is running, corrupting any retry
    // that reads fallbackChainIndex.
    const priorSnapshot = {
      command: terminal.command,
      agentPresetId: terminal.agentPresetId,
      agentPresetColor: terminal.agentPresetColor,
      originalPresetId: terminal.originalPresetId,
      isUsingFallback: terminal.isUsingFallback,
      fallbackChainIndex: terminal.fallbackChainIndex,
      agentLaunchFlags: terminal.agentLaunchFlags,
    };

    try {
      const [agentSettings, tmpDir] = await Promise.all([
        agentSettingsClient.get(),
        systemClient.getTmpDir().catch(() => ""),
      ]);
      const entry = agentSettings?.agents?.[effectiveAgentId] ?? {};
      const ccrPresets = useCcrPresetsStore.getState().ccrPresetsByAgent[effectiveAgentId];
      const projectPresets = useProjectPresetsStore.getState().presetsByAgent[effectiveAgentId];
      const runtimeSettings = resolveAgentRuntimeSettings({
        agentId: effectiveAgentId,
        presetId: nextPresetId,
        entry,
        ccrPresets,
        projectPresets,
      });
      const nextPreset = runtimeSettings.preset;
      if (!nextPreset) {
        throw new Error(`fallback preset "${nextPresetId}" not found`);
      }

      const effectiveEntry = runtimeSettings.effectiveEntry;

      let clipboardDirectory: string | undefined;
      if (effectiveAgentId === "gemini" && effectiveEntry.shareClipboardDirectory !== false) {
        clipboardDirectory = tmpDir ? `${tmpDir}/daintree-clipboard` : undefined;
      }

      const agentConfig = getAgentConfig(effectiveAgentId);
      const baseCommand = agentConfig?.command || effectiveAgentId;
      const commandToRun = generateAgentCommand(baseCommand, effectiveEntry, effectiveAgentId, {
        clipboardDirectory,
        modelId: terminal.agentModelId,
        presetArgs: nextPreset.args?.join(" "),
      });
      const nextLaunchFlags = buildAgentLaunchFlags(effectiveEntry, effectiveAgentId, {
        modelId: terminal.agentModelId,
        presetArgs: nextPreset.args,
      });

      // Capture live terminal dimensions before teardown
      const managedInstance = terminalInstanceService.get(id);
      let spawnCols = terminal.cols || 80;
      let spawnRows = terminal.rows || 24;
      if (managedInstance?.terminal) {
        spawnCols = managedInstance.terminal.cols || spawnCols;
        spawnRows = managedInstance.terminal.rows || spawnRows;
      }

      terminalInstanceService.destroy(id);
      terminalInstanceService.suppressNextExit(id, 10000);
      try {
        await terminalClient.kill(id);
      } catch (error) {
        logWarn("[TerminalStore] kill failed during fallback activation; continuing", {
          id,
          error,
        });
      }

      const nextChainIndex = (terminal.fallbackChainIndex ?? 0) + 1;

      set((state) => {
        const t = state.panelsById[id];
        if (!t) return state;
        const updated = {
          ...t,
          restartKey: (t.restartKey ?? 0) + 1,
          agentState: "working" as AgentState,
          lastStateChange: Date.now(),
          stateChangeTrigger: undefined,
          stateChangeConfidence: undefined,
          command: commandToRun,
          agentPresetId: nextPreset.id,
          agentPresetColor: nextPreset.color,
          originalPresetId: originalPresetId,
          isUsingFallback: true,
          fallbackChainIndex: nextChainIndex,
          agentLaunchFlags: nextLaunchFlags,
          agentSessionId: undefined,
          isRestarting: true,
          restartError: undefined,
          exitCode: undefined,
          startedAt: Date.now(),
        };
        const newById = { ...state.panelsById, [id]: updated };
        saveNormalized(newById, state.panelIds);
        return { panelsById: newById };
      });

      await terminalInstanceService.waitForInstance(id, { timeoutMs: 5000 });

      const projectStore = await resolveProjectStore();
      const capturedProjectId = projectStore.getState().currentProject?.id;

      const restartEnv = await buildRestartEnv(capturedProjectId, runtimeSettings.env, "fallback");

      await terminalClient.spawn({
        id,
        projectId: capturedProjectId,
        cwd: terminal.cwd,
        cols: spawnCols,
        rows: spawnRows,
        kind: "terminal",
        launchAgentId: terminal.launchAgentId,
        title: terminal.title,
        command: commandToRun,
        restore: false,
        env: restartEnv,
        agentLaunchFlags: nextLaunchFlags,
        agentModelId: terminal.agentModelId,
        agentPresetId: nextPreset.id,
        agentPresetColor: nextPreset.color,
        originalAgentPresetId: originalPresetId,
      });

      if (terminal.location === "dock") {
        optimizeForDock(id);
      } else {
        terminalInstanceService.fit(id);
      }

      unmarkTerminalRestarting(id);
      set((state) => updateTerminal(state, id, (t) => ({ ...t, isRestarting: false })));
      return { success: true };
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to restart terminal");
      unmarkTerminalRestarting(id);
      set((state) =>
        updateTerminal(state, id, (t) => ({
          ...t,
          isRestarting: false,
          // Restore pre-mutation fields so fallbackChainIndex and presetId
          // accurately reflect "we are NOT running the next preset". Without
          // rollback, any subsequent fallback trigger would jump past this
          // preset even though the PTY never started.
          ...priorSnapshot,
          restartError: {
            message: errorMessage,
            timestamp: Date.now(),
            recoverable: false,
            context: {
              failedCwd: terminal.cwd,
              phase: "fallback-activation",
              nextPresetId,
            },
          },
        }))
      );
      logError("[TerminalStore] Failed to activate fallback preset", error, {
        id,
        nextPresetId,
      });
      return { success: false, error: errorMessage };
    }
  },
});
