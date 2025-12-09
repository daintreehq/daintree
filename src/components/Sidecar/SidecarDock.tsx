import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { useSidecarStore } from "@/store";
import { cn } from "@/lib/utils";
import { SidecarToolbar } from "./SidecarToolbar";
import { SidecarLaunchpad } from "./SidecarLaunchpad";
import { SIDECAR_MIN_WIDTH, SIDECAR_MAX_WIDTH } from "@shared/types";
import { systemClient } from "@/clients/systemClient";
import { getAIAgentInfo } from "@/lib/aiAgentDetection";

export function SidecarDock() {
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
    closeAllTabs,
    markTabCreated,
    updateTabUrl,
    updateTabTitle,
    createdTabs,
  } = useSidecarStore();
  const placeholderRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);

  const getPlaceholderBounds = useCallback(() => {
    if (!placeholderRef.current) return null;
    const rect = placeholderRef.current.getBoundingClientRect();
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

  const syncBounds = useCallback(() => {
    if (!placeholderRef.current || !activeTabId) return;
    const rect = placeholderRef.current.getBoundingClientRect();
    window.electron.sidecar.resize({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }, [activeTabId]);

  useEffect(() => {
    if (!placeholderRef.current || !activeTabId) return;

    const debouncedSync = debounce(syncBounds, 100);
    const observer = new ResizeObserver(debouncedSync);
    observer.observe(placeholderRef.current);

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
    (tabId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      // Store's closeTab handles state update and deferred webview switching
      closeTab(tabId);
    },
    [closeTab]
  );

  const handleNewTab = useCallback(() => {
    createBlankTab();
    window.electron.sidecar.hide();
  }, [createBlankTab]);

  const handleOpenUrl = useCallback(
    async (url: string, title: string) => {
      setIsSwitching(true);

      try {
        // Detect if this is a known AI agent
        const agentInfo = getAIAgentInfo(url);
        const finalTitle = agentInfo?.title ?? title;
        const icon = agentInfo?.icon;

        // Reuse blank tab if active, otherwise create new tab
        const currentTab = activeTabId ? tabs.find((t) => t.id === activeTabId) : null;
        const isCurrentBlank = currentTab && !currentTab.url;

        let tabId: string;
        if (isCurrentBlank && activeTabId) {
          // Reuse the blank tab
          tabId = activeTabId;
          updateTabUrl(tabId, url);
          updateTabTitle(tabId, finalTitle);
          if (icon) {
            useSidecarStore.getState().updateTabIcon(tabId, icon);
          }
        } else {
          // Create new tab
          const newTabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const newTab = { id: newTabId, url, title: finalTitle, icon };
          useSidecarStore.setState((s) => ({
            tabs: [...s.tabs, newTab],
          }));
          tabId = newTabId;
          // Switch to it immediately so the placeholder renders
          setActiveTab(tabId);
        }

        // Poll for placeholder to exist (wait for React render cycle)
        // The placeholder needs a frame to appear after showLaunchpad becomes false
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

        // Create in main process
        await window.electron.sidecar.create({ tabId, url });
        markTabCreated(tabId);

        // Show webview
        await window.electron.sidecar.show({ tabId, bounds });
      } catch (error) {
        console.error("Failed to open URL in sidecar:", error);
        // Rollback: hide any partial webview
        await window.electron.sidecar.hide().catch(() => {});
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

  return (
    <div className="flex flex-col h-full bg-canopy-bg relative" style={{ width }}>
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
        onClose={handleClose}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onReload={handleReload}
        onOpenExternal={handleOpenExternal}
        hasActiveUrl={hasActiveUrl}
      />
      {showLaunchpad ? (
        <SidecarLaunchpad links={enabledLinks} onOpenUrl={handleOpenUrl} />
      ) : (
        <div ref={placeholderRef} className="flex-1 bg-canopy-sidebar" id="sidecar-placeholder" />
      )}
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
