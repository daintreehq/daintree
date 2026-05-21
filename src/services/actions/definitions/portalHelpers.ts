import { getPortalPlaceholderBounds } from "@/lib/portalBounds";
import { usePortalStore } from "@/store/portalStore";
import {
  usePortalPendingCloseStore,
  type PortalPendingCloseKind,
} from "@/store/portalPendingCloseStore";
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

  const bounds = await getPortalBoundsWithRetry();
  if (!bounds) return;

  try {
    if (!state.createdTabs.has(tabId)) {
      await window.electron.portal.create({ tabId, url: tab.url });
      state.markTabCreated(tabId);
    }
    await window.electron.portal.show({ tabId, bounds });
  } catch (error) {
    logError("Failed to activate portal tab", error);
  }
};
