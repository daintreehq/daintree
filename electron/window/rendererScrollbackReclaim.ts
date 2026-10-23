import type { BrowserWindow } from "electron";
import { CHANNELS } from "../ipc/channels.js";
import { sendToRenderer } from "../ipc/utils.js";
import { SCROLLBACK_BACKGROUND } from "../../shared/config/scrollback.js";

/**
 * Asks each window's active project view to drop the scrollback of the
 * terminals it isn't showing to the pressure budget. Main can't see renderer
 * visibility, so the view picks the terminals and its reducer keeps the
 * focus, scroll, selection, alt-buffer and cooldown guards.
 *
 * Active views only: a cached view may be frozen, and an IPC to it would wake
 * it just to trim. Cached renderers are left to view eviction.
 *
 * Unacknowledged, so it supplies no evidence that anything was reclaimed.
 */
export function reduceHiddenRendererScrollback(windows: Iterable<BrowserWindow>): void {
  for (const win of windows) {
    try {
      sendToRenderer(win, CHANNELS.TERMINAL_REDUCE_SCROLLBACK, {
        targetLines: SCROLLBACK_BACKGROUND,
      });
    } catch {
      /* non-critical */
    }
  }
}
