import { useState, useCallback, useRef, useEffect, useMemo, useReducer } from "react";
import { OctagonAlert, RotateCw } from "lucide-react";
import { DevPreviewDestructiveConfirmDialog } from "./DevPreviewDestructiveConfirmDialog";
import { usePanelStore } from "@/store";
import { useProjectStore } from "@/store/projectStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import type { BrowserHistory } from "@shared/types/browser";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { BrowserToolbar } from "../Browser/BrowserToolbar";
import { InlineStatusBanner } from "../Terminal/InlineStatusBanner";
import { DevPreviewStuckBanner, DevPreviewHmrDeadBanner } from "./DevPreviewBanners";
import { initializeBrowserHistory } from "../Browser/historyUtils";
import { useDevServer } from "@/hooks/useDevServer";
import { ConsoleDrawer } from "./ConsoleDrawer";
import { useDevPreviewConsoleCapture } from "./useDevPreviewConsoleCapture";
import { useDevPreviewCommandConfig } from "./useDevPreviewCommandConfig";
import { useDevPreviewScrollCapture } from "./useDevPreviewScrollCapture";
import { useDevPreviewCrashRecovery } from "./useDevPreviewCrashRecovery";
import { useDevPreviewViewport } from "./useDevPreviewViewport";
import { DevPreviewWebviewOverlays } from "./DevPreviewWebviewOverlays";
import { useDevPreviewNavigation } from "./useDevPreviewNavigation";
import { DevPreviewEmptyStates } from "./DevPreviewEmptyStates";
import { useIsDragging } from "@/components/DragDrop";
import { cn } from "@/lib/utils";
import { useWebviewThrottle } from "@/hooks/useWebviewThrottle";
import { useHasBeenVisible } from "@/hooks/useHasBeenVisible";
import { useWebviewEviction } from "@/hooks/useWebviewEviction";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { useWebviewDialog } from "@/hooks/useWebviewDialog";
import { useFindInPage } from "@/hooks/useFindInPage";
import { useKeybindingScope } from "@/hooks/useKeybinding";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { getViewportPreset } from "@/panels/dev-preview/viewportPresets";
import { isDevPreviewPanel } from "@shared/types/panel";
import { logError } from "@/utils/logger";
import { loadWebviewUrl } from "./loadWebviewUrl";
import { useDevPreviewLoadLifecycle, type SessionStorageEntry } from "./useDevPreviewLoadLifecycle";

import { blockedNavReducer } from "./BlockedNavBanner";
import { looksLikeOAuthUrl } from "@shared/utils/urlUtils";
import { buildDevPreviewProxyOrigin } from "@shared/utils/devPreviewProxy";
import { buildDevPreviewPartition } from "@shared/utils/partitionUtils";

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
  isMultiPanelGrid,
}: DevPreviewPaneProps) {
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const [webviewElement, setWebviewElement] = useState<Electron.WebviewTag | null>(null);
  const setBrowserUrl = usePanelStore((state) => state.setBrowserUrl);
  const setBrowserHistory = usePanelStore((state) => state.setBrowserHistory);
  const setBrowserZoom = usePanelStore((state) => state.setBrowserZoom);
  const setDevPreviewConsoleOpen = usePanelStore((state) => state.setDevPreviewConsoleOpen);
  const setDevPreviewConsoleTab = usePanelStore((state) => state.setDevPreviewConsoleTab);
  const setViewportPreset = usePanelStore((state) => state.setViewportPreset);
  const setViewportRotated = usePanelStore((state) => state.setViewportRotated);
  const setViewportDpr = usePanelStore((state) => state.setViewportDpr);
  const setViewportFit = usePanelStore((state) => state.setViewportFit);
  const setDevPreviewScrollPosition = usePanelStore((state) => state.setDevPreviewScrollPosition);
  const currentProjectId = useProjectStore((state) => state.currentProject?.id);
  const projectSettings = useProjectSettingsStore((state) => state.settings);
  const projectEnv = projectSettings?.environmentVariables;
  const isDragging = useIsDragging();

  const terminal = usePanelStore((state) => {
    const p = state.getTerminal(id);
    return p && isDevPreviewPanel(p) ? p : undefined;
  });
  const devCommand =
    terminal?.devCommand?.trim() || projectSettings?.devServerCommand?.trim() || "";
  const viewportPreset = terminal?.viewportPreset;
  const viewportRotated = terminal?.viewportRotated ?? false;
  const viewportDpr = terminal?.viewportDpr ?? 1;
  const viewportFit = terminal?.viewportFit ?? false;

  const {
    status,
    url,
    terminalId,
    error,
    phaseLabel,
    start,
    stop,
    restart,
    isRestarting,
    stuckTier,
    forceKilled,
    crashLoopStopped,
  } = useDevServer({
    panelId: id,
    devCommand,
    cwd,
    worktreeId,
    env: projectEnv,
    turbopackEnabled: projectSettings?.turbopackEnabled ?? true,
  });

  const { captureScrollViaCdp, invalidateScrollCaptures } = useDevPreviewScrollCapture({
    id,
    status,
    webviewElement,
    setDevPreviewScrollPosition,
  });

  const webviewPartition = useMemo(
    () => buildDevPreviewPartition(currentProjectId, worktreeId, id),
    [currentProjectId, worktreeId, id]
  );

  // Resolve the dev-preview reverse proxy port once, then derive the stable origin this
  // panel's webview loads (#9100). `undefined` = still fetching (hold navigation until it
  // settles so we don't flash the unstable direct-localhost origin); `null` = proxy
  // unavailable, fall back to the legacy direct-localhost behavior.
  const [proxyPort, setProxyPort] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    // Tolerate a bridge that predates the proxy IPC (older preload, partial test mock): degrade
    // to null = legacy direct-localhost mode rather than crashing or hanging in the loading gate.
    const getProxyPort = window.electron?.devPreview?.getProxyPort;
    if (typeof getProxyPort !== "function") {
      setProxyPort(null);
      return;
    }
    getProxyPort()
      .then(({ port }) => {
        if (!cancelled) setProxyPort(port);
      })
      .catch(() => {
        if (!cancelled) setProxyPort(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const proxyOrigin = useMemo<string | null | undefined>(() => {
    if (proxyPort === undefined) return undefined;
    if (proxyPort === null || !currentProjectId) return null;
    return buildDevPreviewProxyOrigin(proxyPort, currentProjectId, id);
  }, [proxyPort, currentProjectId, id]);

  const [forceKillBannerDismissed, setForceKillBannerDismissed] = useState(false);

  useEffect(() => {
    if (forceKilled) {
      setForceKillBannerDismissed(false);
    }
  }, [forceKilled]);

  const [crashLoopBannerDismissed, setCrashLoopBannerDismissed] = useState(false);

  useEffect(() => {
    if (crashLoopStopped) {
      setCrashLoopBannerDismissed(false);
    }
  }, [crashLoopStopped]);

  const [history, setHistory] = useState<BrowserHistory>(() => {
    const saved = terminal?.browserHistory;
    return initializeBrowserHistory(saved, "");
  });

  const [zoomFactor, setZoomFactor] = useState<number>(() => {
    const savedZoom = terminal?.browserZoom ?? 1.0;
    return Number.isFinite(savedZoom) ? Math.max(0.25, Math.min(2.0, savedZoom)) : 1.0;
  });

  const [blockedNav, dispatchBlockedNav] = useReducer(blockedNavReducer, null);
  const crashReloadRef = useRef<() => void>(() => {});
  const blockedNavTimerRef = useRef<NodeJS.Timeout | null>(null);
  const CLIPBOARD_FEEDBACK_MS = 2000;
  const [certCopied, setCertCopied] = useState(false);
  const certCopyTimerRef = useRef<NodeJS.Timeout | null>(null);
  const handleCopyMkcert = useCallback(async () => {
    try {
      await window.electron.clipboard.writeText("mkcert -install");
      setCertCopied(true);
      if (certCopyTimerRef.current) clearTimeout(certCopyTimerRef.current);
      certCopyTimerRef.current = setTimeout(() => setCertCopied(false), CLIPBOARD_FEEDBACK_MS);
    } catch {
      // clipboard unavailable — silently ignore
    }
  }, []);
  useEffect(() => {
    return () => {
      if (certCopyTimerRef.current) clearTimeout(certCopyTimerRef.current);
    };
  }, []);
  // Seed `lastSetUrlRef` to the mount URL so the isWebviewReady navigation
  // effect does not fire a redundant loadURL on first ready (#9940). The
  // hard-restart path resets this to "" explicitly when unconfigured.
  const lastSetUrlRef = useRef<string>(history.present);
  // Seed value for the webview `src` attribute, captured once at mount. Never
  // re-bound to navigation state — Electron's SrcAttribute observer would turn
  // each guest navigation into a redundant full reload (#9940).
  const [webviewSeedUrl, setWebviewSeedUrl] = useState(history.present);
  const [consoleTerminalId, setConsoleTerminalId] = useState<string | null>(terminalId);
  const isConsoleOpen = terminal?.devPreviewConsoleOpen ?? false;
  const activeConsoleTab = terminal?.devPreviewConsoleTab ?? "output";
  const [guestWebContentsId, setGuestWebContentsId] = useState<number | undefined>(undefined);
  // Store the original guest UA so we can restore it when clearing a preset
  const originalUaRef = useRef<string | null>(null);
  const isSettingsLoading = useProjectSettingsStore((state) => state.isLoading);

  const isMountedRef = useRef(true);

  const loadTimeoutMs =
    Math.min(Math.max(projectSettings?.devServerLoadTimeout ?? 30, 1), 120) * 1000;

  const hasBeenVisible = useHasBeenVisible(id, location);

  const currentUrl = history.present;
  const effectiveWebviewSeedUrl = webviewSeedUrl || currentUrl;
  const canGoBack = history.past.length > 0;
  const canGoForward = history.future.length > 0;
  const isUnconfigured =
    Boolean(currentProjectId) && !isSettingsLoading && projectSettings !== null && !devCommand;

  const {
    headerContent,
    candidates,
    primaryCandidate,
    isAutoDetecting,
    autoDetectFailedCommand,
    handleAutoDetect,
    handlePickCandidate,
    pickerOpen,
    setPickerOpen,
    commandInput,
    setCommandInput,
    commandInputError,
    handleSaveCommand,
    handleOpenSettings,
  } = useDevPreviewCommandConfig({
    currentProjectId,
    devCommand,
    isUnconfigured,
    projectSettings,
    stop,
    isMountedRef,
  });

  // Hold the webview (show the loading state) while the dev server is running but the pane
  // hasn't settled onto the stable proxy origin yet (#9100). Covers two cases: the proxy port
  // is still being fetched (proxyOrigin === undefined), and an upgraded session whose persisted
  // history is a raw localhost URL that the navigation effect is about to migrate. Without this
  // the webview would briefly load the unstable origin. Legacy mode (proxyOrigin === null) opts
  // out entirely.
  const isProxyUrlPending =
    status === "running" &&
    (proxyOrigin === undefined ||
      (typeof proxyOrigin === "string" && !!currentUrl && !currentUrl.startsWith(proxyOrigin)));

  useEffect(() => {
    if (!webviewSeedUrl && currentUrl) {
      setWebviewSeedUrl(currentUrl);
    }
  }, [currentUrl, webviewSeedUrl]);

  const { isEvicted, evictingRef } = useWebviewEviction(id, location);

  const [isRecoveringFromEviction, setIsRecoveringFromEviction] = useState(false);
  const previousIsEvictedRef = useRef(false);

  useEffect(() => {
    if (previousIsEvictedRef.current && !isEvicted && hasBeenVisible) {
      setIsRecoveringFromEviction(true);
    }
    if (isEvicted) {
      setIsRecoveringFromEviction(false);
    }
    previousIsEvictedRef.current = isEvicted;
  }, [isEvicted, hasBeenVisible]);

  const showRecoverySpinner = useDohertyGate(isRecoveringFromEviction);

  useEffect(() => {
    const webview = webviewElement;
    if (!webview || !isRecoveringFromEviction) return;

    const handleRecoveryFinishLoad = () => {
      try {
        if (webview.getURL() !== "about:blank") {
          setIsRecoveringFromEviction(false);
        }
      } catch {
        // Webview detached
      }
    };

    webview.addEventListener("did-finish-load", handleRecoveryFinishLoad);

    try {
      if (webview.getURL() !== "about:blank" && !webview.isLoading()) {
        setIsRecoveringFromEviction(false);
      }
    } catch {
      // Webview not ready
    }

    return () => {
      webview.removeEventListener("did-finish-load", handleRecoveryFinishLoad);
    };
  }, [isRecoveringFromEviction, webviewElement]);

  const consoleAutoOpenedErrorRef = useRef<string | null>(null);
  const consoleAutoOpenedStallRef = useRef(false);

  useEffect(() => {
    if (status === "error" && error && consoleAutoOpenedErrorRef.current !== error.message) {
      consoleAutoOpenedErrorRef.current = error.message;
      setDevPreviewConsoleOpen(id, true);
    }
    if (status !== "error") {
      consoleAutoOpenedErrorRef.current = null;
    }
  }, [status, error, id, setDevPreviewConsoleOpen]);

  useEffect(() => {
    if (status !== "starting" && status !== "installing") {
      consoleAutoOpenedStallRef.current = false;
    }
    if (
      (status !== "starting" && status !== "installing") ||
      url ||
      phaseLabel ||
      consoleAutoOpenedStallRef.current
    ) {
      return;
    }

    const timer = setTimeout(() => {
      if ((status === "starting" || status === "installing") && !url && !phaseLabel) {
        consoleAutoOpenedStallRef.current = true;
        setDevPreviewConsoleOpen(id, true);
      }
    }, 15_000);

    return () => clearTimeout(timer);
  }, [status, url, phaseLabel, id, setDevPreviewConsoleOpen]);

  const {
    crashState,
    crashDetails,
    handleRenderProcessGone,
    resetCrashHistory,
    clearUnresponsiveState,
  } = useDevPreviewCrashRecovery({
    id,
    currentUrl,
    crashReloadRef,
  });

  const {
    isWebviewReady,
    setIsWebviewReady,
    isLoading,
    setIsLoading,
    webviewLoadError,
    setWebviewLoadError,
    reconnectAttempt,
    clearLoadTimers,
    clearRetryState,
  } = useDevPreviewLoadLifecycle({
    webviewElement,
    id,
    projectId: currentProjectId,
    loadTimeoutMs,
    zoomFactor,
    evictingRef,
    lastSetUrlRef,
    originalUaRef,
    setHistory,
    setBlockedNav: dispatchBlockedNav,
    onRenderProcessGone: handleRenderProcessGone,
  });

  useEffect(() => {
    if (!isUnconfigured) return;
    setHistory(initializeBrowserHistory(undefined, ""));
    setBrowserUrl(id, "");
    setWebviewSeedUrl("");
    lastSetUrlRef.current = "";
    setWebviewLoadError(null);
    clearRetryState();
    setCommandInput("");
  }, [isUnconfigured, id, setBrowserUrl, setWebviewLoadError, clearRetryState, setCommandInput]);

  const setWebviewNode = useCallback(
    (node: Electron.WebviewTag | null) => {
      if (!node && webviewRef.current) {
        try {
          captureScrollViaCdp(webviewRef.current);
        } catch {
          // Webview already detached
        }
      }
      webviewRef.current = node;
      if (node) {
        // Match the `src` seed so the isWebviewReady navigation effect does not
        // re-load the same URL on first ready (#9940). The isUnconfigured effect
        // resets this to "" afterward when there is no dev command.
        lastSetUrlRef.current = effectiveWebviewSeedUrl;
        clearRetryState();
      }
      setWebviewElement(node);
    },
    [captureScrollViaCdp, clearRetryState, effectiveWebviewSeedUrl]
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setConsoleTerminalId(terminalId);
  }, [terminalId]);

  const performReload = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !isWebviewReady) return;
    setWebviewLoadError(null);
    try {
      const wcId = (webview as unknown as { getWebContentsId(): number }).getWebContentsId();
      safeFireAndForget(window.electron.webview.reloadIgnoringCache(wcId, id), {
        context: "Reloading dev preview ignoring cache",
      });
    } catch {
      webview.reload();
    }
  }, [isWebviewReady, id, setWebviewLoadError]);

  const handleHardReload = useCallback(() => {
    resetCrashHistory();
    performReload();
  }, [resetCrashHistory, performReload]);

  // Keep crashReloadRef in sync so onRenderProcessGone can call performReload
  // before it exists in the lexical scope.
  useEffect(() => {
    crashReloadRef.current = performReload;
  }, [performReload]);

  const {
    handleNavigate,
    handleBack,
    handleForward,
    handleReload,
    handleCancelLoad,
    handleRetryWebviewLoad,
    handleCaptureScreenshot,
    handleToggleDevTools,
    handleToggleConsole,
    handleZoomChange,
    handleOpenExternal,
    handlePromoteToPortal,
  } = useDevPreviewNavigation({
    id,
    currentProjectId,
    currentUrl,
    canGoBack,
    canGoForward,
    history,
    setHistory,
    zoomFactor,
    setZoomFactor,
    devServerUrl: url,
    proxyOrigin,
    isUnconfigured,
    isWebviewReady,
    webviewRef,
    setBrowserUrl,
    setBrowserHistory,
    setBrowserZoom,
    setIsLoading,
    setWebviewLoadError,
    clearLoadTimers,
    isConsoleOpen,
    setDevPreviewConsoleOpen,
    onHardReload: handleHardReload,
  });

  const handleRetry = useCallback(() => {
    void start();
  }, [start]);

  const resetPreviewWebviewState = useCallback(() => {
    invalidateScrollCaptures();
    setDevPreviewScrollPosition(id, undefined);
    clearLoadTimers();
    setHistory(initializeBrowserHistory(undefined, ""));
    setBrowserUrl(id, "");
    setWebviewSeedUrl("");
    lastSetUrlRef.current = "";
    setIsLoading(false);
    setIsWebviewReady(false);
    setWebviewLoadError(null);
    resetCrashHistory();
  }, [
    id,
    setBrowserUrl,
    setDevPreviewScrollPosition,
    invalidateScrollCaptures,
    clearLoadTimers,
    setIsLoading,
    setIsWebviewReady,
    setWebviewLoadError,
    resetCrashHistory,
  ]);

  const handleRestartDevServer = useCallback(() => {
    resetPreviewWebviewState();
    void restart();
  }, [resetPreviewWebviewState, restart]);

  // A "restored-stopped" panel has no live backend session (the process was
  // not reattached across relaunch), so start()/ensure() — not restart() — is
  // what re-issues the prior command. #9094.
  const handleStartFromRestored = useCallback(() => {
    resetPreviewWebviewState();
    void start();
  }, [resetPreviewWebviewState, start]);

  const confirmRestartInFlightRef = useRef(false);
  const [pendingRestartTier, setPendingRestartTier] = useState<
    "restartAndClearCache" | "reinstallAndRestart" | null
  >(null);
  const isRestartConfirmOpen = pendingRestartTier !== null;

  const handleRequestRestartAndClearCache = useCallback(() => {
    setPendingRestartTier("restartAndClearCache");
  }, []);

  const handleRequestReinstallAndRestart = useCallback(() => {
    setPendingRestartTier("reinstallAndRestart");
  }, []);

  const handleRestartConfirmClose = useCallback(() => {
    setPendingRestartTier(null);
  }, []);

  const handleRestartConfirm = useCallback(() => {
    if (confirmRestartInFlightRef.current) return;
    const tier = pendingRestartTier;
    if (!tier || !currentProjectId) return;

    confirmRestartInFlightRef.current = true;

    const onSuccess = () => {
      resetPreviewWebviewState();
      confirmRestartInFlightRef.current = false;
      setPendingRestartTier(null);
    };

    const onError = (err: unknown) => {
      console.warn("[DevPreviewPane] Restart confirm failed", err);
      confirmRestartInFlightRef.current = false;
      setPendingRestartTier(null);
    };

    if (tier === "restartAndClearCache") {
      window.electron.devPreview
        .restartAndClearCache({ panelId: id, projectId: currentProjectId })
        .then(onSuccess, onError);
    } else {
      window.electron.devPreview
        .reinstallAndRestart({ panelId: id, projectId: currentProjectId })
        .then(onSuccess, onError);
    }
  }, [pendingRestartTier, currentProjectId, id, resetPreviewWebviewState]);

  const handleStuckRemedy = useCallback((actionId: string) => {
    if (actionId === "devPreview.restartAndClearCache") {
      setPendingRestartTier("restartAndClearCache");
    } else if (actionId === "devPreview.reinstallAndRestart") {
      setPendingRestartTier("reinstallAndRestart");
    }
  }, []);

  const {
    effectiveViewport,
    fitScale,
    setFitContainerEl,
    handleViewportPresetChange,
    handleViewportRotateToggle,
    handleViewportDprChange,
    handleViewportFitToggle,
  } = useDevPreviewViewport({
    id,
    viewportPreset,
    viewportRotated,
    viewportDpr,
    viewportFit,
    isWebviewReady,
    webviewElement,
    originalUaRef,
    setViewportPreset,
    setViewportRotated,
    setViewportDpr,
    setViewportFit,
  });

  useEffect(() => {
    if (isWebviewReady && currentUrl && currentUrl !== lastSetUrlRef.current) {
      lastSetUrlRef.current = currentUrl;
      if (webviewElement) {
        try {
          const loadedUrl = webviewElement.getURL();
          if (loadedUrl !== currentUrl) {
            // Imperative load only — never write `.src`, which would re-trigger
            // Electron's SrcAttribute observer into a redundant reload (#9940).
            loadWebviewUrl(webviewElement, currentUrl);
          }
        } catch {
          // getURL() threw — the webview is detaching/unready. The ready
          // lifecycle re-drives the load on recovery; don't write `.src` here.
        }
      }
    }
  }, [currentUrl, isWebviewReady, webviewElement]);

  // Wire the guest-page CDP console capture into the renderer store. The hook
  // owns start/stop keyed on the ready/eviction lifecycle; here we only mirror
  // the live webContentsId so lazy object inspection can reach the right guest.
  const { hmrDead, resetHmrDead } = useDevPreviewConsoleCapture(
    id,
    webviewElement,
    isWebviewReady,
    isEvicted
  );

  // A dead HMR socket is a per-load condition. Webview reloads/navigations
  // clear it inside the hook (the guest execution context is torn down), so
  // here we only need to cover the dev-server lifecycle: clear the warning
  // whenever the server leaves the running state (restart/stop/crash).
  useEffect(() => {
    if (status !== "running") resetHmrDead();
  }, [status, resetHmrDead]);

  useEffect(() => {
    if (!isWebviewReady || isEvicted) {
      setGuestWebContentsId(undefined);
      return;
    }
    try {
      setGuestWebContentsId(webviewRef.current?.getWebContentsId());
    } catch {
      setGuestWebContentsId(undefined);
    }
  }, [isWebviewReady, isEvicted]);

  // Blank the webview and clear timers before React unmounts it for faster memory reclamation
  useEffect(() => {
    if (isEvicted) {
      // Clear crash state so a restored panel doesn't surface a stale banner.
      // The eviction placeholder owns the visual signal in that window.
      resetCrashHistory();
    }
    if (isEvicted && webviewRef.current) {
      try {
        // Save scroll position before eviction. See useDevPreviewScrollCapture
        // for why this uses the CDP path rather than executeJavaScript.
        const wv = webviewRef.current;
        captureScrollViaCdp(wv);
        wv.src = "about:blank";
      } catch {
        // webview may already be detached
      }
      clearLoadTimers();
      clearRetryState();
    }
  }, [isEvicted, resetCrashHistory, captureScrollViaCdp, clearLoadTimers, clearRetryState]);

  useWebviewThrottle(id, location, isEvicted ? null : webviewElement, isWebviewReady && !isEvicted);

  const { currentDialog, handleDialogRespond } = useWebviewDialog(
    id,
    isEvicted ? null : webviewElement,
    isWebviewReady && !isEvicted,
    "dev-preview"
  );

  // Consolidated emulation effect above handles all preset/rotation/DPR changes.
  // Cross-origin navigation re-apply is handled in useDevPreviewLoadLifecycle's
  // did-finish-load handler so emulation survives renderer process swaps.
  const findInPage = useFindInPage(
    id,
    isEvicted ? null : webviewElement,
    isWebviewReady && !isEvicted,
    isFocused
  );

  // Activate the dev-preview keybinding scope while focused so Cmd/Ctrl+R maps
  // to devPreview.reloadPreview when the panel chrome (toolbar/header) has focus.
  // The guest-focused case is covered separately by useDevPreviewNavigation's
  // onReloadShortcut listener.
  useKeybindingScope("dev-preview", isFocused);

  // Listen for blocked navigation events from main process.
  // 150ms debounce: latest URL wins — repeated blocks within the window
  // replace the pending data rather than stacking.
  useEffect(() => {
    let disposed = false;
    let latestBlockedData: { url: string; canOpenExternal: boolean } | null = null;

    const cleanup = window.electron.webview.onNavigationBlocked((data) => {
      if (data.panelId !== id) return;
      latestBlockedData = { url: data.url, canOpenExternal: data.canOpenExternal };
      const sessionStorageSnapshotPromise = looksLikeOAuthUrl(data.url)
        ? captureWebviewSessionStorage(webviewElement)
        : Promise.resolve<SessionStorageEntry[]>([]);

      if (blockedNavTimerRef.current) {
        clearTimeout(blockedNavTimerRef.current);
      }
      blockedNavTimerRef.current = setTimeout(() => {
        const latestData = latestBlockedData;
        void sessionStorageSnapshotPromise
          .then((sessionStorageSnapshot) => {
            if (disposed) return;
            dispatchBlockedNav({
              type: "BLOCKED",
              url: latestData?.url ?? data.url,
              canOpenExternal: latestData?.canOpenExternal ?? data.canOpenExternal,
              sessionStorageSnapshot,
            });
            blockedNavTimerRef.current = null;
          })
          .catch((err) => {
            if (!disposed) logError("Failed to capture session storage snapshot", err);
          });
      }, 150);
    });
    return () => {
      disposed = true;
      cleanup();
      if (blockedNavTimerRef.current) {
        clearTimeout(blockedNavTimerRef.current);
        blockedNavTimerRef.current = null;
      }
    };
  }, [id, webviewElement]);

  // Mirrors the branch order in DevPreviewEmptyStates: true whenever that
  // ternary chain there would pick one of its non-null branches instead of
  // falling through to the live webview.
  const showEmptyState =
    isRestarting ||
    status === "starting" ||
    status === "installing" ||
    isProxyUrlPending ||
    (status === "error" && !!error) ||
    !currentUrl ||
    status !== "running" ||
    !hasBeenVisible ||
    isEvicted;

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
      isMultiPanelGrid={isMultiPanelGrid}
      kind="dev-preview"
      headerContent={headerContent}
      headerContentPlacement="leading"
      className={
        phaseLabel === "Compiling"
          ? "panel-state-compiling"
          : stuckTier >= 1
            ? "panel-state-working"
            : undefined
      }
    >
      <div className="flex flex-col h-full">
        <BrowserToolbar
          terminalId={id}
          projectId={currentProjectId}
          url={currentUrl}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          isLoading={isLoading}
          zoomFactor={zoomFactor}
          isWebviewReady={isWebviewReady}
          isConsoleOpen={isConsoleOpen}
          viewportPreset={viewportPreset}
          viewportRotated={viewportRotated}
          viewportDpr={viewportDpr}
          viewportFit={viewportFit}
          onNavigate={handleNavigate}
          onBack={handleBack}
          onForward={handleForward}
          onReload={handleReload}
          onHardReload={handleHardReload}
          onOpenExternal={handleOpenExternal}
          onPromoteToPortal={currentUrl ? handlePromoteToPortal : undefined}
          onZoomChange={handleZoomChange}
          onCaptureScreenshot={handleCaptureScreenshot}
          onToggleDevTools={handleToggleDevTools}
          onToggleConsole={handleToggleConsole}
          onViewportPresetChange={handleViewportPresetChange}
          onViewportRotateToggle={handleViewportRotateToggle}
          onViewportDprChange={handleViewportDprChange}
          onViewportFitToggle={handleViewportFitToggle}
        />

        {stuckTier >= 2 && (
          <DevPreviewStuckBanner
            tier={stuckTier >= 3 ? 3 : 2}
            error={error}
            isRestarting={isRestarting}
            phaseLabel={phaseLabel}
            onRestart={handleRestartDevServer}
            onRemedy={handleStuckRemedy}
          />
        )}

        {status === "running" && hmrDead && <DevPreviewHmrDeadBanner onReload={handleReload} />}

        <div
          className={cn(
            "relative flex-1 min-h-0 bg-surface-canvas",
            viewportPreset && viewportFit ? "overflow-hidden" : "overflow-auto"
          )}
        >
          {viewportPreset && effectiveViewport && (
            <div className="absolute top-1 left-1/2 -translate-x-1/2 z-10 px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface/90 text-daintree-text/60 border border-overlay/50">
              {getViewportPreset(viewportPreset).label} · {effectiveViewport.width}×
              {effectiveViewport.height}
              {viewportFit && fitScale < 1 && ` · ${Math.round(fitScale * 100)}%`}
            </div>
          )}
          {showEmptyState ? (
            <DevPreviewEmptyStates
              isRestarting={isRestarting}
              status={status}
              isProxyUrlPending={isProxyUrlPending}
              phaseLabel={phaseLabel}
              error={error}
              handleRetry={handleRetry}
              setDevPreviewConsoleOpen={setDevPreviewConsoleOpen}
              id={id}
              currentUrl={currentUrl}
              handleOpenExternal={handleOpenExternal}
              isUnconfigured={isUnconfigured}
              primaryCandidate={primaryCandidate}
              isAutoDetecting={isAutoDetecting}
              isSettingsLoading={isSettingsLoading}
              handleAutoDetect={handleAutoDetect}
              autoDetectFailedCommand={autoDetectFailedCommand}
              candidates={candidates}
              pickerOpen={pickerOpen}
              setPickerOpen={setPickerOpen}
              handlePickCandidate={handlePickCandidate}
              handleOpenSettings={handleOpenSettings}
              commandInput={commandInput}
              setCommandInput={setCommandInput}
              handleSaveCommand={handleSaveCommand}
              commandInputError={commandInputError}
              devCommand={devCommand}
              handleStartFromRestored={handleStartFromRestored}
              hasBeenVisible={hasBeenVisible}
              isEvicted={isEvicted}
            />
          ) : (
            <div
              ref={setFitContainerEl}
              className={cn(
                "h-full",
                viewportPreset &&
                  (viewportFit
                    ? "flex items-center justify-center"
                    : "flex items-start justify-center pt-5")
              )}
            >
              <div
                className={cn(
                  "relative",
                  viewportPreset
                    ? "rounded-lg border border-overlay/50 shadow-[var(--theme-shadow-floating)] overflow-hidden"
                    : "h-full"
                )}
                style={
                  viewportPreset && effectiveViewport
                    ? viewportFit
                      ? {
                          width: effectiveViewport.width * fitScale,
                          height: effectiveViewport.height * fitScale,
                        }
                      : {
                          maxWidth: effectiveViewport.width,
                          width: "100%",
                          aspectRatio: `${effectiveViewport.width} / ${effectiveViewport.height}`,
                        }
                    : undefined
                }
              >
                <DevPreviewWebviewOverlays
                  reconnectAttempt={reconnectAttempt}
                  webviewLoadError={webviewLoadError}
                  certCopied={certCopied}
                  onCopyMkcert={handleCopyMkcert}
                  isRestarting={isRestarting}
                  onRestartDevServer={handleRestartDevServer}
                  onHardReload={handleHardReload}
                  onRequestRestartAndClearCache={handleRequestRestartAndClearCache}
                  onRequestReinstallAndRestart={handleRequestReinstallAndRestart}
                  onRetryWebviewLoad={handleRetryWebviewLoad}
                  currentUrl={currentUrl}
                  onOpenExternal={handleOpenExternal}
                  blockedNav={blockedNav}
                  panelId={id}
                  webviewElement={webviewElement}
                  onDispatchBlockedNav={dispatchBlockedNav}
                  crashState={crashState}
                  crashDetails={crashDetails}
                  onCloseCrash={resetCrashHistory}
                  onCloseUnresponsive={clearUnresponsiveState}
                  isLoading={isLoading}
                  onCancelLoad={handleCancelLoad}
                  showRecoverySpinner={showRecoverySpinner}
                  isRecoveringFromEviction={isRecoveringFromEviction}
                  isDragging={isDragging}
                  findInPage={findInPage}
                  currentDialog={currentDialog}
                  onDialogRespond={handleDialogRespond}
                >
                  {/* Only the webview is scaled by zoom-to-fit; overlays above
                        stay at full size relative to the outer container so
                        their action buttons remain readable and clickable. */}
                  <div
                    className={
                      viewportPreset && viewportFit
                        ? "absolute top-0 left-0 origin-top-left"
                        : "w-full h-full"
                    }
                    style={
                      viewportPreset && viewportFit && effectiveViewport
                        ? {
                            width: effectiveViewport.width,
                            height: effectiveViewport.height,
                            transform: `scale(${fitScale})`,
                          }
                        : undefined
                    }
                  >
                    <webview
                      ref={setWebviewNode}
                      // Seed-only: never re-bind to navigation state (#9940).
                      src={effectiveWebviewSeedUrl}
                      partition={webviewPartition}
                      // @ts-expect-error React 19 requires "" to emit the attribute; boolean true is silently dropped
                      allowpopups=""
                      className={cn(
                        "w-full h-full border-0",
                        isDragging && "invisible pointer-events-none"
                      )}
                    />
                  </div>
                </DevPreviewWebviewOverlays>
              </div>
            </div>
          )}
        </div>

        {forceKilled && status === "stopped" && !forceKillBannerDismissed && (
          <InlineStatusBanner
            icon={OctagonAlert}
            title="Dev server was force-quit"
            description="The server did not exit within 5 seconds and was terminated."
            severity="warning"
            onClose={() => setForceKillBannerDismissed(true)}
            actions={[]}
          />
        )}
        {crashLoopStopped && status === "stopped" && !crashLoopBannerDismissed && (
          <InlineStatusBanner
            icon={OctagonAlert}
            title="Dev server stopped"
            description="The server crashed and restarted several times in a row. Check your dev server config, then restart once it's fixed."
            severity="warning"
            onClose={() => setCrashLoopBannerDismissed(true)}
            actions={[
              {
                id: "crash-loop-restart",
                label: "Restart dev server",
                icon: RotateCw,
                variant: "danger",
                onClick: handleRestartDevServer,
                ariaLabel: "Restart dev server",
              },
            ]}
          />
        )}
        {consoleTerminalId && (
          <ConsoleDrawer
            terminalId={consoleTerminalId}
            paneId={id}
            projectId={currentProjectId}
            webContentsId={guestWebContentsId}
            status={status}
            isOpen={isConsoleOpen}
            onOpenChange={(nextOpen) => setDevPreviewConsoleOpen(id, nextOpen)}
            activeTab={activeConsoleTab}
            onTabChange={(tab) => setDevPreviewConsoleTab(id, tab)}
            isRestarting={isRestarting}
            onReloadPreview={handleHardReload}
            onRestartDevServer={handleRestartDevServer}
            onRequestRestartAndClearCache={handleRequestRestartAndClearCache}
            onRequestReinstallAndRestart={handleRequestReinstallAndRestart}
            onStop={stop}
          />
        )}
        <DevPreviewDestructiveConfirmDialog
          panelId={id}
          projectId={currentProjectId}
          tier={pendingRestartTier}
          isOpen={isRestartConfirmOpen}
          onClose={handleRestartConfirmClose}
          onConfirm={handleRestartConfirm}
        />
      </div>
    </ContentPanel>
  );
}
