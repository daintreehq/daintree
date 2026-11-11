import type { WebContents } from "electron";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRendererExcept } from "../ipc/utils.js";
import { isWebContentsFrozen } from "../utils/webContentsLifecycle.js";
import { getAppWebContents } from "./webContentsRegistry.js";
import type { WindowContext } from "./WindowRegistry.js";

type SignalWindow = Pick<WindowContext, "browserWindow" | "services">;

/**
 * Whether a project view can take ProcessMemoryMonitor's periodic pushes now.
 * A frozen one would either wake its JS or hold the work until thaw and run
 * it all inside the warm paint gate (#16810); a loading one is still booting
 * and has no settled memory to report. A frozen view's last Blink sample stays
 * recorded, so diagnostics keep its pre-freeze reading.
 */
function canTakePeriodicPush(wc: WebContents): boolean {
  return !wc.isDestroyed() && !isWebContentsFrozen(wc);
}

/**
 * Ask each project renderer for a Blink memory snapshot. Every cached view
 * that is still running is included, since a hidden renderer's memory is what
 * the snapshot is for; a window still on the bootstrap shell (no PVM yet)
 * gets its app webContents instead.
 */
export function sampleBlinkMemory(windows: readonly SignalWindow[]): void {
  const requestId = `blink-${Date.now().toString(36)}`;
  for (const { browserWindow: w, services } of windows) {
    if (w.isDestroyed()) continue;
    const pvm = services.projectViewManager;
    const targets = pvm
      ? pvm
          .getAllViews()
          .filter((v) => v.state !== "loading")
          .map((v) => v.view.webContents)
      : [getAppWebContents(w)];
    for (const wc of targets) {
      if (!wc || !canTakePeriodicPush(wc)) continue;
      try {
        wc.send(CHANNELS.EVENTS_PUSH, {
          name: "window:sample-blink-memory",
          payload: { requestId },
        });
      } catch {
        /* non-critical */
      }
    }
  }
}

/**
 * Tell every renderer to give memory back. Cached views are included: a
 * hidden renderer is exactly the one that can give memory back without anyone
 * seeing a difference. Frozen ones are left to the main-side CDP purge, which
 * reaches them without waking them.
 */
export function releaseRendererMemory(windows: readonly SignalWindow[]): void {
  const loadingIds = new Set<number>();
  for (const { services } of windows) {
    for (const v of services.projectViewManager?.getAllViews() ?? []) {
      const wc = v.view.webContents;
      if (v.state === "loading" && !wc.isDestroyed()) loadingIds.add(wc.id);
    }
  }
  broadcastToRendererExcept(
    (wc) => loadingIds.has(wc.id) || !canTakePeriodicPush(wc),
    CHANNELS.EVENTS_PUSH,
    { name: "window:reclaim-memory", payload: { reason: "system-memory-pressure" } }
  );
}
