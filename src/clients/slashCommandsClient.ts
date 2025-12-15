import type { SlashCommand, SlashCommandListRequest } from "@shared/types";

export const slashCommandsClient = {
  list: (payload: SlashCommandListRequest): Promise<SlashCommand[]> => {
    return window.electron.slashCommands.list(payload);
  },
};
