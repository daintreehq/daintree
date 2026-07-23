import path from "path";
import fs from "fs/promises";
import { defineIpcNamespace, opValidated } from "../define.js";
import { checkRateLimit } from "../utils.js";
import { FILE_BROWSER_METHOD_CHANNELS } from "./fileBrowser.preload.js";
import {
  FileBrowserListDirectoryPayloadSchema,
  FileBrowserStatPathsPayloadSchema,
} from "../../schemas/ipc.js";
import { AppError } from "../../utils/errorTypes.js";
import { projectStore } from "../../services/ProjectStore.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import type {
  FileBrowserListDirectoryPayload,
  FileBrowserListDirectoryResult,
  FileBrowserStatPathsPayload,
  FileBrowserStatPathsResult,
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

// One call per hovered terminal line (batched, ≤32 paths); even frantic mouse
// travel across link-dense output stays well under this.
const STAT_PATHS_MAX_CALLS = 300;
const STAT_PATHS_WINDOW_MS = 10_000;

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
  /**
   * Resolve a worktree by id, scoped to the *sender view's own project*.
   *
   * `ctx.projectId` is the main-owned webContents→project binding
   * (`viewToProject`), captured synchronously at dispatch — it survives the
   * view being backgrounded and can't be spoofed or repointed by a project
   * switch, unlike window-scoped lookups: `windowToProject` holds one project
   * per window and is repointed to the incoming project the moment a switch
   * starts, so a cached view's requests would resolve against the *active*
   * project's host for the entire background period (#11366). A sender with
   * no project binding is refused outright — null is an identity, not a
   * wildcard, and falling through to an unscoped query is exactly the scope
   * this gate exists to deny. Scoped by sender rather than `getMonitorAsync`,
   * which scans every live workspace host and would happily resolve a
   * worktree belonging to another project — worktree ids are normalized
   * absolute paths, so a renderer could guess one and enumerate a sibling
   * project's tree.
   */
  const resolveSenderWorktree = async (ctx: IpcContext, worktreeId: string) => {
    if (!deps.worktreeService) {
      throw new Error("Worktree service not available");
    }

    const senderProjectId = ctx.projectId;
    if (senderProjectId === null) {
      throw new AppError({
        code: "INVALID_PATH",
        message: "Unable to resolve the requesting view's project",
        context: {},
      });
    }

    const project = projectStore.getProjectById(senderProjectId);
    if (!project) {
      throw new AppError({
        code: "INVALID_PATH",
        message: "Unknown project for the requesting view",
        context: { projectId: senderProjectId },
      });
    }

    const states = await deps.worktreeService.getAllStatesForProjectAsync(project.path);
    const worktree = states.find((state) => state.id === worktreeId);

    if (!worktree) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }
    return worktree;
  };

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

    const worktree = await resolveSenderWorktree(ctx, payload.worktreeId);

    // Always raw: the browser shows every entry and does its own hiding (junk
    // list + dotfile toggle) client-side. Passing this bypasses the per-dir
    // `git check-ignore` pass — no renderer opt-out, so gitignored working
    // folders can never be filtered back out here (#11330).
    return deps.worktreeService.getFileTree(worktree.path, payload.dirPath, {
      includeIgnored: true,
    });
  };

  const handleStatPaths = async (
    ctx: IpcContext,
    payload: FileBrowserStatPathsPayload
  ): Promise<FileBrowserStatPathsResult> => {
    for (const candidate of payload.paths) {
      assertRelativeDirPath(candidate);
    }

    checkRateLimit(
      FILE_BROWSER_METHOD_CHANNELS.statPaths,
      STAT_PATHS_MAX_CALLS,
      STAT_PATHS_WINDOW_MS
    );

    const worktree = await resolveSenderWorktree(ctx, payload.worktreeId);

    // A per-path failure (missing, permission, dangling symlink) is data, not
    // an error: the caller is asking "which of these tokens are real?", and a
    // throw for one bad token would discard the whole batch's answer.
    //
    // Realpath equality, not a bare stat: stat follows symlinks — including
    // INTERMEDIATE ones — so `escape/etc` through an in-root `escape → /`
    // symlink would report the target's kind, an existence probe beyond the
    // root that FileTreeService's realpath containment otherwise keeps shut.
    // Requiring `realpath(root + candidate) === realpath(root) + candidate`
    // rejects any symlink component, which also matches what the tree can
    // actually render (it omits symlink entries).
    const rootRealPath = await fs.realpath(worktree.path).catch(() => null);
    if (rootRealPath === null) {
      return payload.paths.map(() => null);
    }

    return Promise.all(
      payload.paths.map(async (candidate): Promise<"file" | "directory" | null> => {
        try {
          const realPath = await fs.realpath(path.join(worktree.path, candidate));
          if (realPath !== path.join(rootRealPath, candidate)) return null;
          const stats = await fs.stat(realPath);
          if (stats.isDirectory()) return "directory";
          if (stats.isFile()) return "file";
          return null;
        } catch {
          return null;
        }
      })
    );
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
      statPaths: opValidated(
        FILE_BROWSER_METHOD_CHANNELS.statPaths,
        FileBrowserStatPathsPayloadSchema,
        handleStatPaths,
        { withContext: true }
      ),
    },
  });
}

export function registerFileBrowserHandlers(deps: HandlerDependencies): () => void {
  return buildFileBrowserNamespace(deps).register();
}
