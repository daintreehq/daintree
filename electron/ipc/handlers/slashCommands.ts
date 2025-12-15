import { ipcMain } from "electron";
import path from "path";
import { CHANNELS } from "../channels.js";
import { SlashCommandListRequestSchema } from "../../schemas/ipc.js";
import { slashCommandService } from "../../services/SlashCommandService.js";
import type { SlashCommand } from "../../../shared/types/index.js";

export function registerSlashCommandHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleList = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: unknown
  ): Promise<SlashCommand[]> => {
    const parsed = SlashCommandListRequestSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("[IPC] Invalid slash-commands:list payload:", parsed.error.format());
      return [];
    }

    const { agentId, projectPath } = parsed.data;
    const safeProjectPath = projectPath && path.isAbsolute(projectPath) ? projectPath : undefined;
    return slashCommandService.list(agentId, safeProjectPath);
  };

  ipcMain.handle(CHANNELS.SLASH_COMMANDS_LIST, handleList);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SLASH_COMMANDS_LIST));

  return () => handlers.forEach((cleanup) => cleanup());
}
