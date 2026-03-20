import { useEffect, useRef, useCallback } from "react";
import { usePortalStore } from "@/store";
import { useUIStore } from "@/store/uiStore";
import { getPortalPlaceholderBounds } from "@/lib/portalBounds";

/**
 * Zero-UI controller component that manages portal visibility.
 * Mount once in AppLayout - handles IPC hide/show calls when:
 * - Overlays open/close (modal dialogs, etc.)
 * - Portal is collapsed and re-expanded
 * - App starts up with persisted tabs (auto-creates backend views)
 */
export function PortalVisibilityController(): null {
  const portalOpen = usePortalStore((state) => state.isOpen);
  const activeTabId = usePortalStore((state) => state.activeTabId);
  const tabs = usePortalStore((state) => state.tabs);
  const createdTabs = usePortalStore((state) => state.createdTabs);
  const markTabCreated = usePortalStore((state) => state.markTabCreated);
  const overlayCount = useUIStore((state) => state.overlayCount);
  const hasOverlays = overlayCount > 0;
  const isRestoringRef = useRef(false);
  const pendingRestoreRef = useRef<{ tabId: string; tabUrl: string } | null>(null);

  const prevHasOverlaysRef = useRef(hasOverlays);
  const prevPortalOpenRef = useRef(portalOpen);
  const prevActiveTabIdRef = useRef(activeTabId);

  const ensureTabAndRestore = useCallback(
    async (tabId: string, tabUrl: string) => {
      if (isRestoringRef.current) {
        pendingRestoreRef.current = { tabId, tabUrl };
        return;
      }
      isRestoringRef.current = true;
      pendingRestoreRef.current = null;

      try {
        const state = usePortalStore.getState();
        const needsCreation = !state.createdTabs.has(tabId);

        if (needsCreation) {
          await window.electron.portal.create({ tabId, url: tabUrl });
          const postCreateState = usePortalStore.getState();
          const stillExists = postCreateState.tabs.some((t) => t.id === tabId);
          if (stillExists) {
            markTabCreated(tabId);
          } else {
            isRestoringRef.current = false;
            return;
          }
        }

        const getBounds = () => getPortalPlaceholderBounds();

        let bounds = getBounds();
        let attempts = 0;
        while (!bounds && attempts < 20) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          bounds = getBounds();
          attempts++;
        }

        if (!bounds) {
          isRestoringRef.current = false;
          return;
        }

        const portalState = usePortalStore.getState();
        const uiState = useUIStore.getState();
        if (!portalState.isOpen || portalState.activeTabId !== tabId) {
          isRestoringRef.current = false;
          return;
        }
        if (uiState.overlayCount > 0) {
          isRestoringRef.current = false;
          return;
        }

        await window.electron.portal.show({ tabId, bounds });
      } catch (error) {
        console.error("Failed to restore tab:", error);
      } finally {
        isRestoringRef.current = false;
        const pending = pendingRestoreRef.current as { tabId: string; tabUrl: string } | null;
        if (pending) {
          pendingRestoreRef.current = null;
          void ensureTabAndRestore(pending.tabId, pending.tabUrl);
        }
      }
    },
    [markTabCreated]
  );

  // Auto-select first tab on startup when portal is open with tabs but no active tab
  useEffect(() => {
    if (!portalOpen) return;
    if (activeTabId != null) return;
    if (tabs.length === 0) return;

    usePortalStore.getState().setActiveTab(tabs[0].id);
  }, [portalOpen, tabs, activeTabId]);

  // Handle active tab changes (e.g., initial auto-select or programmatic switch)
  // This fixes the issue where the first tab is selected but not loaded on startup
  useEffect(() => {
    const prevId = prevActiveTabIdRef.current;
    prevActiveTabIdRef.current = activeTabId;

    // Trigger restore if:
    // - Active tab changed
    // - Portal is open
    // - No overlays blocking
    // - Tab not yet created in backend (means app just started or tab never loaded)
    if (
      activeTabId &&
      activeTabId !== prevId &&
      portalOpen &&
      !hasOverlays &&
      !createdTabs.has(activeTabId)
    ) {
      const activeTab = tabs.find((t) => t.id === activeTabId);
      if (activeTab?.url) {
        void ensureTabAndRestore(activeTabId, activeTab.url);
      }
    }
  }, [activeTabId, portalOpen, hasOverlays, tabs, createdTabs, ensureTabAndRestore]);

  // Handle overlay visibility changes
  useEffect(() => {
    const wasHiddenByOverlay = prevHasOverlaysRef.current;
    prevHasOverlaysRef.current = hasOverlays;

    if (hasOverlays && portalOpen) {
      window.electron.portal.hide();
    } else if (!hasOverlays && wasHiddenByOverlay && portalOpen && activeTabId) {
      const activeTab = tabs.find((t) => t.id === activeTabId);
      if (activeTab?.url) {
        void ensureTabAndRestore(activeTabId, activeTab.url);
      }
    }
  }, [hasOverlays, portalOpen, activeTabId, tabs, ensureTabAndRestore]);

  // Handle portal open/close toggle (collapse and re-expand)
  useEffect(() => {
    const wasClosed = !prevPortalOpenRef.current;
    prevPortalOpenRef.current = portalOpen;

    // Portal just opened - restore or create webview if we have an active tab
    if (portalOpen && wasClosed && activeTabId && !hasOverlays) {
      const activeTab = tabs.find((t) => t.id === activeTabId);
      if (activeTab?.url) {
        void ensureTabAndRestore(activeTabId, activeTab.url);
      }
    }
  }, [portalOpen, activeTabId, tabs, hasOverlays, ensureTabAndRestore]);

  return null;
}
