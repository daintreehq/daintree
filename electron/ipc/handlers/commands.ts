/**
 * IPC handlers for the command system.
 * Exposes command registry and execution to the renderer process.
 */

import { defineIpcNamespace, op } from "../define.js";
import { COMMANDS_METHOD_CHANNELS } from "./commands.preload.js";
import { commandService } from "../../services/CommandService.js";
import { builtinCommandsReady } from "../../services/commands/index.js";
import type {
  BuilderStep,
  CommandContext,
  CommandExecutePayload,
  CommandGetPayload,
  CommandManifestEntry,
  CommandResult,
} from "../../../shared/types/commands.js";
import { AppError } from "../../utils/errorTypes.js";

async function handleCommandsList(context?: CommandContext): Promise<CommandManifestEntry[]> {
  // Built-in registration runs from the deferred queue's heavy group; await it
  // so an early command-palette open can't observe an empty registry.
  await builtinCommandsReady();
  return await commandService.list(context);
}

async function handleCommandsGet(payload: CommandGetPayload): Promise<CommandManifestEntry | null> {
  if (!payload || typeof payload.commandId !== "string") {
    console.warn("[CommandHandlers] Invalid commands:get payload", payload);
    return null;
  }
  await builtinCommandsReady();
  return (await commandService.getManifest(payload.commandId, payload.context)) ?? null;
}

// Execute command. Validation failures throw `AppError({code: "VALIDATION"})`;
// command-domain success/failure is still carried by the returned
// `CommandResult` (the commands system has its own structured result contract
// that includes optional `prompt` injection — intentional, not an envelope).
async function handleCommandsExecute(payload: CommandExecutePayload): Promise<CommandResult> {
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

  await builtinCommandsReady();
  return commandService.execute(payload.commandId, context, args);
}

async function handleCommandsGetBuilder(
  commandId: string
): Promise<{ steps: BuilderStep[] } | null> {
  if (typeof commandId !== "string") {
    return null;
  }
  await builtinCommandsReady();
  return commandService.getBuilder(commandId) ?? null;
}

export const commandsNamespace = defineIpcNamespace({
  name: "commands",
  ops: {
    list: op(COMMANDS_METHOD_CHANNELS.list, handleCommandsList),
    get: op(COMMANDS_METHOD_CHANNELS.get, handleCommandsGet),
    // @ts-expect-error: result type CommandResult contains {success} — pending migration to throw AppError. See #6020.
    execute: op(COMMANDS_METHOD_CHANNELS.execute, handleCommandsExecute),
    getBuilder: op(COMMANDS_METHOD_CHANNELS.getBuilder, handleCommandsGetBuilder),
  },
});

export function registerCommandHandlers(): () => void {
  return commandsNamespace.register();
}
