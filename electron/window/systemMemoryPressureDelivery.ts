import { randomUUID } from "node:crypto";
import type { BrowserWindow, WebContents } from "electron";
import type {
  SystemMemoryNoticeSurface,
  SystemMemoryPressureDelivery,
  SystemMemoryPressurePayload,
} from "../../shared/types/ipc/system.js";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { getAppWebContents } from "./webContentsRegistry.js";
import { onMainFrameNavigationStart } from "../utils/mainFrameNavigation.js";

type EpisodePhase = "warning" | "critical";

let openEpisode: SystemMemoryPressurePayload | null = null;
let openEpisodeId: string | null = null;
/**
 * The level whose inbox row a view has reported filing. Each project view is
 * its own renderer over one shared inbox, so once one view has filed a level's
 * row the rest leave it alone: a row the user dismissed in one project then
 * stays dismissed in every other (#18274). Until a view reports it, every
 * delivery asks for it, so a send the renderer never handled can't lose it, and
 * the views asked together file one row under one id, with only the focused
 * one toasting. The first critical publish is a new level, so it still files
 * and toasts once (#13529).
 */
let filedPhase: EpisodePhase | null = null;
/** A view raised the launch grid bar this episode (#18274). */
let launchNoticeShown = false;
/**
 * WebContents that have been sent the open episode. Keyed by the renderer, not
 * the window: a replaced view carries no notice, and a reloaded one loses its
 * own dedupe latch with its context, so both must be able to receive it again.
 */
const notifiedWebContentsIds = new Set<number>();
/** WebContents already carrying the latch-clearing load listener. */
const latchedWebContents = new WeakSet<WebContents>();

function phaseOf(payload: SystemMemoryPressurePayload): EpisodePhase {
  return payload.kernelPressureLevel === "critical" ? "critical" : "warning";
}

function envelope(payload: SystemMemoryPressureDelivery) {
  return { name: "system:memory-pressure", payload };
}

function deliver(win: BrowserWindow, wc: WebContents, viewReady: boolean): void {
  if (!openEpisode || win.isDestroyed()) return;
  if (wc.isDestroyed() || notifiedWebContentsIds.has(wc.id)) return;
  // A view still loading drops the send before its preload is listening, so it
  // waits for its own did-finish-load. That event fires before Chromium clears
  // the loading state, so the ready path must not consult the loading state
  // itself. Main frame only: did-finish-load never fires for an iframe or a
  // browser panel's <webview>, so waiting on one of those dropped the notice.
  if (!viewReady && wc.isLoadingMainFrame()) return;
  const fileInbox = filedPhase !== phaseOf(openEpisode);
  try {
    wc.send(
      CHANNELS.EVENTS_PUSH,
      envelope({ ...openEpisode, episodeId: openEpisodeId, fileInbox, launchNoticeShown })
    );
    notifiedWebContentsIds.add(wc.id);
    // A load discards the renderer's copy of the notice, so the latch must not
    // outlive it — both did-finish-load hooks for one load still dedupe,
    // because neither runs before that load has started.
    if (!latchedWebContents.has(wc)) {
      latchedWebContents.add(wc);
      onMainFrameNavigationStart(wc, () => notifiedWebContentsIds.delete(wc.id));
    }
  } catch {
    // Retried on the window's next view load.
  }
}

function deliverToVisibleViews(windows: BrowserWindow[]): void {
  for (const win of windows) {
    if (!win.isDestroyed()) deliver(win, getAppWebContents(win), false);
  }
}

/**
 * Routes a system-memory episode edge (#12462). The opening edge, and each
 * escalation after it (#13529), goes once to each window's visible view — a
 * view that is mid-load, one opened later in the episode, or one that reloaded
 * and lost the notice, gets the latest from
 * {@link deliverOpenSystemMemoryPressure} when it finishes loading. The closing
 * edge reaches every view, cached ones included, so whichever view is showing the notice can clear it.
 */
export function publishSystemMemoryPressure(
  payload: SystemMemoryPressurePayload,
  windows: BrowserWindow[]
): void {
  notifiedWebContentsIds.clear();
  if (payload.status === "normal") {
    const closed = openEpisodeId;
    openEpisode = null;
    openEpisodeId = null;
    filedPhase = null;
    launchNoticeShown = false;
    broadcastToRenderer(
      CHANNELS.EVENTS_PUSH,
      envelope({ ...payload, episodeId: closed, fileInbox: false, launchNoticeShown: false })
    );
    return;
  }
  if (openEpisode === null) {
    openEpisodeId = randomUUID();
    filedPhase = null;
    launchNoticeShown = false;
  }
  openEpisode = payload;
  deliverToVisibleViews(windows);
}

/**
 * A view showed one of the episode's once-only surfaces (#18274). Reports for
 * an episode that has closed, or for a level the episode has since passed, are
 * stale and dropped. A launch bar reaches every view, the visible ones now and
 * cached ones on reveal, so none raises a second.
 */
export function noteSystemMemoryNoticeShown(
  episodeId: string,
  surface: SystemMemoryNoticeSurface,
  windows: BrowserWindow[]
): void {
  if (openEpisode === null || episodeId !== openEpisodeId) return;
  if (surface === "launch-bar") {
    if (launchNoticeShown) return;
    launchNoticeShown = true;
    notifiedWebContentsIds.clear();
    deliverToVisibleViews(windows);
    return;
  }
  const phase: EpisodePhase = surface === "inbox-critical" ? "critical" : "warning";
  if (phase === phaseOf(openEpisode)) filedPhase = phase;
}

/** The episode now open, as last published; null when none is. */
export function getOpenSystemMemoryPressure(): SystemMemoryPressurePayload | null {
  return openEpisode;
}

/** Call from the did-finish-load of a window's visible view. */
export function deliverOpenSystemMemoryPressure(win: BrowserWindow, wc: WebContents): void {
  deliver(win, wc, true);
}

export function resetSystemMemoryPressureDeliveryForTesting(): void {
  openEpisode = null;
  openEpisodeId = null;
  filedPhase = null;
  launchNoticeShown = false;
  notifiedWebContentsIds.clear();
}
