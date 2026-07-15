import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useWebviewThrottle } from "@/hooks/useWebviewThrottle";
import { useHasBeenVisible } from "@/hooks/useHasBeenVisible";
import { useWebviewEviction } from "@/hooks/useWebviewEviction";
import { useWebviewDialog } from "@/hooks/useWebviewDialog";
import { useWebviewEvents } from "@/hooks/useWebviewEvents";
import { useBrowserActionListeners } from "@/hooks/useBrowserActionListeners";
import { AlertTriangle, ExternalLink, RotateCw, Square, XCircle } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/button";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { usePanelStore } from "@/store";
import type { BrowserHistory, BrowserNavigationHistorySnapshot } from "@shared/types/browser";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { BrowserToolbar } from "./BrowserToolbar";
import {
  normalizeBrowserUrl,
  extractHostPort,
  extractHostname,
  isValidBrowserUrl,
  clampZoom,
  type LoadError,
} from "./browserUtils";
import {
  goBackBrowserHistory,
  goForwardBrowserHistory,
  initializeBrowserHistory,
  pushBrowserHistory,
} from "./historyUtils";
import { actionService } from "@/services/ActionService";
import { WebviewDialog } from "./WebviewDialog";
import { FindBar } from "./FindBar";
import { useIsDragging } from "@/components/DragDrop";
import { cn } from "@/lib/utils";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useProjectStore } from "@/store";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useProjectSettings } from "@/hooks/useProjectSettings";
import { useFindInPage } from "@/hooks/useFindInPage";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { logError } from "@/utils/logger";
import { buildBrowserPartition } from "@shared/utils/partitionUtils";
import { notify } from "@/lib/notify";

export interface BrowserPaneProps extends BasePanelProps {
  initialUrl: string;
  initialHistory?: BrowserHistory;
  initialZoom?: number;
  // Tab support
  tabs?: import("@/components/Panel/TabButton").TabInfo[];
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
}

// ERR_ABORTED (-3) fires when a pending load is superseded by a new navigation —
// benign. Any other rejection is unexpected and worth a log; did-fail-load
// surfaces user-visible failures, so this only catches non-event paths.
function loadWebviewUrl(webview: Electron.WebviewTag, url: string): void {
  const result = (webview.loadURL as (url: string) => unknown)(url);
  if (
    result &&
    typeof result === "object" &&
    "catch" in result &&
    typeof result.catch === "function"
  ) {
    (result as { catch: (fn: (err: unknown) => void) => void }).catch((err: unknown) => {
      if (
        err &&
        typeof err === "object" &&
        "errorCode" in err &&
        (err as { errorCode: unknown }).errorCode === -3
      ) {
        return;
      }
      logError(
        "[BrowserPane] Unexpected loadURL rejection",
        err instanceof Error ? err : new Error(String(err))
      );
    });
  }
}

export function BrowserPane({
  id,
  title,
  initialUrl,
  initialHistory,
  initialZoom,
  isFocused,
  isMaximized = false,
  location = "grid",
  onFocus,
  onClose,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  showRestoreControl,
  isMultiPanelGrid,
  tabs,
  onTabClick,
  onTabClose,
  onTabRename,
  onAddTab,
}: BrowserPaneProps) {
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const [webviewElement, setWebviewElement] = useState<Electron.WebviewTag | null>(null);
  const setWebviewNode = useCallback((node: Electron.WebviewTag | null) => {
    webviewRef.current = node;
    setWebviewElement(node);
  }, []);
  const setBrowserUrl = usePanelStore((state) => state.setBrowserUrl);
  const setBrowserHistory = usePanelStore((state) => state.setBrowserHistory);
  const setBrowserZoom = usePanelStore((state) => state.setBrowserZoom);
  const isDragging = useIsDragging();
  const storeProjectId = useProjectStore((state) => state.currentProject?.id);
  // Per-project Chromium session partition so cookies/localStorage/IndexedDB are
  // isolated between projects sharing an origin (e.g. localhost:3000) (#9965).
  // `currentProject` resolves asynchronously, but Electron ignores `partition`
  // changes once the <webview> is attached — so fall back to the project id seeded
  // synchronously by preload (mirrors projectStore.getLocationProjectId) to attach
  // with the correct partition on first render rather than persist:browser-default.
  const projectId = storeProjectId ?? window.__DAINTREE_INITIAL_PROJECT__?.id;
  const webviewPartition = useMemo(() => buildBrowserPartition(projectId), [projectId]);
  const devServerLoadTimeout = useProjectSettingsStore(
    (state) => state.settings?.devServerLoadTimeout
  );
  const loadTimeoutMs = Math.min(Math.max(devServerLoadTimeout ?? 30, 1), 120) * 1000;
  const { settings: projectSettings, saveSettings: saveProjectSettings } = useProjectSettings();
  const allowedHosts = useMemo(
    () => projectSettings?.browserAllowedHosts ?? [],
    [projectSettings?.browserAllowedHosts]
  );

  // Seed history from the `initialHistory` prop (threaded by buildPanelProps from
  // the persisted terminal state). Reading the store via getState() inside a lazy
  // useState initializer was a React Compiler bailout (Globals); prop threading
  // moves the read to the parent and keeps the leaf component compiler-friendly.
  // Use extended mode (empty allowedHosts) so private/LAN URLs in session state
  // are recognized as valid-syntax and return a normalized string; restored URLs
  // bypass the approval prompt since being in history implies prior approval.
  const [history, setHistory] = useState<BrowserHistory>(() => {
    const normalized = normalizeBrowserUrl(initialUrl, { allowedHosts: [] });
    const fallbackPresent = normalized.url || initialUrl;
    return initializeBrowserHistory(initialHistory ?? null, fallbackPresent);
  });

  const [navSnapshot, setNavSnapshot] = useState<BrowserNavigationHistorySnapshot | null>(null);

  // Track whether the current load is the initial session-restored load (not a fresh panel)
  const isInitialRestoredLoadRef = useRef(Boolean(initialHistory?.present));

  // Initialize zoom factor from the `initialZoom` prop (already clamped at the
  // prop-build site). Default 1.0 (100%) when the prop is absent.
  const [zoomFactor, setZoomFactor] = useState<number>(() => clampZoom(initialZoom ?? 1.0));

  const [isLoading, setIsLoading] = useState(true);
  // Doherty 400ms gate: skip loading affordances on fast loads to prevent flicker.
  const showLoadingOverlay = useDohertyGate(isLoading);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  // Webview crash / unresponsive state. `crashed` covers render-process-gone
  // with a recoverable reason (not memory-eviction or clean-exit); `unresponsive`
  // is driven by the main-process unresponsive/responsive WebContents events,
  // which auto-clear without user action. Mutually exclusive states mirror
  // DevPreview's pattern. crashTimestampsRef bounds the auto-reload silently to
  // the first crash within a 60s window; a second crash within the window
  // surfaces the banner to break the loop.
  const [crashState, setCrashState] = useState<"none" | "crashed" | "unresponsive">("none");
  const [crashDetails, setCrashDetails] = useState<{
    reason: string;
    exitCode: number;
  } | null>(null);
  const crashTimestampsRef = useRef<number[]>([]);
  const crashReloadRef = useRef<() => void>(() => {});
  // `phase` keeps the notice alive across an external-open attempt: dispatch()
  // resolves an ActionDispatchResult and never rejects, so the old handler
  // cleared this — the user's only recovery surface — even when the open had
  // failed (#11114). `noticeId` identifies which notice an in-flight result
  // belongs to, so a result for a superseded block can't clobber the current one.
  const [blockedNav, setBlockedNav] = useState<{
    noticeId: number;
    url: string;
    canOpenExternal: boolean;
    phase: "blocked" | "opening" | "error";
    errorMessage: string | null;
  } | null>(null);
  const blockedNavIdRef = useRef(0);
  const [pendingApproval, setPendingApproval] = useState<{
    url: string;
    hostname: string;
    historyIndex?: number;
  } | null>(null);
  const blockedNavTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Track the last URL we set on the webview to detect in-webview navigation
  const lastSetUrlRef = useRef<string>(history.present);
  // Seed value for the webview `src` attribute, captured once at mount. We never
  // re-bind `src` to navigation-driven state: Electron's SrcAttribute observer
  // treats any same-or-different value write as a fresh loadURL, turning guest
  // navigations into redundant full reloads (#9940). All post-mount navigation
  // goes through imperative loadURL calls instead.
  const initialUrlRef = useRef<string>(history.present);
  // When `webviewPartition` changes the `key` remounts the <webview> as a fresh
  // element, so its seed `src` must be the URL the user is currently on — not the
  // URL captured at first component mount (#9940). Re-seed during render, before
  // the JSX `src={initialUrlRef.current}` is read for the remounting element.
  const lastPartitionRef = useRef<string>(webviewPartition);
  if (lastPartitionRef.current !== webviewPartition) {
    lastPartitionRef.current = webviewPartition;
    initialUrlRef.current = history.present;
  }
  // Track if webview has been mounted and is ready
  const [isWebviewReady, setIsWebviewReady] = useState(false);

  const refreshNavigationHistory = useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview || !isWebviewReady) return;
    try {
      const wcId = (webview as unknown as { getWebContentsId(): number }).getWebContentsId();
      const snapshot = await window.electron.webview.getNavigationHistory(wcId);
      setNavSnapshot(snapshot);
    } catch {
      // Webview may have been destroyed between the guard and the IPC call
    }
  }, [isWebviewReady]);

  const loadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isSlowLoad, setIsSlowLoad] = useState(false);
  const slowLoadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const screenshotInFlightRef = useRef(false);

  const hasBeenVisible = useHasBeenVisible(id, location);

  const currentUrl = history.present;
  const canGoBack = Boolean(navSnapshot?.canGoBack) || history.past.length > 0;
  const canGoForward = Boolean(navSnapshot?.canGoForward) || history.future.length > 0;
  const backEntry = navSnapshot
    ? (navSnapshot.entries
        .filter((e) => e.index < navSnapshot.activeIndex)
        .sort((a, b) => b.index - a.index)[0] ?? null)
    : null;
  const forwardEntry = navSnapshot
    ? (navSnapshot.entries
        .filter((e) => e.index > navSnapshot.activeIndex)
        .sort((a, b) => a.index - b.index)[0] ?? null)
    : null;
  const hasValidUrl = isValidBrowserUrl(currentUrl);

  const { isEvicted, evictingRef } = useWebviewEviction(id, location);

  // Sync URL changes to store (only if valid)
  useEffect(() => {
    if (hasValidUrl) {
      setBrowserUrl(id, currentUrl);
    }
  }, [id, currentUrl, hasValidUrl, setBrowserUrl]);

  // Persist history changes to terminal store (with validation)
  useEffect(() => {
    if (Array.isArray(history.past) && Array.isArray(history.future)) {
      setBrowserHistory(id, history);
    }
  }, [id, history, setBrowserHistory]);

  // Apply zoom level when it changes or webview becomes ready
  useEffect(() => {
    const webview = webviewRef.current;
    if (webview && isWebviewReady) {
      webview.setZoomFactor(zoomFactor);
    }
  }, [zoomFactor, isWebviewReady]);

  // Persist zoom factor changes
  useEffect(() => {
    setBrowserZoom(id, zoomFactor);
  }, [id, zoomFactor, setBrowserZoom]);

  // Listen for blocked navigation events from main process (debounced 150ms for redirect chains)
  useEffect(() => {
    const cleanup = window.electron.webview.onNavigationBlocked((data) => {
      if (data.panelId !== id) return;
      if (blockedNavTimerRef.current) {
        clearTimeout(blockedNavTimerRef.current);
      }
      blockedNavTimerRef.current = setTimeout(() => {
        setBlockedNav({
          noticeId: ++blockedNavIdRef.current,
          url: data.url,
          canOpenExternal: data.canOpenExternal,
          phase: "blocked",
          errorMessage: null,
        });
        blockedNavTimerRef.current = null;
      }, 150);
    });
    return () => {
      cleanup();
      if (blockedNavTimerRef.current) {
        clearTimeout(blockedNavTimerRef.current);
        blockedNavTimerRef.current = null;
      }
    };
  }, [id]);

  // Auto-dismiss blocked navigation notification after 10 seconds. Only the
  // untouched notice expires: once the user asks to open externally, the notice
  // is carrying an in-flight attempt or a failure they still have to act on, and
  // timing it out would silently destroy that recovery surface (#11114).
  useEffect(() => {
    if (blockedNav?.phase !== "blocked") return;
    const noticeId = blockedNav.noticeId;
    const timer = setTimeout(() => {
      // An already-queued timer callback can still run after the user clicks
      // (clearTimeout in the cleanup can't cancel a callback the event loop has
      // picked up). Clearing unconditionally here would null the notice that is
      // mid-attempt, and the failure would then find no notice to attach to.
      setBlockedNav((prev) =>
        prev?.noticeId === noticeId && prev.phase === "blocked" ? null : prev
      );
    }, 10_000);
    return () => clearTimeout(timer);
  }, [blockedNav]);

  // The notice is passed in rather than read off `blockedNav` after the await:
  // by then the pane may be showing a different block, and the dispatch must
  // still target the URL the user actually clicked.
  const handleOpenBlockedExternal = useCallback(
    async (noticeId: number, url: string) => {
      // Keep any existing errorMessage so a retry leaves the error banner
      // mounted (with a spinner) instead of flashing back to the warning row.
      setBlockedNav((prev) =>
        prev && prev.noticeId === noticeId ? { ...prev, phase: "opening" } : prev
      );

      const result = await actionService.dispatch(
        "browser.openExternal",
        { terminalId: id, url },
        { source: "user" }
      );
      if (!result.ok) {
        logError("[BrowserPane] openExternal failed", result.error);
      }

      setBlockedNav((prev) => {
        // A newer block, a dismissal, or a navigation replaced the notice while
        // we were awaiting — it owns the banner now, so leave it untouched.
        if (!prev || prev.noticeId !== noticeId) return prev;
        if (result.ok) return null;
        return { ...prev, phase: "error", errorMessage: result.error.message };
      });
    },
    [id]
  );

  const handleRenderProcessGone = useCallback(
    (details: { reason: string; exitCode: number }) => {
      const now = Date.now();
      const timestamps = crashTimestampsRef.current.filter((ts) => now - ts < 60_000);
      timestamps.push(now);
      crashTimestampsRef.current = timestamps;

      // Clear any stale load-error overlay (z-30, absolute inset-0) — without
      // this it would occlude the crash banner, which is an in-flow element.
      setLoadError(null);
      setCrashDetails(details);
      setCrashState("crashed");

      // Auto-reload silently on the first crash within the 60s window so a
      // one-off renderer fault recovers transparently. A second crash within
      // the window leaves the banner up so the user can act.
      if (timestamps.length < 2) {
        crashReloadRef.current();
      } else {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Page crashed repeatedly",
          message: `The browser page crashed (${details.reason}) twice within 60 seconds. Auto-recovery stopped. Use Reload to recover.`,
          priority: "high",
          duration: 0,
          context: { eventKind: "recovery", panelId: id },
          supersedeKey: `browser-pane-crash-loop:${id}`,
          correlationId: id,
        });
      }
    },
    [id]
  );

  useWebviewEvents({
    webviewElement,
    isInitialRestoredLoadRef,
    lastSetUrlRef,
    slowLoadTimeoutRef,
    loadTimeoutRef,
    evictingRef,
    projectId,
    loadTimeoutMs,
    zoomFactor,
    setIsWebviewReady,
    setIsLoading,
    setLoadError,
    setIsSlowLoad,
    setBlockedNav,
    setHistory,
    onRenderProcessGone: handleRenderProcessGone,
  });

  const commitNavigation = useCallback(
    (url: string) => {
      isInitialRestoredLoadRef.current = false;
      setBlockedNav(null);
      setPendingApproval(null);
      setHistory((prev) => pushBrowserHistory(prev, url));
      setIsLoading(true);
      setLoadError(null);
      lastSetUrlRef.current = url;

      const webview = webviewRef.current;
      if (webview && isWebviewReady) {
        loadWebviewUrl(webview, url);
      }
    },
    [isWebviewReady]
  );

  const handleNavigate = useCallback(
    (url: string) => {
      const result = normalizeBrowserUrl(url, { allowedHosts });
      if (result.error || !result.url) return;

      if (result.requiresConfirmation && result.hostname) {
        setPendingApproval({ url: result.url, hostname: result.hostname });
        return;
      }

      commitNavigation(result.url);
    },
    [allowedHosts, commitNavigation]
  );

  const handleApproveHost = useCallback(async () => {
    if (!pendingApproval) return;
    // Guard against save silently no-oping when projectId is transiently null
    // (startup, project switch) — without this, the banner would clear and the
    // webview would load without the hostname ever being persisted.
    if (!projectId) {
      console.warn("[BrowserPane] Cannot approve host without an active project");
      return;
    }
    const { url, hostname } = pendingApproval;
    const baseSettings = projectSettings ?? { runCommands: [] };
    const nextAllowed = Array.from(
      new Set([...(baseSettings.browserAllowedHosts ?? []), hostname])
    );
    try {
      await saveProjectSettings({ ...baseSettings, browserAllowedHosts: nextAllowed });
    } catch (err) {
      logError("[BrowserPane] Failed to save approved host", err);
      return;
    }
    if (pendingApproval.historyIndex !== undefined) {
      const webview = webviewRef.current;
      if (webview && isWebviewReady) {
        try {
          const wcId = (webview as unknown as { getWebContentsId(): number }).getWebContentsId();
          await window.electron.webview.goToHistoryIndex(wcId, pendingApproval.historyIndex);
          setPendingApproval(null);
          void refreshNavigationHistory();
          return;
        } catch {
          // Fall through to loadURL if goToHistoryIndex fails
        }
      }
    }
    commitNavigation(url);
  }, [
    pendingApproval,
    projectId,
    projectSettings,
    saveProjectSettings,
    commitNavigation,
    isWebviewReady,
    refreshNavigationHistory,
  ]);

  const handleDismissApproval = useCallback(() => {
    setPendingApproval(null);
  }, []);

  const handleBack = useCallback(() => {
    const webview = webviewRef.current;
    // Only mutate state once we know navigation will actually fire — otherwise no
    // load event ever clears isLoading (stuck spinner) and a no-op Back would
    // wrongly flip the initial-restored-load heuristic / dismiss banners.
    if (!webview || !isWebviewReady) return;

    if (webview.canGoBack()) {
      isInitialRestoredLoadRef.current = false;
      setBlockedNav(null);
      setIsLoading(true);
      setLoadError(null);
      webview.goBack();
      return;
    }

    if (history.past.length > 0) {
      const nextHistory = goBackBrowserHistory(history);
      isInitialRestoredLoadRef.current = false;
      setBlockedNav(null);
      setIsLoading(true);
      setLoadError(null);
      setHistory(nextHistory);
      lastSetUrlRef.current = nextHistory.present;
      loadWebviewUrl(webview, nextHistory.present);
    }
  }, [history, isWebviewReady]);

  const handleForward = useCallback(() => {
    const webview = webviewRef.current;
    // Only mutate state once we know navigation will actually fire — otherwise no
    // load event ever clears isLoading (stuck spinner) and a no-op Forward would
    // wrongly flip the initial-restored-load heuristic / dismiss banners.
    if (!webview || !isWebviewReady) return;

    if (webview.canGoForward()) {
      isInitialRestoredLoadRef.current = false;
      setBlockedNav(null);
      setIsLoading(true);
      setLoadError(null);
      webview.goForward();
      return;
    }

    if (history.future.length > 0) {
      const nextHistory = goForwardBrowserHistory(history);
      isInitialRestoredLoadRef.current = false;
      setBlockedNav(null);
      setIsLoading(true);
      setLoadError(null);
      setHistory(nextHistory);
      lastSetUrlRef.current = nextHistory.present;
      loadWebviewUrl(webview, nextHistory.present);
    }
  }, [history, isWebviewReady]);

  const handleReload = useCallback(() => {
    setBlockedNav(null);
    setIsLoading(true);
    setLoadError(null);
    setIsSlowLoad(false);
    setCrashState("none");
    setCrashDetails(null);
    crashTimestampsRef.current = [];
    webviewRef.current?.reload();
  }, []);

  // Auto-reload uses a raw webview.reload() — explicitly NOT going through
  // handleReload, which clears crashTimestampsRef and would break the second-
  // crash loop detector. Only user-initiated reload/dismiss should reset the
  // crash window.
  useEffect(() => {
    crashReloadRef.current = () => {
      setIsLoading(true);
      setLoadError(null);
      setIsSlowLoad(false);
      webviewRef.current?.reload();
    };
  }, []);

  // Listen for webview unresponsive/responsive events from the main process.
  // Unresponsive is auto-clearing — the responsive event from Chromium dismisses
  // the banner without user action, so this is Tier 1/3 ambient (no recovery
  // button needed beyond the optional Reload). `crashed` outranks `unresponsive`:
  // if the renderer has died, ignore a stale responsive event.
  useEffect(() => {
    const cleanupUnresponsive = window.electron.webview.onUnresponsive((data) => {
      if (data.panelId !== id) return;
      setCrashState((prev) => {
        if (prev === "crashed") return prev;
        // Clear any in-flight load error — the page is unresponsive, the
        // error is no longer actionable, and its absolute z-30 overlay
        // would occlude this banner.
        setLoadError(null);
        return "unresponsive";
      });
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

  // Clear crash state on memory eviction so a restored panel doesn't surface
  // a stale banner. The eviction placeholder owns the visual signal in that
  // window — see useWebviewEviction.
  useEffect(() => {
    if (isEvicted) {
      setCrashState("none");
      setCrashDetails(null);
      crashTimestampsRef.current = [];
    }
  }, [isEvicted]);

  const handleCancelLoad = useCallback(() => {
    if (slowLoadTimeoutRef.current) {
      clearTimeout(slowLoadTimeoutRef.current);
      slowLoadTimeoutRef.current = null;
    }
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
    setIsSlowLoad(false);
    setIsLoading(false);
    const webview = webviewRef.current;
    if (webview) {
      try {
        webview.stop();
      } catch {
        // Webview detached
      }
    }
    setLoadError({ kind: "cancelled", message: "Load cancelled" });
  }, []);

  const handleRetryFromError = useCallback(() => {
    setLoadError(null);
    setIsSlowLoad(false);
    setIsLoading(true);
    if (currentUrl) {
      // Swallow ERR_ABORTED-class rejections — see commitNavigation comment.
      const webview = webviewRef.current;
      if (webview) {
        loadWebviewUrl(webview, currentUrl);
      }
    } else {
      webviewRef.current?.reload();
    }
  }, [currentUrl]);

  const handleHardReload = useCallback(() => {
    setBlockedNav(null);
    setIsLoading(true);
    setLoadError(null);
    const webview = webviewRef.current;
    if (!webview || !isWebviewReady) return;
    try {
      const wcId = (webview as unknown as { getWebContentsId(): number }).getWebContentsId();
      safeFireAndForget(window.electron.webview.reloadIgnoringCache(wcId, id), {
        context: "Reloading browser webview ignoring cache",
      });
    } catch {
      webview.reload();
    }
  }, [isWebviewReady, id]);

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
    } catch {
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

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (blockedNavTimerRef.current) {
        clearTimeout(blockedNavTimerRef.current);
      }
      if (slowLoadTimeoutRef.current) {
        clearTimeout(slowLoadTimeoutRef.current);
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
    };
  }, []);

  // XButton1/XButton2 back/forward on Windows/Linux. The <webview> does not
  // propagate app-command, so mouseup on the parent document catches clicks
  // on toolbar chrome. macOS maps side buttons differently and stays on the
  // existing Cmd+Left / Cmd+Right keychord.
  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      if (!isFocused) return;
      if (e.button === 3) {
        e.preventDefault();
        handleBack();
      } else if (e.button === 4) {
        e.preventDefault();
        handleForward();
      }
    };
    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, [isFocused, handleBack, handleForward]);

  const handleSetZoom = useCallback((rawZoom: number) => {
    setZoomFactor(clampZoom(rawZoom));
  }, []);

  const handleGoToHistoryIndex = useCallback(
    async (index: number) => {
      // Entries are filtered upstream but keep their original Chromium stack
      // position in `.index`, so the array is sparse — match on the field, not
      // the array position.
      const entry = navSnapshot?.entries.find((e) => e.index === index);
      if (!entry) return;

      const result = normalizeBrowserUrl(entry.url, { allowedHosts });
      if (result.error || !result.url) return;

      if (result.requiresConfirmation && result.hostname) {
        setPendingApproval({ url: result.url, hostname: result.hostname, historyIndex: index });
        return;
      }

      const webview = webviewRef.current;
      if (!webview || !isWebviewReady) return;
      try {
        const wcId = (webview as unknown as { getWebContentsId(): number }).getWebContentsId();
        await window.electron.webview.goToHistoryIndex(wcId, index);
        void refreshNavigationHistory();
      } catch {
        // Index may be stale — refresh and let the user retry
        void refreshNavigationHistory();
      }
    },
    [navSnapshot, allowedHosts, isWebviewReady, refreshNavigationHistory]
  );

  // Refresh navigation history snapshot after webview finishes loading
  useEffect(() => {
    if (isWebviewReady && !isLoading) {
      void refreshNavigationHistory();
    }
  }, [isWebviewReady, isLoading, refreshNavigationHistory]);

  useBrowserActionListeners(id, {
    onReload: handleReload,
    onNavigate: handleNavigate,
    onBack: handleBack,
    onForward: handleForward,
    onSetZoom: handleSetZoom,
    onCaptureScreenshot: handleCaptureScreenshot,
    onToggleDevTools: handleToggleDevTools,
    onHardReload: handleHardReload,
  });

  // Blank the webview before React unmounts it for faster memory reclamation
  useEffect(() => {
    if (isEvicted && webviewRef.current) {
      try {
        webviewRef.current.src = "about:blank";
      } catch {
        // webview may already be detached
      }
    }
  }, [isEvicted]);

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

  const handleOpenExternal = useCallback(() => {
    if (!hasValidUrl) return;
    void actionService.dispatch("browser.openExternal", { terminalId: id }, { source: "user" });
  }, [hasValidUrl, id]);

  const displayTitle = useMemo(() => {
    if (title && title !== "Browser") return title;
    return extractHostPort(currentUrl);
  }, [title, currentUrl]);

  const browserToolbar = (
    <BrowserToolbar
      terminalId={id}
      projectId={projectId}
      url={currentUrl}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      backEntry={backEntry}
      forwardEntry={forwardEntry}
      navSnapshot={navSnapshot}
      isLoading={showLoadingOverlay}
      zoomFactor={zoomFactor}
      isWebviewReady={isWebviewReady}
      validateUrl={(url) => normalizeBrowserUrl(url, { allowedHosts })}
      onNavigate={(url) =>
        void actionService.dispatch("browser.navigate", { terminalId: id, url }, { source: "user" })
      }
      onBack={() =>
        void actionService.dispatch("browser.back", { terminalId: id }, { source: "user" })
      }
      onForward={() =>
        void actionService.dispatch("browser.forward", { terminalId: id }, { source: "user" })
      }
      onGoToHistoryIndex={handleGoToHistoryIndex}
      onReload={() =>
        void actionService.dispatch("browser.reload", { terminalId: id }, { source: "user" })
      }
      onHardReload={() =>
        void actionService.dispatch("browser.hardReload", { terminalId: id }, { source: "user" })
      }
      onOpenExternal={handleOpenExternal}
      onZoomChange={(factor) =>
        void actionService.dispatch(
          "browser.setZoomLevel",
          { terminalId: id, zoomFactor: factor },
          { source: "user" }
        )
      }
      onCaptureScreenshot={handleCaptureScreenshot}
      onToggleDevTools={() =>
        void actionService.dispatch(
          "browser.toggleDevTools",
          { terminalId: id },
          { source: "user" }
        )
      }
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
      isMultiPanelGrid={isMultiPanelGrid}
      onFocus={onFocus}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleChange={onTitleChange}
      onMinimize={onMinimize}
      onRestore={onRestore}
      showRestoreControl={showRestoreControl}
      toolbar={browserToolbar}
      tabs={tabs}
      onTabClick={onTabClick}
      onTabClose={onTabClose}
      onTabRename={onTabRename}
      onAddTab={onAddTab}
    >
      <div className="relative flex-1 min-h-0 flex flex-col bg-surface-canvas">
        {pendingApproval && (
          <div
            aria-live="assertive"
            aria-atomic="true"
            className="absolute top-0 left-0 right-0 z-20 flex items-center gap-2 px-3 py-1.5 text-xs bg-status-info/10 border-b border-status-info/30 text-daintree-text/90"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-status-info" />
            <span className="truncate flex-1">
              Allow browser panel to load{" "}
              <span className="font-mono">{pendingApproval.hostname}</span>?
            </span>
            <button
              type="button"
              onClick={() => void handleApproveHost()}
              className="shrink-0 px-2 py-0.5 rounded text-xs bg-status-info/20 hover:bg-status-info/30 text-daintree-text/90 transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent/50"
            >
              Allow
            </button>
            <button
              type="button"
              onClick={handleDismissApproval}
              className="shrink-0 text-daintree-text/40 hover:text-daintree-text/70 transition-colors"
              aria-label="Dismiss host approval"
            >
              ×
            </button>
          </div>
        )}
        {!hasValidUrl ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
            <div className="flex flex-col items-center text-center max-w-md">
              <h3 className="text-sm font-medium text-daintree-text/70 mb-1">Browser</h3>
              <p className="text-xs text-daintree-text/50 mb-4 leading-relaxed">
                Preview your local development server. Enter a URL in the address bar above —
                localhost, LAN, Docker, and RFC-reserved TLDs (.local, .test, .internal) are all
                supported.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {["localhost:3000", "localhost:5173", "localhost:8080"].map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => handleNavigate(`http://${example}`)}
                    className="px-3 py-1.5 text-xs font-mono text-daintree-text/50 bg-overlay-soft hover:bg-overlay-medium border border-overlay rounded-md transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent/50"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : !hasBeenVisible ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text">
            <p className="text-xs text-daintree-text/50">
              Browser will load when this panel is first viewed
            </p>
          </div>
        ) : isEvicted ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
            <p className="text-xs text-daintree-text/50">Reclaimed for memory</p>
          </div>
        ) : (
          <>
            {loadError && (
              <div
                role="alert"
                className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6"
              >
                <AlertTriangle className="w-6 h-6 text-status-warning mb-3" />
                <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
                  {loadError.kind === "timeout"
                    ? "Page load timed out"
                    : loadError.kind === "cancelled"
                      ? "Load cancelled"
                      : loadError.kind === "cert"
                        ? "Certificate error"
                        : loadError.kind === "network"
                          ? "Connection failed"
                          : "Unable to display page"}
                </h3>
                <p className="text-xs text-daintree-text/50 text-center mb-3 max-w-md">
                  {loadError.message}
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    onClick={handleRetryFromError}
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 px-2.5 py-1.5 group"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    <span className="text-xs">Retry</span>
                  </Button>
                  <button
                    type="button"
                    onClick={handleOpenExternal}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-overlay-soft transition-colors group focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent/50"
                  >
                    <ExternalLink className="h-3.5 w-3.5 text-daintree-text/50 group-hover:text-daintree-text/70 transition-colors" />
                    <span className="text-xs text-daintree-text/50 group-hover:text-daintree-text/70 transition-colors">
                      Open in external browser
                    </span>
                  </button>
                </div>
              </div>
            )}
            {crashState === "crashed" && (
              <InlineStatusBanner
                icon={XCircle}
                title="Page process crashed"
                description={
                  crashDetails
                    ? `Reason: ${crashDetails.reason} (exit code ${crashDetails.exitCode})`
                    : "Browser renderer terminated unexpectedly."
                }
                severity="error"
                animated={false}
                action={{
                  id: "reload",
                  label: "Reload",
                  icon: RotateCw,
                  variant: "dangerFilled",
                  onClick: handleReload,
                  ariaLabel: "Reload page",
                }}
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
                title="Page not responding"
                description="The page may be stuck in a long-running script."
                severity="warning"
                animated={false}
                action={{
                  id: "reload",
                  label: "Reload",
                  icon: RotateCw,
                  variant: "danger",
                  onClick: handleReload,
                  ariaLabel: "Reload page",
                }}
                onClose={() => setCrashState("none")}
              />
            )}
            {blockedNav &&
              (blockedNav.errorMessage !== null ? (
                <InlineStatusBanner
                  icon={XCircle}
                  title="Couldn't open in external browser"
                  description={blockedNav.errorMessage}
                  contextLine={extractHostname(blockedNav.url)}
                  severity="error"
                  animated={false}
                  action={{
                    id: "retry-open-external",
                    label: "Retry",
                    icon: RotateCw,
                    variant: "dangerFilled",
                    loading: blockedNav.phase === "opening",
                    onClick: () =>
                      void handleOpenBlockedExternal(blockedNav.noticeId, blockedNav.url),
                    ariaLabel: "Retry opening in external browser",
                  }}
                  onClose={() => setBlockedNav(null)}
                  closeAriaLabel="Dismiss navigation notice"
                />
              ) : (
                <div
                  aria-live="polite"
                  aria-atomic="true"
                  className="flex items-center gap-2 px-3 py-1.5 text-xs bg-status-warning/10 border-b border-status-warning/20 text-daintree-text/80"
                >
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 text-status-warning" />
                  <span className="truncate flex-1">
                    Navigation to external site blocked: {extractHostname(blockedNav.url)}
                  </span>
                  {blockedNav.canOpenExternal && (
                    <button
                      type="button"
                      disabled={blockedNav.phase === "opening"}
                      aria-busy={blockedNav.phase === "opening" || undefined}
                      onClick={() =>
                        void handleOpenBlockedExternal(blockedNav.noticeId, blockedNav.url)
                      }
                      className="shrink-0 px-2 py-0.5 rounded text-xs bg-status-warning/20 hover:bg-status-warning/30 text-daintree-text/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {blockedNav.phase === "opening" ? "Opening…" : "Open in external browser"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setBlockedNav(null)}
                    className="shrink-0 text-daintree-text/40 hover:text-daintree-text/70 transition-colors"
                    aria-label="Dismiss navigation notice"
                  >
                    ×
                  </button>
                </div>
              ))}
            <div className="relative flex-1 min-h-0">
              {isDragging && <div className="absolute inset-0 z-10 bg-transparent" />}
              {showLoadingOverlay && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg z-10 gap-3">
                  {/* aria-busy on the status wrapper suppresses inner live regions,
                      so the slow-load escalation announces via the sibling
                      aria-live span below (SkeletonHint pattern). */}
                  <div role="status" aria-busy="true" aria-label="Loading…">
                    <span className="sr-only">Loading…</span>
                    <Spinner size="2xl" className="text-status-info" />
                  </div>
                  <span className="sr-only" aria-live="polite" aria-atomic="true">
                    {isSlowLoad
                      ? "Loading is taking longer than usual. Select Cancel to stop."
                      : ""}
                  </span>
                  {isSlowLoad && (
                    <>
                      <p aria-hidden="true" className="text-xs text-daintree-text/50">
                        Taking longer than usual...
                      </p>
                      <Button
                        onClick={handleCancelLoad}
                        variant="ghost"
                        size="sm"
                        className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70"
                      >
                        <Square className="h-3.5 w-3.5" />
                        <span className="text-xs">Cancel</span>
                      </Button>
                    </>
                  )}
                </div>
              )}
              {findInPage.isOpen && <FindBar find={findInPage} />}
              <webview
                ref={setWebviewNode}
                // Remount if the partition ever changes after attach (e.g. a window
                // seeded only via ?projectId= where the store resolves later) so the
                // webview never keeps a stale cross-project session (#9965).
                key={webviewPartition}
                // Seed-only: never re-bind to navigation state (#9940). On a
                // key-driven remount the ref re-initializes to the current URL.
                src={initialUrlRef.current}
                partition={webviewPartition}
                // @ts-expect-error React 19 requires "" to emit the attribute; boolean true is silently dropped
                allowpopups=""
                className={cn(
                  "w-full h-full border-0",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2",
                  isDragging && "invisible pointer-events-none"
                )}
              />
              <WebviewDialog dialog={currentDialog} onRespond={handleDialogRespond} />
            </div>
          </>
        )}
      </div>
    </ContentPanel>
  );
}
