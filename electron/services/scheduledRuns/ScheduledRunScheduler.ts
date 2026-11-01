import type {
  ScheduleRunNowOutcome,
  SchedulesSnapshot,
} from "../../../shared/types/ipc/schedules.js";
import type { Schedule, ScheduledRunOrigin } from "../../../shared/types/scheduledRuns.js";
import {
  nextCronOccurrence,
  parseCron,
  previousCronOccurrence,
  type ParsedCron,
} from "../../../shared/utils/cron.js";
import { occurrenceKeyFor } from "../../../shared/utils/scheduledRuns.js";
import type { RegisterScheduledSkipInput } from "./ScheduledRunRecorder.js";

/**
 * The longest the scheduler sleeps between looks at the wall clock. Node's
 * timers run on a monotonic clock that stops while Linux and Windows sleep,
 * and nothing announces a clock or time-zone change, so a due time is never
 * waited for with one long timer.
 */
export const SCHEDULER_TICK_MS = 30_000;
/** An occurrence found this soon after it came due, with nothing missed before it, fires on time. */
export const ON_TIME_GRACE_MS = 60_000;
/** Wall time moving this far from monotonic time between looks is a clock change or a sleep. */
export const CLOCK_DRIFT_MS = 10_000;
/**
 * How long a schedule waits after a launch or skip that recorded nothing, and
 * a project whose schedules couldn't be read, before they're tried again.
 */
export const UNRECORDED_RETRY_MS = 60_000;

/** The parts of the run history the scheduler reads and writes. */
export interface ScheduledRunSchedulerRecorder {
  /** The latest occurrence a run of the schedule was registered for, or null. */
  evaluationPoint(scheduleId: string): number | null;
  registerSkip(input: RegisterScheduledSkipInput): unknown;
}

export interface ScheduledRunSchedulerLaunch {
  readonly projectId: string;
  readonly scheduleId: string;
  readonly origin: ScheduledRunOrigin;
}

export interface ScheduledRunSchedulerDeps {
  /** Every local project; schedules of projects added later arrive through the store's changes. */
  readonly listProjectIds: () => readonly string[];
  readonly projectExists: (projectId: string) => boolean;
  readonly listSchedules: (projectId: string) => Promise<SchedulesSnapshot>;
  readonly subscribeSchedules: (listener: (snapshot: SchedulesSnapshot) => void) => () => void;
  readonly getRecorder: () => Promise<ScheduledRunSchedulerRecorder | null>;
  /** Launches through `launchScheduledRun`, which registers the run at its spawn. */
  readonly launch: (input: ScheduledRunSchedulerLaunch) => Promise<ScheduleRunNowOutcome>;
  /** Cancels this scheduler's launches of a schedule that haven't spawned yet. */
  readonly cancelLaunches: (scheduleId: string) => void;
  readonly newId: () => string;
  readonly isShuttingDown?: () => boolean;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly logInfo?: (message: string) => void;
  readonly logWarn?: (message: string, error?: unknown) => void;
}

type Decision =
  | { readonly kind: "wait"; readonly nextDueAt: number | null }
  | { readonly kind: "launch"; readonly origin: ScheduledRunOrigin }
  | { readonly kind: "skip"; readonly origin: ScheduledRunOrigin };

/**
 * Fires due schedules (#15979). It holds every local project's schedules,
 * follows their changes, and looks at the wall clock at each schedule's next
 * due time, or every {@link SCHEDULER_TICK_MS} at the longest, and at once
 * after a wake, an unlock, or any edit.
 *
 * Each schedule is evaluated from its evaluation point, the latest occurrence
 * a run was registered for, which the history moves in the same transaction
 * as that run's row, or from its timing floor when that's later: when it was
 * switched on or its cadence last changed while Daintree ran, or its last
 * edit as read at startup. An occurrence found while Daintree was watching,
 * within a minute and with none missed before it, launches with trigger
 * `scheduled`. Anything else found in the window (after a quit, a sleep, a
 * clock jump, or while its last launch was in flight) is one missed window: a
 * `catch-up` launch standing for all of it, or one skip under
 * `missedRuns: "skip"`.
 *
 * A schedule has at most one launch in flight, which switching it off
 * cancels. Its occurrence is consumed only when the launcher records the run,
 * launched or refused, so a quit before then leaves it for the next startup.
 */
export class ScheduledRunScheduler {
  private readonly deps: ScheduledRunSchedulerDeps;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly isShuttingDown: () => boolean;
  private readonly logInfo: (message: string) => void;
  private readonly logWarn: (message: string, error?: unknown) => void;
  private readonly projects = new Map<string, SchedulesSnapshot>();
  private readonly launching = new Set<string>();
  /** Monotonic time before which a schedule isn't tried again. */
  private readonly retryAfter = new Map<string, number>();
  private readonly parsed = new Map<string, ParsedCron | null>();
  /** Where each schedule's timing starts, before which nothing counts as missed. */
  private readonly floors = new Map<string, number>();
  /**
   * Schedules whose next evaluation finds what came due while nobody watched
   * them: while their launch was in flight, their project couldn't be read, or
   * a retry was waited out.
   */
  private readonly unwatched = new Set<string>();
  /**
   * Each schedule's timing, renewed when it's switched on or its cadence
   * changes, so a launch from before then can't leave retry or missed state
   * on the schedule as it is now.
   */
  private readonly epochs = new Map<string, number>();
  private nextEpoch = 0;
  /** Projects whose schedules couldn't be read, and when they're read again. */
  private readonly unread = new Set<string>();
  private nextReadAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private disposed = false;
  /**
   * The next pass finds what came due while nobody watched: at startup, after
   * a suspend, or after the wall clock jumped. Nothing it finds is on time.
   */
  private recoverAll = true;
  private passRequested = false;
  private draining: Promise<void> | null = null;
  private lastLook: { readonly wall: number; readonly monotonic: number } | null = null;

  constructor(deps: ScheduledRunSchedulerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.monotonicNow = deps.monotonicNow ?? (() => performance.now());
    this.isShuttingDown = deps.isShuttingDown ?? (() => false);
    this.logInfo = deps.logInfo ?? console.log;
    this.logWarn = deps.logWarn ?? console.warn;
  }

  /** Reads every project's schedules, then evaluates them; the first pass catches up. */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    // Before the reads, so an edit committed while they run isn't lost; the
    // newer of a read and a change wins.
    this.unsubscribe = this.deps.subscribeSchedules((snapshot) => {
      if (this.hold(snapshot)) this.requestPass();
    });
    let projectIds: readonly string[] = [];
    try {
      projectIds = this.deps.listProjectIds();
    } catch (error) {
      this.logWarn("[ScheduledRuns] Couldn't list projects for their schedules:", error);
    }
    this.nextReadAt = this.monotonicNow() + UNRECORDED_RETRY_MS;
    await this.readProjects(projectIds);
    this.requestPass();
  }

  /** What came due while the machine slept is missed, whichever event reports the wake first. */
  suspend(): void {
    this.recoverAll = true;
  }

  resume(): void {
    this.recoverAll = true;
    this.requestPass();
  }

  /** A locked screen keeps running, so nothing is missed; the due times are looked at again. */
  unlock(): void {
    this.requestPass();
  }

  /** Stops every timer and listener; nothing launches or records after it. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearTimer();
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.draining;
  }

  /** Settles once no pass is running or requested. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /**
   * Keeps the newer snapshot of a project; true when it replaced what was held.
   * An empty one is kept too, so a slower read can't put back schedules a
   * removal took away.
   */
  private hold(snapshot: SchedulesSnapshot): boolean {
    const held = this.projects.get(snapshot.projectId);
    if (held && held.revision > snapshot.revision) return false;
    const previous = new Map(held?.schedules.map((schedule) => [schedule.id, schedule]));
    for (const schedule of snapshot.schedules) {
      const before = previous.get(schedule.id);
      previous.delete(schedule.id);
      // Synchronously with the commit, so a launch past its read doesn't spawn.
      if (before?.enabled && !schedule.enabled) this.deps.cancelLaunches(schedule.id);
      if (before && keepsTiming(before, schedule)) {
        if (!this.floors.has(schedule.id)) this.floors.set(schedule.id, before.updatedAt);
        continue;
      }
      this.floors.set(schedule.id, schedule.updatedAt);
      this.epochs.set(schedule.id, ++this.nextEpoch);
      this.unwatched.delete(schedule.id);
      this.retryAfter.delete(schedule.id);
    }
    for (const removed of previous.keys()) {
      this.floors.delete(removed);
      this.epochs.delete(removed);
      this.unwatched.delete(removed);
      this.retryAfter.delete(removed);
    }
    this.projects.set(snapshot.projectId, snapshot);
    return true;
  }

  private async readProjects(projectIds: readonly string[]): Promise<void> {
    await Promise.all(
      projectIds.map(async (projectId) => {
        try {
          const snapshot = await this.deps.listSchedules(projectId);
          const late = this.unread.delete(projectId);
          if (!this.hold(snapshot) || !late) return;
          // What came due while the project couldn't be read was missed.
          for (const schedule of snapshot.schedules) this.unwatched.add(schedule.id);
        } catch (error) {
          this.unread.add(projectId);
          this.logWarn(`[ScheduledRuns] Couldn't read project ${projectId}'s schedules:`, error);
        }
      })
    );
  }

  private requestPass(): void {
    if (this.disposed) return;
    this.passRequested = true;
    this.draining ??= this.drain();
  }

  private async drain(): Promise<void> {
    // A microtask first, so `draining` is set before a pass can ask for another.
    await Promise.resolve();
    try {
      while (this.passRequested && !this.disposed) {
        this.passRequested = false;
        try {
          await this.pass();
        } catch (error) {
          this.logWarn("[ScheduledRuns] A scheduler pass failed:", error);
          this.arm(SCHEDULER_TICK_MS);
        }
      }
    } finally {
      this.draining = null;
    }
  }

  private async pass(): Promise<void> {
    this.clearTimer();
    if (this.isShuttingDown()) return;
    this.noteClock();
    if (this.unread.size > 0 && this.monotonicNow() >= this.nextReadAt) {
      this.nextReadAt = this.monotonicNow() + UNRECORDED_RETRY_MS;
      await this.readProjects([...this.unread]);
      if (this.disposed || this.isShuttingDown()) return;
    }
    if (!this.hasEnabledSchedule()) {
      // No history opened, and no timer unless a project is still to be read:
      // nothing can come due.
      this.recoverAll = false;
      this.unwatched.clear();
      if (this.unread.size > 0) this.arm(SCHEDULER_TICK_MS);
      return;
    }
    const recorder = await this.deps.getRecorder();
    if (this.disposed || this.isShuttingDown()) return;
    if (!recorder) {
      this.arm(SCHEDULER_TICK_MS);
      return;
    }

    const now = this.now();
    const monotonic = this.monotonicNow();
    let nextDueAt: number | null = null;
    for (const [projectId, snapshot] of this.projects) {
      for (const schedule of snapshot.schedules) {
        if (!schedule.enabled || this.launching.has(schedule.id)) continue;
        const retryAt = this.retryAfter.get(schedule.id);
        if (retryAt !== undefined) {
          if (retryAt > monotonic) continue;
          this.retryAfter.delete(schedule.id);
        }
        const unwatched = this.unwatched.delete(schedule.id);
        const recovering = this.recoverAll || unwatched;
        let decision: Decision;
        try {
          decision = this.decide(schedule, recorder.evaluationPoint(schedule.id), now, recovering);
        } catch (error) {
          this.logWarn(`[ScheduledRuns] Couldn't evaluate schedule ${schedule.id}:`, error);
          continue;
        }
        if (decision.kind === "launch") {
          this.launch(projectId, schedule.id, decision.origin);
          continue;
        }
        if (
          decision.kind === "skip" &&
          !this.skip(recorder, projectId, schedule, decision.origin)
        ) {
          continue;
        }
        const due = decision.kind === "wait" ? decision.nextDueAt : this.nextAfter(schedule, now);
        if (due !== null && (nextDueAt === null || due < nextDueAt)) nextDueAt = due;
      }
    }
    // A schedule skipped here needs none of it: one launching, or waiting out
    // a retry, is unwatched when it's next evaluated.
    this.recoverAll = false;
    this.arm(nextDueAt === null ? SCHEDULER_TICK_MS : nextDueAt - now);
  }

  /** What one schedule's window holds at `now`. */
  private decide(
    schedule: Schedule,
    evaluationPoint: number | null,
    now: number,
    recovering: boolean
  ): Decision {
    const cron = this.parse(schedule.cadence.cron);
    if (!cron) return { kind: "wait", nextDueAt: null };
    const { timeZone } = schedule.cadence;
    // Nothing before its timing floor counts as missed. A clock set back past
    // the point waits for it: an occurrence never runs twice.
    const floor = this.floors.get(schedule.id) ?? schedule.updatedAt;
    const after = Math.max(evaluationPoint ?? floor, floor);
    if (after >= now) return { kind: "wait", nextDueAt: nextCronOccurrence(cron, timeZone, after) };
    const latest = previousCronOccurrence(cron, timeZone, now);
    if (latest === null || latest <= after) {
      return { kind: "wait", nextDueAt: nextCronOccurrence(cron, timeZone, now) };
    }
    const occurrence = { dueAt: latest, occurrenceKey: occurrenceKeyFor(latest) };
    const onlyOne = nextCronOccurrence(cron, timeZone, after) === latest;
    if (!recovering && onlyOne && now - latest < ON_TIME_GRACE_MS) {
      return { kind: "launch", origin: { trigger: "scheduled", ...occurrence, coalesced: null } };
    }
    const origin: ScheduledRunOrigin = {
      trigger: "catch-up",
      ...occurrence,
      coalesced: { after, through: now },
    };
    return schedule.policies.missedRuns === "skip"
      ? { kind: "skip", origin }
      : { kind: "launch", origin };
  }

  private nextAfter(schedule: Schedule, at: number): number | null {
    const cron = this.parse(schedule.cadence.cron);
    return cron ? nextCronOccurrence(cron, schedule.cadence.timeZone, at) : null;
  }

  private launch(projectId: string, scheduleId: string, origin: ScheduledRunOrigin): void {
    this.launching.add(scheduleId);
    const epoch = this.epochs.get(scheduleId);
    // A launch from before a switch-off, a cadence change or a removal leaves
    // nothing on the schedule as it is now.
    const current = () => this.epochs.get(scheduleId) === epoch;
    this.logInfo(
      `[ScheduledRuns] Schedule ${scheduleId} is due: ${origin.trigger} for ${origin.occurrenceKey}`
    );
    new Promise<ScheduleRunNowOutcome>((resolve) =>
      resolve(this.deps.launch({ projectId, scheduleId, origin }))
    )
      .then(
        (outcome) => {
          // A run the history recorded, launched or refused, moved the
          // evaluation point. One it couldn't record, and a launch that found
          // the schedule gone, off or unreadable, left the occurrence due.
          if (outcome.status === "failed" && outcome.runId === null) {
            this.logWarn(
              `[ScheduledRuns] Schedule ${scheduleId}'s run couldn't be recorded: ${outcome.message}`
            );
            if (current()) this.deferRetry(scheduleId);
          } else if (outcome.status === "not-found") {
            if (current()) this.deferRetry(scheduleId);
          }
        },
        (error: unknown) => {
          this.logWarn(`[ScheduledRuns] Schedule ${scheduleId}'s launch failed:`, error);
          if (current()) this.deferRetry(scheduleId);
        }
      )
      .finally(() => {
        this.launching.delete(scheduleId);
        // What came due while it launched was missed.
        if (current()) this.unwatched.add(scheduleId);
        this.requestPass();
      });
  }

  /** Records a missed window as skipped; false when it couldn't be. */
  private skip(
    recorder: ScheduledRunSchedulerRecorder,
    projectId: string,
    schedule: Schedule,
    origin: ScheduledRunOrigin
  ): boolean {
    // A project's row goes before its schedules do; a skip written in between
    // would bring back history its removal deleted.
    if (!this.deps.projectExists(projectId)) return false;
    try {
      recorder.registerSkip({
        id: this.deps.newId(),
        scheduleId: schedule.id,
        projectId,
        origin,
        reason: { kind: "missed" },
      });
      this.logInfo(
        `[ScheduledRuns] Schedule ${schedule.id} missed its runs through ${origin.occurrenceKey}; skipped`
      );
      return true;
    } catch (error) {
      this.logWarn(
        `[ScheduledRuns] Couldn't record schedule ${schedule.id}'s skipped runs:`,
        error
      );
      this.deferRetry(schedule.id);
      return false;
    }
  }

  /** Waits a minute before trying the schedule again, and then never calls it on time. */
  private deferRetry(scheduleId: string): void {
    this.retryAfter.set(scheduleId, this.monotonicNow() + UNRECORDED_RETRY_MS);
    this.unwatched.add(scheduleId);
  }

  /** A wall clock that moved apart from monotonic time since the last look jumped, or slept. */
  private noteClock(): void {
    const look = { wall: this.now(), monotonic: this.monotonicNow() };
    const last = this.lastLook;
    this.lastLook = look;
    if (!last) return;
    const drift = look.wall - last.wall - (look.monotonic - last.monotonic);
    if (Math.abs(drift) <= CLOCK_DRIFT_MS) return;
    this.recoverAll = true;
    this.logInfo(
      `[ScheduledRuns] The clock moved ${Math.round(drift / 1000)}s; due times recomputed`
    );
  }

  private hasEnabledSchedule(): boolean {
    for (const snapshot of this.projects.values()) {
      if (snapshot.schedules.some((schedule) => schedule.enabled)) return true;
    }
    return false;
  }

  private parse(expression: string): ParsedCron | null {
    let cron = this.parsed.get(expression);
    if (cron === undefined) {
      const result = parseCron(expression);
      cron = result.ok ? result.cron : null;
      this.parsed.set(expression, cron);
    }
    return cron;
  }

  private arm(delayMs: number): void {
    this.clearTimer();
    if (this.disposed) return;
    const delay = Math.min(Math.max(delayMs, 0), SCHEDULER_TICK_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.requestPass();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

/** An edit that leaves a running schedule's cadence alone keeps the window it found. */
function keepsTiming(before: Schedule, after: Schedule): boolean {
  return (
    before.enabled &&
    after.enabled &&
    before.cadence.cron === after.cadence.cron &&
    before.cadence.timeZone === after.cadence.timeZone
  );
}
