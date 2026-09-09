import path from "path";
import type { z } from "zod";
import { defineIpcNamespace, opValidated } from "../define.js";
import { SLASH_COMMANDS_METHOD_CHANNELS } from "./slashCommands.preload.js";
import { SlashCommandListRequestSchema } from "../../schemas/ipc.js";
import { slashCommandService } from "../../services/SlashCommandService.js";
import type { SlashCommand } from "../../../shared/types/index.js";

async function handleList(
  payload: z.output<typeof SlashCommandListRequestSchema>
): Promise<SlashCommand[]> {
  const { agentId, projectPath } = payload;
  const safeProjectPath = projectPath && path.isAbsolute(projectPath) ? projectPath : undefined;
  return slashCommandService.list(agentId, safeProjectPath);
}

export const slashCommandsNamespace = defineIpcNamespace({
  name: "slashCommands",
  ops: {
    list: opValidated(
      SLASH_COMMANDS_METHOD_CHANNELS.list,
      SlashCommandListRequestSchema,
      handleList
    ),
  },
});

export function registerSlashCommandHandlers(): () => void {
  return slashCommandsNamespace.register();
}
