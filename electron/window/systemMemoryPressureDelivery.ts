import type { BrowserWindow, WebContents } from "electron";
import type { SystemMemoryPressurePayload } from "../../shared/types/ipc/system.js";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { getAppWebContents } from "./webContentsRegistry.js";

let openEpisode: SystemMemoryPressurePayload | null = null;
/** Windows whose visible view has been sent the open episode. */
const notifiedWindowIds = new Set<number>();

function envelope(payload: SystemMemoryPressurePayload) {
  return { name: "system:memory-pressure", payload };
}

function deliver(win: BrowserWindow, wc: WebContents, viewReady: boolean): void {
  if (!openEpisode || win.isDestroyed() || notifiedWindowIds.has(win.id)) return;
  if (wc.isDestroyed()) return;
  // A view still loading drops the send before its preload is listening, so it
  // waits for its own did-finish-load. That event fires before Chromium clears
  // the loading state, so the ready path must not consult isLoading() itself.
  if (!viewReady && wc.isLoading()) return;
  try {
    wc.send(CHANNELS.EVENTS_PUSH, envelope(openEpisode));
    notifiedWindowIds.add(win.id);
  } catch {
    // Retried on the window's next view load.
  }
}

/**
 * Routes a system-memory episode edge (#12462). The opening edge goes once to
 * each window's visible view — a window whose view is mid-load, or one opened
 * later in the episode, gets it from {@link deliverOpenSystemMemoryPressure}
 * when its view finishes loading. The closing edge reaches every view, cached
 * ones included, so whichever view is showing the notice can clear it.
 */
export function publishSystemMemoryPressure(
  payload: SystemMemoryPressurePayload,
  windows: BrowserWindow[]
): void {
  notifiedWindowIds.clear();
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
  notifiedWindowIds.clear();
}
