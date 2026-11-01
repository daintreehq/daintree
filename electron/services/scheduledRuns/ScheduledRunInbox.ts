import type { Schedule, ScheduledRun } from "../../../shared/types/scheduledRuns.js";
import type {
  ScheduledRunInboxItem,
  ScheduledRunInboxTake,
} from "../../../shared/types/ipc/scheduledRuns.js";

/**
 * How long a view holds the runs it took before another view may take them
 * too. A view puts its runs in the inbox and answers within moments; one that
 * goes quiet for this long has most likely died with them unwritten.
 */
export const SCHEDULED_RUN_INBOX_LEASE_MS = 60_000;

export interface ScheduledRunInboxDeps {
  readonly recorder: () => Promise<{
    listInboxPending(): ScheduledRun[];
    clearInboxPending(runIds: readonly string[]): string[];
  } | null>;
  readonly getSchedule: (projectId: string, scheduleId: string) => Promise<Schedule | null>;
  /** Whether the view behind this web contents id can still answer. */
  readonly isLive: (webContentsId: number) => boolean;
  /**
   * Whether it's the view a window has on screen. A view restored in the
   * background, or cached, would file the runs where nobody looks: the view
   * on screen keeps the history it loaded and never reads a sibling's writes.
   */
  readonly isShown: (webContentsId: number) => boolean;
  readonly now?: () => number;
  readonly logWarn?: (message: string, error?: unknown) => void;
}

interface Lease {
  readonly holder: number;
  readonly at: number;
}

/**
 * Hands the runs that settled with no window open to the views that put them
 * in the notification inbox (#15983). The inbox lives in each view's storage,
 * so a run is taken by one view at a time and its mark cleared only once that
 * view says it is written: a view that dies first leaves it for the next.
 */
export class ScheduledRunInbox {
  private readonly leases = new Map<string, Lease>();
  private readonly now: () => number;
  private readonly logWarn: (message: string, error?: unknown) => void;

  constructor(private readonly deps: ScheduledRunInboxDeps) {
    this.now = deps.now ?? Date.now;
    this.logWarn = deps.logWarn ?? console.warn;
  }

  /**
   * The waiting runs no other live view holds, oldest first, each with its
   * schedule's name and zone as they read now, for a view on screen. They are
   * held for `holder` until it answers; asking again (a reloaded view) takes
   * them again. Runs another view holds come with when to ask again.
   */
  async take(holder: number): Promise<ScheduledRunInboxTake> {
    if (!this.deps.isShown(holder)) return { items: [], retryInMs: null };
    const recorder = await this.deps.recorder();
    if (!recorder) return { items: [], retryInMs: null };
    const pending = recorder.listInboxPending();
    const pendingIds = new Set(pending.map((run) => run.id));
    for (const id of this.leases.keys()) {
      if (!pendingIds.has(id)) this.leases.delete(id);
    }
    const at = this.now();
    let retryInMs: number | null = null;
    const taken = pending.filter((run) => {
      const lease = this.leases.get(run.id);
      if (!lease || lease.holder === holder || !this.deps.isLive(lease.holder)) return true;
      const left = lease.at + SCHEDULED_RUN_INBOX_LEASE_MS - at;
      if (left <= 0) return true;
      retryInMs = retryInMs === null ? left : Math.min(retryInMs, left);
      return false;
    });
    // Held before the schedule reads below, so a view asking meanwhile skips them.
    for (const run of taken) this.leases.set(run.id, { holder, at });

    const schedules = new Map<string, ScheduledRunInboxItem["schedule"]>();
    for (const run of taken) {
      if (schedules.has(run.scheduleId)) continue;
      let schedule: Schedule | null = null;
      try {
        schedule = await this.deps.getSchedule(run.projectId, run.scheduleId);
      } catch (error) {
        this.logWarn(
          `[ScheduledRuns] Couldn't read schedule ${run.scheduleId} for the inbox`,
          error
        );
      }
      schedules.set(
        run.scheduleId,
        schedule ? { name: schedule.name, timeZone: schedule.cadence.timeZone } : null
      );
    }
    // A view switched away from while the reads ran would file them where
    // nobody looks: let them go for the view now on screen to take.
    if (!this.deps.isShown(holder)) {
      for (const run of taken) {
        if (this.leases.get(run.id)?.holder === holder) this.leases.delete(run.id);
      }
      return { items: [], retryInMs: null };
    }
    return {
      items: taken.map((run) => ({ run, schedule: schedules.get(run.scheduleId) ?? null })),
      retryInMs,
    };
  }

  /** The view has written these runs to the inbox; returns the ids that were waiting. */
  async ack(runIds: readonly string[]): Promise<string[]> {
    for (const id of runIds) this.leases.delete(id);
    const recorder = await this.deps.recorder();
    return recorder ? recorder.clearInboxPending(runIds) : [];
  }
}
