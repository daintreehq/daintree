import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { onWithContext } from "../utils.js";
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
    // Size and kind of a local file about to be uploaded: only one the person
    // chose in this same view (a drop, paste or attach), never any path a page names.
    statLocalFile: op(
      FILE_TRANSFER_METHOD_CHANNELS.statLocalFile,
      async (ctx, payload: { localPath: string }): Promise<LocalFileStat | null> =>
        requireRemoteService("hostUploadClient").statLocalSource(
          ctx.webContentsId,
          payload?.localPath
        ),
      { withContext: true }
    ),
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
      async (ctx, payload: { opId: string }): Promise<void> => {
        if (typeof payload?.opId !== "string") return;
        // Uploads and downloads share the operation id space; whichever owns it
        // stops, and only for the view that started it.
        if (getRemoteService("hostUploadClient")?.cancel(payload.opId, ctx.webContentsId)) return;
        requireRemoteService("hostFileClient").cancel(payload.opId, ctx.webContentsId);
      },
      { withContext: true }
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

/**
 * Local files the person chose in a remote-bound view: the preload reports
 * each dropped or pasted File's path as it resolves it, over a channel the
 * page itself can't reach. Only these are ever read for an upload.
 */
function registerLocalSourceGrants(): () => void {
  return onWithContext(CHANNELS.FILE_TRANSFER_GRANT_LOCAL_SOURCES, (ctx, paths: unknown) => {
    getRemoteService("hostUploadClient")?.grantLocalSources(ctx.webContentsId, paths);
  });
}

export function registerFileTransferHandlers(): () => void {
  const disposers = [fileTransferNamespace.register(), registerLocalSourceGrants()];
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
}
