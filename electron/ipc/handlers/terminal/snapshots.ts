/**
 * Terminal snapshot handlers - getSerializedState, wake, getInfo.
 */

import { z } from "zod";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";
import { TerminalReplayHistoryPayloadSchema } from "../../../schemas/index.js";
import { logDebug, logInfo, logWarn } from "../../../utils/logger.js";
import { getAgentAvailabilityStore } from "../../../services/AgentAvailabilityStore.js";
import { typedHandle, typedHandleValidated } from "../../utils.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";

type ValidatedReplayHistoryPayload = z.output<typeof TerminalReplayHistoryPayloadSchema>;

export function registerTerminalSnapshotHandlers(deps: HandlerDependencies): () => void {
  const { ptyClient } = deps;
  if (!ptyClient) {
    return () => {};
  }
  const handlers: Array<() => void> = [];

  const handleTerminalWake = async (
    id: string
  ): Promise<{ state: string | null; warnings?: string[] }> => {
    try {
      if (typeof id !== "string" || !id) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }
      return await ptyClient.wakeTerminal(id);
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to wake terminal");
      throw new Error(`Failed to wake terminal: ${errorMessage}`);
    }
  };
  handlers.push(typedHandle(CHANNELS.TERMINAL_WAKE, handleTerminalWake));

  const handleTerminalGetSerializedState = async (terminalId: string): Promise<string | null> => {
    try {
      if (typeof terminalId !== "string" || !terminalId) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }

      const serializedState = await ptyClient.getSerializedStateAsync(terminalId);

      if (process.env.DAINTREE_VERBOSE) {
        logDebug(
          `terminal:getSerializedState(${terminalId}): ${serializedState ? `${serializedState.length} bytes` : "null"}`
        );
      }
      return serializedState;
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to get serialized terminal state");
      throw new Error(`Failed to get serialized terminal state: ${errorMessage}`);
    }
  };
  handlers.push(
    typedHandle(CHANNELS.TERMINAL_GET_SERIALIZED_STATE, handleTerminalGetSerializedState)
  );

  const handleTerminalGetSerializedStates = async (
    terminalIds: string[]
  ): Promise<Record<string, string | null>> => {
    if (!Array.isArray(terminalIds)) {
      throw new Error("Invalid terminal IDs: must be an array");
    }

    if (terminalIds.length > 256) {
      throw new Error("Invalid terminal IDs: maximum 256 IDs allowed");
    }

    const normalizedIds = Array.from(
      new Set(
        terminalIds.map((id) => {
          if (typeof id !== "string" || !id.trim()) {
            throw new Error("Invalid terminal ID in batch payload");
          }
          return id;
        })
      )
    );

    const results = await Promise.all(
      normalizedIds.map(async (terminalId) => {
        try {
          const serializedState = await ptyClient.getSerializedStateAsync(terminalId);
          return [terminalId, serializedState] as const;
        } catch (error) {
          logWarn(`terminal:getSerializedStates(${terminalId}) failed`, { error });
          return [terminalId, null] as const;
        }
      })
    );

    return Object.fromEntries(results);
  };
  handlers.push(
    typedHandle(CHANNELS.TERMINAL_GET_SERIALIZED_STATES, handleTerminalGetSerializedStates)
  );

  const handleTerminalGetInfo = async (
    id: string
  ): Promise<import("../../../../shared/types/ipc.js").TerminalInfoPayload> => {
    try {
      if (typeof id !== "string" || !id) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }

      const terminalInfo = await ptyClient.getTerminalInfo(id);

      if (!terminalInfo) {
        throw new Error(`Terminal ${id} not found`);
      }

      return terminalInfo;
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to get terminal info");
      throw new Error(`Failed to get terminal info: ${errorMessage}`);
    }
  };
  handlers.push(typedHandle(CHANNELS.TERMINAL_GET_INFO, handleTerminalGetInfo));

  const handleTerminalGetSharedBuffers = async (): Promise<{
    visualBuffers: SharedArrayBuffer[];
    signalBuffer: SharedArrayBuffer | null;
  }> => {
    try {
      return ptyClient.getSharedBuffers();
    } catch (error) {
      logWarn("Failed to get shared buffers", { error });
      return { visualBuffers: [], signalBuffer: null };
    }
  };
  handlers.push(typedHandle(CHANNELS.TERMINAL_GET_SHARED_BUFFERS, handleTerminalGetSharedBuffers));

  const handleTerminalGetAnalysisBuffer = async (): Promise<SharedArrayBuffer | null> => {
    try {
      return ptyClient.getAnalysisBuffer();
    } catch (error) {
      logWarn("Failed to get analysis buffer", { error });
      return null;
    }
  };
  handlers.push(
    typedHandle(CHANNELS.TERMINAL_GET_ANALYSIS_BUFFER, handleTerminalGetAnalysisBuffer)
  );

  const handleTerminalReplayHistory = async ({
    terminalId,
    maxLines,
  }: ValidatedReplayHistoryPayload) => {
    try {
      const replayed = await ptyClient.replayHistoryAsync(terminalId, maxLines);

      logInfo(`terminal:replayHistory(${terminalId}): replayed ${replayed} lines`);
      return { replayed };
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to replay terminal history");
      throw new Error(`Failed to replay terminal history: ${errorMessage}`);
    }
  };
  handlers.push(
    typedHandleValidated(
      CHANNELS.TERMINAL_REPLAY_HISTORY,
      TerminalReplayHistoryPayloadSchema,
      handleTerminalReplayHistory
    )
  );

  const handleTerminalGetForProject = async (
    projectId: string
  ): Promise<import("../../../../shared/types/ipc.js").BackendTerminalInfo[]> => {
    try {
      if (typeof projectId !== "string" || !projectId) {
        throw new Error("Invalid project ID: must be a non-empty string");
      }

      const terminalIds = await ptyClient.getTerminalsForProjectAsync(projectId);

      const terminals: import("../../../../shared/types/ipc.js").BackendTerminalInfo[] = [];
      for (const id of terminalIds) {
        const terminal = await ptyClient.getTerminalAsync(id);
        // Dev preview and help PTYs should not be rehydrated as generic terminal
        // panels during project switching/hydration.
        if (
          terminal &&
          terminal.kind !== "dev-preview" &&
          !getAgentAvailabilityStore().isHelpTerminal(terminal.id)
        ) {
          terminals.push({
            id: terminal.id,
            projectId: terminal.projectId,
            kind: terminal.kind,

            launchAgentId: terminal.launchAgentId,
            title: terminal.title,
            cwd: terminal.cwd,
            agentState: terminal.agentState,
            lastStateChange: terminal.lastStateChange,
            spawnedAt: terminal.spawnedAt,
            isTrashed: terminal.isTrashed,
            trashExpiresAt: terminal.trashExpiresAt,
            activityTier: terminal.activityTier,
            hasPty: terminal.hasPty,
            agentSessionId: terminal.agentSessionId,
            agentLaunchFlags: terminal.agentLaunchFlags,
            agentModelId: terminal.agentModelId,
            agentPresetId: terminal.agentPresetId,
            agentPresetColor: terminal.agentPresetColor,
            originalAgentPresetId: terminal.originalAgentPresetId,
            everDetectedAgent: terminal.everDetectedAgent,
            detectedAgentId: terminal.detectedAgentId,
            detectedProcessId: terminal.detectedProcessId,
          });
        }
      }

      logInfo(
        `terminal:getForProject(${projectId.slice(0, 8)}): found ${terminals.length} terminals`,
        {
          terminals: terminals.map((t) => ({
            id: t.id.slice(0, 12),
            kind: t.kind,
            projectId: t.projectId?.slice(0, 8),
          })),
        }
      );
      return terminals;
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to get terminals for project");
      throw new Error(`Failed to get terminals for project: ${errorMessage}`);
    }
  };
  handlers.push(typedHandle(CHANNELS.TERMINAL_GET_FOR_PROJECT, handleTerminalGetForProject));

  const handleTerminalGetAvailable = async (): Promise<
    import("../../../../shared/types/ipc.js").BackendTerminalInfo[]
  > => {
    try {
      const terminals = await ptyClient.getAvailableTerminalsAsync();

      const sanitized = terminals
        .filter((t) => t.kind !== "dev-preview")
        .map((t) => ({
          id: t.id,
          projectId: t.projectId,
          kind: t.kind,

          launchAgentId: t.launchAgentId,
          title: t.title,
          cwd: t.cwd,
          worktreeId: t.worktreeId,
          agentState: t.agentState,
          lastStateChange: t.lastStateChange,
          spawnedAt: t.spawnedAt,
          isTrashed: t.isTrashed,
          trashExpiresAt: t.trashExpiresAt,
          activityTier: t.activityTier,
          hasPty: t.hasPty,
          agentSessionId: t.agentSessionId,
          agentLaunchFlags: t.agentLaunchFlags,
          agentModelId: t.agentModelId,
          agentPresetId: t.agentPresetId,
          agentPresetColor: t.agentPresetColor,
          originalAgentPresetId: t.originalAgentPresetId,
          everDetectedAgent: t.everDetectedAgent,
          detectedAgentId: t.detectedAgentId,
          detectedProcessId: t.detectedProcessId,
        }));

      logInfo(`terminal:getAvailable: found ${sanitized.length} available terminals`);
      return sanitized;
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to get available terminals");
      throw new Error(`Failed to get available terminals: ${errorMessage}`);
    }
  };
  handlers.push(typedHandle(CHANNELS.TERMINAL_GET_AVAILABLE, handleTerminalGetAvailable));

  const handleTerminalGetByState = async (
    state: string
  ): Promise<import("../../../../shared/types/ipc.js").BackendTerminalInfo[]> => {
    try {
      if (typeof state !== "string" || !state) {
        throw new Error("Invalid state: must be a non-empty string");
      }

      const validStates = ["idle", "working", "waiting", "completed", "exited"];
      if (!validStates.includes(state)) {
        throw new Error(`Invalid state: must be one of ${validStates.join(", ")}`);
      }

      const terminals = await ptyClient.getTerminalsByStateAsync(
        state as import("../../../../shared/types/agent.js").AgentState
      );

      const sanitized = terminals
        .filter((t) => t.kind !== "dev-preview")
        .map((t) => ({
          id: t.id,
          projectId: t.projectId,
          kind: t.kind,

          launchAgentId: t.launchAgentId,
          title: t.title,
          cwd: t.cwd,
          worktreeId: t.worktreeId,
          agentState: t.agentState,
          lastStateChange: t.lastStateChange,
          spawnedAt: t.spawnedAt,
          isTrashed: t.isTrashed,
          trashExpiresAt: t.trashExpiresAt,
          activityTier: t.activityTier,
          hasPty: t.hasPty,
          agentSessionId: t.agentSessionId,
          agentLaunchFlags: t.agentLaunchFlags,
          agentModelId: t.agentModelId,
          agentPresetId: t.agentPresetId,
          agentPresetColor: t.agentPresetColor,
          originalAgentPresetId: t.originalAgentPresetId,
          everDetectedAgent: t.everDetectedAgent,
          detectedAgentId: t.detectedAgentId,
          detectedProcessId: t.detectedProcessId,
        }));

      logInfo(`terminal:getByState(${state}): found ${sanitized.length} terminals`);
      return sanitized;
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to get terminals by state");
      throw new Error(`Failed to get terminals by state: ${errorMessage}`);
    }
  };
  handlers.push(typedHandle(CHANNELS.TERMINAL_GET_BY_STATE, handleTerminalGetByState));

  const handleTerminalGetAll = async (): Promise<
    import("../../../../shared/types/ipc.js").BackendTerminalInfo[]
  > => {
    try {
      const terminals = await ptyClient.getAllTerminalsAsync();

      const sanitized = terminals
        .filter((t) => t.kind !== "dev-preview")
        .map((t) => ({
          id: t.id,
          projectId: t.projectId,
          kind: t.kind,

          launchAgentId: t.launchAgentId,
          title: t.title,
          cwd: t.cwd,
          worktreeId: t.worktreeId,
          agentState: t.agentState,
          lastStateChange: t.lastStateChange,
          spawnedAt: t.spawnedAt,
          isTrashed: t.isTrashed,
          trashExpiresAt: t.trashExpiresAt,
          activityTier: t.activityTier,
          hasPty: t.hasPty,
          agentSessionId: t.agentSessionId,
          agentLaunchFlags: t.agentLaunchFlags,
          agentModelId: t.agentModelId,
          agentPresetId: t.agentPresetId,
          agentPresetColor: t.agentPresetColor,
          originalAgentPresetId: t.originalAgentPresetId,
          everDetectedAgent: t.everDetectedAgent,
          detectedAgentId: t.detectedAgentId,
          detectedProcessId: t.detectedProcessId,
        }));

      logInfo(`terminal:getAll: found ${sanitized.length} terminals`);
      return sanitized;
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to get all terminals");
      throw new Error(`Failed to get all terminals: ${errorMessage}`);
    }
  };
  handlers.push(typedHandle(CHANNELS.TERMINAL_GET_ALL, handleTerminalGetAll));

  const handleTerminalSearchSemanticBuffers = async (
    query: string,
    isRegex: boolean
  ): Promise<import("../../../../shared/types/ipc/terminal.js").SemanticSearchMatch[]> => {
    if (typeof query !== "string") {
      throw new Error("Invalid query: must be a string");
    }
    if (typeof isRegex !== "boolean") {
      throw new Error("Invalid isRegex: must be a boolean");
    }
    // Cap query length so a pathological regex can't lock up the pty-host
    // event loop scanning every terminal's buffer.
    if (query.length === 0 || query.length > 500) {
      return [];
    }
    try {
      return await ptyClient.searchSemanticBuffersAsync(query, isRegex);
    } catch (error) {
      logWarn("terminal:searchSemanticBuffers failed", { error });
      return [];
    }
  };
  handlers.push(
    typedHandle(CHANNELS.TERMINAL_SEARCH_SEMANTIC_BUFFERS, handleTerminalSearchSemanticBuffers)
  );

  const handleTerminalReconnect = async (
    terminalId: string
  ): Promise<import("../../../../shared/types/ipc.js").TerminalReconnectResult> => {
    try {
      if (typeof terminalId !== "string" || !terminalId) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }

      const terminal = await ptyClient.getTerminalAsync(terminalId);

      if (!terminal) {
        logWarn(`terminal:reconnect: Terminal ${terminalId} not found`);
        return { exists: false };
      }

      if (getAgentAvailabilityStore().isHelpTerminal(terminal.id)) {
        logInfo(`terminal:reconnect: Skipping help terminal ${terminalId}`);
        return { exists: false };
      }

      logInfo(`terminal:reconnect: Reconnecting to ${terminalId}`);

      return {
        exists: true,
        id: terminal.id,
        projectId: terminal.projectId,
        kind: terminal.kind,

        launchAgentId: terminal.launchAgentId,
        title: terminal.title,
        cwd: terminal.cwd,
        agentState: terminal.agentState,
        lastStateChange: terminal.lastStateChange,
        spawnedAt: terminal.spawnedAt,
        activityTier: terminal.activityTier,
        hasPty: terminal.hasPty,
        agentSessionId: terminal.agentSessionId,
        agentLaunchFlags: terminal.agentLaunchFlags,
        agentModelId: terminal.agentModelId,
        agentPresetId: terminal.agentPresetId,
        agentPresetColor: terminal.agentPresetColor,
        originalAgentPresetId: terminal.originalAgentPresetId,
        everDetectedAgent: terminal.everDetectedAgent,
        detectedAgentId: terminal.detectedAgentId,
        detectedProcessId: terminal.detectedProcessId,
      };
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to reconnect to terminal");
      throw new Error(`Failed to reconnect to terminal: ${errorMessage}`);
    }
  };
  handlers.push(typedHandle(CHANNELS.TERMINAL_RECONNECT, handleTerminalReconnect));

  return () => handlers.forEach((cleanup) => cleanup());
}
