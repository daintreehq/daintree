import { useCallback, useEffect, useRef, useState } from "react";
import { useBrowserActionListeners } from "@/hooks/useBrowserActionListeners";
import type { BrowserHistory } from "@shared/types/browser";
import { normalizeBrowserUrl } from "../Browser/browserUtils";
import {
  goBackBrowserHistory,
  goForwardBrowserHistory,
  pushBrowserHistory,
} from "../Browser/historyUtils";
import { computeDevServerUrl } from "./urlSync";
import { loadWebviewUrl } from "./loadWebviewUrl";
import { actionService } from "@/services/ActionService";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import type { WebviewLoadError } from "./useDevPreviewLoadLifecycle";

interface UseDevPreviewNavigationParams {
  id: string;
  currentProjectId?: string;
  currentUrl: string;
  canGoBack: boolean;
  canGoForward: boolean;
  history: BrowserHistory;
  setHistory: React.Dispatch<React.SetStateAction<BrowserHistory>>;
  zoomFactor: number;
  setZoomFactor: React.Dispatch<React.SetStateAction<number>>;
  devServerUrl: string | null;
  proxyOrigin: string | null | undefined;
  isUnconfigured: boolean;
  isWebviewReady: boolean;
  webviewRef: React.RefObject<Electron.WebviewTag | null>;
  setBrowserUrl: (id: string, url: string) => void;
  setBrowserHistory: (id: string, history: BrowserHistory) => void;
  setBrowserZoom: (id: string, zoom: number) => void;
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setWebviewLoadError: React.Dispatch<React.SetStateAction<WebviewLoadError | null>>;
  clearLoadTimers: () => void;
  clearRetryState: () => void;
  isConsoleOpen: boolean;
  setDevPreviewConsoleOpen: (id: string, open: boolean) => void;
  onHardReload: () => void;
}

/**
 * Owns the toolbar/navigation action handlers (back/forward/reload/zoom/
 * screenshot/devtools/console/open-external/promote-to-portal), the
 * browser-action-listener wiring, the guest reload/close keyboard-shortcut
 * forwarding, and the URL/history/zoom persistence effects. `history`,
 * `currentUrl`, and the webview ref stay parent-owned — they're shared with
 * useDevPreviewLoadLifecycle (called earlier, needs `setHistory` as an
 * input) and useDevPreviewCrashRecovery, so ownership can't move here
 * without breaking that ordering.
 */
export function useDevPreviewNavigation({
  id,
  currentProjectId,
  currentUrl,
  canGoBack,
  canGoForward,
  history,
  setHistory,
  zoomFactor,
  setZoomFactor,
  devServerUrl,
  proxyOrigin,
  isUnconfigured,
  isWebviewReady,
  webviewRef,
  setBrowserUrl,
  setBrowserHistory,
  setBrowserZoom,
  setIsLoading,
  setWebviewLoadError,
  clearLoadTimers,
  clearRetryState,
  isConsoleOpen,
  setDevPreviewConsoleOpen,
  onHardReload,
}: UseDevPreviewNavigationParams) {
  const screenshotInFlightRef = useRef(false);
  const isPromotingRef = useRef(false);
  // dispatch() resolves an ActionDispatchResult and never rejects, so the old
  // .finally() reset dropped promotion failures on the floor (#11114). The
  // error is surfaced by DevPreviewPane, which owns this hook's JSX.
  const [promoteToPortalError, setPromoteToPortalError] = useState<string | null>(null);
  const [isPromotingToPortal, setIsPromotingToPortal] = useState(false);
  const promoteAttemptRef = useRef(0);

  const clearPromoteToPortalError = useCallback(() => setPromoteToPortalError(null), []);

  // A result that lands after the pane changed identity or project belongs to
  // the previous context: drop it rather than surface it against the new one.
  useEffect(() => {
    promoteAttemptRef.current += 1;
    setPromoteToPortalError(null);
    setIsPromotingToPortal(false);
    isPromotingRef.current = false;
  }, [id, currentProjectId]);

  // Push history only; the imperative navigation effect (keyed on currentUrl
  // vs lastSetUrlRef) performs the actual loadURL. Pre-setting lastSetUrlRef
  // here would make that effect skip — which used to be fine when `src`
  // re-bound to currentUrl, but src is now seed-only (#9940).
  useEffect(() => {
    if (isUnconfigured) return;
    // Hold navigation until the proxy port resolution settles, otherwise the pane would
    // briefly adopt the unstable direct-localhost origin before the proxy origin is known (#9100).
    if (proxyOrigin === undefined) return;
    const nextUrl = devServerUrl
      ? computeDevServerUrl(devServerUrl, currentUrl, proxyOrigin)
      : false;
    if (nextUrl !== false) {
      setHistory((prev) => pushBrowserHistory(prev, nextUrl));
    }
  }, [devServerUrl, currentUrl, isUnconfigured, proxyOrigin, setHistory]);

  useEffect(() => {
    if (isUnconfigured) return;
    if (currentUrl) {
      setBrowserUrl(id, currentUrl);
    }
  }, [id, currentUrl, setBrowserUrl, isUnconfigured]);

  useEffect(() => {
    setBrowserHistory(id, history);
  }, [id, history, setBrowserHistory]);

  useEffect(() => {
    setBrowserZoom(id, zoomFactor);
  }, [id, zoomFactor, setBrowserZoom]);

  // Every explicit navigation action hands the retry budget back. A load start no
  // longer refills it (#12296), and the budget belongs to the target that
  // exhausted it — carrying it into a URL the user just asked for would make that
  // navigation's first transient failure terminal. Deliberately done in the
  // action handlers rather than an effect on `currentUrl`: the error document's
  // own history update must not replenish anything.
  const handleNavigate = useCallback(
    (rawUrl: string) => {
      const normalized = normalizeBrowserUrl(rawUrl);
      if (normalized.url) {
        clearRetryState();
        // Push history only; the imperative navigation effect drives loadURL now
        // that `src` is seed-only (#9940). Mirrors handleBack/handleForward.
        setHistory((prev) => pushBrowserHistory(prev, normalized.url!));
      }
    },
    [clearRetryState, setHistory]
  );

  const handleBack = useCallback(() => {
    if (canGoBack) {
      clearRetryState();
      setHistory((prev) => goBackBrowserHistory(prev));
    }
  }, [canGoBack, clearRetryState, setHistory]);

  const handleForward = useCallback(() => {
    if (canGoForward) {
      clearRetryState();
      setHistory((prev) => goForwardBrowserHistory(prev));
    }
  }, [canGoForward, clearRetryState, setHistory]);

  // A user-initiated reload is a fresh attempt: hand back the retry budget. Load
  // start no longer refills it on its own, so without this an exhausted panel would
  // stay exhausted for the rest of its life (#12296).
  const handleReload = useCallback(() => {
    setWebviewLoadError(null);
    clearRetryState();
    webviewRef.current?.reload();
  }, [clearRetryState, setWebviewLoadError, webviewRef]);

  const handleCancelLoad = useCallback(() => {
    clearLoadTimers();
    setIsLoading(false);
    try {
      webviewRef.current?.stop();
    } catch {
      // Webview detached
    }
    setWebviewLoadError({ code: "aborted", message: "Load cancelled." });
  }, [clearLoadTimers, setIsLoading, setWebviewLoadError, webviewRef]);

  const handleRetryWebviewLoad = useCallback(() => {
    setWebviewLoadError(null);
    clearRetryState();
    setIsLoading(true);
    if (currentUrl) {
      // Swallow ERR_ABORTED-class rejections — did-fail-load is the source
      // of truth for genuine failures.
      const webview = webviewRef.current;
      if (webview) {
        loadWebviewUrl(webview, currentUrl);
      }
    } else {
      webviewRef.current?.reload();
    }
  }, [currentUrl, clearRetryState, setWebviewLoadError, setIsLoading, webviewRef]);

  const handleCaptureScreenshot = useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview || !isWebviewReady) return false;
    let url: string;
    try {
      url = webview.getURL();
    } catch {
      return false;
    }
    if (!url || url === "about:blank") return false;
    if (screenshotInFlightRef.current) return false;
    screenshotInFlightRef.current = true;
    try {
      const image = await webview.capturePage();
      const pngData = new Uint8Array(image.toPNG());
      await window.electron.clipboard.writeImage(pngData);
      return true;
    } catch (err) {
      logError("[DevPreviewPane] Screenshot capture failed", err);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Screenshot failed",
        message: "Couldn't copy the screenshot to clipboard",
      });
      return false;
    } finally {
      screenshotInFlightRef.current = false;
    }
  }, [isWebviewReady, webviewRef]);

  const handleToggleDevTools = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !isWebviewReady) return;
    if (webview.isDevToolsOpened()) {
      webview.closeDevTools();
    } else {
      webview.openDevTools();
    }
  }, [isWebviewReady, webviewRef]);

  const handleToggleConsole = useCallback(() => {
    setDevPreviewConsoleOpen(id, !isConsoleOpen);
  }, [id, isConsoleOpen, setDevPreviewConsoleOpen]);

  const handleOpenExternal = useCallback(() => {
    if (!currentUrl) return;

    // In proxy mode (#9101), hand the system browser a short-lived signed
    // bootstrap URL on the stable origin instead of the raw dev-server URL: it
    // lands with a session cookie and survives dev-server restarts that reshuffle
    // the upstream port. Fall back to the raw URL in legacy mode or if minting
    // fails, so the button always opens *something*.
    if (typeof proxyOrigin === "string" && currentProjectId && currentUrl.startsWith(proxyOrigin)) {
      // Preserve the hash too — hash-router SPAs keep their route in the fragment.
      const { pathname, search, hash } = new URL(currentUrl);
      safeFireAndForget(
        (async () => {
          try {
            const { bootstrapUrl } = await window.electron.devPreview.mintBrowserToken({
              panelId: id,
              projectId: currentProjectId,
              redirectPath: `${pathname}${search}${hash}`,
            });
            await window.electron.system.openExternal(bootstrapUrl);
          } catch (err) {
            logError("[DevPreviewPane] Browser handoff token failed; opening raw URL", err);
            await window.electron.system.openExternal(currentUrl);
          }
        })(),
        { context: "Opening dev preview URL externally" }
      );
      return;
    }

    safeFireAndForget(window.electron.system.openExternal(currentUrl), {
      context: "Opening dev preview URL externally",
    });
  }, [currentUrl, proxyOrigin, currentProjectId, id]);

  const handlePromoteToPortal = useCallback(async () => {
    if (isPromotingRef.current) return;
    isPromotingRef.current = true;
    const attempt = ++promoteAttemptRef.current;
    setIsPromotingToPortal(true);
    if (currentUrl) {
      setBrowserUrl(id, currentUrl);
    }
    const result = await actionService.dispatch(
      "devPreview.promoteToPortal",
      { panelId: id, projectId: currentProjectId },
      { source: "user" }
    );
    // A newer attempt (or a context change) already reset the guard and owns
    // the UI — an obsolete completion must not unlock it or overwrite state.
    if (promoteAttemptRef.current !== attempt) return;
    isPromotingRef.current = false;
    setIsPromotingToPortal(false);
    if (result.ok) {
      setPromoteToPortalError(null);
      return;
    }
    logError("[DevPreviewPane] promoteToPortal failed", result.error);
    setPromoteToPortalError(result.error.message);
  }, [currentProjectId, currentUrl, id, setBrowserUrl]);

  const handleZoomChange = useCallback(
    (newZoom: number) => {
      const clamped = Math.max(0.25, Math.min(2.0, newZoom));
      setZoomFactor(clamped);
      if (webviewRef.current) {
        webviewRef.current.setZoomFactor(clamped);
      }
    },
    [setZoomFactor, webviewRef]
  );

  useBrowserActionListeners(id, {
    onReload: handleReload,
    onNavigate: handleNavigate,
    onBack: handleBack,
    onForward: handleForward,
    onSetZoom: handleZoomChange,
    onCaptureScreenshot: handleCaptureScreenshot,
    onToggleDevTools: handleToggleDevTools,
    onToggleConsole: handleToggleConsole,
    onHardReload,
  });

  // Listen for the reload shortcut (Cmd/Ctrl+R) forwarded from the focused
  // webview guest. When the guest has focus, the outer renderer's keybinding
  // handler never fires, so the main process intercepts the key and forwards it.
  useEffect(() => {
    const cleanup = window.electron.webview.onReloadShortcut((payload) => {
      if (payload.panelId !== id) return;
      onHardReload();
    });
    return cleanup;
  }, [id, onHardReload]);

  // Listen for the close shortcut (Cmd/Ctrl+W) forwarded from the focused
  // webview guest (#10859). Without this, focus inside the guest bypasses the
  // host window's setIgnoreMenuShortcuts guard and the native role:"close"
  // menu accelerator closes the whole window instead of just this panel.
  useEffect(() => {
    const cleanup = window.electron.webview.onCloseShortcut((payload) => {
      if (payload.panelId !== id) return;
      void actionService.dispatch("terminal.close", { terminalId: id }, { source: "keybinding" });
    });
    return cleanup;
  }, [id]);

  // Listen for action-driven hard-reload events
  useEffect(() => {
    const handleHardReloadEvent = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      if (!detail || typeof (detail as { id?: unknown }).id !== "string") return;
      if ((detail as { id: string }).id === id) {
        onHardReload();
      }
    };

    const controller = new AbortController();
    window.addEventListener("daintree:hard-reload-browser", handleHardReloadEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [id, onHardReload]);

  return {
    handleNavigate,
    handleBack,
    handleForward,
    handleReload,
    handleCancelLoad,
    handleRetryWebviewLoad,
    handleCaptureScreenshot,
    handleToggleDevTools,
    handleToggleConsole,
    handleZoomChange,
    handleOpenExternal,
    handlePromoteToPortal,
    promoteToPortalError,
    isPromotingToPortal,
    clearPromoteToPortalError,
  };
}
