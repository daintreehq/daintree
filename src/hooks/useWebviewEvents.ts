import { useEffect, useEffectEvent } from "react";
import type { BrowserHistory } from "@shared/types/browser";
import { pushBrowserHistory } from "@/components/Browser/historyUtils";
import type { LoadError } from "@/components/Browser/browserUtils";
import { useUrlHistoryStore } from "@/store/urlHistoryStore";

// Threshold after which a load is reported as "Taking longer than usual…"
// Independent of the hard timeout (loadTimeoutMs) which actually aborts.
const SLOW_LOAD_THRESHOLD_MS = 5000;
// Coalesce favicon-updated bursts to avoid thrashing the URL-history store.
const FAVICON_DEBOUNCE_MS = 200;

// Chromium net error codes — see net/base/net_error_list.h
const ERR_ABORTED = -3;
const ERR_SSL_PROTOCOL_ERROR = -107;
const ERR_CERT_RANGE_END = -200;
const ERR_CERT_RANGE_START = -299;
const ERR_CONNECTION_REFUSED = -102;
const ERR_NAME_NOT_RESOLVED = -105;
const ERR_INTERNET_DISCONNECTED = -106;
const ERR_CONNECTION_TIMED_OUT = -118;

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
  setLoadError: (v: LoadError | null) => void;
  setIsSlowLoad: (v: boolean) => void;
  /**
   * Navigation events only ever *clear* the blocked-navigation notice — the
   * notice itself is created by the onNavigationBlocked listener. Typing the
   * parameter as `null` keeps this hook decoupled from the notice's shape
   * (which carries retry/error state since #11114) while staying assignable
   * from the owning `useState` setter.
   */
  setBlockedNav: (v: null) => void;
  setHistory: React.Dispatch<React.SetStateAction<BrowserHistory>>;
  onRenderProcessGone?: (details: { reason: string; exitCode: number }) => void;
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
  onRenderProcessGone,
}: UseWebviewEventsOptions): void {
  const getZoomFactor = useEffectEvent(() => zoomFactor);
  const getProjectId = useEffectEvent(() => projectId);
  const getLoadTimeoutMs = useEffectEvent(() => loadTimeoutMs);
  // Route render-process-gone through useEffectEvent so the lifecycle effect
  // doesn't rebind listeners when the callback identity changes — listeners
  // are torn down/rebuilt only when the webview element itself swaps.
  const fireRenderProcessGone = useEffectEvent((details: { reason: string; exitCode: number }) => {
    onRenderProcessGone?.(details);
  });

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
            setLoadError({
              kind: "timeout",
              message: `Load timed out after ${Math.round(timeoutMs / 1000)}s. The server at ${webview.getURL()} may be unreachable or slow to respond.`,
            });
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
      // Both early returns must precede the timer-clear block: a sub-frame
      // failure (ad pixel, tracker) or a stale ERR_ABORTED from a superseded
      // navigation must not disarm the active main-frame load timers.
      if (event.errorCode === ERR_ABORTED) return;
      if (!event.isMainFrame) return;
      setIsSlowLoad(false);
      if (slowLoadTimeoutRef.current) {
        clearTimeout(slowLoadTimeoutRef.current);
        slowLoadTimeoutRef.current = null;
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      setIsLoading(false);
      const errorCode = event.errorCode;
      const isCertError = errorCode <= ERR_CERT_RANGE_END && errorCode >= ERR_CERT_RANGE_START;
      if (errorCode === ERR_CONNECTION_REFUSED && isInitialRestoredLoadRef.current) {
        setLoadError({
          kind: "network",
          message:
            "The saved URL is no longer reachable. The server may have moved to a different port.",
        });
      } else if (errorCode === ERR_NAME_NOT_RESOLVED && event.validatedURL) {
        let hostname = event.validatedURL;
        try {
          hostname = new URL(event.validatedURL).hostname;
        } catch {
          // Use raw validatedURL if parsing fails
        }
        setLoadError({
          kind: "network",
          message: `Couldn't resolve ${hostname}. Check the URL or your connection.`,
        });
      } else if (errorCode === ERR_INTERNET_DISCONNECTED) {
        setLoadError({
          kind: "network",
          message: "No internet connection. Check your network.",
        });
      } else if (errorCode === ERR_CONNECTION_TIMED_OUT) {
        const target = event.validatedURL ? ` to ${event.validatedURL}` : "";
        setLoadError({
          kind: "network",
          message: `Connection${target} timed out. The server may be unreachable.`,
        });
      } else if (errorCode === ERR_SSL_PROTOCOL_ERROR) {
        // -107 also fires on protocol mismatch (HTTP server reached over HTTPS),
        // so the cert/CA trust hint isn't always the right advice.
        const hostContext = event.validatedURL ? ` to ${event.validatedURL}` : "";
        setLoadError({
          kind: "cert",
          message: `SSL/TLS handshake failed${hostContext}. The server may not support HTTPS, or its certificate may be invalid.`,
        });
      } else if (isCertError) {
        const hostContext = event.validatedURL ? ` for ${event.validatedURL}` : "";
        setLoadError({
          kind: "cert",
          message: `The site's certificate couldn't be verified${hostContext}. If this is a local development server, make sure the local CA is trusted (e.g. run \`mkcert -install\`).`,
        });
      } else {
        const urlContext = event.validatedURL ? ` at ${event.validatedURL}` : "";
        setLoadError({
          kind: "generic",
          message: event.errorDescription
            ? `${event.errorDescription}${urlContext}`
            : `Failed to load page${urlContext}. The site may be unavailable.`,
        });
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

    const handleRenderProcessGone = (event: Event) => {
      const details = (event as Event & { details?: { reason: string; exitCode: number } }).details;
      if (!details) return;
      // `clean-exit` (exit code 0) is intentional renderer shutdown — never
      // a crash. `memory-eviction` is filtered ONLY when Daintree itself
      // triggered the eviction: the about:blank src swap in useWebviewEviction
      // sets evictingRef and causes Chromium to report memory-eviction. When
      // the OS kills the renderer under system memory pressure with no
      // Daintree eviction in flight, the panel goes blank with no other UI
      // signal — surface the crash banner. #9212.
      if (details.reason === "clean-exit") return;
      if (evictingRef.current) return;
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
      fireRenderProcessGone(details);
    };

    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-fail-load", handleDidFailLoad);
    webview.addEventListener("did-navigate", handleDidNavigate);
    webview.addEventListener("did-navigate-in-page", handleDidNavigateInPage);
    webview.addEventListener("page-title-updated", handlePageTitleUpdated);
    webview.addEventListener("page-favicon-updated", handlePageFaviconUpdated);
    webview.addEventListener("render-process-gone", handleRenderProcessGone);

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-fail-load", handleDidFailLoad);
      webview.removeEventListener("did-navigate", handleDidNavigate);
      webview.removeEventListener("did-navigate-in-page", handleDidNavigateInPage);
      webview.removeEventListener("page-title-updated", handlePageTitleUpdated);
      webview.removeEventListener("page-favicon-updated", handlePageFaviconUpdated);
      webview.removeEventListener("render-process-gone", handleRenderProcessGone);
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
