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
import { eq } from "drizzle-orm";
import * as schema from "../schema.js";

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

  it("backfills last_accessed_at = 0 rows from last_opened without disturbing non-zero rows", () => {
    const dbPath = path.join(tmpDir, "backfill.db");
    // First open creates the schema.
    const setup = openDb(dbPath, migrationsFolder);
    setup.sqlite
      .prepare(
        "INSERT INTO projects (id, path, name, emoji, last_opened, pinned, frecency_score, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run("zero", "/tmp/zero", "zero", "🌲", 4567, 0, 3.0, 0);
    setup.sqlite
      .prepare(
        "INSERT INTO projects (id, path, name, emoji, last_opened, pinned, frecency_score, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run("nonzero", "/tmp/nonzero", "nonzero", "🌴", 4567, 0, 3.0, 9999);
    setup.sqlite.close();

    const { sqlite } = openDb(dbPath, migrationsFolder);
    try {
      // last_opened, never "now": a dormant project's score must keep decaying
      // from when it was really last touched, not restart fresh on boot.
      const zeroRow = sqlite
        .prepare("SELECT last_accessed_at FROM projects WHERE id = ?")
        .get("zero") as { last_accessed_at: number };
      expect(zeroRow.last_accessed_at).toBe(4567);

      const nonZeroRow = sqlite
        .prepare("SELECT last_accessed_at FROM projects WHERE id = ?")
        .get("nonzero") as { last_accessed_at: number };
      expect(nonZeroRow.last_accessed_at).toBe(9999);
    } finally {
      sqlite.close();
    }
  });

  it("0009 rebase: scales pre-4-day scores and backfills timestamps on upgrade", async () => {
    // Simulate a real upgrade: build a DB with migrations applied only through
    // 0008, seed rows shaped like a long-lived install, then reopen with the
    // full folder so 0009 alone runs against existing data.
    const truncatedFolder = path.join(tmpDir, "migrations-through-0008");
    fs.mkdirSync(path.join(truncatedFolder, "meta"), { recursive: true });
    const journal = JSON.parse(
      fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")
    ) as { entries: { idx: number; tag: string }[] };
    const keptEntries = journal.entries.filter((entry) => entry.idx <= 8);
    for (const entry of keptEntries) {
      const file = `${entry.tag}.sql`;
      fs.copyFileSync(path.join(migrationsFolder, file), path.join(truncatedFolder, file));
    }
    fs.writeFileSync(
      path.join(truncatedFolder, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: keptEntries })
    );

    const dbPath = path.join(tmpDir, "upgrade.db");
    const old = openDb(dbPath, truncatedFolder);
    const insert = old.sqlite.prepare(
      "INSERT INTO projects (id, path, name, emoji, last_opened, pinned, frecency_score, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    // A heavily-used project bumped recently, a legacy row that predates the
    // timestamp column (last_accessed_at still 0), a row carrying the old
    // runtime backfill's boot-stamp (timestamp NEWER than its last open), and
    // a never-opened row still holding the untouched 3.0 seed.
    insert.run(
      "heavy",
      "/tmp/heavy",
      "heavy",
      "🌲",
      1_700_000_000_000,
      0,
      1218.1,
      1_700_000_000_000
    );
    insert.run("legacy", "/tmp/legacy", "legacy", "🌴", 1_650_000_000_000, 0, 26.5, 0);
    insert.run(
      "bootstamped",
      "/tmp/bootstamped",
      "bootstamped",
      "🌵",
      1_650_000_000_000,
      0,
      26.5,
      1_784_000_000_000
    );
    insert.run("seeded", "/tmp/seeded", "seeded", "🌱", 1_700_000_000_000, 0, 3.0, 0);
    old.sqlite.close();

    const { sqlite } = openDb(dbPath, migrationsFolder);
    try {
      const rows = sqlite
        .prepare("SELECT id, frecency_score, last_accessed_at FROM projects ORDER BY id")
        .all() as { id: string; frecency_score: number; last_accessed_at: number }[];
      const heavy = rows.find((r) => r.id === "heavy")!;
      const legacy = rows.find((r) => r.id === "legacy")!;

      // Rate conversion 14d → 4d: steady-state scores shrink by the ratio of
      // per-access steady states, ≈0.3036. Timestamps are left alone so the
      // read-time decay applies the idle gap honestly.
      expect(heavy.frecency_score).toBeCloseTo(1218.1 * 0.3036062767938871, 3);
      expect(heavy.last_accessed_at).toBe(1_700_000_000_000);

      expect(legacy.frecency_score).toBeCloseTo(26.5 * 0.3036062767938871, 3);
      // The 0-timestamp row is rebased onto last_opened, not "now".
      expect(legacy.last_accessed_at).toBe(1_650_000_000_000);

      // The pre-0009 runtime backfill stamped zero timestamps with a BOOT
      // time, leaving score valid-at newer than the project's last open — the
      // exact shape that let dormant projects rank as fresh. 0009 rebases it.
      const bootstamped = rows.find((r) => r.id === "bootstamped")!;
      expect(bootstamped.last_accessed_at).toBe(1_650_000_000_000);
      expect(bootstamped.frecency_score).toBeCloseTo(26.5 * 0.3036062767938871, 3);

      // An untouched 3.0 seed becomes the new 0.5 prior, not 3.0 × scale —
      // registration was never evidence of three accesses.
      const seeded = rows.find((r) => r.id === "seeded")!;
      expect(seeded.frecency_score).toBeCloseTo(0.5);
      expect(seeded.last_accessed_at).toBe(1_700_000_000_000);
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
      // An exact 3.0 is the untouched seed (a bumped score lands there with
      // probability zero), so 0009 rewrites it to the new 0.5 prior instead of
      // rate-scaling it like accumulated history.
      expect(row.frecency_score).toBeCloseTo(0.5);
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

    // Read the newest migration's own effect out of its SQL rather than naming
    // columns here, so this stays a real assertion about migration application
    // instead of a copy of whichever migration happens to be last today.
    const finalTag = journal[journal.length - 1].tag;
    const finalSql = fs.readFileSync(path.join(migrationsFolder, `${finalTag}.sql`), "utf8");
    // Whichever table the newest migration happens to touch — naming one here
    // would reintroduce exactly the copy-of-the-last-migration coupling this
    // extraction exists to avoid.
    const additions = [...finalSql.matchAll(/ALTER TABLE `([a-z_]+)` ADD `([a-z_]+)`/g)].map(
      (m) => ({ table: m[1]!, column: m[2]! })
    );
    const removals = [...finalSql.matchAll(/ALTER TABLE `([a-z_]+)` DROP COLUMN `([a-z_]+)`/g)].map(
      (m) => ({ table: m[1]!, column: m[2]! })
    );
    const deletedKeys = [
      ...finalSql.matchAll(/DELETE FROM `app_state` WHERE `key` = '([^']+)'/g),
    ].map((m) => m[1]!);
    expect(additions.length).toBeGreaterThan(0);

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
      CREATE TABLE scratches (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_opened INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const ins = seed.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
    for (const entry of applied) ins.run(entry.tag, entry.when);

    // Give any `DELETE FROM app_state` in the newest migration something to
    // actually delete, plus a neighbour it must leave alone — without rows the
    // statement could be removed entirely and this test would not notice.
    const appStateIns = seed.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)");
    for (const key of deletedKeys) appStateIns.run(key, "seeded");
    appStateIns.run("currentProjectId", "keep-me");

    // A migration can only drop a column the seeded schema actually has, and
    // the seed above is a minimal pre-history table. Add each dropped column
    // back so the DROP has something to act on — derived from the SQL for the
    // same reason the additions are.
    for (const { table, column } of removals) {
      seed.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`);
    }
    seed.close();

    // Those columns must be absent before the upgrade for the test to mean
    // anything — the seed tables were created without them.
    const preCheck = new Database(dbPath, { readonly: true });
    for (const { table, column } of additions) {
      const seededColumns = (
        preCheck.prepare(`PRAGMA table_info(${table})`).all() as ColInfo[]
      ).map((c) => c.name);
      expect(seededColumns).not.toContain(column);
    }
    // And the dropped ones must be present, or the DROP would prove nothing.
    for (const { table, column } of removals) {
      const seededColumns = (
        preCheck.prepare(`PRAGMA table_info(${table})`).all() as ColInfo[]
      ).map((c) => c.name);
      expect(seededColumns).toContain(column);
    }
    preCheck.close();

    const { sqlite } = openDb(dbPath, migrationsFolder);
    try {
      for (const { table, column } of additions) {
        const columns = (sqlite.pragma(`table_info(${table})`) as ColInfo[]).map((c) => c.name);
        expect(columns).toContain(column);
      }
      for (const { table, column } of removals) {
        const columns = (sqlite.pragma(`table_info(${table})`) as ColInfo[]).map((c) => c.name);
        expect(columns).not.toContain(column);
      }

      // Obsolete keys are gone and their neighbours are not — a DELETE without
      // a WHERE, or one aimed at the wrong key, fails on the second assertion.
      const remainingKeys = (
        sqlite.prepare("SELECT key FROM app_state").all() as { key: string }[]
      ).map((r) => r.key);
      for (const key of deletedKeys) expect(remainingKeys).not.toContain(key);
      expect(remainingKeys).toContain("currentProjectId");

      // The skipped migration is now recorded — total equals the full journal.
      const migrations = sqlite.prepare("SELECT id FROM __drizzle_migrations").all();
      expect(migrations).toHaveLength(EXPECTED_MIGRATION_COUNT);
    } finally {
      sqlite.close();
    }
  });

  it("drops the obsolete session-open checkpoint on upgrade (migration 0012)", async () => {
    // Names the key on purpose, unlike the generic journal test above: that one
    // derives its expectations from the migration's own SQL, so deleting the
    // statement would delete the assertion with it. The checkpoint fed the
    // switcher's old recency dot (#11794) and nothing reads it after #11801, so
    // leaving the row behind would strand user state no code can reach.
    const dbPath = path.join(tmpDir, "checkpoint-cleanup.db");

    const Database = (await import("better-sqlite3")).default;
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const ins = seed.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)");
    ins.run("sessionOpenProjects", '{"v":1,"projectIds":["proj-1"],"atMs":123}');
    ins.run("currentProjectId", "proj-1");
    seed.close();

    const { sqlite } = openDb(dbPath, migrationsFolder);
    try {
      const rows = sqlite.prepare("SELECT key FROM app_state").all() as { key: string }[];
      const keys = rows.map((r) => r.key);
      expect(keys).not.toContain("sessionOpenProjects");
      // The neighbouring key is what proves the DELETE was scoped rather than
      // a table-wide wipe that happened to satisfy the first assertion.
      expect(keys).toContain("currentProjectId");
    } finally {
      sqlite.close();
    }
  });

  it("gives an existing scratch a column the Drizzle schema can address (migration 0013)", async () => {
    // Names the column on purpose, for the same reason the 0012 test does: the
    // generic journal test derives its expectations from the migration's own
    // SQL, so a column misspelled in BOTH would satisfy it, and every store
    // suite hand-creates the table rather than migrating into it. This is the
    // only place the shipped SQL and `schema.ts` have to agree — which matters
    // because 0013 was hand-trimmed from a generated draft (#11821).
    const dbPath = path.join(tmpDir, "scratch-resume-count.db");

    const journal = JSON.parse(
      fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")
    ).entries as Array<{ when: number; tag: string }>;

    const Database = (await import("better-sqlite3")).default;
    const seed = new Database(dbPath);
    // Everything up to 0013 already applied, so only the migration under test
    // runs against a `scratches` table at its pre-0013 shape — holding a scratch
    // that predates the field, which is the population it exists to backfill.
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
      CREATE TABLE scratches (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_opened INTEGER NOT NULL,
        deleted_at INTEGER,
        last_completion_seen_at INTEGER
      );
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const applied = seed.prepare(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)"
    );
    for (const entry of journal.slice(0, -1)) applied.run(entry.tag, entry.when);
    seed
      .prepare(
        "INSERT INTO scratches (id, path, name, created_at, last_opened) VALUES (?, ?, ?, ?, ?)"
      )
      .run("11111111-2222-4333-8444-555555555555", "/tmp/s", "Spike", 1, 2);
    seed.close();

    const { sqlite, db } = openDb(dbPath, migrationsFolder);
    try {
      // Round-tripped through the ORM rather than raw SQL: that is what binds
      // the migration's column name to the one `ScratchStore` actually reads.
      db.update(schema.scratches)
        .set({ resumableAgentCount: 3 })
        .where(eq(schema.scratches.id, "11111111-2222-4333-8444-555555555555"))
        .run();
      const row = db
        .select()
        .from(schema.scratches)
        .where(eq(schema.scratches.id, "11111111-2222-4333-8444-555555555555"))
        .get();

      expect(row?.resumableAgentCount).toBe(3);
      // Pre-existing rows come out of the migration making no claim, not
      // claiming zero.
      expect(row?.name).toBe("Spike");
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
