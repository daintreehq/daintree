import { useState, useCallback, useRef, useEffect, useMemo, useReducer } from "react";
import { useBrowserActionListeners } from "@/hooks/useBrowserActionListeners";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  OctagonAlert,
  Play,
  RotateCw,
  Settings,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DevPreviewDestructiveConfirmDialog } from "./DevPreviewDestructiveConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/Spinner";
import { usePanelStore } from "@/store";
import { useProjectStore } from "@/store/projectStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import type { BrowserHistory } from "@shared/types/browser";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { BrowserToolbar } from "../Browser/BrowserToolbar";
import { InlineStatusBanner } from "../Terminal/InlineStatusBanner";
import { BannerOverflowMenu } from "../Terminal/BannerOverflowMenu";
import { DevPreviewStuckBanner, DevPreviewHmrDeadBanner } from "./DevPreviewBanners";
import { normalizeBrowserUrl } from "../Browser/browserUtils";
import {
  goBackBrowserHistory,
  goForwardBrowserHistory,
  initializeBrowserHistory,
  pushBrowserHistory,
} from "../Browser/historyUtils";
import { useDevServer } from "@/hooks/useDevServer";
import { ConsoleDrawer } from "./ConsoleDrawer";
import { useDevPreviewConsoleCapture } from "./useDevPreviewConsoleCapture";
import { DevPreviewLoadingState } from "./DevPreviewLoadingState";
import { useIsDragging } from "@/components/DragDrop";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { computeDevServerUrl } from "./urlSync";
import { findDevServerCandidate, findAllDevServerCandidates } from "@/utils/devServerDetection";
import { useProjectSettings } from "@/hooks/useProjectSettings";
import { projectClient } from "@/clients";
import { getInvalidCommandMessage } from "@shared/utils/devCommandValidation";
import { actionService } from "@/services/ActionService";
import { useWebviewThrottle } from "@/hooks/useWebviewThrottle";
import { useHasBeenVisible } from "@/hooks/useHasBeenVisible";
import { useWebviewEviction } from "@/hooks/useWebviewEviction";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { useWebviewDialog } from "@/hooks/useWebviewDialog";
import { WebviewDialog } from "../Browser/WebviewDialog";
import { FindBar } from "../Browser/FindBar";
import { useFindInPage } from "@/hooks/useFindInPage";
import { useKeybindingScope } from "@/hooks/useKeybinding";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import {
  getViewportPreset,
  getEffectiveViewportSize,
  computeFitScale,
} from "@/panels/dev-preview/viewportPresets";
import { isDevPreviewPanel, type ViewportPresetId } from "@shared/types/panel";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getDevPreviewWebContents, buildEmulationParams } from "./viewportEmulation";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { loadWebviewUrl } from "./loadWebviewUrl";
import {
  useDevPreviewLoadLifecycle,
  webviewLoadErrorHeading,
  type SessionStorageEntry,
} from "./useDevPreviewLoadLifecycle";

import { BlockedNavBanner, blockedNavReducer } from "./BlockedNavBanner";
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
  const effectiveViewport = viewportPreset
    ? getEffectiveViewportSize(viewportPreset, viewportRotated)
    : null;

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
  const [crashState, setCrashState] = useState<"none" | "crashed" | "unresponsive">("none");
  const [crashDetails, setCrashDetails] = useState<{
    reason: string;
    exitCode: number;
  } | null>(null);
  const crashTimestampsRef = useRef<number[]>([]);
  const crashReloadRef = useRef<() => void>(() => {});
  const screenshotInFlightRef = useRef(false);
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
  // Generation token to invalidate in-flight async scroll captures when the
  // user clears scroll state via hard restart. A pending executeJavaScript
  // promise that resolves after the clear must NOT write the stale position back.
  const scrollCaptureGenerationRef = useRef<number>(0);
  const isConsoleOpen = terminal?.devPreviewConsoleOpen ?? false;
  const activeConsoleTab = terminal?.devPreviewConsoleTab ?? "output";
  const [guestWebContentsId, setGuestWebContentsId] = useState<number | undefined>(undefined);
  // Store the original guest UA so we can restore it when clearing a preset
  const originalUaRef = useRef<string | null>(null);
  const [isAutoDetecting, setIsAutoDetecting] = useState(false);
  // The command whose auto-detect/save attempt failed; null = no failure shown.
  // Empty string means the attempt never resolved a command (re-detection found
  // nothing), so retry falls back to the currently displayed candidate.
  const [autoDetectFailedCommand, setAutoDetectFailedCommand] = useState<string | null>(null);
  const autoDetectRef = useRef(false);

  useEffect(() => {
    if (devCommand) setAutoDetectFailedCommand(null);
  }, [devCommand]);
  const { saveSettings } = useProjectSettings();
  const allDetectedRunners = useProjectSettingsStore((state) => state.allDetectedRunners);
  const isSettingsLoading = useProjectSettingsStore((state) => state.isLoading);

  const candidates = useMemo(
    () => findAllDevServerCandidates(allDetectedRunners, projectSettings?.turbopackEnabled ?? true),
    [allDetectedRunners, projectSettings?.turbopackEnabled]
  );
  const primaryCandidate = candidates[0];
  const activeCandidate = candidates.find((c) => c.command.trim() === devCommand.trim());
  const headerLabel = activeCandidate?.name || devCommand;

  const [commandInput, setCommandInput] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const savingRef = useRef(false);

  const isMountedRef = useRef(true);
  const prevStatusRef = useRef(status);

  const loadTimeoutMs =
    Math.min(Math.max(projectSettings?.devServerLoadTimeout ?? 30, 1), 120) * 1000;

  const hasBeenVisible = useHasBeenVisible(id, location);

  const currentUrl = history.present;
  const effectiveWebviewSeedUrl = webviewSeedUrl || currentUrl;
  const canGoBack = history.past.length > 0;
  const canGoForward = history.future.length > 0;
  const isUnconfigured =
    Boolean(currentProjectId) && !isSettingsLoading && projectSettings !== null && !devCommand;

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

  const handleRenderProcessGone = useCallback(
    (details: { reason: string; exitCode: number }) => {
      const now = Date.now();
      const timestamps = crashTimestampsRef.current.filter((ts) => now - ts < 60_000);
      timestamps.push(now);
      crashTimestampsRef.current = timestamps;

      setCrashDetails(details);
      setCrashState("crashed");

      if (timestamps.length < 2) {
        crashReloadRef.current();
      } else {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Preview process crashed repeatedly",
          message: `The dev preview crashed (${details.reason}) twice within 60 seconds. Auto-recovery stopped. Use Reload or Hard restart to recover.`,
          priority: "high",
          duration: 0,
          context: { eventKind: "recovery", panelId: id },
          supersedeKey: `dev-preview-crash-loop:${id}`,
          correlationId: id,
        });
      }
    },
    [id]
  );

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
  }, [isUnconfigured, id, setBrowserUrl, setWebviewLoadError, clearRetryState]);

  const setWebviewNode = useCallback(
    (node: Electron.WebviewTag | null) => {
      if (!node && webviewRef.current) {
        try {
          const prevWebview = webviewRef.current;
          const currentWebviewUrl = prevWebview.getURL();
          if (currentWebviewUrl && currentWebviewUrl !== "about:blank") {
            const captureGeneration = scrollCaptureGenerationRef.current;
            // Use main-process CDP Page.getLayoutMetrics instead of
            // executeJavaScript("window.scrollY"): hidden dock webviews are
            // frozen by useWebviewThrottle (via Page.setWebLifecycleState) which
            // suspends the JS task queue, so the executeJavaScript path hangs
            // when memory-pressure eviction fires while the page is frozen.
            const wcId = (
              prevWebview as unknown as { getWebContentsId(): number }
            ).getWebContentsId();
            window.electron.webview
              .getScrollPosition(wcId)
              .then((scrollY: number) => {
                if (scrollCaptureGenerationRef.current !== captureGeneration) return;
                // Guard `> 0`: a CDP error returns 0, and the user being at top
                // of page has nothing worth restoring — both cases should leave
                // any prior stored position untouched rather than clobber it.
                if (typeof scrollY === "number" && Number.isFinite(scrollY) && scrollY > 0) {
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
        // Match the `src` seed so the isWebviewReady navigation effect does not
        // re-load the same URL on first ready (#9940). The isUnconfigured effect
        // resets this to "" afterward when there is no dev command.
        lastSetUrlRef.current = effectiveWebviewSeedUrl;
        clearRetryState();
      }
      setWebviewElement(node);
    },
    [id, setDevPreviewScrollPosition, clearRetryState, effectiveWebviewSeedUrl]
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
    // Hold navigation until the proxy port resolution settles, otherwise the pane would
    // briefly adopt the unstable direct-localhost origin before the proxy origin is known (#9100).
    if (proxyOrigin === undefined) return;
    const nextUrl = url ? computeDevServerUrl(url, currentUrl, proxyOrigin) : false;
    if (nextUrl !== false) {
      // Push history only; the imperative navigation effect (keyed on currentUrl
      // vs lastSetUrlRef) performs the actual loadURL. Pre-setting lastSetUrlRef
      // here would make that effect skip — which used to be fine when `src`
      // re-bound to currentUrl, but src is now seed-only (#9940).
      setHistory((prev) => pushBrowserHistory(prev, nextUrl));
    }
  }, [url, currentUrl, isUnconfigured, proxyOrigin]);

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
      // Push history only; the imperative navigation effect drives loadURL now
      // that `src` is seed-only (#9940). Mirrors handleBack/handleForward.
      setHistory((prev) => pushBrowserHistory(prev, normalized.url!));
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
    setWebviewLoadError(null);
    webviewRef.current?.reload();
  }, [setWebviewLoadError]);

  const handleCancelLoad = useCallback(() => {
    clearLoadTimers();
    setIsLoading(false);
    try {
      webviewRef.current?.stop();
    } catch {
      // Webview detached
    }
    setWebviewLoadError({ code: "aborted", message: "Load cancelled." });
  }, [clearLoadTimers, setIsLoading, setWebviewLoadError]);

  const handleRetryWebviewLoad = useCallback(() => {
    setWebviewLoadError(null);
    setIsLoading(true);
    if (currentUrl) {
      // Swallow ERR_ABORTED-class rejections — did-fail-load is the source
      // of truth for genuine failures.
      const webview = webviewRef.current;
      if (webview) {
        loadWebviewUrl(webview, currentUrl);
      }
    } else {
      webviewRef.current?.reload();
    }
  }, [currentUrl, setWebviewLoadError, setIsLoading]);

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

  const handleCaptureScreenshot = useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview || !isWebviewReady) return false;
    let url: string;
    try {
      url = webview.getURL();
    } catch {
      return false;
    }
    if (!url || url === "about:blank") return false;
    if (screenshotInFlightRef.current) return false;
    screenshotInFlightRef.current = true;
    try {
      const image = await webview.capturePage();
      const pngData = new Uint8Array(image.toPNG());
      await window.electron.clipboard.writeImage(pngData);
      return true;
    } catch (err) {
      logError("[DevPreviewPane] Screenshot capture failed", err);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Screenshot failed",
        message: "Couldn't copy the screenshot to clipboard",
      });
      return false;
    } finally {
      screenshotInFlightRef.current = false;
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
    setDevPreviewConsoleOpen(id, !isConsoleOpen);
  }, [id, isConsoleOpen, setDevPreviewConsoleOpen]);

  const handleHardReload = useCallback(() => {
    setCrashState("none");
    setCrashDetails(null);
    crashTimestampsRef.current = [];
    performReload();
  }, [performReload]);

  // Keep crashReloadRef in sync so onRenderProcessGone can call performReload
  // before it exists in the lexical scope.
  useEffect(() => {
    crashReloadRef.current = performReload;
  }, [performReload]);

  const handleOpenExternal = useCallback(() => {
    if (!currentUrl) return;

    // In proxy mode (#9101), hand the system browser a short-lived signed
    // bootstrap URL on the stable origin instead of the raw dev-server URL: it
    // lands with a session cookie and survives dev-server restarts that reshuffle
    // the upstream port. Fall back to the raw URL in legacy mode or if minting
    // fails, so the button always opens *something*.
    if (typeof proxyOrigin === "string" && currentProjectId && currentUrl.startsWith(proxyOrigin)) {
      // Preserve the hash too — hash-router SPAs keep their route in the fragment.
      const { pathname, search, hash } = new URL(currentUrl);
      safeFireAndForget(
        (async () => {
          try {
            const { bootstrapUrl } = await window.electron.devPreview.mintBrowserToken({
              panelId: id,
              projectId: currentProjectId,
              redirectPath: `${pathname}${search}${hash}`,
            });
            await window.electron.system.openExternal(bootstrapUrl);
          } catch (err) {
            logError("[DevPreviewPane] Browser handoff token failed; opening raw URL", err);
            await window.electron.system.openExternal(currentUrl);
          }
        })(),
        { context: "Opening dev preview URL externally" }
      );
      return;
    }

    safeFireAndForget(window.electron.system.openExternal(currentUrl), {
      context: "Opening dev preview URL externally",
    });
  }, [currentUrl, proxyOrigin, currentProjectId, id]);

  const isPromotingRef = useRef(false);
  const handlePromoteToPortal = useCallback(() => {
    if (isPromotingRef.current) return;
    isPromotingRef.current = true;
    if (currentUrl) {
      setBrowserUrl(id, currentUrl);
    }
    void actionService
      .dispatch(
        "devPreview.promoteToPortal",
        { panelId: id, projectId: currentProjectId },
        { source: "user" }
      )
      .finally(() => {
        isPromotingRef.current = false;
      });
  }, [currentProjectId, currentUrl, id, setBrowserUrl]);

  const handleZoomChange = useCallback((newZoom: number) => {
    const clamped = Math.max(0.25, Math.min(2.0, newZoom));
    setZoomFactor(clamped);
    if (webviewRef.current) {
      webviewRef.current.setZoomFactor(clamped);
    }
  }, []);

  useBrowserActionListeners(id, {
    onReload: handleReload,
    onNavigate: handleNavigate,
    onBack: handleBack,
    onForward: handleForward,
    onSetZoom: handleZoomChange,
    onCaptureScreenshot: handleCaptureScreenshot,
    onToggleDevTools: handleToggleDevTools,
    onToggleConsole: handleToggleConsole,
    onHardReload: handleHardReload,
  });

  const handleRetry = useCallback(() => {
    void start();
  }, [start]);

  const resetPreviewWebviewState = useCallback(() => {
    scrollCaptureGenerationRef.current += 1;
    setDevPreviewScrollPosition(id, undefined);
    clearLoadTimers();
    setHistory(initializeBrowserHistory(undefined, ""));
    setBrowserUrl(id, "");
    setWebviewSeedUrl("");
    lastSetUrlRef.current = "";
    setIsLoading(false);
    setIsWebviewReady(false);
    setWebviewLoadError(null);
    setCrashState("none");
    setCrashDetails(null);
    crashTimestampsRef.current = [];
  }, [
    id,
    setBrowserUrl,
    setDevPreviewScrollPosition,
    clearLoadTimers,
    setIsLoading,
    setIsWebviewReady,
    setWebviewLoadError,
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

  const handleAutoDetect = useCallback(
    async (candidateCommand?: string): Promise<boolean> => {
      if (!currentProjectId || autoDetectRef.current) return false;

      autoDetectRef.current = true;
      setIsAutoDetecting(true);
      setAutoDetectFailedCommand(null);
      let attemptedCommand = candidateCommand ?? "";
      try {
        const latestSettings = await projectClient.getSettings(currentProjectId);
        if (!latestSettings) {
          if (isMountedRef.current) setAutoDetectFailedCommand(attemptedCommand);
          return false;
        }

        let command = candidateCommand;
        if (!command) {
          const freshRunners = await projectClient.detectRunners(currentProjectId);
          command = findDevServerCandidate(
            freshRunners,
            latestSettings.turbopackEnabled ?? true
          )?.command;
        }

        if (!command) {
          if (isMountedRef.current) setAutoDetectFailedCommand("");
          return false;
        }
        attemptedCommand = command;

        await saveSettings({
          ...latestSettings,
          devServerCommand: command,
          devServerAutoDetected: true,
          devServerDismissed: false,
        });

        return true;
      } catch (err) {
        logError("Failed to auto-detect dev server", err);
        if (isMountedRef.current) setAutoDetectFailedCommand(attemptedCommand);
        return false;
      } finally {
        autoDetectRef.current = false;
        if (isMountedRef.current) {
          setIsAutoDetecting(false);
        }
      }
    },
    [currentProjectId, saveSettings]
  );

  const handlePickCandidate = useCallback(
    (candidate: { command: string }) => {
      void handleAutoDetect(candidate.command);
    },
    [handleAutoDetect]
  );

  const handleHeaderPickCandidate = useCallback(
    async (candidate: { command: string }) => {
      if (candidate.command.trim() === devCommand.trim()) return;
      const saved = await handleAutoDetect(candidate.command);
      if (saved) stop();
    },
    [devCommand, handleAutoDetect, stop]
  );

  const handleSaveCommand = useCallback(async () => {
    if (!currentProjectId || savingRef.current) return;
    const trimmed = commandInput.trim();
    if (!trimmed || getInvalidCommandMessage(trimmed)) return;

    savingRef.current = true;
    try {
      const latestSettings = await projectClient.getSettings(currentProjectId);
      if (!latestSettings) return;

      await saveSettings({
        ...latestSettings,
        devServerCommand: trimmed,
        devServerAutoDetected: false,
        devServerDismissed: false,
      });
    } catch (err) {
      logError("Failed to save dev command", err);
    } finally {
      savingRef.current = false;
    }
  }, [currentProjectId, commandInput, saveSettings]);

  const headerContent = useMemo(() => {
    if (isUnconfigured || candidates.length === 0) return null;

    return (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                className="flex h-6 items-center gap-1 px-1.5 rounded-sm hover:bg-daintree-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2 text-daintree-text/60 hover:text-daintree-text transition-colors max-w-[180px]"
                aria-label="Switch dev script"
              >
                <span className="min-w-0 text-xs truncate">{headerLabel}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Switch dev script</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" sideOffset={4} className="w-72 p-1">
          {candidates.map((c) => {
            const isActive = c.command.trim() === devCommand.trim();
            return (
              <DropdownMenuItem
                key={c.id}
                onSelect={() => void handleHeaderPickCandidate(c)}
                className={isActive ? "bg-overlay-subtle" : ""}
                aria-current={isActive ? "true" : undefined}
              >
                <span className="text-xs font-medium">{c.name}</span>
                <code className="text-[11px] text-daintree-text/50 truncate ml-auto">
                  {c.command}
                </code>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }, [isUnconfigured, candidates, devCommand, headerLabel, handleHeaderPickCandidate]);

  const commandInputError = useMemo(() => getInvalidCommandMessage(commandInput), [commandInput]);

  const handleOpenSettings = useCallback(() => {
    void actionService.dispatch("project.settings.open", undefined, { source: "user" });
  }, []);

  const handleViewportPresetChange = useCallback(
    (preset: ViewportPresetId | undefined) => {
      setViewportPreset(id, preset);
    },
    [id, setViewportPreset]
  );

  const handleViewportRotateToggle = useCallback(() => {
    setViewportRotated(id, !viewportRotated);
  }, [id, setViewportRotated, viewportRotated]);

  const handleViewportDprChange = useCallback(
    (dpr: 1 | 2 | 3) => {
      setViewportDpr(id, dpr);
    },
    [id, setViewportDpr]
  );

  const handleViewportFitToggle = useCallback(() => {
    setViewportFit(id, !viewportFit);
  }, [id, setViewportFit, viewportFit]);

  // Measure the available preview area so zoom-to-fit can scale the device
  // frame down to fit both pane dimensions. A static scale would break on
  // pane resize, so this tracks the container via ResizeObserver.
  // Callback ref (not useRef) so the observer effect re-runs when the
  // fit-container div mounts for the first time — it lives in the webview
  // branch, which only renders once the dev server reaches "running", long
  // after viewportFit/viewportPreset may have been set.
  const [fitContainerEl, setFitContainerEl] = useState<HTMLDivElement | null>(null);
  const [fitContainerSize, setFitContainerSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });
  useEffect(() => {
    if (!viewportFit || !viewportPreset || !fitContainerEl) return;
    const el = fitContainerEl;
    const measure = () => {
      setFitContainerSize({ w: el.clientWidth, h: el.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewportFit, viewportPreset, fitContainerEl]);

  const fitScale =
    viewportFit && effectiveViewport
      ? computeFitScale(
          fitContainerSize.w,
          fitContainerSize.h,
          effectiveViewport.width,
          effectiveViewport.height
        )
      : 1;

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
      setCrashState("none");
      setCrashDetails(null);
      crashTimestampsRef.current = [];
    }
    if (isEvicted && webviewRef.current) {
      try {
        // Save scroll position before eviction. Use the main-process CDP
        // Page.getLayoutMetrics path rather than executeJavaScript("window.scrollY"):
        // useWebviewThrottle freezes hidden webviews after 500ms, and frozen pages
        // suspend the JS task queue so executeJavaScript hangs indefinitely. CDP
        // reads layout state directly from Blink, bypassing the freeze.
        const wv = webviewRef.current;
        const currentWebviewUrl = wv.getURL();
        if (currentWebviewUrl && currentWebviewUrl !== "about:blank") {
          const captureGeneration = scrollCaptureGenerationRef.current;
          const wcId = (wv as unknown as { getWebContentsId(): number }).getWebContentsId();
          window.electron.webview
            .getScrollPosition(wcId)
            .then((scrollY: number) => {
              if (scrollCaptureGenerationRef.current !== captureGeneration) return;
              // See ref-cleanup path above: skip `0` so a CDP error can't
              // clobber a previously captured position.
              if (typeof scrollY === "number" && Number.isFinite(scrollY) && scrollY > 0) {
                setDevPreviewScrollPosition(id, { url: currentWebviewUrl, scrollY });
              }
            })
            .catch(() => {});
        }
        wv.src = "about:blank";
      } catch {
        // webview may already be detached
      }
      clearLoadTimers();
      clearRetryState();
    }
  }, [isEvicted, id, setDevPreviewScrollPosition, clearLoadTimers, clearRetryState]);

  useWebviewThrottle(id, location, isEvicted ? null : webviewElement, isWebviewReady && !isEvicted);

  // Apply device emulation when viewport preset, rotation, or DPR changes.
  // Uses enableDeviceEmulation which drives CSS media queries and window.innerWidth
  // without a page reload, preserving in-page state across preset switches.
  const prevEmulationKeyRef = useRef<string | null>(null);
  const hasAppliedEmulationRef = useRef(false);
  useEffect(() => {
    if (!isWebviewReady || !webviewElement) return;
    const emulationKey = `${viewportPreset ?? "none"}-${viewportRotated}-${viewportDpr}`;
    if (prevEmulationKeyRef.current === emulationKey) return;
    const hadPrevious = hasAppliedEmulationRef.current;

    const wc = getDevPreviewWebContents(webviewElement);
    if (!wc) return;

    try {
      if (viewportPreset) {
        if (originalUaRef.current === null) {
          originalUaRef.current = wc.getUserAgent();
        }
        wc.setUserAgent(getViewportPreset(viewportPreset).userAgent);
        wc.enableDeviceEmulation(
          buildEmulationParams(viewportPreset, viewportRotated, viewportDpr)!
        );
        prevEmulationKeyRef.current = emulationKey;
        hasAppliedEmulationRef.current = true;
      } else if (hadPrevious) {
        try {
          wc.disableDeviceEmulation();
        } catch {
          // disableDeviceEmulation may throw if emulation was never enabled
        }
        if (originalUaRef.current) {
          wc.setUserAgent(originalUaRef.current);
        }
        prevEmulationKeyRef.current = emulationKey;
        hasAppliedEmulationRef.current = false;
      }
    } catch {
      // WebContents not available (webview detached)
    }
  }, [viewportPreset, viewportRotated, viewportDpr, isWebviewReady, webviewElement]);
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
  // The guest-focused case is covered separately by onReloadShortcut below.
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

  // Listen for webview unresponsive/responsive events from the main process
  useEffect(() => {
    const cleanupUnresponsive = window.electron.webview.onUnresponsive((data) => {
      if (data.panelId !== id) return;
      setCrashState((prev) => (prev === "crashed" ? prev : "unresponsive"));
    });
    const cleanupResponsive = window.electron.webview.onResponsive((data) => {
      if (data.panelId !== id) return;
      setCrashState((prev) => (prev === "unresponsive" ? "none" : prev));
    });
    return () => {
      cleanupUnresponsive();
      cleanupResponsive();
    };
  }, [id]);

  // Clear crash state when the user navigates to a fresh URL. Depending on
  // crashState here would create an instant-reset loop: the effect would fire
  // the moment crashState transitions from "none" and clear it back. Track the
  // last URL we cleared at via a ref so this effect runs only on real URL
  // transitions.
  const lastClearedCrashUrlRef = useRef<string>(currentUrl);
  useEffect(() => {
    if (currentUrl === lastClearedCrashUrlRef.current) return;
    lastClearedCrashUrlRef.current = currentUrl;
    if (currentUrl && currentUrl !== "about:blank") {
      setCrashState("none");
      setCrashDetails(null);
      // Don't carry the prior URL's crash history into the new URL's 60s
      // window — that would mis-throttle the first auto-recovery there.
      crashTimestampsRef.current = [];
    }
  }, [currentUrl]);

  // Listen for the reload shortcut (Cmd/Ctrl+R) forwarded from the focused
  // webview guest. When the guest has focus, the outer renderer's keybinding
  // handler never fires, so the main process intercepts the key and forwards it.
  useEffect(() => {
    const cleanup = window.electron.webview.onReloadShortcut((payload) => {
      if (payload.panelId !== id) return;
      handleHardReload();
    });
    return cleanup;
  }, [id, handleHardReload]);

  // Listen for the close shortcut (Cmd/Ctrl+W) forwarded from the focused
  // webview guest (#10859). Without this, focus inside the guest bypasses the
  // host window's setIgnoreMenuShortcuts guard and the native role:"close"
  // menu accelerator closes the whole window instead of just this panel.
  useEffect(() => {
    const cleanup = window.electron.webview.onCloseShortcut((payload) => {
      if (payload.panelId !== id) return;
      void actionService.dispatch("terminal.close", { terminalId: id }, { source: "keybinding" });
    });
    return cleanup;
  }, [id]);

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
          {isRestarting || status === "starting" || status === "installing" || isProxyUrlPending ? (
            <DevPreviewLoadingState
              variant="full"
              isLoading={true}
              phaseLabel={
                isRestarting
                  ? "Restarting"
                  : status === "installing"
                    ? "Installing dependencies"
                    : (phaseLabel ?? "Starting dev server")
              }
            />
          ) : status === "error" && error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
              <AlertTriangle className="w-6 h-6 text-status-warning mb-3" />
              <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
                {error.type === "port-conflict"
                  ? "Port conflict"
                  : error.type === "missing-dependencies"
                    ? "Missing dependencies"
                    : error.type === "permission"
                      ? "Permission denied"
                      : "Dev server error"}
              </h3>
              <p className="text-xs text-daintree-text/50 text-center mb-3 max-w-md">
                {error.message}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  onClick={handleRetry}
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 px-2.5 py-1.5 group"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  <span className="text-xs">
                    {error.type === "missing-dependencies" ? "Retry install" : "Retry"}
                  </span>
                </Button>
                {error.type === "missing-dependencies" || error.type === "permission" ? (
                  <Button
                    onClick={() => setDevPreviewConsoleOpen(id, true)}
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span className="text-xs">View terminal</span>
                  </Button>
                ) : currentUrl ? (
                  <Button
                    onClick={handleOpenExternal}
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span className="text-xs">Open external</span>
                  </Button>
                ) : null}
              </div>
            </div>
          ) : !currentUrl || status !== "running" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
              {isUnconfigured ? (
                <div className="flex flex-col items-center text-center max-w-md">
                  {primaryCandidate ? (
                    <>
                      <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
                        Start the dev server
                      </h3>
                      <p className="text-xs text-daintree-text/50 mb-4 leading-relaxed">
                        We found a script in your package.json that looks like a dev server.
                      </p>
                      <div className="mb-3 px-3 py-1.5 rounded bg-overlay-subtle border border-overlay/30 inline-flex items-center gap-2">
                        <span className="text-[11px] text-daintree-text/40">Auto-detected</span>
                        <code className="text-xs text-daintree-text/70 font-mono">
                          {primaryCandidate.command}
                        </code>
                      </div>
                      <div className="flex flex-col items-center gap-2">
                        <Button
                          onClick={() => void handleAutoDetect(primaryCandidate.command)}
                          disabled={isAutoDetecting || isSettingsLoading}
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 px-2.5 py-1.5 group text-accent-primary"
                        >
                          <Play className="h-3.5 w-3.5" />
                          <span className="text-xs">
                            {isAutoDetecting
                              ? "Detecting..."
                              : `Run \`${primaryCandidate.command}\``}
                          </span>
                        </Button>
                        {autoDetectFailedCommand !== null && (
                          <InlineStatusBanner
                            icon={XCircle}
                            severity="error"
                            title="Couldn't start preview"
                            description="The detected command couldn't be saved to project settings."
                            className="w-full rounded text-left"
                            action={{
                              id: "dev-preview-auto-detect-retry",
                              label: "Retry",
                              icon: RotateCw,
                              variant: "dangerFilled",
                              onClick: () =>
                                void handleAutoDetect(
                                  autoDetectFailedCommand || primaryCandidate.command
                                ),
                            }}
                          />
                        )}
                        {candidates.length > 1 && (
                          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                            <PopoverTrigger asChild>
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 text-xs text-daintree-text/50 hover:text-daintree-text/70 transition-colors"
                              >
                                Use a different script...
                                <ChevronDown className="h-3 w-3" />
                              </button>
                            </PopoverTrigger>
                            <PopoverContent align="center" sideOffset={4} className="w-72 p-1">
                              <div className="flex flex-col max-h-64 overflow-y-auto">
                                {candidates.map((c) => (
                                  <button
                                    key={c.id}
                                    type="button"
                                    onClick={() => {
                                      handlePickCandidate(c);
                                      setPickerOpen(false);
                                    }}
                                    className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-overlay-subtle transition-colors text-left"
                                  >
                                    <code className="text-daintree-text/70 font-mono text-[11px] flex-1 truncate">
                                      {c.command}
                                    </code>
                                    <span className="text-daintree-text/40 shrink-0">{c.name}</span>
                                  </button>
                                ))}
                              </div>
                            </PopoverContent>
                          </Popover>
                        )}
                        <Button
                          onClick={handleOpenSettings}
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70"
                        >
                          <Settings className="h-3.5 w-3.5" />
                          <span className="text-xs">Open project settings</span>
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
                        Set a dev command
                      </h3>
                      <p className="text-xs text-daintree-text/50 mb-4 leading-relaxed">
                        Configure a command to start a local development server.
                      </p>
                      <div className="flex flex-col items-center gap-2 w-full max-w-xs">
                        <input
                          type="text"
                          value={commandInput}
                          onChange={(e) => setCommandInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              void handleSaveCommand();
                            }
                          }}
                          placeholder="npm run dev"
                          className="w-full px-2.5 py-1.5 text-xs font-mono bg-overlay-subtle border border-overlay/30 rounded text-daintree-text/70 placeholder:text-text-placeholder focus:outline-hidden focus:border-overlay/50 transition-[border-color,box-shadow]"
                        />
                        <Button
                          onClick={() => void handleSaveCommand()}
                          disabled={!commandInput.trim() || commandInputError !== null}
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 px-2.5 py-1.5 group text-accent-primary"
                        >
                          <Play className="h-3.5 w-3.5" />
                          <span className="text-xs">Run</span>
                        </Button>
                        {commandInput.trim() && commandInputError && (
                          <p className="text-[11px] text-status-warning">{commandInputError}</p>
                        )}
                      </div>
                      <Button
                        onClick={handleOpenSettings}
                        variant="ghost"
                        size="sm"
                        className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70 mt-3"
                      >
                        <Settings className="h-3.5 w-3.5" />
                        <span className="text-xs">Open project settings</span>
                      </Button>
                    </>
                  )}
                </div>
              ) : status === "restored-stopped" ? (
                <div className="flex flex-col items-center text-center max-w-md">
                  <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
                    Dev server was running
                  </h3>
                  <p className="text-xs text-daintree-text/50 mb-3 leading-relaxed">
                    Daintree closed while this dev server was active. It wasn't reattached — restart
                    to run it again.
                  </p>
                  {devCommand && (
                    <div className="mb-3 px-3 py-1.5 rounded bg-overlay-subtle border border-overlay/30 inline-flex items-center gap-2">
                      <code className="text-xs text-daintree-text/70 font-mono">{devCommand}</code>
                    </div>
                  )}
                  <Button
                    onClick={handleStartFromRestored}
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 px-2.5 py-1.5 group text-accent-primary"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    <span className="text-xs">Restart dev server</span>
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col items-center text-center max-w-md">
                  <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
                    Waiting for dev server
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
              <p className="text-xs text-daintree-text/50">
                Preview paused to save memory — will reload when opened
              </p>
            </div>
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
                <>
                  {reconnectAttempt > 0 && !webviewLoadError && (
                    <div className="absolute bottom-0 left-0 right-0 z-20 flex items-center justify-center gap-2 px-3 py-1.5 text-xs bg-status-info/10 border-t border-status-info/20 text-daintree-text/70">
                      <Spinner size="xs" />
                      <span>Reconnecting (attempt {reconnectAttempt} of 5)...</span>
                    </div>
                  )}
                  {webviewLoadError && (
                    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
                      <AlertTriangle className="w-6 h-6 text-status-warning mb-3" />
                      <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
                        {webviewLoadErrorHeading(webviewLoadError.code)}
                      </h3>
                      <p className="text-xs text-daintree-text/50 text-center mb-3 max-w-md">
                        {webviewLoadError.message}
                      </p>
                      <div className="flex items-center gap-1">
                        {webviewLoadError.code === "cert" && (
                          <Button
                            onClick={handleCopyMkcert}
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70"
                          >
                            {certCopied ? (
                              <Check className="h-3.5 w-3.5" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                            <span className="text-xs">
                              {certCopied ? "Copied" : "Copy `mkcert -install`"}
                            </span>
                          </Button>
                        )}
                        {webviewLoadError.code === "connection_refused" ||
                        webviewLoadError.code === "proxy_error" ? (
                          <>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  onClick={handleRestartDevServer}
                                  variant="ghost"
                                  size="sm"
                                  disabled={isRestarting}
                                  className="gap-1.5 px-2.5 py-1.5 rounded-r-none group"
                                >
                                  <RotateCw
                                    className={cn("h-3.5 w-3.5", isRestarting && "animate-spin")}
                                  />
                                  <span className="text-xs">Restart dev server</span>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom">Restart dev server</TooltipContent>
                            </Tooltip>
                            <DropdownMenu>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      disabled={isRestarting}
                                      className="px-1.5 rounded-l-none group"
                                      aria-label="More restart options"
                                    >
                                      <ChevronDown className="h-3.5 w-3.5" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                </TooltipTrigger>
                                <TooltipContent side="bottom">More restart options</TooltipContent>
                              </Tooltip>
                              <DropdownMenuContent
                                align="end"
                                sideOffset={4}
                                className="min-w-[14rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
                              >
                                <DropdownMenuItem onSelect={handleHardReload}>
                                  Reload preview
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={handleRestartDevServer}>
                                  Restart dev server
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={handleRequestRestartAndClearCache}>
                                  Restart and clear cache
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={handleRequestReinstallAndRestart}>
                                  Reinstall dependencies
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </>
                        ) : (
                          <Button
                            onClick={handleRetryWebviewLoad}
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 px-2.5 py-1.5 group"
                          >
                            <RotateCw className="h-3.5 w-3.5" />
                            <span className="text-xs">Retry</span>
                          </Button>
                        )}
                        {currentUrl && (
                          <Button
                            onClick={handleOpenExternal}
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            <span className="text-xs">Open external</span>
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                  <BlockedNavBanner
                    state={blockedNav}
                    panelId={id}
                    webviewElement={webviewElement}
                    onDispatch={dispatchBlockedNav}
                  />
                  {crashState === "crashed" && (
                    <InlineStatusBanner
                      icon={XCircle}
                      title="Preview process crashed"
                      description={
                        crashDetails
                          ? `Reason: ${crashDetails.reason} (exit code ${crashDetails.exitCode})`
                          : "The renderer process terminated unexpectedly."
                      }
                      severity="error"
                      animated={false}
                      action={{
                        id: "reload",
                        label: "Reload",
                        icon: RotateCw,
                        variant: "dangerFilled",
                        onClick: handleHardReload,
                        ariaLabel: "Reload preview page",
                      }}
                      trailingSlot={
                        <BannerOverflowMenu
                          ariaLabel="More preview recovery options"
                          actions={[
                            {
                              id: "hard-restart",
                              label: "Hard restart",
                              icon: RotateCw,
                              variant: "danger",
                              onClick: handleRestartDevServer,
                              ariaLabel: "Hard restart preview",
                            },
                          ]}
                        />
                      }
                      onClose={() => {
                        setCrashState("none");
                        setCrashDetails(null);
                        crashTimestampsRef.current = [];
                      }}
                    />
                  )}
                  {crashState === "unresponsive" && (
                    <InlineStatusBanner
                      icon={AlertTriangle}
                      title="Preview is not responding"
                      description="The page may be stuck in a long-running operation."
                      severity="warning"
                      animated={false}
                      actions={[
                        {
                          id: "hard-restart",
                          label: "Hard restart",
                          icon: RotateCw,
                          variant: "danger",
                          onClick: handleRestartDevServer,
                          ariaLabel: "Hard restart preview",
                        },
                      ]}
                      onClose={() => setCrashState("none")}
                    />
                  )}
                  {isLoading && (
                    <DevPreviewLoadingState
                      variant="overlay"
                      isLoading={isLoading}
                      phaseLabel="Loading preview"
                      onCancel={handleCancelLoad}
                    />
                  )}
                  {showRecoverySpinner && !webviewLoadError && (
                    <DevPreviewLoadingState
                      variant="overlay"
                      isLoading={isRecoveringFromEviction}
                      phaseLabel="Rehydrating preview"
                    />
                  )}
                  {isDragging && <div className="absolute inset-0 z-10 bg-transparent" />}
                  {findInPage.isOpen && <FindBar find={findInPage} />}
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
                  <WebviewDialog dialog={currentDialog} onRespond={handleDialogRespond} />
                </>
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
