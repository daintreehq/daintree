import type Database from "better-sqlite3";
import { ScheduledRunSchema, type ScheduledRun } from "../../../shared/types/scheduledRuns.js";

/** How many runs of one schedule its history keeps. */
export const SCHEDULED_RUN_HISTORY_LIMIT = 100;

/** A second run registered for an occurrence its schedule already has a run for. */
export class ScheduledRunConflictError extends Error {
  constructor(
    readonly scheduleId: string,
    readonly occurrenceKey: string
  ) {
    super(`Schedule ${scheduleId} already has a run for ${occurrenceKey}`);
    this.name = "ScheduledRunConflictError";
  }
}

interface RunRow {
  id: string;
  record: string;
}

/**
 * A run is live while it is open or a process of it was last seen running.
 * Startup reconciliation reads live runs, and retention never drops one: a fact
 * still due for it would have nowhere to land.
 */
function isLive(run: ScheduledRun): boolean {
  return (
    run.settlement.state === "open" ||
    run.process.pty.state === "running" ||
    run.process.agent.state === "running"
  );
}

/** How far a run moves its schedule's evaluation point: the occurrences it stands for. */
function evaluatedThrough(run: ScheduledRun): number | null {
  const { origin } = run;
  if (origin.dueAt === null) return null;
  return origin.coalesced?.through ?? origin.dueAt;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
    error.message.includes("occurrence_key")
  );
}

/**
 * Whether any run waits for the notification inbox, read straight from the
 * table so a view loading with no run waiting never opens the history.
 */
export function hasInboxPendingRun(sqlite: Database.Database): boolean {
  return sqlite.prepare("SELECT 1 FROM scheduled_run_inbox LIMIT 1").pluck().get() !== undefined;
}

/**
 * The `scheduled_runs` table: each row is one validated {@link ScheduledRun}
 * beside the columns its queries read. Synchronous, so a registration has
 * committed before the caller goes on to spawn.
 */
export class ScheduledRunStore {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly logWarn: (message: string, error?: unknown) => void = console.warn
  ) {}

  /** Runs `fn` in one transaction; a throw rolls every write in it back. */
  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }

  /**
   * A run for an occurrence also moves its schedule's evaluation point up to
   * that occurrence, in the same transaction, so neither commits alone.
   * `inboxPending` inserts it already waiting for the notification inbox.
   *
   * @throws {ScheduledRunConflictError} when the occurrence already has a run.
   */
  insert(run: ScheduledRun, options: { inboxPending?: boolean } = {}): void {
    const record = ScheduledRunSchema.parse(run);
    try {
      this.transaction(() => {
        this.sqlite
          .prepare(
            `INSERT INTO scheduled_runs
               (id, project_id, schedule_id, occurrence_key, terminal_id, live, created_at, record)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            record.id,
            record.projectId,
            record.scheduleId,
            record.origin.occurrenceKey,
            record.terminalId,
            isLive(record) ? 1 : 0,
            record.createdAt,
            JSON.stringify(record)
          );
        if (options.inboxPending) this.markInboxPending(record.id, record.createdAt);
        const evaluated = evaluatedThrough(record);
        if (evaluated !== null) {
          this.sqlite
            .prepare(
              `INSERT INTO schedule_evaluation_points (schedule_id, project_id, evaluated_through)
               VALUES (?, ?, ?)
               ON CONFLICT (schedule_id) DO UPDATE
               SET evaluated_through = MAX(evaluated_through, excluded.evaluated_through)`
            )
            .run(record.scheduleId, record.projectId, evaluated);
        }
      });
    } catch (error) {
      if (isUniqueViolation(error) && record.origin.occurrenceKey !== null) {
        throw new ScheduledRunConflictError(record.scheduleId, record.origin.occurrenceKey);
      }
      throw error;
    }
  }

  /**
   * The latest occurrence the schedule has a run for, kept after retention
   * prunes that run: no occurrence at or before it runs again. Null when none
   * has had one.
   */
  evaluationPoint(scheduleId: string): number | null {
    const value = this.sqlite
      .prepare("SELECT evaluated_through FROM schedule_evaluation_points WHERE schedule_id = ?")
      .pluck()
      .get(scheduleId) as number | undefined;
    return value ?? null;
  }

  /**
   * Writes a changed record over its row. A run whose row is gone (its schedule
   * was deleted) stays gone: the update touches nothing and returns false.
   */
  update(run: ScheduledRun): boolean {
    const record = ScheduledRunSchema.parse(run);
    const result = this.sqlite
      .prepare("UPDATE scheduled_runs SET terminal_id = ?, live = ?, record = ? WHERE id = ?")
      .run(record.terminalId, isLive(record) ? 1 : 0, JSON.stringify(record), record.id);
    return result.changes > 0;
  }

  get(id: string): ScheduledRun | null {
    const row = this.sqlite
      .prepare("SELECT id, record FROM scheduled_runs WHERE id = ?")
      .get(id) as RunRow | undefined;
    return row ? this.decode(row) : null;
  }

  findByTerminal(terminalId: string): ScheduledRun[] {
    return this.decodeAll(
      this.sqlite
        .prepare("SELECT id, record FROM scheduled_runs WHERE terminal_id = ? ORDER BY rowid")
        .all(terminalId) as RunRow[]
    );
  }

  listLive(): ScheduledRun[] {
    return this.decodeAll(
      this.sqlite
        .prepare("SELECT id, record FROM scheduled_runs WHERE live = 1 ORDER BY rowid")
        .all() as RunRow[]
    );
  }

  /** Newest first; runs registered in the same millisecond keep their registration order. */
  listByProject(projectId: string): ScheduledRun[] {
    return this.decodeAll(
      this.sqlite
        .prepare(
          "SELECT id, record FROM scheduled_runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC"
        )
        .all(projectId) as RunRow[]
    );
  }

  /** Newest first, as {@link listByProject}. */
  listBySchedule(scheduleId: string): ScheduledRun[] {
    return this.decodeAll(
      this.sqlite
        .prepare(
          "SELECT id, record FROM scheduled_runs WHERE schedule_id = ? ORDER BY created_at DESC, rowid DESC"
        )
        .all(scheduleId) as RunRow[]
    );
  }

  /**
   * Drops the schedule's runs past its newest {@link SCHEDULED_RUN_HISTORY_LIMIT},
   * except live ones, which go once they're over and the next prune runs.
   * Returns how many went.
   */
  prune(scheduleId: string, limit: number = SCHEDULED_RUN_HISTORY_LIMIT): number {
    return this.sqlite
      .prepare(
        `DELETE FROM scheduled_runs
         WHERE schedule_id = @scheduleId AND live = 0 AND id NOT IN (
           SELECT id FROM scheduled_runs WHERE schedule_id = @scheduleId
           ORDER BY created_at DESC, rowid DESC LIMIT @limit
         )`
      )
      .run({ scheduleId, limit }).changes;
  }

  /**
   * Marks a run as waiting for the notification inbox (#15983): it settled
   * with no window open. Rewriting the record leaves the mark alone, and
   * pruning or deleting the run takes it away through the cascade.
   */
  markInboxPending(id: string, at: number = Date.now()): void {
    this.sqlite
      .prepare(
        `INSERT INTO scheduled_run_inbox (run_id, created_at)
         SELECT id, ? FROM scheduled_runs WHERE id = ?
         ON CONFLICT (run_id) DO NOTHING`
      )
      .run(at, id);
  }

  /** Runs waiting for the notification inbox, oldest first. */
  listInboxPending(): ScheduledRun[] {
    return this.decodeAll(
      this.sqlite
        .prepare(
          `SELECT r.id, r.record FROM scheduled_run_inbox i
           JOIN scheduled_runs r ON r.id = i.run_id
           ORDER BY r.created_at, r.rowid`
        )
        .all() as RunRow[]
    );
  }

  /** Clears the inbox mark of these runs; returns the ids that held one. */
  clearInboxPending(ids: readonly string[]): string[] {
    const cleared: string[] = [];
    if (ids.length === 0) return cleared;
    const clear = this.sqlite.prepare("DELETE FROM scheduled_run_inbox WHERE run_id = ?");
    this.transaction(() => {
      for (const id of new Set(ids)) {
        if (clear.run(id).changes > 0) cleared.push(id);
      }
    });
    return cleared;
  }

  /** Returns the projects whose history changed. */
  deleteForSchedule(scheduleId: string): string[] {
    const projectIds = this.sqlite
      .prepare("SELECT DISTINCT project_id FROM scheduled_runs WHERE schedule_id = ?")
      .pluck()
      .all(scheduleId) as string[];
    this.transaction(() => {
      this.sqlite.prepare("DELETE FROM scheduled_runs WHERE schedule_id = ?").run(scheduleId);
      this.sqlite
        .prepare("DELETE FROM schedule_evaluation_points WHERE schedule_id = ?")
        .run(scheduleId);
    });
    return projectIds;
  }

  deleteForProject(projectId: string): number {
    return this.transaction(() => {
      this.sqlite
        .prepare("DELETE FROM schedule_evaluation_points WHERE project_id = ?")
        .run(projectId);
      return this.sqlite.prepare("DELETE FROM scheduled_runs WHERE project_id = ?").run(projectId)
        .changes;
    });
  }

  // A row that no longer parses (hand-edited, or written by a newer build) is
  // skipped rather than failing every read of its project's history.
  private decode(row: RunRow): ScheduledRun | null {
    let value: unknown;
    try {
      value = JSON.parse(row.record);
    } catch (error) {
      this.logWarn(`[ScheduledRuns] Skipping unreadable run ${row.id}`, error);
      return null;
    }
    const parsed = ScheduledRunSchema.safeParse(value);
    if (!parsed.success) {
      this.logWarn(`[ScheduledRuns] Skipping invalid run ${row.id}`, parsed.error.issues[0]);
      return null;
    }
    return parsed.data;
  }

  private decodeAll(rows: RunRow[]): ScheduledRun[] {
    const runs: ScheduledRun[] = [];
    for (const row of rows) {
      const run = this.decode(row);
      if (run) runs.push(run);
    }
    return runs;
  }
}
