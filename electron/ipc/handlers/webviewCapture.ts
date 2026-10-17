import { webContents } from "electron";
import { defineIpcNamespace, op } from "../define.js";
import { getWebviewDialogService } from "../../services/WebviewDialogService.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  guestDocument,
  isGuestPageReadableByHost,
  isRemoteView,
} from "../../window/webviewSrcGate.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import { WEBVIEW_CAPTURE_METHOD_CHANNELS } from "./webviewCapture.preload.js";

export const webviewCaptureNamespace = defineIpcNamespace({
  name: "webviewCapture",
  ops: {
    captureScreenshot: op(
      WEBVIEW_CAPTURE_METHOD_CHANNELS.captureScreenshot,
      async (ctx: IpcContext, panelId: string, options?: { forHost?: boolean }) => {
        // The renderer only has the panel id; resolve the live webContentsId
        // from the panel registry (populated by both browser and dev-preview
        // webviews) so this works for either panel kind.
        const webContentsId = getWebviewDialogService().getWebContentsId(panelId);
        if (webContentsId === undefined) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "No browser panel is available to screenshot",
            context: { panelId },
          });
        }

        const wc = webContents.fromId(webContentsId);
        if (!wc || wc.isDestroyed()) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "Browser webview is no longer available",
            context: { panelId, webContentsId },
          });
        }

        // Only a panel the asking view embeds, as registration requires: the
        // registry is process-wide, and a panel id from another window (or a
        // host's MCP asking through a view it drives) must not read its pixels.
        const embedder = wc.hostWebContents;
        if (!embedder || embedder.isDestroyed() || embedder.id !== ctx.webContentsId) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "No browser panel is available to screenshot",
            context: { panelId },
          });
        }

        const url = wc.getURL();
        if (!url || url === "about:blank") {
          throw new AppError({
            code: "UNSUPPORTED",
            message: "Browser has no page loaded to screenshot",
            context: { panelId },
          });
        }

        // A capture the host asked for, from a window attached to it: never a
        // page on this computer's own network, nor one that loaded anything
        // from it, which isn't the host's to see. Judged again once the pixels
        // are in, so a page that navigates meanwhile is never what's handed over.
        const forHost = options?.forHost === true && isRemoteView(ctx.webContentsId);
        const notForHost = () =>
          new AppError({
            code: "PERMISSION",
            message: "The page shows content from this computer's own network",
            userMessage:
              "This page shows content from this computer's own network, so it isn't shown to the host.",
            context: { panelId },
          });
        const shown = forHost ? guestDocument(webContentsId) : null;
        if (forHost) {
          if (shown === null || shown.localNetwork) throw notForHost();
          const readable = await isGuestPageReadableByHost(ctx.webContentsId, url, async (host) =>
            (await wc.session.resolveHost(host)).endpoints.map((endpoint) => endpoint.address)
          );
          if (!readable) throw notForHost();
        }

        let image: Electron.NativeImage;
        try {
          image = await wc.capturePage();
        } catch (err) {
          // The webContents can be destroyed in the gap between the isDestroyed
          // check and this await (tab closed / project evicted mid-call), which
          // surfaces as a raw Electron rejection. Normalize it to the same
          // AppError the caller and MCP error path expect.
          throw new AppError({
            code: "NOT_FOUND",
            message: "Browser panel became unavailable during capture",
            context: { panelId, webContentsId },
            cause: err instanceof Error ? err : undefined,
          });
        }
        if (forHost) {
          const now = guestDocument(webContentsId);
          if (
            now === null ||
            now.generation !== shown!.generation ||
            now.localNetwork ||
            wc.isDestroyed() ||
            wc.getURL() !== url
          ) {
            throw notForHost();
          }
        }
        if (image.isEmpty()) {
          throw new AppError({
            code: "INTERNAL",
            message: "Screenshot capture returned an empty image",
            context: { panelId },
          });
        }

        const size = image.getSize();
        return {
          pngBase64: image.toPNG().toString("base64"),
          width: size.width,
          height: size.height,
        };
      },
      { withContext: true }
    ),
  },
});

export function registerWebviewCaptureHandlers(_deps: HandlerDependencies): () => void {
  return webviewCaptureNamespace.register();
}
