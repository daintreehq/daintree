import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { AlertTriangle, ExternalLink, Home } from "lucide-react";
import { useTerminalStore } from "@/store";
import { ContentPane, type BasePaneProps } from "@/components/Pane";
import { BrowserToolbar } from "./BrowserToolbar";
import { normalizeBrowserUrl, extractHostPort, isValidBrowserUrl } from "./browserUtils";

interface BrowserHistory {
  past: string[];
  present: string;
  future: string[];
}

export interface BrowserPaneProps extends BasePaneProps {
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
  gridTerminalCount,
}: BrowserPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const setBrowserUrl = useTerminalStore((state) => state.setBrowserUrl);

  const [history, setHistory] = useState<BrowserHistory>(() => {
    const normalized = normalizeBrowserUrl(initialUrl);
    return {
      past: [],
      present: normalized.url || initialUrl,
      future: [],
    };
  });

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [navigationId, setNavigationId] = useState(0);

  const currentUrl = history.present;
  const canGoBack = history.past.length > 0;
  const canGoForward = history.future.length > 0;
  const hasValidUrl = isValidBrowserUrl(currentUrl);

  // Sync URL changes to store
  useEffect(() => {
    setBrowserUrl(id, currentUrl);
  }, [id, currentUrl, setBrowserUrl]);

  const handleNavigate = useCallback((url: string) => {
    const result = normalizeBrowserUrl(url);
    if (result.error || !result.url) return;

    setHistory((prev) => ({
      past: [...prev.past, prev.present],
      present: result.url!,
      future: [],
    }));
    setNavigationId((id) => id + 1);
    setIsLoading(true);
    setLoadError(null);
  }, []);

  const handleBack = useCallback(() => {
    setHistory((prev) => {
      if (prev.past.length === 0) return prev;
      const newPast = [...prev.past];
      const previousUrl = newPast.pop()!;
      return {
        past: newPast,
        present: previousUrl,
        future: [prev.present, ...prev.future],
      };
    });
    setNavigationId((id) => id + 1);
    setIsLoading(true);
    setLoadError(null);
  }, []);

  const handleForward = useCallback(() => {
    setHistory((prev) => {
      if (prev.future.length === 0) return prev;
      const [nextUrl, ...restFuture] = prev.future;
      return {
        past: [...prev.past, prev.present],
        present: nextUrl,
        future: restFuture,
      };
    });
    setNavigationId((id) => id + 1);
    setIsLoading(true);
    setLoadError(null);
  }, []);

  const handleReload = useCallback(() => {
    setNavigationId((id) => id + 1);
    setIsLoading(true);
    setLoadError(null);
    if (iframeRef.current?.contentWindow) {
      try {
        iframeRef.current.contentWindow.location.reload();
      } catch {
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

  const handleOpenExternal = useCallback(() => {
    if (hasValidUrl) {
      window.electron.system.openExternal(currentUrl);
    }
  }, [currentUrl, hasValidUrl]);

  const handleIframeLoad = useCallback(
    (currentNavId: number) => () => {
      if (navigationId === currentNavId) {
        setIsLoading(false);
      }
    },
    [navigationId]
  );

  const handleIframeError = useCallback(
    (currentNavId: number) => () => {
      if (navigationId === currentNavId) {
        setIsLoading(false);
        setLoadError("Failed to load page. The site may refuse embedding or be unavailable.");
      }
    },
    [navigationId]
  );

  const displayTitle = useMemo(() => {
    if (title && title !== "Browser") return title;
    return extractHostPort(currentUrl);
  }, [title, currentUrl]);

  const browserToolbar = (
    <BrowserToolbar
      url={currentUrl}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      isLoading={isLoading}
      onNavigate={handleNavigate}
      onBack={handleBack}
      onForward={handleForward}
      onReload={handleReload}
      onOpenExternal={handleOpenExternal}
    />
  );

  return (
    <ContentPane
      id={id}
      title={displayTitle}
      kind="browser"
      isFocused={isFocused}
      isMaximized={isMaximized}
      location={location}
      isTrashing={isTrashing}
      gridTerminalCount={gridTerminalCount}
      onFocus={onFocus}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleChange={onTitleChange}
      onMinimize={onMinimize}
      onRestore={onRestore}
      toolbar={browserToolbar}
    >
      <div className="h-full bg-white">
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
              key={navigationId}
              ref={iframeRef}
              src={currentUrl}
              title={displayTitle}
              className="w-full h-full border-0"
              sandbox="allow-scripts allow-forms"
              onLoad={handleIframeLoad(navigationId)}
              onError={handleIframeError(navigationId)}
            />
          </>
        )}
      </div>
    </ContentPane>
  );
}
