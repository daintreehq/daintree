import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { AlertTriangle, ExternalLink, Home } from "lucide-react";
import { useTerminalStore, useBrowserStateStore } from "@/store";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { BrowserToolbar } from "./BrowserToolbar";
import { normalizeBrowserUrl, extractHostPort, isValidBrowserUrl } from "./browserUtils";
import { actionService } from "@/services/ActionService";

interface BrowserHistory {
  past: string[];
  present: string;
  future: string[];
}

export interface BrowserPaneProps extends BasePanelProps {
  initialUrl: string;
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
}: BrowserPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const setBrowserUrl = useTerminalStore((state) => state.setBrowserUrl);
  const browserStateStore = useBrowserStateStore();

  // Initialize history from persisted state or initialUrl
  const [history, setHistory] = useState<BrowserHistory>(() => {
    const savedState = browserStateStore.getState(id);
    if (savedState) {
      return {
        past: savedState.history.past,
        present: savedState.url,
        future: savedState.history.future,
      };
    }
    const normalized = normalizeBrowserUrl(initialUrl);
    return {
      past: [],
      present: normalized.url || initialUrl,
      future: [],
    };
  });

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Track if user has navigated inside the iframe (URL might be stale)
  const [urlMightBeStale, setUrlMightBeStale] = useState(false);
  // Track the last URL we set on the iframe to detect in-iframe navigation
  const lastSetUrlRef = useRef<string>(history.present);

  const currentUrl = history.present;
  const canGoBack = history.past.length > 0;
  const canGoForward = history.future.length > 0;
  const hasValidUrl = isValidBrowserUrl(currentUrl);

  // Sync URL changes to store
  useEffect(() => {
    setBrowserUrl(id, currentUrl);
  }, [id, currentUrl, setBrowserUrl]);

  // Persist state changes (debounced via effect cleanup)
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      browserStateStore.updateUrl(id, currentUrl, {
        past: history.past,
        future: history.future,
      });
    }, 300);
    return () => clearTimeout(timeoutId);
  }, [id, currentUrl, history.past, history.future, browserStateStore]);

  const handleNavigate = useCallback((url: string) => {
    const result = normalizeBrowserUrl(url);
    if (result.error || !result.url) return;

    setHistory((prev) => ({
      past: [...prev.past, prev.present],
      present: result.url!,
      future: [],
    }));
    setIsLoading(true);
    setLoadError(null);
    setUrlMightBeStale(false);
    lastSetUrlRef.current = result.url!;

    // Update iframe src directly instead of remounting
    if (iframeRef.current) {
      iframeRef.current.src = result.url!;
    }
  }, []);

  const handleBack = useCallback(() => {
    setHistory((prev) => {
      if (prev.past.length === 0) return prev;
      const newPast = [...prev.past];
      const previousUrl = newPast.pop()!;

      // Update iframe directly
      if (iframeRef.current) {
        iframeRef.current.src = previousUrl;
      }
      lastSetUrlRef.current = previousUrl;

      return {
        past: newPast,
        present: previousUrl,
        future: [prev.present, ...prev.future],
      };
    });
    setIsLoading(true);
    setLoadError(null);
    setUrlMightBeStale(false);
  }, []);

  const handleForward = useCallback(() => {
    setHistory((prev) => {
      if (prev.future.length === 0) return prev;
      const [nextUrl, ...restFuture] = prev.future;

      // Update iframe directly
      if (iframeRef.current) {
        iframeRef.current.src = nextUrl;
      }
      lastSetUrlRef.current = nextUrl;

      return {
        past: [...prev.past, prev.present],
        present: nextUrl,
        future: restFuture,
      };
    });
    setIsLoading(true);
    setLoadError(null);
    setUrlMightBeStale(false);
  }, []);

  const handleReload = useCallback(() => {
    setIsLoading(true);
    setLoadError(null);
    if (iframeRef.current) {
      // Try to reload via contentWindow first (works if same-origin)
      try {
        iframeRef.current.contentWindow?.location.reload();
      } catch {
        // Cross-origin: toggle src to force reload
        const currentSrc = iframeRef.current.src;
        iframeRef.current.src = "";
        requestAnimationFrame(() => {
          if (iframeRef.current) {
            iframeRef.current.src = currentSrc;
          }
        });
      }
    }
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
    return () => controller.abort();
  }, [id, handleReload, handleNavigate, handleBack, handleForward]);

  const handleOpenExternal = useCallback(() => {
    if (!hasValidUrl) return;
    void actionService.dispatch("browser.openExternal", { terminalId: id }, { source: "user" });
  }, [hasValidUrl, id]);

  const handleIframeLoad = useCallback(() => {
    setIsLoading(false);
    // After load, mark URL as potentially stale since user may navigate inside iframe
    // We set a small delay to avoid marking it stale immediately on initial load
    const timeoutId = setTimeout(() => {
      setUrlMightBeStale(true);
    }, 1000);
    return () => clearTimeout(timeoutId);
  }, []);

  const handleIframeError = useCallback(() => {
    setIsLoading(false);
    setLoadError("Failed to load page. The site may refuse embedding or be unavailable.");
  }, []);

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
      urlMightBeStale={urlMightBeStale}
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
    >
      <div className="flex-1 min-h-0 bg-white">
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
            {isLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-canopy-bg z-10">
                <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={currentUrl}
              title={displayTitle}
              className="w-full h-full border-0"
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              onLoad={handleIframeLoad}
              onError={handleIframeError}
            />
          </>
        )}
      </div>
    </ContentPanel>
  );
}
