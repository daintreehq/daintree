import type { WebContents } from "electron";
import { watchMainFrameDocument } from "../utils/mainFrameNavigation.js";

const hydratedWebContentsIds = new Set<number>();
const watchedWebContents = new WeakSet<WebContents>();

/**
 * Latches that a renderer's current document reported hydration
 * (`session-restore:view-hydrated`), which is when its post-hydration
 * listeners mount. Unlike the project view manager's restore latch, nothing
 * consumes this one: it holds until the document is replaced or its renderer
 * dies, so a push that needs a listening renderer can prefer one that has
 * them over one still booting.
 */
export function markViewHydrated(webContents: WebContents): void {
  if (webContents.isDestroyed()) return;
  const id = webContents.id;
  hydratedWebContentsIds.add(id);
  if (watchedWebContents.has(webContents)) return;
  watchedWebContents.add(webContents);
  // Cleared on commit, not on navigation start: a navigation the app cancels
  // leaves the hydrated document in place, and it would never report again.
  watchMainFrameDocument(webContents, {
    onLeaving: () => {},
    onReplaced: () => hydratedWebContentsIds.delete(id),
    onSettled: () => {},
  });
  webContents.once("destroyed", () => hydratedWebContentsIds.delete(id));
}

export function isViewHydrated(webContentsId: number): boolean {
  return hydratedWebContentsIds.has(webContentsId);
}

export function _resetViewHydrationForTesting(): void {
  hydratedWebContentsIds.clear();
}
