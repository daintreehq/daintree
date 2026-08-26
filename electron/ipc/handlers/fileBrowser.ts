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
import { scratchStore } from "../../services/ScratchStore.js";
import { fileTreeService } from "../../services/FileTreeService.js";
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
      message: "dirPath must be relative to the browser root",
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
      message: "dirPath cannot traverse outside the browser root",
      context: { dirPath },
    });
  }
}

/**
 * Where a file-browser request is rooted, and which engine can read it.
 *
 * `worktree` keeps the utility-host route (git-aware, already warm for a
 * checked-out worktree); `workspace` is a plain folder — a scratch or a
 * worktree-less project — which has no workspace host at all and must be read
 * in-process.
 */
type BrowserRoot = { kind: "worktree" | "workspace"; path: string };

/**
 * A root must be an absolute path before anything joins against it.
 * `FileTreeService` runs `path.resolve`, so an empty or relative root — which
 * SQLite's NOT NULL columns still permit from corrupt or legacy state — would
 * silently resolve against the main process's own cwd and list *that*.
 */
function assertAbsoluteRoot(rootPath: string, kind: BrowserRoot["kind"]): void {
  // `path.win32.isAbsolute` also accepts rooted-but-not-qualified paths such as
  // a bare leading separator, which `resolve` then completes with the process's
  // *current drive* — the same context-dependent root this guard exists to
  // reject. So on Windows require a drive root or a full UNC share.
  const isFullyQualified =
    process.platform === "win32"
      ? /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/])/.test(rootPath)
      : path.isAbsolute(rootPath);
  if (rootPath === "" || !isFullyQualified) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "Workspace root is not an absolute path",
      context: { kind },
    });
  }
}

export function buildFileBrowserNamespace(deps: HandlerDependencies) {
  /**
   * Resolve what a file-browser request is rooted at, scoped to the *sender
   * view's own workspace*.
   *
   * `ctx.projectId` is the main-owned webContents→workspace binding
   * (`viewToProject`), captured synchronously at dispatch — it survives the
   * view being backgrounded and can't be spoofed or repointed by a project
   * switch, unlike window-scoped lookups: `windowToProject` holds one project
   * per window and is repointed to the incoming project the moment a switch
   * starts, so a cached view's requests would resolve against the *active*
   * project's host for the entire background period (#11366). A sender with
   * no binding is refused outright — null is an identity, not a wildcard, and
   * falling through to an unscoped query is exactly the scope this gate exists
   * to deny. Scoped by sender rather than `getMonitorAsync`, which scans every
   * live workspace host and would happily resolve a worktree belonging to
   * another project — worktree ids are normalized absolute paths, so a
   * renderer could guess one and enumerate a sibling project's tree.
   *
   * `ProjectViewManager` keys views on an opaque workspace id and seeds either
   * kind, so that same binding is a scratch's own id for a scratch-bound view.
   * The stores are therefore tried in sequence against the one id rather than
   * the renderer declaring which kind it is (#11482) — no new identifier
   * crosses the boundary, so a request can still only ever reach the workspace
   * its view was created for.
   *
   * An absent `worktreeId` means "this workspace's own root", which is the only
   * thing a scratch or a worktree-less project (#11417) has. A *supplied* one
   * still demands a project row and the full project-scoped worktree lookup:
   * an unknown id fails rather than falling back to the workspace root, so a
   * stale or guessed worktree can never silently widen to a folder above it.
   */
  const resolveSenderBrowserRoot = async (
    ctx: IpcContext,
    worktreeId: string | undefined
  ): Promise<BrowserRoot> => {
    const senderWorkspaceId = ctx.projectId;
    if (senderWorkspaceId === null) {
      throw new AppError({
        code: "INVALID_PATH",
        message: "Unable to resolve the requesting view's project",
        context: {},
      });
    }

    const project = projectStore.getProjectById(senderWorkspaceId);

    if (worktreeId !== undefined) {
      if (!project) {
        throw new AppError({
          code: "INVALID_PATH",
          message: "Unknown project for the requesting view",
          context: { projectId: senderWorkspaceId },
        });
      }
      if (!deps.worktreeService) {
        throw new Error("Worktree service not available");
      }

      const states = await deps.worktreeService.getAllStatesForProjectAsync(
        project.path,
        senderWorkspaceId
      );
      const worktree = states.find((state) => state.id === worktreeId);

      if (!worktree) {
        throw new Error(`Worktree not found: ${worktreeId}`);
      }
      assertAbsoluteRoot(worktree.path, "worktree");
      return { kind: "worktree", path: worktree.path };
    }

    if (project) {
      assertAbsoluteRoot(project.path, "workspace");
      return { kind: "workspace", path: project.path };
    }

    const scratch = scratchStore.getScratchById(senderWorkspaceId);
    if (scratch) {
      assertAbsoluteRoot(scratch.path, "workspace");
      return { kind: "workspace", path: scratch.path };
    }

    throw new AppError({
      code: "INVALID_PATH",
      message: "Unknown project for the requesting view",
      context: { projectId: senderWorkspaceId },
    });
  };

  /**
   * A worktree keeps the utility-host route; a plain workspace folder is read
   * in-process. `WorkspaceClient.getFileTree` resolves a host *by path*, and a
   * scratch has none — its single-host fallback would hand the listing to an
   * unrelated project's host rather than failing.
   */
  const readFileTree = async (root: BrowserRoot, dirPath: string | undefined) => {
    if (root.kind === "worktree") {
      if (!deps.worktreeService) {
        throw new Error("Worktree service not available");
      }
      return deps.worktreeService.getFileTree(root.path, dirPath);
    }
    return fileTreeService.getFileTree(root.path, dirPath ?? "");
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

    const root = await resolveSenderBrowserRoot(ctx, payload.worktreeId);

    // The browser shows every entry and does its own hiding (junk list +
    // dotfile toggle) client-side, with no renderer opt-out, so gitignored
    // working folders can never be filtered back out here (#11330). This route
    // is the raw listing; the context picker's ignore-aware one is
    // `copytree:get-file-tree`.
    return readFileTree(root, payload.dirPath);
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

    const root = await resolveSenderBrowserRoot(ctx, payload.worktreeId);

    // A per-path failure (missing, permission, dangling symlink) is data, not
    // an error: the caller is asking "which of these tokens are real?", and a
    // throw for one bad token would discard the whole batch's answer.
    //
    // Realpath containment, not a bare stat: stat follows symlinks — including
    // INTERMEDIATE ones — so `escape/etc` through an in-root `escape → /`
    // symlink would report the target's kind, an existence probe beyond the
    // root. Resolving first and requiring the CANONICAL result to stay under
    // the canonical root keeps that shut: `/etc` is not under the root, so it
    // still comes back null.
    //
    // This used to demand exact equality — `realpath(root + candidate) ===
    // realpath(root) + candidate` — which rejected every symlink component and
    // was justified by the tree omitting symlink entries. The tree lists them
    // now (#11939), so a reference in terminal output pointing through an
    // in-root link has to resolve rather than read as a non-existent file.
    //
    // Note this is final-target containment: a chain that leaves the root and
    // comes back inside is accepted, matching how `FileTreeService` decides
    // what may be descended into. `path.relative` rather than a string prefix
    // so a sibling root like `/workspace-other` can't pass.
    const rootRealPath = await fs.realpath(root.path).catch(() => null);
    if (rootRealPath === null) {
      return payload.paths.map(() => null);
    }

    const isContained = (candidateRealPath: string): boolean => {
      const rel = path.relative(rootRealPath, candidateRealPath);
      if (rel === "") return true;
      if (rel === ".." || rel.startsWith(`..${path.sep}`)) return false;
      return !path.isAbsolute(rel);
    };

    return Promise.all(
      payload.paths.map(async (candidate): Promise<"file" | "directory" | null> => {
        try {
          const realPath = await fs.realpath(path.join(root.path, candidate));
          if (!isContained(realPath)) return null;
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
