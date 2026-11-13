import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext, HandlerDependencies } from "../types.js";
import { getWebviewDialogService } from "../../services/WebviewDialogService.js";
import { WEBVIEW_FIND_METHOD_CHANNELS } from "./webviewFind.preload.js";

export const webviewFindNamespace = defineIpcNamespace({
  name: "webviewFind",
  ops: {
    /**
     * Whether the sender's find bar over one of its panels is open, so main can
     * keep that panel's guest from also acting on the Escape that closes it.
     * Recorded under the sender, which is the only view it can speak for.
     */
    setFindOpen: op(
      WEBVIEW_FIND_METHOD_CHANNELS.setFindOpen,
      async (ctx: IpcContext, panelId: string, open: boolean): Promise<void> => {
        if (typeof panelId !== "string" || !panelId || typeof open !== "boolean") {
          throw new Error("Invalid arguments: panelId must be a string, open a boolean");
        }
        getWebviewDialogService().setFindOpen(ctx.webContentsId, panelId, open);
      },
      { withContext: true }
    ),
  },
});

export function registerWebviewFindHandlers(_deps: HandlerDependencies): () => void {
  return webviewFindNamespace.register();
}
