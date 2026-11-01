import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  fitRunWhenClosed,
  isRunWhenClosedOptedIn,
  runWhenClosedIssue,
  scheduleOsJobMachine,
  type ScheduleOsJobContext,
  type ScheduleOsJobKind,
} from "../../../shared/utils/scheduleOsJob.js";
import type { Schedule, ScheduleCadence } from "../../../shared/types/scheduledRuns.js";
import type {
  ScheduleOsJobExclusion,
  ScheduleOsJobStatus,
  SchedulesSnapshot,
} from "../../../shared/types/ipc/schedules.js";

type Cadence = Pick<ScheduleCadence, "cron" | "timeZone">;

export interface ScheduleOsJobObservation {
  /** The job's file exists. */
  installed: boolean;
  /** The file is what these cadences would write, or absent when none would. */
  current: boolean;
  /** launchd (or the platform's equivalent) has it loaded; null when it couldn't say. */
  loaded: boolean | null;
}

/** One platform's OS job, which knows nothing of schedules beyond their cadences. */
export interface ScheduleOsJobAdapter {
  readonly kind: ScheduleOsJobKind;
  /** Why this copy of Daintree can't install the job at all, or null. */
  readonly unavailable: string | null;
  /**
   * Makes the job start Daintree at exactly these cadences' occurrences, and
   * removes it when there are none. With `reload`, reloads it even when it
   * already reads current.
   */
  sync(
    cadences: readonly Cadence[],
    systemTimeZone: string,
    options: { reload: boolean }
  ): Promise<void>;
  observe(cadences: readonly Cadence[], systemTimeZone: string): Promise<ScheduleOsJobObservation>;
}

export interface ScheduleOsJobServiceDeps {
  adapter: ScheduleOsJobAdapter;
  listProjectIds: () => string[];
  listSchedules: (projectId: string) => Promise<SchedulesSnapshot>;
  subscribeSchedules: (listener: (snapshot: SchedulesSnapshot) => void) => () => void;
  context: () => ScheduleOsJobContext;
  readTimeoutMs?: number;
  drainTimeoutMs?: number;
}

const READ_TIMEOUT_MS = 10_000;
/** A quit waits this long for a rewrite under way, so an edit made just before it lands. */
const DRAIN_TIMEOUT_MS = 10_000;

const UNREAD_ERROR =
  "Couldn't read every project's schedules, so the job that starts Daintree was left as it was";

function noZoneError(kind: ScheduleOsJobKind): string {
  return `Couldn't read this ${scheduleOsJobMachine(kind)}'s time zone, so the job that starts Daintree was left as it was`;
}

/** The sender's switched-on, opted-in schedules whose cadences the job can't start. */
export function excludedSchedules(
  schedules: readonly Schedule[],
  context: ScheduleOsJobContext
): ScheduleOsJobExclusion[] {
  return schedules.filter(isRunWhenClosedOptedIn).flatMap((schedule) => {
    const reason = runWhenClosedIssue(schedule.cadence, context);
    return reason === null ? [] : [{ scheduleId: schedule.id, reason }];
  });
}

/**
 * Keeps the machine's one OS job matching every switched-on schedule, in every
 * local project, set to run when Daintree isn't running (#15990, #15991,
 * #15993). It reads each project's schedules once, follows every committed
 * change, and rewrites the job after each, one pass at a time: changes that
 * arrive during a pass are taken by the next, from the newest snapshots.
 *
 * It never treats schedules it couldn't read, or a zone it couldn't read, as
 * none: either would remove a job other schedules rely on, so the job is left
 * as it was and the status says why.
 */
export class ScheduleOsJobService {
  private readonly snapshots = new Map<string, SchedulesSnapshot>();
  private readonly unread = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private started: Promise<void> | null = null;
  private ready = false;
  private loop: Promise<void> | null = null;
  private dirty = false;
  private reloadRequested = false;
  private lastError: string | null = null;
  private disposed = false;

  constructor(private readonly deps: ScheduleOsJobServiceDeps) {}

  /** Reads every project and brings the job up to date. Once only. */
  start(): Promise<void> {
    this.started ??= this.begin();
    return this.started;
  }

  /** The job as it stands once every change already committed has been applied. */
  async status(projectId: string): Promise<ScheduleOsJobStatus> {
    await this.start();
    await this.settled();
    // A project registered since the first reads, with no change since: the
    // job can't have heard of its schedules.
    if (!this.snapshots.has(projectId) && !this.unread.has(projectId)) {
      await this.read([projectId]);
      if (this.snapshots.get(projectId)?.schedules.some(isRunWhenClosedOptedIn)) {
        await this.request(false);
      }
    }
    let status = await this.observe(projectId);
    // A job that drifted since its last pass (the app moved, the file went,
    // the Mac's zone changed) is put right before it's reported.
    if (status.state === "stale" && this.deps.adapter.unavailable === null) {
      await this.request(false);
      status = await this.observe(projectId);
    }
    return status;
  }

  /** Rewrites and reloads the job whether or not it reads current. */
  async repair(projectId: string): Promise<ScheduleOsJobStatus> {
    await this.start();
    await this.request(true);
    return this.observe(projectId);
  }

  /**
   * Stops following changes, and lets what's already owed finish, for a
   * bounded time: a pass under way, the one after it, and a startup still
   * reading, since a change committed during those reads is held but unwritten.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const owed = (async () => {
      await this.started?.catch(() => {});
      await this.settled();
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      owed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.deps.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  private async begin(): Promise<void> {
    if (this.disposed) return;
    // Subscribed first, so a change committed while the first reads are out is kept.
    this.unsubscribe = this.deps.subscribeSchedules((snapshot) => {
      if (this.hold(snapshot) && this.ready) void this.request(false);
    });
    await this.read(this.deps.listProjectIds());
    this.ready = true;
    await this.request(false, true);
  }

  /**
   * The newest snapshot wins: a read that answers late can't put back what a
   * change took. Whether it was held; a read's snapshot asks for no pass of
   * its own, since whoever read it passes next.
   */
  private hold(snapshot: SchedulesSnapshot): boolean {
    const held = this.snapshots.get(snapshot.projectId);
    if (held && held.revision > snapshot.revision) return false;
    this.snapshots.set(snapshot.projectId, snapshot);
    this.unread.delete(snapshot.projectId);
    return true;
  }

  private async read(projectIds: readonly string[]): Promise<void> {
    const timeoutMs = this.deps.readTimeoutMs ?? READ_TIMEOUT_MS;
    await Promise.all(
      projectIds.map(async (projectId) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const snapshot = await Promise.race([
            this.deps.listSchedules(projectId),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
            }),
          ]);
          this.hold(snapshot);
        } catch (error) {
          if (!this.snapshots.has(projectId)) this.unread.add(projectId);
          console.warn(
            `[ScheduleOsJob] Couldn't read the schedules of project ${projectId}: ${formatErrorMessage(error, "unknown error")}`
          );
        } finally {
          clearTimeout(timer);
        }
      })
    );
  }

  private settled(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  /**
   * A pass that takes every change made before it ends. Once disposed, only
   * startup's pass is still owed: a status read or repair still answering
   * starts nothing a quit could cut off halfway.
   */
  private request(reload: boolean, owed = false): Promise<void> {
    if (this.disposed && !owed) return this.settled();
    this.dirty = true;
    if (reload) this.reloadRequested = true;
    this.loop ??= this.run();
    return this.loop;
  }

  private async run(): Promise<void> {
    try {
      while (this.dirty) {
        this.dirty = false;
        const reload = this.reloadRequested;
        this.reloadRequested = false;
        await this.pass(reload);
      }
    } finally {
      // No await between the last check and this, so no request is left behind.
      this.loop = null;
    }
  }

  /** Every project's opted-in schedules, fitted to the one job together. */
  private fit(context: ScheduleOsJobContext) {
    return fitRunWhenClosed(this.snapshots.values(), context);
  }

  private async pass(reload: boolean): Promise<void> {
    const { adapter } = this.deps;
    if (adapter.unavailable !== null) return;
    if (this.unread.size > 0) await this.read([...this.unread]);
    if (this.unread.size > 0) {
      this.lastError = UNREAD_ERROR;
      return;
    }
    const context = this.deps.context();
    if (context.systemTimeZone === null) {
      this.lastError = noZoneError(adapter.kind);
      return;
    }
    try {
      await adapter.sync(this.fit(context).included, context.systemTimeZone, { reload });
      this.lastError = null;
    } catch (error) {
      this.lastError = formatErrorMessage(error, "Couldn't update the job that starts Daintree");
      console.warn(`[ScheduleOsJob] ${this.lastError}`);
    }
  }

  private async observe(projectId: string): Promise<ScheduleOsJobStatus> {
    const { adapter } = this.deps;
    const context = this.deps.context();
    const fit = this.fit(context);
    // In the sender's own order; the job is one for the machine, but no other
    // project's schedules are named to a view.
    const reasons = new Map(
      fit.excluded
        .filter((entry) => entry.projectId === projectId)
        .map((entry) => [entry.scheduleId, entry.reason])
    );
    const excluded = (this.snapshots.get(projectId)?.schedules ?? []).flatMap((schedule) => {
      const reason = reasons.get(schedule.id);
      return reason === undefined ? [] : [{ scheduleId: schedule.id, reason }];
    });
    const base = { context, unavailable: adapter.unavailable, error: this.lastError, excluded };
    if (adapter.unavailable !== null) return { ...base, state: "none", error: null };
    if (context.systemTimeZone === null || this.unread.size > 0) return { ...base, state: "stale" };

    const cadences = fit.included;
    let seen: ScheduleOsJobObservation;
    try {
      seen = await adapter.observe(cadences, context.systemTimeZone);
    } catch (error) {
      return {
        ...base,
        state: "stale",
        error: formatErrorMessage(error, "Couldn't read the job that starts Daintree"),
      };
    }
    const state =
      cadences.length > 0
        ? seen.installed && seen.current && seen.loaded === true
          ? "current"
          : "stale"
        : !seen.installed && seen.loaded !== true
          ? "none"
          : "stale";
    return { ...base, state };
  }
}
