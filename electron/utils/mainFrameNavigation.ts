import type { WebContents } from "electron";

function isDocumentNavigation(details: { isMainFrame: boolean; isSameDocument: boolean }): boolean {
  return details.isMainFrame && !details.isSameDocument;
}

/**
 * Runs `listener` whenever `webContents` starts a cross-document navigation of
 * its main frame: a load or reload that may replace the page, and with it
 * everything its renderer had set up.
 *
 * Not `did-start-loading`, which fires for any frame in the tree: a `<webview>`
 * attaching or an iframe loading inside a page that has already painted reads
 * as the page itself reloading.
 */
export function onMainFrameNavigationStart(webContents: WebContents, listener: () => void): void {
  webContents.on("did-start-navigation", (details) => {
    if (isDocumentNavigation(details)) listener();
  });
}

export interface MainFrameDocumentCallbacks {
  /** A main-frame navigation started: the document may be about to go. */
  onLeaving: () => void;
  /** The document was replaced (a page or an error page committed), or its renderer died. */
  onReplaced: () => void;
  /** Loading stopped: any navigation started since `onLeaving` without a replacement never committed. */
  onSettled: () => void;
}

/**
 * Follows whether the main-frame document of `webContents` survives a
 * navigation. In Electron 42 a navigation that never commits — one the app's
 * `will-navigate` guard cancels (a file dropped on the window, a stray link), a
 * download, a 204 — emits nothing when it ends; `did-fail-provisional-load` is
 * only emitted for an error page that did commit. What every navigation does
 * end with is the WebContents' `did-stop-loading`: Chromium starts loading when
 * it takes the navigation request, before `will-navigate` runs, and stops it
 * when the request is reset. A commit always lands before that stop.
 */
export function watchMainFrameDocument(
  webContents: WebContents,
  callbacks: MainFrameDocumentCallbacks
): void {
  webContents.on("did-start-navigation", (details) => {
    if (isDocumentNavigation(details)) callbacks.onLeaving();
  });
  webContents.on("did-navigate", () => callbacks.onReplaced());
  webContents.on(
    "did-fail-provisional-load",
    (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame) callbacks.onReplaced();
    }
  );
  webContents.on("render-process-gone", () => callbacks.onReplaced());
  webContents.on("did-stop-loading", () => callbacks.onSettled());
}
