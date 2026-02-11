/**
 * Terminal snapshot handlers - getSerializedState, wake, getInfo.
 */

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";
import { TerminalReplayHistoryPayloadSchema } from "../../../schemas/index.js";
import { logDebug, logInfo, logWarn, logError } from "../../../utils/logger.js";

export function registerTerminalSnapshotHandlers(deps: HandlerDependencies): () => void {
  const { ptyClient } = deps;
  const handlers: Array<() => void> = [];

  const handleTerminalWake = async (
    _event: Electron.IpcMainInvokeEvent,
    id: string
  ): Promise<{ state: string | null; warnings?: string[] }> => {
    try {
      if (typeof id !== "string" || !id) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }
      return await ptyClient.wakeTerminal(id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to wake terminal: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_WAKE, handleTerminalWake);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_WAKE));

  const handleTerminalGetSerializedState = async (
    _event: Electron.IpcMainInvokeEvent,
    terminalId: string
  ): Promise<string | null> => {
    try {
      if (typeof terminalId !== "string" || !terminalId) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }

      const serializedState = await ptyClient.getSerializedStateAsync(terminalId);

      if (process.env.CANOPY_VERBOSE) {
        logDebug(
          `terminal:getSerializedState(${terminalId}): ${serializedState ? `${serializedState.length} bytes` : "null"}`
        );
      }
      return serializedState;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get serialized terminal state: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_SERIALIZED_STATE, handleTerminalGetSerializedState);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_SERIALIZED_STATE));

  const handleTerminalGetSerializedStates = async (
    _event: Electron.IpcMainInvokeEvent,
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
  ipcMain.handle(CHANNELS.TERMINAL_GET_SERIALIZED_STATES, handleTerminalGetSerializedStates);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_SERIALIZED_STATES));

  const handleTerminalGetInfo = async (
    _event: Electron.IpcMainInvokeEvent,
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get terminal info: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_INFO, handleTerminalGetInfo);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_INFO));

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
  ipcMain.handle(CHANNELS.TERMINAL_GET_SHARED_BUFFERS, handleTerminalGetSharedBuffers);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_SHARED_BUFFERS));

  const handleTerminalGetAnalysisBuffer = async (): Promise<SharedArrayBuffer | null> => {
    try {
      return ptyClient.getAnalysisBuffer();
    } catch (error) {
      logWarn("Failed to get analysis buffer", { error });
      return null;
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_ANALYSIS_BUFFER, handleTerminalGetAnalysisBuffer);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_ANALYSIS_BUFFER));

  const handleTerminalReplayHistory = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: unknown
  ) => {
    const parseResult = TerminalReplayHistoryPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      logError("terminal:replayHistory validation failed", undefined, {
        error: parseResult.error.format(),
      });
      throw new Error(`Invalid payload: ${parseResult.error.message}`);
    }

    const { terminalId, maxLines } = parseResult.data;

    try {
      const replayed = await ptyClient.replayHistoryAsync(terminalId, maxLines);

      logInfo(`terminal:replayHistory(${terminalId}): replayed ${replayed} lines`);
      return { replayed };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to replay terminal history: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_REPLAY_HISTORY, handleTerminalReplayHistory);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_REPLAY_HISTORY));

  const handleTerminalGetForProject = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string
  ) => {
    try {
      if (typeof projectId !== "string" || !projectId) {
        throw new Error("Invalid project ID: must be a non-empty string");
      }

      const terminalIds = await ptyClient.getTerminalsForProjectAsync(projectId);

      const terminals = [];
      for (const id of terminalIds) {
        const terminal = await ptyClient.getTerminalAsync(id);
        // Dev preview PTYs should not be rehydrated as generic terminal panels
        // during project switching/hydration.
        if (terminal && terminal.kind !== "dev-preview") {
          terminals.push({
            id: terminal.id,
            projectId: terminal.projectId,
            kind: terminal.kind,
            type: terminal.type,
            agentId: terminal.agentId,
            title: terminal.title,
            cwd: terminal.cwd,
            worktreeId: terminal.worktreeId,
            agentState: terminal.agentState,
            lastStateChange: terminal.lastStateChange,
            spawnedAt: terminal.spawnedAt,
            isTrashed: terminal.isTrashed,
            trashExpiresAt: terminal.trashExpiresAt,
            activityTier: terminal.activityTier,
            hasPty: terminal.hasPty,
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get terminals for project: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_FOR_PROJECT, handleTerminalGetForProject);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_FOR_PROJECT));

  const handleTerminalGetAvailable = async () => {
    try {
      const terminals = await ptyClient.getAvailableTerminalsAsync();

      const sanitized = terminals
        .filter((t) => t.kind !== "dev-preview")
        .map((t) => ({
          id: t.id,
          projectId: t.projectId,
          kind: t.kind,
          type: t.type,
          agentId: t.agentId,
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
        }));

      logInfo(`terminal:getAvailable: found ${sanitized.length} available terminals`);
      return sanitized;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get available terminals: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_AVAILABLE, handleTerminalGetAvailable);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_AVAILABLE));

  const handleTerminalGetByState = async (_event: Electron.IpcMainInvokeEvent, state: string) => {
    try {
      if (typeof state !== "string" || !state) {
        throw new Error("Invalid state: must be a non-empty string");
      }

      const validStates = ["idle", "working", "waiting", "completed", "failed"];
      if (!validStates.includes(state)) {
        throw new Error(`Invalid state: must be one of ${validStates.join(", ")}`);
      }

      const terminals = await ptyClient.getTerminalsByStateAsync(
        state as import("../../../../shared/types/domain.js").AgentState
      );

      const sanitized = terminals
        .filter((t) => t.kind !== "dev-preview")
        .map((t) => ({
          id: t.id,
          projectId: t.projectId,
          kind: t.kind,
          type: t.type,
          agentId: t.agentId,
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
        }));

      logInfo(`terminal:getByState(${state}): found ${sanitized.length} terminals`);
      return sanitized;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get terminals by state: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_BY_STATE, handleTerminalGetByState);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_BY_STATE));

  const handleTerminalGetAll = async () => {
    try {
      const terminals = await ptyClient.getAllTerminalsAsync();

      const sanitized = terminals
        .filter((t) => t.kind !== "dev-preview")
        .map((t) => ({
          id: t.id,
          projectId: t.projectId,
          kind: t.kind,
          type: t.type,
          agentId: t.agentId,
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
        }));

      logInfo(`terminal:getAll: found ${sanitized.length} terminals`);
      return sanitized;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get all terminals: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_ALL, handleTerminalGetAll);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_ALL));

  const handleTerminalReconnect = async (
    _event: Electron.IpcMainInvokeEvent,
    terminalId: string
  ) => {
    try {
      if (typeof terminalId !== "string" || !terminalId) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }

      const terminal = await ptyClient.getTerminalAsync(terminalId);

      if (!terminal) {
        logWarn(`terminal:reconnect: Terminal ${terminalId} not found`);
        return { exists: false, error: "Terminal not found in backend" };
      }

      logInfo(`terminal:reconnect: Reconnecting to ${terminalId}`);

      return {
        exists: true,
        id: terminal.id,
        projectId: terminal.projectId,
        kind: terminal.kind,
        type: terminal.type,
        agentId: terminal.agentId,
        title: terminal.title,
        cwd: terminal.cwd,
        worktreeId: terminal.worktreeId,
        agentState: terminal.agentState,
        lastStateChange: terminal.lastStateChange,
        spawnedAt: terminal.spawnedAt,
        activityTier: terminal.activityTier,
        hasPty: terminal.hasPty,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to reconnect to terminal: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_RECONNECT, handleTerminalReconnect);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_RECONNECT));

  return () => handlers.forEach((cleanup) => cleanup());
}
