// eager-import-allow: reads/writes store data via sync fs and store.get while migrating the store
import Store from "electron-store";
import type { StoreSchema } from "../store.js";
import { invalidateStoreValueCache, tightenFilePermissions } from "../store.js";
import fs from "fs";
import { z } from "zod";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { getCurrentDiskSpaceStatus } from "./DiskSpaceMonitor.js";

export const LATEST_SCHEMA_VERSION = 27;

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

type StoreRecord = Record<string, unknown>;

function cloneStoreValue<T>(value: T): T {
  return typeof value === "object" && value !== null ? structuredClone(value) : value;
}

function readStorePath(snapshot: StoreRecord, key: string): unknown {
  let node: unknown = snapshot;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, part)) {
      return undefined;
    }
    node = (node as StoreRecord)[part];
  }
  return node;
}

// conf's `set()` and dot-prop's `setProperty()` both refuse these segments, so
// the buffered facade must refuse them too or it becomes a prototype-pollution
// hole that the direct path does not have.
function hasReservedSegment(parts: string[]): boolean {
  return parts.some(
    (part) => part === "__proto__" || part === "prototype" || part === "constructor"
  );
}

function writeStorePath(snapshot: StoreRecord, key: string, value: unknown): void {
  const parts = key.split(".");
  if (hasReservedSegment(parts)) return;
  let node = snapshot;
  for (const part of parts.slice(0, -1)) {
    const current = node[part];
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      node[part] = {};
    }
    node = node[part] as StoreRecord;
  }
  node[parts.at(-1)!] = cloneStoreValue(value);
}

function deleteStorePath(snapshot: StoreRecord, key: string): void {
  const parts = key.split(".");
  if (hasReservedSegment(parts)) return;
  let node = snapshot;
  for (const part of parts.slice(0, -1)) {
    const current = node[part];
    if (current === null || typeof current !== "object" || Array.isArray(current)) return;
    node = current as StoreRecord;
  }
  delete node[parts.at(-1)!];
}

function bufferedMigrationStore(snapshot: StoreRecord): Store<StoreSchema> {
  const facade = {
    get(key: string, defaultValue?: unknown): unknown {
      const value = readStorePath(snapshot, key);
      return value === undefined ? defaultValue : cloneStoreValue(value);
    },
    has(key: string): boolean {
      return readStorePath(snapshot, key) !== undefined;
    },
    set(key: string, value: unknown): void {
      if (value === undefined) {
        throw new TypeError(`Use delete() to clear migration key "${key}"`);
      }
      writeStorePath(snapshot, key, value);
    },
    delete(key: string): void {
      deleteStorePath(snapshot, key);
    },
  };
  return facade as unknown as Store<StoreSchema>;
}

export class MigrationRunner {
  constructor(
    private store: Store<StoreSchema>,
    private options: MigrationRunnerOptions = {}
  ) {}

  private backupStore(fromVersion: number): string | null {
    // Skip the copy when the volume is already critical — fs.copyFileSync would
    // either fail with ENOSPC or leave a truncated backup. The runMigrations
    // guard short-circuits well before this in practice; keep the check anyway
    // so direct callers (and any future relaxation upstream) stay safe.
    if (getCurrentDiskSpaceStatus().status === "critical") {
      console.warn("[Migrations] Skipping pre-migration backup: disk space is critical");
      return null;
    }
    try {
      const storePath = this.store.path;
      if (!fs.existsSync(storePath)) {
        return null;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${storePath}.backup-v${fromVersion}-${timestamp}`;
      fs.copyFileSync(storePath, backupPath);
      // Pre-migration backups carry the full store including secrets and
      // are never auto-cleaned, so tighten regardless of source mode.
      tightenFilePermissions(backupPath);
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
        // Preserve the failed-migration file owner-only — it carries the
        // post-migration store and lingers for diagnostics.
        tightenFilePermissions(failedStatePath);
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
      // The rename swapped config.json behind electron-store's back — drop
      // the store proxy's value cache so reads reflect the restored file.
      invalidateStoreValueCache();
      // Backups created by older builds may carry 0o644; tighten the
      // restored live config so the rollback never relaxes permissions.
      tightenFilePermissions(storePath);
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
    // Pre-flight disk-space gate. Migrations write the pre-migration backup
    // and may call electron-store's atomic write under the hood; both fail
    // hard on a critical-pressure volume. Throw before the chain starts so the
    // caller can surface the condition instead of partially mutating state.
    if (getCurrentDiskSpaceStatus().status === "critical") {
      throw new Error("Cannot run migrations: disk space is critical");
    }

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
    } else if (getCurrentDiskSpaceStatus().status === "critical") {
      // Disk transitioned to critical between the top-of-method guard and the
      // backup write — backupStore skipped the copy. Don't proceed without a
      // backup on a critical volume; surface the condition before mutating
      // the live store.
      throw new Error("Cannot run migrations: disk space is critical");
    }

    let stage: "loop" | "validate" = "loop";
    let activeMigrationVersion = 0;
    try {
      for (const migration of pending.sort((a, b) => a.version - b.version)) {
        activeMigrationVersion = migration.version;
        console.log(`[Migrations] Applying v${migration.version}: ${migration.description}`);
        // electron-store rewrites the entire JSON document on every set/delete.
        // Buffer one migration's main-store mutations in memory, then persist
        // its data and resume checkpoint together in one atomic write. The
        // per-migration boundary remains crash-safe: a terminated process
        // resumes from the last fully committed version, while sidecar-writing
        // migrations remain idempotent as required by the migration contract.
        // Lightweight test doubles and the in-memory recovery store keep the
        // direct path because they have no whole-file rewrite to remove.
        if (this.store.path !== "" && "store" in this.store) {
          const snapshot = this.store.store as unknown as StoreRecord;
          await migration.up(bufferedMigrationStore(snapshot));
          snapshot._schemaVersion = migration.version;
          this.store.store = snapshot as unknown as StoreSchema;
        } else {
          await migration.up(this.store);
          this.store.set("_schemaVersion", migration.version);
        }
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
