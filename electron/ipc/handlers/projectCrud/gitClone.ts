import path from "path";
import { CHANNELS } from "../../channels.js";
import { getWindowForWebContents } from "../../../window/webContentsRegistry.js";
import {
  broadcastToRenderer,
  sendToRenderer,
  typedHandle,
  typedHandleWithContext,
} from "../../utils.js";
import { createAuthenticatedGit } from "../../../utils/hardenedGit.js";
import type {
  CloneRepoOptions,
  CloneRepoResult,
  CloneRepoProgressEvent,
} from "../../../../shared/types/ipc/gitClone.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { AppError } from "../../../utils/errorTypes.js";

export function registerGitCloneHandlers(): () => void {
  const handlers: Array<() => void> = [];

  let cloneAbortController: AbortController | null = null;

  const handleProjectCloneRepo = async (
    ctx: import("../../types.js").IpcContext,
    options: CloneRepoOptions
  ): Promise<CloneRepoResult> => {
    if (!options || typeof options !== "object") {
      throw new Error("Invalid options object");
    }

    const senderWindow = getWindowForWebContents(ctx.event.sender);

    const { url, parentPath, folderName, shallowClone } = options;

    if (typeof url !== "string" || !url.trim()) {
      throw new Error("Repository URL is required");
    }
    if (!/^https?:\/\//i.test(url) && !/^git@/i.test(url)) {
      throw new Error("Only HTTP(S) and SSH (git@) URLs are supported");
    }
    if (typeof parentPath !== "string" || !parentPath.trim()) {
      throw new Error("Parent path is required");
    }
    if (!path.isAbsolute(parentPath)) {
      throw new Error("Parent path must be absolute");
    }
    if (typeof folderName !== "string" || !folderName.trim()) {
      throw new Error("Folder name is required");
    }

    const trimmedFolder = folderName.trim();
    if (
      trimmedFolder.includes("/") ||
      trimmedFolder.includes("\\") ||
      trimmedFolder === ".." ||
      trimmedFolder === "."
    ) {
      throw new Error("Folder name must not contain path separators or dot segments");
    }

    const targetPath = path.join(parentPath, trimmedFolder);
    const normalizedParent = path.resolve(parentPath);
    const normalizedTarget = path.resolve(targetPath);
    if (!normalizedTarget.startsWith(normalizedParent + path.sep)) {
      throw new Error("Folder name resolves outside of the parent directory");
    }

    const fs = await import("fs");

    try {
      const parentStat = await fs.promises.stat(parentPath);
      if (!parentStat.isDirectory()) {
        throw new Error("Parent path is not a directory");
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error("Parent directory does not exist", { cause: err });
      }
      throw err;
    }

    const targetExists = await fs.promises
      .access(targetPath)
      .then(() => true)
      .catch(() => false);
    if (targetExists) {
      throw new Error(`Folder "${trimmedFolder}" already exists in this location`);
    }

    const emitProgress = (stage: string, progress: number, message: string) => {
      const progressEvent: CloneRepoProgressEvent = {
        stage,
        progress,
        message,
        timestamp: Date.now(),
      };
      if (senderWindow && !senderWindow.isDestroyed()) {
        sendToRenderer(senderWindow, CHANNELS.PROJECT_CLONE_PROGRESS, progressEvent);
      } else {
        broadcastToRenderer(CHANNELS.PROJECT_CLONE_PROGRESS, progressEvent);
      }
    };

    cloneAbortController = new AbortController();

    try {
      emitProgress("starting", 0, "Starting clone...");

      const git = createAuthenticatedGit(parentPath, {
        signal: cloneAbortController.signal,
        progress({ stage, progress }) {
          emitProgress(stage, progress, `${stage}: ${progress}%`);
        },
        extraConfig: ["transfer.bundleURI=false"],
      });

      await git.clone(url, trimmedFolder, shallowClone ? ["--depth", "1"] : []);

      emitProgress("complete", 100, "Clone complete");
      return { clonedPath: targetPath };
    } catch (error) {
      const wasCancelled =
        cloneAbortController?.signal.aborted ||
        (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message)));

      // Clean up partial clone
      const partialExists = await fs.promises
        .access(targetPath)
        .then(() => true)
        .catch(() => false);
      if (partialExists) {
        await fs.promises.rm(targetPath, { recursive: true, force: true }).catch(() => {});
      }

      if (wasCancelled) {
        emitProgress("cancelled", 0, "Clone cancelled");
        throw new AppError({
          code: "CANCELLED",
          message: "Clone cancelled",
          context: { targetPath },
        });
      }

      const errorMessage = formatErrorMessage(error, "Failed to clone repository");
      emitProgress("error", 0, `Clone failed: ${errorMessage}`);
      throw new AppError({
        code: "INTERNAL",
        message: errorMessage,
        context: { targetPath },
        cause: error instanceof Error ? error : undefined,
      });
    } finally {
      cloneAbortController = null;
    }
  };
  handlers.push(typedHandleWithContext(CHANNELS.PROJECT_CLONE_REPO, handleProjectCloneRepo));

  const handleProjectCloneCancel = async (): Promise<void> => {
    if (cloneAbortController) {
      cloneAbortController.abort();
    }
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_CLONE_CANCEL, handleProjectCloneCancel));

  return () => handlers.forEach((cleanup) => cleanup());
}
