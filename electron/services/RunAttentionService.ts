import { events } from "./events.js";
import type { AgentState } from "../../shared/types/agent.js";
import {
  MAX_PARK_NOTE_LENGTH,
  type RunParkRecord,
  type RunSnoozeRecord,
} from "../../shared/types/ipc/fleet.js";
import {
  isAgentSnoozeDurationOption,
  resolveAgentSnoozeDuration,
  type AgentSnoozeDurationOption,
} from "../../shared/utils/agentSnoozeDurations.js";

export { MAX_PARK_NOTE_LENGTH };

/**
 * Cardinality bound on the whole park set. Far beyond any real workflow — this
 * exists so a hostile renderer looping `parkRun` with fresh ids cannot grow the
 * persisted store without bound, not to constrain a user. Re-parking an
 * already-parked run never counts against it.
 */
export const MAX_PARKED_RUNS = 200;

/**
 * Parks expire after two weeks — a deliberate product contract, not just
 * orphan hygiene. A park nobody has looked at in fourteen days is stale
 * intent: the note has lost its context and silently honouring it forever
 * would hide a run behind a decision the user no longer remembers making.
 * Enforced at load, which is the only moment the whole set is re-read anyway.
 */
const STALE_PARK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** A loaded `parkedAt` this far past "now" is corrupt, not early. */
const FUTURE_SKEW_MS = 60_000;

/**
 * Cardinality bound on the snooze set, for the same reason parks have one: a
 * hostile renderer looping `snoozeRun` with fresh ids must not grow the
 * persisted store without bound. Expired records are pruned before the check,
 * so ordinary use can never hit it.
 */
export const MAX_SNOOZED_RUNS = 200;

/**
 * An unlimited snooze is cleared by input, not by a clock — but a run that
 * never comes back would otherwise hold its record forever. Fourteen days
 * matches the park TTL: intent nobody has revisited in two weeks is stale, and
 * silently honouring it hides a run behind a decision the user no longer
 * remembers making. Enforced at load, against `snoozedAt`.
 */
const STALE_SNOOZE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const BUSY_STATES: ReadonlySet<AgentState> = new Set(["working", "directing"]);
const READY_STATES: ReadonlySet<AgentState> = new Set(["idle", "waiting", "completed", "exited"]);

export interface RunAttentionPersistence {
  load(): Record<string, RunParkRecord>;
  save(records: Record<string, RunParkRecord>): void;
  /**
   * Snooze records live under their own store key rather than beside parks in
   * one blob. They are written on a different cadence (a snooze is cleared by
   * every stray keystroke), and a single blob would rewrite the whole park set
   * on each of those.
   */
  loadSnoozes?(): Record<string, RunSnoozeRecord>;
  saveSnoozes?(records: Record<string, RunSnoozeRecord>): void;
}

export interface ParkRunOptions {
  note?: string;
  gateRunId?: string;
}

export interface RunAttentionDeps {
  now?: () => number;
  /**
   * True while the app's graceful-shutdown chain is running. The chain kills
   * every project terminal, and each kill lands as a busy→ready edge while
   * this service is still subscribed — without the guard, quitting the app
   * released every gated park and persisted the release, which is the exact
   * opposite of intent that survives a restart.
   */
  isQuitting?: () => boolean;
}

/**
 * Trim, cap and tidy a note. Returns undefined when nothing usable remains.
 * The cap is UTF-16 code units; a slice landing inside a surrogate pair drops
 * the orphaned half rather than persisting a malformed string.
 */
function normalizeNote(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let note = value.trim().slice(0, MAX_PARK_NOTE_LENGTH);
  const last = note.charCodeAt(note.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) note = note.slice(0, -1);
  return note.length > 0 ? note : undefined;
}

/**
 * Whether a snooze has lapsed. An absent `snoozedUntil` is the unlimited
 * option, which no clock can expire — only typed input ends it.
 */
function isSnoozeExpired(record: RunSnoozeRecord, now: number): boolean {
  return record.snoozedUntil !== undefined && record.snoozedUntil <= now;
}

/**
 * The user's attention decisions about runs, starting with parking.
 *
 * Agent state says what a run is doing; this service records what the user
 * decided about it. The two are deliberately separate: parking must never feed
 * back into the FSM, and the FSM must never clear a park except through the one
 * documented release path below.
 *
 * Release semantics are edge-triggered AND time-fenced: a park gated on
 * terminal B lifts when B transitions busy → ready (`working`/`directing` →
 * `idle`/`waiting`/`completed`/`exited`) with an event timestamp strictly
 * after the park was created. The edge requirement makes the common flow work
 * without a race — "park A until B is free" is usually said while B is
 * waiting, just before handing B the work whose completion the park is about.
 * The time fence closes the other half of that race: a busy→ready edge that
 * happened before the park but was still crossing from the pty-host must not
 * count as the gate "next" coming free, and neither may a stale edge from an
 * earlier process incarnation under the same terminal id. The corollary is
 * honest and documented: if the gate never runs again, the park holds until
 * lifted by hand (or the 14-day expiry).
 *
 * Ready is `idle | waiting`, the codebase's own automation-safe readiness
 * predicate (`waitUntilIdle`, the command queue), plus the terminal states.
 * `completed` alone would be wrong: completion is pattern-detected and most
 * agents end a stint in `waiting`, never `completed`.
 *
 * A gate that is trashed releases its parks too ("gate-closed") — a park that
 * can no longer release must resurface, not hide its run forever. The parked
 * run's OWN trashing does not unpark it: trash is restorable, and restoring a
 * run should restore the intent recorded against it.
 *
 * Every mutation commits in one order — apply, persist, then announce — and a
 * persistence failure rolls the memory state back and suppresses the events,
 * so no surface is ever told about a change that would not survive a restart.
 */
export class RunAttentionService {
  private records = new Map<string, RunParkRecord>();
  private snoozeRecords = new Map<string, RunSnoozeRecord>();
  private unsubscribers: Array<() => void> = [];
  private now: () => number;
  private isQuitting: () => boolean;

  constructor(
    private persistence: RunAttentionPersistence,
    deps: RunAttentionDeps = {}
  ) {
    this.now = deps.now ?? Date.now;
    this.isQuitting = deps.isQuitting ?? (() => false);
    this.loadAndPrune();
    this.loadAndPruneSnoozes();

    this.unsubscribers.push(
      events.on("agent:state-changed", (payload) => {
        const terminalId = payload.terminalId;
        if (!terminalId) return;
        // Typed input is the primary way a snooze ends. On a snoozed run that
        // is waiting/idle/completed, the input event transitions it to
        // `working`, so the clear rides this event.
        if (payload.trigger === "input") this.clearSnoozeOnInput(terminalId);
        if (!READY_STATES.has(payload.state)) return;
        if (!BUSY_STATES.has(payload.previousState)) return;
        this.releaseGatedOn(terminalId, "gate-ready", payload.timestamp);
      })
    );

    // The other half of the input contract. Typing into a run that is ALREADY
    // `working` produces no transition, and `AgentStateService` drops same-state
    // updates without emitting `agent:state-changed` — so without this
    // subscription, snoozing a working agent and then typing at it would leave
    // the snooze in place. The dropped-transition event crosses the pty-host
    // bridge carrying the same normalized trigger, which is exactly the signal
    // needed and costs no new wire plumbing.
    this.unsubscribers.push(
      events.on("agent:state-transition-dropped", (payload) => {
        if (payload.trigger !== "input") return;
        const terminalId = payload.terminalId;
        if (!terminalId) return;
        this.clearSnoozeOnInput(terminalId);
      })
    );

    this.unsubscribers.push(
      events.on("terminal:trashed", (payload) => {
        this.releaseGatedOn(payload.id, "gate-closed");
      })
    );
  }

  getParkRecord(runId: string): RunParkRecord | undefined {
    return this.records.get(runId);
  }

  getAll(): ReadonlyMap<string, RunParkRecord> {
    return this.records;
  }

  /**
   * Park a run. Re-parking replaces the record wholesale — a new note or a new
   * gate is a new decision, so `parkedAt` restarts too.
   *
   * Trusts the caller to have checked the ids against the live fleet — the IPC
   * handler validates both against the current snapshot. This layer enforces
   * only what it can know by itself: shape, the self-gate rule, and the bound.
   */
  park(runId: string, options: ParkRunOptions = {}): RunParkRecord {
    if (this.isQuitting()) {
      throw new Error("Cannot park a run while the app is shutting down");
    }
    if (typeof runId !== "string" || runId.length === 0) {
      throw new Error("Cannot park a run without a terminal id");
    }
    const gateRunId =
      typeof options.gateRunId === "string" && options.gateRunId.length > 0
        ? options.gateRunId
        : undefined;
    if (gateRunId === runId) {
      throw new Error("A run cannot gate its own park");
    }
    if (!this.records.has(runId) && this.records.size >= MAX_PARKED_RUNS) {
      throw new Error(`Cannot park more than ${MAX_PARKED_RUNS} runs`);
    }
    const note = normalizeNote(options.note);

    const record: RunParkRecord = {
      parkedAt: this.now(),
      ...(note !== undefined ? { note } : {}),
      ...(gateRunId !== undefined ? { gateRunId } : {}),
    };

    const previous = this.records.get(runId);
    this.records.set(runId, record);
    try {
      this.persist();
    } catch (error) {
      // The park would not survive a restart, so it must not exist now either:
      // reporting success for a non-durable park is the lie this rollback
      // exists to prevent.
      if (previous !== undefined) this.records.set(runId, previous);
      else this.records.delete(runId);
      throw error;
    }
    events.emit("terminal:park-changed", { id: runId, parked: true, timestamp: this.now() });
    return record;
  }

  /** Lift a park by hand. Returns false when the run wasn't parked. */
  unpark(runId: string): boolean {
    if (this.isQuitting()) {
      throw new Error("Cannot unpark a run while the app is shutting down");
    }
    const previous = this.records.get(runId);
    if (previous === undefined) return false;
    this.records.delete(runId);
    try {
      this.persist();
    } catch (error) {
      this.records.set(runId, previous);
      throw error;
    }
    events.emit("terminal:park-changed", { id: runId, parked: false, timestamp: this.now() });
    return true;
  }

  /** The snooze record for a run, live or expired. */
  getSnoozeRecord(runId: string): RunSnoozeRecord | undefined {
    return this.snoozeRecords.get(runId);
  }

  /**
   * Every snooze that is still live, expiry resolved against the caller's clock.
   *
   * This is the read every attention surface uses, and it is deliberately pure:
   * expiry is decided here rather than by a timer, so a lapsed snooze needs no
   * event to stop applying — the next read simply stops returning it. That is
   * what makes the feature survive a restart and a machine sleeping through the
   * window without owning a single `setTimeout`.
   *
   * Expired records are left in place rather than swept: this runs on the stats
   * poll, and persisting from a hot read path would turn a query into a disk
   * write every few seconds. They are dropped at load and whenever `snooze()`
   * next writes.
   */
  getActiveSnoozes(now: number = this.now()): ReadonlyMap<string, RunSnoozeRecord> {
    const active = new Map<string, RunSnoozeRecord>();
    for (const [runId, record] of this.snoozeRecords) {
      if (!isSnoozeExpired(record, now)) active.set(runId, record);
    }
    return active;
  }

  /** Whether a run is currently snoozed, expiry resolved against `now`. */
  isSnoozed(runId: string, now: number = this.now()): boolean {
    const record = this.snoozeRecords.get(runId);
    return record !== undefined && !isSnoozeExpired(record, now);
  }

  /**
   * Snooze a run for one of the ladder's durations.
   *
   * Re-snoozing replaces the record wholesale — a new duration is a new
   * decision, so `snoozedAt` restarts too. Snoozing does NOT touch a park: the
   * two intents are independent records, and clearing a park here would destroy
   * the note that park exists to carry.
   */
  snooze(runId: string, option: AgentSnoozeDurationOption): RunSnoozeRecord {
    if (this.isQuitting()) {
      throw new Error("Cannot snooze a run while the app is shutting down");
    }
    if (typeof runId !== "string" || runId.length === 0) {
      throw new Error("Cannot snooze a run without a terminal id");
    }
    if (!isAgentSnoozeDurationOption(option)) {
      throw new Error("Invalid snooze duration");
    }

    const now = this.now();
    // Sweep lapsed records before the bound so ordinary use can never be locked
    // out by snoozes that stopped applying hours ago.
    for (const [id, record] of this.snoozeRecords) {
      if (isSnoozeExpired(record, now)) this.snoozeRecords.delete(id);
    }
    if (!this.snoozeRecords.has(runId) && this.snoozeRecords.size >= MAX_SNOOZED_RUNS) {
      throw new Error(`Cannot snooze more than ${MAX_SNOOZED_RUNS} runs`);
    }

    const snoozedUntil = resolveAgentSnoozeDuration(option, now);
    const record: RunSnoozeRecord = {
      snoozedAt: now,
      ...(snoozedUntil !== undefined ? { snoozedUntil } : {}),
    };

    const previous = this.snoozeRecords.get(runId);
    this.snoozeRecords.set(runId, record);
    try {
      this.persistSnoozes();
    } catch (error) {
      // Same contract as park: a snooze that would not survive a restart must
      // not be reported as taken. Only this run is restored — the sweep above
      // dropped records that had already stopped applying, so leaving them out
      // costs nothing and they are gone from disk at the next successful write.
      if (previous !== undefined) this.snoozeRecords.set(runId, previous);
      else this.snoozeRecords.delete(runId);
      throw error;
    }
    events.emit("terminal:snooze-changed", { id: runId, snoozed: true, timestamp: now });
    return record;
  }

  /** Lift a snooze by hand. Returns false when the run wasn't snoozed. */
  unsnooze(runId: string): boolean {
    if (this.isQuitting()) {
      throw new Error("Cannot unsnooze a run while the app is shutting down");
    }
    const previous = this.snoozeRecords.get(runId);
    if (previous === undefined) return false;
    this.snoozeRecords.delete(runId);
    try {
      this.persistSnoozes();
    } catch (error) {
      this.snoozeRecords.set(runId, previous);
      throw error;
    }
    events.emit("terminal:snooze-changed", { id: runId, snoozed: false, timestamp: this.now() });
    return true;
  }

  /**
   * Clear a snooze because the user typed at the run.
   *
   * The headline promise of the feature: whichever duration was picked, coming
   * back and answering the agent ends the snooze. Deliberately silent when the
   * run isn't snoozed — this fires on every input-triggered transition in the
   * app, so the common case must cost one map lookup and nothing else.
   *
   * Unlike `unsnooze`, this never throws: it is driven by an event, not a user
   * request, and there is nobody to report a failure to. A persistence failure
   * keeps the snooze rather than announcing a clear that would come back after
   * a restart.
   */
  private clearSnoozeOnInput(runId: string): void {
    // The shutdown chain's terminal kills do not carry an `input` trigger, but
    // the guard matches park's: nothing may quietly rewrite intent while
    // persistence is trying to carry it across the restart.
    if (this.isQuitting()) return;
    const previous = this.snoozeRecords.get(runId);
    if (previous === undefined) return;
    this.snoozeRecords.delete(runId);
    try {
      this.persistSnoozes();
    } catch (error) {
      this.snoozeRecords.set(runId, previous);
      console.error(
        "[RunAttentionService] Failed to persist an input clear, keeping snooze:",
        error
      );
      return;
    }
    events.emit("terminal:snooze-changed", { id: runId, snoozed: false, timestamp: this.now() });
  }

  /**
   * Release every park gated on a terminal, in one committed batch.
   *
   * Matches are snapshotted before anything is emitted, so a listener that
   * synchronously re-parks on the same gate cannot be revisited by this pass,
   * and a throwing listener cannot leave the set half-deleted: by the time the
   * first event fires, the whole batch is already applied and persisted. A
   * persistence failure keeps every park in place — announcing a release that
   * would resurrect after restart is worse than releasing late.
   */
  private releaseGatedOn(
    gateRunId: string,
    reason: "gate-ready" | "gate-closed",
    edgeTimestamp?: number
  ): void {
    // The shutdown chain gracefully kills every terminal, and each kill lands
    // here as a busy→ready edge (and later a trash). Releasing on those would
    // wipe every gated park at the exact moment persistence is supposed to be
    // carrying them across the restart.
    if (this.isQuitting()) return;

    const released: Array<[string, RunParkRecord]> = [];
    for (const [runId, record] of this.records) {
      if (record.gateRunId !== gateRunId) continue;
      // Time fence, gate-ready only: the edge must postdate the park. A trash
      // is not fenced — it is delivered once, from the user's own present.
      if (reason === "gate-ready") {
        if (typeof edgeTimestamp !== "number" || !Number.isFinite(edgeTimestamp)) continue;
        if (edgeTimestamp <= record.parkedAt) continue;
      }
      released.push([runId, record]);
    }
    if (released.length === 0) return;

    for (const [runId] of released) this.records.delete(runId);
    try {
      this.persist();
    } catch (error) {
      for (const [runId, record] of released) this.records.set(runId, record);
      console.error(
        "[RunAttentionService] Failed to persist a gate release, keeping parks:",
        error
      );
      return;
    }

    for (const [runId, record] of released) {
      events.emit("terminal:park-released", {
        id: runId,
        gateRunId,
        ...(record.note !== undefined ? { note: record.note } : {}),
        reason,
        timestamp: this.now(),
      });
      events.emit("terminal:park-changed", { id: runId, parked: false, timestamp: this.now() });
    }
  }

  /**
   * Hydrate from disk, treating the stored blob as untrusted: every record is
   * rebuilt field-by-field into a fresh object, and anything malformed —
   * wrong types, a self-gate, a timestamp from the future — is dropped rather
   * than repaired, because a repaired guess would still be presented as the
   * user's own words.
   */
  private loadAndPrune(): void {
    let stored: unknown;
    try {
      stored = this.persistence.load() ?? {};
    } catch (error) {
      console.error("[RunAttentionService] Failed to load park records:", error);
      stored = {};
    }
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) stored = {};

    const now = this.now();
    const cutoff = now - STALE_PARK_TTL_MS;
    let pruned = false;
    for (const [runId, raw] of Object.entries(stored as Record<string, unknown>)) {
      const record = this.rebuildRecord(runId, raw, cutoff, now);
      if (record === null) {
        pruned = true;
        continue;
      }
      this.records.set(runId, record);
    }
    if (pruned) {
      try {
        this.persist();
      } catch (error) {
        console.error("[RunAttentionService] Failed to persist pruned park records:", error);
      }
    }
  }

  private rebuildRecord(
    runId: string,
    raw: unknown,
    cutoff: number,
    now: number
  ): RunParkRecord | null {
    if (typeof runId !== "string" || runId.length === 0) return null;
    if (typeof raw !== "object" || raw === null) return null;
    const candidate = raw as Record<string, unknown>;

    const parkedAt = candidate.parkedAt;
    if (typeof parkedAt !== "number" || !Number.isFinite(parkedAt)) return null;
    if (parkedAt < cutoff || parkedAt > now + FUTURE_SKEW_MS) return null;

    const note = normalizeNote(candidate.note);
    const gateRunId =
      typeof candidate.gateRunId === "string" &&
      candidate.gateRunId.length > 0 &&
      candidate.gateRunId !== runId
        ? candidate.gateRunId
        : undefined;

    return {
      parkedAt,
      ...(note !== undefined ? { note } : {}),
      ...(gateRunId !== undefined ? { gateRunId } : {}),
    };
  }

  /**
   * Hydrate snoozes from disk, treating the blob as untrusted exactly as parks
   * are. Records that already expired are dropped here rather than loaded and
   * filtered forever after — load is the one moment the whole set is re-read,
   * so it is the cheapest place to forget them.
   */
  private loadAndPruneSnoozes(): void {
    if (!this.persistence.loadSnoozes) return;
    let stored: unknown;
    try {
      stored = this.persistence.loadSnoozes() ?? {};
    } catch (error) {
      console.error("[RunAttentionService] Failed to load snooze records:", error);
      stored = {};
    }
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) stored = {};

    const now = this.now();
    const cutoff = now - STALE_SNOOZE_TTL_MS;
    let pruned = false;
    for (const [runId, raw] of Object.entries(stored as Record<string, unknown>)) {
      const record = this.rebuildSnoozeRecord(runId, raw, cutoff, now);
      if (record === null) {
        pruned = true;
        continue;
      }
      this.snoozeRecords.set(runId, record);
    }
    if (pruned) {
      try {
        this.persistSnoozes();
      } catch (error) {
        console.error("[RunAttentionService] Failed to persist pruned snooze records:", error);
      }
    }
  }

  private rebuildSnoozeRecord(
    runId: string,
    raw: unknown,
    cutoff: number,
    now: number
  ): RunSnoozeRecord | null {
    if (typeof runId !== "string" || runId.length === 0) return null;
    if (typeof raw !== "object" || raw === null) return null;
    const candidate = raw as Record<string, unknown>;

    const snoozedAt = candidate.snoozedAt;
    if (typeof snoozedAt !== "number" || !Number.isFinite(snoozedAt)) return null;
    if (snoozedAt < cutoff || snoozedAt > now + FUTURE_SKEW_MS) return null;

    const rawUntil = candidate.snoozedUntil;
    const snoozedUntil =
      typeof rawUntil === "number" && Number.isFinite(rawUntil) ? rawUntil : undefined;
    // A snooze whose wake time has already passed is not intent any more, it is
    // history. Dropping it at load keeps the set from accumulating records that
    // every later read would filter out anyway.
    if (snoozedUntil !== undefined && snoozedUntil <= now) return null;

    return {
      snoozedAt,
      ...(snoozedUntil !== undefined ? { snoozedUntil } : {}),
    };
  }

  private persist(): void {
    this.persistence.save(Object.fromEntries(this.records));
  }

  private persistSnoozes(): void {
    this.persistence.saveSnoozes?.(Object.fromEntries(this.snoozeRecords));
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.records.clear();
    this.snoozeRecords.clear();
  }
}
