import { events } from "./events.js";
import type { AgentState } from "../../shared/types/agent.js";
import type { RunHandBackRecord } from "../../shared/types/ipc/fleet.js";
import {
  HAND_BACK_LOOK_LEASE_MS,
  HAND_BACK_MIN_WORK_MS,
  HAND_BACK_SEEN_DWELL_MS,
  isHandBackStop,
  isHandBackUnseen,
} from "../../shared/utils/runHandBack.js";

const BUSY_STATES: ReadonlySet<AgentState> = new Set(["working", "directing"]);

/**
 * Cardinality bound on tracked runs. The fleet prunes departed terminals on
 * every healthy read; this only stops a hostile renderer's looks at made-up ids
 * from growing the map between those reads.
 */
export const MAX_TRACKED_RUNS = 1_000;

interface RunTrack {
  /** The agent session in the PTY this track is about; a new one starts the run afresh. */
  incarnation: number | undefined;
  /** When anything was last observed of the run, so a fleet read begun before it cannot prune it. */
  touchedAt: number;
  /** When the busy stint Daintree is watching began; null while stopped or never seen working. */
  workSince: number | null;
  record: RunHandBackRecord | null;
  /**
   * The record a `completed` stop just replaced, kept until the next state says
   * whether the stop stands: a specific wait straight after is the agent
   * asking, not handing back, and puts this one back.
   */
  replaced: RunHandBackRecord | null | undefined;
  /** Each view showing the run now: when its look began, and when it was last told. */
  lookers: Map<string, { since: number; renewedAt: number }>;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface RunHandBackDeps {
  now?: () => number;
  /** True while graceful shutdown kills every terminal; nothing it does is a hand-back. */
  isQuitting?: () => boolean;
}

/**
 * Whether each run handed back work the user hasn't seen.
 *
 * A hand-back is a stop — `completed`, or `waiting` for no more specific reason
 * than a prompt — after a busy stint Daintree watched for at least
 * `HAND_BACK_MIN_WORK_MS`. Only the stint's start is watched for, so a run first
 * seen already stopped (every run after a restart, every restored session) has
 * none: nobody here saw that work happen. The `completed` → `waiting` slide is
 * one stop, not two, and an approval, question or error wait is never one.
 * Exits and kills land as `exited`/`idle` and make none either; a hand-back
 * already taken survives them.
 *
 * Seen is the run's terminal in front of the user for `HAND_BACK_SEEN_DWELL_MS`
 * after the stop: a look already going when the stop lands still has to last
 * the dwell past it. A user's "mark unread" holds against any look begun before
 * it, so the pane they marked it from doesn't read it straight back.
 *
 * In memory only, and process-wide: project view eviction drops a view's looks,
 * never what was seen. Records are replaced, never mutated, so the fleet's row
 * comparison sees every change.
 */
export class RunHandBackService {
  private tracks = new Map<string, RunTrack>();
  private unsubscribers: Array<() => void> = [];
  private now: () => number;
  private isQuitting: () => boolean;
  private disposed = false;

  constructor(deps: RunHandBackDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.isQuitting = deps.isQuitting ?? (() => false);
    this.unsubscribers.push(
      events.on("agent:state-changed", (payload) => {
        if (!payload.terminalId) return;
        this.observeState(
          payload.terminalId,
          payload.state,
          payload.previousState,
          payload.waitingReason,
          payload.timestamp,
          payload.agentIncarnation
        );
      })
    );
  }

  /**
   * The run's hand-back, if Daintree watched one. A stop from before the
   * terminal last spawned belongs to a process that is gone, and is dropped.
   */
  getRecord(runId: string, spawnedAt?: number): RunHandBackRecord | undefined {
    const track = this.tracks.get(runId);
    if (!track?.record) return undefined;
    if (spawnedAt !== undefined && track.record.stoppedAt < spawnedAt) {
      track.record = null;
      track.replaced = undefined;
      this.clearTimer(track);
      return undefined;
    }
    return track.record;
  }

  /**
   * Forget every run a complete inventory, read from `readStartedAt`, no longer
   * has. A run observed since the read began may simply be newer than it.
   */
  retain(liveRunIds: ReadonlySet<string>, readStartedAt: number): void {
    for (const [runId, track] of this.tracks) {
      if (liveRunIds.has(runId) || track.touchedAt >= readStartedAt) continue;
      this.clearTimer(track);
      this.tracks.delete(runId);
    }
  }

  /**
   * A view started or stopped having the run's terminal in front of the user,
   * or told again that it still does. `viewer` is one key per view.
   */
  noteLook(runId: string, viewer: string, looking: boolean): void {
    if (this.disposed) return;
    const now = this.now();
    let track = this.tracks.get(runId);
    if (!looking) {
      if (!track?.lookers.has(viewer)) return;
      // A look that lasted the dwell reads the run as it ends, even when its
      // timer has not fired yet.
      this.checkSeen(runId, track);
      track.lookers.delete(viewer);
      this.checkSeen(runId, track);
      return;
    }
    if (!track) {
      if (this.tracks.size >= MAX_TRACKED_RUNS) return;
      track = newTrack(now);
      this.tracks.set(runId, track);
    }
    track.touchedAt = now;
    const held = track.lookers.get(viewer);
    if (held !== undefined && now - held.renewedAt <= HAND_BACK_LOOK_LEASE_MS) {
      held.renewedAt = now;
    } else {
      track.lookers.set(viewer, { since: now, renewedAt: now });
    }
    this.checkSeen(runId, track);
  }

  /** A view went away: whatever it showed is no longer in front of anyone. */
  forgetViewer(viewer: string): void {
    for (const [runId, track] of this.tracks) {
      if (!track.lookers.delete(viewer)) continue;
      this.checkSeen(runId, track);
    }
  }

  /**
   * The user read the run's hand-back by hand. False when there is none to
   * read. `fromUser` says it came from a surface of the hand-back's own, so a
   * mirror like Canopy's inbox follows it; one carried over from that mirror
   * leaves it out.
   */
  markRead(runId: string, fromUser = false): boolean {
    if (this.disposed || this.isQuitting()) return false;
    const track = this.tracks.get(runId);
    const record = track?.record;
    if (!track || !record || !isHandBackUnseen(record)) return false;
    track.record = { stoppedAt: record.stoppedAt, seenAt: this.now() };
    this.clearTimer(track);
    this.announce(runId, track.record, fromUser);
    return true;
  }

  /** The user marked the run's hand-back unread again. False when there is none. */
  markUnread(runId: string, fromUser = false): boolean {
    if (this.disposed || this.isQuitting()) return false;
    const track = this.tracks.get(runId);
    const record = track?.record;
    if (!track || !record) return false;
    track.record = { ...record, markedUnreadAt: this.now() };
    this.clearTimer(track);
    this.announce(runId, track.record, fromUser);
    return true;
  }

  private observeState(
    runId: string,
    state: AgentState,
    previousState: AgentState,
    waitingReason: Parameters<typeof isHandBackStop>[1],
    timestamp: number,
    incarnation: number | undefined
  ): void {
    if (this.disposed || this.isQuitting()) return;
    const at = Number.isFinite(timestamp) ? timestamp : this.now();
    let track = this.tracks.get(runId);
    if (track) {
      track.touchedAt = this.now();
      if (
        incarnation !== undefined &&
        track.incarnation !== undefined &&
        incarnation !== track.incarnation
      ) {
        // Another agent in the same terminal: what the last one handed back,
        // and the work it was doing, are not this one's.
        const had = track.record !== null;
        track.record = null;
        track.replaced = undefined;
        track.workSince = null;
        this.clearTimer(track);
        if (had) this.announce(runId, null);
      }
      if (incarnation !== undefined) track.incarnation = incarnation;
    }

    if (BUSY_STATES.has(state)) {
      if (!track) {
        if (this.tracks.size >= MAX_TRACKED_RUNS) return;
        track = newTrack(this.now());
        track.incarnation = incarnation;
        this.tracks.set(runId, track);
      }
      track.replaced = undefined;
      if (track.workSince === null) track.workSince = at;
      return;
    }
    if (!track) return;

    const replaced = track.replaced;
    track.replaced = undefined;
    const workSince = track.workSince;
    track.workSince = null;

    if (state === "waiting" && !isHandBackStop(state, waitingReason)) {
      // The agent finished only to ask something: the stop it just made was not
      // a hand-back, and whatever it replaced stands again.
      if (previousState === "completed" && replaced !== undefined) {
        track.record = replaced;
        this.clearTimer(track);
        this.announce(runId, replaced);
        this.checkSeen(runId, track);
      }
      return;
    }
    if (!isHandBackStop(state, waitingReason)) return;
    if (workSince === null || at - workSince < HAND_BACK_MIN_WORK_MS) return;

    const previous = track.record;
    track.record = { stoppedAt: at };
    if (state === "completed") track.replaced = previous;
    this.clearTimer(track);
    this.announce(runId, track.record);
    this.checkSeen(runId, track);
  }

  /**
   * Reads the hand-back once a look has lasted the dwell past the stop, or arms
   * a timer for when one will have. Looks begun before a "mark unread" do not
   * count; looks not renewed within the lease are dropped as ended.
   */
  private checkSeen(runId: string, track: RunTrack): void {
    this.clearTimer(track);
    const record = track.record;
    if (this.disposed || !record || !isHandBackUnseen(record)) return;
    const now = this.now();
    let since: number | null = null;
    for (const [viewer, look] of track.lookers) {
      if (now - look.renewedAt > HAND_BACK_LOOK_LEASE_MS) {
        track.lookers.delete(viewer);
        continue;
      }
      if (record.markedUnreadAt !== undefined && look.since <= record.markedUnreadAt) continue;
      if (since === null || look.since < since) since = look.since;
    }
    if (since === null) return;
    const due = Math.max(since, record.stoppedAt) + HAND_BACK_SEEN_DWELL_MS;
    if (now >= due) {
      if (this.isQuitting()) return;
      track.record = { stoppedAt: record.stoppedAt, seenAt: now };
      this.announce(runId, track.record);
      return;
    }
    track.timer = setTimeout(() => {
      track.timer = null;
      if (this.tracks.get(runId) === track) this.checkSeen(runId, track);
    }, due - now);
  }

  private clearTimer(track: RunTrack): void {
    if (track.timer === null) return;
    clearTimeout(track.timer);
    track.timer = null;
  }

  private announce(runId: string, record: RunHandBackRecord | null, fromUser = false): void {
    events.emit("terminal:hand-back-changed", {
      id: runId,
      unseen: isHandBackUnseen(record ?? undefined),
      ...(fromUser ? { fromUser: true } : {}),
      timestamp: this.now(),
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    for (const track of this.tracks.values()) this.clearTimer(track);
    this.tracks.clear();
  }
}

function newTrack(now: number): RunTrack {
  return {
    incarnation: undefined,
    touchedAt: now,
    workSince: null,
    record: null,
    replaced: undefined,
    lookers: new Map(),
    timer: null,
  };
}
