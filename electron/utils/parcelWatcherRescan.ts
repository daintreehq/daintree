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
