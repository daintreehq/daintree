import { webContents } from "electron";
import { defineIpcNamespace, op } from "../define.js";
import { getWebviewDialogService } from "../../services/WebviewDialogService.js";
import { AppError } from "../../utils/errorTypes.js";
import type { HandlerDependencies } from "../types.js";
import { WEBVIEW_CAPTURE_METHOD_CHANNELS } from "./webviewCapture.preload.js";

export const webviewCaptureNamespace = defineIpcNamespace({
  name: "webviewCapture",
  ops: {
    captureScreenshot: op(
      WEBVIEW_CAPTURE_METHOD_CHANNELS.captureScreenshot,
      async (panelId: string) => {
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

        const url = wc.getURL();
        if (!url || url === "about:blank") {
          throw new AppError({
            code: "UNSUPPORTED",
            message: "Browser has no page loaded to screenshot",
            context: { panelId },
          });
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
      }
    ),
  },
});

export function registerWebviewCaptureHandlers(_deps: HandlerDependencies): () => void {
  return webviewCaptureNamespace.register();
}
