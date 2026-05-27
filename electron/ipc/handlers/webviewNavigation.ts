import { webContents } from "electron";
import { defineIpcNamespace, op } from "../define.js";
import { getWebviewDialogService } from "../../services/WebviewDialogService.js";
import { sanitizeUrlForHistory } from "../../../shared/utils/urlHistory.js";
import type { HandlerDependencies } from "../types.js";
import { WEBVIEW_NAVIGATION_METHOD_CHANNELS } from "./webviewNavigation.preload.js";

export const webviewNavigationNamespace = defineIpcNamespace({
  name: "webviewNavigation",
  ops: {
    getNavigationHistory: op(
      WEBVIEW_NAVIGATION_METHOD_CHANNELS.getNavigationHistory,
      async (webContentsId: number) => {
        if (!getWebviewDialogService().getPanelId(webContentsId)) {
          throw new Error("WebContents not registered as a browser panel");
        }

        const wc = webContents.fromId(webContentsId);
        if (!wc || wc.isDestroyed()) {
          throw new Error("WebContents not found or destroyed");
        }

        const nh = wc.navigationHistory;
        const entries = nh.getAllEntries();
        const activeIndex = nh.getActiveIndex();

        const sanitized: import("../../../shared/types/browser.js").BrowserNavigationHistoryEntry[] =
          [];
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]!;
          const sanitizedUrl = sanitizeUrlForHistory(entry.url);
          if (sanitizedUrl !== null) {
            sanitized.push({
              index: i,
              url: sanitizedUrl,
              title: entry.title || "",
            });
          }
        }

        return {
          entries: sanitized,
          activeIndex,
          canGoBack: nh.canGoBack(),
          canGoForward: nh.canGoForward(),
        };
      }
    ),
    goToHistoryIndex: op(
      WEBVIEW_NAVIGATION_METHOD_CHANNELS.goToHistoryIndex,
      async (webContentsId: number, index: number) => {
        if (!getWebviewDialogService().getPanelId(webContentsId)) {
          throw new Error("WebContents not registered as a browser panel");
        }

        const wc = webContents.fromId(webContentsId);
        if (!wc || wc.isDestroyed()) {
          throw new Error("WebContents not found or destroyed");
        }

        const nh = wc.navigationHistory;
        if (index < 0 || index >= nh.length()) {
          throw new Error(`Index ${index} out of bounds (length: ${nh.length()})`);
        }

        nh.goToIndex(index);
      }
    ),
  },
});

export function registerWebviewNavigationHandlers(_deps: HandlerDependencies): () => void {
  return webviewNavigationNamespace.register();
}
