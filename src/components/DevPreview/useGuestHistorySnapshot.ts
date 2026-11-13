import { useEffect, useState } from "react";
import type {
  BrowserNavigationHistoryEntry,
  BrowserNavigationHistorySnapshot,
} from "@shared/types/browser";

/**
 * What the host has asked of the guest's own session history and not yet seen
 * commit. Parent-owned so the navigation handlers can set it and the commit
 * listeners in useDevPreviewLoadLifecycle can consume it.
 */
export interface GuestHistoryIntent {
  /** The step Back, Forward or a history-menu jump asked the guest to take. */
  stepOffset: number | null;
  /**
   * A Back the guest couldn't take itself loaded the saved entry instead, which
   * the guest records as a fresh entry on top of the one Back left. Its commit
   * prunes the guest's history, or the next Back would return there.
   */
  pruneOnCommit: boolean;
}

export function createGuestHistoryIntent(): GuestHistoryIntent {
  return { stepOffset: null, pruneOnCommit: false };
}

/** The guest entry one step away, by Chromium's own index: the menu's entries are sparse. */
function adjacentEntry(
  snapshot: BrowserNavigationHistorySnapshot | null,
  direction: "back" | "forward"
): BrowserNavigationHistoryEntry | null {
  if (!snapshot) return null;
  let nearest: BrowserNavigationHistoryEntry | null = null;
  let nearestDistance = Infinity;
  for (const entry of snapshot.entries) {
    const distance =
      direction === "back"
        ? snapshot.activeIndex - entry.index
        : entry.index - snapshot.activeIndex;
    if (distance > 0 && distance < nearestDistance) {
      nearest = entry;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/**
 * The guest's own session history, for the Back and Forward menus. Refreshed on
 * every commit, title change and finished load, since a same-document
 * navigation never toggles loading. Belongs to the guest it was read from, so a
 * replaced <webview> never shows the previous guest's entries.
 */
export function useGuestHistorySnapshot(
  webviewElement: Electron.WebviewTag | null,
  isWebviewReady: boolean
) {
  const [state, setState] = useState<{
    guest: Electron.WebviewTag;
    snapshot: BrowserNavigationHistorySnapshot;
  } | null>(null);

  useEffect(() => {
    const webview = webviewElement;
    if (!webview || !isWebviewReady) return undefined;

    let disposed = false;
    let scheduled = false;
    let requestSeq = 0;

    const refresh = () => {
      scheduled = false;
      if (disposed) return;
      let webContentsId: number;
      try {
        webContentsId = webview.getWebContentsId();
      } catch {
        return;
      }
      const request = ++requestSeq;
      window.electron.webview.getNavigationHistory(webContentsId).then(
        (snapshot) => {
          if (disposed || request !== requestSeq) return;
          setState({ guest: webview, snapshot });
        },
        () => {
          // Not registered yet, or the guest went away mid-request: the next
          // commit or dom-ready reads it again.
        }
      );
    };

    // A microtask later, so a burst of events reads once and the panel
    // registration sent on the same ready or dom-ready (useWebviewDialog)
    // reaches main first — main answers only for a registered guest.
    const scheduleRefresh = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(refresh);
    };

    const handleInPage = (event: Event) => {
      if ((event as Event & { isMainFrame?: boolean }).isMainFrame === false) return;
      scheduleRefresh();
    };

    scheduleRefresh();
    webview.addEventListener("dom-ready", scheduleRefresh);
    webview.addEventListener("did-navigate", scheduleRefresh);
    webview.addEventListener("did-navigate-in-page", handleInPage);
    webview.addEventListener("did-stop-loading", scheduleRefresh);
    webview.addEventListener("page-title-updated", scheduleRefresh);
    return () => {
      disposed = true;
      webview.removeEventListener("dom-ready", scheduleRefresh);
      webview.removeEventListener("did-navigate", scheduleRefresh);
      webview.removeEventListener("did-navigate-in-page", handleInPage);
      webview.removeEventListener("did-stop-loading", scheduleRefresh);
      webview.removeEventListener("page-title-updated", scheduleRefresh);
    };
  }, [webviewElement, isWebviewReady]);

  const navSnapshot =
    isWebviewReady && webviewElement && state?.guest === webviewElement ? state.snapshot : null;
  return {
    navSnapshot,
    backEntry: adjacentEntry(navSnapshot, "back"),
    forwardEntry: adjacentEntry(navSnapshot, "forward"),
  };
}
