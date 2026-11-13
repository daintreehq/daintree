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

/** What became of a show: on screen, held back by an overlay or a closed Portal, or gone from main. */
export type PortalShowOutcome = "shown" | "suppressed" | "missing";

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
): Promise<PortalShowOutcome> => {
  if (useUIStore.getState().overlayStack.length > 0) return "suppressed";
  if (!usePortalStore.getState().isOpen) return "suppressed";
  const shown = await window.electron.portal.show({ tabId, bounds });
  if (shown === false) {
    usePortalStore.getState().unmarkTabCreated(tabId);
    return "missing";
  }
  return "shown";
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

  // Another tab was selected during the wait; it shows itself, and showing
  // this one now would cover it.
  if (usePortalStore.getState().activeTabId !== tabId) return;

  try {
    // Read after the bounds wait: an eviction notice may have landed during it.
    if (usePortalStore.getState().createdTabs.has(tabId)) {
      await showPortalTabIfNoOverlay(tabId, bounds);
      return;
    }
    // Marked created only once it is on screen, as PortalVisibilityController
    // marks its restores: the dock keeps its skeleton until then. A show held
    // back by an overlay or a closed Portal leaves it unmarked, and the
    // controller creates and shows it when that clears. Main can drop the
    // view between create and show; that gets one more try.
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = usePortalStore.getState().tabs.find((t) => t.id === tabId)?.url;
      if (!url) return;
      await window.electron.portal.create({
        tabId,
        url,
        partition: tab.partition,
        isRestore: true,
      });
      // The same, while it loaded. It stays unmarked, so selecting it again
      // shows it.
      if (usePortalStore.getState().activeTabId !== tabId) return;
      const outcome = await showPortalTabIfNoOverlay(tabId, bounds);
      if (outcome === "suppressed") return;
      if (outcome === "shown") {
        usePortalStore.getState().markTabCreated(tabId);
        return;
      }
    }
    usePortalStore.getState().markTabRestoreFailed(tabId);
  } catch (error) {
    logError("Failed to activate portal tab", error);
    usePortalStore.getState().markTabRestoreFailed(tabId);
  }
};
