/**
 * Terminal snapshot handlers - getSnapshot, getCleanLog, getSerializedState, wake, getInfo.
 */

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";
import type {
  TerminalGetCleanLogRequest,
  TerminalGetCleanLogResponse,
  TerminalGetScreenSnapshotOptions,
  TerminalScreenSnapshot,
} from "../../../../shared/types/ipc/terminal.js";

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
        console.log(
          `[IPC] terminal:getSerializedState(${terminalId}): ${serializedState ? `${serializedState.length} bytes` : "null"}`
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

  const handleTerminalGetSnapshot = async (
    _event: Electron.IpcMainInvokeEvent,
    terminalId: string,
    options?: TerminalGetScreenSnapshotOptions
  ): Promise<TerminalScreenSnapshot | null> => {
    if (typeof terminalId !== "string" || !terminalId) {
      throw new Error("Invalid terminal ID: must be a non-empty string");
    }
    if (options !== undefined && (options === null || typeof options !== "object")) {
      throw new Error("Invalid snapshot options");
    }
    return ptyClient.getScreenSnapshotAsync(terminalId, options);
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_SNAPSHOT, handleTerminalGetSnapshot);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_SNAPSHOT));

  const handleTerminalGetCleanLog = async (
    _event: Electron.IpcMainInvokeEvent,
    request: TerminalGetCleanLogRequest
  ): Promise<TerminalGetCleanLogResponse> => {
    if (!request || typeof request !== "object") {
      throw new Error("Invalid request");
    }
    if (typeof request.id !== "string" || !request.id) {
      throw new Error("Invalid terminal ID: must be a non-empty string");
    }
    if (request.sinceSequence !== undefined && typeof request.sinceSequence !== "number") {
      throw new Error("Invalid sinceSequence");
    }
    if (request.limit !== undefined && typeof request.limit !== "number") {
      throw new Error("Invalid limit");
    }
    return ptyClient.getCleanLogAsync(request);
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_CLEAN_LOG, handleTerminalGetCleanLog);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_CLEAN_LOG));

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
      console.warn("[IPC] Failed to get shared buffers:", error);
      return { visualBuffers: [], signalBuffer: null };
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_SHARED_BUFFERS, handleTerminalGetSharedBuffers);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_SHARED_BUFFERS));

  const handleTerminalGetAnalysisBuffer = async (): Promise<SharedArrayBuffer | null> => {
    try {
      return ptyClient.getAnalysisBuffer();
    } catch (error) {
      console.warn("[IPC] Failed to get analysis buffer:", error);
      return null;
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_ANALYSIS_BUFFER, handleTerminalGetAnalysisBuffer);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_ANALYSIS_BUFFER));

  const handleTerminalReplayHistory = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { terminalId: string; maxLines?: number }
  ) => {
    try {
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      if (typeof payload.terminalId !== "string" || !payload.terminalId) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }

      const maxLines = payload.maxLines ?? 100;

      const replayed = await ptyClient.replayHistoryAsync(payload.terminalId, maxLines);

      console.log(
        `[IPC] terminal:replayHistory(${payload.terminalId}): replayed ${replayed} lines`
      );
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
        if (terminal) {
          terminals.push({
            id: terminal.id,
            projectId: terminal.projectId,
            type: terminal.type,
            title: terminal.title,
            cwd: terminal.cwd,
            worktreeId: terminal.worktreeId,
            agentState: terminal.agentState,
            spawnedAt: terminal.spawnedAt,
          });
        }
      }

      console.log(
        `[IPC] terminal:getForProject(${projectId}): found ${terminals.length} terminals`
      );
      return terminals;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get terminals for project: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_FOR_PROJECT, handleTerminalGetForProject);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_FOR_PROJECT));

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
        console.warn(`[IPC] terminal:reconnect: Terminal ${terminalId} not found`);
        return { exists: false, error: "Terminal not found in backend" };
      }

      console.log(`[IPC] terminal:reconnect: Reconnecting to ${terminalId}`);

      return {
        exists: true,
        id: terminal.id,
        type: terminal.type,
        cwd: terminal.cwd,
        agentState: terminal.agentState,
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
