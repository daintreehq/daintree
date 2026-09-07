// eager-import-allow: opens the SQLite store and reads its file synchronously at bootstrap (sync is the storage contract)
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { app } from "electron";
import fs from "node:fs";
import path from "path";
import { getWritesSuppressed } from "../diskPressureState.js";
import { tightenFilePermissionsSync, OWNER_RW_FILE_MODE } from "../../utils/fs.js";
import * as schema from "./schema.js";
import { installSqliteRunStatementCache } from "./sqliteRunStatementCache.js";
import type { DatabaseRecovery } from "../../../shared/types/ipc/app.js";
import type { DbProbeResult } from "./dbWorkerProtocol.js";

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

// Every Daintree SQLite connection is opened from this module, so patching
// better-sqlite3's prototype here — rather than from the declarative schema
// drizzle-kit also loads — keeps the optimisation on the connection path and
// off the migration tooling. Idempotent.
installSqliteRunStatementCache();

let sharedInstance: { sqlite: Database.Database; db: AppDb } | null = null;

export function getDbPath(): string {
  return path.join(app.getPath("userData"), "daintree.db");
}

export function getBackupPath(): string {
  return getDbPath() + ".backup";
}

export function getMigrationsFolder(): string {
  return path.join(app.getAppPath(), "electron/services/persistence/migrations");
}

// better-sqlite3 12.x exposes no file-mode option, so the main daintree.db lands
// at the umask default on creation and must be chmod'd. Bundled SQLite derives
// the -wal/-shm sidecar mode from the main file's mode, so tightening the main
// file BEFORE the WAL journal is enabled makes those sidecars owner-only too;
// we still chmod them here as belt-and-suspenders and to cover any that already
// exist. Best-effort, POSIX-gated, skips missing sidecars. Doubles as the
// retroactive fix for installs that predate this change and hold a 0o644 db.
function tightenDatabaseFilePermissions(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    tightenFilePermissionsSync(dbPath + suffix);
  }
}

export function getSharedDb(): AppDb {
  if (!sharedInstance) {
    const dbPath = getDbPath();
    sharedInstance = openDb(dbPath);
  }
  return sharedInstance.db;
}

export function getSharedSqlite(): Database.Database | null {
  return sharedInstance?.sqlite ?? null;
}

// One-time bootstrap for databases that predate __drizzle_migrations. SQLite has
// no `ALTER TABLE ADD COLUMN IF NOT EXISTS`, and the baseline migration is a
// no-op for tables that already exist — so a legacy DB whose `projects` table
// is missing the columns added in older app versions would never gain them. We
// detect that case here (no migrations table + projects table present) and
// patch up any missing columns before drizzle takes over. After the baseline
// migration is recorded, this function is a fast skip on every subsequent open.
function adoptLegacyProjectColumns(sqlite: Database.Database): void {
  const hasMigrationsTable = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  if (hasMigrationsTable) return;

  const hasProjectsTable = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
    .get();
  if (!hasProjectsTable) return;

  const cols = new Set(
    (sqlite.pragma("table_info(projects)") as { name: string }[]).map((c) => c.name)
  );
  if (!cols.has("pinned")) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.has("frecency_score")) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN frecency_score REAL NOT NULL DEFAULT 3.0");
  }
  if (!cols.has("last_accessed_at")) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0");
  }
}

export function openDb(
  dbPath: string,
  migrationsFolder?: string
): { sqlite: Database.Database; db: AppDb } {
  // Pre-flight disk-space gate. better-sqlite3's constructor creates the file
  // on open; on a critical-pressure volume that leaves a zero-byte database
  // for probeDb to quarantine next boot. Bail before allocating a handle.
  if (getWritesSuppressed()) {
    throw new Error("Cannot open database: disk space is critical");
  }

  // Create a brand-new database owner-only from the very first byte. better-sqlite3
  // creates the file at the umask default (world-readable) on open, so we win the
  // race by pre-creating it with an exclusive 0o600 handle before handing the path
  // to the constructor. Best-effort: EEXIST is the normal existing-DB case, and any
  // other failure (missing parent, permissions) resurfaces from `new Database`
  // below — which stays the authority on open errors — while the post-open chmod
  // still tightens whatever it manages to create. POSIX-only.
  if (process.platform !== "win32") {
    try {
      fs.closeSync(fs.openSync(dbPath, "wx", OWNER_RW_FILE_MODE));
    } catch {
      // Intentionally ignored — see comment above.
    }
  }

  const sqlite = new Database(dbPath);
  try {
    // Tighten the main file up front — before the WAL journal is enabled and
    // before migrations run. This makes an upgrading install's pre-existing
    // 0o644 database owner-only for the whole migration, and lets SQLite create
    // the -wal/-shm sidecars from the (now 0o600) main file's mode.
    tightenDatabaseFilePermissions(dbPath);

    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("busy_timeout = 3000");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("temp_store = MEMORY");
    sqlite.pragma("mmap_size = 10737418240");
    sqlite.pragma("cache_size = -65536");
    sqlite.pragma("journal_size_limit = 5242880");
    sqlite.pragma("foreign_keys = ON");

    adoptLegacyProjectColumns(sqlite);

    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: migrationsFolder ?? getMigrationsFolder() });

    // Backfill: rows whose last_accessed_at is still the column default (0)
    // take their last_opened as the score's valid-at timestamp. Migration 0009
    // already does this once; this catches any row minted through a path that
    // skipped the stamp. last_opened, never "now": the score of a project
    // untouched since May must decay from May, not restart fresh on boot —
    // frozen-at-write scores masquerading as current is the exact staleness
    // bug the read-time decay rework removed.
    sqlite.exec("UPDATE projects SET last_accessed_at = last_opened WHERE last_accessed_at = 0");

    // Tighten the whole family once here: migrate()/the backfill above are the
    // first WAL-mode writes, so -wal/-shm exist by now, and an existing 0o644
    // daintree.db from a pre-fix install gets corrected in place too.
    tightenDatabaseFilePermissions(dbPath);

    return { sqlite, db };
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // ignore close errors during failure unwind
    }
    throw error;
  }
}

/**
 * Probe the database for corruption. When `fullCheck` is false (default on
 * clean-exit boots), runs a cheap `PRAGMA schema_version` open instead of the
 * O(database-size) `PRAGMA quick_check`. Corruption only occurs after crashes
 * or power loss, so the full scan is gated on unclean-exit detection and
 * deferred on clean boots to the idle maintenance tick.
 */
export function probeDb(dbPath: string, fullCheck = true): boolean {
  if (!fs.existsSync(dbPath)) return true; // no file = fresh start, not corruption
  let testDb: Database.Database | null = null;
  try {
    testDb = new Database(dbPath, { readonly: true });
    if (fullCheck) {
      const quickCheckResult = testDb.pragma("quick_check", { simple: true });
      if (quickCheckResult !== "ok") {
        console.warn("[DB] quick_check detected corruption:", quickCheckResult);
        return false;
      }
    } else {
      // Cheap structural open: reading schema_version confirms the file is a
      // valid SQLite database without scanning every page.
      testDb.pragma("schema_version");
    }
    return true;
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (
      typeof code === "string" &&
      (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB")
    ) {
      return false;
    }
    console.warn("[DB] Probe encountered non-corruption error:", error);
    return true;
  } finally {
    try {
      testDb?.close();
    } catch {
      // ignore close errors
    }
  }
}

/**
 * Quarantine a corrupt database and restore it from the backup when that backup
 * probes clean, otherwise leave the path empty so `openDb` creates a fresh file.
 *
 * Returns what actually happened so callers can tell the user. `null` means the
 * recovery itself failed (a rename threw) — the corrupt database may still be in
 * place, so callers must not report a successful restore or reset.
 */
/**
 * Probe an arbitrary SQLite file, reporting "could not verify" separately from
 * "proven corrupt". Distinct from `probeDb`, which is fail-open by design: at
 * boot, a transient EACCES must not quarantine a healthy database. Promoting a
 * backup is the opposite call — it overwrites the last known-good copy, so
 * anything short of a proven "ok" must not proceed.
 *
 * The DB worker reimplements this verdict table inline (it cannot import this
 * module — Electron's `app` does not exist in a worker thread); keep them in step.
 */
export function probeDbFile(dbPath: string): DbProbeResult {
  if (!fs.existsSync(dbPath)) return "unknown";
  let testDb: Database.Database | null = null;
  try {
    testDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    return testDb.pragma("quick_check", { simple: true }) === "ok" ? "ok" : "corrupt";
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (
      typeof code === "string" &&
      (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB")
    ) {
      return "corrupt";
    }
    return "unknown";
  } finally {
    try {
      testDb?.close();
    } catch {
      // ignore close errors
    }
  }
}

export function attemptRecovery(dbPath: string): DatabaseRecovery | null {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const corruptSuffix = `.corrupt-${timestamp}`;
  const backupPath = dbPath + ".backup";

  // Quarantine the corrupt DB and its WAL/SHM sidecars. Only the main file's
  // path is reported — it is the one a user would inspect or hand to support.
  let quarantinedPath: string | undefined;
  for (const suffix of ["", "-wal", "-shm"]) {
    const filePath = dbPath + suffix;
    if (!fs.existsSync(filePath)) continue;
    try {
      fs.renameSync(filePath, filePath + corruptSuffix);
      // rename preserves the source mode, so an upgrading install's 0o644 db
      // would keep world-readable (corrupt but still sensitive) contents in the
      // forensic copy. Tighten the quarantined file explicitly.
      tightenFilePermissionsSync(filePath + corruptSuffix);
      if (suffix === "") quarantinedPath = filePath + corruptSuffix;
    } catch (error) {
      if (suffix === "") {
        // Nothing moved — the corrupt DB is still in place and will be reopened.
        // Claiming a restore or a reset here would report something that never
        // happened, so report nothing at all.
        console.error("[DB] Failed to quarantine the corrupt database:", error);
        return null;
      }
      // A stale WAL/SHM left beside the replacement database can be replayed
      // into it. If it will not move aside, delete it — losing an orphaned
      // sidecar beats corrupting the database we are about to restore.
      console.warn(`[DB] Could not quarantine ${filePath}, removing it instead:`, error);
      try {
        fs.unlinkSync(filePath);
      } catch (unlinkError) {
        console.error(`[DB] Could not remove ${filePath} either:`, unlinkError);
      }
    }
  }

  // Past this point the corrupt DB is gone, so the app WILL come up on a
  // different database — the user has to be told either way.
  try {
    if (fs.existsSync(backupPath)) {
      // probeDbFile, not probeDb: restoring overwrites the database the app is
      // about to open, so a backup we merely failed to READ must not be copied
      // over it and then reported as a successful restore.
      const verdict = probeDbFile(backupPath);
      if (verdict === "ok") {
        fs.copyFileSync(backupPath, dbPath);
        // copyFileSync's mode propagation is platform/filesystem-dependent, so
        // tighten the restored database explicitly (openDb will re-tighten the
        // full family on reopen, but this keeps the restored copy owner-only in
        // the interim).
        tightenFilePermissionsSync(dbPath);
        console.log("[DB] Restored database from backup");
        return { kind: "restored-from-backup", quarantinedPath };
      }
      console.error(`[DB] Backup cannot be restored (${verdict}) — starting fresh`);
    } else {
      console.warn("[DB] No backup available for recovery — fresh database will be created");
    }
  } catch (error) {
    console.error("[DB] Restore from backup failed:", error);
  }

  // Starting fresh. DatabaseMaintenanceService will back the new (empty) database
  // up over `backupPath` on its first idle tick, so any surviving backup has to
  // move out of the way first — otherwise recovery itself destroys the last copy
  // of the user's data, which is the very failure this whole change exists to
  // prevent. Preserve it rather than delete it: it may still be salvageable.
  preserveStaleBackup(backupPath, corruptSuffix);
  return { kind: "reset-to-fresh", quarantinedPath };
}

function preserveStaleBackup(backupPath: string, corruptSuffix: string): void {
  try {
    if (fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, backupPath + corruptSuffix);
      // rename carries the source mode forward; tighten in case a pre-fix
      // install's backup was world-readable.
      tightenFilePermissionsSync(backupPath + corruptSuffix);
    }
  } catch (error) {
    console.error("[DB] Could not move the unusable backup aside:", error);
  }
}

export function closeSharedDb(options?: { checkpoint?: boolean }): void {
  if (sharedInstance) {
    if (options?.checkpoint) {
      try {
        sharedInstance.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      } catch (error) {
        console.warn("[DB] WAL checkpoint on close failed:", error);
      }
    }
    sharedInstance.sqlite.close();
    sharedInstance = null;
  }
}

export function resetSharedInstance(): void {
  sharedInstance = null;
}

// Disk-pressure codes that a WAL truncate plus a single retry can plausibly
// recover from. Other SQLITE_IOERR_* variants (lock, read, access, shmopen,
// etc.) are not write-pressure failures, so we leave them to the caller.
const RECOVERABLE_IOERR_CODES = new Set([
  "SQLITE_IOERR_WRITE",
  "SQLITE_IOERR_FSYNC",
  "SQLITE_IOERR_TRUNCATE",
  "SQLITE_IOERR_DIR_FSYNC",
]);

function isDiskFullError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string") return false;
  return code === "SQLITE_FULL" || RECOVERABLE_IOERR_CODES.has(code);
}

// Run `fn` against the SQLite handle; on SQLITE_FULL or a write-side
// SQLITE_IOERR_* code try to free space by truncating the WAL and retry once.
// The retry is gated on disk-space status — when the volume is critical, the
// WAL truncate would itself need to write and is unlikely to recover, so we
// skip straight to re-throwing the original error. The recovery checkpoint is
// wrapped in its own try/catch so a failed checkpoint does not mask the
// caller's error or trigger a recursive retry; we still attempt the retry
// afterwards in case the checkpoint freed some pages before failing.
export function withDiskRecovery<T>(sqlite: Database.Database, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (!isDiskFullError(error)) throw error;
    if (getWritesSuppressed()) throw error;

    console.warn("[DB] Disk-full error, attempting WAL truncate and retry:", error);
    try {
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } catch (checkpointError) {
      console.warn("[DB] Recovery WAL checkpoint failed:", checkpointError);
    }

    return fn();
  }
}
