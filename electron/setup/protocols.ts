import { app, protocol, net, session } from "electron";
import { getWindowForWebContents, getAppWebContents } from "../window/webContentsRegistry.js";
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
import { isLocalhostUrl, isSafeNavigationUrl } from "../../shared/utils/urlUtils.js";
import { getWebviewDialogService } from "../services/WebviewDialogService.js";
import { looksLikeOAuthUrl } from "../services/OAuthLoopbackService.js";
import { CHANNELS } from "../ipc/channels.js";

// Track which sessions have had protocols registered to avoid double-registration
const registeredSessions = new WeakSet<Electron.Session>();
let cachedDistPath: string | null = null;

/**
 * Create the app:// protocol handler function for a given distPath.
 */
function createAppProtocolHandler(distPath: string) {
  return async (request: GlobalRequest) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: buildHeaders("text/plain"),
      });
    }

    const { filePath, error } = resolveAppUrlToDistPath(request.url, distPath, {
      expectedHostname: "daintree",
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
  };
}

/**
 * Create the daintree-file:// protocol handler function.
 */
function createDaintreeFileProtocolHandler() {
  return async (request: GlobalRequest) => {
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
      console.error("[MAIN] daintree-file protocol error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  };
}

/**
 * Register app:// and daintree-file:// protocol handlers on a specific session.
 * Safe to call multiple times — skips sessions that are already configured.
 * Used for per-project session partitions that don't inherit the default session's handlers.
 */
export function registerProtocolsForSession(ses: Electron.Session, distPath: string): void {
  if (registeredSessions.has(ses)) return;
  registeredSessions.add(ses);

  ses.protocol.handle("app", createAppProtocolHandler(distPath));
  ses.protocol.handle("daintree-file", createDaintreeFileProtocolHandler());
  ses.protocol.handle("canopy-file", createDaintreeFileProtocolHandler());
}

export function registerAppProtocol(distPath: string): void {
  cachedDistPath = distPath;
  protocol.handle("app", createAppProtocolHandler(distPath));
}

export function registerDaintreeFileProtocol(): void {
  protocol.handle("daintree-file", createDaintreeFileProtocolHandler());
}

/**
 * Register the canopy-file:// alias during the temporary 0.7/0.8 migration
 * window. It intentionally stays available in both build variants so old
 * Canopy-era URLs continue to resolve after users manually install Daintree.
 */
export function registerCanopyFileProtocol(): void {
  protocol.handle("canopy-file", createDaintreeFileProtocolHandler());
}

/**
 * Get the cached distPath for use when registering protocols on dynamic sessions.
 */
export function getDistPath(): string | null {
  return cachedDistPath;
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

  // Singleton for the browser partition session — used for identity comparison in navigation handlers.
  const browserSession = session.fromPartition("persist:browser");

  // Monitor for dynamic dev-preview partitions
  app.on("web-contents-created", (_event, contents) => {
    const notifyBlockedNavigation = (url: string) => {
      const dialogService = getWebviewDialogService();
      const panelId = dialogService.getPanelId(contents.id);
      if (!panelId) return;

      const isDevPreview = contents.session !== browserSession;
      if (
        isDevPreview &&
        looksLikeOAuthUrl(url) &&
        "executeJavaScript" in contents &&
        typeof dialogService.storeOAuthSessionStorage === "function"
      ) {
        dialogService.storeOAuthSessionStorage(
          panelId,
          contents
            .executeJavaScript(
              `(() => {
                try {
                  return Object.entries(sessionStorage).filter(
                    (entry) =>
                      Array.isArray(entry) &&
                      entry.length === 2 &&
                      typeof entry[0] === "string" &&
                      typeof entry[1] === "string"
                  );
                } catch {
                  return [];
                }
              })()`
            )
            .catch((error: unknown) => {
              console.warn("[MAIN] Failed to capture OAuth sessionStorage snapshot:", error);
              return [];
            })
        );
      }

      const parentWindow = getWindowForWebContents(contents.hostWebContents ?? contents);
      if (parentWindow && !parentWindow.isDestroyed()) {
        getAppWebContents(parentWindow).send(CHANNELS.WEBVIEW_NAVIGATION_BLOCKED, {
          panelId,
          url,
          canOpenExternal: canOpenExternalUrl(url),
        });
      }
    };

    contents.on("will-attach-webview", (_event, _webPreferences, params) => {
      const partition = params.partition;
      if (partition && isDevPreviewPartition(partition)) {
        applyCSP(partition);
      }
    });

    // Route target="_blank" links and window.open() from webview guests to the system browser
    if (contents.getType() === "webview") {
      contents.setWindowOpenHandler(({ url }) => {
        // If this is an OAuth URL from a dev-preview webview, route it through
        // the blocked-nav banner so the user can use "Sign in via Browser" (loopback flow).
        // Without this, window.open() OAuth popups bypass the banner and go straight
        // to the system browser, losing the PKCE sessionStorage state.
        const isDevPreview = contents.session !== browserSession;
        if (url && isDevPreview && looksLikeOAuthUrl(url)) {
          notifyBlockedNavigation(url);
          return { action: "deny" };
        }

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
      // Browser partition allows cross-origin http/https for OAuth/OIDC flows.
      // Dev-preview and other partitions remain restricted to localhost only.
      contents.on("will-navigate", (event, navigationUrl) => {
        const isBrowserPanel = contents.session === browserSession;

        const blocked = isBrowserPanel
          ? !isSafeNavigationUrl(navigationUrl)
          : !isLocalhostUrl(navigationUrl);

        if (blocked) {
          const label = isBrowserPanel ? "unsafe" : "non-localhost";
          console.warn(`[MAIN] Blocked webview navigation to ${label} URL: ${navigationUrl}`);
          event.preventDefault();
          notifyBlockedNavigation(navigationUrl);
        }
      });

      contents.on("will-redirect", (event, redirectUrl) => {
        const isBrowserPanel = contents.session === browserSession;

        const blocked = isBrowserPanel
          ? !isSafeNavigationUrl(redirectUrl)
          : !isLocalhostUrl(redirectUrl);

        if (blocked) {
          const label = isBrowserPanel ? "unsafe" : "non-localhost";
          console.warn(`[MAIN] Blocked webview redirect to ${label} URL: ${redirectUrl}`);
          event.preventDefault();
          notifyBlockedNavigation(redirectUrl);
        }
      });

      // Intercept JavaScript dialogs (alert/confirm/prompt) from webview guests.
      // Electron 40+ emits "js-dialog" but its TS types omit it from the overload union.
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

          const parentWindow = getWindowForWebContents(contents.hostWebContents ?? contents);
          if (parentWindow && !parentWindow.isDestroyed()) {
            getAppWebContents(parentWindow).send("webview:dialog-request", {
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
        const findParentWindow = getWindowForWebContents(contents.hostWebContents ?? contents);
        if (findParentWindow && !findParentWindow.isDestroyed()) {
          getAppWebContents(findParentWindow).send(CHANNELS.WEBVIEW_FIND_SHORTCUT, {
            panelId,
            shortcut,
          });
        }
      });
    }
  });
}
