import fs from "node:fs/promises";
import path from "node:path";
import { defineIpcNamespace, op } from "../define.js";
import { getRemoteService, requireRemoteService } from "../../remote/runtime.js";
import { store } from "../../store.js";
import { AppError } from "../../utils/errorTypes.js";
import { FILE_TRANSFER_METHOD_CHANNELS } from "./fileTransfer.preload.js";
import type {
  AnswerHostPickPayload,
  DownloadPayload,
  DownloadResult,
  LocalFileStat,
  UploadBytesPayload,
  UploadLocalFilePayload,
  UploadPreferences,
  UploadResult,
} from "../../../shared/types/ipc/fileTransfer.js";

function readUploadPreferences(): UploadPreferences {
  // Absent until the user changes it, so the settings file of someone who
  // never uses remote hosts stays untouched.
  return {
    interceptCtrlVImages: store.get("remoteHostsPreferences")?.interceptCtrlVImages ?? true,
  };
}

/** Size and kind of a local file about to be uploaded, or null when there is none. */
async function statLocalFile(payload: { localPath: string }): Promise<LocalFileStat | null> {
  const localPath = payload?.localPath;
  if (typeof localPath !== "string" || !path.isAbsolute(localPath) || localPath.includes("\0")) {
    throw new AppError({ code: "VALIDATION", message: "Invalid local path" });
  }
  const stat = await fs.stat(localPath).catch(() => null);
  if (!stat) return null;
  return { size: stat.size, isDirectory: stat.isDirectory() };
}

export const fileTransferNamespace = defineIpcNamespace({
  name: "fileTransfer",
  ops: {
    uploadLocalFile: op(
      FILE_TRANSFER_METHOD_CHANNELS.uploadLocalFile,
      async (ctx, payload: UploadLocalFilePayload): Promise<UploadResult> =>
        requireRemoteService("hostUploadClient").uploadLocalFile(ctx.webContentsId, payload),
      { withContext: true }
    ),
    uploadBytes: op(
      FILE_TRANSFER_METHOD_CHANNELS.uploadBytes,
      async (ctx, payload: UploadBytesPayload): Promise<UploadResult> =>
        requireRemoteService("hostUploadClient").uploadBytes(ctx.webContentsId, payload),
      { withContext: true }
    ),
    statLocalFile: op(FILE_TRANSFER_METHOD_CHANNELS.statLocalFile, statLocalFile),
    getUploadPreferences: op(
      FILE_TRANSFER_METHOD_CHANNELS.getUploadPreferences,
      async (): Promise<UploadPreferences> => readUploadPreferences()
    ),
    setUploadPreferences: op(
      FILE_TRANSFER_METHOD_CHANNELS.setUploadPreferences,
      async (patch: Partial<UploadPreferences>): Promise<UploadPreferences> => {
        if (typeof patch?.interceptCtrlVImages !== "boolean") {
          throw new AppError({ code: "VALIDATION", message: "Invalid upload preferences" });
        }
        store.set("remoteHostsPreferences", {
          ...readUploadPreferences(),
          interceptCtrlVImages: patch.interceptCtrlVImages,
        });
        return readUploadPreferences();
      }
    ),
    download: op(
      FILE_TRANSFER_METHOD_CHANNELS.download,
      async (ctx, payload: DownloadPayload): Promise<DownloadResult> =>
        requireRemoteService("hostFileClient").download(ctx.webContentsId, payload),
      { withContext: true }
    ),
    cancel: op(
      FILE_TRANSFER_METHOD_CHANNELS.cancel,
      async (payload: { opId: string }): Promise<void> => {
        if (typeof payload?.opId !== "string") return;
        // Uploads and downloads share the operation id space; whichever owns it stops.
        if (getRemoteService("hostUploadClient")?.cancel(payload.opId)) return;
        requireRemoteService("hostFileClient").cancel(payload.opId);
      }
    ),
    answerHostPick: op(
      FILE_TRANSFER_METHOD_CHANNELS.answerHostPick,
      async (ctx, payload: AnswerHostPickPayload): Promise<void> =>
        requireRemoteService("hostFileClient").answerHostPick(ctx.webContentsId, payload),
      { withContext: true }
    ),
    // Null for a local view, and on a machine where no remote service ever
    // started, so a view of this machine keeps its plain preview URLs.
    getPreviewCapability: op(
      FILE_TRANSFER_METHOD_CHANNELS.getPreviewCapability,
      async (ctx): Promise<string | null> =>
        getRemoteService("hostFileClient")?.previewCapability(ctx.webContentsId) ?? null,
      { withContext: true }
    ),
  },
});

export function registerFileTransferHandlers(): () => void {
  return fileTransferNamespace.register();
}
