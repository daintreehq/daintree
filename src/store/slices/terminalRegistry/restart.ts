import type { TerminalLocation } from "@/types";
import type { TerminalRegistryStoreApi, TerminalRegistrySlice } from "./types";
import { terminalClient, agentSettingsClient, projectClient, systemClient } from "@/clients";
import { generateAgentCommand, buildResumeCommand } from "@shared/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { validateTerminalConfig } from "@/utils/terminalValidation";
import { isRegisteredAgent, getAgentConfig } from "@/config/agents";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { markTerminalRestarting, unmarkTerminalRestarting } from "@/store/restartExitSuppression";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";
import { saveTerminals } from "./persistence";
import { optimizeForDock } from "./layout";
import { deriveRuntimeStatus, getDefaultTitle } from "./helpers";

type Set = TerminalRegistryStoreApi["setState"];
type Get = TerminalRegistryStoreApi["getState"];

export const createRestartActions = (
  set: Set,
  get: Get
): Pick<
  TerminalRegistrySlice,
  | "restartTerminal"
  | "clearTerminalError"
  | "updateTerminalCwd"
  | "moveTerminalToWorktree"
  | "updateFlowStatus"
  | "setRuntimeStatus"
  | "setInputLocked"
  | "toggleInputLocked"
  | "convertTerminalType"
> => ({
  restartTerminal: async (id) => {
    const state = get();
    const terminal = state.terminals.find((t) => t.id === id);

    if (!terminal) {
      console.warn(`[TerminalStore] Cannot restart: terminal ${id} not found`);
      return;
    }

    // Non-PTY panels don't have PTY processes to restart
    if (!panelKindHasPty(terminal.kind ?? "terminal")) {
      console.warn(`[TerminalStore] Cannot restart non-PTY panel ${id}`);
      return;
    }

    // Guard against concurrent restart attempts
    if (terminal.isRestarting) {
      console.warn(`[TerminalStore] Terminal ${id} is already restarting, ignoring`);
      return;
    }

    // Mark as restarting SYNCHRONOUSLY first to prevent exit event race condition.
    // This is checked in the onExit handler before the store state.
    markTerminalRestarting(id);

    // Also set the store flag for UI and other consumers
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id
          ? {
              ...t,
              restartError: undefined,
              reconnectError: undefined,
              spawnError: undefined,
              isRestarting: true,
            }
          : t
      ),
    }));

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
      set((state) => ({
        terminals: state.terminals.map((t) =>
          t.id === id ? { ...t, isRestarting: false, restartError } : t
        ),
      }));
      console.error(`[TerminalStore] Validation error for terminal ${id}:`, error);
      return;
    }

    if (!validation.valid) {
      // Set error state instead of attempting doomed restart
      // Use the first non-recoverable error's code, or the first error's code
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
      set((state) => ({
        terminals: state.terminals.map((t) =>
          t.id === id ? { ...t, isRestarting: false, restartError } : t
        ),
      }));
      console.warn(`[TerminalStore] Restart validation failed for terminal ${id}:`, restartError);
      return;
    }

    // Re-read terminal from state in case it was modified during async validation
    const currentState = get();
    const currentTerminal = currentState.terminals.find((t) => t.id === id);

    if (!currentTerminal || currentTerminal.location === "trash") {
      // Terminal was removed or trashed while we were validating
      unmarkTerminalRestarting(id);
      set((state) => ({
        terminals: state.terminals.map((t) => (t.id === id ? { ...t, isRestarting: false } : t)),
      }));
      console.warn(`[TerminalStore] Terminal ${id} no longer exists or was trashed`);
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
              { clipboardDirectory }
            );
          }
        } catch (error) {
          console.warn(
            "[TerminalStore] Failed to load agent settings for restart, using saved command:",
            error
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
      // The store's cols/rows may be stale (set on initial spawn).
      // The managed xterm instance has the actual current dimensions.
      const managedInstance = terminalInstanceService.get(id);
      let spawnCols = currentTerminal.cols || 80;
      let spawnRows = currentTerminal.rows || 24;
      if (managedInstance?.terminal) {
        spawnCols = managedInstance.terminal.cols || spawnCols;
        spawnRows = managedInstance.terminal.rows || spawnRows;
      }

      // AGGRESSIVE TEARDOWN: Destroy frontend FIRST to prevent race condition
      // The old frontend must stop listening before new PTY data starts flowing
      terminalInstanceService.destroy(id);

      terminalInstanceService.suppressNextExit(id, 10000);

      try {
        await terminalClient.kill(id);
      } catch (error) {
        console.warn(`[TerminalStore] kill(${id}) failed during restart; continuing:`, error);
      }

      // Do not shrink geometry for dock; dock previews are clipped instead.

      // Update terminal in store: increment restartKey, reset agent state, update location
      // This triggers XtermAdapter remount with new xterm instance
      // Keep isRestarting: true to prevent onExit race
      set((state) => {
        const newTerminals = state.terminals.map((t) =>
          t.id === id
            ? {
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
              }
            : t
        );
        saveTerminals(newTerminals);
        return { terminals: newTerminals };
      });

      await terminalInstanceService.waitForInstance(id, { timeoutMs: 5000 });

      // Fetch project environment variables for restart
      let restartEnv: Record<string, string> | undefined;
      try {
        const currentProject = await projectClient.getCurrent();
        if (currentProject?.id) {
          const projectSettings = await projectClient.getSettings(currentProject.id);
          if (
            projectSettings?.environmentVariables &&
            Object.keys(projectSettings.environmentVariables).length > 0
          ) {
            restartEnv = projectSettings.environmentVariables;
          }
        }
      } catch (error) {
        console.warn("[TerminalStore] Failed to fetch project env for restart:", error);
      }

      await terminalClient.spawn({
        id,
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
      });

      if (targetLocation === "dock") {
        optimizeForDock(id);
      } else {
        // Force resize sync to ensure PTY dimensions match the container
        // performFit() in XtermAdapter may run before the container is laid out
        terminalInstanceService.fit(id);
      }

      unmarkTerminalRestarting(id);
      set((state) => ({
        terminals: state.terminals.map((t) => (t.id === id ? { ...t, isRestarting: false } : t)),
      }));
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
      set((state) => ({
        terminals: state.terminals.map((t) =>
          t.id === id
            ? {
                ...t,
                isRestarting: false,
                restartError,
                // Restore session ID so user can retry resume
                ...(consumedSessionId ? { agentSessionId: consumedSessionId } : {}),
              }
            : t
        ),
      }));

      console.error(`[TerminalStore] Failed to restart terminal ${id} during ${phase}:`, error, {
        cwd: currentTerminal.cwd,
        command: commandToRun,
        isAgent,
        agentId: effectiveAgentId,
      });
    }
  },

  clearTerminalError: (id) => {
    set((state) => ({
      terminals: state.terminals.map((t) => (t.id === id ? { ...t, restartError: undefined } : t)),
    }));
  },

  updateTerminalCwd: (id, cwd) => {
    set((state) => {
      const newTerminals = state.terminals.map((t) =>
        t.id === id ? { ...t, cwd, restartError: undefined, spawnError: undefined } : t
      );
      saveTerminals(newTerminals);
      return { terminals: newTerminals };
    });
  },

  moveTerminalToWorktree: (id, worktreeId) => {
    console.log(`[TERM_DEBUG] moveTerminalToWorktree id=${id} worktree=${worktreeId}`);

    const terminal = get().terminals.find((t) => t.id === id);
    if (!terminal) {
      console.warn(`Cannot move terminal ${id}: terminal not found`);
      return;
    }

    if (terminal.worktreeId === worktreeId) {
      return;
    }

    // Check if terminal belongs to a group
    const group = get().getPanelGroup(id);
    if (group) {
      // Move entire group to maintain worktree invariant
      console.log(
        `[TabGroup] Panel ${id} is in group ${group.id}, moving entire group to worktree ${worktreeId}`
      );
      const success = get().moveTabGroupToWorktree(group.id, worktreeId);
      if (!success) {
        console.warn(
          `[TabGroup] Failed to move group ${group.id} to worktree ${worktreeId} (likely capacity exceeded)`
        );
      }
      return;
    }

    // Terminal is not in a group - move it individually
    let movedToLocation: TerminalLocation | null = null;

    set((state) => {
      const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
      const targetGridCount = state.terminals.filter(
        (t) =>
          (t.worktreeId ?? null) === (worktreeId ?? null) &&
          t.location !== "trash" &&
          (t.location === "grid" || t.location === undefined)
      ).length;

      const newLocation: TerminalLocation = targetGridCount >= maxCapacity ? "dock" : "grid";
      movedToLocation = newLocation;

      const newTerminals = state.terminals.map((t) =>
        t.id === id
          ? {
              ...t,
              worktreeId,
              location: newLocation,
              isVisible: newLocation === "grid" ? true : false,
              runtimeStatus: deriveRuntimeStatus(
                newLocation === "grid",
                t.flowStatus,
                t.runtimeStatus
              ),
            }
          : t
      );
      saveTerminals(newTerminals);
      return { terminals: newTerminals };
    });

    if (!movedToLocation) return;

    if (movedToLocation === "dock") {
      optimizeForDock(id);
      return;
    }

    // All terminals stay visible - we don't background for reliability.
    terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
  },

  updateFlowStatus: (id, status, timestamp) => {
    set((state) => {
      const terminal = state.terminals.find((t) => t.id === id);
      if (!terminal) return state;

      const prevTs = terminal.flowStatusTimestamp;
      if (prevTs !== undefined && timestamp < prevTs) return state;

      if (terminal.flowStatus === status && terminal.flowStatusTimestamp === timestamp) {
        return state;
      }

      const runtimeStatus = deriveRuntimeStatus(terminal.isVisible, status, terminal.runtimeStatus);

      return {
        terminals: state.terminals.map((t) =>
          t.id === id
            ? { ...t, flowStatus: status, flowStatusTimestamp: timestamp, runtimeStatus }
            : t
        ),
      };
    });
  },

  setRuntimeStatus: (id, status) => {
    set((state) => {
      const terminal = state.terminals.find((t) => t.id === id);
      if (!terminal) return state;

      if (terminal.runtimeStatus === status) {
        return state;
      }

      return {
        terminals: state.terminals.map((t) => (t.id === id ? { ...t, runtimeStatus: status } : t)),
      };
    });
  },

  setInputLocked: (id, locked) => {
    set((state) => {
      const terminal = state.terminals.find((t) => t.id === id);
      if (!terminal) return state;

      if (terminal.isInputLocked === locked) return state;

      const updated = {
        terminals: state.terminals.map((t) => (t.id === id ? { ...t, isInputLocked: locked } : t)),
      };

      saveTerminals(updated.terminals);
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalInstanceService.setInputLocked(id, locked);
      }

      return updated;
    });
  },

  toggleInputLocked: (id) => {
    set((state) => {
      const terminal = state.terminals.find((t) => t.id === id);
      if (!terminal) return state;

      const locked = !terminal.isInputLocked;

      const updated = {
        terminals: state.terminals.map((t) => (t.id === id ? { ...t, isInputLocked: locked } : t)),
      };

      saveTerminals(updated.terminals);
      if (panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalInstanceService.setInputLocked(id, locked);
      }

      return updated;
    });
  },

  convertTerminalType: async (id, newType, newAgentId) => {
    const terminal = get().terminals.find((t) => t.id === id);
    if (!terminal) {
      console.warn(`[TerminalStore] Cannot convert: terminal ${id} not found`);
      return;
    }

    if (terminal.isRestarting) {
      console.warn(`[TerminalStore] Terminal ${id} is already restarting, ignoring convert`);
      return;
    }

    // Mark as restarting SYNCHRONOUSLY first to prevent exit event race condition.
    markTerminalRestarting(id);

    // Set store flag immediately to prevent overlapping operations
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, restartError: undefined, isRestarting: true } : t
      ),
    }));

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
        console.warn(
          "[TerminalStore] Failed to load agent settings for convert, using default:",
          error
        );
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

      const isAgent = !!effectiveAgentId;

      set((state) => {
        const newTerminals = state.terminals.map((t) =>
          t.id === id
            ? {
                ...t,
                kind: newKind,
                type: newType,
                agentId: effectiveAgentId,
                title: newTitle,
                restartKey: (t.restartKey ?? 0) + 1,
                agentState: isAgent ? ("working" as const) : undefined,
                lastStateChange: isAgent ? Date.now() : undefined,
                stateChangeTrigger: undefined,
                stateChangeConfidence: undefined,
                command: commandToRun,
                isRestarting: true,
                restartError: undefined,
              }
            : t
        );
        saveTerminals(newTerminals);
        return { terminals: newTerminals };
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Fetch project environment variables for conversion
      let convertEnv: Record<string, string> | undefined;
      try {
        const currentProject = await projectClient.getCurrent();
        if (currentProject?.id) {
          const projectSettings = await projectClient.getSettings(currentProject.id);
          if (
            projectSettings?.environmentVariables &&
            Object.keys(projectSettings.environmentVariables).length > 0
          ) {
            convertEnv = projectSettings.environmentVariables;
          }
        }
      } catch (error) {
        console.warn("[TerminalStore] Failed to fetch project env for conversion:", error);
      }

      await terminalClient.spawn({
        id,
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
      set((state) => ({
        terminals: state.terminals.map((t) => (t.id === id ? { ...t, isRestarting: false } : t)),
      }));
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
      set((state) => ({
        terminals: state.terminals.map((t) =>
          t.id === id ? { ...t, isRestarting: false, restartError } : t
        ),
      }));

      console.error(`[TerminalStore] Failed to convert terminal ${id}:`, error);
    }
  },
});
