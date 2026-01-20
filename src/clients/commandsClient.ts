import type {
  CommandContext,
  CommandManifestEntry,
  CommandResult,
  CommandExecutePayload,
  CommandGetPayload,
  BuilderStep,
} from "@shared/types/commands";

export const commandsClient = {
  list: (context?: CommandContext): Promise<CommandManifestEntry[]> => {
    return window.electron.commands.list(context);
  },

  get: (payload: CommandGetPayload): Promise<CommandManifestEntry | null> => {
    return window.electron.commands.get(payload);
  },

  execute: (payload: CommandExecutePayload): Promise<CommandResult> => {
    return window.electron.commands.execute(payload);
  },

  getBuilder: (commandId: string): Promise<{ steps: BuilderStep[] } | null> => {
    return window.electron.commands.getBuilder(commandId);
  },
};
