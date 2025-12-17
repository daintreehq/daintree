/**
 * Artifact handlers - save to file, apply patch.
 */

import { ipcMain, dialog } from "electron";
import os from "os";
import path from "path";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";

export function registerArtifactHandlers(deps: HandlerDependencies): () => void {
  const { mainWindow, worktreeService: workspaceClient } = deps;
  const handlers: Array<() => void> = [];

  const handleArtifactSaveToFile = async (
    _event: Electron.IpcMainInvokeEvent,
    options: unknown
  ): Promise<{ filePath: string; success: boolean } | null> => {
    try {
      if (
        typeof options !== "object" ||
        options === null ||
        !("content" in options) ||
        typeof (options as Record<string, unknown>).content !== "string"
      ) {
        throw new Error("Invalid saveToFile payload: missing or invalid content");
      }

      const { content, suggestedFilename, cwd } = options as {
        content: string;
        suggestedFilename?: string;
        cwd?: string;
      };

      if (content.length > 10 * 1024 * 1024) {
        throw new Error("Artifact content exceeds maximum size (10MB)");
      }

      let safeCwd = os.homedir();
      if (cwd && typeof cwd === "string") {
        const fs = await import("fs/promises");
        try {
          const resolvedCwd = path.resolve(cwd);
          const stat = await fs.stat(resolvedCwd);
          if (stat.isDirectory()) {
            safeCwd = resolvedCwd;
          }
        } catch {
          safeCwd = os.homedir();
        }
      }

      const result = await dialog.showSaveDialog(mainWindow, {
        title: "Save Artifact",
        defaultPath: suggestedFilename
          ? path.join(safeCwd, path.basename(suggestedFilename))
          : path.join(safeCwd, "artifact.txt"),
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });

      if (result.canceled || !result.filePath) {
        return null;
      }

      const fs = await import("fs/promises");
      await fs.writeFile(result.filePath, content, "utf-8");

      return {
        filePath: result.filePath,
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[Artifact] Failed to save to file:", errorMessage);
      throw new Error(`Failed to save artifact: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.ARTIFACT_SAVE_TO_FILE, handleArtifactSaveToFile);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.ARTIFACT_SAVE_TO_FILE));

  const handleArtifactApplyPatch = async (
    _event: Electron.IpcMainInvokeEvent,
    options: unknown
  ): Promise<{ success: boolean; error?: string; modifiedFiles?: string[] }> => {
    try {
      if (
        typeof options !== "object" ||
        options === null ||
        !("patchContent" in options) ||
        !("cwd" in options) ||
        typeof (options as Record<string, unknown>).patchContent !== "string" ||
        typeof (options as Record<string, unknown>).cwd !== "string"
      ) {
        throw new Error("Invalid applyPatch payload: missing or invalid patchContent/cwd");
      }

      const { patchContent, cwd } = options as { patchContent: string; cwd: string };

      if (patchContent.length > 5 * 1024 * 1024) {
        throw new Error("Patch content exceeds maximum size (5MB)");
      }

      const fs = await import("fs/promises");
      let resolvedCwd: string;
      try {
        resolvedCwd = path.resolve(cwd);

        const stat = await fs.stat(resolvedCwd);
        if (!stat.isDirectory()) {
          return {
            success: false,
            error: "Provided cwd is not a directory",
          };
        }

        const gitPath = path.join(resolvedCwd, ".git");
        try {
          await fs.stat(gitPath);
        } catch {
          return {
            success: false,
            error: "Provided cwd is not a git repository",
          };
        }

        if (workspaceClient) {
          const states = await workspaceClient.getAllStatesAsync();
          const isValidWorktree = states.some(
            (wt: { path: string }) => path.resolve(wt.path) === resolvedCwd
          );

          if (!isValidWorktree) {
            return {
              success: false,
              error: "Directory is not a known worktree",
            };
          }
        }
      } catch (error) {
        return {
          success: false,
          error: `Invalid cwd: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const tmpPatchPath = path.join(os.tmpdir(), `canopy-patch-${Date.now()}.patch`);
      await fs.writeFile(tmpPatchPath, patchContent, "utf-8");

      try {
        const { execa } = await import("execa");
        await execa("git", ["apply", tmpPatchPath], { cwd: resolvedCwd });

        const modifiedFiles: string[] = [];
        const lines = patchContent.split("\n");
        for (const line of lines) {
          if (line.startsWith("+++")) {
            const match = line.match(/\+\+\+ b\/(.+)/);
            if (match) {
              modifiedFiles.push(match[1]);
            }
          }
        }

        return {
          success: true,
          modifiedFiles,
        };
      } finally {
        await fs.unlink(tmpPatchPath).catch(() => {});
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[Artifact] Failed to apply patch:", errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  };
  ipcMain.handle(CHANNELS.ARTIFACT_APPLY_PATCH, handleArtifactApplyPatch);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.ARTIFACT_APPLY_PATCH));

  return () => handlers.forEach((cleanup) => cleanup());
}
