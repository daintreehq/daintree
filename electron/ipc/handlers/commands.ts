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
import { AppError } from "../../utils/errorTypes.js";

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

  // Execute command. Validation failures throw `AppError({code: "VALIDATION"})`;
  // command-domain success/failure is still carried by the returned
  // `CommandResult` (the commands system has its own structured result contract
  // that includes optional `prompt` injection — intentional, not an envelope).
  const handleCommandsExecute = async (payload: CommandExecutePayload): Promise<CommandResult> => {
    if (!payload || typeof payload.commandId !== "string") {
      throw new AppError({
        code: "VALIDATION",
        message: "Invalid command execution payload",
      });
    }

    const context = payload.context ?? {};
    if (typeof context !== "object" || Array.isArray(context)) {
      throw new AppError({
        code: "VALIDATION",
        message: "Context must be a plain object",
      });
    }

    const args = payload.args ?? {};
    if (args !== null && (typeof args !== "object" || Array.isArray(args))) {
      throw new AppError({
        code: "VALIDATION",
        message: "Arguments must be a plain object",
      });
    }

    return commandService.execute(payload.commandId, context, args);
  };
  handlers.push(
    // @ts-expect-error: result type CommandResult contains {success} — pending migration to throw AppError. See #6020.
    typedHandle(CHANNELS.COMMANDS_EXECUTE, handleCommandsExecute)
  );

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
