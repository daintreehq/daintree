import { app, shell } from "electron";
import os from "os";
import * as nodePath from "path";
import * as nodeFs from "fs";
import { CHANNELS } from "../channels.js";
import { openExternalUrl } from "../../utils/openExternal.js";
import { projectStore } from "../../services/ProjectStore.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  SystemOpenExternalPayloadSchema,
  SystemOpenPathPayloadSchema,
  SystemOpenInEditorPayloadSchema,
} from "../../schemas/index.js";
import type { HandlerDependencies } from "../types.js";
import { typedHandle, typedHandleValidated } from "../utils.js";
import type {
  SystemOpenExternalPayload,
  SystemOpenPathPayload,
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

/**
 * Guard a renderer-supplied path before forwarding it to a system sink
 * (shell.openPath / EditorService.openFile). Rejects non-absolute paths,
 * executable extensions, and any path not contained within a known project
 * root or the app's userData dir (where crash logs live). Containment uses
 * fs.realpath on both sides — re-resolved at call time — to defeat symlink
 * substitution, matching the pattern in electron/ipc/handlers/files.ts.
 */
async function assertPathAllowed(targetPath: string): Promise<void> {
  if (!nodePath.isAbsolute(targetPath)) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "Only absolute paths are allowed",
      context: { targetPath },
    });
  }

  const ext = nodePath.extname(targetPath).toLowerCase();
  if (DENIED_EXTENSIONS.has(ext)) {
    throw new AppError({
      code: "INVALID_PATH",
      message: `Refusing to open executable file type: ${ext}`,
      context: { targetPath, ext },
    });
  }

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

  const roots = projectStore.getAllProjects().map((p) => p.path);
  roots.push(app.getPath("userData"));

  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await nodeFs.promises.realpath(root);
    } catch {
      // A stale or deleted root can't contain anything — skip it.
      continue;
    }
    if (realTarget === realRoot || realTarget.startsWith(realRoot + nodePath.sep)) {
      return;
    }
  }

  throw new AppError({
    code: "OUTSIDE_ROOT",
    message: "Path is outside all known project roots",
    context: { targetPath },
  });
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
      await assertPathAllowed(targetPath);
      const errorString = await shell.openPath(targetPath);
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

  const handleSystemOpenInEditor = async ({
    path: targetPath,
    line,
    col,
    projectId,
  }: SystemOpenInEditorPayload) => {
    await assertPathAllowed(targetPath);

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
    await openFile(targetPath, line, col, editorConfig);
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
      const { execFileSync } = await import("child_process");
      const checkCmd = process.platform === "win32" ? "where" : "which";
      execFileSync(checkCmd, [command], { stdio: "ignore" });
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
