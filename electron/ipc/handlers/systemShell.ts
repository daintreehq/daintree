import { ipcMain, shell } from "electron";
import os from "os";
import { CHANNELS } from "../channels.js";
import { openExternalUrl } from "../../utils/openExternal.js";
import { projectStore } from "../../services/ProjectStore.js";
import {
  SystemOpenExternalPayloadSchema,
  SystemOpenPathPayloadSchema,
  SystemOpenInEditorPayloadSchema,
} from "../../schemas/index.js";
import type { HandlerDependencies } from "../types.js";

export function registerSystemShellHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleSystemOpenExternal = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: unknown
  ) => {
    const parseResult = SystemOpenExternalPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      console.error("[IPC] system:open-external validation failed:", parseResult.error.format());
      throw new Error(`Invalid payload: ${parseResult.error.message}`);
    }

    const { url } = parseResult.data;
    console.log("[IPC] system:open-external called with:", url);
    try {
      await openExternalUrl(url);
      console.log("[IPC] system:open-external completed successfully");
    } catch (error) {
      console.error("[IPC] Failed to open external URL:", error);
      throw error;
    }
  };
  ipcMain.handle(CHANNELS.SYSTEM_OPEN_EXTERNAL, handleSystemOpenExternal);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_OPEN_EXTERNAL));

  const handleSystemOpenPath = async (_event: Electron.IpcMainInvokeEvent, payload: unknown) => {
    const parseResult = SystemOpenPathPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      console.error("[IPC] system:open-path validation failed:", parseResult.error.format());
      throw new Error(`Invalid payload: ${parseResult.error.message}`);
    }

    const { path: targetPath } = parseResult.data;
    const fs = await import("fs");
    const pathModule = await import("path");

    try {
      if (!pathModule.isAbsolute(targetPath)) {
        throw new Error("Only absolute paths are allowed");
      }
      await fs.promises.access(targetPath);
      const errorString = await shell.openPath(targetPath);
      if (errorString) {
        throw new Error(`Failed to open path: ${errorString}`);
      }
    } catch (error) {
      console.error("Failed to open path:", error);
      throw error;
    }
  };
  ipcMain.handle(CHANNELS.SYSTEM_OPEN_PATH, handleSystemOpenPath);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_OPEN_PATH));

  const handleSystemOpenInEditor = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: unknown
  ) => {
    const parseResult = SystemOpenInEditorPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      throw new Error(`Invalid payload: ${parseResult.error.message}`);
    }

    const { path: targetPath, line, col, projectId } = parseResult.data;

    let editorConfig = null;
    if (projectId) {
      try {
        const settings = await projectStore.getProjectSettings(projectId);
        editorConfig = settings.preferredEditor ?? null;
      } catch {
        // ignore — fall through to EditorService defaults
      }
    }

    const { openFile } = await import("../../services/EditorService.js");
    await openFile(targetPath, line, col, editorConfig);
  };
  ipcMain.handle(CHANNELS.SYSTEM_OPEN_IN_EDITOR, handleSystemOpenInEditor);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_OPEN_IN_EDITOR));

  const handleSystemCheckCommand = async (
    _event: Electron.IpcMainInvokeEvent,
    command: string
  ): Promise<boolean> => {
    if (typeof command !== "string" || !command.trim()) {
      return false;
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(command)) {
      console.warn(`Command "${command}" contains invalid characters, rejecting`);
      return false;
    }

    try {
      const { execFileSync } = await import("child_process");
      const checkCmd = process.platform === "win32" ? "where" : "which";
      execFileSync(checkCmd, [command], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  ipcMain.handle(CHANNELS.SYSTEM_CHECK_COMMAND, handleSystemCheckCommand);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_CHECK_COMMAND));

  const handleSystemCheckDirectory = async (
    _event: Electron.IpcMainInvokeEvent,
    directoryPath: string
  ): Promise<boolean> => {
    if (typeof directoryPath !== "string" || !directoryPath.trim()) {
      return false;
    }

    const path = await import("path");
    if (!path.isAbsolute(directoryPath)) {
      console.warn(`Directory path "${directoryPath}" is not absolute, rejecting`);
      return false;
    }

    try {
      const fs = await import("fs");
      const stats = await fs.promises.stat(directoryPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  };
  ipcMain.handle(CHANNELS.SYSTEM_CHECK_DIRECTORY, handleSystemCheckDirectory);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_CHECK_DIRECTORY));

  const handleSystemGetHomeDir = async () => {
    return os.homedir();
  };
  ipcMain.handle(CHANNELS.SYSTEM_GET_HOME_DIR, handleSystemGetHomeDir);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_GET_HOME_DIR));

  const handleSystemGetTmpDir = async () => {
    return os.tmpdir();
  };
  ipcMain.handle(CHANNELS.SYSTEM_GET_TMP_DIR, handleSystemGetTmpDir);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_GET_TMP_DIR));

  return () => handlers.forEach((cleanup) => cleanup());
}
