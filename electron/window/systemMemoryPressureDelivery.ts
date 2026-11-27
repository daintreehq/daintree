import { randomUUID } from "node:crypto";
import type { BrowserWindow, WebContents } from "electron";
import type {
  SystemMemoryNoticeSurface,
  SystemMemoryPressureDelivery,
  SystemMemoryPressurePayload,
} from "../../shared/types/ipc/system.js";
import type { ClientEndpoint } from "../ipc/endpoint.js";
import { CHANNELS } from "../ipc/channels.js";
import {
  broadcastToRemoteEndpoints,
  broadcastToRenderer,
  sendToWebContents,
} from "../ipc/utils.js";
import { getAllAppWebContents, getAppWebContents } from "./webContentsRegistry.js";

/**
 * Which machine's episode a view shows: null for this one's own monitor, else
 * the id of the remote host its project runs on (#18275).
 */
type Machine = string | null;

/** What a view is bound to, installed by the Remote Hosts boot; every view is this machine's until then. */
export type SystemMemoryPressureRoute = (webContentsId: number) => string | null;

let routeOf: SystemMemoryPressureRoute | null = null;

type EpisodePhase = "warning" | "critical";

interface OpenEpisode {
  payload: SystemMemoryPressurePayload;
  /** This machine's own, or the one its host sent, as the views here claim against it. */
  id: string;
  /**
   * The level whose inbox row a view has claimed. Each project view is its own
   * renderer over one shared inbox, so only the first view to claim a level's
   * row files it and the rest leave it alone: a row the user dismissed in one
   * project then stays dismissed in every other (#18274). A view claims when it
   * handles the delivery, not when Main sends it, so a delivery its renderer
   * replays late can't file a row the user has dismissed since. The first
   * critical publish is a new level, so it still files once (#13529).
   */
  filedPhase: EpisodePhase | null;
  /** An attended view showed the critical toast this episode. */
  criticalToastShown: boolean;
  /** A view raised the launch grid bar this episode. */
  launchNoticeShown: boolean;
}

/** Each machine's open episode: one id per episode, kept through its escalations. */
const openEpisodes = new Map<Machine, OpenEpisode>();
/**
 * The episode each renderer was last sent, and so may still be showing. Keyed
 * by the renderer, not the window: a replaced view carries no notice, and a
 * reloaded one loses its own dedupe latch with its context, so both must be
 * able to receive it again.
 */
const sentByWebContentsId = new Map<
  number,
  { wc: WebContents; payload: SystemMemoryPressurePayload }
>();
/** WebContents already carrying the latch-clearing load listener. */
const latchedWebContents = new WeakSet<WebContents>();
/** Views a refresh skipped while they loaded, retried once loading stops. */
const refreshOwed = new WeakMap<WebContents, BrowserWindow>();

/** Names in a link payload are bounded, so a long one can never make it unsendable. */
const MAX_LINKED_NAME_LENGTH = 200;

/** Sent to a view that just attached: no episode is open, and none recovered in its sight. */
const NO_EPISODE: SystemMemoryPressurePayload = {
  status: "normal",
  swapUsedPercent: null,
  swapKind: "swap",
  fseventsdRssMb: null,
  kernelPressureLevel: null,
  escalated: false,
  workloads: null,
  replay: true,
};

function phaseOf(payload: SystemMemoryPressurePayload): EpisodePhase {
  return payload.kernelPressureLevel === "critical" ? "critical" : "warning";
}

function newEpisode(payload: SystemMemoryPressurePayload, id: string): OpenEpisode {
  return { payload, id, filedPhase: null, criticalToastShown: false, launchNoticeShown: false };
}

function envelope(payload: SystemMemoryPressurePayload | SystemMemoryPressureDelivery) {
  return { name: "system:memory-pressure", payload };
}

/** What a view is handed: the episode it claims against, and whether its level's row is still unfiled. */
function deliveryOf(episode: OpenEpisode): SystemMemoryPressureDelivery {
  return {
    ...episode.payload,
    episodeId: episode.id,
    fileInbox: episode.filedPhase !== phaseOf(episode.payload),
  };
}

/** A recovery, or standing state with nothing open, closing `closedId` if any. */
function closingDelivery(
  payload: SystemMemoryPressurePayload,
  closedId: string | null
): SystemMemoryPressureDelivery {
  return { ...payload, episodeId: closedId, fileInbox: false };
}

function machineOf(wc: WebContents): Machine {
  return routeOf?.(wc.id) ?? null;
}

function machineOfPayload(payload: SystemMemoryPressurePayload): Machine {
  return payload.host?.id ?? null;
}

/** A closed view takes nothing with it, so a long episode would otherwise collect them. */
function forgetDestroyed(): void {
  for (const [id, { wc }] of sentByWebContentsId) {
    if (wc.isDestroyed()) sentByWebContentsId.delete(id);
  }
}

function send(machine: Machine, wc: WebContents, payload: SystemMemoryPressureDelivery): boolean {
  // A host's episode is that host's push, which this Shell is relaying.
  if (machine === null) return sendToWebContents(wc, CHANNELS.EVENTS_PUSH, envelope(payload));
  try {
    wc.send(CHANNELS.EVENTS_PUSH, envelope(payload));
    return true;
  } catch {
    return false;
  }
}

function deliver(
  machine: Machine,
  win: BrowserWindow,
  wc: WebContents,
  episode: OpenEpisode,
  viewReady: boolean
): void {
  if (win.isDestroyed() || wc.isDestroyed()) return;
  if (sentByWebContentsId.get(wc.id)?.payload === episode.payload) return;
  // A view still loading drops the send before its preload is listening, so it
  // waits for its own did-finish-load. That event fires before Chromium clears
  // the loading state, so the ready path must not consult the loading state
  // itself. Main frame only: did-finish-load never fires for an iframe or a
  // browser panel's <webview>, so waiting on one of those dropped the notice.
  if (!viewReady && wc.isLoadingMainFrame()) return;
  // Retried on the window's next view load.
  if (!send(machine, wc, deliveryOf(episode))) return;
  sentByWebContentsId.set(wc.id, { wc, payload: episode.payload });
  // A load discards the renderer's copy of the notice, so the latch goes with
  // the document it was sent to — both did-finish-load hooks for one load still
  // dedupe, because neither runs before that load commits. Cleared on commit,
  // not on navigation start: a navigation that never commits leaves the
  // document, and the notice it shows, in place. Main frame only: a subframe
  // or a browser panel's <webview> loading replaces nothing.
  if (!latchedWebContents.has(wc)) {
    latchedWebContents.add(wc);
    const forget = () => sentByWebContentsId.delete(wc.id);
    wc.on("did-navigate", forget);
    wc.on("did-fail-provisional-load", (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame) forget();
    });
  }
}

function deliverToWindows(machine: Machine, windows: readonly BrowserWindow[]): void {
  const episode = openEpisodes.get(machine);
  if (!episode) return;
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    const wc = getAppWebContents(win);
    if (machineOf(wc) === machine) deliver(machine, win, wc, episode, false);
  }
}

/**
 * As the Shells attached here hear it: one id for the episode, kept through
 * its escalations, and project names bounded. A payload the link refused would
 * mark its views stale, and the resync that follows would replay it again.
 */
function forLink(episode: OpenEpisode): SystemMemoryPressurePayload {
  const { payload } = episode;
  const workloads = payload.workloads && {
    ...payload.workloads,
    projects: payload.workloads.projects.map((project) =>
      project.projectName !== null && project.projectName.length > MAX_LINKED_NAME_LENGTH
        ? { ...project, projectName: `${project.projectName.slice(0, MAX_LINKED_NAME_LENGTH)}…` }
        : project
    ),
  };
  return { ...payload, workloads, episodeId: episode.id };
}

/**
 * Routes one of this machine's episode edges (#12462). The opening edge, and
 * each escalation after it (#13529), goes once to each window's visible view
 * of this machine — a view that is mid-load, one opened later in the episode,
 * or one that reloaded and lost the notice, gets the latest from
 * {@link deliverOpenSystemMemoryPressure} when it finishes loading. The
 * closing edge reaches every view, cached ones included, so whichever view is
 * showing the notice can clear it. Views a Shell attached here describe this
 * machine too, and hear each edge over their link.
 */
export function publishSystemMemoryPressure(
  payload: SystemMemoryPressurePayload,
  windows: BrowserWindow[]
): void {
  forgetDestroyed();
  if (payload.status === "normal") {
    const closed = openEpisodes.get(null)?.id ?? null;
    openEpisodes.delete(null);
    for (const [id, { payload: sent }] of sentByWebContentsId) {
      if (machineOfPayload(sent) === null) sentByWebContentsId.delete(id);
    }
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, envelope(closingDelivery(payload, closed)));
    return;
  }
  const previous = openEpisodes.get(null);
  const episode = previous
    ? Object.assign(previous, { payload })
    : newEpisode(payload, randomUUID());
  openEpisodes.set(null, episode);
  deliverToWindows(null, windows);
  broadcastToRemoteEndpoints(CHANNELS.EVENTS_PUSH, [envelope(forLink(episode))]);
}

/** Brings a view a Shell just attached, or one whose events were dropped, up to date with this machine's episode. */
export function replaySystemMemoryPressureToEndpoint(endpoint: ClientEndpoint): void {
  if (endpoint.kind !== "remote-view" || endpoint.isClosed()) return;
  const open = openEpisodes.get(null);
  try {
    endpoint.send({
      type: "event",
      channel: CHANNELS.EVENTS_PUSH,
      args: [envelope(open ? forLink(open) : closingDelivery(NO_EPISODE, null))],
    });
  } catch {
    // A closing link has no view left to tell.
  }
}

function sameReadings(a: SystemMemoryPressurePayload, b: SystemMemoryPressurePayload): boolean {
  return (
    JSON.stringify({ ...a, replay: undefined }) === JSON.stringify({ ...b, replay: undefined })
  );
}

/**
 * A remote host's episode, as this Shell received it from that host, stamped
 * with the host it describes. It reaches the views bound to that host the way
 * this machine's own reaches its views: once per window, then on load. A host
 * repeats its standing state to each view it attaches, so the same episode
 * with the same readings keeps the payload already delivered rather than
 * announcing it anew.
 */
export function publishHostSystemMemoryPressure(
  hostId: string,
  payload: SystemMemoryPressurePayload,
  windows: readonly BrowserWindow[]
): void {
  forgetDestroyed();
  const previous = openEpisodes.get(hostId);
  if (payload.status !== "normal") {
    // A host too old to name its episodes escalates the one already open.
    const id = payload.episodeId ?? previous?.id ?? randomUUID();
    if (previous && previous.id === id) {
      if (!sameReadings(previous.payload, payload)) previous.payload = payload;
    } else {
      openEpisodes.set(hostId, newEpisode(payload, id));
    }
    deliverToWindows(hostId, windows);
    return;
  }
  const closed = previous?.id ?? null;
  openEpisodes.delete(hostId);
  // A measured recovery reaches every view of the host, as this machine's
  // does; standing state only the views that may still show an episode.
  const silent = payload.replay === true;
  for (const wc of getAllAppWebContents()) {
    if (wc.isDestroyed() || machineOf(wc) !== hostId) continue;
    if (silent && !sentByWebContentsId.has(wc.id)) continue;
    sentByWebContentsId.delete(wc.id);
    send(hostId, wc, closingDelivery(payload, closed));
  }
}

/**
 * A host removed, or re-pointed at another machine under the same id: what it
 * last said describes nothing a view shows, so its notices go quietly.
 */
export function forgetHostSystemMemoryPressure(hostId: string): void {
  if (!openEpisodes.has(hostId)) return;
  publishHostSystemMemoryPressure(hostId, NO_EPISODE, []);
}

/** This machine's episode now open, as last published; null when none is. */
export function getOpenSystemMemoryPressure(): SystemMemoryPressurePayload | null {
  return openEpisodes.get(null)?.payload ?? null;
}

function episodeById(episodeId: string): OpenEpisode | null {
  for (const episode of openEpisodes.values()) if (episode.id === episodeId) return episode;
  return null;
}

/**
 * A view asks to show one of an episode's once-only surfaces (#18274); true
 * means it is the one to show it. Claims are this Shell's whichever machine
 * the episode is on, since every view of it is a renderer here. A claim for an
 * episode that has closed, or for a level the episode has since passed, is
 * stale and refused.
 */
export function claimSystemMemoryNotice(
  episodeId: string,
  surface: SystemMemoryNoticeSurface
): boolean {
  const episode = episodeById(episodeId);
  if (episode === null) return false;
  const phase = phaseOf(episode.payload);
  switch (surface) {
    case "inbox-warning":
    case "inbox-critical": {
      const claimed: EpisodePhase = surface === "inbox-critical" ? "critical" : "warning";
      if (claimed !== phase || episode.filedPhase === phase) return false;
      episode.filedPhase = phase;
      return true;
    }
    case "critical-toast":
      if (phase !== "critical" || episode.criticalToastShown) return false;
      episode.criticalToastShown = true;
      return true;
    case "launch-bar":
      if (episode.launchNoticeShown) return false;
      episode.launchNoticeShown = true;
      return true;
  }
}

/**
 * The claimant couldn't show its toast or bar after all (quiet hours, a mute),
 * so the next view to try may.
 */
export function releaseSystemMemoryNotice(
  episodeId: string,
  surface: SystemMemoryNoticeSurface
): void {
  const episode = episodeById(episodeId);
  if (episode === null) return;
  if (surface === "critical-toast") episode.criticalToastShown = false;
  if (surface === "launch-bar") episode.launchNoticeShown = false;
}

/**
 * Call from the did-finish-load of a window's visible view, when a cached one
 * is revealed or restored, and when its window moves to another machine: it
 * gets the open episode of the machine it shows, and loses a notice from one
 * it no longer does.
 */
export function deliverOpenSystemMemoryPressure(win: BrowserWindow, wc: WebContents): void {
  if (wc.isDestroyed()) return;
  forgetDestroyed();
  const machine = machineOf(wc);
  const episode = openEpisodes.get(machine);
  if (episode) {
    deliver(machine, win, wc, episode, true);
    return;
  }
  // A view with no project follows its window's binding, and can still show
  // the machine it left.
  const shown = sentByWebContentsId.get(wc.id)?.payload;
  if (shown && machineOfPayload(shown) !== machine) {
    sentByWebContentsId.delete(wc.id);
    send(machine, wc, closingDelivery(NO_EPISODE, null));
  }
}

/**
 * For a view that is back on screen, or whose window moved to another machine,
 * rather than one that just finished loading. One still loading is left to its
 * own did-finish-load: a send now could be latched without ever reaching it.
 */
export function refreshSystemMemoryPressure(win: BrowserWindow, wc: WebContents): void {
  if (wc.isDestroyed()) return;
  if (!wc.isLoadingMainFrame()) {
    deliverOpenSystemMemoryPressure(win, wc);
    return;
  }
  // A load that commits brings its own did-finish-load; one that never does
  // leaves the old document, which is owed this refresh once loading stops.
  const owed = refreshOwed.has(wc);
  refreshOwed.set(wc, win);
  if (owed) return;
  wc.once("did-stop-loading", () => {
    const owedWin = refreshOwed.get(wc);
    refreshOwed.delete(wc);
    if (owedWin && !owedWin.isDestroyed()) deliverOpenSystemMemoryPressure(owedWin, wc);
  });
}

/** Installed by the Remote Hosts boot the first time a host is used. */
export function setSystemMemoryPressureRoute(route: SystemMemoryPressureRoute | null): () => void {
  routeOf = route;
  return () => {
    if (routeOf === route) routeOf = null;
  };
}

export function resetSystemMemoryPressureDeliveryForTesting(): void {
  openEpisodes.clear();
  sentByWebContentsId.clear();
  routeOf = null;
}
