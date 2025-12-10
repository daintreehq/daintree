import { ipcMain, clipboard } from "electron";
import crypto from "crypto";
import path from "path";
import { CHANNELS } from "../channels.js";
import { sendToRenderer } from "../utils.js";
import type { HandlerDependencies } from "../types.js";
import type {
  CopyTreeGeneratePayload,
  CopyTreeGenerateAndCopyFilePayload,
  CopyTreeInjectPayload,
  CopyTreeGetFileTreePayload,
  CopyTreeResult,
  CopyTreeProgress,
  FileTreeNode,
} from "../../types/index.js";
import {
  CopyTreeGeneratePayloadSchema,
  CopyTreeGenerateAndCopyFilePayloadSchema,
  CopyTreeInjectPayloadSchema,
  CopyTreeGetFileTreePayloadSchema,
} from "../../schemas/ipc.js";

export function registerCopyTreeHandlers(deps: HandlerDependencies): () => void {
  const { mainWindow, worktreeService: workspaceClient, ptyManager: ptyClient } = deps;
  const handlers: Array<() => void> = [];

  const injectionsInProgress = new Set<string>();

  const handleCopyTreeGenerate = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: CopyTreeGeneratePayload
  ): Promise<CopyTreeResult> => {
    const traceId = crypto.randomUUID();
    console.log(`[${traceId}] CopyTree generate started for worktree ${payload.worktreeId}`);

    const parseResult = CopyTreeGeneratePayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      console.error(`[${traceId}] Invalid CopyTree generate payload:`, parseResult.error.format());
      return {
        content: "",
        fileCount: 0,
        error: `Invalid payload: ${parseResult.error.message}`,
      };
    }

    const validated = parseResult.data;

    if (!workspaceClient) {
      return {
        content: "",
        fileCount: 0,
        error: "Workspace client not initialized",
      };
    }

    const states = await workspaceClient.getAllStatesAsync();
    const worktree = states.find((wt) => wt.id === validated.worktreeId);

    if (!worktree) {
      return {
        content: "",
        fileCount: 0,
        error: `Worktree not found: ${validated.worktreeId}`,
      };
    }

    const onProgress = (progress: CopyTreeProgress) => {
      sendToRenderer(mainWindow, CHANNELS.COPYTREE_PROGRESS, { ...progress, traceId });
    };

    return workspaceClient.generateContext(worktree.path, validated.options, onProgress);
  };
  ipcMain.handle(CHANNELS.COPYTREE_GENERATE, handleCopyTreeGenerate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.COPYTREE_GENERATE));

  const handleCopyTreeGenerateAndCopyFile = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: CopyTreeGenerateAndCopyFilePayload
  ): Promise<CopyTreeResult> => {
    const traceId = crypto.randomUUID();
    console.log(
      `[${traceId}] CopyTree generate-and-copy-file started for worktree ${payload.worktreeId}`
    );

    const parseResult = CopyTreeGenerateAndCopyFilePayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      console.error(
        `[${traceId}] Invalid CopyTree generate-and-copy-file payload:`,
        parseResult.error.format()
      );
      return {
        content: "",
        fileCount: 0,
        error: `Invalid payload: ${parseResult.error.message}`,
      };
    }

    const validated = parseResult.data;

    if (!workspaceClient) {
      return {
        content: "",
        fileCount: 0,
        error: "Workspace client not initialized",
      };
    }

    const states = await workspaceClient.getAllStatesAsync();
    const worktree = states.find((wt) => wt.id === validated.worktreeId);

    if (!worktree) {
      return {
        content: "",
        fileCount: 0,
        error: `Worktree not found: ${validated.worktreeId}`,
      };
    }

    const onProgress = (progress: CopyTreeProgress) => {
      sendToRenderer(mainWindow, CHANNELS.COPYTREE_PROGRESS, { ...progress, traceId });
    };

    const result = await workspaceClient.generateContext(
      worktree.path,
      validated.options,
      onProgress
    );

    if (result.error) {
      return result;
    }

    try {
      const fs = await import("fs/promises");
      const os = await import("os");
      const path = await import("path");

      const tempDir = path.join(os.tmpdir(), "canopy-context");
      await fs.mkdir(tempDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safeBranch =
        (worktree.branch || "head")
          .replace(/[^a-zA-Z0-9-_]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 100) || "head";
      const filename = `context-${safeBranch}-${timestamp}.xml`;
      const filePath = path.join(tempDir, filename);

      await fs.writeFile(filePath, result.content, "utf-8");

      if (process.platform === "darwin") {
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
    <string>${filePath}</string>
</array>
</plist>`;
        clipboard.writeBuffer("NSFilenamesPboardType", Buffer.from(plist, "utf8"));
      } else if (process.platform === "win32") {
        clipboard.writeText(filePath);
      } else {
        clipboard.writeBuffer("text/uri-list", Buffer.from(`file://${filePath}`, "utf8"));
      }

      console.log(`[${traceId}] Copied context file to clipboard: ${filePath}`);

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[${traceId}] Failed to save/copy context file:`, errorMessage);
      return {
        ...result,
        error: `Failed to copy file to clipboard: ${errorMessage}`,
      };
    }
  };
  ipcMain.handle(CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE, handleCopyTreeGenerateAndCopyFile);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE));

  const handleCopyTreeInject = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: CopyTreeInjectPayload
  ): Promise<CopyTreeResult> => {
    const traceId = crypto.randomUUID();
    console.log(
      `[${traceId}] CopyTree inject started for terminal ${payload.terminalId}, worktree ${payload.worktreeId}`
    );

    const parseResult = CopyTreeInjectPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      console.error(`[${traceId}] Invalid CopyTree inject payload:`, parseResult.error.format());
      return {
        content: "",
        fileCount: 0,
        error: `Invalid payload: ${parseResult.error.message}`,
      };
    }

    const validated = parseResult.data;

    if (injectionsInProgress.has(validated.terminalId)) {
      return {
        content: "",
        fileCount: 0,
        error: "Context injection already in progress for this terminal",
      };
    }

    if (!workspaceClient) {
      return {
        content: "",
        fileCount: 0,
        error: "Workspace client not initialized",
      };
    }

    injectionsInProgress.add(validated.terminalId);

    try {
      const states = await workspaceClient.getAllStatesAsync();
      const worktree = states.find((wt) => wt.id === validated.worktreeId);

      if (!worktree) {
        return {
          content: "",
          fileCount: 0,
          error: `Worktree not found: ${validated.worktreeId}`,
        };
      }

      if (!ptyClient.hasTerminal(validated.terminalId)) {
        return {
          content: "",
          fileCount: 0,
          error: "Terminal no longer exists",
        };
      }

      const onProgress = (progress: CopyTreeProgress) => {
        sendToRenderer(mainWindow, CHANNELS.COPYTREE_PROGRESS, { ...progress, traceId });
      };

      const result = await workspaceClient.generateContext(
        worktree.path,
        validated.options || {},
        onProgress
      );

      if (result.error) {
        return result;
      }

      const CHUNK_SIZE = 4096;
      const content = result.content;

      for (let i = 0; i < content.length; i += CHUNK_SIZE) {
        if (!ptyClient.hasTerminal(validated.terminalId)) {
          return {
            content: "",
            fileCount: 0,
            error: "Terminal closed during injection",
          };
        }

        const chunk = content.slice(i, i + CHUNK_SIZE);
        ptyClient.write(validated.terminalId, chunk, traceId);
        if (i + CHUNK_SIZE < content.length) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }

      console.log(`[${traceId}] CopyTree inject completed successfully`);
      return result;
    } finally {
      injectionsInProgress.delete(validated.terminalId);
    }
  };
  ipcMain.handle(CHANNELS.COPYTREE_INJECT, handleCopyTreeInject);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.COPYTREE_INJECT));

  const handleCopyTreeAvailable = async (): Promise<boolean> => {
    return !!workspaceClient && workspaceClient.isReady();
  };
  ipcMain.handle(CHANNELS.COPYTREE_AVAILABLE, handleCopyTreeAvailable);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.COPYTREE_AVAILABLE));

  const handleCopyTreeCancel = async (): Promise<void> => {
    if (workspaceClient) {
      workspaceClient.cancelAllContext();
    }
  };
  ipcMain.handle(CHANNELS.COPYTREE_CANCEL, handleCopyTreeCancel);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.COPYTREE_CANCEL));

  const handleCopyTreeGetFileTree = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: CopyTreeGetFileTreePayload
  ): Promise<FileTreeNode[]> => {
    const parseResult = CopyTreeGetFileTreePayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      throw new Error(`Invalid file tree request: ${parseResult.error.message}`);
    }

    const validated = parseResult.data;

    if (validated.dirPath) {
      if (path.isAbsolute(validated.dirPath)) {
        throw new Error("dirPath must be a relative path");
      }
      const normalized = path.normalize(validated.dirPath);
      if (normalized.startsWith("..")) {
        throw new Error("dirPath cannot traverse outside worktree root");
      }
    }

    if (!workspaceClient) {
      throw new Error("Worktree service not available");
    }

    const monitor = await workspaceClient.getMonitorAsync(validated.worktreeId);

    if (!monitor) {
      throw new Error(`Worktree not found: ${validated.worktreeId}`);
    }

    return workspaceClient.getFileTree(monitor.path, validated.dirPath);
  };
  ipcMain.handle(CHANNELS.COPYTREE_GET_FILE_TREE, handleCopyTreeGetFileTree);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.COPYTREE_GET_FILE_TREE));

  return () => handlers.forEach((cleanup) => cleanup());
}
