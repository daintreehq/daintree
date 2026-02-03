import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Globe, Server, Power, Terminal, RotateCw } from "lucide-react";
import { BrowserToolbar } from "@/components/Browser/BrowserToolbar";
import { XtermAdapter } from "@/components/Terminal/XtermAdapter";
import { isValidBrowserUrl, normalizeBrowserUrl } from "@/components/Browser/browserUtils";
import { useIsDragging } from "@/components/DragDrop";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useProjectStore, useTerminalStore } from "@/store";
import type { BrowserHistory } from "@shared/types/domain";
import { panelKindKeepsAliveOnProjectSwitch } from "@shared/config/panelKindRegistry";
import type { DevPreviewStatus } from "@shared/types/ipc/devPreview";

interface WebviewInstance {
  element: Electron.WebviewTag;
  lastActiveTime: number;
  worktreeId: string | null;
  isReady: boolean;
  hasLoaded: boolean;
  isLoading: boolean;
  loadError: string | null;
  lastKnownUrl: string;
}

const MAX_WEBVIEWS_PER_PANEL = 5;

function makeWebviewKey(panelId: string, worktreeId: string | null | undefined): string {
  return `${panelId}-${worktreeId ?? "default"}`;
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
const AUTO_RELOAD_WINDOW_MS = 30000;
const AUTO_RELOAD_ERROR_CODES = new Set([-102, -105, -106, -118]);
const LOADING_TIMEOUT_MS = 45000;

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
  const [showTerminal, setShowTerminal] = useState(false);
  const restartTerminal = useTerminalStore((state) => state.restartTerminal);
  const [history, setHistory] = useState<BrowserHistory>(() => {
    const terminal = useTerminalStore.getState().getTerminal(id);
    const saved = terminal?.browserHistory;
    if (
      saved &&
      Array.isArray(saved.past) &&
      Array.isArray(saved.future) &&
      typeof saved.present === "string"
    ) {
      return saved;
    }
    return {
      past: [],
      present: "",
      future: [],
    };
  });
  const [zoomFactor, setZoomFactor] = useState<number>(() => {
    const terminal = useTerminalStore.getState().getTerminal(id);
    const savedZoom = terminal?.browserZoom ?? 1.0;
    return Number.isFinite(savedZoom) ? Math.max(0.25, Math.min(2.0, savedZoom)) : 1.0;
  });
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [webviewLoadError, setWebviewLoadError] = useState<string | null>(null);
  const [isWebviewReady, setIsWebviewReady] = useState(false);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webviewContainerRef = useRef<HTMLDivElement>(null);
  const webviewMapRef = useRef<Map<string, WebviewInstance>>(new Map());
  const pendingUrlRef = useRef<string | null>(null);
  const autoReloadAttemptsRef = useRef(0);
  const autoReloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUrlSetAtRef = useRef(0);
  const hasLoadedRef = useRef(false);
  const lastSetUrlRef = useRef<string>(history.present);
  const shouldAutoReloadRef = useRef(false);
  const loadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRestoringStateRef = useRef(false);
  const isDragging = useIsDragging();
  const setBrowserUrl = useTerminalStore((state) => state.setBrowserUrl);
  const setBrowserHistory = useTerminalStore((state) => state.setBrowserHistory);
  const setBrowserZoom = useTerminalStore((state) => state.setBrowserZoom);
  const currentWebviewKey = useMemo(() => makeWebviewKey(id, worktreeId), [id, worktreeId]);
  const currentWebviewKeyRef = useRef(currentWebviewKey);
  currentWebviewKeyRef.current = currentWebviewKey;

  const currentUrl = history.present;
  const canGoBack = history.past.length > 0;
  const canGoForward = history.future.length > 0;
  const hasValidUrl = isValidBrowserUrl(currentUrl);

  // Sync history to terminal store (skip during restoration)
  useEffect(() => {
    if (isRestoringStateRef.current) return;
    if (!Array.isArray(history.past) || !Array.isArray(history.future)) return;
    setBrowserHistory(id, history);
  }, [history, id, setBrowserHistory]);

  // Reload state when worktreeId changes (for shared component instances)
  useEffect(() => {
    isRestoringStateRef.current = true;
    const terminal = useTerminalStore.getState().getTerminal(id);
    const saved = terminal?.browserHistory;
    if (
      saved &&
      Array.isArray(saved.past) &&
      Array.isArray(saved.future) &&
      typeof saved.present === "string"
    ) {
      setHistory(saved);
      lastSetUrlRef.current = saved.present;
    } else {
      setHistory({ past: [], present: "", future: [] });
    }
    if (terminal?.browserZoom !== undefined) {
      const savedZoom = terminal.browserZoom;
      setZoomFactor(Number.isFinite(savedZoom) ? Math.max(0.25, Math.min(2.0, savedZoom)) : 1.0);
    } else {
      setZoomFactor(1.0);
    }
    // Defer flag reset to next tick to ensure sync effect sees it
    setTimeout(() => {
      isRestoringStateRef.current = false;
    }, 0);
  }, [id, worktreeId]);

  const clearAutoReload = useCallback(() => {
    if (autoReloadTimeoutRef.current) {
      clearTimeout(autoReloadTimeoutRef.current);
      autoReloadTimeoutRef.current = null;
    }
  }, []);

  const clearLoadingTimeout = useCallback(() => {
    if (loadingTimeoutRef.current) {
      clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }
  }, []);

  const startLoadingTimeout = useCallback(() => {
    clearLoadingTimeout();
    loadingTimeoutRef.current = setTimeout(() => {
      loadingTimeoutRef.current = null;
      if (hasLoadedRef.current) return;
      const instance = webviewMapRef.current.get(currentWebviewKeyRef.current);
      if (instance) {
        instance.isLoading = false;
        instance.loadError = "Loading timed out. The dev server may still be starting.";
      }
      setIsLoading(false);
      setWebviewLoadError("Loading timed out. The dev server may still be starting.");
    }, LOADING_TIMEOUT_MS);
  }, [clearLoadingTimeout]);

  const getActiveWebview = useCallback((): Electron.WebviewTag | null => {
    const instance = webviewMapRef.current.get(currentWebviewKey);
    return instance?.element ?? null;
  }, [currentWebviewKey]);

  const evictLRUWebview = useCallback((excludeKey: string) => {
    const map = webviewMapRef.current;

    // Evict until we're under the cap
    while (map.size >= MAX_WEBVIEWS_PER_PANEL) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;

      map.forEach((ref, key) => {
        if (key !== excludeKey && ref.lastActiveTime < oldestTime) {
          oldestTime = ref.lastActiveTime;
          oldestKey = key;
        }
      });

      if (!oldestKey) break;

      const ref = map.get(oldestKey);
      if (ref) {
        // Clean up event listeners
        const cleanup = webviewCleanupRefs.current.get(oldestKey);
        if (cleanup) {
          cleanup();
          webviewCleanupRefs.current.delete(oldestKey);
        }

        // Remove webview element
        ref.element.remove();
        map.delete(oldestKey);
      } else {
        break;
      }
    }
  }, []);

  const updateWebviewVisibility = useCallback(() => {
    const map = webviewMapRef.current;
    map.forEach((instance, key) => {
      const isActive = key === currentWebviewKey;
      instance.element.style.display = isActive ? "flex" : "none";
      if (isActive) {
        instance.lastActiveTime = Date.now();
      }
    });
  }, [currentWebviewKey]);

  const webviewCleanupRefs = useRef<Map<string, () => void>>(new Map());

  const createWebviewForWorktree = useCallback(
    (url: string): Electron.WebviewTag => {
      const container = webviewContainerRef.current;
      if (!container) {
        throw new Error("Webview container not available");
      }

      const map = webviewMapRef.current;

      // Check if webview already exists for this key
      const existingInstance = map.get(currentWebviewKey);
      if (existingInstance) {
        existingInstance.lastActiveTime = Date.now();
        return existingInstance.element;
      }

      // Evict LRU if needed before creating new webview
      evictLRUWebview(currentWebviewKey);

      // Create new webview element
      const webview = document.createElement("webview") as Electron.WebviewTag;
      webview.setAttribute("partition", `persist:dev-preview-${currentWebviewKey}`);
      webview.style.cssText = "width: 100%; height: 100%; border: 0; display: flex;";

      // Add to container first
      container.appendChild(webview);

      // Store in map with initial state
      const instance: WebviewInstance = {
        element: webview,
        lastActiveTime: Date.now(),
        worktreeId: worktreeId ?? null,
        isReady: false,
        hasLoaded: false,
        isLoading: false,
        loadError: null,
        lastKnownUrl: url || "",
      };
      map.set(currentWebviewKey, instance);

      // Setup event listeners BEFORE setting src to avoid missing early events
      const cleanup = setupWebviewListeners(webview, currentWebviewKey);
      webviewCleanupRefs.current.set(currentWebviewKey, cleanup);

      // Now set src to trigger loading
      webview.setAttribute("src", url || "about:blank");

      // Update visibility for all webviews
      updateWebviewVisibility();

      return webview;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentWebviewKey, evictLRUWebview, updateWebviewVisibility, worktreeId]
  );

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
        const webview = getActiveWebview();
        if (!webview) return;
        autoReloadAttemptsRef.current += 1;
        webview.loadURL(currentUrl);
      }, delayMs);
    },
    [currentUrl, getActiveWebview]
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

      const webview = getActiveWebview();
      if (webview && isWebviewReady) {
        webview.loadURL(result.url!);
      }

      if (isBrowserOnly) {
        void window.electron.devPreview.setUrl(id, result.url!);
      }
    },
    [clearAutoReload, getActiveWebview, id, isBrowserOnly, isWebviewReady]
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

      const webview = getActiveWebview();
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
  }, [clearAutoReload, getActiveWebview, isWebviewReady]);

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

      const webview = getActiveWebview();
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
  }, [clearAutoReload, getActiveWebview, isWebviewReady]);

  const handleReload = useCallback(() => {
    shouldAutoReloadRef.current = false;
    setIsLoading(true);
    setWebviewLoadError(null);
    hasLoadedRef.current = false;
    setHasLoaded(false);
    autoReloadAttemptsRef.current = 0;
    clearAutoReload();
    clearLoadingTimeout();
    lastUrlSetAtRef.current = Date.now();
    const webview = getActiveWebview();
    if (webview && isWebviewReady) {
      webview.reload();
    }
  }, [clearAutoReload, clearLoadingTimeout, getActiveWebview, isWebviewReady]);

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
        const webview = getActiveWebview();
        if (webview && isWebviewReady) {
          webview.loadURL(resolvedUrl);
        }
        return;
      }

      // Only reset history if no URL is currently set (avoid overwriting restored state)
      if (!currentUrl) {
        shouldAutoReloadRef.current = true;
        setIsLoading(true);
        setHistory({ past: [], present: resolvedUrl, future: [] });
        lastSetUrlRef.current = resolvedUrl;
      }
    },
    [
      clearAutoReload,
      currentUrl,
      getActiveWebview,
      isBrowserOnly,
      isWebviewReady,
      scheduleAutoReload,
    ]
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
        clearLoadingTimeout();
      }
    });

    const offUrl = window.electron.devPreview.onUrl((payload) => {
      if (payload.panelId !== id) return;
      handleServerUrl(payload.url);
    });

    const offRecovery = window.electron.devPreview.onRecovery(async (payload) => {
      if (payload.panelId !== id) return;
      // DevPreviewService killed the PTY for recovery. Restart via standard pipeline
      // and re-attach so the overlay can monitor the new process.
      // Use the recovery command (includes install) instead of terminal's devCommand.
      await restartTerminal(id);
      void window.electron.devPreview.attach(id, cwd, payload.command);
    });

    return () => {
      offStatus();
      offUrl();
      offRecovery();
      if (restartTimeoutRef.current) {
        clearTimeout(restartTimeoutRef.current);
      }
      clearAutoReload();
      clearLoadingTimeout();
    };
  }, [clearAutoReload, clearLoadingTimeout, cwd, handleServerUrl, id, restartTerminal]);

  const setupWebviewListeners = useCallback(
    (webview: Electron.WebviewTag, webviewKey: string) => {
      const handleDomReady = () => {
        // Update instance state
        const instance = webviewMapRef.current.get(webviewKey);
        if (instance) {
          instance.isReady = true;
          instance.lastKnownUrl = webview.getURL();
        }

        // Only update UI state if this is the currently active webview
        if (webviewKey === currentWebviewKeyRef.current) {
          setIsWebviewReady(true);
        }
      };

      const handleDidFailLoad = (event: Electron.DidFailLoadEvent) => {
        if (event.errorCode === -3 || event.errorCode === -6) return;

        // Update instance state
        const instance = webviewMapRef.current.get(webviewKey);
        if (instance) {
          instance.hasLoaded = false;
          instance.isLoading = false;
          instance.loadError =
            event.errorDescription || "Failed to load dev server. Check if the server is running.";
        }

        // Only update UI state if this is the currently active webview
        if (webviewKey !== currentWebviewKeyRef.current) return;

        hasLoadedRef.current = false;
        setHasLoaded(false);
        setIsLoading(false);
        const isRetryable = AUTO_RELOAD_ERROR_CODES.has(event.errorCode);
        if (isRetryable && autoReloadAttemptsRef.current < AUTO_RELOAD_MAX_ATTEMPTS) {
          const delay = AUTO_RELOAD_RETRY_DELAY_MS * (autoReloadAttemptsRef.current + 1);
          scheduleAutoReload(delay);
          return;
        }
        clearLoadingTimeout();
        setWebviewLoadError(instance?.loadError || "Failed to load");
      };

      const handleDidStartLoading = () => {
        // Update instance state
        const instance = webviewMapRef.current.get(webviewKey);
        if (instance) {
          instance.isLoading = true;
          instance.hasLoaded = false;
          instance.loadError = null;
        }

        // Only update UI state if this is the currently active webview
        if (webviewKey !== currentWebviewKeyRef.current) return;
        setWebviewLoadError(null);
        hasLoadedRef.current = false;
        setHasLoaded(false);
        setIsLoading(true);
        startLoadingTimeout();
      };

      const handleDidStopLoading = () => {
        // Update instance state
        const instance = webviewMapRef.current.get(webviewKey);
        if (instance) {
          instance.isLoading = false;
          instance.hasLoaded = true;
          instance.loadError = null;
          instance.lastKnownUrl = webview.getURL();
        }

        // Only update UI state if this is the currently active webview
        if (webviewKey !== currentWebviewKeyRef.current) return;
        hasLoadedRef.current = true;
        autoReloadAttemptsRef.current = 0;
        clearAutoReload();
        clearLoadingTimeout();
        setHasLoaded(true);
        setIsLoading(false);
      };

      const handleDidNavigate = (event: Electron.DidNavigateEvent) => {
        const newUrl = event.url;

        // Update instance last known URL
        const instance = webviewMapRef.current.get(webviewKey);
        if (instance) {
          instance.lastKnownUrl = newUrl;
        }

        // Only update history if this is the currently active webview
        if (webviewKey !== currentWebviewKeyRef.current) return;

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

        // Update instance last known URL
        const instance = webviewMapRef.current.get(webviewKey);
        if (instance) {
          instance.lastKnownUrl = newUrl;
        }

        // Only update history if this is the currently active webview
        if (webviewKey !== currentWebviewKeyRef.current) return;

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
    },
    [clearAutoReload, clearLoadingTimeout, scheduleAutoReload, startLoadingTimeout]
  );

  useEffect(() => {
    if (!hasValidUrl) return;
    setBrowserUrl(id, currentUrl);
  }, [currentUrl, hasValidUrl, id, setBrowserUrl]);

  useEffect(() => {
    setBrowserZoom(id, zoomFactor);
  }, [id, setBrowserZoom, zoomFactor]);

  // Update webview visibility when worktree changes (show/hide instead of reload)
  useEffect(() => {
    updateWebviewVisibility();
  }, [updateWebviewVisibility, currentWebviewKey]);

  useEffect(() => {
    const webview = getActiveWebview();
    if (webview && isWebviewReady) {
      webview.setZoomFactor(zoomFactor);
    }
  }, [getActiveWebview, isWebviewReady, zoomFactor]);

  // Create webview when URL becomes available and container is ready
  useEffect(() => {
    if (!currentUrl || !webviewContainerRef.current) return;

    const map = webviewMapRef.current;
    const existingInstance = map.get(currentWebviewKey);

    // If webview already exists, restore state from the instance
    if (existingInstance) {
      updateWebviewVisibility();
      existingInstance.lastActiveTime = Date.now();

      // Restore UI state from the instance's tracked state
      setIsWebviewReady(existingInstance.isReady);
      setHasLoaded(existingInstance.hasLoaded);
      setIsLoading(existingInstance.isLoading);
      setWebviewLoadError(existingInstance.loadError);
      hasLoadedRef.current = existingInstance.hasLoaded;

      // Check if URL changed using lastKnownUrl (more reliable than getAttribute)
      if (existingInstance.lastKnownUrl !== currentUrl && currentUrl) {
        // URL changed - trigger reload
        try {
          existingInstance.element.loadURL(currentUrl);
          existingInstance.isLoading = true;
          existingInstance.hasLoaded = false;
          existingInstance.loadError = null;
          setIsLoading(true);
          setHasLoaded(false);
          setWebviewLoadError(null);
          hasLoadedRef.current = false;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : "Failed to load URL";
          existingInstance.loadError = errorMsg;
          setWebviewLoadError(errorMsg);
        }
      }
      return;
    }

    // Create new webview for this worktree (listeners are attached in createWebviewForWorktree)
    try {
      createWebviewForWorktree(currentUrl);
      setIsWebviewReady(false);
      setHasLoaded(false);
      setIsLoading(true);
      setWebviewLoadError(null);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Failed to create webview";
      setWebviewLoadError(errorMsg);
    }
  }, [currentUrl, currentWebviewKey, createWebviewForWorktree, updateWebviewVisibility]);

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
    setShowTerminal(false);
    setHasLoaded(false);
    setIsLoading(false);
    setWebviewLoadError(null);
    setIsWebviewReady(false);
    hasLoadedRef.current = false;
    autoReloadAttemptsRef.current = 0;
    clearAutoReload();
    clearLoadingTimeout();
    pendingUrlRef.current = null;
    lastSetUrlRef.current = "";
    lastUrlSetAtRef.current = 0;
    shouldAutoReloadRef.current = false;
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }

    const terminal = useTerminalStore.getState().getTerminal(id);
    const devCommand = terminal?.devCommand;
    const savedUrl = terminal?.browserUrl ?? null;

    // Restore saved state from terminal store (preserves URL across project switches)
    isRestoringStateRef.current = true;
    const currentTerminal = useTerminalStore.getState().getTerminal(id);
    if (currentTerminal?.browserHistory) {
      setHistory(currentTerminal.browserHistory);
      lastSetUrlRef.current = currentTerminal.browserHistory.present;
      pendingUrlRef.current = currentTerminal.browserHistory.present;
    } else if (savedUrl) {
      pendingUrlRef.current = savedUrl;
    }
    if (currentTerminal?.browserZoom !== undefined) {
      const savedZoom = currentTerminal.browserZoom;
      setZoomFactor(Number.isFinite(savedZoom) ? Math.max(0.25, Math.min(2.0, savedZoom)) : 1.0);
    }
    isRestoringStateRef.current = false;

    const cleanups = webviewCleanupRefs.current;
    const map = webviewMapRef.current;

    // Attach DevPreviewService overlay to the PTY spawned by the standard terminal pipeline.
    // Panel ID = PTY ID in the terminal-first architecture.
    void window.electron.devPreview.attach(id, cwd, devCommand);

    return () => {
      // Only skip cleanup if it's a project switch AND panel kind keeps alive
      const shouldKeepAlive =
        useProjectStore.getState().isSwitching && panelKindKeepsAliveOnProjectSwitch("dev-preview");

      if (shouldKeepAlive) {
        return;
      }

      // Clean up all webviews and their event listeners
      cleanups.forEach((cleanup) => cleanup());
      cleanups.clear();

      map.forEach((instance) => {
        instance.element.remove();
      });
      map.clear();

      // Detach overlay (PTY lifecycle managed by terminal store)
      void window.electron.devPreview.detach(id);
    };
  }, [clearAutoReload, clearLoadingTimeout, cwd, id, worktreeId]);

  // Separate unmount effect to ensure cleanup even during project switch
  useEffect(() => {
    const cleanups = webviewCleanupRefs.current;
    const map = webviewMapRef.current;

    return () => {
      // Force cleanup on actual component unmount (panel close)
      // This runs even if the cwd/id effect's cleanup was skipped
      const hasWebviews = map.size > 0;
      if (hasWebviews) {
        cleanups.forEach((cleanup) => cleanup());
        cleanups.clear();

        map.forEach((instance) => {
          instance.element.remove();
        });
        map.clear();
      }
    };
  }, []);

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

  const handleRestartServer = useCallback(async () => {
    setHistory({ past: [], present: "", future: [] });
    setError(undefined);
    setStatus("starting");
    setMessage("Restarting dev server...");
    setIsRestarting(true);
    setIsBrowserOnly(false);
    setShowTerminal(false);
    setHasLoaded(false);
    setIsLoading(false);
    setWebviewLoadError(null);
    setIsWebviewReady(false);
    hasLoadedRef.current = false;
    autoReloadAttemptsRef.current = 0;
    clearAutoReload();
    clearLoadingTimeout();
    lastSetUrlRef.current = "";
    lastUrlSetAtRef.current = 0;
    shouldAutoReloadRef.current = false;
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
    }
    restartTimeoutRef.current = setTimeout(() => {
      setIsRestarting(false);
    }, 10000);

    // Detach overlay, restart PTY through standard pipeline, then re-attach
    // Await detach to prevent race where late detach severs the new attachment
    await window.electron.devPreview.detach(id);
    await restartTerminal(id);
    const terminal = useTerminalStore.getState().getTerminal(id);
    void window.electron.devPreview.attach(id, cwd, terminal?.devCommand);
  }, [clearAutoReload, clearLoadingTimeout, cwd, id, restartTerminal]);

  const handleReloadBrowser = useCallback(() => {
    if (!hasValidUrl || !isWebviewReady) return;
    handleReload();
  }, [handleReload, hasValidUrl, isWebviewReady]);

  const handleForceReload = useCallback(() => {
    if (!hasValidUrl) return;
    setIsLoading(true);
    setWebviewLoadError(null);
    hasLoadedRef.current = false;
    setHasLoaded(false);
    autoReloadAttemptsRef.current = 0;
    clearAutoReload();
    clearLoadingTimeout();
    lastUrlSetAtRef.current = Date.now();
    const webview = getActiveWebview();
    if (webview) {
      webview.loadURL(currentUrl);
      startLoadingTimeout();
    }
  }, [
    clearAutoReload,
    clearLoadingTimeout,
    currentUrl,
    getActiveWebview,
    hasValidUrl,
    startLoadingTimeout,
  ]);

  const statusStyle = STATUS_STYLES[status];
  const showLoadingOverlay = hasValidUrl && !hasLoaded && !webviewLoadError;
  const loadingMessage =
    status === "starting" || status === "installing" ? message : "Loading preview...";
  const showRestartSpinner = isRestarting || status === "starting" || status === "installing";
  const canToggleTerminal = !isBrowserOnly;

  const handleToggleView = useCallback(() => {
    if (!canToggleTerminal) return;
    setShowTerminal((prev) => {
      const nextShowTerminal = !prev;
      terminalInstanceService.setVisible(id, nextShowTerminal);
      return nextShowTerminal;
    });
  }, [canToggleTerminal, id]);

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
          {/* Terminal View - always mounted to preserve output history */}
          <div
            className={cn(
              "absolute inset-0 bg-canopy-bg",
              showTerminal ? "z-10 visible" : "z-0 invisible"
            )}
            aria-hidden={!showTerminal}
            {...(!showTerminal && { inert: true })}
          >
            <XtermAdapter terminalId={id} terminalType="terminal" className="w-full h-full" />
          </div>
          {/* Browser View - layered on top when terminal is hidden */}
          <div
            className={cn(
              "absolute inset-0",
              // When terminal is shown, hide browser completely to pause webview
              showTerminal ? "hidden" : "z-10 visible"
            )}
            aria-hidden={showTerminal}
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
                      <button
                        type="button"
                        onClick={handleForceReload}
                        className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-white/10 hover:bg-white/15 text-canopy-text transition-colors"
                      >
                        <RotateCw className="w-3 h-3" />
                        Retry
                      </button>
                    </div>
                  </div>
                )}
                {/* Container for dynamically created webviews - multiple instances preserved */}
                <div
                  ref={webviewContainerRef}
                  className={cn("w-full h-full", isDragging && "invisible pointer-events-none")}
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
