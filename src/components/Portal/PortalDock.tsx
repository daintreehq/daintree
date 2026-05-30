import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import type React from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortalStore } from "@/store";
import { cn } from "@/lib/utils";
import { PortalToolbar } from "./PortalToolbar";
import { PortalLaunchpad } from "./PortalLaunchpad";
import { DevServerDashboard } from "./DevServerDashboard";
import { PortalTabSkeleton } from "./PortalTabSkeleton";
import { useSkeletonGate, useSkeletonFloor } from "@/hooks/useDeferredLoading";
import {
  PORTAL_MIN_WIDTH,
  PORTAL_MAX_WIDTH,
  PORTAL_DEFAULT_WIDTH,
  PORTAL_MIN_EDITOR_WIDTH,
} from "@shared/types";
import { getAIAgentInfo } from "@/lib/aiAgentDetection";
import { useKeybindingScope } from "@/hooks/useKeybinding";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import {
  ContextMenu,
  ContextMenuActionItem,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { MenuActionSourceContext } from "@/components/ui/menu-source";
import { getElementBoundsAsDip } from "@/lib/portalBounds";
import { debounce } from "@/utils/debounce";

export function PortalDock() {
  const {
    width,
    activeTabId,
    tabs,
    links,
    createdTabs,
    setWidth,
    setOpen,
    defaultNewTabUrl,
    showDevDashboard,
  } = usePortalStore(
    useShallow((s) => ({
      width: s.width,
      activeTabId: s.activeTabId,
      tabs: s.tabs,
      links: s.links,
      createdTabs: s.createdTabs,
      setWidth: s.setWidth,
      setOpen: s.setOpen,
      defaultNewTabUrl: s.defaultNewTabUrl,
      showDevDashboard: s.showDevDashboard,
    }))
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);
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

  // Render a skeleton in the content placeholder while the active tab's view is
  // being (re)created. Triggers on cold start with a persisted activeTabId and
  // on click of an LRU-evicted tab (PortalManager evicts beyond PORTAL_MAX_LIVE_TABS),
  // both of which take 300-800ms to resolve via portal.create + bounds wait + portal.show.
  const isTabRestoring = !showLaunchpad && activeTabId !== null && !createdTabs.has(activeTabId);
  const isRestoringGated = useSkeletonGate(isTabRestoring);
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

  useEffect(() => {
    const cleanup = window.electron.portal.onNavEvent((data) => {
      const agentInfo = getAIAgentInfo(data.url);
      const finalTitle = agentInfo?.title ?? data.title;
      usePortalStore.getState().updateTabTitle(data.tabId, finalTitle);
      usePortalStore.getState().updateTabUrl(data.tabId, data.url);
      if (agentInfo?.icon) {
        usePortalStore.getState().updateTabIcon(data.tabId, agentInfo.icon);
      }
    });
    return cleanup;
  }, []);

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

  useEffect(() => {
    if (!window.electron.portal.onNewTabMenuAction) return;

    const cleanup = window.electron.portal.onNewTabMenuAction((action) => {
      if (!action || typeof action !== "object" || typeof action.type !== "string") return;

      switch (action.type) {
        case "open-url":
          if (typeof action.url !== "string" || typeof action.title !== "string") return;
          void actionService.dispatch(
            "portal.openUrl",
            { url: action.url, title: action.title },
            { source: "menu" }
          );
          return;

        case "open-launchpad":
          void actionService.dispatch("portal.openLaunchpad", undefined, { source: "menu" });
          return;

        case "set-default-new-tab-url":
          void actionService.dispatch(
            "portal.setDefaultNewTab",
            { url: action.url },
            { source: "menu" }
          );
          return;

        default:
          return;
      }
    });

    return cleanup;
  }, []);

  const handleNewTab = useCallback(() => {
    if (isSwitching) return;
    void actionService.dispatch("portal.newTab", undefined, { source: "user" });
  }, [isSwitching]);

  // Keybindings for portal scope are handled by the global keybinding handler
  // useKeybindingScope above tells the service when portal is focused

  const handleClose = useCallback(async () => {
    await actionService.dispatch("portal.closeAllTabs", undefined, { source: "user" });
    // At 3+ tabs the action escalates to a confirm dialog and leaves the
    // tabs intact; collapsing the dock here would hide the portal out from
    // under that dialog. Only collapse once the tabs are actually gone.
    if (usePortalStore.getState().tabs.length === 0) {
      setOpen(false);
    }
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

  const handleCopyUrl = useCallback(async () => {
    const result = await actionService.dispatch("portal.copyUrl", undefined, { source: "user" });
    if (!result.ok) {
      logError("Failed to copy URL", undefined, { error: result.error });
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

  const handleCopyTabUrl = useCallback(async (tabId: string) => {
    const result = await actionService.dispatch("portal.copyTabUrl", { tabId }, { source: "user" });
    if (!result.ok) {
      logError("Failed to copy tab URL", undefined, { error: result.error });
    }
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

  const handleResizeDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    void actionService.dispatch("portal.resetWidth", undefined, { source: "user" });
  }, []);

  // Right-anchored dock: ArrowLeft widens, ArrowRight narrows. Home/End and
  // Shift+Arrow follow the WAI-ARIA APG window-splitter pattern (Home/End)
  // plus the common IDE convention of a coarse step under Shift.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? RESIZE_STEP_COARSE : RESIZE_STEP_FINE;
      let nextWidth: number;
      switch (e.key) {
        case "ArrowLeft":
          nextWidth = width + step;
          break;
        case "ArrowRight":
          nextWidth = width - step;
          break;
        case "Home":
          nextWidth = PORTAL_MIN_WIDTH;
          break;
        case "End":
          nextWidth = PORTAL_MAX_WIDTH;
          break;
        default:
          return;
      }
      e.preventDefault();
      setWidth(Math.min(Math.max(nextWidth, PORTAL_MIN_WIDTH), PORTAL_MAX_WIDTH));
    },
    [width, setWidth]
  );

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

  const handleDockFocus = useCallback(() => {
    setIsFocused(true);
  }, []);

  const handleDockBlur = useCallback((e: React.FocusEvent) => {
    if (dockRef.current && !dockRef.current.contains(e.relatedTarget as Node)) {
      setIsFocused(false);
    }
  }, []);

  useEffect(() => {
    if (!window.electron.portal.onFocus || !window.electron.portal.onBlur) return;

    const cleanupFocus = window.electron.portal.onFocus(() => {
      setIsFocused(true);
    });
    const cleanupBlur = window.electron.portal.onBlur(() => {
      setIsFocused(false);
    });
    return () => {
      cleanupFocus();
      cleanupBlur();
    };
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <aside
          ref={dockRef}
          role="region"
          aria-label="Portal"
          data-macro-focus={isMacroFocused ? "true" : undefined}
          className={cn(
            "flex flex-col h-full bg-daintree-bg relative portal-dock outline-hidden",
            "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-border-default data-[macro-focus=true]:ring-inset"
          )}
          style={{ width }}
          onFocus={handleDockFocus}
          onBlur={handleDockBlur}
          tabIndex={-1}
        >
          <div
            role="separator"
            aria-label="Resize portal panel"
            aria-orientation="vertical"
            aria-controls="portal-placeholder"
            aria-valuenow={Math.round(width)}
            aria-valuemin={PORTAL_MIN_WIDTH}
            aria-valuemax={PORTAL_MAX_WIDTH}
            tabIndex={0}
            className={cn(
              "group absolute -left-1.5 top-0 bottom-0 w-3 cursor-col-resize flex items-center justify-center z-50",
              "hover:bg-overlay-soft transition-colors focus:outline-hidden focus:bg-tint/[0.04] focus:ring-1 focus:ring-daintree-accent/50",
              isResizing && "bg-overlay-medium"
            )}
            onMouseDown={handleResizeStart}
            onDoubleClick={handleResizeDoubleClick}
            onKeyDown={handleKeyDown}
          >
            <div
              className={cn(
                "w-px h-8 rounded-full transition-[width] duration-150 delay-100 group-hover:w-0.5",
                "bg-daintree-text/20",
                "group-hover:bg-daintree-text/35 group-focus:bg-daintree-accent",
                isResizing && "bg-daintree-text/50"
              )}
            />
          </div>
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
            onCopyUrl={handleCopyUrl}
            hasActiveUrl={hasActiveUrl}
            onDuplicateTab={handleDuplicateTab}
            onCloseOthers={handleCloseOthers}
            onCloseToRight={handleCloseToRight}
            onCopyTabUrl={handleCopyTabUrl}
            onOpenTabExternal={handleOpenTabExternal}
            onReloadTab={handleReloadTab}
            enabledLinks={enabledLinks}
          />
          <div
            ref={contentRef}
            id="portal-placeholder"
            className="flex-1 flex flex-col min-h-0 relative"
          >
            {showLaunchpad ? (
              <PortalLaunchpad links={enabledLinks} onOpenUrl={handleOpenUrl} />
            ) : showSkeleton ? (
              <PortalTabSkeleton />
            ) : (
              <div className="flex-1 bg-daintree-sidebar" />
            )}
          </div>
          {showDevDashboard && <DevServerDashboard />}
        </aside>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuActionItem actionId="portal.newTab">New Tab</ContextMenuActionItem>
        <ContextMenuSeparator />
        <ContextMenuActionItem actionId="portal.closeTab" disabled={activeTabId === null}>
          Close Tab
        </ContextMenuActionItem>
        <ContextMenuActionItem actionId="portal.closeAllTabs" disabled={tabs.length === 0}>
          Close All Tabs
        </ContextMenuActionItem>
        <ContextMenuSeparator />
        <ContextMenuActionItem actionId="portal.resetWidth">Reset Width</ContextMenuActionItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>Default New Tab</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <MenuActionSourceContext.Consumer>
              {(source) => (
                <ContextMenuCheckboxItem
                  checked={defaultNewTabUrl === null}
                  onSelect={() =>
                    void actionService.dispatch(
                      "portal.setDefaultNewTab",
                      { url: null },
                      { source: source ?? "user" }
                    )
                  }
                >
                  Launchpad
                </ContextMenuCheckboxItem>
              )}
            </MenuActionSourceContext.Consumer>
            {enabledLinks.length > 0 && <ContextMenuSeparator />}
            <MenuActionSourceContext.Consumer>
              {(source) => (
                <>
                  {enabledLinks.map((link) => (
                    <ContextMenuCheckboxItem
                      key={link.url}
                      checked={defaultNewTabUrl === link.url}
                      onSelect={() =>
                        void actionService.dispatch(
                          "portal.setDefaultNewTab",
                          { url: link.url },
                          { source: source ?? "user" }
                        )
                      }
                    >
                      {link.title}
                    </ContextMenuCheckboxItem>
                  ))}
                </>
              )}
            </MenuActionSourceContext.Consumer>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuActionItem actionId="app.settings.openTab" args={{ tab: "portal" }}>
          Portal Settings...
        </ContextMenuActionItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
