import { getPortalPlaceholderBounds } from "@/lib/portalBounds";
import { usePortalStore } from "@/store/portalStore";
import {
  usePortalPendingCloseStore,
  type PortalPendingCloseKind,
} from "@/store/portalPendingCloseStore";
import { useUIStore } from "@/store/uiStore";
import { logError } from "@/utils/logger";

/** True when dispatch args carry an explicit `confirmed: true` flag. */
export const parseConfirmed = (args: unknown): boolean => {
  if (!args || typeof args !== "object") return false;
  return (args as { confirmed?: unknown }).confirmed === true;
};

/** Clear a stale pending-close request once its action proceeds. */
export const clearPortalPendingIf = (kind: PortalPendingCloseKind): void => {
  const pending = usePortalPendingCloseStore.getState().pending;
  if (pending && pending.kind === kind) {
    usePortalPendingCloseStore.getState().clear();
  }
};

export const getPortalBounds = () => getPortalPlaceholderBounds();

/**
 * Show a portal tab only when no modal overlay owns the viewport and the Portal
 * is still open. Reading both at call time (after any awaits) keeps the portal
 * WebContentsView from covering an open modal, or from reappearing over the
 * Assistant after opening it closed the Portal mid-creation. When suppressed,
 * PortalVisibilityController shows the active tab once the overlay clears or
 * the Portal reopens — no pending-show bookkeeping needed here.
 *
 * When main no longer holds the tab (released while this project view was
 * cached, #14537), the tab is marked uncreated so PortalVisibilityController
 * recreates it rather than leaving the pane blank.
 */
export const showPortalTabIfNoOverlay = async (
  tabId: string,
  bounds: { x: number; y: number; width: number; height: number }
): Promise<void> => {
  if (useUIStore.getState().overlayStack.length > 0) return;
  if (!usePortalStore.getState().isOpen) return;
  const shown = await window.electron.portal.show({ tabId, bounds });
  if (shown === false) usePortalStore.getState().unmarkTabCreated(tabId);
};

export const getPortalBoundsWithRetry = async (
  maxAttempts: number = 20,
  delayMs: number = 50
): Promise<{ x: number; y: number; width: number; height: number } | null> => {
  let bounds = getPortalBounds();
  let attempts = 0;
  while (!bounds && attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    bounds = getPortalBounds();
    attempts++;
  }
  return bounds;
};

export const activatePortalTab = async (tabId: string): Promise<void> => {
  const state = usePortalStore.getState();
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) {
    return;
  }

  state.setActiveTab(tabId);

  if (!tab?.url) {
    await window.electron.portal.hide().catch(() => {});
    return;
  }

  // Reselecting the tab already selected doesn't wake PortalVisibilityController,
  // so a restore that gives up here has to say so or the dock loads forever.
  const bounds = await getPortalBoundsWithRetry();
  if (!bounds) {
    usePortalStore.getState().markTabRestoreFailed(tabId);
    return;
  }

  try {
    // Read after the bounds wait: an eviction notice may have landed during it.
    if (!usePortalStore.getState().createdTabs.has(tabId)) {
      await window.electron.portal.create({ tabId, url: tab.url, partition: tab.partition });
      state.markTabCreated(tabId);
    }
    await showPortalTabIfNoOverlay(tabId, bounds);
  } catch (error) {
    logError("Failed to activate portal tab", error);
    usePortalStore.getState().markTabRestoreFailed(tabId);
  }
};
