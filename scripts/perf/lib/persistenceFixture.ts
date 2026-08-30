/**
 * Real persistence engines on real temp storage.
 *
 * The scenarios these back drive better-sqlite3 + drizzle and electron-store
 * themselves — not a model of them. That distinction is the whole point of the
 * family: a `JSON.stringify` benchmark cannot see WAL growth, transaction
 * batching, an unused index, `ALTER TABLE ... DROP COLUMN` rewriting a table,
 * or the atomic whole-file rewrite electron-store performs on every `set`.
 *
 * `electron/services/persistence/db.ts` cannot be imported here: it does a
 * static `import { app } from "electron"`, which throws outside Electron. So
 * `openProductionShapedDb` reproduces `openDb`'s pragma sequence verbatim and
 * hands the SAME connection to the SAME drizzle adapter with the SAME generated
 * migrations. `persistence.test.ts` parses db.ts and fails if the two pragma
 * lists ever diverge — benchmarking `synchronous = OFF` while production runs
 * `NORMAL` would report a number the product never gets.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../../../electron/services/persistence/schema";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

export const MIGRATIONS_FOLDER = join(repoRoot, "electron/services/persistence/migrations");
export const DB_SOURCE_PATH = join(repoRoot, "electron/services/persistence/db.ts");

/**
 * `openDb`'s pragma sequence, in its order. Order matters: `journal_mode = WAL`
 * has to land before anything writes, and the rest are session settings the
 * measurements inherit. Kept as strings so the sync test can diff them against
 * db.ts's source rather than against a hand-written summary.
 */
export const PRODUCTION_PRAGMAS: readonly string[] = [
  "journal_mode = WAL",
  "busy_timeout = 3000",
  "synchronous = NORMAL",
  "temp_store = MEMORY",
  "mmap_size = 10737418240",
  "cache_size = -65536",
  "journal_size_limit = 5242880",
  "foreign_keys = ON",
];

let tempRoot: string | null = null;

/**
 * Every SQLite connection this fixture (or a scenario using it) opens.
 *
 * Tracked because deleting the scratch root while a handle is open works on
 * POSIX and fails on Windows: NTFS refuses to unlink an open .db/-wal/-shm, the
 * error is swallowed by the best-effort cleanup, and the directory is
 * abandoned. Closing first is the only portable order.
 */
const openConnections = new Set<Database.Database>();

export function trackConnection<T extends Database.Database>(connection: T): T {
  openConnections.add(connection);
  return connection;
}

export function closeConnection(connection: Database.Database): void {
  openConnections.delete(connection);
  try {
    connection.close();
  } catch {
    // Already closed.
  }
}

function closeAllConnections(): void {
  for (const connection of openConnections) {
    try {
      connection.close();
    } catch {
      // Already closed.
    }
  }
  openConnections.clear();
}

/** Lazily-created scratch root, removed on process exit. */
export function getTempRoot(): string {
  if (!tempRoot) {
    tempRoot = mkdtempSync(join(tmpdir(), "daintree-perf-persistence-"));
    process.on("exit", () => {
      cleanupTempRoot();
    });
  }
  return tempRoot;
}

/**
 * Explicit teardown for callers that never reach an `exit` handler. Vitest's
 * forked workers are torn down by signal, so a test that used this fixture
 * would otherwise leave a few megabytes of database behind on every run.
 */
export function cleanupTempRoot(): void {
  closeAllConnections();
  seededHandle = null;
  for (const dir of [tempRoot, ownedUserDataDir]) {
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup.
    }
  }
  tempRoot = null;
  ownedUserDataDir = null;
  baselineOnlyFolder = null;
}

export interface DbHandle {
  sqlite: Database.Database;
  db: ReturnType<typeof drizzle<typeof schema>>;
  path: string;
}

/**
 * Open a database exactly the way the product does, minus the Electron-only
 * file-permission tightening (which costs a few `chmod`s and would only add
 * noise to a POSIX-vs-NTFS comparison).
 */
export function openProductionShapedDb(dbPath: string, migrationsFolder?: string): DbHandle {
  const sqlite = trackConnection(new Database(dbPath));
  for (const pragma of PRODUCTION_PRAGMAS) sqlite.pragma(pragma);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder ?? MIGRATIONS_FOLDER });
  return { sqlite, db, path: dbPath };
}

/** Byte size of a database file plus its WAL/SHM sidecars, in KB. */
export function fileKB(path: string): number {
  return existsSync(path) ? statSync(path).size / 1024 : 0;
}

export function walKB(dbPath: string): number {
  return fileKB(`${dbPath}-wal`);
}

// --- Seed population ---------------------------------------------------------

/**
 * Worst-case-plausible rather than median, the same call PERF-080's fixture
 * makes. Seeded with the median user's twelve projects an index lookup and a
 * full table scan report the same number, and the scenario measures nothing.
 */
export const SEED_PROJECT_COUNT = 4000;
export const SEED_SCRATCH_COUNT = 1200;
export const SEED_APP_STATE_KEYS = 16;
const APP_STATE_BLOB_BYTES = 48 * 1024;

function projectRow(i: number): typeof schema.projects.$inferInsert {
  return {
    id: `perf-project-${i}`,
    path: `/Users/perf/code/repo-${String(i).padStart(5, "0")}`,
    name: `Repository ${String(i).padStart(5, "0")}`,
    emoji: "🌳",
    lastOpened: 1_700_000_000_000 + i * 1_000,
    color: i % 3 === 0 ? "#3f9d6d" : null,
    status: i % 5 === 0 ? "closed" : "background",
    pinned: i % 40 === 0 ? 1 : 0,
    frecencyScore: 0.5 + (i % 97) / 10,
    lastAccessedAt: 1_700_000_000_000 + i * 1_500,
    statsCommitCount: i * 7,
    statsIssueCount: i % 23,
    statsPrCount: i % 11,
    statsProviderId: "github",
    statsLastUpdated: 1_700_000_000_000 + i * 900,
  };
}

function scratchRow(i: number): typeof schema.scratches.$inferInsert {
  return {
    id: `perf-scratch-${i}`,
    path: `/Users/perf/scratch/pad-${String(i).padStart(5, "0")}`,
    name: `Scratch ${i}`,
    createdAt: 1_700_000_000_000 + i * 500,
    lastOpened: 1_700_000_000_000 + i * 750,
    deletedAt: i % 17 === 0 ? 1_700_500_000_000 : null,
    resumableAgentCount: i % 4,
  };
}

/** A stand-in for the window manifest and panel-grid blobs the app parks in `app_state`. */
function appStateBlob(i: number): string {
  const entries = [];
  let bytes = 0;
  let n = 0;
  while (bytes < APP_STATE_BLOB_BYTES) {
    const entry = {
      windowId: `win-${i}-${n}`,
      projectId: `perf-project-${(i * 31 + n) % SEED_PROJECT_COUNT}`,
      bounds: { x: n * 3, y: n * 5, width: 1440, height: 900 },
      panelIds: Array.from({ length: 8 }, (_, k) => `panel-${i}-${n}-${k}`),
    };
    entries.push(entry);
    bytes += JSON.stringify(entry).length;
    n += 1;
  }
  return JSON.stringify({ version: 3, windows: entries });
}

export function seedProjects(handle: DbHandle, count: number): number {
  let changed = 0;
  handle.db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      changed += handle.db
        .insert(schema.projects)
        .values(projectRow(i))
        .onConflictDoNothing()
        .run().changes;
    }
  });
  return changed;
}

export function seedScratches(handle: DbHandle, count: number): number {
  let changed = 0;
  handle.db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      changed += handle.db
        .insert(schema.scratches)
        .values(scratchRow(i))
        .onConflictDoNothing()
        .run().changes;
    }
  });
  return changed;
}

export function seedAppState(handle: DbHandle, count: number): number {
  let changed = 0;
  handle.db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      changed += handle.db
        .insert(schema.appState)
        .values({ key: `perf-blob-${i}`, value: appStateBlob(i) })
        .onConflictDoNothing()
        .run().changes;
    }
  });
  return changed;
}

let seededHandle: DbHandle | null = null;

/**
 * The shared, migrated, populated database used by the read/write scenarios.
 * One connection for the whole run: the product holds exactly one shared handle
 * (`getSharedDb`), and reopening per iteration would measure `migrate()` over
 * and over instead of the workload.
 */
export function getSeededDb(): DbHandle {
  if (!seededHandle) {
    const handle = openProductionShapedDb(join(getTempRoot(), "seeded.db"));
    seedProjects(handle, SEED_PROJECT_COUNT);
    seedScratches(handle, SEED_SCRATCH_COUNT);
    seedAppState(handle, SEED_APP_STATE_KEYS);
    seededHandle = handle;
  }
  return seededHandle;
}

/** A row id guaranteed to exist in the seeded population. */
export function seededProjectPath(i: number): string {
  return projectRow(i % SEED_PROJECT_COUNT).path as string;
}

export function seededProjectName(i: number): string {
  return projectRow(i % SEED_PROJECT_COUNT).name as string;
}

export function seededProjectId(i: number): string {
  return `perf-project-${i % SEED_PROJECT_COUNT}`;
}

export function makeProjectRow(i: number): typeof schema.projects.$inferInsert {
  return projectRow(i);
}

// --- Migration fixture -------------------------------------------------------

let baselineOnlyFolder: string | null = null;

/**
 * A copy of the real migrations folder with the journal truncated to the
 * baseline entry, so `migrate()` can be run twice: once to reach the v0
 * schema, and once (timed) to walk the remaining chain over a populated table.
 *
 * A copy of the shipped SQL, not a rewrite of it — the timed pass runs the same
 * `ALTER TABLE`/`UPDATE`/`DROP COLUMN` statements a user's upgrade runs.
 */
export function getBaselineOnlyMigrationsFolder(): string {
  if (!baselineOnlyFolder) {
    const dest = join(getTempRoot(), "migrations-baseline-only");
    cpSync(MIGRATIONS_FOLDER, dest, { recursive: true });
    const journalPath = join(dest, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.slice(0, 1);
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    baselineOnlyFolder = dest;
  }
  return baselineOnlyFolder;
}

/** Migrations SQLite says are recorded as applied, straight from drizzle's table. */
export function appliedMigrationCount(handle: DbHandle): number {
  return handle.sqlite
    .prepare("SELECT COUNT(*) AS c FROM __drizzle_migrations")
    .pluck()
    .get() as number;
}

export function countRealMigrations(): number {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")
  ) as { entries: Array<{ tag: string }> };
  return journal.entries.length;
}

/**
 * Columns the chain must have added by the time it finishes. Read back from
 * `PRAGMA table_info` after the timed migration: a migration that silently did
 * nothing is instant, and without this pairing that reads as a win.
 */
export const POST_MIGRATION_PROJECT_COLUMNS: readonly string[] = [
  "last_completion_seen_at",
  "auto_parked_at",
  "resumable_agent_count",
  "git_backed",
  "stats_commit_count",
  "stats_provider_id",
];

let migrationSeq = 0;

/**
 * A database sitting at the baseline schema with `count` project rows in it,
 * ready for the timed chain. Each call gets its own file — a migration can only
 * be applied once.
 */
export function createPreMigrationDb(count: number): DbHandle {
  migrationSeq += 1;
  const dbPath = join(getTempRoot(), `migrate-${migrationSeq}.db`);
  const sqlite = trackConnection(new Database(dbPath));
  for (const pragma of PRODUCTION_PRAGMAS) sqlite.pragma(pragma);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: getBaselineOnlyMigrationsFolder() });

  // Raw SQL: the drizzle schema describes the CURRENT shape, and the baseline
  // `projects` table has neither `resumable_agent_count` nor `git_backed` yet.
  const insert = sqlite.prepare(
    "INSERT INTO projects (id, path, name, emoji, last_opened, color, status, pinned, frecency_score, last_accessed_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertMany = sqlite.transaction((n: number) => {
    for (let i = 0; i < n; i += 1) {
      const row = projectRow(i);
      insert.run(
        row.id,
        row.path,
        row.name,
        row.emoji,
        row.lastOpened,
        row.color ?? null,
        row.status ?? null,
        // Pre-0009 rows: frecency at the old 3.0 default and an unstamped
        // last_accessed_at, so 0009's two UPDATEs actually rewrite every row
        // instead of matching nothing.
        0,
        3.0,
        0
      );
    }
  });
  insertMany(count);
  return { sqlite, db, path: dbPath };
}

/** Apply the rest of the real chain to a database sitting at the baseline. */
export function migrateToHead(handle: DbHandle): void {
  migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/** Columns present on `projects` right now, straight from SQLite. */
export function projectColumns(handle: DbHandle): Set<string> {
  return new Set(
    (handle.sqlite.pragma("table_info(projects)") as Array<{ name: string }>).map((c) => c.name)
  );
}

export function disposeDb(handle: DbHandle): void {
  closeConnection(handle.sqlite);
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(handle.path + suffix, { force: true });
    } catch {
      // Best-effort.
    }
  }
}

// --- electron-store ----------------------------------------------------------

interface KeyValueStore {
  set: (key: string, value: unknown) => void;
  get: (key: string, defaultValue?: unknown) => unknown;
  path: string;
}

export interface StoreModule {
  /** The exported proxy every product module reads through — cached reads. */
  store: KeyValueStore;
  /** The raw `Conf` instance: uncached reads, straight off disk. */
  initializeStore: () => KeyValueStore;
  _resetStoreInstance: () => void;
  invalidateStoreValueCache: () => void;
}

/**
 * Read once, at module evaluation, BEFORE anything here can import
 * `electron/store.ts`. An inherited value is another perf fixture's temp dir in
 * normal use — but it could equally be a developer's real Daintree profile,
 * and `conf` would then rewrite their live `config.json`. `??=` alone trusts
 * whatever it finds, so the value is validated instead of assumed.
 */
const INHERITED_USER_DATA = process.env.DAINTREE_USER_DATA;

let ownedUserDataDir: string | null = null;

function ensureBenchUserData(): string {
  if (!process.env.DAINTREE_USER_DATA) {
    const dir = join(getTempRoot(), "user-data");
    mkdirSync(dir, { recursive: true });
    ownedUserDataDir = dir;
    process.env.DAINTREE_USER_DATA = dir;
    return dir;
  }
  const dir = process.env.DAINTREE_USER_DATA;
  // Anything outside the OS temp root is presumed to be real user data. Refuse
  // rather than benchmark it: these scenarios WRITE.
  if (!resolve(dir).startsWith(resolve(tmpdir()))) {
    throw new Error(
      `DAINTREE_USER_DATA points outside the temp root (${dir}); refusing to benchmark ` +
        "electron-store against what may be a real Daintree profile."
    );
  }
  return dir;
}

let storeModulePromise: Promise<StoreModule> | null = null;

/**
 * The product's own electron-store wiring: real `conf` defaults, real
 * `clearInvalidConfig`, real `configFileMode: 0o600`, real corrupt-config
 * preflight, real cached-read proxy. Nothing is stubbed; only `cwd` moves.
 *
 * `storeOptions.cwd` is bound from `DAINTREE_USER_DATA` at module-evaluation
 * time, so the variable must be settled before the import — hence the eager
 * capture above and the post-construction path assertion below.
 */
export function loadStoreModule(): Promise<StoreModule> {
  if (!storeModulePromise) {
    const userData = ensureBenchUserData();
    storeModulePromise = import("../../../electron/store").then((module) => {
      const loaded = module as unknown as StoreModule;
      const path = loaded.store.path;
      if (!path.startsWith(userData)) {
        throw new Error(
          `electron-store resolved to ${path}, outside the benchmark user-data dir ` +
            `${userData}. Something imported electron/store.ts before DAINTREE_USER_DATA ` +
            "was set; refusing to write."
        );
      }
      return loaded;
    });
  }
  return storeModulePromise;
}

/** True when this process inherited its user-data dir rather than minting one. */
export function inheritedUserData(): boolean {
  return INHERITED_USER_DATA !== undefined;
}

/**
 * An `appState` snapshot the size a fleet user's really is.
 *
 * `appState` is the largest thing the live config.json carries and the one
 * `CrashRecoveryService` rewrites wholesale (`store.set("appState", ...)`), so
 * it is the honest payload for an atomic-write measurement. The legacy
 * `audit-logs.json` store is NOT: its rings moved to SQLite (`auditRingStore`),
 * and only migrations 022/023 still touch the JSON file.
 */
export function appStateSnapshot(panelCount: number): Record<string, unknown> {
  return {
    activeWorktreeId: "wt-perf-0",
    focusMode: false,
    terminals: Array.from({ length: panelCount }, (_, i) => ({
      id: `panel-${i}`,
      worktreeId: `wt-perf-${i % 24}`,
      title: `agent ${i} — feature/some-reasonably-long-branch-name-${i}`,
      cwd: `/Users/perf/code/repo-${String(i % 200).padStart(5, "0")}/packages/app`,
      command: i % 3 === 0 ? "claude --dangerously-skip-permissions" : "codex",
      location: i % 5 === 0 ? "dock" : "grid",
      agentState: i % 4 === 0 ? "working" : "waiting",
      lastStateChange: 1_700_000_000_000 + i * 911,
      env: { DAINTREE_PANEL: `panel-${i}`, PATH_HINT: "/usr/local/bin:/usr/bin" },
    })),
    mruList: Array.from({ length: Math.min(panelCount, 64) }, (_, i) => `panel-${i}`),
  };
}
