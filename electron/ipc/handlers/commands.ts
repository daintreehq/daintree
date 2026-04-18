/**
 * IPC handlers for the command system.
 * Exposes command registry and execution to the renderer process.
 */

import { CHANNELS } from "../channels.js";
import { commandService } from "../../services/CommandService.js";
import type {
  CommandContext,
  CommandExecutePayload,
  CommandGetPayload,
  CommandManifestEntry,
  CommandResult,
  DaintreeCommand,
} from "../../../shared/types/commands.js";
import { typedHandle } from "../utils.js";

export function registerCommandHandlers(): () => void {
  const handlers: Array<() => void> = [];

  // List all commands
  const handleCommandsList = async (context?: CommandContext): Promise<CommandManifestEntry[]> => {
    return await commandService.list(context);
  };
  handlers.push(typedHandle(CHANNELS.COMMANDS_LIST, handleCommandsList));

  // Get single command
  const handleCommandsGet = async (
    payload: CommandGetPayload
  ): Promise<CommandManifestEntry | null> => {
    if (!payload || typeof payload.commandId !== "string") {
      console.warn("[CommandHandlers] Invalid commands:get payload", payload);
      return null;
    }
    return (await commandService.getManifest(payload.commandId, payload.context)) ?? null;
  };
  handlers.push(typedHandle(CHANNELS.COMMANDS_GET, handleCommandsGet));

  // Execute command
  const handleCommandsExecute = async (payload: CommandExecutePayload): Promise<CommandResult> => {
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
  handlers.push(typedHandle(CHANNELS.COMMANDS_EXECUTE, handleCommandsExecute));

  // Get command builder
  const handleCommandsGetBuilder = async (
    commandId: string
  ): Promise<DaintreeCommand["builder"] | null> => {
    if (typeof commandId !== "string") {
      return null;
    }
    return commandService.getBuilder(commandId) ?? null;
  };
  handlers.push(typedHandle(CHANNELS.COMMANDS_GET_BUILDER, handleCommandsGetBuilder));

  return () => handlers.forEach((cleanup) => cleanup());
}
