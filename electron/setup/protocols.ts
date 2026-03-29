import { app, protocol, net, session, BrowserWindow } from "electron";
import path from "path";
import { pathToFileURL } from "url";
import { resolveAppUrlToDistPath, getMimeType, buildHeaders } from "../utils/appProtocol.js";
import {
  classifyPartition,
  getLocalhostDevCSP,
  mergeCspHeaders,
  isDevPreviewPartition,
} from "../utils/webviewCsp.js";
import { canOpenExternalUrl, openExternalUrl } from "../utils/openExternal.js";
import { isLocalhostUrl } from "../../shared/utils/urlUtils.js";
import { getWebviewDialogService } from "../services/WebviewDialogService.js";
import { CHANNELS } from "../ipc/channels.js";

export function registerAppProtocol(distPath: string): void {
  protocol.handle("app", async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: buildHeaders("text/plain"),
      });
    }

    const { filePath, error } = resolveAppUrlToDistPath(request.url, distPath, {
      expectedHostname: "canopy",
    });

    if (error || !filePath) {
      console.error("[MAIN] App protocol error:", error);
      return new Response("Not Found", {
        status: 404,
        headers: buildHeaders("text/plain"),
      });
    }

    try {
      const fileUrl = pathToFileURL(filePath).toString();
      const response = await net.fetch(fileUrl);

      if (!response.ok) {
        return new Response("Not Found", {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        });
      }

      const mimeType = getMimeType(filePath);
      const headers = buildHeaders(mimeType);
      const buffer = await response.arrayBuffer();

      return new Response(buffer, {
        status: 200,
        headers: headers,
      });
    } catch (err) {
      console.error("[MAIN] Error serving file:", filePath, err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  });
}

export function registerCanopyFileProtocol(): void {
  protocol.handle("canopy-file", async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const url = new URL(request.url);
      const filePath = url.searchParams.get("path");
      const rootPath = url.searchParams.get("root");

      if (!filePath || !rootPath) {
        return new Response("Missing path or root parameter", { status: 400 });
      }

      if (filePath.includes("\0") || rootPath.includes("\0")) {
        return new Response("Invalid path", { status: 400 });
      }

      if (!path.isAbsolute(filePath) || !path.isAbsolute(rootPath)) {
        return new Response("Paths must be absolute", { status: 400 });
      }

      const normalizedFile = path.normalize(filePath);
      const normalizedRoot = path.normalize(rootPath);

      if (
        !normalizedFile.startsWith(normalizedRoot + path.sep) &&
        normalizedFile !== normalizedRoot
      ) {
        return new Response("Forbidden — path outside root", { status: 403 });
      }

      const mimeType = getMimeType(normalizedFile);
      const fileUrl = pathToFileURL(normalizedFile).toString();
      const response = await net.fetch(fileUrl);

      if (!response.ok) {
        return new Response("Not Found", { status: 404 });
      }

      const buffer = await response.arrayBuffer();
      return new Response(buffer, {
        status: 200,
        headers: { "Content-Type": mimeType },
      });
    } catch (err) {
      console.error("[MAIN] canopy-file protocol error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  });
}

export function setupWebviewCSP(): void {
  const configuredPartitions = new Set<string>();

  const applyCSP = (partition: string): void => {
    if (configuredPartitions.has(partition)) {
      return;
    }

    const partitionType = classifyPartition(partition);
    if (partitionType === "unknown" || partitionType === "portal") {
      return;
    }

    const ses = session.fromPartition(partition);
    const cspPolicy = getLocalhostDevCSP();

    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: mergeCspHeaders(details, cspPolicy),
      });
    });

    configuredPartitions.add(partition);
  };

  // Configure static partitions (browser only - portal excluded)
  applyCSP("persist:browser");

  // Monitor for dynamic dev-preview partitions
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (_event, _webPreferences, params) => {
      const partition = params.partition;
      if (partition && isDevPreviewPartition(partition)) {
        applyCSP(partition);
      }
    });

    // Route target="_blank" links and window.open() from webview guests to the system browser
    if (contents.getType() === "webview") {
      contents.setWindowOpenHandler(({ url }) => {
        if (url && canOpenExternalUrl(url)) {
          void openExternalUrl(url).catch((error) => {
            console.error("[MAIN] Failed to open webview external URL:", error);
          });
        } else {
          console.warn(`[MAIN] Blocked webview window.open for unsupported/empty URL: ${url}`);
        }
        return { action: "deny" };
      });

      // Block webview guest navigations to non-localhost URLs (closes TOCTOU gap
      // where will-attach-webview validates src at attachment but the guest can
      // navigate away afterwards).
      contents.on("will-navigate", (event, navigationUrl) => {
        if (!isLocalhostUrl(navigationUrl)) {
          console.warn(`[MAIN] Blocked webview navigation to non-localhost URL: ${navigationUrl}`);
          event.preventDefault();
        }
      });

      contents.on("will-redirect", (event, redirectUrl) => {
        if (!isLocalhostUrl(redirectUrl)) {
          console.warn(`[MAIN] Blocked webview redirect to non-localhost URL: ${redirectUrl}`);
          event.preventDefault();
        }
      });

      // Intercept JavaScript dialogs (alert/confirm/prompt) from webview guests.
      // Electron 40 emits "js-dialog" but its TS types omit it from the overload union.
      (contents as { on: (event: string, listener: (...args: unknown[]) => void) => void }).on(
        "js-dialog",
        (
          event: unknown,
          _url: unknown,
          message: unknown,
          dialogType: unknown,
          defaultValue: unknown,
          callback: unknown
        ) => {
          (event as Electron.Event).preventDefault();
          const msg = message as string;
          const type = dialogType as string;
          const defVal = (defaultValue as string) ?? "";
          const cb = callback as (success: boolean, response?: string) => void;

          const dialogService = getWebviewDialogService();
          const dialogId = crypto.randomUUID();
          const panelId = dialogService.registerDialog(dialogId, contents.id, cb);

          if (!panelId) {
            cb(type === "alert");
            return;
          }

          const hostContents =
            (contents as unknown as { hostWebContents?: Electron.WebContents }).hostWebContents ??
            contents;
          const parentWindow = BrowserWindow.fromWebContents(hostContents);
          if (parentWindow && !parentWindow.isDestroyed()) {
            parentWindow.webContents.send("webview:dialog-request", {
              dialogId,
              panelId,
              type,
              message: msg,
              defaultValue: defVal,
            });
          } else {
            dialogService.resolveDialog(dialogId, type === "alert");
          }
        }
      );

      // Intercept find-in-page shortcuts (Cmd/Ctrl+F, Cmd/Ctrl+G, Escape) from webview guests
      contents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown") return;
        const isMac = process.platform === "darwin";
        const mod = isMac ? input.meta : input.control;

        let shortcut: "find" | "next" | "prev" | "close" | null = null;
        if (input.key === "Escape") {
          shortcut = "close";
        } else if (mod && input.key.toLowerCase() === "f" && !input.alt && !input.shift) {
          shortcut = "find";
        } else if (mod && input.key.toLowerCase() === "g" && !input.alt) {
          shortcut = input.shift ? "prev" : "next";
        }

        if (!shortcut) return;

        const panelId = getWebviewDialogService().getPanelId(contents.id);
        if (!panelId) return;

        if (shortcut !== "close") {
          event.preventDefault();
        }
        const findHostContents =
          (contents as unknown as { hostWebContents?: Electron.WebContents }).hostWebContents ??
          contents;
        const findParentWindow = BrowserWindow.fromWebContents(findHostContents);
        if (findParentWindow && !findParentWindow.isDestroyed()) {
          findParentWindow.webContents.send(CHANNELS.WEBVIEW_FIND_SHORTCUT, { panelId, shortcut });
        }
      });
    }
  });
}
