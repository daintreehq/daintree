/**
 * A single forward-only boot-time migration. Runs before `app.whenReady()`
 * and must be safe to re-invoke after a partial failure on a previous boot.
 */
export interface BootMigration {
  /** Stable unique identifier. Recorded in the marker on success. */
  id: string;
  /** Short human-readable description — shown in logs. */
  description: string;
  /** Performs the migration. Throwing aborts the pipeline and preserves the pre-existing marker state. */
  up: () => void | Promise<void>;
}

/** On-disk shape of the `migrations.json` marker file. */
export interface BootMigrationsMarker {
  completed: string[];
}

/** Result of a single `BootMigrationRunner.run()` invocation. */
export interface BootMigrationRunResult {
  /** Total wall-clock time spent inside `run()`, including safe-mode bail. */
  durationMs: number;
  /** True if runtime exceeded the configured budget. */
  didExceedBudget: boolean;
  /** IDs of migrations applied during this run (empty in safe mode or when nothing was pending). */
  applied: string[];
  /** True if the runner skipped migrations because safe mode was active. */
  skippedForSafeMode: boolean;
}
