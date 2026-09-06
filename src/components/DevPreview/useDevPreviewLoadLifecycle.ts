import { useState, useRef, useEffect, useCallback } from "react";
import { usePanelStore } from "@/store";
import { useUrlHistoryStore } from "@/store/urlHistoryStore";
import type { BrowserHistory } from "@shared/types/browser";
import { isDevPreviewPanel } from "@shared/types/panel";
import { DEV_PREVIEW_PROXY_STATUS_TEXT } from "@shared/utils/devPreviewProxy";
import { applyDevPreviewEmulation } from "./viewportEmulation";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
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
  | "proxy_error"
  | "cert"
  | "ssl_protocol"
  | "failed";

export interface WebviewLoadError {
  code: WebviewLoadErrorCode;
  message: string;
  errorCode?: number;
  validatedURL?: string;
}

// Sentence-case headings for the webview load-error overlay.
export function webviewLoadErrorHeading(code: WebviewLoadErrorCode): string {
  switch (code) {
    case "timeout":
      return "Page load timed out";
    case "aborted":
      return "Load cancelled";
    case "connection_refused":
      return "Dev server unreachable";
    case "proxy_error":
      return "Dev server unavailable";
    case "name_not_resolved":
      return "Couldn't resolve address";
    case "internet_disconnected":
      return "No internet connection";
    case "cert":
    case "ssl_protocol":
      return "Certificate error";
    default:
      return "Page load failed";
  }
}

// Chromium net error codes — see net/base/net_error_list.h
const ERR_SSL_PROTOCOL_ERROR = -107;
const ERR_CERT_RANGE_END = -200;
const ERR_CERT_RANGE_START = -299;

interface UseDevPreviewLoadLifecycleParams {
  webviewElement: Electron.WebviewTag | null;
  id: string;
  projectId?: string;
  loadTimeoutMs: number;
  zoomFactor: number;
  evictingRef: React.RefObject<boolean>;
  lastSetUrlRef: React.MutableRefObject<string>;
  setHistory: React.Dispatch<React.SetStateAction<BrowserHistory>>;
  setBlockedNav: React.Dispatch<BlockedNavAction>;
  onRenderProcessGone?: (details: { reason: string; exitCode: number }) => void;
}

interface UseDevPreviewLoadLifecycleResult {
  isWebviewReady: boolean;
  setIsWebviewReady: React.Dispatch<React.SetStateAction<boolean>>;
  isLoading: boolean;
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  webviewLoadError: WebviewLoadError | null;
  setWebviewLoadError: React.Dispatch<React.SetStateAction<WebviewLoadError | null>>;
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
  setHistory,
  setBlockedNav,
  onRenderProcessGone,
}: UseDevPreviewLoadLifecycleParams): UseDevPreviewLoadLifecycleResult {
  const [isWebviewReady, setIsWebviewReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [webviewLoadError, setWebviewLoadError] = useState<WebviewLoadError | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);

  // Read projectId through a ref so a late project-hydration transition
  // (undefined → id) doesn't rebind the webview listeners mid-load and clear
  // the load watchdog timer.
  const projectIdRef = useRef(projectId);

  const loadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const failLoadRetryRef = useRef<NodeJS.Timeout | null>(null);
  const failLoadRetryCountRef = useRef<number>(0);

  // Latched synchronously by handleDidFrameNavigate when a main-frame HTTP 5xx
  // (e.g. the dev-preview proxy's 502 for a down/unregistered upstream) commits.
  // Read in the same event-loop tick by handleDidNavigate and handleDidFinishLoad
  // so a TCP-successful-but-error-page load doesn't clear the error overlay and
  // render the raw text/plain proxy body. A plain ref (not state) is required:
  // the three events fire sequentially within one microtask pump.
  const pendingHttpErrorRef = useRef(false);

  // Companion latch for a failed main-frame navigation. When a main-frame load
  // fails, Chromium commits its own internal error document and replays the whole
  // lifecycle for it — the observed sequence is
  // did-start-loading → did-fail-load → dom-ready → did-finish-load → did-stop-loading
  // — so those trailing events are evidence about the interstitial, not about the
  // requested URL. did-fail-load latches the failure here and, unlike the HTTP
  // latch, it is not consumed on did-finish-load: it describes the document
  // currently committed, so only the next did-start-loading — a genuinely new
  // navigation — clears it (#12296).
  const pendingNetErrorRef = useRef(false);

  // Bounded auto-retry for a proxy 5xx. The dev server can restart in place
  // (e.g. config-change full reload) while Daintree still reports status
  // "running", so the webview never remounts and there's no recovery signal
  // other than re-hitting the stable proxy origin. Reload with exponential
  // backoff until the upstream answers or the cap is reached; after the cap the
  // overlay's manual recovery actions take over. Mirrors the connection-refused
  // retry below.
  const proxyRetryRef = useRef<NodeJS.Timeout | null>(null);
  const proxyRetryCountRef = useRef<number>(0);

  // Mirror the active preset/rotation/DPR into refs so handleDidFinishLoad can
  // re-apply overrides after cross-origin navigation without the load-listener
  // effect depending on these values (which would tear down/rebuild load timers
  // on every change). The refs are kept in sync by the effect just below.
  const terminal = usePanelStore((s) => {
    const p = s.getTerminal(id);
    return p && isDevPreviewPanel(p) ? p : undefined;
  });
  const viewportPresetRef = useRef(terminal?.viewportPreset);
  const viewportRotatedRef = useRef(terminal?.viewportRotated ?? false);
  const viewportDprRef = useRef(terminal?.viewportDpr ?? 1);

  // Sync the latest projectId + viewport overrides into their refs after each
  // commit. Writing refs during render is forbidden by the React Compiler, and
  // these refs are only read from async webview event handlers (recordVisit,
  // page-title-updated, did-finish-load) — which always fire after commit — so
  // the post-commit write is current by the time they run. Keeping them as refs
  // (not effect deps) is the whole point: it stops a late projectId hydration
  // (undefined → id) or a viewport change from rebinding the webview listeners
  // and clearing the in-flight load watchdog timer.
  useEffect(() => {
    projectIdRef.current = projectId;
    viewportPresetRef.current = terminal?.viewportPreset;
    viewportRotatedRef.current = terminal?.viewportRotated ?? false;
    viewportDprRef.current = terminal?.viewportDpr ?? 1;
  });

  const clearLoadTimers = useCallback(() => {
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
    if (proxyRetryRef.current) {
      clearTimeout(proxyRetryRef.current);
      proxyRetryRef.current = null;
    }
    failLoadRetryCountRef.current = 0;
    proxyRetryCountRef.current = 0;
    pendingHttpErrorRef.current = false;
    pendingNetErrorRef.current = false;
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
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      if (failLoadRetryRef.current) {
        clearTimeout(failLoadRetryRef.current);
        failLoadRetryRef.current = null;
      }
      if (proxyRetryRef.current) {
        clearTimeout(proxyRetryRef.current);
        proxyRetryRef.current = null;
      }
      failLoadRetryCountRef.current = 0;
      proxyRetryCountRef.current = 0;
      pendingHttpErrorRef.current = false;
      pendingNetErrorRef.current = false;
      if (reason === "clean-exit") return;
      setWebviewLoadError(null);
      onRenderProcessGone?.({ reason, exitCode });
    };

    const handleDidStartLoading = () => {
      setIsLoading(true);
      setWebviewLoadError(null);
      setReconnectAttempt(0);
      // Fresh navigation: drop any stale error latches. did-frame-navigate and
      // did-fail-load, which fire after this for the same navigation, re-set them
      // if needed.
      pendingHttpErrorRef.current = false;
      pendingNetErrorRef.current = false;
      // Cancel a pending proxy auto-retry — this load supersedes it. The retry
      // count is intentionally preserved so a still-failing upstream keeps
      // walking up the backoff; it resets only on a genuine successful load.
      if (proxyRetryRef.current) {
        clearTimeout(proxyRetryRef.current);
        proxyRetryRef.current = null;
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
      if (failLoadRetryRef.current) {
        clearTimeout(failLoadRetryRef.current);
        failLoadRetryRef.current = null;
      }
      // The connection-refused retry count is deliberately preserved here, exactly
      // like proxyRetryCountRef above: the scheduled retry issues its own loadURL,
      // which fires this handler, so resetting made MAX_RETRIES unreachable and the
      // backoff loop endless (#12296). It resets on a confirmed successful load, on
      // a crash, and when a user-initiated action calls clearRetryState.
      loadTimeoutRef.current = setTimeout(() => {
        loadTimeoutRef.current = null;
        try {
          if (webview.isLoading()) {
            webview.stop();
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
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
    };

    const handleDidFinishLoad = () => {
      setIsLoading(false);
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }

      // A main-frame 5xx (proxy 502) was committed via did-frame-navigate: the
      // network load finished, but the rendered body is the proxy's error page.
      // Keep the overlay (skip the error clear + emulation re-apply) and consume
      // the latch so the next genuine successful load clears the overlay.
      if (pendingHttpErrorRef.current) {
        pendingHttpErrorRef.current = false;
        return;
      }

      // The requested navigation failed: this event belongs to Chromium's error
      // document, so it is not evidence that anything loaded. Keep the overlay and
      // the retry budget intact (#12296).
      if (pendingNetErrorRef.current) {
        return;
      }

      setWebviewLoadError(null);
      setReconnectAttempt(0);
      failLoadRetryCountRef.current = 0;
      proxyRetryCountRef.current = 0;
      if (failLoadRetryRef.current) {
        clearTimeout(failLoadRetryRef.current);
        failLoadRetryRef.current = null;
      }
      if (proxyRetryRef.current) {
        clearTimeout(proxyRetryRef.current);
        proxyRetryRef.current = null;
      }

      // Device emulation does not persist across cross-origin navigation
      // (renderer process swap), so re-apply it here. Without this, navigating
      // within the preview silently drops the emulated viewport. Only re-apply
      // while a preset is active: clearing is driven by the toolbar, and main
      // already restored the guest's own user agent when the preset was
      // cleared, so a redundant clear on every load would be noise.
      const activePreset = viewportPresetRef.current;
      if (activePreset) {
        try {
          safeFireAndForget(
            applyDevPreviewEmulation(
              webview,
              id,
              activePreset,
              viewportRotatedRef.current,
              viewportDprRef.current
            ),
            { context: "Re-applying dev-preview device emulation after navigation" }
          );
        } catch {
          // getWebContentsId() throws on a detached webview.
        }
      }
    };

    const handleDidFailLoad = (e: Electron.DidFailLoadEvent) => {
      // Ignore aborted loads (e.g., navigation interrupted by another navigation)
      if (e.errorCode === -3) return;
      // Ignore subframe failures — they don't affect the main-frame load state
      if (!e.isMainFrame) return;

      // Everything past here either surfaces an error overlay or schedules a retry,
      // and in both cases Chromium is about to commit its error document. Latch the
      // failure so that document's own lifecycle events don't clear it (#12296).
      pendingNetErrorRef.current = true;

      setIsLoading(false);
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

      // Cert/SSL errors: deterministic, no retry. Classify before the
      // connection-refused retry block so cert failures don't enter the
      // exponential-backoff loop. -107 (SSL protocol) checked first so it
      // gets a different message than the cert-validation range (-200..-299).
      const isCertError = e.errorCode <= ERR_CERT_RANGE_END && e.errorCode >= ERR_CERT_RANGE_START;

      if (e.errorCode === ERR_SSL_PROTOCOL_ERROR) {
        if (failLoadRetryRef.current) {
          clearTimeout(failLoadRetryRef.current);
          failLoadRetryRef.current = null;
        }
        failLoadRetryCountRef.current = 0;
        setWebviewLoadError({
          code: "ssl_protocol",
          message: `SSL/TLS handshake failed to ${e.validatedURL || "the server"}. The server may not support HTTPS, or its certificate may be invalid.`,
          errorCode: e.errorCode,
          validatedURL: e.validatedURL || undefined,
        });
        return;
      }

      if (isCertError) {
        if (failLoadRetryRef.current) {
          clearTimeout(failLoadRetryRef.current);
          failLoadRetryRef.current = null;
        }
        failLoadRetryCountRef.current = 0;
        setWebviewLoadError({
          code: "cert",
          message: `The site's certificate couldn't be verified for ${e.validatedURL || "the server"}. If this is a local development server, make sure the local CA is trusted (e.g. run \`mkcert -install\`).`,
          errorCode: e.errorCode,
          validatedURL: e.validatedURL || undefined,
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

      // Catch-all for unhandled error codes (-2 ERR_FAILED, -6 ERR_FILE_NOT_FOUND,
      // -7 ERR_TIMED_OUT, -104 ERR_CONNECTION_FAILED, and any other unexpected codes).
      // Without this branch the webview shows a blank white screen with no error.
      if (failLoadRetryRef.current) {
        clearTimeout(failLoadRetryRef.current);
        failLoadRetryRef.current = null;
      }
      failLoadRetryCountRef.current = 0;
      const desc = e.errorDescription || `Error code ${e.errorCode}`;
      setWebviewLoadError({
        code: "failed",
        message: `Page failed to load: ${desc}.`,
        errorCode: e.errorCode,
        validatedURL: e.validatedURL || undefined,
      });
    };

    const handleDidFrameNavigate = (e: Electron.DidFrameNavigateEvent) => {
      // did-frame-navigate is the only renderer-side <webview> event carrying
      // httpResponseCode. The dev-preview proxy self-generates exactly one status
      // — HTTP 502 — when the upstream dev server is down or unregistered
      // (DevPreviewProxyService.send502); every other response (including an app
      // 500/503/504) is forwarded upstream untouched and must render normally so
      // developers can see their own error pages. Because TCP succeeds for the
      // 502, did-fail-load never fires and did-finish-load would otherwise render
      // the raw text/plain 502 body. Latch a main-frame 502 here and surface the
      // styled overlay; the guards in did-navigate/did-finish-load keep it from
      // being cleared. 4xx (bootstrap 403/405) and other 5xx pass through.
      //
      // The status code alone is ambiguous: the proxy also forwards an upstream
      // 502 untouched, and hiding the app's own error page behind the outage
      // overlay costs the developer the debugging information (#12296). So match
      // the proxy's provenance marker — the custom HTTP/1.1 reason phrase
      // send502 stamps on the responses it generates itself — not the bare status.
      if (!e.isMainFrame) return;
      if (e.httpResponseCode !== 502) return;
      if (e.httpStatusText !== DEV_PREVIEW_PROXY_STATUS_TEXT) return;
      pendingHttpErrorRef.current = true;
      setIsLoading(false);
      setReconnectAttempt(0);
      failLoadRetryCountRef.current = 0;
      if (failLoadRetryRef.current) {
        clearTimeout(failLoadRetryRef.current);
        failLoadRetryRef.current = null;
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }

      // Schedule a bounded auto-retry. proxyRetryCountRef persists across the
      // reload (did-start-loading clears the timer, not the count), so repeated
      // 502 responses walk up the backoff and stop at the cap.
      const PROXY_MAX_RETRIES = 5;
      if (proxyRetryRef.current) {
        clearTimeout(proxyRetryRef.current);
        proxyRetryRef.current = null;
      }
      const attempt = proxyRetryCountRef.current;
      const willRetry = attempt < PROXY_MAX_RETRIES;

      setWebviewLoadError({
        code: "proxy_error",
        message: willRetry
          ? "The dev server isn't responding. It may be restarting — the preview reloads automatically once it's back."
          : "The dev server isn't responding. Restart it or reload the preview to try again.",
        errorCode: e.httpResponseCode,
        validatedURL: e.url || undefined,
      });

      if (willRetry) {
        proxyRetryCountRef.current = attempt + 1;
        const delayMs = Math.min(1000 * 2 ** attempt, 16000);
        proxyRetryRef.current = setTimeout(() => {
          proxyRetryRef.current = null;
          try {
            webview.reload();
          } catch {
            // Webview detached
          }
        }, delayMs);
      }
    };

    const handleDidNavigate = (e: Electron.DidNavigateEvent) => {
      const navigatedUrl = e.url;
      // Suppress about:blank navigations triggered by eviction
      if (navigatedUrl === "about:blank" && evictingRef.current) return;
      setBlockedNav({ type: "DISMISS" });
      // A main-frame 5xx (proxy 502) was just committed via did-frame-navigate, or
      // the navigation failed and this is the error document committing; keep the
      // overlay rather than clearing it for either "successful" load (#12296).
      if (!pendingHttpErrorRef.current && !pendingNetErrorRef.current) {
        setWebviewLoadError(null);
        setReconnectAttempt(0);
        proxyRetryCountRef.current = 0;
        if (proxyRetryRef.current) {
          clearTimeout(proxyRetryRef.current);
          proxyRetryRef.current = null;
        }
        // A confirmed new main-frame navigation means we're past any previous
        // failure; reset the retry budget so stale exhaustion doesn't block future
        // attempts. Gated on the document actually being the requested one — the
        // error document's own commit would otherwise refill the budget forever.
        failLoadRetryCountRef.current = 0;
        if (failLoadRetryRef.current) {
          clearTimeout(failLoadRetryRef.current);
          failLoadRetryRef.current = null;
        }
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
    webview.addEventListener("did-frame-navigate", handleDidFrameNavigate);
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
      webview.removeEventListener("did-frame-navigate", handleDidFrameNavigate);
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
      if (proxyRetryRef.current) {
        clearTimeout(proxyRetryRef.current);
        proxyRetryRef.current = null;
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
      // The watchdog and the blocking "Loading preview" overlay share this one
      // finish boundary. dom-ready is DOMContentLoaded: the document is committed
      // and usable, while did-finish-load/did-stop-loading additionally wait on the
      // window load event — so a single hung image used to clear the only timer
      // guarding an overlay that then stayed up forever (#12296). A hung main
      // document never reaches dom-ready and still hits the timeout.
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      setIsLoading(false);

      const currentPanel = usePanelStore.getState().getTerminal(id);
      const saved =
        currentPanel && isDevPreviewPanel(currentPanel)
          ? currentPanel.devPreviewScrollPosition
          : undefined;
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
        // dom-ready already fired before this listener attached. Run scroll
        // restore here so the position survives tab switches and other
        // re-renders that don't trigger another dom-ready.
        const currentPanel = usePanelStore.getState().getTerminal(id);
        const saved =
          currentPanel && isDevPreviewPanel(currentPanel)
            ? currentPanel.devPreviewScrollPosition
            : undefined;
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
  }, [id, zoomFactor, webviewElement]);

  useEffect(() => {
    return () => {
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
      if (failLoadRetryRef.current) {
        clearTimeout(failLoadRetryRef.current);
      }
      if (proxyRetryRef.current) {
        clearTimeout(proxyRetryRef.current);
      }
    };
  }, []);

  return {
    isWebviewReady,
    setIsWebviewReady,
    isLoading,
    setIsLoading,
    webviewLoadError,
    setWebviewLoadError,
    reconnectAttempt,
    clearLoadTimers,
    clearRetryState,
  };
}
