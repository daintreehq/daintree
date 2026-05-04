import { useState, useRef, useEffect, useCallback } from "react";
import { usePanelStore } from "@/store";
import type { BrowserHistory } from "@shared/types/browser";
import type { ViewportPresetId } from "@shared/types/panel";
import { getViewportPreset } from "@/panels/dev-preview/viewportPresets";
import { pushBrowserHistory } from "../Browser/historyUtils";
import { loadWebviewUrl } from "./loadWebviewUrl";

export type SessionStorageEntry = [string, string];

export type DevPreviewBlockedNav = {
  url: string;
  canOpenExternal: boolean;
  sessionStorageSnapshot: SessionStorageEntry[];
};

interface UseDevPreviewLoadLifecycleParams {
  webviewElement: Electron.WebviewTag | null;
  id: string;
  loadTimeoutMs: number;
  zoomFactor: number;
  viewportPreset: ViewportPresetId | undefined;
  evictingRef: React.RefObject<boolean>;
  lastSetUrlRef: React.MutableRefObject<string>;
  originalUaRef: React.MutableRefObject<string | null>;
  setHistory: React.Dispatch<React.SetStateAction<BrowserHistory>>;
  setBlockedNav: React.Dispatch<React.SetStateAction<DevPreviewBlockedNav | null>>;
}

interface UseDevPreviewLoadLifecycleResult {
  isWebviewReady: boolean;
  setIsWebviewReady: React.Dispatch<React.SetStateAction<boolean>>;
  isLoading: boolean;
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  isSlowLoad: boolean;
  setIsSlowLoad: React.Dispatch<React.SetStateAction<boolean>>;
  webviewLoadError: string | null;
  setWebviewLoadError: React.Dispatch<React.SetStateAction<string | null>>;
  clearLoadTimers: () => void;
  clearRetryState: () => void;
}

export function useDevPreviewLoadLifecycle({
  webviewElement,
  id,
  loadTimeoutMs,
  zoomFactor,
  viewportPreset,
  evictingRef,
  lastSetUrlRef,
  originalUaRef,
  setHistory,
  setBlockedNav,
}: UseDevPreviewLoadLifecycleParams): UseDevPreviewLoadLifecycleResult {
  const [isWebviewReady, setIsWebviewReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSlowLoad, setIsSlowLoad] = useState(false);
  const [webviewLoadError, setWebviewLoadError] = useState<string | null>(null);

  const loadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const slowLoadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const failLoadRetryRef = useRef<NodeJS.Timeout | null>(null);
  const failLoadRetryCountRef = useRef<number>(0);

  const clearLoadTimers = useCallback(() => {
    if (slowLoadTimeoutRef.current) {
      clearTimeout(slowLoadTimeoutRef.current);
      slowLoadTimeoutRef.current = null;
    }
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
  }, []);

  const clearRetryState = useCallback(() => {
    if (failLoadRetryRef.current) {
      clearTimeout(failLoadRetryRef.current);
      failLoadRetryRef.current = null;
    }
    failLoadRetryCountRef.current = 0;
  }, []);

  useEffect(() => {
    const webview = webviewElement;
    if (!webview) {
      setIsWebviewReady(false);
      return undefined;
    }

    const handleDidStartLoading = () => {
      setIsLoading(true);
      setWebviewLoadError(null);
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
      }, 5000);
      loadTimeoutRef.current = setTimeout(() => {
        loadTimeoutRef.current = null;
        try {
          if (webview.isLoading()) {
            webview.stop();
            setIsSlowLoad(false);
            setIsLoading(false);
            setWebviewLoadError(
              `Load timed out after ${Math.round(loadTimeoutMs / 1000)}s. The server at ${webview.getURL()} may be unreachable or slow to respond.`
            );
          }
        } catch {
          // Webview detached before timeout fired
        }
      }, loadTimeoutMs);
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

    const handleDidFinishLoad = () => {
      setIsLoading(false);
      setWebviewLoadError(null);
      setIsSlowLoad(false);
      if (slowLoadTimeoutRef.current) {
        clearTimeout(slowLoadTimeoutRef.current);
        slowLoadTimeoutRef.current = null;
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      failLoadRetryCountRef.current = 0;
      if (failLoadRetryRef.current) {
        clearTimeout(failLoadRetryRef.current);
        failLoadRetryRef.current = null;
      }
    };

    const handleDidFailLoad = (e: Electron.DidFailLoadEvent) => {
      // Ignore aborted loads (e.g., navigation interrupted by another navigation)
      if (e.errorCode === -3) return;
      // Ignore cancellations
      if (e.errorCode === -6) return;
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

      const ERR_CONNECTION_REFUSED = -102;
      const ERR_CONNECTION_RESET = -101;
      const ERR_NAME_NOT_RESOLVED = -105;
      const ERR_INTERNET_DISCONNECTED = -106;
      const ERR_CONNECTION_TIMED_OUT = -118;

      // Non-retryable errors: surface directly with friendly messages
      if (e.isMainFrame && e.errorCode === ERR_NAME_NOT_RESOLVED && e.validatedURL) {
        let hostname = e.validatedURL;
        try {
          hostname = new URL(e.validatedURL).hostname;
        } catch {
          // Use raw validatedURL if parsing fails
        }
        setWebviewLoadError(`Couldn't resolve ${hostname}. Check the URL or your connection.`);
        return;
      }
      if (e.isMainFrame && e.errorCode === ERR_INTERNET_DISCONNECTED) {
        setWebviewLoadError("No internet connection. Check your network.");
        return;
      }
      if (e.isMainFrame && e.errorCode === ERR_CONNECTION_TIMED_OUT && e.validatedURL) {
        setWebviewLoadError(
          `Connection to ${e.validatedURL} timed out. The server may be unreachable.`
        );
        return;
      }

      // Retry on connection-refused errors: the readiness check may have passed
      // a moment before the server was fully reachable from the webview.
      if (
        e.isMainFrame &&
        (e.errorCode === ERR_CONNECTION_REFUSED || e.errorCode === ERR_CONNECTION_RESET)
      ) {
        const MAX_RETRIES = 5;
        const retryCount = failLoadRetryCountRef.current;
        if (retryCount >= MAX_RETRIES) {
          const urlContext = e.validatedURL ? ` at ${e.validatedURL}` : "";
          setWebviewLoadError(
            `Unable to connect to dev server${urlContext}. The server may be on a different port.`
          );
        } else if (retryCount < MAX_RETRIES) {
          failLoadRetryCountRef.current += 1;
          // Capture URL at fail-time so the retry loads the same page even if
          // the webview navigates elsewhere during the backoff window.
          const urlToRetry = e.validatedURL || "";
          const delayMs = Math.min(500 * 2 ** retryCount, 8000);
          // Clear any in-flight retry so only one is pending at a time.
          if (failLoadRetryRef.current) {
            clearTimeout(failLoadRetryRef.current);
          }
          failLoadRetryRef.current = setTimeout(() => {
            failLoadRetryRef.current = null;
            try {
              if (urlToRetry && urlToRetry !== "about:blank") {
                loadWebviewUrl(webview, urlToRetry);
              }
            } catch {
              // Webview detached
            }
          }, delayMs);
        }
      }
    };

    const handleDidNavigate = (e: Electron.DidNavigateEvent) => {
      const navigatedUrl = e.url;
      // Suppress about:blank navigations triggered by eviction
      if (navigatedUrl === "about:blank" && evictingRef.current) return;
      setBlockedNav(null);
      setWebviewLoadError(null);
      // A confirmed new main-frame navigation means we're past any previous failure;
      // reset the retry budget so stale exhaustion doesn't block future attempts.
      failLoadRetryCountRef.current = 0;
      if (failLoadRetryRef.current) {
        clearTimeout(failLoadRetryRef.current);
        failLoadRetryRef.current = null;
      }
      if (navigatedUrl !== lastSetUrlRef.current) {
        setHistory((prev) => pushBrowserHistory(prev, navigatedUrl));
        lastSetUrlRef.current = navigatedUrl;
      }
    };

    const handleDidNavigateInPage = (e: Electron.DidNavigateInPageEvent) => {
      if (!e.isMainFrame) return;
      setBlockedNav(null);
      const navigatedUrl = e.url;
      if (navigatedUrl !== lastSetUrlRef.current) {
        setHistory((prev) => pushBrowserHistory(prev, navigatedUrl));
        lastSetUrlRef.current = navigatedUrl;
      }
    };

    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-finish-load", handleDidFinishLoad);
    webview.addEventListener("did-fail-load", handleDidFailLoad as unknown as EventListener);
    webview.addEventListener("did-navigate", handleDidNavigate as unknown as EventListener);
    webview.addEventListener(
      "did-navigate-in-page",
      handleDidNavigateInPage as unknown as EventListener
    );

    return () => {
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-finish-load", handleDidFinishLoad);
      webview.removeEventListener("did-fail-load", handleDidFailLoad as unknown as EventListener);
      webview.removeEventListener("did-navigate", handleDidNavigate as unknown as EventListener);
      webview.removeEventListener(
        "did-navigate-in-page",
        handleDidNavigateInPage as unknown as EventListener
      );
      if (failLoadRetryRef.current) {
        clearTimeout(failLoadRetryRef.current);
        failLoadRetryRef.current = null;
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
  }, [webviewElement, loadTimeoutMs, evictingRef, lastSetUrlRef, setHistory, setBlockedNav]);

  useEffect(() => {
    const webview = webviewElement;
    if (!webview) {
      setIsWebviewReady(false);
      return undefined;
    }

    const handleDomReady = () => {
      setIsWebviewReady(true);
      webview.setZoomFactor(zoomFactor);
      // Capture original UA before any override
      try {
        const wc = (
          webview as unknown as {
            getWebContents(): { setUserAgent(ua: string): void; getUserAgent(): string };
          }
        ).getWebContents();
        if (originalUaRef.current === null) {
          originalUaRef.current = wc.getUserAgent();
        }
        // Apply preset UA if active
        if (viewportPreset) {
          wc.setUserAgent(getViewportPreset(viewportPreset).userAgent);
        }
      } catch {
        // WebContents not available yet
      }
      if (slowLoadTimeoutRef.current) {
        clearTimeout(slowLoadTimeoutRef.current);
        slowLoadTimeoutRef.current = null;
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }

      const saved = usePanelStore.getState().getTerminal(id)?.devPreviewScrollPosition;
      if (saved && Number.isFinite(saved.scrollY) && saved.scrollY > 0 && saved.url) {
        try {
          const loadedUrl = webview.getURL();
          if (loadedUrl === saved.url) {
            webview
              .executeJavaScript(
                `requestAnimationFrame(() => window.scrollTo(0, ${saved.scrollY}))`
              )
              .catch(() => {});
          }
        } catch {
          // Webview not ready
        }
      }
    };

    try {
      const existingUrl = webview.getURL();
      if (existingUrl && existingUrl !== "about:blank" && !webview.isLoading()) {
        setIsWebviewReady(true);
        webview.setZoomFactor(zoomFactor);
        try {
          const wc = (
            webview as unknown as {
              getWebContents(): { setUserAgent(ua: string): void; getUserAgent(): string };
            }
          ).getWebContents();
          if (originalUaRef.current === null) {
            originalUaRef.current = wc.getUserAgent();
          }
          if (viewportPreset) {
            wc.setUserAgent(getViewportPreset(viewportPreset).userAgent);
          }
        } catch {
          // WebContents not available
        }
        // dom-ready already fired before this listener attached. Run scroll
        // restore here so the position survives tab switches and other
        // re-renders that don't trigger another dom-ready.
        const saved = usePanelStore.getState().getTerminal(id)?.devPreviewScrollPosition;
        if (saved && Number.isFinite(saved.scrollY) && saved.scrollY > 0 && saved.url) {
          if (existingUrl === saved.url) {
            webview
              .executeJavaScript(
                `requestAnimationFrame(() => window.scrollTo(0, ${saved.scrollY}))`
              )
              .catch(() => {});
          }
        }
      }
    } catch {
      // Webview not yet attached to DOM - dom-ready handler will take over
    }

    webview.addEventListener("dom-ready", handleDomReady);
    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
    };
  }, [id, zoomFactor, webviewElement, viewportPreset, originalUaRef]);

  useEffect(() => {
    return () => {
      if (slowLoadTimeoutRef.current) {
        clearTimeout(slowLoadTimeoutRef.current);
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
      if (failLoadRetryRef.current) {
        clearTimeout(failLoadRetryRef.current);
      }
    };
  }, []);

  return {
    isWebviewReady,
    setIsWebviewReady,
    isLoading,
    setIsLoading,
    isSlowLoad,
    setIsSlowLoad,
    webviewLoadError,
    setWebviewLoadError,
    clearLoadTimers,
    clearRetryState,
  };
}
