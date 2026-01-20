/**
 * IPC handlers for the command system.
 * Exposes command registry and execution to the renderer process.
 */

import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { commandService } from "../../services/CommandService.js";
import type {
  CommandContext,
  CommandExecutePayload,
  CommandGetPayload,
  CommandManifestEntry,
  CommandResult,
  CanopyCommand,
} from "../../../shared/types/commands.js";

export function registerCommandHandlers(): () => void {
  const handlers: Array<() => void> = [];

  // List all commands
  const handleCommandsList = async (
    _event: Electron.IpcMainInvokeEvent,
    context?: CommandContext
  ): Promise<CommandManifestEntry[]> => {
    return commandService.list(context);
  };
  ipcMain.handle(CHANNELS.COMMANDS_LIST, handleCommandsList);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.COMMANDS_LIST));

  // Get single command
  const handleCommandsGet = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: CommandGetPayload
  ): Promise<CommandManifestEntry | null> => {
    if (!payload || typeof payload.commandId !== "string") {
      console.warn("[CommandHandlers] Invalid commands:get payload", payload);
      return null;
    }
    return commandService.getManifest(payload.commandId, payload.context) ?? null;
  };
  ipcMain.handle(CHANNELS.COMMANDS_GET, handleCommandsGet);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.COMMANDS_GET));

  // Execute command
  const handleCommandsExecute = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: CommandExecutePayload
  ): Promise<CommandResult> => {
    if (!payload || typeof payload.commandId !== "string") {
      return {
        success: false,
        error: {
          code: "INVALID_PAYLOAD",
          message: "Invalid command execution payload",
        },
      };
    }

    // Validate context is a plain object
    const context = payload.context ?? {};
    if (typeof context !== "object" || Array.isArray(context)) {
      return {
        success: false,
        error: {
          code: "INVALID_PAYLOAD",
          message: "Context must be a plain object",
        },
      };
    }

    // Validate args is a plain object
    const args = payload.args ?? {};
    if (args !== null && (typeof args !== "object" || Array.isArray(args))) {
      return {
        success: false,
        error: {
          code: "INVALID_PAYLOAD",
          message: "Arguments must be a plain object",
        },
      };
    }

    return commandService.execute(payload.commandId, context, args);
  };
  ipcMain.handle(CHANNELS.COMMANDS_EXECUTE, handleCommandsExecute);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.COMMANDS_EXECUTE));

  // Get command builder
  const handleCommandsGetBuilder = async (
    _event: Electron.IpcMainInvokeEvent,
    commandId: string
  ): Promise<CanopyCommand["builder"] | null> => {
    if (typeof commandId !== "string") {
      return null;
    }
    return commandService.getBuilder(commandId) ?? null;
  };
  ipcMain.handle(CHANNELS.COMMANDS_GET_BUILDER, handleCommandsGetBuilder);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.COMMANDS_GET_BUILDER));

  return () => handlers.forEach((cleanup) => cleanup());
}
