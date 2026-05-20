/**
 * Artifact handlers - save to file, apply patch.
 */

import { dialog } from "electron";
import os from "os";
import path from "path";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies, IpcContext } from "../../types.js";
import { defineIpcNamespace, op } from "../../define.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { AppError } from "../../../utils/errorTypes.js";
import type {
  SaveArtifactOptions,
  SaveArtifactResult,
  ApplyPatchOptions,
  ApplyPatchResult,
} from "../../../../shared/types/ipc/agent.js";

export function registerArtifactHandlers(deps: HandlerDependencies): () => void {
  const mainWindow = deps.windowRegistry?.getPrimary()?.browserWindow ?? deps.mainWindow;

  const handleArtifactSaveToFile = async (
    options: SaveArtifactOptions
  ): Promise<SaveArtifactResult | null> => {
    if (typeof options !== "object" || options === null || typeof options.content !== "string") {
      throw new AppError({
        code: "VALIDATION",
        message: "Invalid saveToFile payload: missing or invalid content",
      });
    }

    const { content, suggestedFilename, cwd } = options;

    if (content.length > 10 * 1024 * 1024) {
      throw new AppError({
        code: "FILE_TOO_LARGE",
        message: "Artifact content exceeds maximum size (10MB)",
        userMessage: "This artifact is too large to save (10 MB limit).",
      });
    }

    try {
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

      const dialogOpts = {
        title: "Save Artifact",
        defaultPath: suggestedFilename
          ? path.join(safeCwd, path.basename(suggestedFilename))
          : path.join(safeCwd, "artifact.txt"),
        properties: ["createDirectory" as const, "showOverwriteConfirmation" as const],
      };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, dialogOpts)
        : await dialog.showSaveDialog(dialogOpts);

      if (result.canceled || !result.filePath) {
        return null;
      }

      const fs = await import("fs/promises");
      await fs.writeFile(result.filePath, content, "utf-8");

      return {
        filePath: result.filePath,
      };
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to save artifact");
      console.error("[Artifact] Failed to save to file:", errorMessage);
      throw new AppError({
        code: "INTERNAL",
        message: `Failed to save artifact: ${errorMessage}`,
        cause: error instanceof Error ? error : undefined,
      });
    }
  };

  const handleArtifactApplyPatch = async (
    ctx: IpcContext,
    options: ApplyPatchOptions
  ): Promise<ApplyPatchResult> => {
    if (
      typeof options !== "object" ||
      options === null ||
      typeof options.patchContent !== "string" ||
      typeof options.cwd !== "string"
    ) {
      throw new AppError({
        code: "VALIDATION",
        message: "Invalid applyPatch payload: missing or invalid patchContent/cwd",
      });
    }

    const { patchContent, cwd } = options;

    if (patchContent.length > 5 * 1024 * 1024) {
      throw new AppError({
        code: "FILE_TOO_LARGE",
        message: "Patch content exceeds maximum size (5MB)",
      });
    }

    const fs = await import("fs/promises");
    let resolvedCwd: string;
    try {
      resolvedCwd = path.resolve(cwd);

      const stat = await fs.stat(resolvedCwd);
      if (!stat.isDirectory()) {
        throw new AppError({
          code: "INVALID_PATH",
          message: "Provided cwd is not a directory",
          context: { cwd },
        });
      }

      const gitPath = path.join(resolvedCwd, ".git");
      try {
        await fs.stat(gitPath);
      } catch {
        throw new AppError({
          code: "VALIDATION",
          message: "Provided cwd is not a git repository",
          context: { cwd },
        });
      }

      if (deps.worktreeService) {
        const senderWindowPatch = ctx.senderWindow;
        const states = await deps.worktreeService.getAllStatesAsync(senderWindowPatch?.id);
        const isValidWorktree = states.some(
          (wt: { path: string }) => path.resolve(wt.path) === resolvedCwd
        );

        if (!isValidWorktree) {
          throw new AppError({
            code: "VALIDATION",
            message: "Directory is not a known worktree",
            context: { cwd },
          });
        }
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError({
        code: "INVALID_PATH",
        message: formatErrorMessage(error, "Invalid cwd"),
        context: { cwd },
        cause: error instanceof Error ? error : undefined,
      });
    }

    const tmpPatchPath = path.join(os.tmpdir(), `daintree-patch-${Date.now()}.patch`);
    await fs.writeFile(tmpPatchPath, patchContent, "utf-8");

    try {
      const { execa } = await import("execa");
      try {
        await execa("git", ["apply", tmpPatchPath], { cwd: resolvedCwd });
      } catch (error) {
        const errorMessage = formatErrorMessage(error, "Failed to apply patch");
        console.error("[Artifact] Failed to apply patch:", errorMessage);
        throw new AppError({
          code: "INTERNAL",
          message: errorMessage,
          context: { cwd: resolvedCwd },
          cause: error instanceof Error ? error : undefined,
        });
      }

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

      return { modifiedFiles };
    } finally {
      await fs.unlink(tmpPatchPath).catch(() => {});
    }
  };
  const namespace = defineIpcNamespace({
    name: "artifacts",
    ops: {
      saveToFile: op(CHANNELS.ARTIFACT_SAVE_TO_FILE, handleArtifactSaveToFile),
      applyPatch: op(CHANNELS.ARTIFACT_APPLY_PATCH, handleArtifactApplyPatch, {
        withContext: true,
      }),
    },
  });

  return namespace.register();
}
