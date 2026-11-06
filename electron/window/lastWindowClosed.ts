import { resetDeferredQueueForNextWindow } from "./deferredInitQueue.js";

/**
 * The deferred init queue's part in a window's `closed` event. Once the last
 * window has gone, the queue is reset so a future window's per-window tasks wait
 * for its own first-interactive. Global services stay up for the app's
 * lifetime, so `initGlobalServices()` never runs again and never re-registers
 * its tasks — which is why the reset waits until the ones still queued have
 * drained (#15562).
 */
export function releaseDeferredQueueOnWindowClosed(opts: {
  openWindowCount: number;
  hostRuntimeActive: boolean;
}): void {
  if (opts.openWindowCount > 0) return;
  // A Host owns the queue: it released the drain for the process with no
  // renderer to wait on, so later windows join it rather than starting a cycle
  // of their own.
  if (opts.hostRuntimeActive) return;
  resetDeferredQueueForNextWindow();
}
