import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import type React from "react";
import { useSidecarStore } from "@/store";
import { cn } from "@/lib/utils";
import { SidecarToolbar } from "./SidecarToolbar";
import { SidecarLaunchpad } from "./SidecarLaunchpad";
import { SIDECAR_DEFAULT_WIDTH, SIDECAR_MIN_WIDTH, SIDECAR_MAX_WIDTH } from "@shared/types";
import { systemClient } from "@/clients/systemClient";
import { getAIAgentInfo } from "@/lib/aiAgentDetection";
import { useKeybinding, useKeybindingScope } from "@/hooks/useKeybinding";
import { useNativeContextMenu } from "@/hooks";
import type { MenuItemOption } from "@/types";

export function SidecarDock() {
  const { showMenu } = useNativeContextMenu();
  const {
    width,
    activeTabId,
    tabs,
    links,
    setActiveTab,
    setWidth,
    setOpen,
    createBlankTab,
    closeTab,
    closeActiveTab,
    closeAllTabs,
    duplicateTab,
    closeTabsExcept,
    closeTabsAfter,
    markTabCreated,
    updateTabUrl,
    updateTabTitle,
    createdTabs,
    defaultNewTabUrl,
    layoutModePreference,
    setLayoutModePreference,
    setDefaultNewTabUrl,
  } = useSidecarStore();
  const contentRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  useKeybindingScope("sidecar", isFocused);

  const getPlaceholderBounds = useCallback(() => {
    if (!contentRef.current) return null;
    const rect = contentRef.current.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
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
        setDefaultNewTabUrl(url);
        return;
      }

      switch (actionId) {
        case "sidecar:new-tab":
          createBlankTab();
          void window.electron.sidecar.hide();
          break;
        case "sidecar:close-tab":
          closeActiveTab();
          break;
        case "sidecar:close-all":
          closeAllTabs();
          break;
        case "sidecar:layout-mode:auto":
          setLayoutModePreference("auto");
          break;
        case "sidecar:layout-mode:push":
          setLayoutModePreference("push");
          break;
        case "sidecar:layout-mode:overlay":
          setLayoutModePreference("overlay");
          break;
        case "sidecar:reset-width":
          setWidth(SIDECAR_DEFAULT_WIDTH);
          break;
        case "sidecar:default-new-tab:launchpad":
          setDefaultNewTabUrl(null);
          break;
        case "settings:open:sidecar":
          window.dispatchEvent(new CustomEvent("canopy:open-settings-tab", { detail: "sidecar" }));
          break;
      }
    },
    [
      activeTabId,
      closeActiveTab,
      closeAllTabs,
      createBlankTab,
      defaultNewTabUrl,
      enabledLinks,
      layoutModePreference,
      setDefaultNewTabUrl,
      setLayoutModePreference,
      setWidth,
      showMenu,
      tabs.length,
    ]
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

      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return;

      // Blank tabs (no URL) switch instantly - no webview to wait for
      if (!tab.url) {
        setActiveTab(tabId);
        window.electron.sidecar.hide();
        return;
      }

      const bounds = getPlaceholderBounds();
      if (!bounds) return;

      setIsSwitching(true);

      try {
        // Ensure the tab exists in main process
        if (!createdTabs.has(tabId)) {
          await window.electron.sidecar.create({ tabId, url: tab.url });
          markTabCreated(tabId);
        }

        // Wait for webview to switch before updating UI
        await window.electron.sidecar.show({ tabId, bounds });

        // Only now update the UI to highlight the tab
        setActiveTab(tabId);
      } catch (error) {
        console.error("Failed to switch tab:", error);
      } finally {
        setIsSwitching(false);
      }
    },
    [
      activeTabId,
      tabs,
      createdTabs,
      getPlaceholderBounds,
      markTabCreated,
      setActiveTab,
      isSwitching,
    ]
  );

  const handleTabClose = useCallback(
    (tabId: string) => {
      closeTab(tabId);
    },
    [closeTab]
  );

  const handleOpenUrl = useCallback(
    async (url: string, title: string, background?: boolean) => {
      const agentInfo = getAIAgentInfo(url);
      const finalTitle = agentInfo?.title ?? title;
      const icon = agentInfo?.icon;

      if (background) {
        const newTabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newTab = { id: newTabId, url, title: finalTitle, icon };
        useSidecarStore.setState((s) => ({
          tabs: [...s.tabs, newTab],
        }));
        try {
          await window.electron.sidecar.create({ tabId: newTabId, url });
          markTabCreated(newTabId);
        } catch (error) {
          console.error("Failed to create background tab:", error);
          useSidecarStore.setState((s) => ({
            tabs: s.tabs.filter((t) => t.id !== newTabId),
          }));
        }
        return;
      }

      setIsSwitching(true);

      const previousActiveTabId = activeTabId;
      let createdNewTab = false;
      let reusedTabId: string | null = null;
      let previousTabState: { url: string | null; title: string; icon?: string } | null = null;

      try {
        const currentTab = activeTabId ? tabs.find((t) => t.id === activeTabId) : null;
        const isCurrentBlank = currentTab && !currentTab.url;

        let tabId: string;
        if (isCurrentBlank && activeTabId) {
          reusedTabId = activeTabId;
          previousTabState = {
            url: currentTab.url,
            title: currentTab.title,
            icon: currentTab.icon,
          };
          tabId = activeTabId;
          updateTabUrl(tabId, url);
          updateTabTitle(tabId, finalTitle);
          if (icon) {
            useSidecarStore.getState().updateTabIcon(tabId, icon);
          }
        } else {
          const newTabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const newTab = { id: newTabId, url, title: finalTitle, icon };
          useSidecarStore.setState((s) => ({
            tabs: [...s.tabs, newTab],
          }));
          tabId = newTabId;
          createdNewTab = true;
          setActiveTab(tabId);
        }

        let bounds = getPlaceholderBounds();
        let attempts = 0;
        while (!bounds && attempts < 20) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          bounds = getPlaceholderBounds();
          attempts++;
        }

        if (!bounds) {
          throw new Error("Failed to get sidecar bounds after waiting for render");
        }

        await window.electron.sidecar.create({ tabId, url });
        markTabCreated(tabId);

        await window.electron.sidecar.show({ tabId, bounds });
      } catch (error) {
        console.error("Failed to open URL in sidecar:", error);
        await window.electron.sidecar.hide().catch(() => {});

        if (createdNewTab) {
          useSidecarStore.setState((s) => ({
            tabs: s.tabs.filter((t) => t.id !== activeTabId),
            activeTabId: previousActiveTabId,
          }));
        } else if (reusedTabId && previousTabState) {
          const restoredState = previousTabState;
          useSidecarStore.setState((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === reusedTabId
                ? {
                    ...t,
                    url: restoredState.url,
                    title: restoredState.title,
                    icon: restoredState.icon,
                  }
                : t
            ),
          }));
        }
      } finally {
        setIsSwitching(false);
      }
    },
    [
      activeTabId,
      tabs,
      markTabCreated,
      updateTabUrl,
      updateTabTitle,
      getPlaceholderBounds,
      setActiveTab,
    ]
  );

  useEffect(() => {
    if (!window.electron.sidecar.onNewTabMenuAction) return;

    const cleanup = window.electron.sidecar.onNewTabMenuAction((action) => {
      if (!action || typeof action !== "object" || typeof action.type !== "string") return;

      switch (action.type) {
        case "open-url":
          if (typeof action.url !== "string" || typeof action.title !== "string") return;
          void handleOpenUrl(action.url, action.title);
          return;

        case "open-launchpad":
          createBlankTab();
          void window.electron.sidecar.hide();
          return;

        case "set-default-new-tab-url":
          useSidecarStore.getState().setDefaultNewTabUrl(action.url);
          return;

        default:
          return;
      }
    });

    return cleanup;
  }, [createBlankTab, handleOpenUrl]);

  const handleNewTab = useCallback(() => {
    if (isSwitching) return;

    if (defaultNewTabUrl) {
      const matchingLink = links.find((l) => l.url === defaultNewTabUrl);
      const title = matchingLink?.title ?? "New Tab";
      void handleOpenUrl(defaultNewTabUrl, title);
    } else {
      createBlankTab();
      window.electron.sidecar.hide();
    }
  }, [defaultNewTabUrl, links, handleOpenUrl, createBlankTab, isSwitching]);

  const handleCloseTabShortcut = useCallback(() => {
    if (tabs.length > 0) {
      closeActiveTab();
    }
  }, [tabs.length, closeActiveTab]);

  const handleNextTabShortcut = useCallback(() => {
    if (tabs.length <= 1) return;
    const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
    const nextIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
    const nextTabId = tabs[nextIndex].id;
    void handleTabClick(nextTabId);
  }, [tabs, activeTabId, handleTabClick]);

  const handlePrevTabShortcut = useCallback(() => {
    if (tabs.length <= 1) return;
    const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
    const prevTabId = tabs[prevIndex].id;
    void handleTabClick(prevTabId);
  }, [tabs, activeTabId, handleTabClick]);

  const handleNewTabShortcut = useCallback(() => {
    handleNewTab();
  }, [handleNewTab]);

  useKeybinding("sidecar.closeTab", handleCloseTabShortcut, { enabled: isFocused });
  useKeybinding("sidecar.nextTab", handleNextTabShortcut, { enabled: isFocused });
  useKeybinding("sidecar.prevTab", handlePrevTabShortcut, { enabled: isFocused });
  useKeybinding("sidecar.newTab", handleNewTabShortcut, { enabled: isFocused });

  const handleClose = useCallback(async () => {
    closeAllTabs();
    await window.electron.sidecar.hide();
    setOpen(false);
  }, [closeAllTabs, setOpen]);

  const handleGoBack = useCallback(async () => {
    if (activeTabId) {
      await window.electron.sidecar.goBack(activeTabId);
    }
  }, [activeTabId]);

  const handleGoForward = useCallback(async () => {
    if (activeTabId) {
      await window.electron.sidecar.goForward(activeTabId);
    }
  }, [activeTabId]);

  const handleReload = useCallback(async () => {
    if (activeTabId) {
      await window.electron.sidecar.reload(activeTabId);
    }
  }, [activeTabId]);

  const handleOpenExternal = useCallback(async () => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab?.url) return;
    try {
      await systemClient.openExternal(activeTab.url);
    } catch (error) {
      console.error("Failed to open URL externally:", error);
    }
  }, [activeTabId, tabs]);

  const handleCopyUrl = useCallback(async () => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab?.url) return;
    try {
      await navigator.clipboard.writeText(activeTab.url);
    } catch (error) {
      console.error("Failed to copy URL:", error);
    }
  }, [activeTabId, tabs]);

  const handleDuplicateTab = useCallback(
    async (tabId: string) => {
      if (isSwitching) return;
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab?.url) return;

      const bounds = getPlaceholderBounds();
      if (!bounds) return;

      const newTabId = duplicateTab(tabId);
      if (!newTabId) return;

      setIsSwitching(true);
      try {
        await window.electron.sidecar.create({ tabId: newTabId, url: tab.url });
        markTabCreated(newTabId);
        await window.electron.sidecar.show({ tabId: newTabId, bounds });
      } catch (error) {
        console.error("Failed to duplicate tab:", error);
        closeTab(newTabId);
      } finally {
        setIsSwitching(false);
      }
    },
    [tabs, duplicateTab, getPlaceholderBounds, markTabCreated, isSwitching, closeTab]
  );

  const handleCloseOthers = useCallback(
    async (tabId: string) => {
      if (isSwitching) return;
      closeTabsExcept(tabId);
      const nextState = useSidecarStore.getState();
      const nextActiveId = nextState.activeTabId;
      const nextActiveTab = nextState.tabs.find((t) => t.id === nextActiveId);
      if (!nextActiveId || !nextActiveTab?.url) {
        await window.electron.sidecar.hide().catch(() => {});
        return;
      }
      const bounds = getPlaceholderBounds();
      if (!bounds) return;
      setIsSwitching(true);
      try {
        if (!nextState.createdTabs.has(nextActiveId)) {
          await window.electron.sidecar.create({ tabId: nextActiveId, url: nextActiveTab.url });
          markTabCreated(nextActiveId);
        }
        await window.electron.sidecar.show({ tabId: nextActiveId, bounds });
      } catch (error) {
        console.error("Failed to activate tab after close-others:", error);
      } finally {
        setIsSwitching(false);
      }
    },
    [closeTabsExcept, getPlaceholderBounds, isSwitching, markTabCreated]
  );

  const handleCloseToRight = useCallback(
    async (tabId: string) => {
      if (isSwitching) return;
      closeTabsAfter(tabId);
      const nextState = useSidecarStore.getState();
      const nextActiveId = nextState.activeTabId;
      const nextActiveTab = nextState.tabs.find((t) => t.id === nextActiveId);
      if (!nextActiveId || !nextActiveTab?.url) {
        await window.electron.sidecar.hide().catch(() => {});
        return;
      }
      const bounds = getPlaceholderBounds();
      if (!bounds) return;
      setIsSwitching(true);
      try {
        if (!nextState.createdTabs.has(nextActiveId)) {
          await window.electron.sidecar.create({ tabId: nextActiveId, url: nextActiveTab.url });
          markTabCreated(nextActiveId);
        }
        await window.electron.sidecar.show({ tabId: nextActiveId, bounds });
      } catch (error) {
        console.error("Failed to activate tab after close-to-right:", error);
      } finally {
        setIsSwitching(false);
      }
    },
    [closeTabsAfter, getPlaceholderBounds, isSwitching, markTabCreated]
  );

  const handleCopyTabUrl = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab?.url) return;
      try {
        await navigator.clipboard.writeText(tab.url);
      } catch (error) {
        console.error("Failed to copy URL:", error);
      }
    },
    [tabs]
  );

  const handleOpenTabExternal = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab?.url) return;
      try {
        await systemClient.openExternal(tab.url);
      } catch (error) {
        console.error("Failed to open URL externally:", error);
      }
    },
    [tabs]
  );

  const handleReloadTab = useCallback(async (tabId: string) => {
    const state = useSidecarStore.getState();
    if (!state.createdTabs.has(tabId)) return;
    try {
      await window.electron.sidecar.reload(tabId);
    } catch (error) {
      console.error("Failed to reload tab:", error);
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
          "hover:bg-canopy-accent/25 transition-colors focus:outline-none focus:bg-canopy-accent/30",
          isResizing && "bg-canopy-accent/30"
        )}
        onMouseDown={handleResizeStart}
        onKeyDown={handleKeyDown}
      >
        <div
          className={cn(
            "w-0.5 h-8 rounded-full transition-colors",
            "bg-canopy-text/20",
            "group-hover:bg-canopy-accent/70 group-focus:bg-canopy-accent",
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
