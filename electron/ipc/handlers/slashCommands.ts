import path from "path";
import { CHANNELS } from "../channels.js";
import { SlashCommandListRequestSchema } from "../../schemas/ipc.js";
import { slashCommandService } from "../../services/SlashCommandService.js";
import type { SlashCommand } from "../../../shared/types/index.js";
import { typedHandle } from "../utils.js";

export function registerSlashCommandHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleList = async (payload: unknown): Promise<SlashCommand[]> => {
    const parsed = SlashCommandListRequestSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("[IPC] Invalid slash-commands:list payload:", parsed.error.format());
      return [];
    }

    const { agentId, projectPath } = parsed.data;
    const safeProjectPath = projectPath && path.isAbsolute(projectPath) ? projectPath : undefined;
    return slashCommandService.list(agentId, safeProjectPath);
  };

  handlers.push(typedHandle(CHANNELS.SLASH_COMMANDS_LIST, handleList));

  return () => handlers.forEach((cleanup) => cleanup());
}
