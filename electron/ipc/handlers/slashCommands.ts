import path from "path";
import { defineIpcNamespace, op } from "../define.js";
import { SLASH_COMMANDS_METHOD_CHANNELS } from "./slashCommands.preload.js";
import { SlashCommandListRequestSchema } from "../../schemas/ipc.js";
import { slashCommandService } from "../../services/SlashCommandService.js";
import type { SlashCommand, SlashCommandListRequest } from "../../../shared/types/index.js";

async function handleList(payload: SlashCommandListRequest): Promise<SlashCommand[]> {
  const parsed = SlashCommandListRequestSchema.safeParse(payload);
  if (!parsed.success) {
    console.error("[IPC] Invalid slash-commands:list payload:", parsed.error.format());
    return [];
  }

  const { agentId, projectPath } = parsed.data;
  const safeProjectPath = projectPath && path.isAbsolute(projectPath) ? projectPath : undefined;
  return slashCommandService.list(agentId, safeProjectPath);
}

export const slashCommandsNamespace = defineIpcNamespace({
  name: "slashCommands",
  ops: {
    list: op(SLASH_COMMANDS_METHOD_CHANNELS.list, handleList),
  },
});

export function registerSlashCommandHandlers(): () => void {
  return slashCommandsNamespace.register();
}
