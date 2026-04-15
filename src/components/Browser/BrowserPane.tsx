import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useWebviewThrottle } from "@/hooks/useWebviewThrottle";
import { useHasBeenVisible } from "@/hooks/useHasBeenVisible";
import { useWebviewEviction } from "@/hooks/useWebviewEviction";
import { useWebviewDialog } from "@/hooks/useWebviewDialog";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { usePanelStore } from "@/store";
import type { BrowserHistory } from "@shared/types/browser";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { BrowserToolbar } from "./BrowserToolbar";
import { ConsolePanel } from "./ConsolePanel";
import { normalizeBrowserUrl, extractHostPort, isValidBrowserUrl } from "./browserUtils";
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
import { useConsoleCaptureStore } from "@/store/consoleCaptureStore";
import type { SerializedConsoleRow } from "@shared/types/ipc/webviewConsole";
import { useProjectStore } from "@/store";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useUrlHistoryStore } from "@/store/urlHistoryStore";
import { useFindInPage } from "@/hooks/useFindInPage";

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
  const [webviewElement, setWebviewElement] = useState<Electron.WebviewTag | null>(null);
  const setWebviewNode = useCallback((node: Electron.WebviewTag | null) => {
    webviewRef.current = node;
    setWebviewElement(node);
  }, []);
  const setBrowserUrl = usePanelStore((state) => state.setBrowserUrl);
  const setBrowserHistory = usePanelStore((state) => state.setBrowserHistory);
  const setBrowserZoom = usePanelStore((state) => state.setBrowserZoom);
  const isDragging = useIsDragging();
  const addStructuredMessage = useConsoleCaptureStore((state) => state.addStructuredMessage);
  const markStale = useConsoleCaptureStore((state) => state.markStale);
  const clearConsoleMessages = useConsoleCaptureStore((state) => state.clearMessages);
  const removePane = useConsoleCaptureStore((state) => state.removePane);
  const webContentsIdRef = useRef<number | null>(null);
  const projectId = useProjectStore((state) => state.currentProject?.id);
  const devServerLoadTimeout = useProjectSettingsStore(
    (state) => state.settings?.devServerLoadTimeout
  );
  const loadTimeoutMs = Math.min(Math.max(devServerLoadTimeout ?? 30, 1), 120) * 1000;

  const isConsoleOpen = usePanelStore(
    (state) => state.getTerminal(id)?.browserConsoleOpen ?? false
  );
  const setBrowserConsoleOpen = usePanelStore((state) => state.setBrowserConsoleOpen);

  // Track whether the current load is the initial session-restored load (not a fresh panel)
  const isInitialRestoredLoadRef = useRef(true);

  // Initialize history from persisted state or initialUrl
  const [history, setHistory] = useState<BrowserHistory>(() => {
    const terminal = usePanelStore.getState().getTerminal(id);
    const saved = terminal?.browserHistory;
    // Only treat this as a restored session load if we actually have persisted history
    isInitialRestoredLoadRef.current = Boolean(saved?.present);
    const normalized = normalizeBrowserUrl(initialUrl);
    const fallbackPresent = terminal?.browserUrl || normalized.url || initialUrl;
    return initializeBrowserHistory(saved, fallbackPresent);
  });

  // Initialize zoom factor from persisted state (default 1.0 = 100%)
  // Clamp to valid range [0.25, 2.0] to handle corrupt storage
  const [zoomFactor, setZoomFactor] = useState<number>(() => {
    const terminal = usePanelStore.getState().getTerminal(id);
    const savedZoom = terminal?.browserZoom ?? 1.0;
    return Number.isFinite(savedZoom) ? Math.max(0.25, Math.min(2.0, savedZoom)) : 1.0;
  });

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [blockedNav, setBlockedNav] = useState<{
    url: string;
    canOpenExternal: boolean;
  } | null>(null);
  const blockedNavTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Track the last URL we set on the webview to detect in-webview navigation
  const lastSetUrlRef = useRef<string>(history.present);
  // Track if webview has been mounted and is ready
  const [isWebviewReady, setIsWebviewReady] = useState(false);
  const loadTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

  // Clean up console messages when pane unmounts
  useEffect(() => {
    return () => removePane(id);
  }, [id, removePane]);

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

  // CDP console capture: start when webview is ready, subscribe to push events
  useEffect(() => {
    if (!webviewElement || !isWebviewReady) return;

    let wcId: number;
    try {
      wcId = (webviewElement as unknown as { getWebContentsId(): number }).getWebContentsId();
    } catch {
      return;
    }
    webContentsIdRef.current = wcId;

    // Subscribe to push events BEFORE starting capture to avoid missing early messages
    const cleanupMessage = window.electron.webview.onConsoleMessage((row: SerializedConsoleRow) => {
      if (row.paneId === id) {
        addStructuredMessage(row);
      }
    });

    const cleanupContext = window.electron.webview.onConsoleContextCleared(
      (payload: { paneId: string; navigationGeneration: number }) => {
        if (payload.paneId === id) {
          markStale(id, payload.navigationGeneration);
        }
      }
    );

    void (async () => {
      await window.electron.webview.registerPanel(wcId, id);
      await window.electron.webview.startConsoleCapture(wcId, id);
    })();

    return () => {
      void window.electron.webview.stopConsoleCapture(wcId, id);
      cleanupMessage();
      cleanupContext();
      webContentsIdRef.current = null;
    };
  }, [webviewElement, isWebviewReady, id, addStructuredMessage, markStale]);

  // Set up webview event listeners - reattach whenever webview element changes
  useEffect(() => {
    const webview = webviewElement;
    if (!webview) {
      setIsWebviewReady(false);
      return;
    }

    const handleDomReady = () => {
      isInitialRestoredLoadRef.current = false;
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
        try {
          if (webview.isLoading()) {
            webview.reload();
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
      const ERR_CONNECTION_REFUSED = -102;
      if (
        event.isMainFrame &&
        event.errorCode === ERR_CONNECTION_REFUSED &&
        isInitialRestoredLoadRef.current
      ) {
        setLoadError(
          "The saved URL is no longer reachable. The server may have moved to a different port."
        );
      } else {
        setLoadError(event.errorDescription || "Failed to load page. The site may be unavailable.");
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
      if (projectId) {
        let title: string | undefined;
        try {
          title = webview.getTitle();
        } catch {
          // webview may not be ready for getTitle
        }
        useUrlHistoryStore.getState().recordVisit(projectId, newUrl, title);
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
      if (projectId) {
        let title: string | undefined;
        try {
          title = webview.getTitle();
        } catch {
          // webview may not be ready for getTitle
        }
        useUrlHistoryStore.getState().recordVisit(projectId, newUrl, title);
      }
    };

    const handlePageTitleUpdated = (event: Event) => {
      const detail = event as Event & { title?: string; explicitSet?: boolean };
      if (detail.explicitSet === false) return;
      if (projectId && detail.title) {
        try {
          useUrlHistoryStore.getState().updateTitle(projectId, webview.getURL(), detail.title);
        } catch {
          // webview may be detached
        }
      }
    };

    try {
      const existingUrl = webview.getURL();
      if (existingUrl && existingUrl !== "about:blank" && !webview.isLoading()) {
        setIsWebviewReady(true);
        setIsLoading(false);
        const savedZoom = zoomFactor;
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

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-fail-load", handleDidFailLoad);
      webview.removeEventListener("did-navigate", handleDidNavigate);
      webview.removeEventListener("did-navigate-in-page", handleDidNavigateInPage);
      webview.removeEventListener("page-title-updated", handlePageTitleUpdated);
    };
  }, [
    webviewElement,
    hasValidUrl,
    loadError,
    zoomFactor,
    id,
    projectId,
    loadTimeoutMs,
    evictingRef,
  ]);

  const handleNavigate = useCallback(
    (url: string) => {
      const result = normalizeBrowserUrl(url);
      if (result.error || !result.url) return;

      isInitialRestoredLoadRef.current = false;
      setBlockedNav(null);
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
    isInitialRestoredLoadRef.current = false;
    setBlockedNav(null);
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
    isInitialRestoredLoadRef.current = false;
    setBlockedNav(null);
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
    setBlockedNav(null);
    setIsLoading(true);
    setLoadError(null);
    const webview = webviewRef.current;
    if (webview && isWebviewReady) {
      webview.reload();
    }
  }, [isWebviewReady]);

  const handleCaptureScreenshot = useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview || !isWebviewReady) return;
    try {
      const url = webview.getURL();
      if (!url || url === "about:blank") return;
      const image = await webview.capturePage();
      const pngData = new Uint8Array(image.toPNG());
      await window.electron.clipboard.writeImage(pngData);
    } catch (err) {
      console.error("[BrowserPane] Screenshot capture failed:", err);
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

  const handleToggleConsole = useCallback(() => {
    setBrowserConsoleOpen(id, !isConsoleOpen);
  }, [id, isConsoleOpen, setBrowserConsoleOpen]);

  const handleClearConsole = useCallback(() => {
    const wcId = webContentsIdRef.current;
    if (wcId != null) {
      void window.electron.webview.clearConsoleCapture(wcId, id);
    }
    clearConsoleMessages(id);
  }, [id, clearConsoleMessages]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (blockedNavTimerRef.current) {
        clearTimeout(blockedNavTimerRef.current);
      }
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

    const handleCaptureScreenshotEvent = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      if (!detail || typeof (detail as { id?: unknown }).id !== "string") return;
      if ((detail as { id: string }).id === id) {
        void handleCaptureScreenshot();
      }
    };

    const handleToggleConsoleEvent = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      if (!detail || typeof (detail as { id?: unknown }).id !== "string") return;
      if ((detail as { id: string }).id === id) {
        handleToggleConsole();
      }
    };

    const handleClearConsoleEvent = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      if (!detail || typeof (detail as { id?: unknown }).id !== "string") return;
      if ((detail as { id: string }).id === id) {
        handleClearConsole();
      }
    };

    const handleToggleDevToolsEvent = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      if (!detail || typeof (detail as { id?: unknown }).id !== "string") return;
      if ((detail as { id: string }).id === id) {
        handleToggleDevTools();
      }
    };

    const controller = new AbortController();
    window.addEventListener("daintree:reload-browser", handleReloadEvent, {
      signal: controller.signal,
    });
    window.addEventListener("daintree:browser-navigate", handleNavigateEvent, {
      signal: controller.signal,
    });
    window.addEventListener("daintree:browser-back", handleBackEvent, {
      signal: controller.signal,
    });
    window.addEventListener("daintree:browser-forward", handleForwardEvent, {
      signal: controller.signal,
    });
    window.addEventListener("daintree:browser-set-zoom", handleSetZoomEvent, {
      signal: controller.signal,
    });
    window.addEventListener("daintree:browser-capture-screenshot", handleCaptureScreenshotEvent, {
      signal: controller.signal,
    });
    window.addEventListener("daintree:browser-toggle-console", handleToggleConsoleEvent, {
      signal: controller.signal,
    });
    window.addEventListener("daintree:browser-clear-console", handleClearConsoleEvent, {
      signal: controller.signal,
    });
    window.addEventListener("daintree:browser-toggle-devtools", handleToggleDevToolsEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [
    id,
    handleReload,
    handleNavigate,
    handleBack,
    handleForward,
    handleCaptureScreenshot,
    handleToggleConsole,
    handleClearConsole,
    handleToggleDevTools,
  ]);

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
      isLoading={isLoading}
      urlMightBeStale={false}
      zoomFactor={zoomFactor}
      isConsoleOpen={isConsoleOpen}
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
      onToggleConsole={() =>
        void actionService.dispatch("browser.toggleConsole", { terminalId: id }, { source: "user" })
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
      <div
        className={cn(
          "relative flex-1 min-h-0 flex flex-col bg-surface-canvas",
          isConsoleOpen && "min-h-0"
        )}
      >
        {!hasValidUrl ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
            <div className="flex flex-col items-center text-center max-w-md">
              <h3 className="text-sm font-medium text-daintree-text/70 mb-1">Localhost Browser</h3>
              <p className="text-xs text-daintree-text/50 mb-4 leading-relaxed">
                Preview your local development server. Enter a localhost URL in the address bar
                above to get started.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {["localhost:3000", "localhost:5173", "localhost:8080"].map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => handleNavigate(`http://${example}`)}
                    className="px-3 py-1.5 text-xs font-mono text-daintree-text/50 bg-overlay-soft hover:bg-overlay-medium border border-overlay rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-daintree-accent/50"
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
        ) : loadError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
            <AlertTriangle className="w-6 h-6 text-status-warning mb-3" />
            <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
              Unable to Display Page
            </h3>
            <p className="text-xs text-daintree-text/50 text-center mb-3 max-w-md">{loadError}</p>
            <button
              type="button"
              onClick={handleOpenExternal}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-overlay-soft transition-colors group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-daintree-accent/50"
            >
              <ExternalLink className="h-3.5 w-3.5 text-daintree-text/50 group-hover:text-daintree-text/70 transition-colors" />
              <span className="text-xs text-daintree-text/50 group-hover:text-daintree-text/70 transition-colors">
                Open in External Browser
              </span>
            </button>
          </div>
        ) : isEvicted ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
            <p className="text-xs text-daintree-text/50">Reclaimed for memory</p>
          </div>
        ) : (
          <>
            {blockedNav && (
              <div className="flex items-center gap-2 px-3 py-1.5 text-xs bg-status-warning/10 border-b border-status-warning/20 text-daintree-text/80">
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-status-warning" />
                <span className="truncate flex-1">
                  Navigation to external site blocked:{" "}
                  {(() => {
                    try {
                      return new URL(blockedNav.url).hostname;
                    } catch {
                      return blockedNav.url;
                    }
                  })()}
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
                    Open in External Browser
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setBlockedNav(null)}
                  className="shrink-0 text-daintree-text/40 hover:text-daintree-text/70 transition-colors"
                  aria-label="Dismiss"
                >
                  ×
                </button>
              </div>
            )}
            <div className="relative flex-1 min-h-0">
              {isDragging && <div className="absolute inset-0 z-10 bg-transparent" />}
              {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-daintree-bg z-10">
                  <Spinner size="2xl" className="text-status-info" />
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
            {isConsoleOpen && (
              <ConsolePanel
                paneId={id}
                height={200}
                webContentsId={webContentsIdRef.current ?? undefined}
              />
            )}
          </>
        )}
      </div>
    </ContentPanel>
  );
}
