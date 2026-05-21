import { useState, useRef, useEffect, useCallback } from "react";
import { usePanelStore } from "@/store";
import { useUrlHistoryStore } from "@/store/urlHistoryStore";
import type { BrowserHistory } from "@shared/types/browser";
import { getViewportPreset } from "@/panels/dev-preview/viewportPresets";
import { getDevPreviewWebContents, buildEmulationParams } from "./viewportEmulation";
import { pushBrowserHistory } from "../Browser/historyUtils";
import { loadWebviewUrl } from "./loadWebviewUrl";
import type { BlockedNavAction } from "./BlockedNavBanner";

export type SessionStorageEntry = [string, string];

export type DevPreviewBlockedNav = {
  url: string;
  canOpenExternal: boolean;
  sessionStorageSnapshot: SessionStorageEntry[];
};

export type WebviewLoadErrorCode =
  | "aborted"
  | "timeout"
  | "name_not_resolved"
  | "internet_disconnected"
  | "connection_refused"
  | "failed";

export interface WebviewLoadError {
  code: WebviewLoadErrorCode;
  message: string;
  errorCode?: number;
  validatedURL?: string;
}

interface UseDevPreviewLoadLifecycleParams {
  webviewElement: Electron.WebviewTag | null;
  id: string;
  projectId?: string;
  loadTimeoutMs: number;
  zoomFactor: number;
  evictingRef: React.RefObject<boolean>;
  lastSetUrlRef: React.MutableRefObject<string>;
  originalUaRef: React.MutableRefObject<string | null>;
  setHistory: React.Dispatch<React.SetStateAction<BrowserHistory>>;
  setBlockedNav: React.Dispatch<BlockedNavAction>;
  onRenderProcessGone?: (details: { reason: string; exitCode: number }) => void;
}

export interface WebviewCrashInfo {
  reason: string;
  exitCode: number;
}

interface UseDevPreviewLoadLifecycleResult {
  isWebviewReady: boolean;
  setIsWebviewReady: React.Dispatch<React.SetStateAction<boolean>>;
  isLoading: boolean;
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  isSlowLoad: boolean;
  setIsSlowLoad: React.Dispatch<React.SetStateAction<boolean>>;
  webviewLoadError: WebviewLoadError | null;
  setWebviewLoadError: React.Dispatch<React.SetStateAction<WebviewLoadError | null>>;
  webviewCrashed: WebviewCrashInfo | null;
  setWebviewCrashed: React.Dispatch<React.SetStateAction<WebviewCrashInfo | null>>;
  reconnectAttempt: number;
  clearLoadTimers: () => void;
  clearRetryState: () => void;
}

export function useDevPreviewLoadLifecycle({
  webviewElement,
  id,
  projectId,
  loadTimeoutMs,
  zoomFactor,
  evictingRef,
  lastSetUrlRef,
  originalUaRef,
  setHistory,
  setBlockedNav,
  onRenderProcessGone,
}: UseDevPreviewLoadLifecycleParams): UseDevPreviewLoadLifecycleResult {
  const [isWebviewReady, setIsWebviewReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSlowLoad, setIsSlowLoad] = useState(false);
  const [webviewLoadError, setWebviewLoadError] = useState<WebviewLoadError | null>(null);
  const [webviewCrashed, setWebviewCrashed] = useState<WebviewCrashInfo | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);

  // Read projectId through a ref so a late project-hydration transition
  // (undefined → id) doesn't rebind the webview listeners mid-load and clear
  // the load watchdog timer.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const loadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const slowLoadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const failLoadRetryRef = useRef<NodeJS.Timeout | null>(null);
  const failLoadRetryCountRef = useRef<number>(0);

  // Mirror the active preset/rotation/DPR into refs so handleDidFinishLoad can
  // re-apply overrides after cross-origin navigation without the load-listener
  // effect depending on these values (which would tear down/rebuild load timers
  // on every change). Updated on each render from the terminal store selector.
  const terminal = usePanelStore((s) => s.getTerminal(id));
  const viewportPresetRef = useRef(terminal?.viewportPreset);
  viewportPresetRef.current = terminal?.viewportPreset;
  const viewportRotatedRef = useRef(terminal?.viewportRotated ?? false);
  viewportRotatedRef.current = terminal?.viewportRotated ?? false;
  const viewportDprRef = useRef(terminal?.viewportDpr ?? 1);
  viewportDprRef.current = terminal?.viewportDpr ?? 1;

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
    setReconnectAttempt(0);
  }, []);

  useEffect(() => {
    const webview = webviewElement;
    if (!webview) {
      setIsWebviewReady(false);
      return undefined;
    }

    const recordVisit = (navigatedUrl: string) => {
      const currentProjectId = projectIdRef.current;
      if (!currentProjectId) return;
      if (navigatedUrl === "about:blank") return;
      let title: string | undefined;
      try {
        title = webview.getTitle();
      } catch {
        // webview may not be ready for getTitle
      }
      useUrlHistoryStore.getState().recordVisit(currentProjectId, navigatedUrl, title);
    };

    const handlePageTitleUpdated = (event: Event) => {
      const detail = event as Event & { title?: string; explicitSet?: boolean };
      if (detail.explicitSet === false) return;
      const currentProjectId = projectIdRef.current;
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

    const handleRenderProcessGone = (e: Electron.RenderProcessGoneEvent) => {
      const { reason, exitCode } = e.details;
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
      if (failLoadRetryRef.current) {
        clearTimeout(failLoadRetryRef.current);
        failLoadRetryRef.current = null;
      }
      failLoadRetryCountRef.current = 0;
      setWebviewCrashed({ reason, exitCode });
      setWebviewLoadError(null);
    };

    const handleDidStartLoading = () => {
      setIsLoading(true);
      setWebviewLoadError(null);
      setWebviewCrashed(null);
      setReconnectAttempt(0);
      setIsSlowLoad(false);
      if (slowLoadTimeoutRef.current) {
        clearTimeout(slowLoadTimeoutRef.current);
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
      if (failLoadRetryRef.current) {
        clearTimeout(failLoadRetryRef.current);
        failLoadRetryRef.current = null;
      }
      failLoadRetryCountRef.current = 0;
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
            setWebviewLoadError({
              code: "timeout",
              message: `Load timed out after ${Math.round(loadTimeoutMs / 1000)}s. The server at ${webview.getURL()} may be unreachable or slow to respond.`,
            });
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
      setWebviewCrashed(null);
      setReconnectAttempt(0);
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

      // Device emulation and the UA override do NOT persist across
      // cross-origin navigation (renderer process swap), so re-apply both
      // here. Without this, navigating within the preview silently drops
      // the emulated viewport and the spoofed user agent.
      const activePreset = viewportPresetRef.current;
      const activeRotated = viewportRotatedRef.current;
      const activeDpr = viewportDprRef.current;
      try {
        const wc = getDevPreviewWebContents(webview);
        if (wc) {
          if (originalUaRef.current === null) {
            originalUaRef.current = wc.getUserAgent();
          }
          if (activePreset) {
            wc.setUserAgent(getViewportPreset(activePreset).userAgent);
            const params = buildEmulationParams(activePreset, activeRotated, activeDpr);
            if (params) {
              wc.enableDeviceEmulation(params);
            }
          } else if (originalUaRef.current !== null) {
            wc.setUserAgent(originalUaRef.current);
            try {
              wc.disableDeviceEmulation();
            } catch {
              // disableDeviceEmulation may throw if emulation was never enabled
            }
          }
        }
      } catch {
        // WebContents not available (webview detached)
      }
    };

    const handleDidFailLoad = (e: Electron.DidFailLoadEvent) => {
      // Ignore aborted loads (e.g., navigation interrupted by another navigation)
      if (e.errorCode === -3) return;
      // Ignore cancellations
      if (e.errorCode === -6) return;
      // Ignore subframe failures — they don't affect the main-frame load state
      if (!e.isMainFrame) return;

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
      if (e.errorCode === ERR_NAME_NOT_RESOLVED && e.validatedURL) {
        let hostname = e.validatedURL;
        try {
          hostname = new URL(e.validatedURL).hostname;
        } catch {
          // Use raw validatedURL if parsing fails
        }
        setWebviewLoadError({
          code: "name_not_resolved",
          message: `Couldn't resolve ${hostname}. Check the URL or your connection.`,
          validatedURL: e.validatedURL,
        });
        return;
      }
      if (e.errorCode === ERR_INTERNET_DISCONNECTED) {
        setWebviewLoadError({
          code: "internet_disconnected",
          message: "No internet connection. Check your network.",
        });
        return;
      }
      if (e.errorCode === ERR_CONNECTION_TIMED_OUT && e.validatedURL) {
        setWebviewLoadError({
          code: "timeout",
          message: `Connection to ${e.validatedURL} timed out. The server may be unreachable.`,
          errorCode: ERR_CONNECTION_TIMED_OUT,
        });
        return;
      }

      // Retry on connection-refused errors: the readiness check may have passed
      // a moment before the server was fully reachable from the webview.
      if (e.errorCode === ERR_CONNECTION_REFUSED || e.errorCode === ERR_CONNECTION_RESET) {
        const MAX_RETRIES = 5;
        const retryCount = failLoadRetryCountRef.current;
        if (retryCount >= MAX_RETRIES) {
          setReconnectAttempt(0);
          setWebviewLoadError({
            code: "connection_refused",
            message: `Unable to connect to dev server${e.validatedURL ? ` at ${e.validatedURL}` : ""}. The server may be on a different port.`,
            validatedURL: e.validatedURL || undefined,
          });
          return;
        }
        if (retryCount < MAX_RETRIES) {
          failLoadRetryCountRef.current += 1;
          setReconnectAttempt(retryCount + 1);
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
          return;
        }
      }

      // Catch-all for unhandled error codes (-2 ERR_FAILED, -7 ERR_TIMED_OUT,
      // -104 ERR_CONNECTION_FAILED, and any other unexpected codes).
      // Without this branch the webview shows a blank white screen with no error.
      const desc = e.errorDescription || `Error code ${e.errorCode}`;
      setWebviewLoadError({
        code: "failed",
        message: `Page failed to load: ${desc}.`,
        errorCode: e.errorCode,
        validatedURL: e.validatedURL || undefined,
      });
    };

    const handleDidNavigate = (e: Electron.DidNavigateEvent) => {
      const navigatedUrl = e.url;
      // Suppress about:blank navigations triggered by eviction
      if (navigatedUrl === "about:blank" && evictingRef.current) return;
      setBlockedNav({ type: "DISMISS" });
      setWebviewLoadError(null);
      setReconnectAttempt(0);
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
      recordVisit(navigatedUrl);
    };

    const handleDidNavigateInPage = (e: Electron.DidNavigateInPageEvent) => {
      if (!e.isMainFrame) return;
      setBlockedNav({ type: "DISMISS" });
      const navigatedUrl = e.url;
      if (navigatedUrl !== lastSetUrlRef.current) {
        setHistory((prev) => pushBrowserHistory(prev, navigatedUrl));
        lastSetUrlRef.current = navigatedUrl;
      }
      recordVisit(navigatedUrl);
    };

    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-finish-load", handleDidFinishLoad);
    webview.addEventListener("did-fail-load", handleDidFailLoad as unknown as EventListener);
    webview.addEventListener(
      "render-process-gone",
      handleRenderProcessGone as unknown as EventListener
    );
    webview.addEventListener("did-navigate", handleDidNavigate as unknown as EventListener);
    webview.addEventListener(
      "did-navigate-in-page",
      handleDidNavigateInPage as unknown as EventListener
    );
    webview.addEventListener("page-title-updated", handlePageTitleUpdated);

    return () => {
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-finish-load", handleDidFinishLoad);
      webview.removeEventListener("did-fail-load", handleDidFailLoad as unknown as EventListener);
      webview.removeEventListener(
        "render-process-gone",
        handleRenderProcessGone as unknown as EventListener
      );
      webview.removeEventListener("did-navigate", handleDidNavigate as unknown as EventListener);
      webview.removeEventListener(
        "did-navigate-in-page",
        handleDidNavigateInPage as unknown as EventListener
      );
      webview.removeEventListener("page-title-updated", handlePageTitleUpdated);
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
  }, [
    webviewElement,
    loadTimeoutMs,
    evictingRef,
    lastSetUrlRef,
    setHistory,
    setBlockedNav,
    id,
    originalUaRef,
    onRenderProcessGone,
  ]);

  useEffect(() => {
    const webview = webviewElement;
    if (!webview) {
      setIsWebviewReady(false);
      return undefined;
    }

    const handleDomReady = () => {
      setIsWebviewReady(true);
      webview.setZoomFactor(zoomFactor);
      try {
        const wc = getDevPreviewWebContents(webview);
        if (wc && originalUaRef.current === null) {
          originalUaRef.current = wc.getUserAgent();
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
          const wc = getDevPreviewWebContents(webview);
          if (wc && originalUaRef.current === null) {
            originalUaRef.current = wc.getUserAgent();
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
  }, [id, zoomFactor, webviewElement, originalUaRef]);

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
    webviewCrashed,
    setWebviewCrashed,
    reconnectAttempt,
    clearLoadTimers,
    clearRetryState,
  };
}
