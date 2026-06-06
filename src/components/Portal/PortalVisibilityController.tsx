import { useEffect, useRef, useCallback } from "react";
import { usePortalStore } from "@/store";
import { useUIStore } from "@/store/uiStore";
import { getPortalPlaceholderBounds } from "@/lib/portalBounds";
import { logError } from "@/utils/logger";

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
  const overlayStackLength = useUIStore((state) => state.overlayStack.length);
  const hasOverlays = overlayStackLength > 0;
  const isRestoringRef = useRef(false);
  const pendingRestoreRef = useRef<{ tabId: string; tabUrl: string } | null>(null);
  const isMountedRef = useRef(true);

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
          // Re-create on the tab's own partition so a promoted dev-preview tab
          // keeps its shared session after eviction/restart instead of silently
          // reverting to the default portal session.
          const partition = state.tabs.find((t) => t.id === tabId)?.partition;
          // isRestore shields the tab from LRU eviction during the bounds
          // polling below — activeTabId only protects it after show completes.
          await window.electron.portal.create({ tabId, url: tabUrl, partition, isRestore: true });
          const postCreateState = usePortalStore.getState();
          const stillExists = postCreateState.tabs.some((t) => t.id === tabId);
          if (!stillExists) {
            isRestoringRef.current = false;
            return;
          }
        }

        const getBounds = () => getPortalPlaceholderBounds();

        let bounds = getBounds();
        let attempts = 0;
        while (!bounds && attempts < 20) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (!isMountedRef.current) break;
          const pending = pendingRestoreRef.current as { tabId: string; tabUrl: string } | null;
          if (pending && pending.tabId !== tabId) break;
          bounds = getBounds();
          attempts++;
        }

        if (!bounds) {
          isRestoringRef.current = false;
          return;
        }

        if (!isMountedRef.current) {
          return;
        }

        const portalState = usePortalStore.getState();
        const uiState = useUIStore.getState();
        if (!portalState.isOpen || portalState.activeTabId !== tabId) {
          isRestoringRef.current = false;
          return;
        }
        if (uiState.overlayStack.length > 0) {
          isRestoringRef.current = false;
          return;
        }

        await window.electron.portal.show({ tabId, bounds });

        // Mark created only after the full create + show pipeline completes so
        // PortalDock can derive `isTabRestoring = !createdTabs.has(activeTabId)`
        // as a single signal for "tab is being restored to visibility". Marking
        // earlier (post-create) would clear the skeleton before bounds polling +
        // show resolve. PortalManager.createTab is idempotent, so a later retry
        // for an already-shown tab is harmless.
        if (needsCreation) {
          markTabCreated(tabId);
        }
      } catch (error) {
        logError("Failed to restore tab", error);
      } finally {
        isRestoringRef.current = false;
        const pending = pendingRestoreRef.current as { tabId: string; tabUrl: string } | null;
        if (pending && isMountedRef.current) {
          pendingRestoreRef.current = null;
          void ensureTabAndRestore(pending.tabId, pending.tabUrl);
        }
      }
    },
    [markTabCreated]
  );

  useEffect(() => {
    return window.electron.portal.onTabEvicted(({ tabId }) => {
      usePortalStore.getState().unmarkTabCreated(tabId);
    });
  }, []);

  // Listen for portal tabs evicted by main-process memory pressure
  useEffect(() => {
    const cleanup = window.electron.portal.onTabsEvicted((payload) => {
      usePortalStore.getState().markTabsUncreated(payload.tabIds);
    });
    return cleanup;
  }, []);

  // Auto-select first tab on startup when portal is open with tabs but no active tab
  useEffect(() => {
    if (!portalOpen) return;
    if (activeTabId != null) return;
    if (tabs.length === 0) return;

    usePortalStore.getState().setActiveTab(tabs[0]!.id);
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

  // Mark unmounted so in-flight bounds polling and pending queue work bails out.
  // The body re-asserts true so React 19 StrictMode's effect re-run (cleanup then
  // body) leaves the live component flagged as mounted; production runs once.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return null;
}
