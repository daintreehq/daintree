import { ipcMain } from "electron";
import path from "path";
import { CHANNELS } from "../channels.js";
import { fileSearchService } from "../../services/FileSearchService.js";
import { FileSearchPayloadSchema } from "../../schemas/ipc.js";

export function registerFilesHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleSearch = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: unknown
  ): Promise<{ files: string[] }> => {
    const parsed = FileSearchPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("[IPC] Invalid files:search payload:", parsed.error.format());
      return { files: [] };
    }

    const { cwd, query, limit } = parsed.data;

    if (!path.isAbsolute(cwd)) {
      return { files: [] };
    }

    try {
      const files = await fileSearchService.search({ cwd, query, limit });
      return { files };
    } catch (error) {
      console.error("[IPC] files:search failed:", error);
      return { files: [] };
    }
  };

  ipcMain.handle(CHANNELS.FILES_SEARCH, handleSearch);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.FILES_SEARCH));

  return () => handlers.forEach((cleanup) => cleanup());
}
