import { useEffect, useEffectEvent } from "react";
import type { BrowserHistory } from "@shared/types/browser";
import { pushBrowserHistory } from "@/components/Browser/historyUtils";
import { useUrlHistoryStore } from "@/store/urlHistoryStore";

// Threshold after which a load is reported as "Taking longer than usual…"
// Independent of the hard timeout (loadTimeoutMs) which actually aborts.
const SLOW_LOAD_THRESHOLD_MS = 5000;
// Coalesce favicon-updated bursts to avoid thrashing the URL-history store.
const FAVICON_DEBOUNCE_MS = 200;

export type UseWebviewEventsOptions = {
  webviewElement: Electron.WebviewTag | null;
  isInitialRestoredLoadRef: React.MutableRefObject<boolean>;
  lastSetUrlRef: React.MutableRefObject<string>;
  slowLoadTimeoutRef: React.MutableRefObject<NodeJS.Timeout | null>;
  loadTimeoutRef: React.MutableRefObject<NodeJS.Timeout | null>;
  evictingRef: React.RefObject<boolean>;
  projectId: string | undefined;
  loadTimeoutMs: number;
  zoomFactor: number;
  setIsWebviewReady: (v: boolean) => void;
  setIsLoading: (v: boolean) => void;
  setLoadError: (v: string | null) => void;
  setIsSlowLoad: (v: boolean) => void;
  setBlockedNav: (v: { url: string; canOpenExternal: boolean } | null) => void;
  setHistory: React.Dispatch<React.SetStateAction<BrowserHistory>>;
};

/**
 * Owns the BrowserPane <webview> lifecycle event listeners: dom-ready,
 * did-start/stop-loading, did-fail-load, did-navigate(-in-page), and
 * page-title/favicon-updated. Drives the slow-load and hard-timeout timers.
 *
 * Volatile values (`zoomFactor`, `projectId`, `loadTimeoutMs`) are read via
 * `useEffectEvent` so the listener bindings are not re-installed on every
 * change — the effect re-runs only when `webviewElement` itself swaps, which
 * matches the original behavior modulo the spurious `loadError`/`hasValidUrl`
 * deps that were never read inside the effect body.
 */
export function useWebviewEvents({
  webviewElement,
  isInitialRestoredLoadRef,
  lastSetUrlRef,
  slowLoadTimeoutRef,
  loadTimeoutRef,
  evictingRef,
  projectId,
  loadTimeoutMs,
  zoomFactor,
  setIsWebviewReady,
  setIsLoading,
  setLoadError,
  setIsSlowLoad,
  setBlockedNav,
  setHistory,
}: UseWebviewEventsOptions): void {
  const getZoomFactor = useEffectEvent(() => zoomFactor);
  const getProjectId = useEffectEvent(() => projectId);
  const getLoadTimeoutMs = useEffectEvent(() => loadTimeoutMs);

  useEffect(() => {
    const webview = webviewElement;
    if (!webview) {
      setIsWebviewReady(false);
      return;
    }

    const clearAllTimers = () => {
      if (slowLoadTimeoutRef.current) {
        clearTimeout(slowLoadTimeoutRef.current);
        slowLoadTimeoutRef.current = null;
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
    };

    const handleDomReady = () => {
      isInitialRestoredLoadRef.current = false;
      setIsWebviewReady(true);
      clearAllTimers();
    };

    const handleDidStartLoading = () => {
      setIsLoading(true);
      setLoadError(null);
      setIsSlowLoad(false);
      if (slowLoadTimeoutRef.current) {
        clearTimeout(slowLoadTimeoutRef.current);
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
      slowLoadTimeoutRef.current = setTimeout(() => {
        try {
          if (webview.isLoading()) {
            setIsSlowLoad(true);
          }
        } catch {
          // Webview detached before timeout fired
        }
      }, SLOW_LOAD_THRESHOLD_MS);
      const timeoutMs = getLoadTimeoutMs();
      loadTimeoutRef.current = setTimeout(() => {
        loadTimeoutRef.current = null;
        try {
          if (webview.isLoading()) {
            webview.stop();
            setIsSlowLoad(false);
            setIsLoading(false);
            setLoadError(
              `Load timed out after ${Math.round(timeoutMs / 1000)}s. The server at ${webview.getURL()} may be unreachable or slow to respond.`
            );
          }
        } catch {
          // Webview detached before timeout fired
        }
      }, timeoutMs);
    };

    const handleDidStopLoading = () => {
      setIsLoading(false);
      setIsSlowLoad(false);
      if (slowLoadTimeoutRef.current) {
        clearTimeout(slowLoadTimeoutRef.current);
        slowLoadTimeoutRef.current = null;
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
    };

    const handleDidFailLoad = (event: Electron.DidFailLoadEvent) => {
      setIsSlowLoad(false);
      if (slowLoadTimeoutRef.current) {
        clearTimeout(slowLoadTimeoutRef.current);
        slowLoadTimeoutRef.current = null;
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      // Ignore aborted loads (e.g., navigation interrupted by another navigation)
      if (event.errorCode === -3) return;
      // Ignore cancellations
      if (event.errorCode === -6) return;
      setIsLoading(false);
      const ERR_CONNECTION_REFUSED = -102;
      const ERR_NAME_NOT_RESOLVED = -105;
      const ERR_INTERNET_DISCONNECTED = -106;
      const ERR_CONNECTION_TIMED_OUT = -118;
      if (
        event.isMainFrame &&
        event.errorCode === ERR_CONNECTION_REFUSED &&
        isInitialRestoredLoadRef.current
      ) {
        setLoadError(
          "The saved URL is no longer reachable. The server may have moved to a different port."
        );
      } else if (
        event.isMainFrame &&
        event.errorCode === ERR_NAME_NOT_RESOLVED &&
        event.validatedURL
      ) {
        let hostname = event.validatedURL;
        try {
          hostname = new URL(event.validatedURL).hostname;
        } catch {
          // Use raw validatedURL if parsing fails
        }
        setLoadError(`Couldn't resolve ${hostname}. Check the URL or your connection.`);
      } else if (event.isMainFrame && event.errorCode === ERR_INTERNET_DISCONNECTED) {
        setLoadError("No internet connection. Check your network.");
      } else if (
        event.isMainFrame &&
        event.errorCode === ERR_CONNECTION_TIMED_OUT &&
        event.validatedURL
      ) {
        setLoadError(
          `Connection to ${event.validatedURL} timed out. The server may be unreachable.`
        );
      } else if (event.isMainFrame) {
        const urlContext = event.validatedURL ? ` at ${event.validatedURL}` : "";
        setLoadError(
          event.errorDescription
            ? `${event.errorDescription}${urlContext}`
            : `Failed to load page${urlContext}. The site may be unavailable.`
        );
      }
    };

    const handleDidNavigate = (event: Electron.DidNavigateEvent) => {
      const newUrl = event.url;
      // Suppress about:blank navigations triggered by eviction
      if (newUrl === "about:blank" && evictingRef.current) return;
      isInitialRestoredLoadRef.current = false;
      setBlockedNav(null);
      // Only update history if this is a new URL (not our programmatic navigation)
      if (newUrl !== lastSetUrlRef.current) {
        setHistory((prev) => pushBrowserHistory(prev, newUrl));
        lastSetUrlRef.current = newUrl;
      }
      const currentProjectId = getProjectId();
      if (currentProjectId) {
        let title: string | undefined;
        try {
          title = webview.getTitle();
        } catch {
          // webview may not be ready for getTitle
        }
        useUrlHistoryStore.getState().recordVisit(currentProjectId, newUrl, title);
      }
    };

    const handleDidNavigateInPage = (event: Electron.DidNavigateInPageEvent) => {
      if (!event.isMainFrame) return;
      setBlockedNav(null);
      const newUrl = event.url;
      if (newUrl !== lastSetUrlRef.current) {
        setHistory((prev) => pushBrowserHistory(prev, newUrl));
        lastSetUrlRef.current = newUrl;
      }
      const currentProjectId = getProjectId();
      if (currentProjectId) {
        let title: string | undefined;
        try {
          title = webview.getTitle();
        } catch {
          // webview may not be ready for getTitle
        }
        useUrlHistoryStore.getState().recordVisit(currentProjectId, newUrl, title);
      }
    };

    const handlePageTitleUpdated = (event: Event) => {
      const detail = event as Event & { title?: string; explicitSet?: boolean };
      if (detail.explicitSet === false) return;
      const currentProjectId = getProjectId();
      if (currentProjectId && detail.title) {
        try {
          useUrlHistoryStore
            .getState()
            .updateTitle(currentProjectId, webview.getURL(), detail.title);
        } catch {
          // webview may be detached
        }
      }
    };

    // Debounce favicon updates to avoid store thrashing on rapid events
    let faviconDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    const handlePageFaviconUpdated = (event: Event) => {
      const detail = event as Event & { favicons?: string[] };
      const currentProjectId = getProjectId();
      if (!currentProjectId || !detail.favicons?.length) return;
      const favicon = detail.favicons[0]!;
      // Skip oversized data URLs that could exceed localStorage quota
      if (favicon.startsWith("data:") && favicon.length > 8192) return;
      // Capture URL at event time to avoid race with navigation
      let capturedUrl: string;
      try {
        capturedUrl = webview.getURL();
      } catch {
        return;
      }
      if (!capturedUrl || capturedUrl === "about:blank") return;
      if (faviconDebounceTimer) clearTimeout(faviconDebounceTimer);
      const url = capturedUrl;
      faviconDebounceTimer = setTimeout(() => {
        faviconDebounceTimer = null;
        useUrlHistoryStore.getState().updateFavicon(currentProjectId, url, favicon);
      }, FAVICON_DEBOUNCE_MS);
    };

    try {
      const existingUrl = webview.getURL();
      if (existingUrl && existingUrl !== "about:blank" && !webview.isLoading()) {
        setIsWebviewReady(true);
        setIsLoading(false);
        const savedZoom = getZoomFactor();
        if (Number.isFinite(savedZoom)) {
          webview.setZoomFactor(savedZoom);
        }
      }
    } catch {
      // Webview not yet attached to DOM - dom-ready handler will take over
    }

    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-fail-load", handleDidFailLoad);
    webview.addEventListener("did-navigate", handleDidNavigate);
    webview.addEventListener("did-navigate-in-page", handleDidNavigateInPage);
    webview.addEventListener("page-title-updated", handlePageTitleUpdated);
    webview.addEventListener("page-favicon-updated", handlePageFaviconUpdated);

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-fail-load", handleDidFailLoad);
      webview.removeEventListener("did-navigate", handleDidNavigate);
      webview.removeEventListener("did-navigate-in-page", handleDidNavigateInPage);
      webview.removeEventListener("page-title-updated", handlePageTitleUpdated);
      webview.removeEventListener("page-favicon-updated", handlePageFaviconUpdated);
      if (faviconDebounceTimer) {
        clearTimeout(faviconDebounceTimer);
        faviconDebounceTimer = null;
      }
      if (slowLoadTimeoutRef.current) {
        clearTimeout(slowLoadTimeoutRef.current);
        slowLoadTimeoutRef.current = null;
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
    };
  }, [
    webviewElement,
    evictingRef,
    isInitialRestoredLoadRef,
    lastSetUrlRef,
    slowLoadTimeoutRef,
    loadTimeoutRef,
    setIsWebviewReady,
    setIsLoading,
    setLoadError,
    setIsSlowLoad,
    setBlockedNav,
    setHistory,
  ]);
}
