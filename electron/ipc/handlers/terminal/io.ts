/**
 * Terminal I/O handlers - input, resize, submit, sendKey, acknowledge, forceResume.
 */

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";
import type { TerminalResizePayload } from "../../../types/index.js";
import { TerminalResizePayloadSchema } from "../../../schemas/ipc.js";
import type { PtyHostActivityTier } from "../../../../shared/types/pty-host.js";

export function registerTerminalIOHandlers(deps: HandlerDependencies): () => void {
  const { ptyClient } = deps;
  const handlers: Array<() => void> = [];

  const handleTerminalInput = (_event: Electron.IpcMainEvent, id: string, data: string) => {
    try {
      if (typeof id !== "string" || typeof data !== "string") {
        console.error("Invalid terminal input parameters");
        return;
      }
      ptyClient.write(id, data);
    } catch (error) {
      console.error("Error writing to terminal:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_INPUT, handleTerminalInput);
  handlers.push(() => ipcMain.removeListener(CHANNELS.TERMINAL_INPUT, handleTerminalInput));

  const handleTerminalSendKey = (_event: Electron.IpcMainEvent, id: string, key: string) => {
    try {
      if (typeof id !== "string" || typeof key !== "string") {
        console.error("Invalid terminal sendKey parameters");
        return;
      }
      ptyClient.sendKey(id, key);
    } catch (error) {
      console.error("Error sending key to terminal:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_SEND_KEY, handleTerminalSendKey);
  handlers.push(() => ipcMain.removeListener(CHANNELS.TERMINAL_SEND_KEY, handleTerminalSendKey));

  const handleTerminalSubmit = async (
    _event: Electron.IpcMainInvokeEvent,
    id: string,
    text: string
  ) => {
    try {
      if (typeof id !== "string" || typeof text !== "string") {
        throw new Error("Invalid terminal submit parameters");
      }
      ptyClient.submit(id, text);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to submit to terminal: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_SUBMIT, handleTerminalSubmit);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_SUBMIT));

  const handleTerminalResize = (_event: Electron.IpcMainEvent, payload: TerminalResizePayload) => {
    try {
      const parseResult = TerminalResizePayloadSchema.safeParse(payload);
      if (!parseResult.success) {
        console.error("[IPC] Invalid terminal resize payload:", parseResult.error.format());
        return;
      }

      const { id, cols, rows } = parseResult.data;
      const clampedCols = Math.max(1, Math.min(500, Math.floor(cols)));
      const clampedRows = Math.max(1, Math.min(500, Math.floor(rows)));

      ptyClient.resize(id, clampedCols, clampedRows);
    } catch (error) {
      console.error("Error resizing terminal:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_RESIZE, handleTerminalResize);
  handlers.push(() => ipcMain.removeListener(CHANNELS.TERMINAL_RESIZE, handleTerminalResize));

  const handleTerminalSetActivityTier = (
    _event: Electron.IpcMainEvent,
    payload: { id: string; tier: PtyHostActivityTier }
  ) => {
    try {
      if (!payload || typeof payload !== "object") {
        return;
      }
      const { id, tier } = payload;
      if (typeof id !== "string" || !id) return;
      const effectiveTier: PtyHostActivityTier = tier === "background" ? "background" : "active";
      ptyClient.setActivityTier(id, effectiveTier);
    } catch (error) {
      console.error("[IPC] Failed to set activity tier:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_SET_ACTIVITY_TIER, handleTerminalSetActivityTier);
  handlers.push(() =>
    ipcMain.removeListener(CHANNELS.TERMINAL_SET_ACTIVITY_TIER, handleTerminalSetActivityTier)
  );

  const handleTerminalAcknowledgeData = (
    _event: Electron.IpcMainEvent,
    payload: { id: string; length: number }
  ) => {
    try {
      if (!payload || typeof payload !== "object") {
        return;
      }
      if (typeof payload.id !== "string" || typeof payload.length !== "number") {
        return;
      }
      ptyClient.acknowledgeData(payload.id, payload.length);
    } catch (error) {
      console.error("Error acknowledging terminal data:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_ACKNOWLEDGE_DATA, handleTerminalAcknowledgeData);
  handlers.push(() =>
    ipcMain.removeListener(CHANNELS.TERMINAL_ACKNOWLEDGE_DATA, handleTerminalAcknowledgeData)
  );

  const handleTerminalForceResume = async (
    _event: Electron.IpcMainInvokeEvent,
    id: string
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      if (typeof id !== "string" || !id) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }
      ptyClient.forceResume(id);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[IPC] Failed to force resume terminal ${id}:`, errorMessage);
      return { success: false, error: errorMessage };
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_FORCE_RESUME, handleTerminalForceResume);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_FORCE_RESUME));

  return () => handlers.forEach((cleanup) => cleanup());
}
