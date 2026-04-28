import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { AlertTriangle, RotateCw, ExternalLink, Settings, WandSparkles } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/button";
import { usePanelStore } from "@/store";
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
import { getViewportPreset } from "@/panels/dev-preview/viewportPresets";
import type { ViewportPresetId } from "@shared/types/panel";

import { looksLikeOAuthUrl } from "@shared/utils/urlUtils";

type SessionStorageEntry = [string, string];

async function captureWebviewSessionStorage(
  webviewElement: Electron.WebviewTag | null
): Promise<SessionStorageEntry[]> {
  if (!webviewElement) return [];

  try {
    const snapshot = await webviewElement.executeJavaScript(
      `(() => {
        try {
          return Object.entries(sessionStorage).filter(
            (entry) =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              typeof entry[0] === "string" &&
              typeof entry[1] === "string"
          );
        } catch {
          return [];
        }
      })()`
    );

    if (!Array.isArray(snapshot)) return [];
    return snapshot.filter(
      (entry): entry is SessionStorageEntry =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string"
    );
  } catch {
    return [];
  }
}

function BlockedNavBanner({
  blockedNav,
  panelId,
  webviewElement,
  onDismiss,
}: {
  blockedNav: {
    url: string;
    canOpenExternal: boolean;
    sessionStorageSnapshot: SessionStorageEntry[];
  };
  panelId: string;
  webviewElement: Electron.WebviewTag | null;
  onDismiss: () => void;
}) {
  const isOAuth = looksLikeOAuthUrl(blockedNav.url);
  const hostname = (() => {
    try {
      return new URL(blockedNav.url).hostname;
    } catch {
      return blockedNav.url;
    }
  })();

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs bg-status-warning/10 border-b border-status-warning/20 text-daintree-text/80">
      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-status-warning" />
      <span className="truncate flex-1">Navigation to external site blocked: {hostname}</span>
      {isOAuth ? (
        <button
          type="button"
          onClick={async () => {
            const url = blockedNav.url;
            onDismiss();
            // Get webContentsId for CDP interception of the token exchange
            let wcId: number | undefined;
            try {
              wcId = (
                webviewElement as unknown as { getWebContentsId(): number }
              )?.getWebContentsId();
            } catch {
              /* webview not ready */
            }
            if (wcId != null) {
              await window.electron.webview.startOAuthLoopback(
                url,
                panelId,
                wcId,
                blockedNav.sessionStorageSnapshot
              );
            }
          }}
          className="shrink-0 px-2 py-0.5 rounded text-xs bg-status-warning/20 hover:bg-status-warning/30 text-daintree-text/90 transition-colors"
        >
          Sign in via Browser
        </button>
      ) : blockedNav.canOpenExternal ? (
        <button
          type="button"
          onClick={() => {
            void window.electron.system.openExternal(blockedNav.url);
            onDismiss();
          }}
          className="shrink-0 px-2 py-0.5 rounded text-xs bg-status-warning/20 hover:bg-status-warning/30 text-daintree-text/90 transition-colors"
        >
          Open in External Browser
        </button>
      ) : null}
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-daintree-text/40 hover:text-daintree-text/70 transition-colors"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
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
  const setBrowserUrl = usePanelStore((state) => state.setBrowserUrl);
  const setBrowserHistory = usePanelStore((state) => state.setBrowserHistory);
  const setBrowserZoom = usePanelStore((state) => state.setBrowserZoom);
  const setDevPreviewConsoleOpen = usePanelStore((state) => state.setDevPreviewConsoleOpen);
  const setViewportPreset = usePanelStore((state) => state.setViewportPreset);
  const setDevPreviewScrollPosition = usePanelStore((state) => state.setDevPreviewScrollPosition);
  const currentProjectId = useProjectStore((state) => state.currentProject?.id);
  const projectSettings = useProjectSettingsStore((state) => state.settings);
  const projectEnv = projectSettings?.environmentVariables;
  const isDragging = useIsDragging();

  const terminal = usePanelStore((state) => state.getTerminal(id));
  const devCommand =
    terminal?.devCommand?.trim() || projectSettings?.devServerCommand?.trim() || "";
  const viewportPreset = terminal?.viewportPreset;

  const { status, url, terminalId, error, start, restart, isRestarting } = useDevServer({
    panelId: id,
    devCommand,
    cwd,
    worktreeId,
    env: projectEnv,
    turbopackEnabled: projectSettings?.turbopackEnabled ?? true,
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
  const [blockedNav, setBlockedNav] = useState<{
    url: string;
    canOpenExternal: boolean;
    sessionStorageSnapshot: SessionStorageEntry[];
  } | null>(null);
  const blockedNavTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastSetUrlRef = useRef<string>("");
  const [isWebviewReady, setIsWebviewReady] = useState(false);
  const [consoleTerminalId, setConsoleTerminalId] = useState<string | null>(terminalId);
  const loadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const failLoadRetryRef = useRef<NodeJS.Timeout | null>(null);
  const failLoadRetryCountRef = useRef<number>(0);
  // Generation token to invalidate in-flight async scroll captures when the
  // user clears scroll state via hard restart. A pending executeJavaScript
  // promise that resolves after the clear must NOT write the stale position back.
  const scrollCaptureGenerationRef = useRef<number>(0);
  const isConsoleOpen = terminal?.devPreviewConsoleOpen ?? false;
  const [webviewLoadError, setWebviewLoadError] = useState<string | null>(null);
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
  const isUnconfigured =
    Boolean(currentProjectId) && !isSettingsLoading && projectSettings !== null && !devCommand;

  useEffect(() => {
    if (!isUnconfigured) return;
    setHistory(initializeBrowserHistory(undefined, ""));
    setBrowserUrl(id, "");
    lastSetUrlRef.current = "";
    setWebviewLoadError(null);
    if (failLoadRetryRef.current) {
      clearTimeout(failLoadRetryRef.current);
      failLoadRetryRef.current = null;
    }
    failLoadRetryCountRef.current = 0;
  }, [isUnconfigured, id, setBrowserUrl]);

  const { isEvicted, evictingRef } = useWebviewEviction(id, location);

  const setWebviewNode = useCallback(
    (node: Electron.WebviewTag | null) => {
      if (!node && webviewRef.current) {
        try {
          const prevWebview = webviewRef.current;
          const currentWebviewUrl = prevWebview.getURL();
          if (currentWebviewUrl && currentWebviewUrl !== "about:blank") {
            const captureGeneration = scrollCaptureGenerationRef.current;
            prevWebview
              .executeJavaScript("window.scrollY")
              .then((scrollY: number) => {
                if (scrollCaptureGenerationRef.current !== captureGeneration) return;
                if (typeof scrollY === "number" && Number.isFinite(scrollY)) {
                  setDevPreviewScrollPosition(id, { url: currentWebviewUrl, scrollY });
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
    [id, setDevPreviewScrollPosition]
  );

  useEffect(() => {
    isMountedRef.current = true;
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
          const captureGeneration = scrollCaptureGenerationRef.current;
          webviewElement
            .executeJavaScript("window.scrollY")
            .then((scrollY: number) => {
              if (scrollCaptureGenerationRef.current !== captureGeneration) return;
              if (typeof scrollY === "number" && Number.isFinite(scrollY)) {
                setDevPreviewScrollPosition(id, { url: currentWebviewUrl, scrollY });
              }
            })
            .catch(() => {});
        }
      } catch {
        // Webview already detached
      }
    }
  }, [status, id, webviewElement, setDevPreviewScrollPosition]);

  useEffect(() => {
    setConsoleTerminalId(terminalId);
  }, [terminalId]);

  useEffect(() => {
    if (isUnconfigured) return;
    if (url && shouldAdoptDetectedDevServerUrl(url, currentUrl)) {
      setHistory((prev) => pushBrowserHistory(prev, url));
      lastSetUrlRef.current = url;
    }
  }, [url, currentUrl, isUnconfigured]);

  useEffect(() => {
    if (isUnconfigured) return;
    if (currentUrl) {
      setBrowserUrl(id, currentUrl);
    }
  }, [id, currentUrl, setBrowserUrl, isUnconfigured]);

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

  const handleHardReload = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !isWebviewReady) return;
    try {
      const wcId = (webview as unknown as { getWebContentsId(): number }).getWebContentsId();
      void window.electron.webview.reloadIgnoringCache(wcId, id);
    } catch {
      webview.reload();
    }
  }, [isWebviewReady, id]);

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
    // Invalidate any in-flight async scroll captures so they can't write
    // stale data back over the cleared position.
    scrollCaptureGenerationRef.current += 1;
    setDevPreviewScrollPosition(id, undefined);
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
    setHistory(initializeBrowserHistory(undefined, ""));
    setBrowserUrl(id, "");
    lastSetUrlRef.current = "";
    setIsLoading(false);
    setIsWebviewReady(false);
    setWebviewLoadError(null);
    void restart();
  }, [id, restart, setBrowserUrl, setDevPreviewScrollPosition]);

  const handleAutoDetect = useCallback(async () => {
    if (!currentProjectId || isAutoDetecting) return;

    setIsAutoDetecting(true);
    try {
      const freshRunners = await projectClient.detectRunners(currentProjectId);
      const candidate = findDevServerCandidate(
        freshRunners,
        projectSettings?.turbopackEnabled ?? true
      );

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
  }, [currentProjectId, isAutoDetecting, saveSettings, projectSettings?.turbopackEnabled]);

  const handleOpenSettings = useCallback(() => {
    void actionService.dispatch("project.settings.open", undefined, { source: "user" });
  }, []);

  const handleViewportPresetChange = useCallback(
    (preset: ViewportPresetId | undefined) => {
      setViewportPreset(id, preset);
    },
    [id, setViewportPreset]
  );

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
      setWebviewLoadError(null);
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
        if (retryCount >= MAX_RETRIES) {
          setWebviewLoadError(
            "Unable to connect to dev server. The server may be on a different port."
          );
        } else if (retryCount < MAX_RETRIES) {
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
      setBlockedNav(null);
      setWebviewLoadError(null);
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
      setBlockedNav(null);
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
      // Capture original UA before any override
      try {
        const wc = (
          webview as unknown as {
            getWebContents(): { setUserAgent(ua: string): void; getUserAgent(): string };
          }
        ).getWebContents();
        if (originalUaRef.current === null) {
          originalUaRef.current = wc.getUserAgent();
        }
        // Apply preset UA if active
        if (viewportPreset) {
          wc.setUserAgent(getViewportPreset(viewportPreset).userAgent);
        }
      } catch {
        // WebContents not available yet
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }

      const saved = usePanelStore.getState().getTerminal(id)?.devPreviewScrollPosition;
      if (saved && Number.isFinite(saved.scrollY) && saved.scrollY > 0 && saved.url) {
        try {
          const loadedUrl = webview.getURL();
          if (loadedUrl === saved.url) {
            webview
              .executeJavaScript(
                `requestAnimationFrame(() => window.scrollTo(0, ${saved.scrollY}))`
              )
              .catch(() => {});
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
        try {
          const wc = (
            webview as unknown as {
              getWebContents(): { setUserAgent(ua: string): void; getUserAgent(): string };
            }
          ).getWebContents();
          if (originalUaRef.current === null) {
            originalUaRef.current = wc.getUserAgent();
          }
          if (viewportPreset) {
            wc.setUserAgent(getViewportPreset(viewportPreset).userAgent);
          }
        } catch {
          // WebContents not available
        }
        // dom-ready already fired before this listener attached. Run scroll
        // restore here so the position survives tab switches and other
        // re-renders that don't trigger another dom-ready.
        const saved = usePanelStore.getState().getTerminal(id)?.devPreviewScrollPosition;
        if (saved && Number.isFinite(saved.scrollY) && saved.scrollY > 0 && saved.url) {
          if (existingUrl === saved.url) {
            webview
              .executeJavaScript(
                `requestAnimationFrame(() => window.scrollTo(0, ${saved.scrollY}))`
              )
              .catch(() => {});
          }
        }
      }
    } catch {
      // Webview not yet attached to DOM - dom-ready handler will take over
    }

    webview.addEventListener("dom-ready", handleDomReady);
    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
    };
  }, [id, zoomFactor, webviewElement, viewportPreset]);

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
          const captureGeneration = scrollCaptureGenerationRef.current;
          wv.executeJavaScript("window.scrollY")
            .then((scrollY: number) => {
              if (scrollCaptureGenerationRef.current !== captureGeneration) return;
              if (typeof scrollY === "number" && Number.isFinite(scrollY)) {
                setDevPreviewScrollPosition(id, { url: currentWebviewUrl, scrollY });
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
  }, [isEvicted, id, setDevPreviewScrollPosition]);

  useWebviewThrottle(id, location, isEvicted ? null : webviewElement, isWebviewReady && !isEvicted);

  // Store the original guest UA so we can restore it when clearing a preset
  const originalUaRef = useRef<string | null>(null);

  // Apply UA override when viewport preset changes on an already-ready webview
  // Initialize to undefined so restored presets trigger the effect on first render
  const prevViewportPresetRef = useRef<ViewportPresetId | undefined>(undefined);
  useEffect(() => {
    if (!isWebviewReady || !webviewElement) return;
    if (prevViewportPresetRef.current === viewportPreset) return;
    const previousPreset = prevViewportPresetRef.current;
    prevViewportPresetRef.current = viewportPreset;

    try {
      const wc = (
        webviewElement as unknown as {
          getWebContents(): { setUserAgent(ua: string): void; getUserAgent(): string };
        }
      ).getWebContents();
      // Capture original UA on first override
      if (originalUaRef.current === null) {
        originalUaRef.current = wc.getUserAgent();
      }
      if (viewportPreset) {
        const preset = getViewportPreset(viewportPreset);
        wc.setUserAgent(preset.userAgent);
      } else if (previousPreset !== undefined) {
        // Only restore if we previously overrode (not first mount with no preset)
        wc.setUserAgent(originalUaRef.current!);
      }
      // Reload so the page re-evaluates with the new UA
      if (previousPreset !== undefined) {
        webviewElement.reload();
      }
    } catch {
      // WebContents not available (webview detached)
    }
  }, [viewportPreset, isWebviewReady, webviewElement]);
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

  // Listen for blocked navigation events from main process
  useEffect(() => {
    const cleanup = window.electron.webview.onNavigationBlocked((data) => {
      if (data.panelId !== id) return;
      const sessionStorageSnapshotPromise = looksLikeOAuthUrl(data.url)
        ? captureWebviewSessionStorage(webviewElement)
        : Promise.resolve<SessionStorageEntry[]>([]);
      if (blockedNavTimerRef.current) {
        clearTimeout(blockedNavTimerRef.current);
      }
      blockedNavTimerRef.current = setTimeout(() => {
        void sessionStorageSnapshotPromise.then((sessionStorageSnapshot) => {
          setBlockedNav({
            url: data.url,
            canOpenExternal: data.canOpenExternal,
            sessionStorageSnapshot,
          });
          blockedNavTimerRef.current = null;
        });
      }, 150);
    });
    return () => {
      cleanup();
      if (blockedNavTimerRef.current) {
        clearTimeout(blockedNavTimerRef.current);
        blockedNavTimerRef.current = null;
      }
    };
  }, [id, webviewElement]);

  // Auto-dismiss blocked navigation notification after 10 seconds
  useEffect(() => {
    if (!blockedNav) return;
    const timer = setTimeout(() => setBlockedNav(null), 10_000);
    return () => clearTimeout(timer);
  }, [blockedNav]);

  // Listen for action-driven hard-reload events
  useEffect(() => {
    const handleHardReloadEvent = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      if (!detail || typeof (detail as { id?: unknown }).id !== "string") return;
      if ((detail as { id: string }).id === id) {
        handleHardReload();
      }
    };

    const controller = new AbortController();
    window.addEventListener("daintree:hard-reload-browser", handleHardReloadEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [id, handleHardReload]);

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
          viewportPreset={viewportPreset}
          onNavigate={handleNavigate}
          onBack={handleBack}
          onForward={handleForward}
          onReload={handleReload}
          onHardReload={handleHardReload}
          onOpenExternal={handleOpenExternal}
          onZoomChange={handleZoomChange}
          onViewportPresetChange={handleViewportPresetChange}
        />

        <div className="relative flex-1 min-h-0 bg-surface-canvas overflow-auto">
          {viewportPreset && (
            <div className="absolute top-1 left-1/2 -translate-x-1/2 z-10 px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface/90 text-daintree-text/60 border border-overlay/50">
              {getViewportPreset(viewportPreset).label} · {getViewportPreset(viewportPreset).width}×
              {getViewportPreset(viewportPreset).height}
            </div>
          )}
          {isRestarting || status === "starting" || status === "installing" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg">
              <Spinner size="2xl" className="text-status-info mb-4" />
              <p className="text-sm text-daintree-text/60">
                {isRestarting ? "Restarting" : status === "installing" ? "Installing" : "Starting"}
                ...
              </p>
            </div>
          ) : status === "error" && error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
              <AlertTriangle className="w-6 h-6 text-status-warning mb-3" />
              <h3 className="text-sm font-medium text-daintree-text/70 mb-1">Dev Server Error</h3>
              <p className="text-xs text-daintree-text/50 text-center mb-3 max-w-md">
                {error.message}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  onClick={handleRetry}
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 px-2.5 py-1.5 group text-daintree-accent/70 hover:text-daintree-accent"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  <span className="text-xs">Retry</span>
                </Button>
                {currentUrl && (
                  <Button
                    onClick={handleOpenExternal}
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span className="text-xs">Open External</span>
                  </Button>
                )}
              </div>
            </div>
          ) : !currentUrl || status !== "running" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
              {isUnconfigured ? (
                <div className="flex flex-col items-center text-center max-w-md">
                  <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
                    Configure Dev Server
                  </h3>
                  <p className="text-xs text-daintree-text/50 mb-4 leading-relaxed">
                    No dev server command is configured for this project.
                    {allDetectedRunners &&
                    findDevServerCandidate(
                      allDetectedRunners,
                      projectSettings?.turbopackEnabled ?? true
                    )
                      ? " We found a script in your package.json that looks like a dev server."
                      : " Configure one to preview your application."}
                  </p>
                  <div className="flex flex-col items-center gap-2">
                    {allDetectedRunners &&
                      findDevServerCandidate(
                        allDetectedRunners,
                        projectSettings?.turbopackEnabled ?? true
                      ) && (
                        <Button
                          onClick={handleAutoDetect}
                          disabled={isAutoDetecting || isSettingsLoading}
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 px-2.5 py-1.5 group text-daintree-accent/70 hover:text-daintree-accent"
                        >
                          <WandSparkles className="h-3.5 w-3.5" />
                          <span className="text-xs">
                            {isAutoDetecting
                              ? "Detecting..."
                              : `Use \`${findDevServerCandidate(allDetectedRunners, projectSettings?.turbopackEnabled ?? true)?.command}\``}
                          </span>
                        </Button>
                      )}
                    <Button
                      onClick={handleOpenSettings}
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70"
                    >
                      <Settings className="h-3.5 w-3.5" />
                      <span className="text-xs">Open Project Settings</span>
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center text-center max-w-md">
                  <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
                    Waiting for Dev Server
                  </h3>
                  <p className="text-xs text-daintree-text/50 mb-4 leading-relaxed">
                    The development server will appear here once it starts and a URL is detected.
                  </p>
                </div>
              )}
            </div>
          ) : !hasBeenVisible ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text">
              <p className="text-xs text-daintree-text/50">
                Preview will load when this panel is first viewed
              </p>
            </div>
          ) : isEvicted ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
              <p className="text-xs text-daintree-text/50">Reclaimed for memory</p>
            </div>
          ) : (
            <div className={cn("h-full", viewportPreset && "flex items-start justify-center pt-5")}>
              <div
                className={cn(
                  "relative",
                  viewportPreset
                    ? "rounded-lg border border-overlay/50 shadow-[var(--theme-shadow-floating)] overflow-hidden"
                    : "h-full"
                )}
                style={
                  viewportPreset
                    ? {
                        maxWidth: getViewportPreset(viewportPreset).width,
                        width: "100%",
                        aspectRatio: `${getViewportPreset(viewportPreset).width} / ${getViewportPreset(viewportPreset).height}`,
                      }
                    : undefined
                }
              >
                <>
                  {webviewLoadError && (
                    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
                      <AlertTriangle className="w-6 h-6 text-status-warning mb-3" />
                      <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
                        Dev Server Unreachable
                      </h3>
                      <p className="text-xs text-daintree-text/50 text-center mb-3 max-w-md">
                        {webviewLoadError}
                      </p>
                      <Button
                        onClick={handleHardRestart}
                        variant="ghost"
                        size="sm"
                        className="gap-1.5 px-2.5 py-1.5 group text-daintree-accent/70 hover:text-daintree-accent"
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                        <span className="text-xs">Hard Restart</span>
                      </Button>
                    </div>
                  )}
                  {blockedNav && (
                    <BlockedNavBanner
                      blockedNav={blockedNav}
                      panelId={id}
                      webviewElement={webviewElement}
                      onDismiss={() => setBlockedNav(null)}
                    />
                  )}
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
              </div>
            </div>
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
