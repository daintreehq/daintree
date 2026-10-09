import type { CanopyReadMark } from "../../../shared/types/ipc/canopy.js";

/**
 * How long a state the agent moved into must last before it counts: a start
 * that is gone again in under this is output flickering the observed state,
 * not the agent taking up work.
 */
export const CANOPY_TURN_HOLD_MS = 3_000;
/**
 * How long a terminal must stay in front of the user before what it shows
 * counts as read: arrowing down the list, or switching through panes, reads
 * nothing on the way.
 */
export const CANOPY_READ_DWELL_MS = 1_500;
/**
 * A start this soon after the user sent the terminal something is their own
 * doing — it says nothing they haven't seen, any more than a sent reply makes
 * a mail thread unread.
 */
export const CANOPY_OWN_START_MS = 10_000;
/**
 * A look not told again for this long has ended, whether or not its ending
 * was ever heard: a view reports each look it keeps once a minute, and a lost
 * report must never leave a run read as watched for good.
 */
export const CANOPY_LOOK_LEASE_MS = 150_000;

/**
 * Whether the user has seen what a run has done. Each thing an agent does that
 * would be news to someone looking away is one turn: a stop the screen backs
 * up, a start nobody here sent it, a new ask. The run is unread while it has
 * turns the user has not read, or when they marked it unread themselves.
 *
 * Driven by what Daintree observed and what the screen showed, never by the
 * readers' words: a re-reading, a redraw or a resize is no turn.
 */
export interface ReadTrack {
  turn: number;
  /** The turn the user has read through. */
  readTurn: number;
  /** When the user marked it unread; a look that began before then reads nothing. Null when not. */
  markedUnreadAt: number | null;
  /** Bumped by every change to what is read, so an undo can tell nothing has changed since. */
  version: number;
  /** Busy or stopped, as of the last turn; null before the run was first observed. */
  busy: boolean | null;
  /** The screen when the last turn was taken: a state change with the screen unmoved is a flicker. */
  hash: string | null;
  /** The ask the last turn is about, normalised; null when none was read. */
  ask: string | null;
  /**
   * Daintree saw the run at work, for longer than a flicker, since the last
   * turn — work that started and ended between two reads of its screen, which
   * see it stopped both times.
   */
  sawWork: boolean;
  /** When the fleet last showed the run starting work; null while it shows it stopped. */
  busySince: number | null;
  /** When the user last sent the run something; null when not. */
  userSentAt: number | null;
  /**
   * What is showing the run to the user now: one key per view and per place in
   * it — its grid pane, its Canopy panel — so one ending a look never ends the
   * other's. `since` is when the look began, `renewedAt` when it was last told.
   */
  lookers: Map<string, { since: number; renewedAt: number }>;
}

export function newReadTrack(): ReadTrack {
  return {
    turn: 0,
    readTurn: 0,
    markedUnreadAt: null,
    version: 0,
    busy: null,
    hash: null,
    ask: null,
    sawWork: false,
    busySince: null,
    userSentAt: null,
    lookers: new Map(),
  };
}

export function isUnread(track: ReadTrack): boolean {
  return track.markedUnreadAt !== null || track.readTurn < track.turn;
}

/**
 * When the longest look still going began, of the looks that may read the run:
 * one begun before the user marked it unread may not. Null when there is none.
 * Looks not renewed within the lease are dropped as ended.
 */
export function lookingSince(track: ReadTrack, now: number): number | null {
  let earliest: number | null = null;
  for (const [looker, look] of track.lookers) {
    if (now - look.renewedAt > CANOPY_LOOK_LEASE_MS) {
      track.lookers.delete(looker);
      continue;
    }
    if (track.markedUnreadAt !== null && look.since <= track.markedUnreadAt) continue;
    if (earliest === null || look.since < earliest) earliest = look.since;
  }
  return earliest;
}

/** Someone has had the run in front of them long enough for what it shows to count as read. */
export function isWatched(track: ReadTrack, now: number): boolean {
  const since = lookingSince(track, now);
  return since !== null && now - since >= CANOPY_READ_DWELL_MS;
}

/** What Daintree and the screen show of the run at one read. */
export interface TurnObservation {
  busy: boolean;
  /** The agent's observed state, for telling a run stopped on something from one idle since launch. */
  agentState: string | null;
  /** When the run moved into its observed state; null when unknown. */
  since: number | null;
  /** The screen's hash, as the inbox's own change tracking keeps it. */
  hash: string;
  now: number;
}

export type TurnStep =
  | { kind: "same" }
  | { kind: "moved" }
  /** A change not held long enough yet: look again at `at`. */
  | { kind: "wait"; at: number };

/**
 * Takes one read of the run. A turn is taken when the run went from busy to
 * stopped or back, the screen moved since the last turn, and the new state has
 * lasted `CANOPY_TURN_HOLD_MS` — or when it is stopped on a moved screen after
 * work Daintree saw between reads. A start the user set off is taken already
 * read when the run was read before it; so is any turn taken while someone
 * watches.
 */
export function observeTurn(track: ReadTrack, seen: TurnObservation): TurnStep {
  if (track.busy === null) {
    track.busy = seen.busy;
    track.hash = seen.hash;
    track.sawWork = false;
    // First sight. A run already stopped on something has handed back what
    // nobody here has seen; one at work, or idle since it launched, has not.
    if (!seen.busy && (seen.agentState === "waiting" || seen.agentState === "completed")) {
      advanceTurn(track, seen.now, false);
      return { kind: "moved" };
    }
    return { kind: "same" };
  }
  if (seen.hash === track.hash) return { kind: "same" };
  if (seen.busy === track.busy) {
    // Stopped on both reads, but it worked in between: one stop, the start
    // folded into it.
    if (seen.busy || !track.sawWork) return { kind: "same" };
    track.hash = seen.hash;
    track.ask = null;
    track.sawWork = false;
    advanceTurn(track, seen.now, false);
    return { kind: "moved" };
  }
  if (seen.since !== null && seen.now - seen.since < CANOPY_TURN_HOLD_MS) {
    return { kind: "wait", at: seen.since + CANOPY_TURN_HOLD_MS };
  }
  track.busy = seen.busy;
  track.hash = seen.hash;
  track.ask = null;
  track.sawWork = false;
  const own =
    seen.busy &&
    track.userSentAt !== null &&
    (seen.since ?? seen.now) - track.userSentAt <= CANOPY_OWN_START_MS &&
    (seen.since ?? seen.now) >= track.userSentAt - CANOPY_TURN_HOLD_MS;
  advanceTurn(track, seen.now, own);
  return { kind: "moved" };
}

/**
 * What the fleet showed of the run, between reads of its screen: work begun,
 * or ended. Work that lasted past the hold is remembered, so a stop read on a
 * moved screen counts even when no read saw it at work.
 */
export function observeFleet(track: ReadTrack, busy: boolean, at: number): void {
  if (busy) {
    if (track.busySince === null) track.busySince = at;
    return;
  }
  if (track.busySince !== null && at - track.busySince >= CANOPY_TURN_HOLD_MS) {
    track.sawWork = true;
  }
  track.busySince = null;
}

/**
 * An ask read on a stopped run. On the screen the last turn was taken on, it
 * is that turn's ask. On another screen, a different ask is a turn of its own:
 * a dialog answered and the next drawn in its place, or a question put after
 * a stop already read, with no start Daintree saw in between.
 */
export function observeAsk(track: ReadTrack, ask: string, hash: string, now: number): boolean {
  if (hash === track.hash) {
    track.ask = ask;
    return false;
  }
  if (ask === track.ask) {
    track.hash = hash;
    return false;
  }
  track.ask = ask;
  track.hash = hash;
  advanceTurn(track, now, false);
  return true;
}

/**
 * A new turn. It is unread unless it carries the read along — the user's own
 * doing, on a run they had read — or someone is watching it as it happens.
 */
export function advanceTurn(track: ReadTrack, now: number, carryRead: boolean): void {
  const wasRead = track.readTurn >= track.turn;
  track.turn++;
  track.version++;
  if ((carryRead && wasRead) || isWatched(track, now)) {
    track.readTurn = track.turn;
  }
}

/**
 * The user read the run. A look (`lookedSince`) that began before they marked
 * it unread reads nothing: they marked it while looking at it. Never reads
 * past the turn they were shown (`throughTurn`), so a read sent before a newer
 * turn landed leaves that turn unread.
 */
export function markRead(
  track: ReadTrack,
  options: { throughTurn?: number; lookedSince?: number } = {}
): boolean {
  if (
    options.lookedSince !== undefined &&
    track.markedUnreadAt !== null &&
    options.lookedSince <= track.markedUnreadAt
  ) {
    return false;
  }
  const through = Math.min(options.throughTurn ?? track.turn, track.turn);
  const next = Math.max(track.readTurn, through);
  const clearsMark =
    track.markedUnreadAt !== null && (options.throughTurn === undefined || through === track.turn);
  if (next === track.readTurn && !clearsMark) return false;
  track.readTurn = next;
  if (clearsMark) track.markedUnreadAt = null;
  track.version++;
  return true;
}

export function markUnread(track: ReadTrack, now: number): void {
  track.markedUnreadAt = now;
  track.version++;
}

/**
 * Puts back what the user had before an action they took back — but only
 * while nothing has changed since that action (`expectVersion`, the version
 * it left): a new turn, or a read or mark from another view, stands.
 */
export function restoreRead(
  track: ReadTrack,
  mark: CanopyReadMark,
  expectVersion: number
): boolean {
  if (track.version !== expectVersion || track.turn !== mark.turn) return false;
  track.readTurn = Math.min(mark.readTurn, track.turn);
  track.markedUnreadAt = mark.markedUnreadAt;
  track.version++;
  return true;
}

/**
 * A view started or stopped showing the run to the user, or told again that it
 * still is. Returns when the look will have lasted long enough to read it, for
 * a look that just began; and when an ending look began, if it lasted that long.
 */
export function look(
  track: ReadTrack,
  looker: string,
  looking: boolean,
  now: number
): { readsAt: number | null; ended: number | null } {
  const held = track.lookers.get(looker);
  const current = held !== undefined && now - held.renewedAt <= CANOPY_LOOK_LEASE_MS ? held : null;
  if (looking) {
    if (current !== null) {
      current.renewedAt = now;
      return { readsAt: null, ended: null };
    }
    track.lookers.set(looker, { since: now, renewedAt: now });
    return { readsAt: now + CANOPY_READ_DWELL_MS, ended: null };
  }
  if (held === undefined) return { readsAt: null, ended: null };
  track.lookers.delete(looker);
  if (current === null) return { readsAt: null, ended: null };
  return {
    readsAt: null,
    ended: now - current.since >= CANOPY_READ_DWELL_MS ? current.since : null,
  };
}

export function readMarkOf(runId: string, spawnedAt: number, track: ReadTrack): CanopyReadMark {
  return {
    runId,
    spawnedAt,
    turn: track.turn,
    readTurn: track.readTurn,
    markedUnreadAt: track.markedUnreadAt,
    version: track.version,
  };
}
