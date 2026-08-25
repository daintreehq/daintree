import { app, shell } from "electron";
import os from "os";
import * as nodePath from "path";
import * as nodeFs from "fs";
import { CHANNELS } from "../channels.js";
import { openExternalUrl } from "../../utils/openExternal.js";
import { projectStore } from "../../services/ProjectStore.js";
import { gitServiceCache } from "../../services/GitServiceCache.js";
import { AppError } from "../../utils/errorTypes.js";
import { resolveContainedPath, assertExtensionAllowed } from "./pathGuard.js";
import {
  SystemOpenExternalPayloadSchema,
  SystemOpenPathPayloadSchema,
  SystemShowItemInFolderUnconfinedPayloadSchema,
  SystemOpenInEditorPayloadSchema,
} from "../../schemas/index.js";
import type { HandlerDependencies } from "../types.js";
import { typedHandle, typedHandleValidated } from "../utils.js";
import { defineIpcNamespace, opValidated } from "../define.js";
import type {
  SystemOpenExternalPayload,
  SystemOpenPathPayload,
  SystemShowItemInFolderUnconfinedPayload,
  SystemOpenInEditorPayload,
} from "../../schemas/ipc.js";

/**
 * Collect the worktree roots git actually tracks for each project.
 *
 * This replaces an earlier heuristic that reconstructed a worktree *parent*
 * directory from the configured path pattern. That approach admitted the whole
 * predicted parent (including directories that were never worktrees) yet still
 * missed real ones: it only consulted the global pattern, so a per-project
 * `worktreePathPattern` override was invisible to it, and a worktree created
 * by hand via `git worktree add` lands wherever the user chose — no pattern
 * predicts it. Asking git is both narrower and complete.
 *
 * Each returned path is a root in its own right; the parent is never admitted.
 * Enumeration runs concurrently and per-project failures degrade to an empty
 * list, so one broken or deleted repository can't suppress healthy ones — the
 * project root itself stays allowed regardless.
 *
 * Git reports more than live working trees, so every candidate is confirmed to
 * still be one before it earns containment. Bare entries are excluded outright:
 * a linked checkout backed by a bare repository reports that repository, and
 * granting it would hand out its object store and hooks. The rest are checked
 * for a `.git` entry, which every working tree has (a directory in the main
 * one, a gitdir pointer file in linked ones). That check is what makes stale
 * "prunable" records safe — git keeps reporting a worktree directory the user
 * deleted behind its back, and if that path is later reused by something
 * unrelated, the absent `.git` is the only thing separating it from a granted
 * root. Recreation is exactly the case a realpath-only test misses. We never
 * prune: this is a read-time authorization check, not worktree lifecycle code.
 */
async function collectTrackedWorktreeRoots(projectRoots: readonly string[]): Promise<string[]> {
  const perProject = await Promise.all(
    projectRoots.map((root) =>
      gitServiceCache
        .getGitService(root)
        .listWorktrees()
        .catch(() => [])
    )
  );

  const candidates = [
    ...new Set(
      perProject.flatMap((worktrees) =>
        worktrees.filter(isAdmissibleRecord).map((worktree) => worktree.path)
      )
    ),
  ];
  const live = await Promise.all(candidates.map((candidate) => isLiveWorkingTree(candidate)));

  return candidates.filter((_, index) => live[index]);
}

function isAdmissibleRecord(worktree: { path: string; bare: boolean }): boolean {
  if (worktree.bare) return false;
  // pathGuard treats the filesystem root as containing every absolute path, so
  // a record pointing there would silently grant the whole disk.
  return nodePath.parse(worktree.path).root !== worktree.path;
}

/**
 * True when `candidate` still looks like a working tree worth trusting.
 *
 * Only a definitively absent `.git` disqualifies it. Any other error — a
 * permission failure while traversing, an unreachable network volume, a
 * transient I/O fault — says nothing about whether this is a worktree, and git
 * just told us it is; rejecting on those would lock a user out of a perfectly
 * good worktree for an unrelated reason.
 */
async function isLiveWorkingTree(candidate: string): Promise<boolean> {
  try {
    await nodeFs.promises.access(nodePath.join(candidate, ".git"));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/**
 * Guard a renderer-supplied path before forwarding it to a system sink
 * (shell.openPath / EditorService.openFile). Rejects non-absolute paths,
 * executable extensions, and any path not contained within a known project
 * root, a git-tracked worktree of one of those projects, or the app's userData
 * dir (where crash logs live). The extension is checked twice — on the raw
 * input and on the realpath-resolved target — so a benignly-named symlink
 * (`notes.txt` → `Evil.app`) inside a root can't smuggle an executable past
 * the deny-list. Returns the resolved path so the caller hands the canonical
 * target to the sink, shrinking the TOCTOU window.
 *
 * Worktree enumeration shells out to git, so it is deferred until a path is
 * otherwise about to be rejected. Containment against a union is the same
 * question as containment against any one member, so escalating only after an
 * OUTSIDE_ROOT miss decides identical cases while keeping the common
 * inside-the-project case free of subprocess work. A path that fails for any
 * other reason (non-absolute, unresolvable) would fail against every root set,
 * so it propagates immediately rather than paying for enumeration.
 *
 * `flavor` controls the executable deny-list. The OS launcher (`shell.openPath`)
 * runs scripts and binaries, so it gets the full deny-list. Editors only read
 * the file, so the "editor" flavor relaxes the deny-list — viewing a `.sh` /
 * `.ps1` / `.bat` in VS Code is a legitimate ReviewHub flow that the launcher
 * deny-list would otherwise block.
 */
async function assertPathAllowed(
  targetPath: string,
  flavor: "launcher" | "editor" = "launcher"
): Promise<string> {
  if (flavor === "launcher") {
    assertExtensionAllowed(targetPath);
  }

  const projectRoots = [...new Set(projectStore.getAllProjects().map((p) => p.path))];
  const baseRoots = [...projectRoots, app.getPath("userData")];

  let realTarget: string;
  try {
    realTarget = await resolveContainedPath(targetPath, baseRoots);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "OUTSIDE_ROOT") {
      throw error;
    }
    const worktreeRoots = await collectTrackedWorktreeRoots(projectRoots);
    if (worktreeRoots.length === 0) {
      throw error;
    }
    realTarget = await resolveContainedPath(targetPath, [
      ...new Set([...baseRoots, ...worktreeRoots]),
    ]);
  }

  // shell.openPath / openFile follow symlinks, so re-check the resolved
  // extension to defeat a safe-named symlink pointing at an executable.
  if (flavor === "launcher") {
    assertExtensionAllowed(realTarget);
  }

  return realTarget;
}

/**
 * Resolve a renderer-supplied path for the UNCONFINED reveal op. Two
 * user-initiated callers: the recovery action on a terminal file link that
 * resolved outside project roots, and the file viewer's reveal button, whose
 * read root falls back to the file's own parent, so the pane routinely
 * displays files no project owns (#11934). Both arrive here only after the
 * contained reveal has already been tried and refused with OUTSIDE_ROOT.
 * Unlike {@link assertPathAllowed}, this deliberately skips roots
 * containment (that's the rejection the user is asking to bypass), but keeps
 * every other guard: absolute-only, executable deny-list on both the raw
 * input and the realpath target (defeats a safe-named symlink → Evil.app),
 * realpath canonicalization (collapses intermediate-component TOCTOU — lesson
 * #6442), and a stat gate so a since-deleted path surfaces as INVALID_PATH
 * instead of `shell.showItemInFolder`'s silent no-op. The deny-list is
 * unconditional here — unlike the confined "editor" flavor, which relaxes it —
 * because an out-of-root path sits outside every root the app vouches for
 * (parsed terminal output, or a path the viewer was merely pointed at), and the
 * historical Windows ShellExecute("open") / Linux xdg-open fallbacks make
 * reveal a launch surface on some platforms. So this op cannot reveal
 * everything the contained one can, and callers must not promise it will.
 */
async function resolveRevealTargetUnconfined(targetPath: string): Promise<string> {
  if (!nodePath.isAbsolute(targetPath)) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "Only absolute paths are allowed",
      context: { targetPath },
    });
  }

  assertExtensionAllowed(targetPath);

  let realTarget: string;
  try {
    realTarget = await nodeFs.promises.realpath(targetPath);
  } catch (error) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "Could not resolve path",
      context: { targetPath },
      cause: error instanceof Error ? error : undefined,
    });
  }

  assertExtensionAllowed(realTarget);

  try {
    const stats = await nodeFs.promises.stat(realTarget);
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new AppError({
        code: "INVALID_PATH",
        message: "Path is not a file or directory",
        context: { targetPath, realTarget },
      });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError({
      code: "INVALID_PATH",
      message: "Could not stat path",
      context: { targetPath, realTarget },
      cause: error instanceof Error ? error : undefined,
    });
  }

  return realTarget;
}

export function registerSystemShellHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleSystemOpenExternal = async ({ url }: SystemOpenExternalPayload) => {
    try {
      await openExternalUrl(url);
    } catch (error) {
      console.error("[IPC] Failed to open external URL:", error);
      throw error;
    }
  };
  handlers.push(
    typedHandleValidated(
      CHANNELS.SYSTEM_OPEN_EXTERNAL,
      SystemOpenExternalPayloadSchema,
      handleSystemOpenExternal
    )
  );

  const handleSystemOpenPath = async ({ path: targetPath }: SystemOpenPathPayload) => {
    try {
      const realTarget = await assertPathAllowed(targetPath);
      const errorString = await shell.openPath(realTarget);
      if (errorString) {
        throw new Error(`Failed to open path: ${errorString}`);
      }
    } catch (error) {
      console.error("Failed to open path:", error);
      throw error;
    }
  };
  handlers.push(
    typedHandleValidated(
      CHANNELS.SYSTEM_OPEN_PATH,
      SystemOpenPathPayloadSchema,
      handleSystemOpenPath
    )
  );

  // Registered via defineIpcNamespace (not a hand-written IpcInvokeMap entry)
  // so the channel is codegen'd into GeneratedIpcInvokeMap — new IPC handlers
  // must not grow the hand-written map (ipc-handwritten ratchet).
  const systemShellNamespace = defineIpcNamespace({
    name: "systemShell",
    ops: {
      showItemInFolder: opValidated(
        CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER,
        SystemOpenPathPayloadSchema,
        async (payload: SystemOpenPathPayload): Promise<void> => {
          try {
            // Reveal-in-file-manager only selects the item — it never launches
            // it — so the "editor" flavor (containment check, relaxed
            // executable deny-list) is correct: revealing an .app/.exe the user
            // can already see must not be blocked. assertPathAllowed →
            // resolveContainedPath realpaths the target, so a since-deleted
            // path is already rejected (INVALID_PATH) before we reach
            // shell.showItemInFolder (which gives no failure signal).
            const realTarget = await assertPathAllowed(payload.path, "editor");
            shell.showItemInFolder(realTarget);
          } catch (error) {
            console.error("Failed to reveal item in folder:", error);
            throw error;
          }
        }
      ),
      // User-initiated reveal of an OUTSIDE_ROOT path: the recovery action on a
      // terminal file-link toast, or the file viewer's reveal of a file it is
      // already displaying. Bypasses roots containment but keeps the deny-list,
      // realpath canonicalization, and a stat gate — see
      // resolveRevealTargetUnconfined.
      showItemInFolderUnconfined: opValidated(
        CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER_UNCONFINED,
        SystemShowItemInFolderUnconfinedPayloadSchema,
        async (payload: SystemShowItemInFolderUnconfinedPayload): Promise<void> => {
          try {
            const realTarget = await resolveRevealTargetUnconfined(payload.path);
            shell.showItemInFolder(realTarget);
          } catch (error) {
            console.error("Failed to reveal unconfined item in folder:", error);
            throw error;
          }
        }
      ),
    },
  });
  handlers.push(systemShellNamespace.register());

  const handleSystemOpenInEditor = async ({
    path: targetPath,
    line,
    col,
    projectId,
  }: SystemOpenInEditorPayload) => {
    const realTarget = await assertPathAllowed(targetPath, "editor");

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
    await openFile(realTarget, line, col, editorConfig);
  };
  handlers.push(
    typedHandleValidated(
      CHANNELS.SYSTEM_OPEN_IN_EDITOR,
      SystemOpenInEditorPayloadSchema,
      handleSystemOpenInEditor
    )
  );

  const handleSystemCheckCommand = async (command: string): Promise<boolean> => {
    if (typeof command !== "string" || !command.trim()) {
      return false;
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(command)) {
      console.warn(`Command "${command}" contains invalid characters, rejecting`);
      return false;
    }

    try {
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const checkCmd = process.platform === "win32" ? "where" : "which";
      await promisify(execFile)(checkCmd, [command], { timeout: 5_000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_CHECK_COMMAND, handleSystemCheckCommand));

  const handleSystemCheckDirectory = async (directoryPath: string): Promise<boolean> => {
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
  handlers.push(typedHandle(CHANNELS.SYSTEM_CHECK_DIRECTORY, handleSystemCheckDirectory));

  const handleSystemGetHomeDir = async () => {
    return os.homedir();
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_GET_HOME_DIR, handleSystemGetHomeDir));

  const handleSystemGetTmpDir = async () => {
    return os.tmpdir();
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_GET_TMP_DIR, handleSystemGetTmpDir));

  return () => handlers.forEach((cleanup) => cleanup());
}
