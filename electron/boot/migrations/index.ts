import path from "node:path";
import { app } from "electron";
import { BootMigrationRunner, type BootMigrationRunnerOptions } from "./BootMigrationRunner.js";
import { BootMigrationState } from "./BootMigrationState.js";
import type { BootMigration, BootMigrationRunResult } from "./types.js";

export { BootMigrationRunner } from "./BootMigrationRunner.js";
export { BootMigrationState } from "./BootMigrationState.js";
export type { BootMigration, BootMigrationRunResult, BootMigrationsMarker } from "./types.js";

/**
 * Registry of boot migrations applied before `app.whenReady()`.
 *
 * Empty by default — this is infrastructure for future one-shots. The
 * current codebase has no eligible candidates:
 *  - `electron/setup/environment.ts` and `electron/services/projectDirMigration.ts`
 *    are `TODO(0.9.0)` Canopy→Daintree rebrand code, explicitly out of scope
 *    for this pipeline (owned by #5150).
 *  - `electron/services/migrations/*` are electron-store schema migrations,
 *    a complementary system keyed by integer version, not one-shot filesystem
 *    migrations.
 *  - `src/store/agentPreferencesStore.ts` runs in the renderer process
 *    against `localStorage`, which is not reachable before `app.whenReady()`.
 *    It stays in place as a Zustand `merge` hook.
 *
 * New filesystem one-shots that must run before window creation go here.
 */
export const BOOT_MIGRATIONS: readonly BootMigration[] = [];

const MARKER_FILENAME = "migrations.json";

type RunBootMigrationsOptions = Partial<
  Omit<BootMigrationRunnerOptions, "migrations" | "state">
> & {
  /** Override the registered registry — tests only. */
  migrations?: readonly BootMigration[];
  /** Override the marker path — tests only. */
  markerPath?: string;
};

/**
 * Runs all registered boot migrations. Safe to call before `app.whenReady()`.
 * Reads/writes the marker at `path.join(app.getPath('userData'), 'migrations.json')`.
 *
 * Failures propagate to the caller so the bootstrap process can decide
 * whether to continue — currently it logs and continues (forward-only
 * idempotency means the failing migration retries on the next boot).
 */
export async function runBootMigrations(
  options: RunBootMigrationsOptions = {}
): Promise<BootMigrationRunResult> {
  const migrations = options.migrations ?? BOOT_MIGRATIONS;
  const markerPath = options.markerPath ?? path.join(app.getPath("userData"), MARKER_FILENAME);
  const state = new BootMigrationState(markerPath);
  const runner = new BootMigrationRunner({
    migrations,
    state,
    isSafeMode: options.isSafeMode,
    budgetMs: options.budgetMs,
    now: options.now,
  });
  return runner.run();
}
