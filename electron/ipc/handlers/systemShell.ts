// eager-import-allow: reads worktree config via store.get synchronously to derive worktree parent dirs for path-guard checks
import { app, shell } from "electron";
import os from "os";
import * as nodePath from "path";
import * as nodeFs from "fs";
import { CHANNELS } from "../channels.js";
import { openExternalUrl } from "../../utils/openExternal.js";
import { projectStore } from "../../services/ProjectStore.js";
import { store } from "../../store.js";
import { AppError } from "../../utils/errorTypes.js";
import { resolveContainedPath } from "./pathGuard.js";
import {
  DEFAULT_WORKTREE_PATH_PATTERN,
  buildPathPatternVariables,
  resolvePathPattern,
  validatePathPattern,
} from "../../../shared/utils/pathPattern.js";
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

// Extensions that shell.openPath / the OS would execute rather than reveal.
// On macOS, opening a .app (or .command/.scpt) launches it; on Windows a
// .exe/.bat/.lnk runs; on Linux a .desktop/.sh/.AppImage executes. We deny
// these for renderer-supplied paths regardless of containment, since a
// malicious file dropped inside an allowed root must not become a launch
// primitive. Selected per-platform at module init.
const DENIED_EXTENSIONS_BY_PLATFORM: Record<string, readonly string[]> = {
  darwin: [".app", ".command", ".terminal", ".scpt", ".scptd", ".pkg", ".dmg", ".desktop"],
  linux: [".desktop", ".sh", ".appimage", ".run"],
  win32: [
    ".exe",
    ".bat",
    ".cmd",
    ".com",
    ".scr",
    ".pif",
    ".vbs",
    ".ps1",
    ".msi",
    ".lnk",
    ".jar",
    ".reg",
    ".cpl",
    ".wsf",
    ".hta",
  ],
};

const DENIED_EXTENSIONS = new Set<string>(DENIED_EXTENSIONS_BY_PLATFORM[process.platform] ?? []);

function assertExtensionAllowed(candidate: string): void {
  const ext = nodePath.extname(candidate).toLowerCase();
  if (DENIED_EXTENSIONS.has(ext)) {
    throw new AppError({
      code: "INVALID_PATH",
      message: `Refusing to open executable file type: ${ext}`,
      context: { candidate, ext },
    });
  }
}

// A placeholder branch slug used purely to resolve a worktree path pattern down
// to its parent directory. Worktrees for a project all share the parent of the
// resolved pattern; the slug value itself is discarded after `dirname()`.
const WORKTREE_PARENT_PROBE_SLUG = "__daintree_probe__";

/**
 * Compute the set of "worktree parent" directories implied by the configured
 * worktree path pattern(s) and the global default. Worktrees aren't tracked
 * in `projectStore` (they live in workspace-host state), but they always sit
 * under a deterministic parent derived from the project root + pattern. We
 * include both the global-configured pattern and the built-in default so a
 * stale or temporarily-changed pattern doesn't lock the user out of the
 * "Reveal in Finder" / "Open in Editor" flows on existing worktrees.
 */
function collectWorktreeParentDirs(projectRoots: readonly string[]): string[] {
  const patterns = new Set<string>([DEFAULT_WORKTREE_PATH_PATTERN]);
  try {
    const configured = store.get("worktreeConfig.pathPattern");
    if (typeof configured === "string" && configured.trim()) {
      const validation = validatePathPattern(configured);
      if (validation.valid) {
        patterns.add(configured);
      }
    }
  } catch {
    // Store read failures fall through to the default-only set.
  }

  const parents = new Set<string>();
  for (const root of projectRoots) {
    for (const pattern of patterns) {
      try {
        const variables = buildPathPatternVariables(root, WORKTREE_PARENT_PROBE_SLUG);
        const resolved = resolvePathPattern(pattern, variables, root);
        const parent = nodePath.dirname(resolved);
        if (parent && parent !== "." && parent !== nodePath.sep) {
          parents.add(parent);
        }
      } catch {
        // Skip patterns that fail to resolve for a given root.
      }
    }
  }
  return [...parents];
}

/**
 * Guard a renderer-supplied path before forwarding it to a system sink
 * (shell.openPath / EditorService.openFile). Rejects non-absolute paths,
 * executable extensions, and any path not contained within a known project
 * root, a known worktree parent directory, or the app's userData dir (where
 * crash logs live). The extension is checked twice — on the raw input and on
 * the realpath-resolved target — so a benignly-named symlink (`notes.txt` →
 * `Evil.app`) inside a root can't smuggle an executable past the deny-list.
 * Returns the resolved path so the caller hands the canonical target to the
 * sink, shrinking the TOCTOU window.
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

  const projectRoots = projectStore.getAllProjects().map((p) => p.path);
  const roots: string[] = [...projectRoots];
  roots.push(...collectWorktreeParentDirs(projectRoots));
  roots.push(app.getPath("userData"));

  const realTarget = await resolveContainedPath(targetPath, roots);

  // shell.openPath / openFile follow symlinks, so re-check the resolved
  // extension to defeat a safe-named symlink pointing at an executable.
  if (flavor === "launcher") {
    assertExtensionAllowed(realTarget);
  }

  return realTarget;
}

/**
 * Resolve a renderer-supplied path for the UNCONFINED reveal op — the
 * user-initiated recovery path for a file link that resolved outside project
 * roots. Unlike {@link assertPathAllowed}, this deliberately skips roots
 * containment (that's the rejection the user is asking to bypass), but keeps
 * every other guard: absolute-only, executable deny-list on both the raw
 * input and the realpath target (defeats a safe-named symlink → Evil.app),
 * realpath canonicalization (collapses intermediate-component TOCTOU — lesson
 * #6442), and a stat gate so a since-deleted path surfaces as INVALID_PATH
 * instead of `shell.showItemInFolder`'s silent no-op. The deny-list is
 * unconditional here — unlike the confined "editor" flavor, which relaxes it —
 * because an out-of-root path is untrusted terminal output and the historical
 * Windows ShellExecute("open") / Linux xdg-open fallbacks make reveal a launch
 * surface on some platforms.
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
      // User-initiated reveal of an OUTSIDE_ROOT path (the recovery action on
      // a file-link toast). Bypasses roots containment but keeps the deny-list,
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
