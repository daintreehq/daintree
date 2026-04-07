import type { PanelLocation } from "@/types";
import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import { terminalClient, agentSettingsClient, projectClient, systemClient } from "@/clients";
import { generateAgentCommand, buildResumeCommand } from "@shared/types";
import type { AgentState } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { validateTerminalConfig } from "@/utils/terminalValidation";
import { isRegisteredAgent, getAgentConfig } from "@/config/agents";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { markTerminalRestarting, unmarkTerminalRestarting } from "@/store/restartExitSuppression";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";
import { saveNormalized } from "./persistence";
import { optimizeForDock } from "./layout";
import { deriveRuntimeStatus, getDefaultTitle } from "./helpers";
import { logDebug, logWarn, logError } from "@/utils/logger";

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
  | "convertTerminalType"
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
          validationError: error instanceof Error ? error.message : String(error),
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
    // Get effective agentId - handles both new agentId and legacy type-based detection
    const effectiveAgentId =
      currentTerminal.agentId ??
      (currentTerminal.type && isRegisteredAgent(currentTerminal.type)
        ? currentTerminal.type
        : undefined);
    const isAgent = !!effectiveAgentId;

    if (isAgent && effectiveAgentId) {
      const sessionId = currentTerminal.agentSessionId;
      if (sessionId) {
        const resumeCmd = buildResumeCommand(
          effectiveAgentId,
          sessionId,
          currentTerminal.agentLaunchFlags
        );
        if (resumeCmd) {
          commandToRun = resumeCmd;
        }
      }

      if (commandToRun === currentTerminal.command) {
        try {
          const [agentSettings, tmpDir] = await Promise.all([
            agentSettingsClient.get(),
            systemClient.getTmpDir().catch(() => ""),
          ]);
          if (agentSettings) {
            const agentConfig = getAgentConfig(effectiveAgentId);
            const baseCommand = agentConfig?.command || effectiveAgentId;
            const clipboardDirectory = tmpDir ? `${tmpDir}/canopy-clipboard` : undefined;
            commandToRun = generateAgentCommand(
              baseCommand,
              agentSettings.agents?.[effectiveAgentId] ?? {},
              effectiveAgentId,
              { clipboardDirectory, modelId: currentTerminal.agentModelId }
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
          agentState: isAgent ? ("working" as const) : undefined,
          lastStateChange: isAgent ? Date.now() : undefined,
          stateChangeTrigger: undefined,
          stateChangeConfidence: undefined,
          command: durableCommand,
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

      // Fetch project environment variables for restart
      let restartEnv: Record<string, string> | undefined;
      try {
        if (capturedProjectId) {
          const projectSettings = await projectClient.getSettings(capturedProjectId);
          if (
            projectSettings?.environmentVariables &&
            Object.keys(projectSettings.environmentVariables).length > 0
          ) {
            restartEnv = projectSettings.environmentVariables;
          }
        }
      } catch (error) {
        logWarn("[TerminalStore] Failed to fetch project env for restart", { error });
      }

      await terminalClient.spawn({
        id,
        projectId: capturedProjectId,
        cwd: currentTerminal.cwd,
        cols: spawnCols,
        rows: spawnRows,
        kind: currentTerminal.kind ?? (isAgent ? "agent" : "terminal"),
        type: currentTerminal.type,
        agentId: currentTerminal.agentId,
        title: currentTerminal.title,
        worktreeId: currentTerminal.worktreeId,
        command: spawnCommand,
        restore: false,
        env: restartEnv,
        agentLaunchFlags: currentTerminal.agentLaunchFlags,
        agentModelId: currentTerminal.agentModelId,
      });

      if (targetLocation === "dock") {
        optimizeForDock(id);
      } else {
        terminalInstanceService.fit(id);
      }

      unmarkTerminalRestarting(id);
      set((state) => updateTerminal(state, id, (t) => ({ ...t, isRestarting: false })));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
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
    const effectiveAgentId =
      terminal.agentId ??
      (terminal.type && isRegisteredAgent(terminal.type) ? terminal.type : undefined);
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
                    message: err instanceof Error ? err.message : String(err),
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

  convertTerminalType: async (id, newType, newAgentId) => {
    const terminal = get().panelsById[id];
    if (!terminal) {
      logWarn("[TerminalStore] Cannot convert: terminal not found", { id });
      return;
    }

    if (terminal.isRestarting) {
      logWarn("[TerminalStore] Terminal is already restarting, ignoring convert", { id });
      return;
    }

    // Mark as restarting SYNCHRONOUSLY first to prevent exit event race condition.
    markTerminalRestarting(id);

    // Set store flag immediately to prevent overlapping operations
    set((state) =>
      updateTerminal(state, id, (t) => ({
        ...t,
        restartError: undefined,
        isRestarting: true,
      }))
    );

    const effectiveAgentId = newAgentId ?? (isRegisteredAgent(newType) ? newType : undefined);
    const newKind: "terminal" | "agent" = effectiveAgentId ? "agent" : "terminal";
    const newTitle = getDefaultTitle(newKind, newType, effectiveAgentId);

    let commandToRun: string | undefined;
    if (effectiveAgentId) {
      try {
        const [agentSettings, tmpDir] = await Promise.all([
          agentSettingsClient.get(),
          systemClient.getTmpDir().catch(() => ""),
        ]);
        if (agentSettings) {
          const agentConfig = getAgentConfig(effectiveAgentId);
          const baseCommand = agentConfig?.command || effectiveAgentId;
          const clipboardDirectory = tmpDir ? `${tmpDir}/canopy-clipboard` : undefined;
          commandToRun = generateAgentCommand(
            baseCommand,
            agentSettings.agents?.[effectiveAgentId] ?? {},
            effectiveAgentId,
            { clipboardDirectory }
          );
        }
      } catch (error) {
        logWarn("[TerminalStore] Failed to load agent settings for convert, using default", {
          error,
        });
        const agentConfig = getAgentConfig(effectiveAgentId);
        commandToRun = agentConfig?.command || effectiveAgentId;
      }
    }

    try {
      const managedInstance = terminalInstanceService.get(id);
      let spawnCols = terminal.cols || 80;
      let spawnRows = terminal.rows || 24;
      if (managedInstance?.terminal) {
        spawnCols = managedInstance.terminal.cols || spawnCols;
        spawnRows = managedInstance.terminal.rows || spawnRows;
      }

      terminalInstanceService.destroy(id);
      terminalInstanceService.suppressNextExit(id);
      await terminalClient.kill(id);

      const isAgentConvert = !!effectiveAgentId;

      set((state) => {
        const t = state.panelsById[id];
        if (!t) return state;
        const updated = {
          ...t,
          kind: newKind,
          type: newType,
          agentId: effectiveAgentId,
          title: newTitle,
          restartKey: (t.restartKey ?? 0) + 1,
          agentState: isAgentConvert ? ("working" as const) : undefined,
          lastStateChange: isAgentConvert ? Date.now() : undefined,
          stateChangeTrigger: undefined,
          stateChangeConfidence: undefined,
          command: commandToRun,
          isRestarting: true,
          restartError: undefined,
        };
        const newById = { ...state.panelsById, [id]: updated };
        saveNormalized(newById, state.panelIds);
        return { panelsById: newById };
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Capture project ID before async work to avoid race conditions (issue #3690).
      const projectStoreForConvert = await resolveProjectStore();
      const capturedProjectId = projectStoreForConvert.getState().currentProject?.id;

      // Fetch project environment variables for conversion
      let convertEnv: Record<string, string> | undefined;
      try {
        if (capturedProjectId) {
          const projectSettings = await projectClient.getSettings(capturedProjectId);
          if (
            projectSettings?.environmentVariables &&
            Object.keys(projectSettings.environmentVariables).length > 0
          ) {
            convertEnv = projectSettings.environmentVariables;
          }
        }
      } catch (error) {
        logWarn("[TerminalStore] Failed to fetch project env for conversion", { error });
      }

      await terminalClient.spawn({
        id,
        projectId: capturedProjectId,
        cwd: terminal.cwd,
        cols: spawnCols,
        rows: spawnRows,
        kind: newKind,
        type: newType,
        agentId: effectiveAgentId,
        title: newTitle,
        worktreeId: terminal.worktreeId,
        command: commandToRun,
        restore: false,
        env: convertEnv,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      if (terminal.location === "dock") {
        optimizeForDock(id);
      } else {
        terminalInstanceService.fit(id);
      }

      unmarkTerminalRestarting(id);
      set((state) => updateTerminal(state, id, (t) => ({ ...t, isRestarting: false })));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = (error as { code?: string })?.code;

      const restartError = {
        message: errorMessage,
        code: errorCode,
        timestamp: Date.now(),
        recoverable: false,
        context: {
          failedCwd: terminal.cwd,
          command: commandToRun,
        },
      };

      unmarkTerminalRestarting(id);
      set((state) =>
        updateTerminal(state, id, (t) => ({
          ...t,
          isRestarting: false,
          restartError,
        }))
      );

      logError("[TerminalStore] Failed to convert terminal", error, { id });
    }
  },
});
