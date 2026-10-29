import { useEffect, useRef, useCallback } from "react";
import { usePortalStore } from "@/store";
import { useUIStore } from "@/store/uiStore";
import { getPortalPlaceholderBounds } from "@/lib/portalBounds";
import { getAIAgentInfo } from "@/lib/aiAgentDetection";
import { isProjectViewCached } from "@/lib/viewCacheState";
import { useProjectViewRevealed } from "@/hooks/useProjectViewRevealed";
import { logError } from "@/utils/logger";

const BOUNDS_POLL_ATTEMPTS = 20;

interface PendingRestore {
  tabId: string;
  tabUrl: string;
  retried: boolean;
}

/**
 * Zero-UI controller component that manages portal visibility.
 * Mount once in AppLayout - handles IPC hide/show calls when:
 * - Overlays open/close (modal dialogs, etc.)
 * - Portal is collapsed and re-expanded
 * - App starts up with persisted tabs (auto-creates backend views)
 * - Main releases the active tab, here or while this project view was cached
 */
export function PortalVisibilityController(): null {
  const portalOpen = usePortalStore((state) => state.isOpen);
  const activeTabId = usePortalStore((state) => state.activeTabId);
  const tabs = usePortalStore((state) => state.tabs);
  const createdTabs = usePortalStore((state) => state.createdTabs);
  const restoreFailedTabs = usePortalStore((state) => state.restoreFailedTabs);
  const markTabCreated = usePortalStore((state) => state.markTabCreated);
  const overlayStackLength = useUIStore((state) => state.overlayStack.length);
  const hasOverlays = overlayStackLength > 0;
  const isRestoringRef = useRef(false);
  const pendingRestoreRef = useRef<PendingRestore | null>(null);
  const isMountedRef = useRef(true);

  const prevHasOverlaysRef = useRef(hasOverlays);
  const prevPortalOpenRef = useRef(portalOpen);
  const prevActiveTabIdRef = useRef(activeTabId);
  const prevCreatedTabsRef = useRef(createdTabs);
  const prevRestoreFailedTabsRef = useRef(restoreFailedTabs);

  const ensureTabAndRestore = useCallback(
    async (tabId: string, tabUrl: string, retried = false) => {
      // A cached view showing a tab would put it over the project in front.
      // Its reveal catches up instead.
      if (isProjectViewCached()) return;
      if (isRestoringRef.current) {
        pendingRestoreRef.current = { tabId, tabUrl, retried };
        return;
      }
      isRestoringRef.current = true;
      pendingRestoreRef.current = null;

      // Gives up on the tab so the dock can offer a retry instead of loading
      // forever. Queued work gets its own attempt first.
      const failRestore = () => {
        if (!isMountedRef.current || pendingRestoreRef.current) return;
        usePortalStore.getState().markTabRestoreFailed(tabId);
      };

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
        while (!bounds && attempts < BOUNDS_POLL_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (!isMountedRef.current) break;
          const pending = pendingRestoreRef.current as PendingRestore | null;
          if (pending && pending.tabId !== tabId) break;
          bounds = getBounds();
          attempts++;
        }

        if (!bounds) {
          // Only a wait that ran out is a failure; a break means unmount or a
          // newer tab took over.
          if (attempts >= BOUNDS_POLL_ATTEMPTS) failRestore();
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
        if (uiState.overlayStack.length > 0 || isProjectViewCached()) {
          isRestoringRef.current = false;
          return;
        }

        const shown = await window.electron.portal.show({ tabId, bounds });
        if (shown === false) {
          // Main released the tab after createdTabs said it held it, or between
          // our create and this show. Unmarking an already-created tab hands it
          // to the released-tab effect below; one we just created gets a single
          // retry here, at its latest URL.
          if (needsCreation) {
            const latestUrl = usePortalStore.getState().tabs.find((t) => t.id === tabId)?.url;
            if (!retried && latestUrl && !pendingRestoreRef.current) {
              pendingRestoreRef.current = { tabId, tabUrl: latestUrl, retried: true };
            } else {
              failRestore();
            }
          } else {
            usePortalStore.getState().unmarkTabCreated(tabId);
          }
          return;
        }

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
        failRestore();
      } finally {
        isRestoringRef.current = false;
        const pending = pendingRestoreRef.current as PendingRestore | null;
        if (pending && isMountedRef.current) {
          pendingRestoreRef.current = null;
          void ensureTabAndRestore(pending.tabId, pending.tabUrl, pending.retried);
        }
      }
    },
    [markTabCreated]
  );

  // Bring the active tab back when main no longer holds it. Main reaches every
  // project view with its eviction notices, so a cached view learns about the
  // loss while hidden and restores on its way back to the front (#14537).
  const restoreActiveTabIfReleased = useCallback(() => {
    const state = usePortalStore.getState();
    const tabId = state.activeTabId;
    if (!state.isOpen || !tabId || state.createdTabs.has(tabId)) return;
    if (useUIStore.getState().overlayStack.length > 0) return;
    const tab = state.tabs.find((t) => t.id === tabId);
    if (tab?.url) void ensureTabAndRestore(tabId, tab.url);
  }, [ensureTabAndRestore]);

  useProjectViewRevealed(restoreActiveTabIfReleased);

  // The selected tab dropping out of createdTabs changes nothing the other
  // effects watch, so the pane would sit blank or on its skeleton.
  useEffect(() => {
    const prevCreatedTabs = prevCreatedTabsRef.current;
    prevCreatedTabsRef.current = createdTabs;
    if (!activeTabId || !prevCreatedTabs.has(activeTabId) || createdTabs.has(activeTabId)) return;
    restoreActiveTabIfReleased();
  }, [activeTabId, createdTabs, restoreActiveTabIfReleased]);

  // The dock's Retry clears the selected tab's failure; nothing else does while
  // the tab is still selected and uncreated.
  useEffect(() => {
    const prevRestoreFailedTabs = prevRestoreFailedTabsRef.current;
    prevRestoreFailedTabsRef.current = restoreFailedTabs;
    if (!activeTabId || !prevRestoreFailedTabs.has(activeTabId)) return;
    if (restoreFailedTabs.has(activeTabId)) return;
    restoreActiveTabIfReleased();
  }, [activeTabId, restoreFailedTabs, restoreActiveTabIfReleased]);

  // Navigation is tracked here rather than in the dock, which unmounts when
  // collapsed, so a released tab comes back at the page's latest URL.
  useEffect(() => {
    return window.electron.portal.onNavEvent((data) => {
      const store = usePortalStore.getState();
      if (!store.tabs.some((t) => t.id === data.tabId)) return;
      const agentInfo = getAIAgentInfo(data.url);
      store.updateTabTitle(data.tabId, agentInfo?.title ?? data.title);
      store.updateTabUrl(data.tabId, data.url);
      if (agentInfo?.icon) {
        store.updateTabIcon(data.tabId, agentInfo.icon);
      }
    });
  }, []);

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

    // The portal is window-wide: a cached view rerunning this (its tabs change
    // on navigation notices) would hide the front project's tab.
    if (hasOverlays && portalOpen) {
      if (isProjectViewCached()) return;
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
