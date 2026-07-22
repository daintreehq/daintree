import path from "path";
import { defineIpcNamespace, opValidated } from "../define.js";
import { checkRateLimit } from "../utils.js";
import { FILE_BROWSER_METHOD_CHANNELS } from "./fileBrowser.preload.js";
import { FileBrowserListDirectoryPayloadSchema } from "../../schemas/ipc.js";
import { AppError } from "../../utils/errorTypes.js";
import type { HandlerDependencies } from "../types.js";
import type {
  FileBrowserListDirectoryPayload,
  FileBrowserListDirectoryResult,
} from "../../../shared/types/ipc/fileBrowser.js";

/**
 * Sized for how a lazily-expanding tree actually behaves: opening a deep path
 * fires one call per level, and a live refresh re-lists every expanded folder
 * at once. `copytree:get-file-tree`'s 5-per-10s budget — correct for a picker
 * the user touches occasionally — would reject an ordinary browsing session
 * within the first few clicks.
 *
 * Still a real ceiling rather than a formality: the renderer only ever issues
 * one request per directory, so sustained traffic past this rate means a
 * refresh loop, not a user.
 */
const LIST_DIRECTORY_MAX_CALLS = 240;
const LIST_DIRECTORY_WINDOW_MS = 10_000;

/**
 * Structural validation happens in the schema; this adds the semantic path
 * checks the schema can't express. `FileTreeService` re-checks all of this
 * against the resolved realpath — this is the cheap first gate, not the only
 * one.
 */
function assertRelativeDirPath(dirPath: string | undefined): void {
  if (dirPath === undefined || dirPath === "") return;
  if (dirPath.includes("\0")) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "dirPath contains null bytes",
      context: {},
    });
  }
  if (path.isAbsolute(dirPath)) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "dirPath must be relative to the worktree root",
      context: { dirPath },
    });
  }
  const normalized = path.normalize(dirPath);
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  if (segments.includes("..")) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "dirPath cannot traverse outside the worktree root",
      context: { dirPath },
    });
  }
}

export function buildFileBrowserNamespace(deps: HandlerDependencies) {
  const handleListDirectory = async (
    payload: FileBrowserListDirectoryPayload
  ): Promise<FileBrowserListDirectoryResult> => {
    checkRateLimit(
      FILE_BROWSER_METHOD_CHANNELS.listDirectory,
      LIST_DIRECTORY_MAX_CALLS,
      LIST_DIRECTORY_WINDOW_MS
    );

    assertRelativeDirPath(payload.dirPath);

    if (!deps.worktreeService) {
      throw new Error("Worktree service not available");
    }

    const monitor = await deps.worktreeService.getMonitorAsync(payload.worktreeId);
    if (!monitor) {
      throw new Error(`Worktree not found: ${payload.worktreeId}`);
    }

    return deps.worktreeService.getFileTree(monitor.path, payload.dirPath, {
      includeIgnored: payload.includeIgnored,
    });
  };

  return defineIpcNamespace({
    name: "fileBrowser",
    ops: {
      listDirectory: opValidated(
        FILE_BROWSER_METHOD_CHANNELS.listDirectory,
        FileBrowserListDirectoryPayloadSchema,
        handleListDirectory
      ),
    },
  });
}

export function registerFileBrowserHandlers(deps: HandlerDependencies): () => void {
  return buildFileBrowserNamespace(deps).register();
}
