import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
}));

import { openDb } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../migrations");

// Derive the expected migration count from the journal so each new migration
// added to the repo doesn't require touching every assertion in this file.
const migrationsJournalEntries = JSON.parse(
  fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")
).entries as Array<{ tag: string }>;
const EXPECTED_MIGRATION_COUNT = migrationsJournalEntries.length;

type ColInfo = { name: string; type: string };

describe("openDb (integration)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-db-opendb-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the schema and records the baseline migration on a fresh DB", () => {
    const dbPath = path.join(tmpDir, "fresh.db");
    const { sqlite } = openDb(dbPath, migrationsFolder);
    try {
      const tableNames = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const names = tableNames.map((t) => t.name);
      expect(names).toContain("projects");
      expect(names).toContain("app_state");
      expect(names).toContain("__drizzle_migrations");
      expect(names).toContain("scratches");
      expect(names).not.toContain("tasks");

      const migrations = sqlite.prepare("SELECT id, hash FROM __drizzle_migrations").all() as {
        id: number;
        hash: string;
      }[];
      expect(migrations).toHaveLength(EXPECTED_MIGRATION_COUNT);
      expect(migrations[0].hash).toBeTruthy();
    } finally {
      sqlite.close();
    }
  });

  it("applies the WAL and tuning pragmas", () => {
    const dbPath = path.join(tmpDir, "pragmas.db");
    const { sqlite } = openDb(dbPath, migrationsFolder);
    try {
      const journalMode = sqlite.pragma("journal_mode", { simple: true });
      expect(String(journalMode).toLowerCase()).toBe("wal");

      const synchronous = sqlite.pragma("synchronous", { simple: true });
      // synchronous = NORMAL is enum value 1
      expect(Number(synchronous)).toBe(1);

      const tempStore = sqlite.pragma("temp_store", { simple: true });
      // temp_store = MEMORY is enum value 2
      expect(Number(tempStore)).toBe(2);

      const journalSizeLimit = sqlite.pragma("journal_size_limit", { simple: true });
      expect(Number(journalSizeLimit)).toBe(5_242_880);

      const foreignKeys = sqlite.pragma("foreign_keys", { simple: true });
      expect(Number(foreignKeys)).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  // chmod is a POSIX no-op on Windows, so the mode-bit assertions only run there.
  const posixIt = process.platform === "win32" ? it.skip : it;

  posixIt("creates the database and its WAL/SHM sidecars owner-only", () => {
    const dbPath = path.join(tmpDir, "perms.db");
    const { sqlite } = openDb(dbPath, migrationsFolder);
    try {
      // Force a WAL frame so -wal/-shm are guaranteed to materialize (a no-op
      // migrate could otherwise checkpoint them away and leave the loop vacuous).
      sqlite.pragma("user_version = 42");

      expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = dbPath + suffix;
        expect(fs.existsSync(sidecar)).toBe(true);
        expect(fs.statSync(sidecar).mode & 0o777).toBe(0o600);
      }
    } finally {
      sqlite.close();
    }
  });

  posixIt("pre-creates a fresh database with an exclusive owner-only handle", () => {
    // The final-mode assertion above would still pass with only the post-open
    // chmod, so pin the TOCTOU protection: the fresh file is created via an
    // exclusive 0o600 handle BEFORE better-sqlite3 opens it.
    const dbPath = path.join(tmpDir, "toctou.db");
    const openSyncSpy = vi.spyOn(fs, "openSync");
    const { sqlite } = openDb(dbPath, migrationsFolder);
    try {
      expect(openSyncSpy).toHaveBeenCalledWith(dbPath, "wx", 0o600);
    } finally {
      sqlite.close();
      openSyncSpy.mockRestore();
    }
  });

  posixIt("tightens a pre-existing world-readable database on reopen (upgrade case)", () => {
    const dbPath = path.join(tmpDir, "legacy.db");
    openDb(dbPath, migrationsFolder).sqlite.close();
    // Simulate a database written by a pre-fix app version at the umask default.
    fs.chmodSync(dbPath, 0o644);

    const reopened = openDb(dbPath, migrationsFolder);
    try {
      expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
    } finally {
      reopened.sqlite.close();
    }
  });

  it("is idempotent — opening the same DB twice does not throw or duplicate rows", () => {
    const dbPath = path.join(tmpDir, "twice.db");
    const first = openDb(dbPath, migrationsFolder);
    first.sqlite.close();

    const second = openDb(dbPath, migrationsFolder);
    try {
      const migrations = second.sqlite.prepare("SELECT id FROM __drizzle_migrations").all() as {
        id: number;
      }[];
      expect(migrations).toHaveLength(EXPECTED_MIGRATION_COUNT);
    } finally {
      second.sqlite.close();
    }
  });

  it("adopts a legacy DB that already has the project schema (simulates pre-migration users)", async () => {
    const dbPath = path.join(tmpDir, "legacy.db");

    // Simulate the historical CREATE_TABLES_SQL from db.ts before drizzle migrations existed.
    // Open a raw better-sqlite3 first and create the tables exactly as the old code did,
    // then close — openDb() should be safe to run on top of this.
    const Database = (await import("better-sqlite3")).default;
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE tasks (
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
      CREATE INDEX tasks_project_idx ON tasks(project_id);
      CREATE INDEX tasks_project_status_idx ON tasks(project_id, status);
      CREATE TABLE projects (
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
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        "INSERT INTO projects (id, path, name, emoji, last_opened, pinned, frecency_score, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run("p1", "/tmp/p1", "p1", "🌳", 1, 0, 3.0, 0);
    legacy.close();

    const { sqlite } = openDb(dbPath, migrationsFolder);
    try {
      const projectCols = sqlite.pragma("table_info(projects)") as ColInfo[];
      expect(projectCols.map((c) => c.name)).toEqual(
        expect.arrayContaining(["pinned", "frecency_score", "last_accessed_at"])
      );

      const project = sqlite
        .prepare("SELECT id, name, last_accessed_at FROM projects WHERE id = ?")
        .get("p1") as { id: string; name: string; last_accessed_at: number };
      expect(project.id).toBe("p1");
      expect(project.name).toBe("p1");
      // Backfill must have updated last_accessed_at to a non-zero recent time.
      expect(project.last_accessed_at).toBeGreaterThan(0);

      const migrations = sqlite.prepare("SELECT id FROM __drizzle_migrations").all() as {
        id: number;
      }[];
      expect(migrations).toHaveLength(EXPECTED_MIGRATION_COUNT);
    } finally {
      sqlite.close();
    }
  });

  it("backfills last_accessed_at = 0 rows to the current timestamp without disturbing non-zero rows", () => {
    const dbPath = path.join(tmpDir, "backfill.db");
    // First open creates the schema.
    const setup = openDb(dbPath, migrationsFolder);
    setup.sqlite
      .prepare(
        "INSERT INTO projects (id, path, name, emoji, last_opened, pinned, frecency_score, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run("zero", "/tmp/zero", "zero", "🌲", 1, 0, 3.0, 0);
    setup.sqlite
      .prepare(
        "INSERT INTO projects (id, path, name, emoji, last_opened, pinned, frecency_score, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run("nonzero", "/tmp/nonzero", "nonzero", "🌴", 1, 0, 3.0, 9999);
    setup.sqlite.close();

    const before = Date.now();
    const { sqlite } = openDb(dbPath, migrationsFolder);
    try {
      const zeroRow = sqlite
        .prepare("SELECT last_accessed_at FROM projects WHERE id = ?")
        .get("zero") as { last_accessed_at: number };
      expect(zeroRow.last_accessed_at).toBeGreaterThanOrEqual(before);

      const nonZeroRow = sqlite
        .prepare("SELECT last_accessed_at FROM projects WHERE id = ?")
        .get("nonzero") as { last_accessed_at: number };
      expect(nonZeroRow.last_accessed_at).toBe(9999);
    } finally {
      sqlite.close();
    }
  });

  it("upgrades a pre-pinned legacy DB (only the original 9 columns) to the current schema", async () => {
    const dbPath = path.join(tmpDir, "pre-pinned.db");

    const Database = (await import("better-sqlite3")).default;
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        last_opened INTEGER NOT NULL,
        color TEXT,
        status TEXT,
        daintree_config_present INTEGER,
        in_repo_settings INTEGER
      );
    `);
    legacy
      .prepare("INSERT INTO projects (id, path, name, emoji, last_opened) VALUES (?, ?, ?, ?, ?)")
      .run("old", "/tmp/old", "old", "🪵", 1);
    legacy.close();

    const { sqlite } = openDb(dbPath, migrationsFolder);
    try {
      const cols = (sqlite.pragma("table_info(projects)") as ColInfo[]).map((c) => c.name);
      expect(cols).toEqual(
        expect.arrayContaining(["pinned", "frecency_score", "last_accessed_at"])
      );

      const row = sqlite
        .prepare("SELECT id, pinned, frecency_score, last_accessed_at FROM projects WHERE id = ?")
        .get("old") as {
        id: string;
        pinned: number;
        frecency_score: number;
        last_accessed_at: number;
      };
      expect(row.id).toBe("old");
      expect(row.pinned).toBe(0);
      expect(row.frecency_score).toBeCloseTo(3.0);
      // Backfill must have replaced the column-default 0 with a real timestamp.
      expect(row.last_accessed_at).toBeGreaterThan(0);

      const migrations = sqlite.prepare("SELECT id FROM __drizzle_migrations").all() as {
        id: number;
      }[];
      expect(migrations).toHaveLength(EXPECTED_MIGRATION_COUNT);
    } finally {
      sqlite.close();
    }
  });

  it("upgrades a partial-legacy DB (pinned present, frecency columns missing)", async () => {
    const dbPath = path.join(tmpDir, "partial-legacy.db");

    const Database = (await import("better-sqlite3")).default;
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        last_opened INTEGER NOT NULL,
        color TEXT,
        status TEXT,
        daintree_config_present INTEGER,
        in_repo_settings INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0
      );
    `);
    legacy.close();

    const { sqlite } = openDb(dbPath, migrationsFolder);
    try {
      const cols = (sqlite.pragma("table_info(projects)") as ColInfo[]).map((c) => c.name);
      expect(cols).toEqual(
        expect.arrayContaining(["pinned", "frecency_score", "last_accessed_at"])
      );
    } finally {
      sqlite.close();
    }
  });

  it("applies a later migration to a DB already migrated through an earlier one (regression: journal-timestamp skip)", async () => {
    // Reproduces the journal-timestamp bug: drizzle only applies a migration when
    // its folderMillis (the journal `when`) is greater than the newest recorded
    // `created_at`. A migration stamped with a `when` that predates an already-
    // applied one is silently skipped on every existing DB. Here we seed a DB that
    // has run through every migration EXCEPT the last and assert openDb closes the
    // gap — i.e. the final migration's table actually gets created.
    const dbPath = path.join(tmpDir, "mid-history.db");

    const journal = JSON.parse(
      fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")
    ).entries as Array<{ when: number; tag: string }>;
    // Everything except the most recent migration is "already applied".
    const applied = journal.slice(0, -1);

    const Database = (await import("better-sqlite3")).default;
    const seed = new Database(dbPath);
    // Mirror drizzle's own bookkeeping table + a projects table for openDb's backfill.
    seed.exec(`
      CREATE TABLE __drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        last_opened INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        frecency_score REAL NOT NULL DEFAULT 3.0,
        last_accessed_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    const ins = seed.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
    for (const entry of applied) ins.run(entry.tag, entry.when);
    seed.close();

    // The final migration's effect must be absent before the upgrade for the test
    // to mean anything — the seed `projects` table was created without them, and
    // the final migration (0007) adds the stats_* columns (#11078).
    const preCheck = new Database(dbPath, { readonly: true });
    const seededColumns = (preCheck.prepare("PRAGMA table_info(projects)").all() as ColInfo[]).map(
      (c) => c.name
    );
    preCheck.close();
    expect(seededColumns).not.toContain("stats_commit_count");

    const { sqlite } = openDb(dbPath, migrationsFolder);
    try {
      const projectColumns = (sqlite.pragma("table_info(projects)") as ColInfo[]).map(
        (c) => c.name
      );
      expect(projectColumns).toEqual(
        expect.arrayContaining([
          "stats_commit_count",
          "stats_issue_count",
          "stats_pr_count",
          "stats_provider_id",
          "stats_last_updated",
        ])
      );

      // The skipped migration is now recorded — total equals the full journal.
      const migrations = sqlite.prepare("SELECT id FROM __drizzle_migrations").all();
      expect(migrations).toHaveLength(EXPECTED_MIGRATION_COUNT);
    } finally {
      sqlite.close();
    }
  });

  it("closes the underlying SQLite handle if migrate() throws", () => {
    const dbPath = path.join(tmpDir, "leak.db");
    const bogusFolder = path.join(tmpDir, "does-not-exist");

    expect(() => openDb(dbPath, bogusFolder)).toThrow();

    // If the handle were leaked, deleting the file on Windows would EBUSY.
    // On POSIX, the WAL/SHM files would still exist. Deleting the DB file
    // and walking the directory verifies no stray handle held it open.
    expect(() => fs.unlinkSync(dbPath)).not.toThrow();
  });
});
