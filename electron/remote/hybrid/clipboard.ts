import { clipboard, type NativeImage } from "electron";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getIpcDispatcher } from "../../ipc/dispatcher.js";
import type { HybridSplit, IpcDispatcher } from "../../ipc/endpoint.js";
import type { IpcContext } from "../../ipc/types.js";
import { MAX_CLIPBOARD_IMAGE_BYTES } from "../../utils/clipboardImage.js";
import { AppError } from "../../utils/errorTypes.js";
import { getRemoteService } from "../runtime.js";
import type { HostUploadClient } from "../files/uploadClient.js";

/**
 * Hybrid splits for pasting and attaching in a window attached to a remote
 * host. The clipboard and the attach dialog are this machine's; the file the
 * agent reads has to be on the host. So a pasted image is captured here, its
 * thumbnail built here from the bytes already in hand, and the image itself
 * uploaded into the host inbox. The attach dialog opens here and answers with
 * local paths, which the window then uploads one by one with progress.
 */

export interface ClipboardSplitDeps {
  readImage(): NativeImage;
  uploader(): Pick<HostUploadClient, "uploadClipboardImage" | "grantLocalSources"> | undefined;
}

const THUMB_HEIGHT = 40;

function thumbnailOf(image: NativeImage): string {
  const size = image.getSize();
  const width = Math.max(1, Math.round((size.width / size.height) * THUMB_HEIGHT));
  const thumbnail = image.resize({ width, height: THUMB_HEIGHT });
  return `data:image/png;base64,${thumbnail.toPNG().toString("base64")}`;
}

function saveImage(deps: ClipboardSplitDeps): HybridSplit {
  return async ({ hostId, webContentsId }) => {
    const image = deps.readImage();
    if (image.isEmpty()) {
      throw new AppError({
        code: "CLIPBOARD_EMPTY",
        message: "No image in clipboard",
        userMessage: "There's no image on the clipboard to save.",
      });
    }
    const png = image.toPNG();
    if (png.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
      throw new AppError({
        code: "PAYLOAD_TOO_LARGE",
        message: "Clipboard image exceeds the paste limit",
        userMessage: "That image is too large to paste.",
      });
    }
    const uploader = deps.uploader();
    if (!uploader) {
      throw new AppError({
        code: "HOST_DISCONNECTED",
        message: "Remote hosts client is not running",
      });
    }
    const thumbnailDataUrl = thumbnailOf(image);
    const filePath = await uploader.uploadClipboardImage(
      webContentsId,
      hostId as HostId,
      new Uint8Array(png)
    );
    return { filePath, thumbnailDataUrl };
  };
}

// The picker is this machine's; what it returns are local paths the window
// uploads, recorded as the person's choice in this view so the upload may read them.
function pickAttachments(deps: ClipboardSplitDeps): HybridSplit {
  return async ({ local, webContentsId }) => {
    const picked = await local();
    if (Array.isArray(picked) && picked.length > 0) {
      deps.uploader()?.grantLocalSources(webContentsId, picked);
    }
    return picked;
  };
}

export function createClipboardSplits(
  deps: ClipboardSplitDeps
): Readonly<Record<string, HybridSplit>> {
  return {
    [CHANNELS.CLIPBOARD_SAVE_IMAGE]: saveImage(deps),
    [CHANNELS.CLIPBOARD_PICK_ATTACHMENTS]: pickAttachments(deps),
  };
}

/**
 * Shell side: register the clipboard splits over the base refusals. The
 * remote leg is an upload, not a hybrid call, so the host admits nothing.
 */
export function installClipboardSplits(
  dispatcher: Pick<IpcDispatcher<IpcContext>, "registerHybridSplit"> = getIpcDispatcher()
): () => void {
  const splits = createClipboardSplits({
    readImage: () => clipboard.readImage(),
    uploader: () => getRemoteService("hostUploadClient"),
  });
  const disposers = Object.entries(splits).map(([channel, split]) =>
    dispatcher.registerHybridSplit(channel, split)
  );
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
}
