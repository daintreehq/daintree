/**
 * Terminal snapshot handlers - getSerializedState, wake, getInfo.
 */

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";
import { TerminalReplayHistoryPayloadSchema } from "../../../schemas/index.js";

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
    payload: unknown
  ) => {
    const parseResult = TerminalReplayHistoryPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      console.error("[IPC] terminal:replayHistory validation failed:", parseResult.error.format());
      throw new Error(`Invalid payload: ${parseResult.error.message}`);
    }

    const { terminalId, maxLines } = parseResult.data;

    try {
      const replayed = await ptyClient.replayHistoryAsync(terminalId, maxLines);

      console.log(`[IPC] terminal:replayHistory(${terminalId}): replayed ${replayed} lines`);
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
        // Dev preview PTYs are managed by DevPreviewService and should not be rehydrated
        // as generic terminal panels during project switching/hydration.
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
        lastStateChange: terminal.lastStateChange,
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
