import { defineIpcNamespace, op } from "../define.js";
import { pendingRemoteHostsHandler } from "../../remote/pendingHandler.js";
import { requireRemoteService } from "../../remote/runtime.js";
import { FILE_TRANSFER_METHOD_CHANNELS } from "./fileTransfer.preload.js";
import type {
  AnswerHostPickPayload,
  DownloadPayload,
  DownloadResult,
  UploadBytesPayload,
  UploadLocalFilePayload,
  UploadResult,
} from "../../../shared/types/ipc/fileTransfer.js";

export const fileTransferNamespace = defineIpcNamespace({
  name: "fileTransfer",
  ops: {
    uploadLocalFile: op(
      FILE_TRANSFER_METHOD_CHANNELS.uploadLocalFile,
      async (_payload: UploadLocalFilePayload): Promise<UploadResult> =>
        pendingRemoteHostsHandler(FILE_TRANSFER_METHOD_CHANNELS.uploadLocalFile)
    ),
    uploadBytes: op(
      FILE_TRANSFER_METHOD_CHANNELS.uploadBytes,
      async (_payload: UploadBytesPayload): Promise<UploadResult> =>
        pendingRemoteHostsHandler(FILE_TRANSFER_METHOD_CHANNELS.uploadBytes)
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
        requireRemoteService("hostFileClient").cancel(payload.opId);
      }
    ),
    answerHostPick: op(
      FILE_TRANSFER_METHOD_CHANNELS.answerHostPick,
      async (ctx, payload: AnswerHostPickPayload): Promise<void> =>
        requireRemoteService("hostFileClient").answerHostPick(ctx.webContentsId, payload),
      { withContext: true }
    ),
  },
});

export function registerFileTransferHandlers(): () => void {
  return fileTransferNamespace.register();
}
