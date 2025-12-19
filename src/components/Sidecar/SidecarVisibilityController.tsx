import { useEffect, useRef, useCallback } from "react";
import { useSidecarStore } from "@/store";
import { useUIStore } from "@/store/uiStore";

/**
 * Zero-UI controller component that manages sidecar visibility.
 * Mount once in AppLayout - handles IPC hide/show calls when:
 * - Overlays open/close (modal dialogs, etc.)
 * - Sidecar is collapsed and re-expanded
 */
export function SidecarVisibilityController(): null {
  const sidecarOpen = useSidecarStore((state) => state.isOpen);
  const activeTabId = useSidecarStore((state) => state.activeTabId);
  const tabs = useSidecarStore((state) => state.tabs);
  const markTabCreated = useSidecarStore((state) => state.markTabCreated);
  const overlayCount = useUIStore((state) => state.overlayCount);
  const hasOverlays = overlayCount > 0;
  const isRestoringRef = useRef(false);

  const prevHasOverlaysRef = useRef(hasOverlays);
  const prevSidecarOpenRef = useRef(sidecarOpen);

  const ensureTabAndRestore = useCallback(
    async (tabId: string, tabUrl: string) => {
      if (isRestoringRef.current) return;
      isRestoringRef.current = true;

      try {
        const state = useSidecarStore.getState();
        const needsCreation = !state.createdTabs.has(tabId);

        if (needsCreation) {
          await window.electron.sidecar.create({ tabId, url: tabUrl });
          const postCreateState = useSidecarStore.getState();
          const stillExists = postCreateState.tabs.some((t) => t.id === tabId);
          if (stillExists) {
            markTabCreated(tabId);
          } else {
            isRestoringRef.current = false;
            return;
          }
        }

        const getBounds = () => {
          const placeholder = document.getElementById("sidecar-placeholder");
          if (!placeholder) return null;
          const rect = placeholder.getBoundingClientRect();
          return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        };

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

        const sidecarState = useSidecarStore.getState();
        const uiState = useUIStore.getState();
        if (!sidecarState.isOpen || sidecarState.activeTabId !== tabId) {
          isRestoringRef.current = false;
          return;
        }
        if (uiState.overlayCount > 0) {
          isRestoringRef.current = false;
          return;
        }

        await window.electron.sidecar.show({ tabId, bounds });
      } catch (error) {
        console.error("Failed to restore tab:", error);
      } finally {
        isRestoringRef.current = false;
      }
    },
    [markTabCreated]
  );

  // Auto-select first tab on startup when sidecar is open with tabs but no active tab
  useEffect(() => {
    if (!sidecarOpen) return;
    if (activeTabId != null) return;
    if (tabs.length === 0) return;

    useSidecarStore.getState().setActiveTab(tabs[0].id);
  }, [sidecarOpen, tabs, activeTabId]);

  // Handle overlay visibility changes
  useEffect(() => {
    const wasHiddenByOverlay = prevHasOverlaysRef.current;
    prevHasOverlaysRef.current = hasOverlays;

    if (hasOverlays && sidecarOpen) {
      window.electron.sidecar.hide();
    } else if (!hasOverlays && wasHiddenByOverlay && sidecarOpen && activeTabId) {
      const activeTab = tabs.find((t) => t.id === activeTabId);
      if (activeTab?.url) {
        void ensureTabAndRestore(activeTabId, activeTab.url);
      }
    }
  }, [hasOverlays, sidecarOpen, activeTabId, tabs, ensureTabAndRestore]);

  // Handle sidecar open/close toggle (collapse and re-expand)
  useEffect(() => {
    const wasClosed = !prevSidecarOpenRef.current;
    prevSidecarOpenRef.current = sidecarOpen;

    // Sidecar just opened - restore or create webview if we have an active tab
    if (sidecarOpen && wasClosed && activeTabId && !hasOverlays) {
      const activeTab = tabs.find((t) => t.id === activeTabId);
      if (activeTab?.url) {
        void ensureTabAndRestore(activeTabId, activeTab.url);
      }
    }
  }, [sidecarOpen, activeTabId, tabs, hasOverlays, ensureTabAndRestore]);

  return null;
}
