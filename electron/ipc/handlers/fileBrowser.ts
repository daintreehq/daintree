import path from "path";
import { defineIpcNamespace, opValidated } from "../define.js";
import { checkRateLimit } from "../utils.js";
import { FILE_BROWSER_METHOD_CHANNELS } from "./fileBrowser.preload.js";
import { FileBrowserListDirectoryPayloadSchema } from "../../schemas/ipc.js";
import { AppError } from "../../utils/errorTypes.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import type {
  FileBrowserListDirectoryPayload,
  FileBrowserListDirectoryResult,
} from "../../../shared/types/ipc/fileBrowser.js";

/**
 * Sized for how a lazily-expanding tree actually behaves: opening a deep path
 * fires one call per level, and a live refresh re-lists every expanded folder.
 * `copytree:get-file-tree`'s 5-per-10s budget — correct for a picker the user
 * touches occasionally — would reject an ordinary browsing session within the
 * first few clicks.
 *
 * The renderer caps its own concurrency well below this, so the limit is a
 * backstop against a refresh loop rather than the thing shaping normal traffic.
 */
const LIST_DIRECTORY_MAX_CALLS = 240;
const LIST_DIRECTORY_WINDOW_MS = 10_000;

/**
 * Structural validation happens in the schema; this adds the semantic path
 * checks the schema can't express. `FileTreeService` re-checks all of this
 * against the resolved realpath — this is the cheap first gate, not the only
 * one.
 *
 * Backslashes are treated as separators regardless of platform: on Windows they
 * are one, and on POSIX rejecting them costs only the vanishingly rare file
 * with a literal backslash in its name, which is a better trade than reasoning
 * about `..\\..` reaching a Windows-hosted worktree over a shared drive.
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
  if (path.isAbsolute(dirPath) || dirPath.startsWith("/") || dirPath.startsWith("\\")) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "dirPath must be relative to the worktree root",
      context: { dirPath },
    });
  }
  // `C:foo` is drive-relative, not absolute — `path.isAbsolute` says false on
  // POSIX, and it resolves against the drive's own working directory on
  // Windows. Neither is a path inside this worktree.
  if (/^[a-zA-Z]:/.test(dirPath)) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "dirPath must not be drive-qualified",
      context: { dirPath },
    });
  }
  const segments = dirPath.split(/[\\/]+/).filter(Boolean);
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
    ctx: IpcContext,
    payload: FileBrowserListDirectoryPayload
  ): Promise<FileBrowserListDirectoryResult> => {
    // Validate before spending rate-limit budget: the checks are pure string
    // work, and the budget is shared across windows, so letting one renderer's
    // malformed requests drain it would deny service to every other panel.
    assertRelativeDirPath(payload.dirPath);

    checkRateLimit(
      FILE_BROWSER_METHOD_CHANNELS.listDirectory,
      LIST_DIRECTORY_MAX_CALLS,
      LIST_DIRECTORY_WINDOW_MS
    );

    if (!deps.worktreeService) {
      throw new Error("Worktree service not available");
    }

    // Read the sender's window synchronously, before the first await: the
    // view can be evicted while the workspace call is in flight, and a binding
    // that vanishes mid-request would silently widen the scope.
    const senderWindowId = ctx.senderWindow?.id;

    // Scoped by sender rather than `getMonitorAsync`, which scans every live
    // workspace host and would happily resolve a worktree belonging to another
    // project — worktree ids are normalized absolute paths, so a renderer could
    // guess one and enumerate a sibling project's tree.
    const states = await deps.worktreeService.getAllStatesAsync(senderWindowId);
    const worktree = states.find((state) => state.id === payload.worktreeId);

    if (!worktree) {
      throw new Error(`Worktree not found: ${payload.worktreeId}`);
    }

    return deps.worktreeService.getFileTree(worktree.path, payload.dirPath, {
      includeIgnored: payload.includeIgnored,
    });
  };

  return defineIpcNamespace({
    name: "fileBrowser",
    ops: {
      listDirectory: opValidated(
        FILE_BROWSER_METHOD_CHANNELS.listDirectory,
        FileBrowserListDirectoryPayloadSchema,
        handleListDirectory,
        { withContext: true }
      ),
    },
  });
}

export function registerFileBrowserHandlers(deps: HandlerDependencies): () => void {
  return buildFileBrowserNamespace(deps).register();
}
