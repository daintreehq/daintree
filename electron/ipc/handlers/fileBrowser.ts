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
 * Sized against the worst *legitimate* burst, not a guess.
 *
 * Hydration caps a restored panel at 500 expanded directories, so one refresh
 * of the widest tree the app can produce is 501 listings. Anything at or below
 * that has to succeed — a limit that rejects a normal restore would leave the
 * tree permanently half-loaded, which is worse than no limit at all.
 * `copytree:get-file-tree`'s 5-per-10s budget is correct for a picker the user
 * touches occasionally and hopeless here.
 *
 * It is still a real ceiling: the renderer holds itself to a handful of
 * concurrent listings, so sustained traffic past this rate means a refresh
 * loop, not a user. The budget is shared across windows, which is why the
 * renderer — not this limit — is what shapes normal traffic.
 */
const LIST_DIRECTORY_MAX_CALLS = 600;
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

    // An unresolvable sender is refused rather than passed through as
    // `undefined`, which `getAllStatesAsync` reads as "every host" — a wildcard
    // is exactly the scope this gate exists to deny. `getWindowForWebContents`
    // falls back to the WebContents registry, so a real project view always
    // resolves; nothing legitimate lands here.
    if (senderWindowId === undefined) {
      throw new AppError({
        code: "INVALID_PATH",
        message: "Unable to resolve the requesting window",
        context: {},
      });
    }

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
