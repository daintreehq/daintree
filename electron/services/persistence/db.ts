import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { app } from "electron";
import fs from "node:fs";
import path from "path";
import * as schema from "./schema.js";

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    queued_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    dependencies TEXT NOT NULL DEFAULT '[]',
    worktree_id TEXT,
    assigned_agent_id TEXT,
    run_id TEXT,
    metadata TEXT,
    result TEXT,
    routing_hints TEXT
  );

  CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS tasks_project_status_idx ON tasks(project_id, status);

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    last_opened INTEGER NOT NULL,
    color TEXT,
    status TEXT,
    daintree_config_present INTEGER,
    in_repo_settings INTEGER,
    pinned INTEGER NOT NULL DEFAULT 0,
    frecency_score REAL NOT NULL DEFAULT 3.0,
    last_accessed_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

let sharedInstance: { sqlite: Database.Database; db: AppDb } | null = null;

export function getDbPath(): string {
  return path.join(app.getPath("userData"), "daintree.db");
}

export function getBackupPath(): string {
  return getDbPath() + ".backup";
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

export function openDb(dbPath: string): { sqlite: Database.Database; db: AppDb } {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 3000");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("temp_store = MEMORY");
  sqlite.pragma("mmap_size = 10737418240");
  sqlite.pragma("cache_size = -65536");
  sqlite.exec(CREATE_TABLES_SQL);

  // Migrate: add pinned column to projects table if it doesn't exist
  const cols = sqlite.pragma("table_info(projects)") as { name: string }[];
  if (!cols.some((c) => c.name === "pinned")) {
    sqlite.prepare("ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0").run();
  }

  // Migrate: add frecency columns to projects table
  if (!cols.some((c) => c.name === "frecency_score")) {
    sqlite
      .prepare("ALTER TABLE projects ADD COLUMN frecency_score REAL NOT NULL DEFAULT 3.0")
      .run();
  }
  if (!cols.some((c) => c.name === "last_accessed_at")) {
    sqlite
      .prepare("ALTER TABLE projects ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0")
      .run();
  }
  // Backfill: set last_accessed_at to now for migrated rows to prevent first-access decay collapse
  sqlite
    .prepare("UPDATE projects SET last_accessed_at = ? WHERE last_accessed_at = 0")
    .run(Date.now());

  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
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
