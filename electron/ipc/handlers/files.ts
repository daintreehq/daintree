import { ipcMain } from "electron";
import path from "path";
import fs from "fs/promises";
import { CHANNELS } from "../channels.js";
import { checkRateLimit } from "../utils.js";
import { fileSearchService } from "../../services/FileSearchService.js";
import { FileSearchPayloadSchema, FileReadPayloadSchema } from "../../schemas/ipc.js";

const FILE_SIZE_LIMIT = 512 * 1024; // 500 KB

export function registerFilesHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleSearch = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: unknown
  ): Promise<{ files: string[] }> => {
    checkRateLimit(CHANNELS.FILES_SEARCH, 20, 10_000);

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

  const handleRead = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: unknown
  ): Promise<
    | { ok: true; content: string }
    | {
        ok: false;
        code: "BINARY_FILE" | "FILE_TOO_LARGE" | "NOT_FOUND" | "OUTSIDE_ROOT" | "INVALID_PATH";
      }
  > => {
    const parsed = FileReadPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("[IPC] Invalid files:read payload:", parsed.error.format());
      return { ok: false, code: "INVALID_PATH" };
    }

    const { path: filePath, rootPath } = parsed.data;

    if (!path.isAbsolute(filePath) || !path.isAbsolute(rootPath)) {
      return { ok: false, code: "INVALID_PATH" };
    }

    // Containment check: file must be inside rootPath
    const normalizedFile = path.normalize(filePath);
    const normalizedRoot = path.normalize(rootPath);
    if (
      !normalizedFile.startsWith(normalizedRoot + path.sep) &&
      normalizedFile !== normalizedRoot
    ) {
      return { ok: false, code: "OUTSIDE_ROOT" };
    }

    try {
      const stat = await fs.stat(normalizedFile);

      if (stat.size > FILE_SIZE_LIMIT) {
        return { ok: false, code: "FILE_TOO_LARGE" };
      }

      const buffer = await fs.readFile(normalizedFile);

      // Binary detection: check for null bytes in first 8 KB
      const checkLength = Math.min(buffer.length, 8192);
      for (let i = 0; i < checkLength; i++) {
        if (buffer[i] === 0) {
          return { ok: false, code: "BINARY_FILE" };
        }
      }

      return { ok: true, content: buffer.toString("utf-8") };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { ok: false, code: "NOT_FOUND" };
      }
      console.error("[IPC] files:read failed:", error);
      return { ok: false, code: "INVALID_PATH" };
    }
  };

  ipcMain.handle(CHANNELS.FILES_READ, handleRead);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.FILES_READ));

  return () => handlers.forEach((cleanup) => cleanup());
}
