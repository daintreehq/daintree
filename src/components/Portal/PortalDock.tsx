import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import type React from "react";
import { usePortalStore } from "@/store";
import { cn } from "@/lib/utils";
import { PortalToolbar } from "./PortalToolbar";
import { PortalLaunchpad } from "./PortalLaunchpad";
import { PORTAL_MIN_WIDTH, PORTAL_MAX_WIDTH } from "@shared/types";
import { getAIAgentInfo } from "@/lib/aiAgentDetection";
import { useKeybindingScope } from "@/hooks/useKeybinding";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { actionService } from "@/services/ActionService";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { getElementBoundsAsDip } from "@/lib/portalBounds";

export function PortalDock() {
  const { width, activeTabId, tabs, links, setWidth, setOpen, defaultNewTabUrl } = usePortalStore();
  const contentRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
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
          console.error("Failed to activate portal tab:", result.error);
        }
      } catch (error) {
        console.error("Failed to activate portal tab:", error);
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
    setOpen(false);
  }, [setOpen]);

  const handleGoBack = useCallback(async () => {
    const result = await actionService.dispatch("portal.goBack", undefined, { source: "user" });
    if (!result.ok) {
      console.error("Failed to go back:", result.error);
    }
  }, [activeTabId]);

  const handleGoForward = useCallback(async () => {
    const result = await actionService.dispatch("portal.goForward", undefined, {
      source: "user",
    });
    if (!result.ok) {
      console.error("Failed to go forward:", result.error);
    }
  }, [activeTabId]);

  const handleReload = useCallback(async () => {
    const result = await actionService.dispatch("portal.reload", undefined, { source: "user" });
    if (!result.ok) {
      console.error("Failed to reload:", result.error);
    }
  }, [activeTabId]);

  const handleOpenExternal = useCallback(async () => {
    const result = await actionService.dispatch("portal.openExternal", undefined, {
      source: "user",
    });
    if (!result.ok) {
      console.error("Failed to open URL externally:", result.error);
    }
  }, []);

  const handleCopyUrl = useCallback(async () => {
    const result = await actionService.dispatch("portal.copyUrl", undefined, { source: "user" });
    if (!result.ok) {
      console.error("Failed to copy URL:", result.error);
    }
  }, []);

  const handleDuplicateTab = useCallback(
    async (tabId: string) => {
      if (isSwitching) return;
      const result = await actionService.dispatch(
        "portal.duplicateTab",
        { tabId },
        { source: "context-menu" }
      );
      if (!result.ok) {
        console.error("Failed to duplicate tab:", result.error);
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
        { source: "context-menu" }
      );
      if (!result.ok) {
        console.error("Failed to close other tabs:", result.error);
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
        { source: "context-menu" }
      );
      if (!result.ok) {
        console.error("Failed to close tabs to the right:", result.error);
      }
    },
    [isSwitching]
  );

  const handleCopyTabUrl = useCallback(async (tabId: string) => {
    const result = await actionService.dispatch(
      "portal.copyTabUrl",
      { tabId },
      { source: "context-menu" }
    );
    if (!result.ok) {
      console.error("Failed to copy tab URL:", result.error);
    }
  }, []);

  const handleOpenTabExternal = useCallback(async (tabId: string) => {
    const result = await actionService.dispatch(
      "portal.openTabExternal",
      { tabId },
      { source: "context-menu" }
    );
    if (!result.ok) {
      console.error("Failed to open tab externally:", result.error);
    }
  }, []);

  const handleReloadTab = useCallback(async (tabId: string) => {
    const result = await actionService.dispatch(
      "portal.reloadTab",
      { tabId },
      { source: "context-menu" }
    );
    if (!result.ok) {
      console.error("Failed to reload tab:", result.error);
    }
  }, []);

  const RESIZE_STEP = 10;

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
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
        setIsResizing(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);

      return () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };
    },
    [width, setWidth]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const newWidth = Math.min(width + RESIZE_STEP, PORTAL_MAX_WIDTH);
        setWidth(newWidth);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const newWidth = Math.max(width - RESIZE_STEP, PORTAL_MIN_WIDTH);
        setWidth(newWidth);
      }
    },
    [width, setWidth]
  );

  useEffect(() => {
    return () => {
      setIsResizing(false);
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
        <div
          ref={dockRef}
          role="region"
          aria-label="Portal"
          data-macro-focus={isMacroFocused ? "true" : undefined}
          className={cn(
            "flex flex-col h-full bg-daintree-bg relative portal-dock outline-none",
            "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-daintree-accent/60 data-[macro-focus=true]:ring-inset"
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
            aria-valuenow={Math.round(width)}
            aria-valuemin={PORTAL_MIN_WIDTH}
            aria-valuemax={PORTAL_MAX_WIDTH}
            tabIndex={0}
            className={cn(
              "group absolute -left-1.5 top-0 bottom-0 w-3 cursor-col-resize flex items-center justify-center z-50",
              "hover:bg-overlay-soft transition-colors focus:outline-none focus:bg-tint/[0.04] focus:ring-1 focus:ring-daintree-accent/50",
              isResizing && "bg-daintree-accent/20"
            )}
            onMouseDown={handleResizeStart}
            onKeyDown={handleKeyDown}
          >
            <div
              className={cn(
                "w-px h-8 rounded-full transition-[width] duration-150 delay-100 group-hover:w-0.5",
                "bg-daintree-text/20",
                "group-hover:bg-daintree-text/35 group-focus:bg-daintree-accent",
                isResizing && "bg-daintree-accent"
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
          <div ref={contentRef} className="flex-1 flex flex-col min-h-0 relative">
            {showLaunchpad ? (
              <PortalLaunchpad links={enabledLinks} onOpenUrl={handleOpenUrl} />
            ) : (
              <div className="flex-1 bg-daintree-sidebar" id="portal-placeholder" />
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() =>
            void actionService.dispatch("portal.newTab", undefined, { source: "context-menu" })
          }
        >
          New Tab
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={activeTabId === null}
          onSelect={() =>
            void actionService.dispatch("portal.closeTab", undefined, { source: "context-menu" })
          }
        >
          Close Tab
        </ContextMenuItem>
        <ContextMenuItem
          disabled={tabs.length === 0}
          onSelect={() =>
            void actionService.dispatch("portal.closeAllTabs", undefined, {
              source: "context-menu",
            })
          }
        >
          Close All Tabs
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() =>
            void actionService.dispatch("portal.resetWidth", undefined, { source: "context-menu" })
          }
        >
          Reset Width
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>Default New Tab</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuCheckboxItem
              checked={defaultNewTabUrl === null}
              onSelect={() =>
                void actionService.dispatch(
                  "portal.setDefaultNewTab",
                  { url: null },
                  { source: "context-menu" }
                )
              }
            >
              Launchpad
            </ContextMenuCheckboxItem>
            {enabledLinks.length > 0 && <ContextMenuSeparator />}
            {enabledLinks.map((link) => (
              <ContextMenuCheckboxItem
                key={link.url}
                checked={defaultNewTabUrl === link.url}
                onSelect={() =>
                  void actionService.dispatch(
                    "portal.setDefaultNewTab",
                    { url: link.url },
                    { source: "context-menu" }
                  )
                }
              >
                {link.title}
              </ContextMenuCheckboxItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() =>
            void actionService.dispatch(
              "app.settings.openTab",
              { tab: "portal" },
              { source: "context-menu" }
            )
          }
        >
          Portal Settings...
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return ((...args: unknown[]) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), ms);
  }) as T;
}
