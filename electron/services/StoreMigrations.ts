import Store from "electron-store";
import type { StoreSchema } from "../store.js";
import fs from "fs";
import { z } from "zod";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

export const LATEST_SCHEMA_VERSION = 20;

export interface Migration {
  version: number;
  description: string;
  up: (store: Store<StoreSchema>) => void | Promise<void>;
}

export interface MigrationRunnerOptions {
  /**
   * Minimum supported schema version. When set, any stored version below this
   * floor is treated as too old to migrate — the store is cleared and
   * `_schemaVersion` is set to `floorVersion`, skipping all migration functions
   * for this run. Intended as an emergency escape hatch for corrupt or
   * unsupported legacy data; not activated in production.
   */
  floorVersion?: number;
}

/**
 * Thrown by `MigrationRunner.runMigrations` when a migration fails or
 * post-migration validation rejects the resulting state. Carries the path of
 * the pre-migration backup (preserved on disk; may have been used to restore
 * the live store) and the path where the failed-migration state was preserved
 * for diagnostics, both `null` when unavailable.
 */
export class StoreMigrationError extends Error {
  readonly backupPath: string | null;
  readonly failedStatePath: string | null;
  readonly restored: boolean;
  readonly restoreError: Error | null;

  constructor(
    message: string,
    options: {
      backupPath: string | null;
      failedStatePath: string | null;
      restored: boolean;
      restoreError?: Error | null;
      cause?: unknown;
    }
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "StoreMigrationError";
    this.backupPath = options.backupPath;
    this.failedStatePath = options.failedStatePath;
    this.restored = options.restored;
    this.restoreError = options.restoreError ?? null;
  }
}

export function isStoreMigrationError(error: unknown): error is StoreMigrationError {
  return error instanceof StoreMigrationError;
}

/**
 * Narrow shape check applied to the in-memory store after the migration chain
 * completes. Validates only the most critical invariant — `_schemaVersion`
 * must be a non-negative integer — and uses `.passthrough()` so unknown keys
 * are preserved (the parsed output is never written back to disk; this schema
 * is for validation only). Intended as a foundation that can grow alongside a
 * real `StoreSchema` Zod schema if one is added later.
 */
const PostMigrationSanitySchema = z
  .object({
    _schemaVersion: z.number().int().nonnegative(),
  })
  .passthrough();

export class MigrationRunner {
  constructor(
    private store: Store<StoreSchema>,
    private options: MigrationRunnerOptions = {}
  ) {}

  private backupStore(fromVersion: number): string | null {
    try {
      const storePath = this.store.path;
      if (!fs.existsSync(storePath)) {
        return null;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${storePath}.backup-v${fromVersion}-${timestamp}`;
      fs.copyFileSync(storePath, backupPath);
      console.log(`[Migrations] Created backup at ${backupPath}`);
      return backupPath;
    } catch (error) {
      console.warn("[Migrations] Failed to create backup:", error);
      return null;
    }
  }

  /**
   * Two-step rename to restore the pre-migration store: preserve the
   * failed-migration state at `<storePath>.failed-<ts>` for diagnostics, then
   * atomically move the backup over the live store path. Never throws — the
   * outcome (and any diagnostic paths the caller can surface) is reported via
   * the return value so a partial failure still produces an actionable error.
   *
   * On step-2 failure, the preserve file is left in place so the user can
   * recover manually from `failedStatePath` or the still-existing `backupPath`.
   */
  private restoreFromBackup(backupPath: string): {
    restored: boolean;
    failedStatePath: string | null;
    error: Error | null;
  } {
    const storePath = this.store.path;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const failedStatePath = `${storePath}.failed-${timestamp}`;
    let preservedFailedState = false;

    try {
      if (fs.existsSync(storePath)) {
        fs.renameSync(storePath, failedStatePath);
        preservedFailedState = true;
      }
    } catch (preserveError) {
      console.warn(
        "[Migrations] Could not preserve failed migration state for diagnostics:",
        preserveError
      );
    }

    try {
      fs.renameSync(backupPath, storePath);
      console.log(`[Migrations] Restored store from backup ${backupPath}`);
      return {
        restored: true,
        failedStatePath: preservedFailedState ? failedStatePath : null,
        error: null,
      };
    } catch (restoreErr) {
      const error = restoreErr instanceof Error ? restoreErr : new Error(String(restoreErr));
      console.error("[Migrations] Atomic restore (backup -> storePath) failed:", error);
      return {
        restored: false,
        failedStatePath: preservedFailedState ? failedStatePath : null,
        error,
      };
    }
  }

  getCurrentVersion(): number {
    const raw = this.store.get("_schemaVersion", 0);
    const version = Number.isFinite(raw) && Number.isInteger(raw) && raw >= 0 ? raw : 0;
    if (version !== raw) {
      console.warn(`[Migrations] Invalid schema version "${raw}", resetting to 0`);
      this.store.set("_schemaVersion", 0);
    }
    return version;
  }

  async runMigrations(migrations: Migration[]): Promise<void> {
    const current = this.getCurrentVersion();
    const maxKnownVersion = Math.max(...migrations.map((m) => m.version), 0);

    if (current > maxKnownVersion) {
      // Downgrade: on-disk store was written by a newer build than this binary
      // knows. We rely on additive-only schema design — unknown keys are ignored
      // by electron-store (no strict JSON schema), and we preserve the higher
      // _schemaVersion so a later upgrade resumes from the correct point.
      console.warn(
        `[Migrations] Store schema v${current} is ahead of this binary (max known v${maxKnownVersion}). ` +
          `Continuing in compatibility mode — unknown keys will be ignored, _schemaVersion preserved.`
      );
      return;
    }

    const { floorVersion } = this.options;
    if (floorVersion !== undefined) {
      if (!Number.isInteger(floorVersion) || floorVersion < 0) {
        throw new Error(`floorVersion must be a non-negative integer, got ${String(floorVersion)}`);
      }
      if (current < floorVersion) {
        console.warn(
          `[Migrations] Stored schema version (${current}) is below floor (${floorVersion}); ` +
            "resetting store to defaults."
        );
        const backupPath = this.backupStore(current);
        if (backupPath) {
          console.log(`[Migrations] Store backed up before reset: ${backupPath}`);
        }
        this.store.clear();
        this.store.set("_schemaVersion", floorVersion);
        return;
      }
    }

    const pending = migrations.filter((m) => m.version > current);

    if (pending.length === 0) {
      return;
    }

    console.log(`[Migrations] Running ${pending.length} pending migration(s)...`);

    const backupPath = this.backupStore(current);
    if (backupPath) {
      console.log(`[Migrations] Store backed up, can restore from: ${backupPath}`);
    }

    let stage: "loop" | "validate" = "loop";
    let activeMigrationVersion = 0;
    try {
      for (const migration of pending.sort((a, b) => a.version - b.version)) {
        activeMigrationVersion = migration.version;
        console.log(`[Migrations] Applying v${migration.version}: ${migration.description}`);
        await migration.up(this.store);
        this.store.set("_schemaVersion", migration.version);
        console.log(`[Migrations] Applied v${migration.version} successfully`);
      }

      stage = "validate";
      const finalVersion = this.store.get("_schemaVersion");
      const validation = PostMigrationSanitySchema.safeParse({ _schemaVersion: finalVersion });
      if (!validation.success) {
        throw new Error(
          `Post-migration sanity check failed: ${validation.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")}`
        );
      }

      console.log("[Migrations] All migrations completed successfully");
    } catch (error) {
      const innerMessage = formatErrorMessage(error, String(error));
      const errorContext =
        stage === "loop" && activeMigrationVersion > 0
          ? `Migration v${activeMigrationVersion} failed: ${innerMessage}`
          : innerMessage;
      console.error(`[Migrations] ${errorContext}`, error);

      let failedStatePath: string | null = null;
      let restored = false;
      let restoreError: Error | null = null;

      if (backupPath) {
        const result = this.restoreFromBackup(backupPath);
        restored = result.restored;
        failedStatePath = result.failedStatePath;
        restoreError = result.error;
      }

      const suffix = !backupPath
        ? " (no backup was available to restore)"
        : restoreError
          ? ` (auto-restore failed: ${restoreError.message})`
          : "";

      throw new StoreMigrationError(`${errorContext}${suffix}`, {
        backupPath,
        failedStatePath,
        restored,
        restoreError,
        cause: error,
      });
    }
  }
}
