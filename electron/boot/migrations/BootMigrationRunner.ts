import type { BootMigrationState } from "./BootMigrationState.js";
import type { BootMigration, BootMigrationRunResult } from "./types.js";

export interface BootMigrationRunnerOptions {
  migrations: readonly BootMigration[];
  state: BootMigrationState;
  /** If true, the runner skips every migration and returns immediately. */
  isSafeMode?: boolean;
  /** Total-run budget. Exceeding it flips `didExceedBudget` on the result. */
  budgetMs?: number;
  /** Injection seam for tests — defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_BUDGET_MS = 500;

/**
 * Runs the registered boot migrations in array order, persisting each
 * success to the marker before starting the next. A single failure stops
 * the run and rethrows — the failing migration and everything after it stays
 * out of the marker so the next boot retries from that point.
 *
 * Duplicate migration IDs are rejected at construction time because a
 * duplicate would silently skip the second entry once the first is recorded.
 */
export class BootMigrationRunner {
  private readonly migrations: readonly BootMigration[];
  private readonly state: BootMigrationState;
  private readonly isSafeMode: boolean;
  private readonly budgetMs: number;
  private readonly now: () => number;

  constructor(options: BootMigrationRunnerOptions) {
    BootMigrationRunner.assertUniqueIds(options.migrations);
    this.migrations = options.migrations;
    this.state = options.state;
    this.isSafeMode = options.isSafeMode ?? false;
    this.budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
    this.now = options.now ?? Date.now;
  }

  async run(): Promise<BootMigrationRunResult> {
    const start = this.now();

    if (this.isSafeMode) {
      console.warn("[BootMigrations] Safe mode active — skipping all boot migrations");
      return {
        durationMs: this.now() - start,
        didExceedBudget: false,
        applied: [],
        skippedForSafeMode: true,
      };
    }

    const marker = this.state.load();
    const completed = new Set(marker.completed);
    const applied: string[] = [];

    const pending = this.migrations.filter((m) => !completed.has(m.id));
    if (pending.length === 0) {
      return {
        durationMs: this.now() - start,
        didExceedBudget: false,
        applied,
        skippedForSafeMode: false,
      };
    }

    console.log(`[BootMigrations] Running ${pending.length} pending migration(s)`);

    for (const migration of pending) {
      console.log(`[BootMigrations] Applying ${migration.id}: ${migration.description}`);
      try {
        await migration.up();
      } catch (err) {
        console.error(`[BootMigrations] Migration ${migration.id} failed:`, err);
        const durationMs = this.now() - start;
        if (err instanceof Error) {
          throw new Error(`Boot migration ${migration.id} failed: ${err.message}`, { cause: err });
        }
        throw new Error(
          `Boot migration ${migration.id} failed after ${durationMs}ms: ${String(err)}`,
          { cause: err }
        );
      }

      completed.add(migration.id);
      applied.push(migration.id);
      this.state.save(Array.from(completed));
      console.log(`[BootMigrations] Applied ${migration.id}`);
    }

    const durationMs = this.now() - start;
    const didExceedBudget = durationMs > this.budgetMs;
    if (didExceedBudget) {
      console.warn(
        `[BootMigrations] Run exceeded budget: ${durationMs}ms > ${this.budgetMs}ms ` +
          `(applied ${applied.length} migration(s))`
      );
    }

    return { durationMs, didExceedBudget, applied, skippedForSafeMode: false };
  }

  private static assertUniqueIds(migrations: readonly BootMigration[]): void {
    const seen = new Set<string>();
    for (const migration of migrations) {
      if (seen.has(migration.id)) {
        throw new Error(`Duplicate boot migration id: "${migration.id}"`);
      }
      seen.add(migration.id);
    }
  }
}
