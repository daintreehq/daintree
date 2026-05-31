import { app } from "electron";

// macOS `daintree://` deep-link queue + `open-url` listener (#9559). Kept in its
// own lightweight module — separate from the heavy `environment.ts` (which runs
// `app.getPath`/`setPath` and other fs work at module load) — so importers that
// only need the queue accessors (e.g. `deepLinkInstall.ts`, and via it the
// `second-instance` lifecycle handler) don't pull that startup machinery into
// their graph.
//
// The listener is registered synchronously at module load, the same timing
// rationale as the `open-file` handler in `environment.ts`: on a cold launch the
// OS delivers `open-url` during early startup, and a listener added inside the
// `whenReady` chain would miss it. `environment.ts` side-effect-imports this
// module so it loads on the existing early path. URLs that arrive before the
// deep-link handler is wired are queued; `activateDeepLinkHandler`
// (./deepLinkInstall.ts) drains the queue and takes over live events.
//
// macOS-only — Windows/Linux deliver deep links through argv / `second-instance`.

const _pendingDaintreeUrls: string[] = [];
let _daintreeUrlConsumer: ((url: string) => void) | null = null;

/** Snapshot (copy) of deep-link URLs queued before the handler was activated. */
export function getPendingDaintreeUrls(): string[] {
  return [..._pendingDaintreeUrls];
}

export function clearPendingDaintreeUrls(): void {
  _pendingDaintreeUrls.length = 0;
}

/**
 * Install the live `open-url` consumer. Once set, incoming URLs route directly
 * to it instead of the pre-ready queue. Pass `null` to detach.
 */
export function setDaintreeUrlConsumer(consumer: ((url: string) => void) | null): void {
  _daintreeUrlConsumer = consumer;
}

if (process.platform === "darwin") {
  app.on("open-url", (event, url) => {
    // Required: without preventDefault, Chromium's default handling may try to
    // navigate the focused window to the deep-link URL.
    event.preventDefault();
    if (_daintreeUrlConsumer) {
      _daintreeUrlConsumer(url);
    } else if (!_pendingDaintreeUrls.includes(url)) {
      // Dedup: a burst of identical deep links before activation shouldn't
      // queue N copies and re-trigger the same intent N times.
      _pendingDaintreeUrls.push(url);
    }
  });
}
