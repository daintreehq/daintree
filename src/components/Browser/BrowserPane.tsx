import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { AlertTriangle, ExternalLink, Home } from "lucide-react";
import { useTerminalStore } from "@/store";
import type { BrowserHistory } from "@shared/types/domain";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { BrowserToolbar } from "./BrowserToolbar";
import { normalizeBrowserUrl, extractHostPort, isValidBrowserUrl } from "./browserUtils";
import {
  goBackBrowserHistory,
  goForwardBrowserHistory,
  initializeBrowserHistory,
  pushBrowserHistory,
} from "./historyUtils";
import { actionService } from "@/services/ActionService";
import { useIsDragging } from "@/components/DragDrop";
import { cn } from "@/lib/utils";

export interface BrowserPaneProps extends BasePanelProps {
  initialUrl: string;
  // Tab support
  tabs?: import("@/components/Panel/TabButton").TabInfo[];
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
}

export function BrowserPane({
  id,
  title,
  initialUrl,
  isFocused,
  isMaximized = false,
  location = "grid",
  onFocus,
  onClose,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  isTrashing = false,
  gridPanelCount,
  tabs,
  onTabClick,
  onTabClose,
  onTabRename,
  onAddTab,
}: BrowserPaneProps) {
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const setBrowserUrl = useTerminalStore((state) => state.setBrowserUrl);
  const setBrowserHistory = useTerminalStore((state) => state.setBrowserHistory);
  const setBrowserZoom = useTerminalStore((state) => state.setBrowserZoom);
  const isDragging = useIsDragging();

  // Initialize history from persisted state or initialUrl
  const [history, setHistory] = useState<BrowserHistory>(() => {
    const terminal = useTerminalStore.getState().getTerminal(id);
    const saved = terminal?.browserHistory;
    const normalized = normalizeBrowserUrl(initialUrl);
    const fallbackPresent = terminal?.browserUrl || normalized.url || initialUrl;
    return initializeBrowserHistory(saved, fallbackPresent);
  });

  // Initialize zoom factor from persisted state (default 1.0 = 100%)
  // Clamp to valid range [0.25, 2.0] to handle corrupt storage
  const [zoomFactor, setZoomFactor] = useState<number>(() => {
    const terminal = useTerminalStore.getState().getTerminal(id);
    const savedZoom = terminal?.browserZoom ?? 1.0;
    return Number.isFinite(savedZoom) ? Math.max(0.25, Math.min(2.0, savedZoom)) : 1.0;
  });

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Track the last URL we set on the webview to detect in-webview navigation
  const lastSetUrlRef = useRef<string>(history.present);
  // Track if webview has been mounted and is ready
  const [isWebviewReady, setIsWebviewReady] = useState(false);
  const loadTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const currentUrl = history.present;
  const canGoBack = history.past.length > 0;
  const canGoForward = history.future.length > 0;
  const hasValidUrl = isValidBrowserUrl(currentUrl);

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

  // Set up webview event listeners - reattach whenever webview element changes
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) {
      setIsWebviewReady(false);
      return;
    }

    const handleDomReady = () => {
      setIsWebviewReady(true);
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
    };

    const handleDidStartLoading = () => {
      setIsLoading(true);
      setLoadError(null);
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
      loadTimeoutRef.current = setTimeout(() => {
        if (webview.isLoading()) {
          webview.reload();
        }
      }, 30000);
    };

    const handleDidStopLoading = () => {
      setIsLoading(false);
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
    };

    const handleDidFailLoad = (event: Electron.DidFailLoadEvent) => {
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      // Ignore aborted loads (e.g., navigation interrupted by another navigation)
      if (event.errorCode === -3) return;
      // Ignore cancellations
      if (event.errorCode === -6) return;
      setIsLoading(false);
      setLoadError(event.errorDescription || "Failed to load page. The site may be unavailable.");
    };

    const handleDidNavigate = (event: Electron.DidNavigateEvent) => {
      const newUrl = event.url;
      // Only update history if this is a new URL (not our programmatic navigation)
      if (newUrl !== lastSetUrlRef.current) {
        setHistory((prev) => pushBrowserHistory(prev, newUrl));
        lastSetUrlRef.current = newUrl;
      }
    };

    const handleDidNavigateInPage = (event: Electron.DidNavigateInPageEvent) => {
      if (!event.isMainFrame) return;
      const newUrl = event.url;
      if (newUrl !== lastSetUrlRef.current) {
        setHistory((prev) => pushBrowserHistory(prev, newUrl));
        lastSetUrlRef.current = newUrl;
      }
    };

    const existingUrl = webview.getURL();
    if (existingUrl && existingUrl !== "about:blank" && !webview.isLoading()) {
      setIsWebviewReady(true);
      setIsLoading(false);
      const savedZoom = zoomFactor;
      if (Number.isFinite(savedZoom)) {
        webview.setZoomFactor(savedZoom);
      }
    }

    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-fail-load", handleDidFailLoad);
    webview.addEventListener("did-navigate", handleDidNavigate);
    webview.addEventListener("did-navigate-in-page", handleDidNavigateInPage);

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-fail-load", handleDidFailLoad);
      webview.removeEventListener("did-navigate", handleDidNavigate);
      webview.removeEventListener("did-navigate-in-page", handleDidNavigateInPage);
    };
  }, [hasValidUrl, loadError, zoomFactor]);

  const handleNavigate = useCallback(
    (url: string) => {
      const result = normalizeBrowserUrl(url);
      if (result.error || !result.url) return;

      setHistory((prev) => pushBrowserHistory(prev, result.url!));
      setIsLoading(true);
      setLoadError(null);
      lastSetUrlRef.current = result.url!;

      // Navigate webview to new URL
      const webview = webviewRef.current;
      if (webview && isWebviewReady) {
        webview.loadURL(result.url!);
      }
    },
    [isWebviewReady]
  );

  const handleBack = useCallback(() => {
    setHistory((prev) => {
      const next = goBackBrowserHistory(prev);
      if (next === prev) return prev;
      const previousUrl = next.present;
      lastSetUrlRef.current = previousUrl;

      // Navigate webview back
      const webview = webviewRef.current;
      if (webview && isWebviewReady) {
        webview.loadURL(previousUrl);
      }

      return next;
    });
    setIsLoading(true);
    setLoadError(null);
  }, [isWebviewReady]);

  const handleForward = useCallback(() => {
    setHistory((prev) => {
      const next = goForwardBrowserHistory(prev);
      if (next === prev) return prev;
      const nextUrl = next.present;
      lastSetUrlRef.current = nextUrl;

      // Navigate webview forward
      const webview = webviewRef.current;
      if (webview && isWebviewReady) {
        webview.loadURL(nextUrl);
      }

      return next;
    });
    setIsLoading(true);
    setLoadError(null);
  }, [isWebviewReady]);

  const handleReload = useCallback(() => {
    setIsLoading(true);
    setLoadError(null);
    const webview = webviewRef.current;
    if (webview && isWebviewReady) {
      webview.reload();
    }
  }, [isWebviewReady]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
    };
  }, []);

  // Listen for action-driven browser events
  useEffect(() => {
    const handleReloadEvent = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      if (!detail || typeof (detail as { id?: unknown }).id !== "string") return;
      if ((detail as { id: string }).id === id) {
        handleReload();
      }
    };

    const handleNavigateEvent = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      if (!detail || typeof (detail as { id?: unknown }).id !== "string") return;
      if (typeof (detail as { url?: unknown }).url !== "string") return;
      if ((detail as { id: string }).id === id) {
        handleNavigate((detail as { url: string }).url);
      }
    };

    const handleBackEvent = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      if (!detail || typeof (detail as { id?: unknown }).id !== "string") return;
      if ((detail as { id: string }).id === id) {
        handleBack();
      }
    };

    const handleForwardEvent = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      if (!detail || typeof (detail as { id?: unknown }).id !== "string") return;
      if ((detail as { id: string }).id === id) {
        handleForward();
      }
    };

    const handleSetZoomEvent = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      if (!detail || typeof (detail as { id?: unknown }).id !== "string") return;
      if (typeof (detail as { zoomFactor?: unknown }).zoomFactor !== "number") return;
      if ((detail as { id: string }).id === id) {
        const rawZoom = (detail as { zoomFactor: number }).zoomFactor;
        // Validate and clamp zoom factor to [0.25, 2.0]
        const validZoom = Number.isFinite(rawZoom) ? Math.max(0.25, Math.min(2.0, rawZoom)) : 1.0;
        setZoomFactor(validZoom);
      }
    };

    const controller = new AbortController();
    window.addEventListener("canopy:reload-browser", handleReloadEvent, {
      signal: controller.signal,
    });
    window.addEventListener("canopy:browser-navigate", handleNavigateEvent, {
      signal: controller.signal,
    });
    window.addEventListener("canopy:browser-back", handleBackEvent, { signal: controller.signal });
    window.addEventListener("canopy:browser-forward", handleForwardEvent, {
      signal: controller.signal,
    });
    window.addEventListener("canopy:browser-set-zoom", handleSetZoomEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [id, handleReload, handleNavigate, handleBack, handleForward]);

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
      url={currentUrl}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      isLoading={isLoading}
      urlMightBeStale={false}
      zoomFactor={zoomFactor}
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
      onOpenExternal={handleOpenExternal}
      onZoomChange={(factor) =>
        void actionService.dispatch(
          "browser.setZoomLevel",
          { terminalId: id, zoomFactor: factor },
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
      isTrashing={isTrashing}
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
      <div className="relative flex-1 min-h-0 bg-white">
        {!hasValidUrl ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-canopy-bg text-canopy-text p-6">
            <div className="flex flex-col items-center text-center max-w-md">
              <div className="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center mb-6">
                <Home className="w-8 h-8 text-blue-400" />
              </div>
              <h3 className="text-lg font-medium mb-2">Localhost Browser</h3>
              <p className="text-sm text-canopy-text/60 mb-6 leading-relaxed">
                Preview your local development server. Enter a localhost URL in the address bar
                above to get started.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {["localhost:3000", "localhost:5173", "localhost:8080"].map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => handleNavigate(`http://${example}`)}
                    className="px-3 py-1.5 text-xs font-mono bg-white/5 hover:bg-white/10 border border-white/10 rounded-md transition-colors"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : loadError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-canopy-bg text-canopy-text p-6">
            <AlertTriangle className="w-12 h-12 text-amber-400 mb-4" />
            <h3 className="text-lg font-medium mb-2">Unable to Display Page</h3>
            <p className="text-sm text-canopy-text/60 text-center mb-4 max-w-md">{loadError}</p>
            <button
              type="button"
              onClick={handleOpenExternal}
              className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-lg border border-blue-500/30 transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              Open in External Browser
            </button>
          </div>
        ) : (
          <>
            {isDragging && <div className="absolute inset-0 z-10 bg-transparent" />}
            {isLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-canopy-bg z-10">
                <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            <webview
              ref={webviewRef}
              src={currentUrl}
              partition="persist:browser"
              className={cn(
                "w-full h-full border-0",
                isDragging && "invisible pointer-events-none"
              )}
            />
          </>
        )}
      </div>
    </ContentPanel>
  );
}
