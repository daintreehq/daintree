import { defineIpcNamespace, op } from "../define.js";
import { pendingRemoteHostsHandler } from "../../remote/pendingHandler.js";
import { FILE_TRANSFER_METHOD_CHANNELS } from "./fileTransfer.preload.js";
import type {
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
      async (_payload: DownloadPayload): Promise<DownloadResult> =>
        pendingRemoteHostsHandler(FILE_TRANSFER_METHOD_CHANNELS.download)
    ),
    cancel: op(
      FILE_TRANSFER_METHOD_CHANNELS.cancel,
      async (_payload: { opId: string }): Promise<void> =>
        pendingRemoteHostsHandler(FILE_TRANSFER_METHOD_CHANNELS.cancel)
    ),
  },
});

export function registerFileTransferHandlers(): () => void {
  return fileTransferNamespace.register();
}
