import { events } from "./events.js";
import type { AgentState } from "../../shared/types/agent.js";
import type { RunHandBackRecord, RunWaitRecord } from "../../shared/types/ipc/fleet.js";
import {
  HAND_BACK_LOOK_LEASE_MS,
  HAND_BACK_MIN_WORK_MS,
  HAND_BACK_SEEN_DWELL_MS,
  isHandBackStop,
  isHandBackUnseen,
  isObservedAskWait,
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
  /** When a state of the run was last heard, so an inventory read begun before it cannot overrule it. */
  stateAt: number | null;
  /** When the busy stint Daintree is watching began; null while stopped or never seen working. */
  workSince: number | null;
  record: RunHandBackRecord | null;
  /**
   * The record a `completed` stop just replaced, kept until the next state says
   * whether the stop stands: a specific wait straight after is the agent
   * asking, not handing back, and puts this one back.
   */
  replaced: RunHandBackRecord | null | undefined;
  /** The approval or question wait of the stop the run is in; null when it has none. */
  wait: RunWaitRecord | null;
  /** Each view showing the run now: when its look began, and when it was last told. */
  lookers: Map<string, { since: number; renewedAt: number }>;
  timer: ReturnType<typeof setTimeout> | null;
  waitTimer: ReturnType<typeof setTimeout> | null;
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
 * Beside each hand-back, and never as one, the approval or question wait the
 * run's current stop includes (`getWait`), seen by the same looks and dwell. A
 * wait needs no watched work: one first seen at startup is still news to
 * whoever looks. The stop's slides between waits, prompts and `completed` keep
 * it; work Daintree watched, an error, an exit or another agent ends it.
 *
 * In memory only, and process-wide: project view eviction drops a view's looks,
 * never what was seen. Records are replaced, never mutated, so the fleet's row
 * comparison sees every change.
 */
export class RunHandBackService {
  private tracks = new Map<string, RunTrack>();
  private unsubscribers: Array<() => void> = [];
  private waitListeners = new Set<() => void>();
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
   * The run's approval or question wait, when its current stop has one. A wait
   * from before the terminal last spawned belongs to a process that is gone.
   */
  getWait(runId: string, spawnedAt?: number): RunWaitRecord | undefined {
    const track = this.tracks.get(runId);
    if (!track?.wait) return undefined;
    if (spawnedAt !== undefined && track.wait.stoppedAt < spawnedAt) {
      this.endWait(track);
      return undefined;
    }
    return track.wait;
  }

  /**
   * A complete inventory, read from `readStartedAt`, shows the run in an
   * approval or question wait since `stoppedAt`. A wait no state was heard
   * for — a run already waiting when main started — begins here; a state heard
   * since the read began is newer than it, and stands.
   */
  noteInventoryWait(runId: string, stoppedAt: number, readStartedAt: number): void {
    if (this.disposed || this.isQuitting()) return;
    let track = this.tracks.get(runId);
    if (track?.wait) return;
    if (track && track.stateAt !== null && track.stateAt >= readStartedAt) return;
    if (!track) {
      if (this.tracks.size >= MAX_TRACKED_RUNS) return;
      track = newTrack(this.now());
      this.tracks.set(runId, track);
    }
    track.wait = { stoppedAt };
    this.checkWaitSeen(runId, track);
  }

  /** Be told each time a run's wait begins, is seen or ends. Returns the unsubscribe. */
  onWaitChanged(listener: () => void): () => void {
    this.waitListeners.add(listener);
    return () => {
      this.waitListeners.delete(listener);
    };
  }

  /** Runs whose hand-back is unseen, as recorded; reading never expires or marks one. */
  listUnseenRunIds(): string[] {
    const ids: string[] = [];
    for (const [runId, track] of this.tracks) {
      if (isHandBackUnseen(track.record ?? undefined)) ids.push(runId);
    }
    return ids;
  }

  /**
   * Forget every run a complete inventory, read from `readStartedAt`, no longer
   * has. A run observed since the read began may simply be newer than it.
   */
  retain(liveRunIds: ReadonlySet<string>, readStartedAt: number): void {
    for (const [runId, track] of this.tracks) {
      if (liveRunIds.has(runId) || track.touchedAt >= readStartedAt) continue;
      this.clearTimer(track);
      this.clearWaitTimer(track);
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
      this.checkLooks(runId, track);
      track.lookers.delete(viewer);
      this.checkLooks(runId, track);
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
    this.checkLooks(runId, track);
  }

  /** A view went away: whatever it showed is no longer in front of anyone. */
  forgetViewer(viewer: string): void {
    for (const [runId, track] of this.tracks) {
      if (!track.lookers.delete(viewer)) continue;
      this.checkLooks(runId, track);
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
      track.stateAt = track.touchedAt;
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
        if (this.endWait(track)) this.announceWait();
      }
      if (incarnation !== undefined) track.incarnation = incarnation;
    }

    if (!track) {
      // Every state heard is tracked, a stop included: a wait is news whether
      // or not any work was watched before it, and a state heard after an
      // inventory read began must be there to overrule that read.
      if (this.tracks.size >= MAX_TRACKED_RUNS) return;
      track = newTrack(this.now());
      track.incarnation = incarnation;
      track.stateAt = track.touchedAt;
      this.tracks.set(runId, track);
    }

    if (BUSY_STATES.has(state)) {
      track.replaced = undefined;
      if (track.workSince === null) track.workSince = at;
      return;
    }

    const replaced = track.replaced;
    track.replaced = undefined;
    const workSince = track.workSince;
    track.workSince = null;
    this.observeWait(runId, track, state, waitingReason, at, workSince);

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
   * The stop's wait as the run's new state leaves it. Work watched past the
   * flicker bar ends the stop it belonged to, and so do an error, an exit or
   * idling; a slide to `completed` or a prompt is the same stop, and one wait
   * after another in it keeps the first's seen mark — without a reading, two
   * asks with no work between can't be told apart.
   */
  private observeWait(
    runId: string,
    track: RunTrack,
    state: AgentState,
    waitingReason: Parameters<typeof isHandBackStop>[1],
    at: number,
    workSince: number | null
  ): void {
    let changed = false;
    if (workSince !== null && at - workSince >= HAND_BACK_MIN_WORK_MS)
      changed = this.endWait(track);
    if (isObservedAskWait(state, waitingReason)) {
      if (track.wait === null) {
        track.wait = { stoppedAt: at };
        changed = true;
      }
    } else if (!isHandBackStop(state, waitingReason)) {
      changed = this.endWait(track) || changed;
    }
    if (!changed) return;
    this.announceWait();
    this.checkWaitSeen(runId, track);
  }

  /** Ends the run's wait, if it has one. True when it had. */
  private endWait(track: RunTrack): boolean {
    this.clearWaitTimer(track);
    if (track.wait === null) return false;
    track.wait = null;
    return true;
  }

  private checkLooks(runId: string, track: RunTrack): void {
    this.checkSeen(runId, track);
    this.checkWaitSeen(runId, track);
  }

  /**
   * When the longest look still going began, of those that may read a record
   * the user marked unread at `markedUnreadAt`. Looks not renewed within the
   * lease are dropped as ended. Null when there is none.
   */
  private lookingSince(track: RunTrack, now: number, markedUnreadAt?: number): number | null {
    let since: number | null = null;
    for (const [viewer, look] of track.lookers) {
      if (now - look.renewedAt > HAND_BACK_LOOK_LEASE_MS) {
        track.lookers.delete(viewer);
        continue;
      }
      if (markedUnreadAt !== undefined && look.since <= markedUnreadAt) continue;
      if (since === null || look.since < since) since = look.since;
    }
    return since;
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
    const since = this.lookingSince(track, now, record.markedUnreadAt);
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

  /** The same for the run's wait: seen once a look has lasted the dwell past its stop. */
  private checkWaitSeen(runId: string, track: RunTrack): void {
    this.clearWaitTimer(track);
    const wait = track.wait;
    if (this.disposed || wait === null || wait.seenAt !== undefined) return;
    const now = this.now();
    const since = this.lookingSince(track, now);
    if (since === null) return;
    const due = Math.max(since, wait.stoppedAt) + HAND_BACK_SEEN_DWELL_MS;
    if (now >= due) {
      if (this.isQuitting()) return;
      track.wait = { stoppedAt: wait.stoppedAt, seenAt: now };
      this.announceWait();
      return;
    }
    track.waitTimer = setTimeout(() => {
      track.waitTimer = null;
      if (this.tracks.get(runId) === track) this.checkWaitSeen(runId, track);
    }, due - now);
  }

  private clearTimer(track: RunTrack): void {
    if (track.timer === null) return;
    clearTimeout(track.timer);
    track.timer = null;
  }

  private clearWaitTimer(track: RunTrack): void {
    if (track.waitTimer === null) return;
    clearTimeout(track.waitTimer);
    track.waitTimer = null;
  }

  private announceWait(): void {
    for (const listener of [...this.waitListeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[RunHandBackService] Wait listener failed:", error);
      }
    }
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
    this.waitListeners.clear();
    for (const track of this.tracks.values()) {
      this.clearTimer(track);
      this.clearWaitTimer(track);
    }
    this.tracks.clear();
  }
}

function newTrack(now: number): RunTrack {
  return {
    incarnation: undefined,
    touchedAt: now,
    stateAt: null,
    workSince: null,
    record: null,
    replaced: undefined,
    wait: null,
    lookers: new Map(),
    timer: null,
    waitTimer: null,
  };
}
