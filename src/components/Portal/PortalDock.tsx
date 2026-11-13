import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import type React from "react";
import { ListX, PanelRight, Plus, Ruler, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { usePortalStore } from "@/store";
import { cn } from "@/lib/utils";
import { copyWithToast } from "@/lib/copyWithToast";
import type { CopyFlashTicket } from "@/lib/copyFlash";
import { writeMainClipboard } from "@/lib/mainClipboard";
import { PortalToolbar } from "./PortalToolbar";
import {
  PORTAL_DOCK_ID,
  PORTAL_TAB_PANEL_ID,
  PORTAL_TOGGLE_ID,
  portalTabDomId,
} from "./portalTabIds";
import { PortalDefaultNewTabSubmenu } from "./PortalDefaultNewTabSubmenu";
import { PortalLaunchpad } from "./PortalLaunchpad";
import { DevServerDashboard } from "./DevServerDashboard";
import { PortalTabSkeleton } from "./PortalTabSkeleton";
import { PortalTabRestoreError } from "./PortalTabRestoreError";
import { useSkeletonGate, useSkeletonFloor } from "@/hooks/useDeferredLoading";
import {
  PORTAL_MIN_WIDTH,
  PORTAL_MAX_WIDTH,
  PORTAL_DEFAULT_WIDTH,
  PORTAL_MIN_EDITOR_WIDTH,
} from "@shared/types";
import { useKeybindingScope } from "@/hooks/useKeybinding";
import { useSplitterKeys } from "@/hooks/useSplitterKeys";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { usePanelStore } from "@/store/panelStore";
import { enterFocusedPanel } from "@/components/Terminal/contentGridFocus";
import { restoreFocusTo } from "@/lib/accessibility";
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";
import { isProjectViewCached } from "@/lib/viewCacheState";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useNativeViewMenu } from "./useNativeViewMenu";
import { NativeViewMenuActionItem } from "./NativeViewMenuActionItem";
import { getElementBoundsAsDip } from "@/lib/portalBounds";
import { debounce } from "@/utils/debounce";

/**
 * What held the keyboard as the dock closes: its own chrome, a layer it opened
 * (its menus render in portals outside the `<aside>`), the page in its native
 * view, or nothing of the dock's. `lastFocused` is the last element focused
 * anywhere in the dock's React tree, which still holds focus only if nothing
 * outside the dock has taken it since.
 */
function closingDockFocusOwner(
  dock: HTMLElement | null,
  lastFocused: EventTarget | null,
  pageHadFocus: boolean
): "chrome" | "layer" | "page" | null {
  const active = document.activeElement;
  if (active === null || active === document.body) return pageHadFocus ? "page" : null;
  if (dock?.contains(active)) return "chrome";
  return active === lastFocused ? "layer" : null;
}

/**
 * Closing unmounts the dock, so focus it held would drop to the page body. Hand
 * it to the selected pane, or failing that the toolbar toggle that reopens the
 * dock.
 */
function returnFocusToWorkspace(): void {
  // A cached view is off screen; its keyboard is not ours to move.
  if (isProjectViewCached()) return;
  if (enterFocusedPanel(usePanelStore.getState().focusedId)) return;
  armTooltipFocusSuppression();
  restoreFocusTo(document.getElementById(PORTAL_TOGGLE_ID));
}

export function PortalDock() {
  const {
    width,
    activeTabId,
    tabs,
    links,
    createdTabs,
    restoreFailedTabs,
    tabHistory,
    setWidth,
    setOpen,
    defaultNewTabUrl,
    showDevDashboard,
    toggleDevDashboard,
  } = usePortalStore(
    useShallow((s) => ({
      width: s.width,
      activeTabId: s.activeTabId,
      tabs: s.tabs,
      links: s.links,
      createdTabs: s.createdTabs,
      restoreFailedTabs: s.restoreFailedTabs,
      tabHistory: s.tabHistory,
      setWidth: s.setWidth,
      setOpen: s.setOpen,
      defaultNewTabUrl: s.defaultNewTabUrl,
      showDevDashboard: s.showDevDashboard,
      toggleDevDashboard: s.toggleDevDashboard,
    }))
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const devServersButtonRef = useRef<HTMLButtonElement>(null);
  const pageFocusedRef = useRef(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  useKeybindingScope("portal", isFocused);

  const isMacroFocused = useMacroFocusStore((state) => state.focusedRegion === "portal");

  useEffect(() => {
    useMacroFocusStore.getState().setRegionRef("portal", dockRef.current);
    return () => useMacroFocusStore.getState().setRegionRef("portal", null);
  }, []);

  const enabledLinks = useMemo(
    () => links.filter((l) => l.enabled).sort((a, b) => a.order - b.order),
    [links]
  );

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isBlankTab = activeTabId !== null && activeTab && !activeTab.url;
  const showLaunchpad = activeTabId === null || tabs.length === 0 || isBlankTab;
  const hasActiveUrl =
    activeTab?.url !== undefined && activeTab.url !== null && activeTab.url !== "";
  // Main reports history as soon as it shows a tab, which can land just ahead
  // of the tab being marked created.
  const activeHistory =
    activeTabId !== null && createdTabs.has(activeTabId) ? tabHistory[activeTabId] : undefined;

  // Render a skeleton in the content placeholder while the active tab's view is
  // being (re)created. Triggers on cold start with a persisted activeTabId and
  // on click of an LRU-evicted tab (PortalManager evicts beyond PORTAL_MAX_LIVE_TABS),
  // both of which take 300-800ms to resolve via portal.create + bounds wait + portal.show.
  // A restore that gave up replaces the skeleton outright: the floor would
  // otherwise hold the skeleton up past the failure.
  const isTabRestoring = !showLaunchpad && activeTabId !== null && !createdTabs.has(activeTabId);
  const isRestoreFailed = isTabRestoring && restoreFailedTabs.has(activeTabId);
  const isRestoringGated = useSkeletonGate(isTabRestoring && !isRestoreFailed);
  const showSkeleton = useSkeletonFloor(isRestoringGated);

  const syncBounds = useCallback(() => {
    if (!contentRef.current || !activeTabId) return;
    const bounds = getElementBoundsAsDip(contentRef.current);
    if (bounds) {
      window.electron.portal.resize(bounds);
    }
  }, [activeTabId]);

  useEffect(() => {
    if (!contentRef.current || !activeTabId) return;

    const debouncedSync = debounce(syncBounds, 100);
    const observer = new ResizeObserver(debouncedSync);
    observer.observe(contentRef.current);

    window.addEventListener("resize", debouncedSync);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", debouncedSync);
      debouncedSync.cancel();
    };
  }, [activeTabId, syncBounds]);

  const handleTabClick = useCallback(
    async (tabId: string) => {
      if (tabId === activeTabId || isSwitching) return;
      setIsSwitching(true);
      try {
        const result = await actionService.dispatch(
          "portal.activateTab",
          { tabId },
          { source: "user" }
        );
        if (!result.ok) {
          logError("Failed to activate portal tab", undefined, { error: result.error });
        }
      } catch (error) {
        logError("Failed to activate portal tab", error);
      } finally {
        setIsSwitching(false);
      }
    },
    [activeTabId, isSwitching]
  );

  const handleTabClose = useCallback((tabId: string) => {
    void actionService.dispatch("portal.closeTab", { tabId }, { source: "user" });
  }, []);

  const handleOpenUrl = useCallback(
    (url: string, title: string, background?: boolean) => {
      if (isSwitching) return;
      void actionService.dispatch("portal.openUrl", { url, title, background }, { source: "user" });
    },
    [isSwitching]
  );

  const handleNewTab = useCallback(() => {
    if (isSwitching) return;
    void actionService.dispatch("portal.newTab", undefined, { source: "user" });
  }, [isSwitching]);

  // Keybindings for portal scope are handled by the global keybinding handler
  // useKeybindingScope above tells the service when portal is focused

  // The close button advertises the panel.togglePortal shortcut in its tooltip,
  // so it hides the portal exactly as the shortcut does and leaves the tabs
  // alone. Closing every tab is its own command (portal.closeAllTabs).
  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const handleGoBack = useCallback(async () => {
    const result = await actionService.dispatch("portal.goBack", undefined, { source: "user" });
    if (!result.ok) {
      logError("Failed to go back", undefined, { error: result.error });
    }
  }, [activeTabId]);

  const handleGoForward = useCallback(async () => {
    const result = await actionService.dispatch("portal.goForward", undefined, {
      source: "user",
    });
    if (!result.ok) {
      logError("Failed to go forward", undefined, { error: result.error });
    }
  }, [activeTabId]);

  const handleReload = useCallback(async () => {
    const result = await actionService.dispatch("portal.reload", undefined, { source: "user" });
    if (!result.ok) {
      logError("Failed to reload", undefined, { error: result.error });
    }
  }, [activeTabId]);

  const handleOpenExternal = useCallback(async () => {
    const result = await actionService.dispatch("portal.openExternal", undefined, {
      source: "user",
    });
    if (!result.ok) {
      logError("Failed to open URL externally", undefined, { error: result.error });
    }
  }, []);


  const handleDuplicateTab = useCallback(
    async (tabId: string) => {
      if (isSwitching) return;
      const result = await actionService.dispatch(
        "portal.duplicateTab",
        { tabId },
        { source: "user" }
      );
      if (!result.ok) {
        logError("Failed to duplicate tab", undefined, { error: result.error });
      }
    },
    [isSwitching]
  );

  const handleCloseOthers = useCallback(
    async (tabId: string) => {
      if (isSwitching) return;
      const result = await actionService.dispatch(
        "portal.closeOthers",
        { tabId },
        { source: "user" }
      );
      if (!result.ok) {
        logError("Failed to close other tabs", undefined, { error: result.error });
      }
    },
    [isSwitching]
  );

  const handleCloseToRight = useCallback(
    async (tabId: string) => {
      if (isSwitching) return;
      const result = await actionService.dispatch(
        "portal.closeToRight",
        { tabId },
        { source: "user" }
      );
      if (!result.ok) {
        logError("Failed to close tabs to the right", undefined, { error: result.error });
      }
    },
    [isSwitching]
  );

  // The tab menu row closes on select, so it confirms like any menu row: a
  // flash by the tab, and a Retry toast that writes that same URL even if the
  // tab has moved on. Written through main, since the page may hold focus.
  const handleCopyTabUrl = useCallback((tabId: string, flash: CopyFlashTicket) => {
    const url = usePortalStore.getState().tabs.find((t) => t.id === tabId)?.url;
    if (!url) return;
    copyWithToast("URL", url, {
      flash,
      write: async (text) => {
        await writeMainClipboard(text);
        return true;
      },
    });
  }, []);

  const handleOpenTabExternal = useCallback(async (tabId: string) => {
    const result = await actionService.dispatch(
      "portal.openTabExternal",
      { tabId },
      { source: "user" }
    );
    if (!result.ok) {
      logError("Failed to open tab externally", undefined, { error: result.error });
    }
  }, []);

  // Clearing the failure is the retry: PortalVisibilityController restores the
  // selected tab when its failure clears. Retry unmounts with the failure, so
  // focus moves to the dock first rather than dropping to the page.
  const handleRetryRestore = useCallback(() => {
    if (!activeTabId) return;
    const dock = dockRef.current;
    if (dock?.contains(document.activeElement)) dock.focus({ preventScroll: true });
    usePortalStore.getState().clearTabRestoreFailed(activeTabId);
  }, [activeTabId]);

  const handleOpenRestoreFailedExternal = useCallback(() => {
    if (activeTabId) void handleOpenTabExternal(activeTabId);
  }, [activeTabId, handleOpenTabExternal]);

  const handleReloadTab = useCallback(async (tabId: string) => {
    const result = await actionService.dispatch("portal.reloadTab", { tabId }, { source: "user" });
    if (!result.ok) {
      logError("Failed to reload tab", undefined, { error: result.error });
    }
  }, []);

  const RESIZE_STEP_FINE = 10;
  const RESIZE_STEP_COARSE = 50;

  // Holds the cleanup for an active drag so the unmount effect can drop the
  // document listeners if the dock tears down mid-drag. Without this the
  // listeners outlive the component (the closure keeps writing through
  // setWidth, which still mutates the surviving Zustand store).
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      // Skip the second mousedown of a double-click. The browser fires
      // mousedown twice before dblclick, so a propagation/preventDefault
      // tweak inside the dblclick handler is too late — the drag has
      // already started. See lesson #4997.
      if (e.detail > 1) return;
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = width;

      const handleMouseMove = (e: MouseEvent) => {
        const delta = startX - e.clientX;
        const newWidth = Math.min(Math.max(startWidth + delta, PORTAL_MIN_WIDTH), PORTAL_MAX_WIDTH);
        setWidth(newWidth);
      };

      const handleMouseUp = () => {
        cleanup();
      };

      const cleanup = () => {
        setIsResizing(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        dragCleanupRef.current = null;
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      dragCleanupRef.current = cleanup;
    },
    [width, setWidth]
  );

  const handleResetWidth = useCallback(() => {
    void actionService.dispatch("portal.resetWidth", undefined, { source: "user" });
  }, []);

  // Right-anchored dock, so ArrowLeft widens it.
  const handleKeyDown = useSplitterKeys({
    growKey: "ArrowLeft",
    value: width,
    min: PORTAL_MIN_WIDTH,
    max: PORTAL_MAX_WIDTH,
    step: RESIZE_STEP_FINE,
    largeStep: RESIZE_STEP_COARSE,
    onChange: setWidth,
    onReset: handleResetWidth,
  });

  // One-time viewport clamp on mount. The zustand persist `merge` callback
  // can't safely read window.innerWidth — Electron's BrowserWindow boots with
  // `show: false`, so innerWidth is 0 during synchronous hydration and every
  // restore would fall back to the default. Running after layout in a mount
  // effect avoids that. Only writes when the persisted width would crowd the
  // editor below PORTAL_MIN_EDITOR_WIDTH on the current viewport.
  const didClampRestoredWidthRef = useRef(false);
  useEffect(() => {
    if (didClampRestoredWidthRef.current) return;
    const vw = window.innerWidth;
    // vw can legitimately be 0 during early hydration — bail without
    // tripping the ref so the next mount attempt can still clamp.
    if (vw <= 0) return;
    didClampRestoredWidthRef.current = true;
    const safeMax = Math.max(
      PORTAL_MIN_WIDTH,
      Math.min(PORTAL_MAX_WIDTH, vw - PORTAL_MIN_EDITOR_WIDTH)
    );
    const currentWidth = usePortalStore.getState().width;
    if (currentWidth <= safeMax) return;
    setWidth(Math.min(PORTAL_DEFAULT_WIDTH, safeMax));
  }, [setWidth]);

  useEffect(() => {
    return () => {
      setIsResizing(false);
      dragCleanupRef.current?.();
    };
  }, []);

  const lastFocusedRef = useRef<EventTarget | null>(null);
  const noteFocus = useCallback((e: React.FocusEvent) => {
    lastFocusedRef.current = e.target;
  }, []);

  const handleDockFocus = useCallback(
    (e: React.FocusEvent) => {
      noteFocus(e);
      setIsFocused(true);
    },
    [noteFocus]
  );

  const handleDockBlur = useCallback((e: React.FocusEvent) => {
    if (dockRef.current && !dockRef.current.contains(e.relatedTarget as Node)) {
      setIsFocused(false);
    }
  }, []);

  useEffect(() => {
    if (!window.electron.portal.onFocus || !window.electron.portal.onBlur) return;

    const cleanupFocus = window.electron.portal.onFocus(() => {
      pageFocusedRef.current = true;
      setIsFocused(true);
    });
    const cleanupBlur = window.electron.portal.onBlur(() => {
      pageFocusedRef.current = false;
      setIsFocused(false);
    });
    return () => {
      cleanupFocus();
      cleanupBlur();
    };
  }, []);

  // Every way the dock closes (its Close button, the toggle shortcut, the
  // assistant opening) goes through the store. The parent unmounts the dock on
  // that change, so it is caught here, synchronously, while the dock still
  // holds focus to give back. Focus in its chrome moves at once, so it keeps
  // the ring state of the control that closed it. Focus in a layer it opened
  // waits for the unmount: a modal menu's focus trap would pull it straight
  // back, and then take it down with the menu.
  const restoreOnUnmountRef = useRef(false);
  useEffect(
    () =>
      usePortalStore.subscribe((state, prev) => {
        if (prev.isOpen === state.isOpen) return;
        restoreOnUnmountRef.current = false;
        if (state.isOpen) return;
        const owner = closingDockFocusOwner(
          dockRef.current,
          lastFocusedRef.current,
          pageFocusedRef.current
        );
        if (owner === "layer") restoreOnUnmountRef.current = true;
        else if (owner !== null) returnFocusToWorkspace();
      }),
    []
  );
  useEffect(
    () => () => {
      if (!restoreOnUnmountRef.current) return;
      restoreOnUnmountRef.current = false;
      const active = document.activeElement;
      if (active === null || active === document.body) returnFocusToWorkspace();
    },
    []
  );

  // Hiding the dashboard unmounts the button that hid it, so the toolbar toggle
  // that shows it again takes focus first: ringless after a click, the way a
  // pointer close restores focus everywhere else.
  const handleHideDevDashboard = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const toggle = devServersButtonRef.current;
      if (toggle?.isConnected && event.currentTarget.contains(document.activeElement)) {
        armTooltipFocusSuppression();
        toggle.focus(
          event.detail > 0 ? { preventScroll: true, focusVisible: false } : { preventScroll: true }
        );
      }
      toggleDevDashboard();
    },
    [toggleDevDashboard]
  );

  const { setOpen: setMenuOpen, afterClose } = useNativeViewMenu("portal-dock-menu");

  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>
        <aside
          ref={dockRef}
          id={PORTAL_DOCK_ID}
          role="region"
          aria-label="Portal"
          data-macro-focus={isMacroFocused ? "true" : undefined}
          className={cn(
            "flex flex-col h-full bg-surface-canvas relative portal-dock outline-hidden",
            "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-border-default data-[macro-focus=true]:ring-inset"
          )}
          style={{ width }}
          onFocus={handleDockFocus}
          onBlur={handleDockBlur}
          tabIndex={-1}
        >
          <ResizeHandle
            growKey="ArrowLeft"
            edge="left"
            label="Resize portal panel"
            value={width}
            min={PORTAL_MIN_WIDTH}
            max={PORTAL_MAX_WIDTH}
            isResizing={isResizing}
            aria-controls={PORTAL_DOCK_ID}
            className="z-50"
            onMouseDown={handleResizeStart}
            onKeyDown={handleKeyDown}
            onReset={handleResetWidth}
          />
          <PortalToolbar
            tabs={tabs}
            activeTabId={activeTabId}
            onTabClick={handleTabClick}
            onTabClose={handleTabClose}
            onNewTab={handleNewTab}
            defaultNewTabUrl={defaultNewTabUrl}
            onClose={handleClose}
            onGoBack={handleGoBack}
            onGoForward={handleGoForward}
            onReload={handleReload}
            onOpenExternal={handleOpenExternal}
            hasActiveUrl={hasActiveUrl}
            canGoBack={activeHistory?.canGoBack ?? false}
            canGoForward={activeHistory?.canGoForward ?? false}
            onDuplicateTab={handleDuplicateTab}
            onCloseOthers={handleCloseOthers}
            onCloseToRight={handleCloseToRight}
            onCopyTabUrl={handleCopyTabUrl}
            onOpenTabExternal={handleOpenTabExternal}
            onReloadTab={handleReloadTab}
            enabledLinks={enabledLinks}
            devServersButtonRef={devServersButtonRef}
          />
          <div
            ref={contentRef}
            id={PORTAL_TAB_PANEL_ID}
            // The tabs' controlled region while one is selected; with none, it is
            // the launchpad and nothing names it.
            role={activeTab ? "tabpanel" : undefined}
            aria-labelledby={activeTab ? portalTabDomId(activeTab.id) : undefined}
            className="flex-1 flex flex-col min-h-0 relative"
          >
            {showLaunchpad ? (
              <PortalLaunchpad links={enabledLinks} onOpenUrl={handleOpenUrl} />
            ) : isRestoreFailed && activeTab?.url ? (
              <PortalTabRestoreError
                url={activeTab.url}
                onRetry={handleRetryRestore}
                onOpenExternal={handleOpenRestoreFailedExternal}
              />
            ) : showSkeleton ? (
              <PortalTabSkeleton />
            ) : (
              <div className="flex-1 bg-surface-sidebar" />
            )}
          </div>
          {showDevDashboard && <DevServerDashboard onHide={handleHideDevDashboard} />}
        </aside>
      </ContextMenuTrigger>
      {/* A sibling of the dock in the React tree, not a child, so its focus
          never reaches the `<aside>`'s handler. */}
      <ContextMenuContent onFocus={noteFocus}>
        <NativeViewMenuActionItem actionId="portal.newTab" afterClose={afterClose}>
          <Plus data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          New tab
        </NativeViewMenuActionItem>
        <ContextMenuSeparator />
        <NativeViewMenuActionItem
          actionId="portal.closeTab"
          afterClose={afterClose}
          disabled={activeTabId === null}
        >
          <X data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Close tab
        </NativeViewMenuActionItem>
        <NativeViewMenuActionItem
          actionId="portal.closeAllTabs"
          afterClose={afterClose}
          disabled={tabs.length === 0}
        >
          <ListX data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Close all tabs
        </NativeViewMenuActionItem>
        <ContextMenuSeparator />
        <NativeViewMenuActionItem actionId="portal.resetWidth" afterClose={afterClose}>
          <Ruler data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Reset width
        </NativeViewMenuActionItem>
        <ContextMenuSeparator />
        <PortalDefaultNewTabSubmenu links={enabledLinks} defaultNewTabUrl={defaultNewTabUrl} />
        <ContextMenuSeparator />
        <NativeViewMenuActionItem
          actionId="app.settings.openTab"
          args={{ tab: "portal" }}
          afterClose={afterClose}
        >
          <PanelRight data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Portal settings…
        </NativeViewMenuActionItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
