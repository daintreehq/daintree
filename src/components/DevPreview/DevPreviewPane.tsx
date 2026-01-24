import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, Server, Power, Terminal, RotateCw } from "lucide-react";
import { BrowserToolbar } from "@/components/Browser/BrowserToolbar";
import { XtermAdapter } from "@/components/Terminal/XtermAdapter";
import { isValidBrowserUrl, normalizeBrowserUrl } from "@/components/Browser/browserUtils";
import { useIsDragging } from "@/components/DragDrop";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import {
  useBrowserStateStore,
  useProjectStore,
  useTerminalStore,
  useWorktreeSelectionStore,
} from "@/store";
import { panelKindKeepsAliveOnProjectSwitch } from "@shared/config/panelKindRegistry";
import type { DevPreviewStatus } from "@shared/types/ipc/devPreview";

interface BrowserHistory {
  past: string[];
  present: string;
  future: string[];
}

const STATUS_STYLES: Record<DevPreviewStatus, { label: string; dot: string; text: string }> = {
  installing: {
    label: "Installing",
    dot: "bg-[var(--color-status-warning)]",
    text: "text-[var(--color-status-warning)]",
  },
  starting: {
    label: "Starting",
    dot: "bg-[var(--color-status-info)]",
    text: "text-[var(--color-status-info)]",
  },
  running: {
    label: "Running",
    dot: "bg-[var(--color-status-success)]",
    text: "text-[var(--color-status-success)]",
  },
  error: {
    label: "Error",
    dot: "bg-[var(--color-status-error)]",
    text: "text-[var(--color-status-error)]",
  },
  stopped: {
    label: "Stopped",
    dot: "bg-canopy-text/40",
    text: "text-canopy-text/50",
  },
};

const AUTO_RELOAD_MAX_ATTEMPTS = 3;
const AUTO_RELOAD_INITIAL_DELAY_MS = 1500;
const AUTO_RELOAD_RETRY_DELAY_MS = 800;
const AUTO_RELOAD_WINDOW_MS = 15000;
const AUTO_RELOAD_ERROR_CODES = new Set([-102, -105, -106, -118]);

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
  const [status, setStatus] = useState<DevPreviewStatus>("starting");
  const [message, setMessage] = useState("Starting dev server...");
  const [error, setError] = useState<string | undefined>(undefined);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isBrowserOnly, setIsBrowserOnly] = useState(false);
  const [ptyId, setPtyId] = useState<string>("");
  const [showTerminal, setShowTerminal] = useState(false);
  const [history, setHistory] = useState<BrowserHistory>(() => ({
    past: [],
    present: "",
    future: [],
  }));
  const [zoomFactor, setZoomFactor] = useState<number>(() => {
    const savedState = useBrowserStateStore.getState().getState(id, worktreeId);
    const savedZoom = savedState?.zoomFactor ?? 1.0;
    return Number.isFinite(savedZoom) ? Math.max(0.25, Math.min(2.0, savedZoom)) : 1.0;
  });
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [webviewLoadError, setWebviewLoadError] = useState<string | null>(null);
  const [isWebviewReady, setIsWebviewReady] = useState(false);
  const [wasInactive, setWasInactive] = useState(false);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const pendingUrlRef = useRef<string | null>(null);
  const autoReloadAttemptsRef = useRef(0);
  const autoReloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUrlSetAtRef = useRef(0);
  const hasLoadedRef = useRef(false);
  const lastSetUrlRef = useRef<string>(history.present);
  const shouldAutoReloadRef = useRef(false);
  const isDragging = useIsDragging();
  const setBrowserUrl = useTerminalStore((state) => state.setBrowserUrl);
  const updateBrowserZoomFactor = useBrowserStateStore((state) => state.updateZoomFactor);
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);

  const currentUrl = history.present;
  const canGoBack = history.past.length > 0;
  const canGoForward = history.future.length > 0;
  const hasValidUrl = isValidBrowserUrl(currentUrl);

  const clearAutoReload = useCallback(() => {
    if (autoReloadTimeoutRef.current) {
      clearTimeout(autoReloadTimeoutRef.current);
      autoReloadTimeoutRef.current = null;
    }
  }, []);

  const scheduleAutoReload = useCallback(
    (delayMs: number) => {
      if (!currentUrl) return;
      if (autoReloadTimeoutRef.current) return;
      if (autoReloadAttemptsRef.current >= AUTO_RELOAD_MAX_ATTEMPTS) return;
      const lastUrlSetAt = lastUrlSetAtRef.current || Date.now();
      if (Date.now() - lastUrlSetAt > AUTO_RELOAD_WINDOW_MS) return;
      if (hasLoadedRef.current) return;

      autoReloadTimeoutRef.current = setTimeout(() => {
        autoReloadTimeoutRef.current = null;
        if (!currentUrl || hasLoadedRef.current) return;
        const webview = webviewRef.current;
        if (!webview) return;
        autoReloadAttemptsRef.current += 1;
        webview.loadURL(currentUrl);
      }, delayMs);
    },
    [currentUrl]
  );

  const handleNavigate = useCallback(
    (url: string) => {
      shouldAutoReloadRef.current = false;
      const result = normalizeBrowserUrl(url);
      if (result.error || !result.url) return;

      setHistory((prev) => {
        const past = prev.present ? [...prev.past, prev.present] : prev.past;
        return {
          past,
          present: result.url!,
          future: [],
        };
      });
      setIsLoading(true);
      setWebviewLoadError(null);
      hasLoadedRef.current = false;
      setHasLoaded(false);
      autoReloadAttemptsRef.current = 0;
      clearAutoReload();
      lastSetUrlRef.current = result.url!;

      const webview = webviewRef.current;
      if (webview && isWebviewReady) {
        webview.loadURL(result.url!);
      }

      if (isBrowserOnly) {
        void window.electron.devPreview.setUrl(id, result.url!);
      }
    },
    [clearAutoReload, id, isBrowserOnly, isWebviewReady]
  );

  const handleBack = useCallback(() => {
    shouldAutoReloadRef.current = false;
    setHistory((prev) => {
      if (prev.past.length === 0) return prev;
      const newPast = [...prev.past];
      const previousUrl = newPast.pop()!;
      lastSetUrlRef.current = previousUrl;

      setIsLoading(true);
      setWebviewLoadError(null);
      hasLoadedRef.current = false;
      setHasLoaded(false);
      autoReloadAttemptsRef.current = 0;
      clearAutoReload();

      const webview = webviewRef.current;
      if (webview && isWebviewReady) {
        webview.loadURL(previousUrl);
      }

      const future = prev.present ? [prev.present, ...prev.future] : prev.future;

      return {
        past: newPast,
        present: previousUrl,
        future,
      };
    });
  }, [clearAutoReload, isWebviewReady]);

  const handleForward = useCallback(() => {
    shouldAutoReloadRef.current = false;
    setHistory((prev) => {
      if (prev.future.length === 0) return prev;
      const [nextUrl, ...restFuture] = prev.future;
      lastSetUrlRef.current = nextUrl;

      setIsLoading(true);
      setWebviewLoadError(null);
      hasLoadedRef.current = false;
      setHasLoaded(false);
      autoReloadAttemptsRef.current = 0;
      clearAutoReload();

      const webview = webviewRef.current;
      if (webview && isWebviewReady) {
        webview.loadURL(nextUrl);
      }

      const past = prev.present ? [...prev.past, prev.present] : prev.past;

      return {
        past,
        present: nextUrl,
        future: restFuture,
      };
    });
  }, [clearAutoReload, isWebviewReady]);

  const handleReload = useCallback(() => {
    shouldAutoReloadRef.current = false;
    setIsLoading(true);
    setWebviewLoadError(null);
    hasLoadedRef.current = false;
    setHasLoaded(false);
    autoReloadAttemptsRef.current = 0;
    clearAutoReload();
    lastUrlSetAtRef.current = Date.now();
    const webview = webviewRef.current;
    if (webview && isWebviewReady) {
      webview.reload();
    }
  }, [clearAutoReload, isWebviewReady]);

  const handleServerUrl = useCallback(
    (nextUrl: string) => {
      const normalized = normalizeBrowserUrl(nextUrl);
      const resolvedUrl = normalized.url ?? nextUrl;
      setWebviewLoadError(null);

      if (resolvedUrl === currentUrl) {
        lastSetUrlRef.current = resolvedUrl;
        if (isBrowserOnly) return;
        setIsLoading(true);
        hasLoadedRef.current = false;
        setHasLoaded(false);
        autoReloadAttemptsRef.current = 0;
        clearAutoReload();
        lastUrlSetAtRef.current = Date.now();
        scheduleAutoReload(AUTO_RELOAD_INITIAL_DELAY_MS);
        const webview = webviewRef.current;
        if (webview && isWebviewReady) {
          webview.loadURL(resolvedUrl);
        }
        return;
      }

      shouldAutoReloadRef.current = true;
      setIsLoading(true);
      setHistory({ past: [], present: resolvedUrl, future: [] });
      lastSetUrlRef.current = resolvedUrl;
    },
    [clearAutoReload, currentUrl, isBrowserOnly, isWebviewReady, scheduleAutoReload]
  );

  const handleOpenExternal = useCallback(() => {
    if (!hasValidUrl) return;
    void actionService.dispatch("browser.openExternal", { terminalId: id }, { source: "user" });
  }, [hasValidUrl, id]);

  useEffect(() => {
    const offStatus = window.electron.devPreview.onStatus((payload) => {
      if (payload.panelId !== id) return;
      setStatus(payload.status);
      setMessage(payload.message);
      setError(
        payload.status === "error"
          ? payload.error?.trim() || payload.message || undefined
          : undefined
      );
      setIsBrowserOnly((prev) => prev || payload.message.includes("Browser-only mode"));
      setPtyId(payload.ptyId);
      if (
        payload.status === "running" ||
        payload.status === "error" ||
        payload.status === "stopped"
      ) {
        setIsRestarting(false);
        if (restartTimeoutRef.current) {
          clearTimeout(restartTimeoutRef.current);
          restartTimeoutRef.current = null;
        }
      }
      if (payload.status === "error" || payload.status === "stopped") {
        clearAutoReload();
      }
    });

    const offUrl = window.electron.devPreview.onUrl((payload) => {
      if (payload.panelId !== id) return;
      handleServerUrl(payload.url);
    });

    return () => {
      offStatus();
      offUrl();
      if (restartTimeoutRef.current) {
        clearTimeout(restartTimeoutRef.current);
      }
      clearAutoReload();
    };
  }, [clearAutoReload, handleServerUrl, id]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) {
      setIsWebviewReady(false);
      return;
    }

    const handleDomReady = () => {
      setIsWebviewReady(true);
    };

    const handleDidFailLoad = (event: Electron.DidFailLoadEvent) => {
      if (event.errorCode === -3 || event.errorCode === -6) return;
      hasLoadedRef.current = false;
      setHasLoaded(false);
      setIsLoading(false);
      const isRetryable = AUTO_RELOAD_ERROR_CODES.has(event.errorCode);
      if (isRetryable && autoReloadAttemptsRef.current < AUTO_RELOAD_MAX_ATTEMPTS) {
        const delay = AUTO_RELOAD_RETRY_DELAY_MS * (autoReloadAttemptsRef.current + 1);
        scheduleAutoReload(delay);
        return;
      }
      setWebviewLoadError(
        event.errorDescription || "Failed to load dev server. Check if the server is running."
      );
    };

    const handleDidStartLoading = () => {
      setWebviewLoadError(null);
      hasLoadedRef.current = false;
      setHasLoaded(false);
      setIsLoading(true);
    };

    const handleDidStopLoading = () => {
      hasLoadedRef.current = true;
      autoReloadAttemptsRef.current = 0;
      clearAutoReload();
      setHasLoaded(true);
      setIsLoading(false);
    };

    const handleDidNavigate = (event: Electron.DidNavigateEvent) => {
      const newUrl = event.url;
      if (newUrl !== lastSetUrlRef.current) {
        shouldAutoReloadRef.current = false;
        setHistory((prev) => ({
          past: [...prev.past, prev.present],
          present: newUrl,
          future: [],
        }));
        lastSetUrlRef.current = newUrl;
      }
    };

    const handleDidNavigateInPage = (event: Electron.DidNavigateInPageEvent) => {
      if (!event.isMainFrame) return;
      const newUrl = event.url;
      if (newUrl !== lastSetUrlRef.current) {
        shouldAutoReloadRef.current = false;
        setHistory((prev) => ({
          past: [...prev.past, prev.present],
          present: newUrl,
          future: [],
        }));
        lastSetUrlRef.current = newUrl;
      }
    };

    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-fail-load", handleDidFailLoad);
    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-navigate", handleDidNavigate);
    webview.addEventListener("did-navigate-in-page", handleDidNavigateInPage);

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-fail-load", handleDidFailLoad);
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-navigate", handleDidNavigate);
      webview.removeEventListener("did-navigate-in-page", handleDidNavigateInPage);
    };
  }, [clearAutoReload, scheduleAutoReload]);

  useEffect(() => {
    if (!hasValidUrl) return;
    setBrowserUrl(id, currentUrl);
  }, [currentUrl, hasValidUrl, id, setBrowserUrl]);

  useEffect(() => {
    updateBrowserZoomFactor(id, zoomFactor, worktreeId);
  }, [id, updateBrowserZoomFactor, zoomFactor, worktreeId]);

  // Track when this panel becomes inactive (different worktree selected)
  useEffect(() => {
    const isCurrentlyActive = (worktreeId ?? undefined) === (activeWorktreeId ?? undefined);
    if (!isCurrentlyActive) {
      setWasInactive(true);
    }
  }, [worktreeId, activeWorktreeId]);

  // Reload when panel becomes active after being backgrounded
  useEffect(() => {
    const isInActiveWorktree = (worktreeId ?? undefined) === (activeWorktreeId ?? undefined);

    if (wasInactive && isInActiveWorktree && isWebviewReady && currentUrl) {
      setWasInactive(false);
      setIsLoading(true);
      setWebviewLoadError(null);
      hasLoadedRef.current = false;
      setHasLoaded(false);
      autoReloadAttemptsRef.current = 0;
      clearAutoReload();
      lastUrlSetAtRef.current = Date.now();

      const webview = webviewRef.current;
      if (webview) {
        webview.loadURL(currentUrl);
      }
    }
  }, [wasInactive, worktreeId, activeWorktreeId, isWebviewReady, currentUrl, clearAutoReload]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (webview && isWebviewReady) {
      webview.setZoomFactor(zoomFactor);
    }
  }, [isWebviewReady, zoomFactor]);

  useEffect(() => {
    if (!currentUrl) return;
    if (!shouldAutoReloadRef.current) return;
    shouldAutoReloadRef.current = false;
    hasLoadedRef.current = false;
    setHasLoaded(false);
    autoReloadAttemptsRef.current = 0;
    lastUrlSetAtRef.current = Date.now();
    clearAutoReload();
    scheduleAutoReload(AUTO_RELOAD_INITIAL_DELAY_MS);
  }, [clearAutoReload, currentUrl, scheduleAutoReload]);

  useEffect(() => {
    if (!isBrowserOnly || currentUrl || !pendingUrlRef.current) return;
    handleNavigate(pendingUrlRef.current);
  }, [currentUrl, handleNavigate, isBrowserOnly]);

  useEffect(() => {
    setHistory({ past: [], present: "", future: [] });
    setError(undefined);
    setStatus("starting");
    setMessage("Starting dev server...");
    setIsRestarting(false);
    setIsBrowserOnly(false);
    setPtyId("");
    setShowTerminal(false);
    setHasLoaded(false);
    setIsLoading(false);
    setWebviewLoadError(null);
    setIsWebviewReady(false);
    hasLoadedRef.current = false;
    autoReloadAttemptsRef.current = 0;
    clearAutoReload();
    pendingUrlRef.current = null;
    lastSetUrlRef.current = "";
    lastUrlSetAtRef.current = 0;
    shouldAutoReloadRef.current = false;
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }

    const terminal = useTerminalStore.getState().getTerminal(id);
    const cols = terminal?.cols ?? 80;
    const rows = terminal?.rows ?? 24;
    const devCommand = terminal?.devCommand;
    const savedUrl = terminal?.browserUrl ?? null;

    if (savedUrl) {
      pendingUrlRef.current = savedUrl;
    }

    void window.electron.devPreview.start(id, cwd, cols, rows, devCommand);

    return () => {
      if (
        useProjectStore.getState().isSwitching &&
        panelKindKeepsAliveOnProjectSwitch("dev-preview")
      ) {
        return;
      }
      void window.electron.devPreview.stop(id);
    };
  }, [clearAutoReload, cwd, id]);

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
  }, [handleBack, handleForward, handleNavigate, handleReload, id]);

  const handleRestartServer = useCallback(() => {
    setHistory({ past: [], present: "", future: [] });
    setError(undefined);
    setStatus("starting");
    setMessage("Restarting dev server...");
    setIsRestarting(true);
    setIsBrowserOnly(false);
    setPtyId("");
    setShowTerminal(false);
    setHasLoaded(false);
    setIsLoading(false);
    setWebviewLoadError(null);
    setIsWebviewReady(false);
    hasLoadedRef.current = false;
    autoReloadAttemptsRef.current = 0;
    clearAutoReload();
    lastSetUrlRef.current = "";
    lastUrlSetAtRef.current = 0;
    shouldAutoReloadRef.current = false;
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
    }
    restartTimeoutRef.current = setTimeout(() => {
      setIsRestarting(false);
    }, 10000);
    void window.electron.devPreview.restart(id);
  }, [clearAutoReload, id]);

  const handleReloadBrowser = useCallback(() => {
    if (!hasValidUrl || !isWebviewReady) return;
    handleReload();
  }, [handleReload, hasValidUrl, isWebviewReady]);

  const statusStyle = STATUS_STYLES[status];
  const showLoadingOverlay = hasValidUrl && !hasLoaded && !webviewLoadError;
  const loadingMessage =
    status === "starting" || status === "installing" ? message : "Loading preview...";
  const showRestartSpinner = isRestarting || status === "starting" || status === "installing";
  const hasTerminal = ptyId.length > 0;
  const canToggleTerminal = hasTerminal && !isBrowserOnly;

  const handleToggleView = useCallback(() => {
    if (!canToggleTerminal) return;
    setShowTerminal((prev) => !prev);
  }, [canToggleTerminal]);

  const devPreviewToolbar = (
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

  const buttonClass =
    "p-1.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors";

  return (
    <ContentPanel
      id={id}
      title={title}
      kind="dev-preview"
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
      onRestart={handleReloadBrowser}
      toolbar={devPreviewToolbar}
    >
      <div className="flex flex-1 min-h-0 flex-col">
        <div className="relative flex-1 min-h-0 bg-white">
          {/* Terminal View */}
          {showTerminal && hasTerminal && (
            <div className="absolute inset-0 bg-canopy-bg">
              <XtermAdapter
                terminalId={ptyId}
                terminalType="terminal"
                isInputLocked={true}
                className="w-full h-full"
              />
            </div>
          )}
          {/* Browser View - use visibility:hidden instead of unmounting to preserve state */}
          <div
            className={cn("absolute inset-0", showTerminal && hasTerminal && "invisible")}
            style={{ display: showTerminal && hasTerminal ? "none" : undefined }}
          >
            {hasValidUrl ? (
              <>
                {isDragging && <div className="absolute inset-0 z-10 bg-transparent" />}
                {showLoadingOverlay && (
                  <div className="absolute inset-0 flex items-center justify-center bg-canopy-bg z-10">
                    <div className="text-center max-w-md space-y-1 px-4">
                      <div className="text-sm font-medium text-canopy-text">Dev Preview</div>
                      <div className="text-xs text-canopy-text/60">{loadingMessage}</div>
                    </div>
                  </div>
                )}
                {webviewLoadError && (
                  <div className="absolute inset-0 flex items-center justify-center bg-canopy-bg z-10">
                    <div className="text-center max-w-md space-y-2 px-4">
                      <div className="text-sm font-medium text-[var(--color-status-error)]">
                        Webview Load Error
                      </div>
                      <div className="text-xs text-canopy-text/60">{webviewLoadError}</div>
                    </div>
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
            ) : isBrowserOnly ? (
              <div className="absolute inset-0 flex items-center justify-center bg-canopy-bg">
                <div className="text-center max-w-md space-y-2 px-4">
                  <div className="text-sm font-medium text-canopy-text">Browser-Only Mode</div>
                  <div className="text-xs text-canopy-text/60">
                    No dev command configured. Enter a localhost URL in the address bar above.
                  </div>
                  {error && <div className="text-xs text-[var(--color-status-error)]">{error}</div>}
                </div>
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-canopy-bg">
                <div className="text-center max-w-md space-y-1 px-4">
                  <div className="text-sm font-medium text-canopy-text">Dev Preview</div>
                  <div className="text-xs text-canopy-text/60">{message}</div>
                  {error && <div className="text-xs text-[var(--color-status-error)]">{error}</div>}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-t border-canopy-border bg-[color-mix(in_oklab,var(--color-surface)_92%,transparent)] text-xs text-canopy-text/70">
          <div className="flex items-center gap-2 min-w-0" role="status" aria-live="polite">
            <Server className="w-3.5 h-3.5 text-canopy-text/40 shrink-0" />
            <span className={cn("h-2 w-2 rounded-full shrink-0", statusStyle.dot)} />
            {status === "running" && !isBrowserOnly ? (
              <span className={cn("font-medium", statusStyle.text)}>{statusStyle.label}</span>
            ) : status === "error" && error ? (
              <span className={cn("truncate", statusStyle.text)} title={error}>
                {error}
              </span>
            ) : (
              <span className="truncate text-canopy-text/60" title={message}>
                {message}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 min-w-0">
            {canToggleTerminal && (
              <button
                type="button"
                onClick={handleToggleView}
                className={cn(buttonClass, showTerminal && "bg-white/10")}
                title={showTerminal ? "Show browser preview" : "Show terminal output"}
                aria-label={showTerminal ? "Show browser preview" : "Show terminal output"}
                aria-pressed={showTerminal}
              >
                {showTerminal ? <Globe className="w-4 h-4" /> : <Terminal className="w-4 h-4" />}
              </button>
            )}
            <button
              type="button"
              onClick={handleReloadBrowser}
              disabled={!hasValidUrl || !isWebviewReady || isLoading}
              className={cn(buttonClass, isLoading && "animate-pulse")}
              title="Reload browser"
              aria-label="Reload browser"
              aria-busy={isLoading}
            >
              <RotateCw className="w-4 h-4" />
            </button>
            {!isBrowserOnly && (
              <button
                type="button"
                onClick={handleRestartServer}
                disabled={showRestartSpinner}
                className={cn(buttonClass, showRestartSpinner && "animate-pulse")}
                title="Restart dev server"
                aria-label="Restart dev server"
                aria-busy={showRestartSpinner}
              >
                <Power className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </ContentPanel>
  );
}
