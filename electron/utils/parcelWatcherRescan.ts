import type { Event } from "@parcel/watcher";

/**
 * Distinguish @parcel/watcher's non-fatal "you missed some events, re-scan"
 * signal from a genuine subscription failure. Only the macOS FSEvents backend
 * emits it (for `kFSEventStreamEventFlagMustScanSubDirs` and its kernel/client
 * drop variants), and only through the channel that leaves the subscription
 * alive. Windows fs.watch errors travel the ordinary fatal channel instead, so
 * they must NOT match here.
 *
 * Kept out of `parcelWatcherBackend.ts` on purpose: suites replace that module
 * wholesale to fake subscriptions, and a classifier living there would vanish
 * with it.
 */
export function isRescanRequest(message: string): boolean {
  return /must be re-scanned/i.test(message);
}

/**
 * Whether a batch reports the watched root itself being removed. The FSEvents
 * backend stops the stream when that happens, silently and whatever else rode
 * along with it — so a rescan notice in the same batch does not mean the
 * stream is still alive.
 */
export function removesWatchedRoot(events: readonly Event[] | undefined, root: string): boolean {
  return (
    Array.isArray(events) && events.some((event) => event?.type === "delete" && event.path === root)
  );
}
