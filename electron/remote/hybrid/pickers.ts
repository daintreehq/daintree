import { posix } from "node:path";
import type { CopyTreeResult } from "../../../shared/types/ipc/copyTree.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { HostPickRequest } from "../../../shared/types/ipc/hostFiles.js";
import type { Project } from "../../../shared/types/project.js";
import type { Scratch } from "../../../shared/types/scratch.js";
import type { ScratchSaveAsProjectResult } from "../../../shared/types/ipc/scratch.js";
import type { PluginPickPathRequest } from "../../../shared/types/plugin.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getIpcDispatcher } from "../../ipc/dispatcher.js";
import type { HybridSplit, IpcDispatcher } from "../../ipc/endpoint.js";
import { copyFileToClipboard } from "../../ipc/handlers/copyTree.js";
import type { IpcContext } from "../../ipc/types.js";
import { AppError } from "../../utils/errorTypes.js";
import { getRemoteService } from "../runtime.js";
import type { HostFileClient } from "../files/clientInstall.js";

/**
 * Hybrid splits for the calls that open a native file dialog. In a window
 * attached to a remote host the path being chosen is the host's, so the view
 * shows Daintree's host picker instead; anything that then acts on the choice
 * runs on the host. Exports stay on this machine: the file is saved locally.
 */

type PickerClient = Pick<HostFileClient, "pickHostPaths" | "downloadToTemp">;

export interface PickerSplitDeps {
  client(): PickerClient | undefined;
  /** Put a file on this machine's clipboard as a file. */
  copyFileToClipboard(localPath: string): void;
}

function requireClient(deps: PickerSplitDeps): PickerClient {
  const client = deps.client();
  if (!client) {
    throw new AppError({
      code: "HOST_DISCONNECTED",
      message: "Remote hosts client is not running",
    });
  }
  return client;
}

async function pickOne(
  deps: PickerSplitDeps,
  webContentsId: number,
  request: HostPickRequest
): Promise<string | null> {
  const paths = await requireClient(deps).pickHostPaths(webContentsId, request);
  return paths?.[0] ?? null;
}

const localOnly: HybridSplit = ({ local }) => local();

function projectOpenDialog(deps: PickerSplitDeps): HybridSplit {
  return ({ webContentsId }) =>
    pickOne(deps, webContentsId, { mode: "directory", title: "Open folder", buttonLabel: "Open" });
}

/** Choose the project's new folder on the host, then reattach it there. */
function projectLocate(deps: PickerSplitDeps): HybridSplit {
  return async ({ webContentsId, args, remote }) => {
    const projectId = args[0];
    if (typeof projectId !== "string" || !projectId) {
      throw new AppError({ code: "VALIDATION", message: "Invalid project ID" });
    }
    const projects = (await remote(CHANNELS.PROJECT_GET_ALL, [])) as Project[];
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      throw new AppError({ code: "NOT_FOUND", message: `Project not found: ${projectId}` });
    }
    const newPath = await pickOne(deps, webContentsId, {
      mode: "directory",
      title: `Locate "${project.name}"`,
      buttonLabel: "Choose",
      defaultPath: posix.dirname(project.path),
    });
    if (newPath === null) return null;
    return remote(CHANNELS.PROJECT_RELOCATION_APPLY, [{ projectId, mode: "reattach", newPath }]);
  };
}

/** A folder name for the saved project, from the scratch's name. */
export function scratchFolderName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.-]+/, "")
    .slice(0, 80)
    .trim();
  return cleaned || "scratch";
}

/**
 * The scratch is copied into a new folder on the host. The host picker can't
 * make folders, so the user chooses where it goes and the folder is named
 * after the scratch; the host refuses one that already has files in it.
 */
function scratchSaveAsProject(deps: PickerSplitDeps): HybridSplit {
  return async ({ webContentsId, args, remote }) => {
    const scratchId = args[0];
    if (typeof scratchId !== "string" || !scratchId) {
      throw new AppError({ code: "VALIDATION", message: "Invalid scratch ID" });
    }
    const scratches = (await remote(CHANNELS.SCRATCH_GET_ALL, [])) as Scratch[];
    const scratch = scratches.find((candidate) => candidate.id === scratchId);
    if (!scratch) {
      throw new AppError({ code: "NOT_FOUND", message: `Scratch not found: ${scratchId}` });
    }
    const parent = await pickOne(deps, webContentsId, {
      mode: "directory",
      title: `Choose where to save "${scratch.name}"`,
      buttonLabel: "Save here",
    });
    if (parent === null) return { status: "cancelled" } satisfies ScratchSaveAsProjectResult;
    const destinationPath = posix.join(parent, scratchFolderName(scratch.name));
    return remote(undefined, [scratchId, destinationPath]);
  };
}

function pluginPickPath(deps: PickerSplitDeps): HybridSplit {
  return async ({ webContentsId, args }) => {
    const request = (args[1] ?? {}) as Partial<PluginPickPathRequest>;
    if (typeof args[0] !== "string" || !args[0]) {
      throw new AppError({ code: "VALIDATION", message: "pickPath: pluginId is required" });
    }
    const isDirectory = request.kind === "directory";
    const filters =
      !isDirectory && Array.isArray(request.filters) && request.filters.length > 0
        ? request.filters.map((filter) => ({
            name: String(filter.name),
            extensions: Array.isArray(filter.extensions) ? filter.extensions.map(String) : [],
          }))
        : undefined;
    return pickOne(deps, webContentsId, {
      mode: isDirectory ? "directory" : "file",
      title: isDirectory ? "Choose folder" : "Choose file",
      ...(typeof request.defaultPath === "string" && posix.isAbsolute(request.defaultPath)
        ? { defaultPath: request.defaultPath }
        : {}),
      ...(filters ? { filters } : {}),
    });
  };
}

/**
 * The host writes the bundle; this machine downloads it into its own temp
 * folder and puts that copy on its clipboard. The result names the local copy,
 * which is the file the user can actually paste.
 */
function copyTreeGenerateAndCopyFile(deps: PickerSplitDeps): HybridSplit {
  return async ({ hostId, webContentsId, args, remote }) => {
    const result = (await remote(CHANNELS.COPYTREE_GENERATE, args)) as CopyTreeResult;
    if (result.error || !result.filePath) return result;
    const bundle = {
      content: "",
      fileCount: result.fileCount,
      outputBytes: result.outputBytes,
      stats: result.stats,
      outputFormatVersion: result.outputFormatVersion,
    };
    let localPath: string;
    try {
      ({ localPath } = await requireClient(deps).downloadToTemp(
        hostId as HostId,
        result.filePath,
        webContentsId
      ));
    } catch (error) {
      const message = formatErrorMessage(error, "download failed");
      return { ...bundle, error: `Failed to download context file from the host: ${message}` };
    }
    try {
      deps.copyFileToClipboard(localPath);
    } catch (error) {
      const message = formatErrorMessage(error, "clipboard write failed");
      return {
        ...bundle,
        filePath: localPath,
        error: `Failed to copy file to clipboard: ${message}`,
      };
    }
    return { ...bundle, filePath: localPath } satisfies CopyTreeResult;
  };
}

/**
 * The picker splits, by channel. The base splits have no entry for the dialog
 * channels, so a remote window that reaches one before these are installed is
 * refused as not remotable rather than shown a native dialog.
 */
export function createPickerSplits(deps: PickerSplitDeps): Readonly<Record<string, HybridSplit>> {
  return {
    [CHANNELS.PROJECT_OPEN_DIALOG]: projectOpenDialog(deps),
    [CHANNELS.PROJECT_LOCATE]: projectLocate(deps),
    [CHANNELS.PLUGIN_PICK_PATH]: pluginPickPath(deps),
    [CHANNELS.SCRATCH_SAVE_AS_PROJECT]: scratchSaveAsProject(deps),
    // Records come from the renderer; the save dialog and the file are this machine's.
    [CHANNELS.FORGE_AUDIT_EXPORT_LOG]: localOnly,
    [CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE]: copyTreeGenerateAndCopyFile(deps),
  };
}

/**
 * Shell side: register the picker splits. Their remote legs are
 * host-classified channels, except scratch save-as-project's own host leg,
 * which the host admits through HYBRID_HOST_LEGS.
 */
export function installPickerSplits(
  dispatcher: Pick<IpcDispatcher<IpcContext>, "registerHybridSplit"> = getIpcDispatcher()
): () => void {
  const splits = createPickerSplits({
    client: () => getRemoteService("hostFileClient"),
    copyFileToClipboard,
  });
  const disposers = Object.entries(splits).map(([channel, split]) =>
    dispatcher.registerHybridSplit(channel, split)
  );
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
}
