import type { WebContents } from "electron";
import { watchMainFrameDocument } from "../utils/mainFrameNavigation.js";

const hydratedWebContentsIds = new Set<number>();
const watchedWebContents = new WeakSet<WebContents>();
const waiters = new Map<number, Set<() => void>>();

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
  const ready = waiters.get(id);
  waiters.delete(id);
  for (const then of ready ?? []) then();
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

/**
 * Runs `then` once the renderer's document has hydrated, at once if it has.
 * A push sent before it is lost: preload buffers nothing. Returns a cancel,
 * which the caller runs when it stops waiting.
 */
export function whenViewHydrated(webContents: WebContents, then: () => void): () => void {
  const id = webContents.id;
  if (hydratedWebContentsIds.has(id)) {
    then();
    return () => {};
  }
  let pending = waiters.get(id);
  if (!pending) waiters.set(id, (pending = new Set()));
  pending.add(then);
  const waiting = pending;
  return () => {
    waiting.delete(then);
    if (waiting.size === 0 && waiters.get(id) === waiting) waiters.delete(id);
  };
}

export function _resetViewHydrationForTesting(): void {
  hydratedWebContentsIds.clear();
  waiters.clear();
}

/** @internal Tests only: renderers something is still waiting on. */
export function _viewHydrationWaitersForTesting(): number {
  return waiters.size;
}
