import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { app } from "electron";
import fs from "node:fs";
import path from "path";
import { getCurrentDiskSpaceStatus } from "../DiskSpaceMonitor.js";
import * as schema from "./schema.js";

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

let sharedInstance: { sqlite: Database.Database; db: AppDb } | null = null;

export function getDbPath(): string {
  return path.join(app.getPath("userData"), "daintree.db");
}

export function getBackupPath(): string {
  return getDbPath() + ".backup";
}

export function getMigrationsFolder(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "migrations")
    : path.join(app.getAppPath(), "electron/services/persistence/migrations");
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
  const sqlite = new Database(dbPath);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("busy_timeout = 3000");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("temp_store = MEMORY");
    sqlite.pragma("mmap_size = 10737418240");
    sqlite.pragma("cache_size = -65536");
    sqlite.pragma("journal_size_limit = 5242880");

    adoptLegacyProjectColumns(sqlite);

    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: migrationsFolder ?? getMigrationsFolder() });

    // Backfill: rows whose last_accessed_at is still the column default (0) get
    // bumped to "now" so the first access doesn't crash the frecency score from
    // its initial value down to ~0 due to the time-decay term.
    sqlite
      .prepare("UPDATE projects SET last_accessed_at = ? WHERE last_accessed_at = 0")
      .run(Date.now());

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

const CORRUPTION_CODES = new Set(["SQLITE_CORRUPT", "SQLITE_NOTADB"]);

export function probeDb(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) return true; // no file = fresh start, not corruption
  let testDb: Database.Database | null = null;
  try {
    testDb = new Database(dbPath, { readonly: true });
    testDb.pragma("schema_version");
    return true;
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (code && CORRUPTION_CODES.has(code)) {
      return false;
    }
    // Non-corruption errors (e.g. permission denied) — treat as healthy to avoid data loss
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

export function attemptRecovery(dbPath: string): boolean {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const corruptSuffix = `.corrupt-${timestamp}`;
  const backupPath = dbPath + ".backup";

  try {
    // Quarantine corrupt DB and associated WAL/SHM files
    for (const suffix of ["", "-wal", "-shm"]) {
      const filePath = dbPath + suffix;
      if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, filePath + corruptSuffix);
      }
    }

    // Restore from backup if available
    if (fs.existsSync(backupPath)) {
      // Verify backup integrity before restoring
      if (probeDb(backupPath)) {
        fs.copyFileSync(backupPath, dbPath);
        console.log("[DB] Restored database from backup");
        return true;
      } else {
        console.error("[DB] Backup is also corrupt, cannot restore");
        // Quarantine the corrupt backup too
        fs.renameSync(backupPath, backupPath + corruptSuffix);
        return false;
      }
    }

    console.warn("[DB] No backup available for recovery — fresh database will be created");
    return false;
  } catch (error) {
    console.error("[DB] Recovery failed:", error);
    return false;
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
    if (getCurrentDiskSpaceStatus().status === "critical") throw error;

    console.warn("[DB] Disk-full error, attempting WAL truncate and retry:", error);
    try {
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } catch (checkpointError) {
      console.warn("[DB] Recovery WAL checkpoint failed:", checkpointError);
    }

    return fn();
  }
}
