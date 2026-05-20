import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useWebviewThrottle } from "@/hooks/useWebviewThrottle";
import { useHasBeenVisible } from "@/hooks/useHasBeenVisible";
import { useWebviewEviction } from "@/hooks/useWebviewEviction";
import { useWebviewDialog } from "@/hooks/useWebviewDialog";
import { useWebviewEvents } from "@/hooks/useWebviewEvents";
import { useBrowserActionListeners } from "@/hooks/useBrowserActionListeners";
import { AlertTriangle, ExternalLink, RotateCw, Square } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/button";
import { usePanelStore } from "@/store";
import type { BrowserHistory } from "@shared/types/browser";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { BrowserToolbar } from "./BrowserToolbar";
import {
  normalizeBrowserUrl,
  extractHostPort,
  extractHostname,
  isValidBrowserUrl,
  clampZoom,
  type LoadError,
} from "./browserUtils";
import {
  goBackBrowserHistory,
  goForwardBrowserHistory,
  initializeBrowserHistory,
  pushBrowserHistory,
} from "./historyUtils";
import { actionService } from "@/services/ActionService";
import { WebviewDialog } from "./WebviewDialog";
import { FindBar } from "./FindBar";
import { useIsDragging } from "@/components/DragDrop";
import { cn } from "@/lib/utils";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useProjectStore } from "@/store";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useProjectSettings } from "@/hooks/useProjectSettings";
import { useFindInPage } from "@/hooks/useFindInPage";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { logError } from "@/utils/logger";

export interface BrowserPaneProps extends BasePanelProps {
  initialUrl: string;
  initialHistory?: BrowserHistory;
  initialZoom?: number;
  // Tab support
  tabs?: import("@/components/Panel/TabButton").TabInfo[];
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
}

// ERR_ABORTED (-3) fires when a pending load is superseded by a new navigation —
// benign. Any other rejection is unexpected and worth a log; did-fail-load
// surfaces user-visible failures, so this only catches non-event paths.
function loadWebviewUrl(webview: Electron.WebviewTag, url: string): void {
  const result = (webview.loadURL as (url: string) => unknown)(url);
  if (
    result &&
    typeof result === "object" &&
    "catch" in result &&
    typeof result.catch === "function"
  ) {
    (result as { catch: (fn: (err: unknown) => void) => void }).catch((err: unknown) => {
      if (
        err &&
        typeof err === "object" &&
        "errorCode" in err &&
        (err as { errorCode: unknown }).errorCode === -3
      ) {
        return;
      }
      logError(
        "[BrowserPane] Unexpected loadURL rejection",
        err instanceof Error ? err : new Error(String(err))
      );
    });
  }
}

export function BrowserPane({
  id,
  title,
  initialUrl,
  initialHistory,
  initialZoom,
  isFocused,
  isMaximized = false,
  location = "grid",
  onFocus,
  onClose,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  gridPanelCount,
  tabs,
  onTabClick,
  onTabClose,
  onTabRename,
  onAddTab,
}: BrowserPaneProps) {
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const [webviewElement, setWebviewElement] = useState<Electron.WebviewTag | null>(null);
  const setWebviewNode = useCallback((node: Electron.WebviewTag | null) => {
    webviewRef.current = node;
    setWebviewElement(node);
  }, []);
  const setBrowserUrl = usePanelStore((state) => state.setBrowserUrl);
  const setBrowserHistory = usePanelStore((state) => state.setBrowserHistory);
  const setBrowserZoom = usePanelStore((state) => state.setBrowserZoom);
  const isDragging = useIsDragging();
  const projectId = useProjectStore((state) => state.currentProject?.id);
  const devServerLoadTimeout = useProjectSettingsStore(
    (state) => state.settings?.devServerLoadTimeout
  );
  const loadTimeoutMs = Math.min(Math.max(devServerLoadTimeout ?? 30, 1), 120) * 1000;
  const { settings: projectSettings, saveSettings: saveProjectSettings } = useProjectSettings();
  const allowedHosts = useMemo(
    () => projectSettings?.browserAllowedHosts ?? [],
    [projectSettings?.browserAllowedHosts]
  );

  // Seed history from the `initialHistory` prop (threaded by buildPanelProps from
  // the persisted terminal state). Reading the store via getState() inside a lazy
  // useState initializer was a React Compiler bailout (Globals); prop threading
  // moves the read to the parent and keeps the leaf component compiler-friendly.
  // Use extended mode (empty allowedHosts) so private/LAN URLs in session state
  // are recognized as valid-syntax and return a normalized string; restored URLs
  // bypass the approval prompt since being in history implies prior approval.
  const [history, setHistory] = useState<BrowserHistory>(() => {
    const normalized = normalizeBrowserUrl(initialUrl, { allowedHosts: [] });
    const fallbackPresent = normalized.url || initialUrl;
    return initializeBrowserHistory(initialHistory ?? null, fallbackPresent);
  });

  // Track whether the current load is the initial session-restored load (not a fresh panel)
  const isInitialRestoredLoadRef = useRef(Boolean(initialHistory?.present));

  // Initialize zoom factor from the `initialZoom` prop (already clamped at the
  // prop-build site). Default 1.0 (100%) when the prop is absent.
  const [zoomFactor, setZoomFactor] = useState<number>(() => clampZoom(initialZoom ?? 1.0));

  const [isLoading, setIsLoading] = useState(true);
  // Doherty 400ms gate: skip loading affordances on fast loads to prevent flicker.
  const showLoadingOverlay = useDohertyGate(isLoading);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [blockedNav, setBlockedNav] = useState<{
    url: string;
    canOpenExternal: boolean;
  } | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{
    url: string;
    hostname: string;
  } | null>(null);
  const blockedNavTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Track the last URL we set on the webview to detect in-webview navigation
  const lastSetUrlRef = useRef<string>(history.present);
  // Track if webview has been mounted and is ready
  const [isWebviewReady, setIsWebviewReady] = useState(false);
  const loadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isSlowLoad, setIsSlowLoad] = useState(false);
  const slowLoadTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const hasBeenVisible = useHasBeenVisible(id, location);

  const currentUrl = history.present;
  const canGoBack = history.past.length > 0;
  const canGoForward = history.future.length > 0;
  const hasValidUrl = isValidBrowserUrl(currentUrl);

  const { isEvicted, evictingRef } = useWebviewEviction(id, location);

  // Sync URL changes to store (only if valid)
  useEffect(() => {
    if (hasValidUrl) {
      setBrowserUrl(id, currentUrl);
    }
  }, [id, currentUrl, hasValidUrl, setBrowserUrl]);

  // Persist history changes to terminal store (with validation)
  useEffect(() => {
    if (Array.isArray(history.past) && Array.isArray(history.future)) {
      setBrowserHistory(id, history);
    }
  }, [id, history, setBrowserHistory]);

  // Apply zoom level when it changes or webview becomes ready
  useEffect(() => {
    const webview = webviewRef.current;
    if (webview && isWebviewReady) {
      webview.setZoomFactor(zoomFactor);
    }
  }, [zoomFactor, isWebviewReady]);

  // Persist zoom factor changes
  useEffect(() => {
    setBrowserZoom(id, zoomFactor);
  }, [id, zoomFactor, setBrowserZoom]);

  // Listen for blocked navigation events from main process (debounced 150ms for redirect chains)
  useEffect(() => {
    const cleanup = window.electron.webview.onNavigationBlocked((data) => {
      if (data.panelId !== id) return;
      if (blockedNavTimerRef.current) {
        clearTimeout(blockedNavTimerRef.current);
      }
      blockedNavTimerRef.current = setTimeout(() => {
        setBlockedNav({ url: data.url, canOpenExternal: data.canOpenExternal });
        blockedNavTimerRef.current = null;
      }, 150);
    });
    return () => {
      cleanup();
      if (blockedNavTimerRef.current) {
        clearTimeout(blockedNavTimerRef.current);
        blockedNavTimerRef.current = null;
      }
    };
  }, [id]);

  // Auto-dismiss blocked navigation notification after 10 seconds
  useEffect(() => {
    if (!blockedNav) return;
    const timer = setTimeout(() => setBlockedNav(null), 10_000);
    return () => clearTimeout(timer);
  }, [blockedNav]);

  useWebviewEvents({
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
  });

  const commitNavigation = useCallback(
    (url: string) => {
      isInitialRestoredLoadRef.current = false;
      setBlockedNav(null);
      setPendingApproval(null);
      setHistory((prev) => pushBrowserHistory(prev, url));
      setIsLoading(true);
      setLoadError(null);
      lastSetUrlRef.current = url;

      const webview = webviewRef.current;
      if (webview && isWebviewReady) {
        // ERR_ABORTED (-3) is benign: emitted when a pending load is superseded
        // by a fresh navigation (typing a new URL while the previous one is
        // still loading). The did-fail-load handler already filters -3 — we
        // mirror that here on the loadURL Promise so the rejection doesn't
        // bubble to the global unhandled-rejection handler. Any genuine load
        // failure will surface through did-fail-load with a non-(-3) code.
        loadWebviewUrl(webview, url);
      }
    },
    [isWebviewReady]
  );

  const handleNavigate = useCallback(
    (url: string) => {
      const result = normalizeBrowserUrl(url, { allowedHosts });
      if (result.error || !result.url) return;

      if (result.requiresConfirmation && result.hostname) {
        setPendingApproval({ url: result.url, hostname: result.hostname });
        return;
      }

      commitNavigation(result.url);
    },
    [allowedHosts, commitNavigation]
  );

  const handleApproveHost = useCallback(async () => {
    if (!pendingApproval) return;
    // Guard against save silently no-oping when projectId is transiently null
    // (startup, project switch) — without this, the banner would clear and the
    // webview would load without the hostname ever being persisted.
    if (!projectId) {
      console.warn("[BrowserPane] Cannot approve host without an active project");
      return;
    }
    const { url, hostname } = pendingApproval;
    const baseSettings = projectSettings ?? { runCommands: [] };
    const nextAllowed = Array.from(
      new Set([...(baseSettings.browserAllowedHosts ?? []), hostname])
    );
    try {
      await saveProjectSettings({ ...baseSettings, browserAllowedHosts: nextAllowed });
    } catch (err) {
      logError("[BrowserPane] Failed to save approved host", err);
      return;
    }
    commitNavigation(url);
  }, [pendingApproval, projectId, projectSettings, saveProjectSettings, commitNavigation]);

  const handleDismissApproval = useCallback(() => {
    setPendingApproval(null);
  }, []);

  const handleBack = useCallback(() => {
    isInitialRestoredLoadRef.current = false;
    setBlockedNav(null);
    setHistory((prev) => {
      const next = goBackBrowserHistory(prev);
      if (next === prev) return prev;
      const previousUrl = next.present;
      lastSetUrlRef.current = previousUrl;

      // Navigate webview back. Swallow ERR_ABORTED-class rejections — see
      // commitNavigation comment above; did-fail-load is the source of truth
      // for genuine failures.
      const webview = webviewRef.current;
      if (webview && isWebviewReady) {
        loadWebviewUrl(webview, previousUrl);
      }

      return next;
    });
    setIsLoading(true);
    setLoadError(null);
  }, [isWebviewReady]);

  const handleForward = useCallback(() => {
    isInitialRestoredLoadRef.current = false;
    setBlockedNav(null);
    setHistory((prev) => {
      const next = goForwardBrowserHistory(prev);
      if (next === prev) return prev;
      const nextUrl = next.present;
      lastSetUrlRef.current = nextUrl;

      // Navigate webview forward. Swallow ERR_ABORTED-class rejections —
      // see commitNavigation comment.
      const webview = webviewRef.current;
      if (webview && isWebviewReady) {
        loadWebviewUrl(webview, nextUrl);
      }

      return next;
    });
    setIsLoading(true);
    setLoadError(null);
  }, [isWebviewReady]);

  const handleReload = useCallback(() => {
    setBlockedNav(null);
    setIsLoading(true);
    setLoadError(null);
    setIsSlowLoad(false);
    webviewRef.current?.reload();
  }, []);

  const handleCancelLoad = useCallback(() => {
    if (slowLoadTimeoutRef.current) {
      clearTimeout(slowLoadTimeoutRef.current);
      slowLoadTimeoutRef.current = null;
    }
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
    setIsSlowLoad(false);
    setIsLoading(false);
    const webview = webviewRef.current;
    if (webview) {
      try {
        webview.stop();
      } catch {
        // Webview detached
      }
    }
    setLoadError({ kind: "cancelled", message: "Load cancelled." });
  }, []);

  const handleRetryFromError = useCallback(() => {
    setLoadError(null);
    setIsSlowLoad(false);
    setIsLoading(true);
    if (currentUrl) {
      // Swallow ERR_ABORTED-class rejections — see commitNavigation comment.
      const webview = webviewRef.current;
      if (webview) {
        loadWebviewUrl(webview, currentUrl);
      }
    } else {
      webviewRef.current?.reload();
    }
  }, [currentUrl]);

  const handleHardReload = useCallback(() => {
    setBlockedNav(null);
    setIsLoading(true);
    setLoadError(null);
    const webview = webviewRef.current;
    if (!webview || !isWebviewReady) return;
    try {
      const wcId = (webview as unknown as { getWebContentsId(): number }).getWebContentsId();
      safeFireAndForget(window.electron.webview.reloadIgnoringCache(wcId, id), {
        context: "Reloading browser webview ignoring cache",
      });
    } catch {
      webview.reload();
    }
  }, [isWebviewReady, id]);

  const handleCaptureScreenshot = useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview || !isWebviewReady) return;
    let url: string;
    try {
      url = webview.getURL();
    } catch {
      return;
    }
    if (!url || url === "about:blank") return;
    try {
      const image = await webview.capturePage();
      const pngData = new Uint8Array(image.toPNG());
      await window.electron.clipboard.writeImage(pngData);
    } catch (err) {
      logError("[BrowserPane] Screenshot capture failed", err);
    }
  }, [isWebviewReady]);

  const handleToggleDevTools = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !isWebviewReady) return;
    if (webview.isDevToolsOpened()) {
      webview.closeDevTools();
    } else {
      webview.openDevTools();
    }
  }, [isWebviewReady]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (blockedNavTimerRef.current) {
        clearTimeout(blockedNavTimerRef.current);
      }
      if (slowLoadTimeoutRef.current) {
        clearTimeout(slowLoadTimeoutRef.current);
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
    };
  }, []);

  const handleSetZoom = useCallback((rawZoom: number) => {
    setZoomFactor(clampZoom(rawZoom));
  }, []);

  useBrowserActionListeners(id, {
    onReload: handleReload,
    onNavigate: handleNavigate,
    onBack: handleBack,
    onForward: handleForward,
    onSetZoom: handleSetZoom,
    onCaptureScreenshot: handleCaptureScreenshot,
    onToggleDevTools: handleToggleDevTools,
    onHardReload: handleHardReload,
  });

  // Blank the webview before React unmounts it for faster memory reclamation
  useEffect(() => {
    if (isEvicted && webviewRef.current) {
      try {
        webviewRef.current.src = "about:blank";
      } catch {
        // webview may already be detached
      }
    }
  }, [isEvicted]);

  useWebviewThrottle(id, location, isEvicted ? null : webviewElement, isWebviewReady && !isEvicted);
  const { currentDialog, handleDialogRespond } = useWebviewDialog(
    id,
    isEvicted ? null : webviewElement,
    isWebviewReady && !isEvicted
  );
  const findInPage = useFindInPage(
    id,
    isEvicted ? null : webviewElement,
    isWebviewReady && !isEvicted,
    isFocused
  );

  const handleOpenExternal = useCallback(() => {
    if (!hasValidUrl) return;
    void actionService.dispatch("browser.openExternal", { terminalId: id }, { source: "user" });
  }, [hasValidUrl, id]);

  const displayTitle = useMemo(() => {
    if (title && title !== "Browser") return title;
    return extractHostPort(currentUrl);
  }, [title, currentUrl]);

  const browserToolbar = (
    <BrowserToolbar
      terminalId={id}
      projectId={projectId}
      url={currentUrl}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      isLoading={showLoadingOverlay}
      zoomFactor={zoomFactor}
      isWebviewReady={isWebviewReady}
      onNavigate={(url) =>
        void actionService.dispatch("browser.navigate", { terminalId: id, url }, { source: "user" })
      }
      onBack={() =>
        void actionService.dispatch("browser.back", { terminalId: id }, { source: "user" })
      }
      onForward={() =>
        void actionService.dispatch("browser.forward", { terminalId: id }, { source: "user" })
      }
      onReload={() =>
        void actionService.dispatch("browser.reload", { terminalId: id }, { source: "user" })
      }
      onHardReload={() =>
        void actionService.dispatch("browser.hardReload", { terminalId: id }, { source: "user" })
      }
      onOpenExternal={handleOpenExternal}
      onZoomChange={(factor) =>
        void actionService.dispatch(
          "browser.setZoomLevel",
          { terminalId: id, zoomFactor: factor },
          { source: "user" }
        )
      }
      onCaptureScreenshot={() =>
        void actionService.dispatch(
          "browser.captureScreenshot",
          { terminalId: id },
          { source: "user" }
        )
      }
      onToggleDevTools={() =>
        void actionService.dispatch(
          "browser.toggleDevTools",
          { terminalId: id },
          { source: "user" }
        )
      }
    />
  );

  return (
    <ContentPanel
      id={id}
      title={displayTitle}
      kind="browser"
      isFocused={isFocused}
      isMaximized={isMaximized}
      location={location}
      gridPanelCount={gridPanelCount}
      onFocus={onFocus}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleChange={onTitleChange}
      onMinimize={onMinimize}
      onRestore={onRestore}
      toolbar={browserToolbar}
      tabs={tabs}
      onTabClick={onTabClick}
      onTabClose={onTabClose}
      onTabRename={onTabRename}
      onAddTab={onAddTab}
    >
      <div className="relative flex-1 min-h-0 flex flex-col bg-surface-canvas">
        {pendingApproval && (
          <div
            aria-live="assertive"
            aria-atomic="true"
            className="absolute top-0 left-0 right-0 z-20 flex items-center gap-2 px-3 py-1.5 text-xs bg-status-info/10 border-b border-status-info/30 text-daintree-text/90"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-status-info" />
            <span className="truncate flex-1">
              Allow browser panel to load{" "}
              <span className="font-mono">{pendingApproval.hostname}</span>?
            </span>
            <button
              type="button"
              onClick={() => void handleApproveHost()}
              className="shrink-0 px-2 py-0.5 rounded text-xs bg-status-info/20 hover:bg-status-info/30 text-daintree-text/90 transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent/50"
            >
              Allow
            </button>
            <button
              type="button"
              onClick={handleDismissApproval}
              className="shrink-0 text-daintree-text/40 hover:text-daintree-text/70 transition-colors"
              aria-label="Dismiss host approval"
            >
              ×
            </button>
          </div>
        )}
        {!hasValidUrl ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
            <div className="flex flex-col items-center text-center max-w-md">
              <h3 className="text-sm font-medium text-daintree-text/70 mb-1">Browser</h3>
              <p className="text-xs text-daintree-text/50 mb-4 leading-relaxed">
                Preview your local development server. Enter a URL in the address bar above —
                localhost, LAN, Docker, and RFC-reserved TLDs (.local, .test, .internal) are all
                supported.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {["localhost:3000", "localhost:5173", "localhost:8080"].map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => handleNavigate(`http://${example}`)}
                    className="px-3 py-1.5 text-xs font-mono text-daintree-text/50 bg-overlay-soft hover:bg-overlay-medium border border-overlay rounded-md transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent/50"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : !hasBeenVisible ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text">
            <p className="text-xs text-daintree-text/50">
              Browser will load when this panel is first viewed
            </p>
          </div>
        ) : isEvicted ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
            <p className="text-xs text-daintree-text/50">Reclaimed for memory</p>
          </div>
        ) : (
          <>
            {loadError && (
              <div
                role="alert"
                className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6"
              >
                <AlertTriangle className="w-6 h-6 text-status-warning mb-3" />
                <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
                  {loadError.kind === "timeout"
                    ? "Page Load Timed Out"
                    : loadError.kind === "cancelled"
                      ? "Load Cancelled"
                      : loadError.kind === "cert"
                        ? "Certificate Error"
                        : loadError.kind === "network"
                          ? "Connection Failed"
                          : "Unable to Display Page"}
                </h3>
                <p className="text-xs text-daintree-text/50 text-center mb-3 max-w-md">
                  {loadError.message}
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    onClick={handleRetryFromError}
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 px-2.5 py-1.5 group"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    <span className="text-xs">Retry</span>
                  </Button>
                  <button
                    type="button"
                    onClick={handleOpenExternal}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-overlay-soft transition-colors group focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent/50"
                  >
                    <ExternalLink className="h-3.5 w-3.5 text-daintree-text/50 group-hover:text-daintree-text/70 transition-colors" />
                    <span className="text-xs text-daintree-text/50 group-hover:text-daintree-text/70 transition-colors">
                      Open in external browser
                    </span>
                  </button>
                </div>
              </div>
            )}
            {blockedNav && (
              <div
                aria-live="polite"
                aria-atomic="true"
                className="flex items-center gap-2 px-3 py-1.5 text-xs bg-status-warning/10 border-b border-status-warning/20 text-daintree-text/80"
              >
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-status-warning" />
                <span className="truncate flex-1">
                  Navigation to external site blocked: {extractHostname(blockedNav.url)}
                </span>
                {blockedNav.canOpenExternal && (
                  <button
                    type="button"
                    onClick={() => {
                      void actionService.dispatch(
                        "browser.openExternal",
                        { terminalId: id, url: blockedNav.url },
                        { source: "user" }
                      );
                      setBlockedNav(null);
                    }}
                    className="shrink-0 px-2 py-0.5 rounded text-xs bg-status-warning/20 hover:bg-status-warning/30 text-daintree-text/90 transition-colors"
                  >
                    Open in external browser
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setBlockedNav(null)}
                  className="shrink-0 text-daintree-text/40 hover:text-daintree-text/70 transition-colors"
                  aria-label="Dismiss navigation notice"
                >
                  ×
                </button>
              </div>
            )}
            <div className="relative flex-1 min-h-0">
              {isDragging && <div className="absolute inset-0 z-10 bg-transparent" />}
              {showLoadingOverlay && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg z-10 gap-3">
                  <Spinner size="2xl" className="text-status-info" />
                  {isSlowLoad && (
                    <>
                      <p className="text-xs text-daintree-text/50">Taking longer than usual...</p>
                      <Button
                        onClick={handleCancelLoad}
                        variant="ghost"
                        size="sm"
                        className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70"
                      >
                        <Square className="h-3.5 w-3.5" />
                        <span className="text-xs">Cancel</span>
                      </Button>
                    </>
                  )}
                </div>
              )}
              {findInPage.isOpen && <FindBar find={findInPage} />}
              <webview
                ref={setWebviewNode}
                src={currentUrl}
                partition="persist:browser"
                // @ts-expect-error React 19 requires "" to emit the attribute; boolean true is silently dropped
                allowpopups=""
                className={cn(
                  "w-full h-full border-0",
                  isDragging && "invisible pointer-events-none"
                )}
              />
              <WebviewDialog dialog={currentDialog} onRespond={handleDialogRespond} />
            </div>
          </>
        )}
      </div>
    </ContentPanel>
  );
}
