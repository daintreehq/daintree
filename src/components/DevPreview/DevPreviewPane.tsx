import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { AlertTriangle, RotateCw, ExternalLink, Settings, Wand2 } from "lucide-react";
import { useTerminalStore } from "@/store";
import { useProjectStore } from "@/store/projectStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import type { BrowserHistory } from "@shared/types/domain";
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

  const currentUrl = history.present;
  const canGoBack = history.past.length > 0;
  const canGoForward = history.future.length > 0;
  const isUnconfigured = Boolean(currentProjectId) && !isSettingsLoading && !devCommand;

  const setWebviewNode = useCallback((node: Electron.WebviewTag | null) => {
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
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

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
      }, 30000);
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
  }, [webviewElement]);

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
  }, [zoomFactor, webviewElement]);

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

        <div className="relative flex-1 min-h-0 bg-white">
          {isRestarting || status === "starting" || status === "installing" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-canopy-bg">
              <div className="w-12 h-12 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mb-4" />
              <p className="text-sm text-canopy-text/60">
                {isRestarting ? "Restarting" : status === "installing" ? "Installing" : "Starting"}
                ...
              </p>
            </div>
          ) : status === "error" && error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-canopy-bg text-canopy-text p-6">
              <AlertTriangle className="w-6 h-6 text-amber-400 mb-3" />
              <h3 className="text-sm font-medium text-canopy-text/70 mb-1">Dev Server Error</h3>
              <p className="text-xs text-canopy-text/50 text-center mb-3 max-w-md">
                {error.message}
              </p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleRetry}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-white/5 transition-colors group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent/50"
                >
                  <RotateCw className="h-3.5 w-3.5 text-canopy-accent/70 group-hover:text-canopy-accent transition-colors" />
                  <span className="text-xs text-canopy-accent/70 group-hover:text-canopy-accent transition-colors">
                    Retry
                  </span>
                </button>
                {currentUrl && (
                  <button
                    type="button"
                    onClick={handleOpenExternal}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-white/5 transition-colors group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent/50"
                  >
                    <ExternalLink className="h-3.5 w-3.5 text-canopy-text/50 group-hover:text-canopy-text/70 transition-colors" />
                    <span className="text-xs text-canopy-text/50 group-hover:text-canopy-text/70 transition-colors">
                      Open External
                    </span>
                  </button>
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
                      <button
                        type="button"
                        onClick={handleAutoDetect}
                        disabled={isAutoDetecting || isSettingsLoading}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-white/5 transition-colors group disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent/50"
                      >
                        <Wand2 className="h-3.5 w-3.5 text-canopy-accent/70 group-hover:text-canopy-accent transition-colors" />
                        <span className="text-xs text-canopy-accent/70 group-hover:text-canopy-accent transition-colors">
                          {isAutoDetecting
                            ? "Detecting..."
                            : `Use \`${findDevServerCandidate(allDetectedRunners)?.command}\``}
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleOpenSettings}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-white/5 transition-colors group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent/50"
                    >
                      <Settings className="h-3.5 w-3.5 text-canopy-text/50 group-hover:text-canopy-text/70 transition-colors" />
                      <span className="text-xs text-canopy-text/50 group-hover:text-canopy-text/70 transition-colors">
                        Open Project Settings
                      </span>
                    </button>
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
          ) : (
            <>
              {isDragging && <div className="absolute inset-0 z-10 bg-transparent" />}
              <webview
                ref={setWebviewNode}
                src={currentUrl}
                partition={webviewPartition}
                className={cn(
                  "w-full h-full border-0",
                  isDragging && "invisible pointer-events-none"
                )}
              />
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
