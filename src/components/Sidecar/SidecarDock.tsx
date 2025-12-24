import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import type React from "react";
import { useSidecarStore } from "@/store";
import { cn } from "@/lib/utils";
import { SidecarToolbar } from "./SidecarToolbar";
import { SidecarLaunchpad } from "./SidecarLaunchpad";
import { SIDECAR_MIN_WIDTH, SIDECAR_MAX_WIDTH } from "@shared/types";
import { getAIAgentInfo } from "@/lib/aiAgentDetection";
import { useKeybinding, useKeybindingScope } from "@/hooks/useKeybinding";
import { useNativeContextMenu } from "@/hooks";
import type { MenuItemOption } from "@/types";
import { actionService } from "@/services/ActionService";

export function SidecarDock() {
  const { showMenu } = useNativeContextMenu();
  const {
    width,
    activeTabId,
    tabs,
    links,
    setWidth,
    setOpen,
    defaultNewTabUrl,
    layoutModePreference,
  } = useSidecarStore();
  const contentRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  useKeybindingScope("sidecar", isFocused);

  const enabledLinks = useMemo(
    () => links.filter((l) => l.enabled).sort((a, b) => a.order - b.order),
    [links]
  );

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isBlankTab = activeTabId !== null && activeTab && !activeTab.url;
  const showLaunchpad = activeTabId === null || tabs.length === 0 || isBlankTab;
  const hasActiveUrl =
    activeTab?.url !== undefined && activeTab.url !== null && activeTab.url !== "";

  const handleGlobalContextMenu = useCallback(
    async (event: React.MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest(
          "button,[role='tab'],[role='separator'],a,input,textarea,select,[contenteditable='true']"
        )
      ) {
        return;
      }

      const defaultNewTabItems: MenuItemOption[] = [
        {
          id: "sidecar:default-new-tab:launchpad",
          label: "Launchpad",
          type: "checkbox",
          checked: defaultNewTabUrl === null,
        },
        ...(enabledLinks.length > 0 ? [{ type: "separator" as const }] : []),
        ...enabledLinks.map((link) => ({
          id: `sidecar:default-new-tab:url:${link.url}`,
          label: link.title,
          type: "checkbox" as const,
          checked: defaultNewTabUrl === link.url,
        })),
      ];

      const template: MenuItemOption[] = [
        { id: "sidecar:new-tab", label: "New Tab" },
        { type: "separator" },
        { id: "sidecar:close-tab", label: "Close Tab", enabled: activeTabId !== null },
        { id: "sidecar:close-all", label: "Close All Tabs", enabled: tabs.length > 0 },
        { type: "separator" },
        {
          id: "sidecar:layout-mode",
          label: "Layout Mode",
          submenu: [
            {
              id: "sidecar:layout-mode:auto",
              label: "Auto",
              type: "checkbox",
              checked: layoutModePreference === "auto",
            },
            {
              id: "sidecar:layout-mode:push",
              label: "Push",
              type: "checkbox",
              checked: layoutModePreference === "push",
            },
            {
              id: "sidecar:layout-mode:overlay",
              label: "Overlay",
              type: "checkbox",
              checked: layoutModePreference === "overlay",
            },
          ],
        },
        { id: "sidecar:reset-width", label: "Reset Width" },
        { type: "separator" },
        { id: "sidecar:default-new-tab", label: "Default New Tab", submenu: defaultNewTabItems },
        { type: "separator" },
        { id: "settings:open:sidecar", label: "Sidecar Settings..." },
      ];

      const actionId = await showMenu(event, template);
      if (!actionId) return;

      if (actionId.startsWith("sidecar:default-new-tab:url:")) {
        const url = actionId.slice("sidecar:default-new-tab:url:".length);
        void actionService.dispatch(
          "sidecar.setDefaultNewTab",
          { url },
          { source: "context-menu" }
        );
        return;
      }

      switch (actionId) {
        case "sidecar:new-tab":
          void actionService.dispatch("sidecar.newTab", undefined, { source: "context-menu" });
          break;
        case "sidecar:close-tab":
          void actionService.dispatch("sidecar.closeTab", undefined, { source: "context-menu" });
          break;
        case "sidecar:close-all":
          void actionService.dispatch("sidecar.closeAllTabs", undefined, {
            source: "context-menu",
          });
          break;
        case "sidecar:layout-mode:auto":
          void actionService.dispatch(
            "sidecar.setLayoutMode",
            { mode: "auto" },
            { source: "context-menu" }
          );
          break;
        case "sidecar:layout-mode:push":
          void actionService.dispatch(
            "sidecar.setLayoutMode",
            { mode: "push" },
            { source: "context-menu" }
          );
          break;
        case "sidecar:layout-mode:overlay":
          void actionService.dispatch(
            "sidecar.setLayoutMode",
            { mode: "overlay" },
            { source: "context-menu" }
          );
          break;
        case "sidecar:reset-width":
          void actionService.dispatch("sidecar.resetWidth", undefined, { source: "context-menu" });
          break;
        case "sidecar:default-new-tab:launchpad":
          void actionService.dispatch(
            "sidecar.setDefaultNewTab",
            { url: null },
            { source: "context-menu" }
          );
          break;
        case "settings:open:sidecar":
          void actionService.dispatch(
            "app.settings.openTab",
            { tab: "sidecar" },
            { source: "context-menu" }
          );
          break;
      }
    },
    [activeTabId, defaultNewTabUrl, enabledLinks, layoutModePreference, showMenu, tabs.length]
  );

  const syncBounds = useCallback(() => {
    if (!contentRef.current || !activeTabId) return;
    const rect = contentRef.current.getBoundingClientRect();
    window.electron.sidecar.resize({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
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
    const cleanup = window.electron.sidecar.onNavEvent((data) => {
      const agentInfo = getAIAgentInfo(data.url);
      const finalTitle = agentInfo?.title ?? data.title;
      useSidecarStore.getState().updateTabTitle(data.tabId, finalTitle);
      useSidecarStore.getState().updateTabUrl(data.tabId, data.url);
      if (agentInfo?.icon) {
        useSidecarStore.getState().updateTabIcon(data.tabId, agentInfo.icon);
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
          "sidecar.activateTab",
          { tabId },
          { source: "user" }
        );
        if (!result.ok) {
          console.error("Failed to activate sidecar tab:", result.error);
        }
      } catch (error) {
        console.error("Failed to activate sidecar tab:", error);
      } finally {
        setIsSwitching(false);
      }
    },
    [activeTabId, isSwitching]
  );

  const handleTabClose = useCallback((tabId: string) => {
    void actionService.dispatch("sidecar.closeTab", { tabId }, { source: "user" });
  }, []);

  const handleOpenUrl = useCallback(
    (url: string, title: string, background?: boolean) => {
      if (isSwitching) return;
      void actionService.dispatch(
        "sidecar.openUrl",
        { url, title, background },
        { source: "user" }
      );
    },
    [isSwitching]
  );

  useEffect(() => {
    if (!window.electron.sidecar.onNewTabMenuAction) return;

    const cleanup = window.electron.sidecar.onNewTabMenuAction((action) => {
      if (!action || typeof action !== "object" || typeof action.type !== "string") return;

      switch (action.type) {
        case "open-url":
          if (typeof action.url !== "string" || typeof action.title !== "string") return;
          void actionService.dispatch(
            "sidecar.openUrl",
            { url: action.url, title: action.title },
            { source: "menu" }
          );
          return;

        case "open-launchpad":
          void actionService.dispatch("sidecar.openLaunchpad", undefined, { source: "menu" });
          return;

        case "set-default-new-tab-url":
          void actionService.dispatch(
            "sidecar.setDefaultNewTab",
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
    void actionService.dispatch("sidecar.newTab", undefined, { source: "user" });
  }, [isSwitching]);

  const handleCloseTabShortcut = useCallback(() => {
    if (tabs.length > 0) {
      void actionService.dispatch("sidecar.closeTab", undefined, { source: "keybinding" });
    }
  }, [tabs.length]);

  const handleNextTabShortcut = useCallback(() => {
    void actionService.dispatch("sidecar.nextTab", undefined, { source: "keybinding" });
  }, []);

  const handlePrevTabShortcut = useCallback(() => {
    void actionService.dispatch("sidecar.prevTab", undefined, { source: "keybinding" });
  }, []);

  const handleNewTabShortcut = useCallback(() => {
    void actionService.dispatch("sidecar.newTab", undefined, { source: "keybinding" });
  }, []);

  useKeybinding("sidecar.closeTab", handleCloseTabShortcut, { enabled: isFocused });
  useKeybinding("sidecar.nextTab", handleNextTabShortcut, { enabled: isFocused });
  useKeybinding("sidecar.prevTab", handlePrevTabShortcut, { enabled: isFocused });
  useKeybinding("sidecar.newTab", handleNewTabShortcut, { enabled: isFocused });

  const handleClose = useCallback(async () => {
    await actionService.dispatch("sidecar.closeAllTabs", undefined, { source: "user" });
    setOpen(false);
  }, [setOpen]);

  const handleGoBack = useCallback(async () => {
    await actionService.dispatch("sidecar.goBack", undefined, { source: "user" });
  }, [activeTabId]);

  const handleGoForward = useCallback(async () => {
    await actionService.dispatch("sidecar.goForward", undefined, { source: "user" });
  }, [activeTabId]);

  const handleReload = useCallback(async () => {
    await actionService.dispatch("sidecar.reload", undefined, { source: "user" });
  }, [activeTabId]);

  const handleOpenExternal = useCallback(async () => {
    const result = await actionService.dispatch("sidecar.openExternal", undefined, {
      source: "user",
    });
    if (!result.ok) {
      console.error("Failed to open URL externally:", result.error);
    }
  }, []);

  const handleCopyUrl = useCallback(async () => {
    const result = await actionService.dispatch("sidecar.copyUrl", undefined, { source: "user" });
    if (!result.ok) {
      console.error("Failed to copy URL:", result.error);
    }
  }, []);

  const handleDuplicateTab = useCallback(
    async (tabId: string) => {
      if (isSwitching) return;
      const result = await actionService.dispatch(
        "sidecar.duplicateTab",
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
        "sidecar.closeOthers",
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
        "sidecar.closeToRight",
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
      "sidecar.copyTabUrl",
      { tabId },
      { source: "context-menu" }
    );
    if (!result.ok) {
      console.error("Failed to copy tab URL:", result.error);
    }
  }, []);

  const handleOpenTabExternal = useCallback(async (tabId: string) => {
    const result = await actionService.dispatch(
      "sidecar.openTabExternal",
      { tabId },
      { source: "context-menu" }
    );
    if (!result.ok) {
      console.error("Failed to open tab externally:", result.error);
    }
  }, []);

  const handleReloadTab = useCallback(async (tabId: string) => {
    const result = await actionService.dispatch(
      "sidecar.reloadTab",
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
        const newWidth = Math.min(
          Math.max(startWidth + delta, SIDECAR_MIN_WIDTH),
          SIDECAR_MAX_WIDTH
        );
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
        const newWidth = Math.min(width + RESIZE_STEP, SIDECAR_MAX_WIDTH);
        setWidth(newWidth);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const newWidth = Math.max(width - RESIZE_STEP, SIDECAR_MIN_WIDTH);
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
    if (!window.electron.sidecar.onFocus || !window.electron.sidecar.onBlur) return;

    const cleanupFocus = window.electron.sidecar.onFocus(() => {
      setIsFocused(true);
    });
    const cleanupBlur = window.electron.sidecar.onBlur(() => {
      setIsFocused(false);
    });
    return () => {
      cleanupFocus();
      cleanupBlur();
    };
  }, []);

  return (
    <div
      ref={dockRef}
      className="flex flex-col h-full bg-canopy-bg relative sidecar-dock"
      style={{ width }}
      onFocus={handleDockFocus}
      onBlur={handleDockBlur}
      onContextMenu={handleGlobalContextMenu}
      tabIndex={-1}
    >
      <div
        role="separator"
        aria-label="Resize sidecar panel"
        aria-orientation="vertical"
        aria-valuenow={Math.round(width)}
        aria-valuemin={SIDECAR_MIN_WIDTH}
        aria-valuemax={SIDECAR_MAX_WIDTH}
        tabIndex={0}
        className={cn(
          "group absolute -left-0.5 top-0 bottom-0 w-1.5 cursor-ew-resize flex items-center justify-center z-50",
          "hover:bg-white/[0.03] transition-colors focus:outline-none focus:bg-white/[0.04] focus:ring-1 focus:ring-canopy-accent/50",
          isResizing && "bg-canopy-accent/20"
        )}
        onMouseDown={handleResizeStart}
        onKeyDown={handleKeyDown}
      >
        <div
          className={cn(
            "w-px h-8 rounded-full transition-colors",
            "bg-canopy-text/20",
            "group-hover:bg-canopy-text/35 group-focus:bg-canopy-accent",
            isResizing && "bg-canopy-accent"
          )}
        />
      </div>
      <SidecarToolbar
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
          <SidecarLaunchpad links={enabledLinks} onOpenUrl={handleOpenUrl} />
        ) : (
          <div className="flex-1 bg-canopy-sidebar" id="sidecar-placeholder" />
        )}
      </div>
    </div>
  );
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return ((...args: unknown[]) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), ms);
  }) as T;
}
