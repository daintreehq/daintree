import { useState, useCallback, useRef, useEffect } from "react";
import { AlertTriangle, RotateCw, ExternalLink } from "lucide-react";
import { useTerminalStore } from "@/store";
import type { BrowserHistory } from "@shared/types/domain";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { BrowserToolbar } from "../Browser/BrowserToolbar";
import { normalizeBrowserUrl } from "../Browser/browserUtils";
import { useDevServer } from "@/hooks/useDevServer";
import { DevPreviewToolbar } from "./DevPreviewToolbar";
import { ConsoleDrawer } from "./ConsoleDrawer";
import { useIsDragging } from "@/components/DragDrop";
import { cn } from "@/lib/utils";

export interface DevPreviewPaneProps extends BasePanelProps {
  cwd: string;
  worktreeId?: string;
}

export function DevPreviewPane({
  id,
  title,
  cwd,
  worktreeId,
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
}: DevPreviewPaneProps) {
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const setBrowserUrl = useTerminalStore((state) => state.setBrowserUrl);
  const setBrowserHistory = useTerminalStore((state) => state.setBrowserHistory);
  const setBrowserZoom = useTerminalStore((state) => state.setBrowserZoom);
  const isDragging = useIsDragging();

  const terminal = useTerminalStore((state) => state.getTerminal(id));
  const devCommand = terminal?.devCommand || "";

  const { status, url, terminalId, error, start, restart, isRestarting } = useDevServer({
    panelId: id,
    devCommand,
    cwd,
    worktreeId,
  });

  const [history, setHistory] = useState<BrowserHistory>(() => {
    const saved = terminal?.browserHistory;
    if (
      saved &&
      Array.isArray(saved.past) &&
      Array.isArray(saved.future) &&
      typeof saved.present === "string"
    ) {
      return {
        past: saved.past,
        present: saved.present || "",
        future: saved.future,
      };
    }
    return {
      past: [],
      present: "",
      future: [],
    };
  });

  const [zoomFactor, setZoomFactor] = useState<number>(() => {
    const savedZoom = terminal?.browserZoom ?? 1.0;
    return Number.isFinite(savedZoom) ? Math.max(0.25, Math.min(2.0, savedZoom)) : 1.0;
  });

  const [isLoading, setIsLoading] = useState(false);
  const lastSetUrlRef = useRef<string>("");
  const [isWebviewReady, setIsWebviewReady] = useState(false);

  const currentUrl = history.present;
  const canGoBack = history.past.length > 0;
  const canGoForward = history.future.length > 0;

  useEffect(() => {
    if (url && url !== currentUrl) {
      setHistory((prev) => ({
        past: prev.present ? [...prev.past, prev.present] : prev.past,
        present: url,
        future: [],
      }));
      lastSetUrlRef.current = url;
    }
  }, [url, currentUrl]);

  useEffect(() => {
    if (currentUrl) {
      setBrowserUrl(id, currentUrl);
    }
  }, [id, currentUrl, setBrowserUrl]);

  useEffect(() => {
    setBrowserHistory(id, history);
  }, [id, history, setBrowserHistory]);

  useEffect(() => {
    setBrowserZoom(id, zoomFactor);
  }, [id, zoomFactor, setBrowserZoom]);

  useEffect(() => {
    if (devCommand && status === "stopped" && !isRestarting) {
      start();
    }
  }, [devCommand, status, start, isRestarting]);

  const handleNavigate = useCallback((rawUrl: string) => {
    const normalized = normalizeBrowserUrl(rawUrl);
    if (normalized.url) {
      setHistory((prev) => ({
        past: prev.present ? [...prev.past, prev.present] : prev.past,
        present: normalized.url!,
        future: [],
      }));
      lastSetUrlRef.current = normalized.url;
    }
  }, []);

  const handleBack = useCallback(() => {
    if (canGoBack) {
      setHistory((prev) => {
        const newPast = [...prev.past];
        const newPresent = newPast.pop()!;
        return {
          past: newPast,
          present: newPresent,
          future: [prev.present, ...prev.future],
        };
      });
    }
  }, [canGoBack]);

  const handleForward = useCallback(() => {
    if (canGoForward) {
      setHistory((prev) => {
        const newFuture = [...prev.future];
        const newPresent = newFuture.shift()!;
        return {
          past: [...prev.past, prev.present],
          present: newPresent,
          future: newFuture,
        };
      });
    }
  }, [canGoForward]);

  const handleReload = useCallback(() => {
    webviewRef.current?.reload();
  }, []);

  const handleOpenExternal = useCallback(() => {
    if (currentUrl) {
      window.electron.system.openExternal(currentUrl);
    }
  }, [currentUrl]);

  const handleZoomChange = useCallback((newZoom: number) => {
    setZoomFactor(newZoom);
    if (webviewRef.current) {
      webviewRef.current.setZoomFactor(newZoom);
    }
  }, []);

  const handleRestart = useCallback(() => {
    setHistory({ past: [], present: "", future: [] });
    lastSetUrlRef.current = "";
    setIsLoading(false);
    setIsWebviewReady(false);
    restart();
  }, [restart]);

  const handleRetry = useCallback(() => {
    start();
  }, [start]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !isWebviewReady) return undefined;

    const handleDidStartLoading = () => setIsLoading(true);
    const handleDidStopLoading = () => setIsLoading(false);
    const handleDidFinishLoad = () => setIsLoading(false);

    const handleDidNavigate = (e: Electron.DidNavigateEvent) => {
      const navigatedUrl = e.url;
      if (navigatedUrl !== lastSetUrlRef.current) {
        setHistory((prev) => ({
          past: prev.present ? [...prev.past, prev.present] : prev.past,
          present: navigatedUrl,
          future: [],
        }));
      }
    };

    const handleDidNavigateInPage = (e: Electron.DidNavigateInPageEvent) => {
      const navigatedUrl = e.url;
      if (navigatedUrl !== lastSetUrlRef.current) {
        setHistory((prev) => ({
          past: prev.present ? [...prev.past, prev.present] : prev.past,
          present: navigatedUrl,
          future: [],
        }));
      }
    };

    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-finish-load", handleDidFinishLoad);
    webview.addEventListener("did-navigate", handleDidNavigate as any);
    webview.addEventListener("did-navigate-in-page", handleDidNavigateInPage as any);

    return () => {
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-finish-load", handleDidFinishLoad);
      webview.removeEventListener("did-navigate", handleDidNavigate as any);
      webview.removeEventListener("did-navigate-in-page", handleDidNavigateInPage as any);
    };
  }, [isWebviewReady]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return undefined;

    const handleDomReady = () => {
      setIsWebviewReady(true);
      webview.setZoomFactor(zoomFactor);
    };

    webview.addEventListener("dom-ready", handleDomReady);
    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
    };
  }, [zoomFactor, currentUrl]);

  useEffect(() => {
    if (isWebviewReady && currentUrl && currentUrl !== lastSetUrlRef.current) {
      lastSetUrlRef.current = currentUrl;
      if (webviewRef.current && webviewRef.current.src !== currentUrl) {
        webviewRef.current.src = currentUrl;
      }
    }
  }, [currentUrl, isWebviewReady]);

  return (
    <ContentPanel
      id={id}
      title={title}
      isFocused={isFocused}
      isMaximized={isMaximized}
      location={location}
      onFocus={onFocus}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleChange={onTitleChange}
      onMinimize={onMinimize}
      onRestore={onRestore}
      isTrashing={isTrashing}
      gridPanelCount={gridPanelCount}
      kind="dev-preview"
    >
      <div className="flex flex-col h-full">
        <DevPreviewToolbar
          status={status}
          url={currentUrl || null}
          isRestarting={isRestarting}
          onRestart={handleRestart}
          onOpenExternal={handleOpenExternal}
        />
        <BrowserToolbar
          terminalId={id}
          url={currentUrl}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          isLoading={isLoading}
          zoomFactor={zoomFactor}
          onNavigate={handleNavigate}
          onBack={handleBack}
          onForward={handleForward}
          onReload={handleReload}
          onOpenExternal={handleOpenExternal}
          onZoomChange={handleZoomChange}
        />

        <div className="relative flex-1 min-h-0 bg-white">
          {status === "error" && error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-canopy-bg text-canopy-text p-6">
              <AlertTriangle className="w-12 h-12 text-amber-400 mb-4" />
              <h3 className="text-lg font-medium mb-2">Dev Server Error</h3>
              <p className="text-sm text-canopy-text/60 text-center mb-4 max-w-md">
                {error.message}
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleRetry}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-lg border border-blue-500/30 transition-colors"
                >
                  <RotateCw className="w-4 h-4" />
                  Retry
                </button>
                {currentUrl && (
                  <button
                    type="button"
                    onClick={handleOpenExternal}
                    className="flex items-center gap-2 px-4 py-2 bg-gray-500/20 hover:bg-gray-500/30 text-gray-400 rounded-lg border border-gray-500/30 transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Open External
                  </button>
                )}
              </div>
            </div>
          ) : status === "starting" || status === "installing" || isRestarting ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-canopy-bg">
              <div className="w-12 h-12 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mb-4" />
              <p className="text-sm text-canopy-text/60">
                {isRestarting ? "Restarting" : status === "installing" ? "Installing" : "Starting"}...
              </p>
            </div>
          ) : !currentUrl ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-canopy-bg text-canopy-text p-6">
              <div className="flex flex-col items-center text-center max-w-md">
                <h3 className="text-lg font-medium mb-2">Waiting for Dev Server</h3>
                <p className="text-sm text-canopy-text/60 mb-6 leading-relaxed">
                  The development server will appear here once it starts and a URL is detected.
                </p>
                {!devCommand && (
                  <p className="text-xs text-amber-400/80">
                    No dev command configured for this panel.
                  </p>
                )}
              </div>
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
                partition="persist:dev-preview"
                className={cn(
                  "w-full h-full border-0",
                  isDragging && "invisible pointer-events-none"
                )}
              />
            </>
          )}
        </div>

        {terminalId && <ConsoleDrawer terminalId={terminalId} defaultOpen={false} />}
      </div>
    </ContentPanel>
  );
}
