import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { AlertTriangle, RotateCw, ExternalLink, Settings, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTerminalStore } from "@/store";
import { useProjectStore } from "@/store/projectStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import type { BrowserHistory } from "@shared/types/browser";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { BrowserToolbar } from "../Browser/BrowserToolbar";
import { normalizeBrowserUrl } from "../Browser/browserUtils";
import {
  goBackBrowserHistory,
  goForwardBrowserHistory,
  initializeBrowserHistory,
  pushBrowserHistory,
} from "../Browser/historyUtils";
import { useDevServer } from "@/hooks/useDevServer";
import { ConsoleDrawer } from "./ConsoleDrawer";
import { useIsDragging } from "@/components/DragDrop";
import { cn } from "@/lib/utils";
import { shouldAdoptDetectedDevServerUrl } from "./urlSync";
import { findDevServerCandidate } from "@/utils/devServerDetection";
import { useProjectSettings } from "@/hooks/useProjectSettings";
import { projectClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { useWebviewThrottle } from "@/hooks/useWebviewThrottle";
import { useHasBeenVisible } from "@/hooks/useHasBeenVisible";
import { useWebviewEviction } from "@/hooks/useWebviewEviction";
import { useWebviewDialog } from "@/hooks/useWebviewDialog";
import { WebviewDialog } from "../Browser/WebviewDialog";
import { FindBar } from "../Browser/FindBar";
import { useFindInPage } from "@/hooks/useFindInPage";

const scrollCache = new Map<string, { url: string; scrollY: number }>();

export function _resetScrollCacheForTests(): void {
  scrollCache.clear();
}

export interface DevPreviewPaneProps extends BasePanelProps {
  cwd: string;
  worktreeId?: string;
}

function sanitizePartitionToken(value: string | undefined): string {
  const token = (value ?? "default").trim().toLowerCase();
  const sanitized = token.replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-");
  return sanitized || "default";
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
  const [webviewElement, setWebviewElement] = useState<Electron.WebviewTag | null>(null);
  const setBrowserUrl = useTerminalStore((state) => state.setBrowserUrl);
  const setBrowserHistory = useTerminalStore((state) => state.setBrowserHistory);
  const setBrowserZoom = useTerminalStore((state) => state.setBrowserZoom);
  const setDevPreviewConsoleOpen = useTerminalStore((state) => state.setDevPreviewConsoleOpen);
  const currentProjectId = useProjectStore((state) => state.currentProject?.id);
  const projectSettings = useProjectSettingsStore((state) => state.settings);
  const projectEnv = projectSettings?.environmentVariables;
  const isDragging = useIsDragging();

  const terminal = useTerminalStore((state) => state.getTerminal(id));
  const devCommand =
    terminal?.devCommand?.trim() || projectSettings?.devServerCommand?.trim() || "";

  const { status, url, terminalId, error, start, restart, isRestarting } = useDevServer({
    panelId: id,
    devCommand,
    cwd,
    worktreeId,
    env: projectEnv,
  });

  const webviewPartition = useMemo(() => {
    const projectToken = sanitizePartitionToken(currentProjectId);
    const worktreeToken = sanitizePartitionToken(worktreeId ?? "main");
    const panelToken = sanitizePartitionToken(id);
    return `persist:dev-preview-${projectToken}-${worktreeToken}-${panelToken}`;
  }, [currentProjectId, worktreeId, id]);

  const [history, setHistory] = useState<BrowserHistory>(() => {
    const saved = terminal?.browserHistory;
    return initializeBrowserHistory(saved, "");
  });

  const [zoomFactor, setZoomFactor] = useState<number>(() => {
    const savedZoom = terminal?.browserZoom ?? 1.0;
    return Number.isFinite(savedZoom) ? Math.max(0.25, Math.min(2.0, savedZoom)) : 1.0;
  });

  const [isLoading, setIsLoading] = useState(false);
  const lastSetUrlRef = useRef<string>("");
  const [isWebviewReady, setIsWebviewReady] = useState(false);
  const [consoleTerminalId, setConsoleTerminalId] = useState<string | null>(terminalId);
  const loadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const failLoadRetryRef = useRef<NodeJS.Timeout | null>(null);
  const failLoadRetryCountRef = useRef<number>(0);
  const isConsoleOpen = terminal?.devPreviewConsoleOpen ?? false;
  const [isAutoDetecting, setIsAutoDetecting] = useState(false);
  const { saveSettings } = useProjectSettings();
  const allDetectedRunners = useProjectSettingsStore((state) => state.allDetectedRunners);
  const isSettingsLoading = useProjectSettingsStore((state) => state.isLoading);
  const isMountedRef = useRef(true);
  const prevStatusRef = useRef(status);
  const loadTimeoutMs =
    Math.min(Math.max(projectSettings?.devServerLoadTimeout ?? 30, 1), 120) * 1000;

  const hasBeenVisible = useHasBeenVisible(id, location);

  const currentUrl = history.present;
  const canGoBack = history.past.length > 0;
  const canGoForward = history.future.length > 0;
  const isUnconfigured = Boolean(currentProjectId) && !isSettingsLoading && !devCommand;

  const { isEvicted, evictingRef } = useWebviewEviction(id, location);

  const setWebviewNode = useCallback(
    (node: Electron.WebviewTag | null) => {
      if (!node && webviewRef.current) {
        try {
          const prevWebview = webviewRef.current;
          const currentWebviewUrl = prevWebview.getURL();
          if (currentWebviewUrl && currentWebviewUrl !== "about:blank") {
            prevWebview
              .executeJavaScript("window.scrollY")
              .then((scrollY: number) => {
                if (typeof scrollY === "number" && Number.isFinite(scrollY)) {
                  scrollCache.set(id, { url: currentWebviewUrl, scrollY });
                }
              })
              .catch(() => {});
          }
        } catch {
          // Webview already detached
        }
      }
      webviewRef.current = node;
      if (node) {
        lastSetUrlRef.current = "";
        failLoadRetryCountRef.current = 0;
        if (failLoadRetryRef.current) {
          clearTimeout(failLoadRetryRef.current);
          failLoadRetryRef.current = null;
        }
      }
      setWebviewElement(node);
    },
    [id]
  );

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = status;

    if (prevStatus === "running" && status !== "running" && webviewElement) {
      try {
        const currentWebviewUrl = webviewElement.getURL();
        if (currentWebviewUrl && currentWebviewUrl !== "about:blank") {
          webviewElement
            .executeJavaScript("window.scrollY")
            .then((scrollY: number) => {
              if (typeof scrollY === "number" && Number.isFinite(scrollY)) {
                scrollCache.set(id, { url: currentWebviewUrl, scrollY });
              }
            })
            .catch(() => {});
        }
      } catch {
        // Webview already detached
      }
    }
  }, [status, id, webviewElement]);

  useEffect(() => {
    setConsoleTerminalId(terminalId);
  }, [terminalId]);

  useEffect(() => {
    if (url && shouldAdoptDetectedDevServerUrl(url, currentUrl)) {
      setHistory((prev) => pushBrowserHistory(prev, url));
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

  const handleNavigate = useCallback((rawUrl: string) => {
    const normalized = normalizeBrowserUrl(rawUrl);
    if (normalized.url) {
      setHistory((prev) => pushBrowserHistory(prev, normalized.url!));
      lastSetUrlRef.current = normalized.url;
    }
  }, []);

  const handleBack = useCallback(() => {
    if (canGoBack) {
      setHistory((prev) => goBackBrowserHistory(prev));
    }
  }, [canGoBack]);

  const handleForward = useCallback(() => {
    if (canGoForward) {
      setHistory((prev) => goForwardBrowserHistory(prev));
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

  const handleRetry = useCallback(() => {
    start();
  }, [start]);

  const handleHardRestart = useCallback(() => {
    scrollCache.delete(id);
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
    setHistory(initializeBrowserHistory(undefined, ""));
    setBrowserUrl(id, "");
    lastSetUrlRef.current = "";
    setIsLoading(false);
    setIsWebviewReady(false);
    void restart();
  }, [id, restart, setBrowserUrl]);

  const handleAutoDetect = useCallback(async () => {
    if (!currentProjectId || isAutoDetecting) return;

    setIsAutoDetecting(true);
    try {
      const freshRunners = await projectClient.detectRunners(currentProjectId);
      const candidate = findDevServerCandidate(freshRunners);

      if (!candidate) {
        return;
      }

      const latestSettings = await projectClient.getSettings(currentProjectId);
      if (!latestSettings) {
        return;
      }

      await saveSettings({
        ...latestSettings,
        devServerCommand: candidate.command,
        devServerAutoDetected: true,
        devServerDismissed: false,
      });
    } catch (err) {
      console.error("Failed to auto-detect dev server:", err);
    } finally {
      if (isMountedRef.current) {
        setIsAutoDetecting(false);
      }
    }
  }, [currentProjectId, isAutoDetecting, saveSettings]);

  const handleOpenSettings = useCallback(() => {
    void actionService.dispatch("project.settings.open", undefined, { source: "user" });
  }, []);

  useEffect(() => {
    const webview = webviewElement;
    if (!webview) {
      setIsWebviewReady(false);
      return undefined;
    }

    const handleDidStartLoading = () => {
      setIsLoading(true);
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

    const handleDidFinishLoad = () => {
      setIsLoading(false);
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
      setIsLoading(false);
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }

      // Retry on connection-refused errors: the readiness check may have passed
      // a moment before the server was fully reachable from the webview.
      const ERR_CONNECTION_REFUSED = -102;
      const ERR_CONNECTION_RESET = -101;
      if (
        e.isMainFrame &&
        (e.errorCode === ERR_CONNECTION_REFUSED || e.errorCode === ERR_CONNECTION_RESET)
      ) {
        const MAX_RETRIES = 5;
        const retryCount = failLoadRetryCountRef.current;
        if (retryCount < MAX_RETRIES) {
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
                webview.loadURL(urlToRetry).catch(() => {});
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
    };
  }, [webviewElement, loadTimeoutMs, evictingRef]);

  useEffect(() => {
    const webview = webviewElement;
    if (!webview) {
      setIsWebviewReady(false);
      return undefined;
    }

    const handleDomReady = () => {
      setIsWebviewReady(true);
      webview.setZoomFactor(zoomFactor);
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }

      const saved = scrollCache.get(id);
      if (saved) {
        try {
          const loadedUrl = webview.getURL();
          if (loadedUrl === saved.url && saved.scrollY > 0) {
            webview.executeJavaScript(`window.scrollTo(0, ${saved.scrollY})`).catch(() => {});
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
    if (isWebviewReady && currentUrl && currentUrl !== lastSetUrlRef.current) {
      lastSetUrlRef.current = currentUrl;
      if (webviewElement) {
        try {
          const loadedUrl = webviewElement.getURL();
          if (loadedUrl !== currentUrl) {
            webviewElement.loadURL(currentUrl).catch(() => {
              webviewElement.src = currentUrl;
            });
          }
        } catch {
          webviewElement.src = currentUrl;
        }
      }
    }
  }, [currentUrl, isWebviewReady, webviewElement]);

  useEffect(() => {
    return () => {
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
      if (failLoadRetryRef.current) {
        clearTimeout(failLoadRetryRef.current);
      }
    };
  }, []);

  // Blank the webview and clear timers before React unmounts it for faster memory reclamation
  useEffect(() => {
    if (isEvicted && webviewRef.current) {
      try {
        // Save scroll position before eviction
        const wv = webviewRef.current;
        const currentWebviewUrl = wv.getURL();
        if (currentWebviewUrl && currentWebviewUrl !== "about:blank") {
          wv.executeJavaScript("window.scrollY")
            .then((scrollY: number) => {
              if (typeof scrollY === "number" && Number.isFinite(scrollY)) {
                scrollCache.set(id, { url: currentWebviewUrl, scrollY });
              }
            })
            .catch(() => {});
        }
        wv.src = "about:blank";
      } catch {
        // webview may already be detached
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      if (failLoadRetryRef.current) {
        clearTimeout(failLoadRetryRef.current);
        failLoadRetryRef.current = null;
      }
    }
  }, [isEvicted, id]);

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

        <div className="relative flex-1 min-h-0 bg-surface-canvas">
          {isRestarting || status === "starting" || status === "installing" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-canopy-bg">
              <div className="w-12 h-12 border-2 border-status-info border-t-transparent rounded-full animate-spin mb-4" />
              <p className="text-sm text-canopy-text/60">
                {isRestarting ? "Restarting" : status === "installing" ? "Installing" : "Starting"}
                ...
              </p>
            </div>
          ) : status === "error" && error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-canopy-bg text-canopy-text p-6">
              <AlertTriangle className="w-6 h-6 text-status-warning mb-3" />
              <h3 className="text-sm font-medium text-canopy-text/70 mb-1">Dev Server Error</h3>
              <p className="text-xs text-canopy-text/50 text-center mb-3 max-w-md">
                {error.message}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  onClick={handleRetry}
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 px-2.5 py-1.5 group text-canopy-accent/70 hover:text-canopy-accent"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  <span className="text-xs">Retry</span>
                </Button>
                {currentUrl && (
                  <Button
                    onClick={handleOpenExternal}
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 px-2.5 py-1.5 group text-canopy-text/50 hover:text-canopy-text/70"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span className="text-xs">Open External</span>
                  </Button>
                )}
              </div>
            </div>
          ) : !currentUrl || status !== "running" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-canopy-bg text-canopy-text p-6">
              {isUnconfigured ? (
                <div className="flex flex-col items-center text-center max-w-md">
                  <h3 className="text-sm font-medium text-canopy-text/70 mb-1">
                    Configure Dev Server
                  </h3>
                  <p className="text-xs text-canopy-text/50 mb-4 leading-relaxed">
                    No dev server command is configured for this project.
                    {allDetectedRunners && findDevServerCandidate(allDetectedRunners)
                      ? " We found a script in your package.json that looks like a dev server."
                      : " Configure one to preview your application."}
                  </p>
                  <div className="flex flex-col items-center gap-2">
                    {allDetectedRunners && findDevServerCandidate(allDetectedRunners) && (
                      <Button
                        onClick={handleAutoDetect}
                        disabled={isAutoDetecting || isSettingsLoading}
                        variant="ghost"
                        size="sm"
                        className="gap-1.5 px-2.5 py-1.5 group text-canopy-accent/70 hover:text-canopy-accent"
                      >
                        <WandSparkles className="h-3.5 w-3.5" />
                        <span className="text-xs">
                          {isAutoDetecting
                            ? "Detecting..."
                            : `Use \`${findDevServerCandidate(allDetectedRunners)?.command}\``}
                        </span>
                      </Button>
                    )}
                    <Button
                      onClick={handleOpenSettings}
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 px-2.5 py-1.5 group text-canopy-text/50 hover:text-canopy-text/70"
                    >
                      <Settings className="h-3.5 w-3.5" />
                      <span className="text-xs">Open Project Settings</span>
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center text-center max-w-md">
                  <h3 className="text-sm font-medium text-canopy-text/70 mb-1">
                    Waiting for Dev Server
                  </h3>
                  <p className="text-xs text-canopy-text/50 mb-4 leading-relaxed">
                    The development server will appear here once it starts and a URL is detected.
                  </p>
                </div>
              )}
            </div>
          ) : !hasBeenVisible ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-canopy-bg text-canopy-text">
              <p className="text-xs text-canopy-text/50">
                Preview will load when this panel is first viewed
              </p>
            </div>
          ) : isEvicted ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-canopy-bg text-canopy-text p-6">
              <p className="text-xs text-canopy-text/50">Reclaimed for memory</p>
            </div>
          ) : (
            <>
              {isDragging && <div className="absolute inset-0 z-10 bg-transparent" />}
              {findInPage.isOpen && <FindBar find={findInPage} />}
              <webview
                ref={setWebviewNode}
                src={currentUrl}
                partition={webviewPartition}
                // @ts-expect-error React 19 requires "" to emit the attribute; boolean true is silently dropped
                allowpopups=""
                className={cn(
                  "w-full h-full border-0",
                  isDragging && "invisible pointer-events-none"
                )}
              />
              <WebviewDialog dialog={currentDialog} onRespond={handleDialogRespond} />
            </>
          )}
        </div>

        {consoleTerminalId && (
          <ConsoleDrawer
            terminalId={consoleTerminalId}
            status={status}
            isOpen={isConsoleOpen}
            onOpenChange={(nextOpen) => setDevPreviewConsoleOpen(id, nextOpen)}
            isRestarting={isRestarting}
            onHardRestart={handleHardRestart}
          />
        )}
      </div>
    </ContentPanel>
  );
}
