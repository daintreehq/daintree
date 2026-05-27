import { app, shell } from "electron";
import os from "os";
import * as nodePath from "path";
import { CHANNELS } from "../channels.js";
import { openExternalUrl } from "../../utils/openExternal.js";
import { projectStore } from "../../services/ProjectStore.js";
import { AppError } from "../../utils/errorTypes.js";
import { resolveContainedPath } from "./pathGuard.js";
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

/**
 * Guard a renderer-supplied path before forwarding it to a system sink
 * (shell.openPath / EditorService.openFile). Rejects non-absolute paths,
 * executable extensions, and any path not contained within a known project
 * root or the app's userData dir (where crash logs live). The extension is
 * checked twice — on the raw input and on the realpath-resolved target — so a
 * benignly-named symlink (`notes.txt` → `Evil.app`) inside a root can't smuggle
 * an executable past the deny-list. Returns the resolved path so the caller
 * hands the canonical target to the sink, shrinking the TOCTOU window.
 */
async function assertPathAllowed(targetPath: string): Promise<string> {
  assertExtensionAllowed(targetPath);

  const roots = projectStore.getAllProjects().map((p) => p.path);
  roots.push(app.getPath("userData"));

  const realTarget = await resolveContainedPath(targetPath, roots);

  // shell.openPath / openFile follow symlinks, so re-check the resolved
  // extension to defeat a safe-named symlink pointing at an executable.
  assertExtensionAllowed(realTarget);

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

  const handleSystemOpenInEditor = async ({
    path: targetPath,
    line,
    col,
    projectId,
  }: SystemOpenInEditorPayload) => {
    const realTarget = await assertPathAllowed(targetPath);

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
