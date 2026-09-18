import type { BrowserWindow, WebContents } from "electron";
import type { SystemMemoryPressurePayload } from "../../shared/types/ipc/system.js";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { getAppWebContents } from "./webContentsRegistry.js";

let openEpisode: SystemMemoryPressurePayload | null = null;
/**
 * WebContents that have been sent the open episode. Keyed by the renderer, not
 * the window: a replaced view carries no notice, and a reloaded one loses its
 * own dedupe latch with its context, so both must be able to receive it again.
 */
const notifiedWebContentsIds = new Set<number>();
/** WebContents already carrying the latch-clearing load listener. */
const latchedWebContents = new WeakSet<WebContents>();

function envelope(payload: SystemMemoryPressurePayload) {
  return { name: "system:memory-pressure", payload };
}

function deliver(win: BrowserWindow, wc: WebContents, viewReady: boolean): void {
  if (!openEpisode || win.isDestroyed()) return;
  if (wc.isDestroyed() || notifiedWebContentsIds.has(wc.id)) return;
  // A view still loading drops the send before its preload is listening, so it
  // waits for its own did-finish-load. That event fires before Chromium clears
  // the loading state, so the ready path must not consult isLoading() itself.
  if (!viewReady && wc.isLoading()) return;
  try {
    wc.send(CHANNELS.EVENTS_PUSH, envelope(openEpisode));
    notifiedWebContentsIds.add(wc.id);
    // A load discards the renderer's copy of the notice, so the latch must not
    // outlive it — both did-finish-load hooks for one load still dedupe,
    // because neither runs before that load has started.
    if (!latchedWebContents.has(wc)) {
      latchedWebContents.add(wc);
      wc.on("did-start-loading", () => notifiedWebContentsIds.delete(wc.id));
    }
  } catch {
    // Retried on the window's next view load.
  }
}

/**
 * Routes a system-memory episode edge (#12462). The opening edge goes once to
 * each window's visible view — a view that is mid-load, one opened later in
 * the episode, or one that reloaded and lost the notice, gets it from
 * {@link deliverOpenSystemMemoryPressure} when it finishes loading. The closing
 * edge reaches every view, cached ones included, so whichever view is showing the notice can clear it.
 */
export function publishSystemMemoryPressure(
  payload: SystemMemoryPressurePayload,
  windows: BrowserWindow[]
): void {
  notifiedWebContentsIds.clear();
  if (payload.status === "normal") {
    openEpisode = null;
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, envelope(payload));
    return;
  }
  openEpisode = payload;
  for (const win of windows) {
    if (!win.isDestroyed()) deliver(win, getAppWebContents(win), false);
  }
}

/** Call from the did-finish-load of a window's visible view. */
export function deliverOpenSystemMemoryPressure(win: BrowserWindow, wc: WebContents): void {
  deliver(win, wc, true);
}

export function resetSystemMemoryPressureDeliveryForTesting(): void {
  openEpisode = null;
  notifiedWebContentsIds.clear();
}
