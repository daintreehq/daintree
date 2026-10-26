// eager-import-allow: reads the import-map hash sidecar synchronously while the session CSP is set up on startup
import { app, session } from "electron";
import { getWindowForWebContents, getAppWebContents } from "../../window/webContentsRegistry.js";
import path from "path";
import { readFileSync } from "node:fs";
import {
  classifyPartition,
  getDaintreeAppCSP,
  getLocalhostDevCSP,
  mergeCspHeaders,
  isDevPreviewPartition,
} from "../../utils/webviewCsp.js";
import { canOpenExternalUrl, openExternalUrl } from "../../utils/openExternal.js";
import { formatDialogOrigin } from "../../../shared/utils/urlUtils.js";
import { isBrowserPartition } from "../../../shared/utils/partitionUtils.js";
import {
  guardRemoteGuestRequests,
  isGuestNavigationAllowed,
  isGuestPopupAllowed,
} from "../../window/webviewSrcGate.js";
import { getWebviewDialogService } from "../../services/WebviewDialogService.js";
import { looksLikeOAuthUrl } from "../../services/OAuthLoopbackService.js";
import { CHANNELS } from "../../ipc/channels.js";
import { claimDictationKey } from "../../ipc/handlers/voiceInput.js";
import { getDistPath } from "./app.js";

/** True for any `daintree-html://…` request URL (the sandboxed preview scheme). */
function isDaintreeHtmlPreviewUrl(url: string | undefined): boolean {
  return typeof url === "string" && url.startsWith("daintree-html://");
}

/** True for any `daintree-pdf://…` request URL (the inline PDF preview scheme). */
function isDaintreePdfPreviewUrl(url: string | undefined): boolean {
  return typeof url === "string" && url.startsWith("daintree-pdf://");
}

// Chromium's built-in PDF viewer component extension (`kPdfExtensionId`). The
// PDFium document installs this origin's `index.html` as a child frame and
// loads its scripts from here, and Electron's webRequest sees all of it.
const PDF_VIEWER_EXTENSION_ORIGIN = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";

function isPdfViewerExtensionUrl(url: string | undefined): boolean {
  return typeof url === "string" && url.startsWith(PDF_VIEWER_EXTENSION_ORIGIN);
}

/**
 * Responses whose headers must survive the session-wide CSP overlay untouched.
 * Each needs the pass-through for its own reason:
 *   daintree-html:// carries a token-scoped CSP and a COEP that the overlay
 *     would replace with the trusted app policy.
 *   daintree-pdf:// carries NEITHER, and must not acquire either: a `sandbox`
 *     CSP blocks PDFium outright (ERR_BLOCKED_BY_CLIENT), and a COEP header
 *     makes the PDF document an embedder whose own internal viewer frame is
 *     then blocked (ERR_BLOCKED_BY_RESPONSE).
 *   The PDF viewer extension ships its own manifest CSP. Stamping the app
 *     policy over it blocks the `chrome://resources` scripts and styles the
 *     viewer boots from, so it never creates its content frame and the preview
 *     stays blank with no error anywhere the user can see (#12598).
 * All verified against Electron 42 / Chromium 148 on a persist: partition.
 */
function shouldPreservePreviewResponseHeaders(url: string | undefined): boolean {
  return (
    isDaintreeHtmlPreviewUrl(url) || isDaintreePdfPreviewUrl(url) || isPdfViewerExtensionUrl(url)
  );
}

// Read the production import-map hash sidecar emitted by the Vite build
// (`hostImportMapPlugin` in vite.config.ts). The hash must reach the
// `Content-Security-Policy` HTTP header layer so it stays aligned with the
// `<meta http-equiv>` value inside the document — the browser intersects the
// two policies, and a divergence silently drops the inline importmap. In dev,
// the sidecar doesn't exist (Vite serves React from the module graph and the
// dev CSP carries `'unsafe-inline'`), so this returns []. Failure to read or
// parse the sidecar in production logs a warning and returns []; without the
// hash the host page still loads, but plugins that externalize React will
// fail to resolve `react` at runtime — visible enough to debug, but not worth
// crashing app startup over a missing build artifact.
function loadHostImportMapHashes(distPath: string | null): string[] {
  if (process.env.NODE_ENV === "development") return [];
  if (!distPath) return [];

  try {
    const sidecarPath = path.join(distPath, "importmap-meta.json");
    const raw = readFileSync(sidecarPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "scriptSrcHashes" in parsed &&
      Array.isArray((parsed as { scriptSrcHashes: unknown }).scriptSrcHashes)
    ) {
      const hashes = (parsed as { scriptSrcHashes: unknown[] }).scriptSrcHashes.filter(
        (h): h is string => typeof h === "string"
      );
      return hashes;
    }
    console.warn("[MAIN] importmap-meta.json is malformed; missing scriptSrcHashes array.");
    return [];
  } catch (err) {
    console.warn("[MAIN] Failed to load importmap-meta.json sidecar:", err);
    return [];
  }
}

/**
 * Apply the strict Daintree app CSP to a dynamically-created trusted session
 * (paint-fabric surface views). Their `paint-surface:*` partitions are
 * deliberately NOT reclassified in classifyPartition: the "unknown" class is
 * what routes them through the session-created permission lockdown in
 * security.ts, and this helper restores the CSP half of the project-view
 * hardening that classification skips.
 */
export function applyDaintreeAppCspToSession(ses: Electron.Session): void {
  const scriptSrcHashes = loadHostImportMapHashes(getDistPath());
  const isDev = process.env.NODE_ENV === "development";
  const cspPolicy =
    scriptSrcHashes.length > 0
      ? getDaintreeAppCSP(isDev, { scriptSrcHashes })
      : getDaintreeAppCSP(isDev);
  ses.webRequest.onHeadersReceived(
    { urls: ["<all_urls>"], types: ["mainFrame", "subFrame", "script"] },
    (details, callback) => {
      if (shouldPreservePreviewResponseHeaders(details.url)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      callback({
        responseHeaders: mergeCspHeaders(details, cspPolicy),
      });
    }
  );
}

export function setupWebviewCSP(): void {
  const configuredPartitions = new Set<string>();
  const scriptSrcHashes = loadHostImportMapHashes(getDistPath());

  const applyCSP = (partition: string): void => {
    if (configuredPartitions.has(partition)) {
      return;
    }

    const partitionType = classifyPartition(partition);
    // Browser panels load arbitrary remote sites — overlaying our CSP would
    // intersect with theirs and break most of the web. Sandbox, deny-all
    // permissions, and navigation guards remain in place.
    if (partitionType === "unknown" || partitionType === "portal" || partitionType === "browser") {
      return;
    }

    const ses = session.fromPartition(partition);
    const isDev = process.env.NODE_ENV === "development";
    const cspPolicy =
      partitionType === "project"
        ? scriptSrcHashes.length > 0
          ? getDaintreeAppCSP(isDev, { scriptSrcHashes })
          : getDaintreeAppCSP(isDev)
        : getLocalhostDevCSP();

    // CSP response headers are only enforced on document and worker
    // main-script responses (workers map to "script" in the webRequest
    // resource-type model), so stylesheet/image/font/xhr/media/ping traffic
    // skips the network-service→main-process detour entirely. `urls` must be
    // explicit: since Electron 41 an empty array matches nothing, and
    // Electron 42 rejects "other" in `types` at registration.
    ses.webRequest.onHeadersReceived(
      { urls: ["<all_urls>"], types: ["mainFrame", "subFrame", "script"] },
      (details, callback) => {
        // Preview documents own their response headers. protocol.handle
        // responses DO flow through onHeadersReceived (Electron 42 /
        // Chromium 148), so without this bypass mergeCspHeaders would replace
        // a daintree-html:// page's token-scoped CSP with the trusted app CSP
        // — breaking its scripts AND re-exposing connect-src daintree-file: —
        // and would stamp that same policy onto a daintree-pdf:// document and
        // onto PDFium's own viewer frame, which then can't boot. Pass all of
        // them through untouched.
        if (shouldPreservePreviewResponseHeaders(details.url)) {
          callback({ responseHeaders: details.responseHeaders });
          return;
        }
        callback({
          responseHeaders: mergeCspHeaders(details, cspPolicy),
        });
      }
    );

    configuredPartitions.add(partition);
  };

  // Configure static partitions:
  // - persist:daintree: trusted Daintree renderer shell (strict app CSP)
  // Browser hosts arbitrary remote sites (skipped by classifyPartition guard above
  // to avoid intersecting with site CSPs), portal/unknown are excluded, and
  // dev-preview partitions are wired dynamically via will-attach-webview below.
  applyCSP("persist:daintree");

  // Browser panel sessions are per-project (persist:browser-*) and created lazily,
  // so navigation handlers below discriminate by the webContents' partition string
  // rather than against a single cached session object.
  const isBrowserPanelContents = (contents: Electron.WebContents): boolean =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Electron typing gap: Session.partition is not exposed
    isBrowserPartition((contents.session as any)?.partition ?? "");

  // Monitor for dynamic dev-preview partitions
  app.on("web-contents-created", (_event, contents) => {
    const notifyBlockedNavigation = (url: string) => {
      const dialogService = getWebviewDialogService();
      const panelId = dialogService.getPanelId(contents.id);
      if (!panelId) return;

      const isDevPreview = !isBrowserPanelContents(contents);
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

    // A guest in a remote-bound view reaches this machine's localhost only
    // through its host's forwards, for every request and not just navigations.
    contents.on("did-attach-webview", (_event, guest) => {
      guardRemoteGuestRequests(contents.id, guest);
    });

    // Route target="_blank" links and window.open() from webview guests to the system browser
    if (contents.getType() === "webview") {
      const embedder = contents.hostWebContents;
      if (embedder) guardRemoteGuestRequests(embedder.id, contents);

      contents.setWindowOpenHandler(({ url }) => {
        // If this is an OAuth URL from a dev-preview webview, route it through
        // the blocked-nav banner so the user can use "Sign in via Browser" (loopback flow).
        // Without this, window.open() OAuth popups bypass the banner and go straight
        // to the system browser, losing the PKCE sessionStorage state.
        const isDevPreview = !isBrowserPanelContents(contents);
        if (url && isDevPreview && looksLikeOAuthUrl(url)) {
          notifyBlockedNavigation(url);
          return { action: "deny" };
        }

        if (url && !isGuestPopupAllowed((contents.hostWebContents ?? contents).id, url)) {
          console.warn(`[MAIN] Blocked a remote view's popup to this machine's localhost: ${url}`);
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
      // Both use the attach gate's host-aware rule, so a guest in a remote-bound
      // view can't reach this machine's localhost except through a forward.
      contents.on("will-navigate", (event, navigationUrl) => {
        const isBrowserPanel = isBrowserPanelContents(contents);

        const blocked = !isGuestNavigationAllowed(
          (contents.hostWebContents ?? contents).id,
          navigationUrl,
          isBrowserPanel
        );

        if (blocked) {
          const label = isBrowserPanel ? "unsafe" : "non-localhost";
          console.warn(`[MAIN] Blocked webview navigation to ${label} URL: ${navigationUrl}`);
          event.preventDefault();
          notifyBlockedNavigation(navigationUrl);
        }
      });

      contents.on("will-redirect", (event, redirectUrl) => {
        const isBrowserPanel = isBrowserPanelContents(contents);

        const blocked = !isGuestNavigationAllowed(
          (contents.hostWebContents ?? contents).id,
          redirectUrl,
          isBrowserPanel
        );

        if (blocked) {
          const label = isBrowserPanel ? "unsafe" : "non-localhost";
          console.warn(`[MAIN] Blocked webview redirect to ${label} URL: ${redirectUrl}`);
          event.preventDefault();
          notifyBlockedNavigation(redirectUrl);
        }
      });

      // Resolve and cache the guest's parent window. On the `destroyed` event the
      // guest's hostWebContents is no longer reachable, so dismiss-on-destroy falls
      // back to the reference captured while the guest was alive — populated when a
      // dialog is first intercepted below (a dialog can only be pending if this ran).
      let cachedParentWindow: Electron.BrowserWindow | null = null;
      const resolveParentWindow = (): Electron.BrowserWindow | null => {
        if (!contents.isDestroyed()) {
          const live = getWindowForWebContents(contents.hostWebContents ?? contents);
          if (live) cachedParentWindow = live;
        }
        return cachedParentWindow && !cachedParentWindow.isDestroyed() ? cachedParentWindow : null;
      };

      // Intercept JavaScript dialogs (alert/confirm/prompt) from webview guests.
      // Electron 40+ emits "js-dialog" but its TS types omit it from the overload union.
      (contents as { on: (event: string, listener: (...args: unknown[]) => void) => void }).on(
        "js-dialog",
        (
          event: unknown,
          url: unknown,
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
          // Chromium hands us the origin of the frame that raised the dialog. It is the
          // only trustworthy attribution available — the address bar reflects the
          // top-level document, which is not necessarily who is speaking. Chromium names
          // its own dialogs the same way ("<origin> says").
          const origin = formatDialogOrigin(typeof url === "string" ? url : null);

          const dialogService = getWebviewDialogService();
          const dialogId = crypto.randomUUID();
          const panelId = dialogService.registerDialog(dialogId, contents.id, cb);

          if (!panelId) {
            cb(type === "alert");
            return;
          }

          const parentWindow = resolveParentWindow();
          if (parentWindow) {
            getAppWebContents(parentWindow).send("webview:dialog-request", {
              dialogId,
              panelId,
              type,
              message: msg,
              defaultValue: defVal,
              origin,
            });
          } else {
            dialogService.resolveDialog(dialogId, type === "alert");
          }
        }
      );

      // Surface render-process hang to the renderer when the guest stops processing
      // input events for >30s. Auto-clears when `responsive` fires.
      const notifyUnresponsive = () => {
        if (contents.isDestroyed()) return;
        const panelId = getWebviewDialogService().getPanelId(contents.id);
        if (!panelId) return;
        const parentWindow = getWindowForWebContents(contents.hostWebContents ?? contents);
        if (parentWindow && !parentWindow.isDestroyed()) {
          getAppWebContents(parentWindow).send(CHANNELS.WEBVIEW_UNRESPONSIVE, { panelId });
        }
      };

      const notifyResponsive = () => {
        if (contents.isDestroyed()) return;
        const panelId = getWebviewDialogService().getPanelId(contents.id);
        if (!panelId) return;
        const parentWindow = getWindowForWebContents(contents.hostWebContents ?? contents);
        if (parentWindow && !parentWindow.isDestroyed()) {
          getAppWebContents(parentWindow).send(CHANNELS.WEBVIEW_RESPONSIVE, { panelId });
        }
      };

      contents.on("unresponsive", notifyUnresponsive);
      contents.on("responsive", notifyResponsive);

      // Dismiss any pending JS dialogs when the guest navigates to a new document,
      // its renderer crashes, or it is destroyed (e.g. the <webview> is remounted on
      // a partition change). Chromium discards the native dialog state in all three
      // cases, so the stored callback would otherwise leak and the renderer overlay
      // would survive a page that no longer exists. did-navigate fires only for
      // cross-document main-frame navigations (same-document hash/pushState changes
      // emit did-navigate-in-page and are correctly ignored). The destroyed path
      // relies on the cached parent window since hostWebContents is gone by then.
      const dismissPendingDialogs = () => {
        const dialogService = getWebviewDialogService();
        const panelId = dialogService.getPanelId(contents.id);
        dialogService.cancelPendingForGuest(contents.id);
        if (!panelId) return;
        const parentWindow = resolveParentWindow();
        if (parentWindow) {
          getAppWebContents(parentWindow).send(CHANNELS.WEBVIEW_DIALOG_DISMISS, { panelId });
        }
      };

      contents.on("did-navigate", dismissPendingDialogs);
      contents.on("render-process-gone", dismissPendingDialogs);
      contents.once("destroyed", dismissPendingDialogs);

      // Intercept find-in-page (Cmd/Ctrl+F, Cmd/Ctrl+G, Escape), reload
      // (Cmd/Ctrl+R), and close (Cmd/Ctrl+W) shortcuts from webview guests.
      // When the guest has focus Chromium routes keystrokes directly to it
      // — bypassing the host webContents' setIgnoreMenuShortcuts guards —
      // so they must be caught and forwarded here.
      contents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown") return;

        if (claimDictationKey(input)) {
          event.preventDefault();
          return;
        }

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

        const isReload = mod && input.key.toLowerCase() === "r" && !input.alt && !input.shift;
        // Match the host-level guard in createWindow.ts: require the
        // platform-correct close modifier and reject the opposite one, so
        // Ctrl+Cmd+W isn't treated as a plain close.
        const isCloseShortcut =
          input.key.toLowerCase() === "w" &&
          ((isMac && input.meta && !input.control) || (!isMac && input.control && !input.meta)) &&
          !input.alt &&
          !input.shift;

        if (!shortcut && !isReload && !isCloseShortcut) return;

        // Always claim the close chord from a webview guest, before any lookup
        // can bail. Unclaimed, it reaches the native role:"close" accelerator
        // and closes the whole window — which is what happens when the guest
        // was replaced (any DOM move of the <webview>) and isn't registered yet
        // (#13634). A swallowed Cmd+W is recoverable; a closed window is not.
        if (isCloseShortcut) event.preventDefault();

        const dialogService = getWebviewDialogService();
        const panelId = dialogService.getPanelId(contents.id);
        if (!panelId) return;

        const findParentWindow = getWindowForWebContents(contents.hostWebContents ?? contents);

        if (isReload) {
          // Only dev-preview guests get Cmd/Ctrl+R reload — claiming the key for
          // other webview kinds (e.g. the browser panel) would swallow it from
          // the guest page, which has no reload handler of its own here.
          if (dialogService.getPanelKind(contents.id) !== "dev-preview") return;
          // preventDefault only when the signal can actually be delivered, so a
          // window teardown race doesn't eat the key with no reload to show for it.
          if (findParentWindow && !findParentWindow.isDestroyed()) {
            event.preventDefault();
            getAppWebContents(findParentWindow).send(CHANNELS.WEBVIEW_RELOAD_SHORTCUT, {
              panelId,
            });
          }
          return;
        }

        if (isCloseShortcut) {
          // Applies to every webview-hosting panel kind (dev-preview, browser)
          // — unlike reload, all of them need Cmd/Ctrl+W to close the panel
          // instead of falling through to the native role:"close" accelerator,
          // which would otherwise close the whole window (#10859).
          if (findParentWindow && !findParentWindow.isDestroyed()) {
            getAppWebContents(findParentWindow).send(CHANNELS.WEBVIEW_CLOSE_SHORTCUT, {
              panelId,
            });
          }
          return;
        }

        if (shortcut !== "close") {
          event.preventDefault();
        }
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
