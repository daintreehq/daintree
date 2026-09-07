/**
 * The two durable-state engines, driven for real.
 *
 * PERF-050..052 used to live here and measured `JSON.stringify`/`JSON.parse`
 * over a synthetic object — neither SQLite nor electron-store was ever touched,
 * and PERF-050 returned a hardcoded `durationMs: 0` while reporting only
 * `bytes`. They were removed; the pure serialization cost they stood in for is
 * already measured, against real app state, by PERF-070..073.
 *
 * Every scenario reports SQL statement and transaction counts, or byte counts,
 * alongside its durations: those survive a hardware change and are what a
 * Windows run can actually be compared against. Each is paired with a `*Misses`
 * reading, because a write that silently no-ops is infinitely fast.
 */

import Database from "better-sqlite3";
import { desc, eq } from "drizzle-orm";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import type { PerfScenario, ScenarioSample } from "../types";
import { armBystanderProbe, bystanderMetrics } from "../lib/bystander";
import { percentile } from "../lib/stats";
import * as schema from "../../../electron/services/persistence/schema";
import {
  appliedMigrationCount,
  appStateSnapshot,
  closeConnection,
  countRealMigrations,
  createPreMigrationDb,
  disposeDb,
  getSeededDb,
  getTempRoot,
  loadStoreModule,
  makeProjectRow,
  migrateToHead,
  openProductionShapedDb,
  POST_MIGRATION_PROJECT_COLUMNS,
  projectColumns,
  SEED_PROJECT_COUNT,
  seededProjectName,
  seededProjectPath,
  trackConnection,
  walKB,
  createProjectStateFixture,
  withProjectStateCounters,
  type ProjectStateFixture,
} from "../lib/persistenceFixture";

const BATCH_ROWS = 200;
const LOOKUPS = 200;
const WAL_TRANSACTIONS = 40;
const WAL_ROWS_PER_TRANSACTION = 25;
const APP_STATE_PANELS = 400;
const SETTINGS_WRITES = 12;
const KEY_READS = 200;
const STATE_PANELS = 40;
/**
 * Bursts per measured window.
 *
 * One burst is far too short to describe a loop: a coalesced K=20 burst is two
 * atomic writes, which at a 4ms cadence can finish between two probe ticks and
 * leave a single gap equal to the whole burst. A percentile over that is the
 * burst duration wearing a percentile's name. Ten back-to-back bursts give both
 * arms a real gap distribution and match the thing being claimed anyway —
 * sustained layout traffic during a fleet launch, not one isolated write.
 */
const STATE_BURST_REPEATS = 10;
const STATE_PROBE_CADENCE_MS = 4;

const MIGRATION_COUNT = countRealMigrations();

let batchSeq = 0;
let walSeq = 0;

/** A project row namespaced to one iteration, so iterations never collide. */
function batchRow(prefix: string, i: number): typeof schema.projects.$inferInsert {
  return {
    ...makeProjectRow(SEED_PROJECT_COUNT + i),
    id: `${prefix}-${i}`,
    path: `/Users/perf/batch/${prefix}/${i}`,
    name: `${prefix} ${i}`,
  };
}

// --- PERF-053: transaction batching ------------------------------------------

function runBatchingScenario(): ScenarioSample {
  const handle = getSeededDb();
  batchSeq += 1;
  const perRowPrefix = `perf-batch-row-${batchSeq}`;
  const txnPrefix = `perf-batch-txn-${batchSeq}`;

  const walBefore = walKB(handle.path);

  // Autocommit. better-sqlite3 wraps each statement in its own implicit
  // transaction, so this is one commit per row — the shape ProjectStore uses
  // today, where nothing batches.
  let perRowChanges = 0;
  const perRowStart = performance.now();
  for (let i = 0; i < BATCH_ROWS; i += 1) {
    perRowChanges += handle.db
      .insert(schema.projects)
      .values(batchRow(perRowPrefix, i))
      .onConflictDoUpdate({
        target: schema.projects.id,
        set: { lastOpened: 1_800_000_000_000 + i },
      })
      .run().changes;
  }
  const perRowMs = performance.now() - perRowStart;

  let txnChanges = 0;
  const txnStart = performance.now();
  handle.db.transaction(() => {
    for (let i = 0; i < BATCH_ROWS; i += 1) {
      txnChanges += handle.db
        .insert(schema.projects)
        .values(batchRow(txnPrefix, i))
        .onConflictDoUpdate({
          target: schema.projects.id,
          set: { lastOpened: 1_800_000_000_000 + i },
        })
        .run().changes;
    }
  });
  const txnMs = performance.now() - txnStart;

  // Both phases claim the same statement count. A phase that wrote nothing
  // would post the better duration, so count what is actually on disk.
  const countPrefix = (prefix: string): number =>
    handle.sqlite
      .prepare("SELECT COUNT(*) AS c FROM projects WHERE id LIKE ?")
      .pluck()
      .get(`${prefix}-%`) as number;
  const rowMisses = BATCH_ROWS - countPrefix(perRowPrefix) + (BATCH_ROWS - countPrefix(txnPrefix));

  const walAfter = walKB(handle.path);

  // Outside both timed regions, and batched so it cannot dominate the next
  // iteration's WAL reading.
  handle.db.transaction(() => {
    for (let i = 0; i < BATCH_ROWS; i += 1) {
      handle.db
        .delete(schema.projects)
        .where(eq(schema.projects.id, `${perRowPrefix}-${i}`))
        .run();
      handle.db
        .delete(schema.projects)
        .where(eq(schema.projects.id, `${txnPrefix}-${i}`))
        .run();
    }
  });

  return {
    durationMs: perRowMs + txnMs,
    metrics: {
      perRowMs,
      txnMs,
      perRowStatementCount: BATCH_ROWS,
      txnStatementCount: BATCH_ROWS,
      // The pair this scenario exists to expose: identical statement counts,
      // two orders of magnitude apart in commits.
      perRowTransactionCount: BATCH_ROWS,
      txnTransactionCount: 1,
      batchSpeedupRatio: txnMs > 0 ? perRowMs / txnMs : 0,
      rowsChangedCount: perRowChanges + txnChanges,
      rowMisses,
      // Absolute as well as delta: past the first iteration the journal is at
      // steady state and reuses its pages in place, so growth alone reads as
      // zero on a WAL that is in fact megabytes wide.
      walKB: walAfter,
      walGrowthKB: Math.max(0, walAfter - walBefore),
    },
  };
}

// --- PERF-054: query shapes ---------------------------------------------------

function queryPlan(sqlite: Database.Database, sql: string, params: unknown[]): string {
  return (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join(" | ");
}

function runQueryShapeScenario(): ScenarioSample {
  const handle = getSeededDb();

  // Probe the TAIL of the table. better-sqlite3's `get()` steps the statement
  // once, so an equality scan stops at the matching row: probing row 7 makes a
  // full scan look like an index lookup and the whole comparison evaporates.
  const probeIndex = (i: number): number => SEED_PROJECT_COUNT - 1 - (i % LOOKUPS);

  // getProjectByPath()'s query, served by projects_path_idx — through drizzle,
  // which is how ProjectStore actually issues it.
  let drizzleHits = 0;
  const drizzleStart = performance.now();
  for (let i = 0; i < LOOKUPS; i += 1) {
    const row = handle.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.path, seededProjectPath(probeIndex(i))))
      .get();
    if (row) drizzleHits += 1;
  }
  const drizzleIndexedMs = performance.now() - drizzleStart;

  // The same two queries at the SQLite layer, prepared once from drizzle's OWN
  // generated SQL rather than from hand-written statements. Splitting the layers
  // matters: drizzle rebuilds and re-prepares on every call, and that cost is
  // large enough to hide the index entirely if the two are measured together.
  const indexedSql = handle.db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.path, seededProjectPath(0)))
    .toSQL();
  const scanSql = handle.db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.name, seededProjectName(0)))
    .toSQL();
  const orderedSql = handle.db
    .select()
    .from(schema.projects)
    .orderBy(desc(schema.projects.frecencyScore), desc(schema.projects.lastOpened))
    .toSQL();

  const rawIndexed = handle.sqlite.prepare(indexedSql.sql);
  const rawScan = handle.sqlite.prepare(scanSql.sql);

  let rawIndexedHits = 0;
  const rawIndexedStart = performance.now();
  for (let i = 0; i < LOOKUPS; i += 1) {
    if (rawIndexed.get(seededProjectPath(probeIndex(i)))) rawIndexedHits += 1;
  }
  const rawIndexedMs = performance.now() - rawIndexedStart;

  // `name` carries no index, so this is the identical lookup returning the
  // identical row, forced into a table scan.
  let rawScanHits = 0;
  const rawScanStart = performance.now();
  for (let i = 0; i < LOOKUPS; i += 1) {
    if (rawScan.get(seededProjectName(probeIndex(i)))) rawScanHits += 1;
  }
  const rawScanMs = performance.now() - rawScanStart;

  // getAllProjects()'s ordering, which projects_frecency_last_opened_idx is
  // declared ASC/ASC specifically to serve by reverse scan.
  const orderedStart = performance.now();
  const ordered = handle.db
    .select()
    .from(schema.projects)
    .orderBy(desc(schema.projects.frecencyScore), desc(schema.projects.lastOpened))
    .all();
  const orderedListMs = performance.now() - orderedStart;

  const indexedPlan = queryPlan(handle.sqlite, indexedSql.sql, indexedSql.params);
  const scanPlan = queryPlan(handle.sqlite, scanSql.sql, scanSql.params);
  const orderedPlan = queryPlan(handle.sqlite, orderedSql.sql, orderedSql.params);

  // Structural and machine-independent. A dropped index changes the plan long
  // before it moves a p95, so the plan is the reading that survives; the
  // duration is the one that lies. The scan arm is asserted too — if `name`
  // ever gains an index the comparison silently becomes index-vs-index.
  const indexPlanMisses =
    (indexedPlan.includes("projects_path_idx") ? 0 : 1) +
    (scanPlan.includes("SCAN projects") ? 0 : 1) +
    (orderedPlan.includes("projects_frecency_last_opened_idx") ? 0 : 1) +
    (orderedPlan.includes("USE TEMP B-TREE") ? 1 : 0);

  return {
    durationMs: drizzleIndexedMs + rawIndexedMs + rawScanMs + orderedListMs,
    metrics: {
      drizzleIndexedMs,
      rawIndexedMs,
      rawScanMs,
      orderedListMs,
      indexSpeedupRatio: rawIndexedMs > 0 ? rawScanMs / rawIndexedMs : 0,
      // How much of a project lookup is drizzle rather than SQLite.
      drizzleOverheadRatio: rawIndexedMs > 0 ? drizzleIndexedMs / rawIndexedMs : 0,
      statementCount: LOOKUPS * 3 + 1,
      rowsReturnedCount: drizzleHits + rawIndexedHits + rawScanHits + ordered.length,
      lookupMisses: LOOKUPS - drizzleHits + (LOOKUPS - rawIndexedHits) + (LOOKUPS - rawScanHits),
      indexPlanMisses,
      orderedRowMisses: ordered.length === SEED_PROJECT_COUNT ? 0 : 1,
    },
  };
}

// --- PERF-055: WAL growth, concurrent reader, checkpoint ----------------------

let walHandle: ReturnType<typeof openProductionShapedDb> | null = null;
let walReader: Database.Database | null = null;

function getWalHarness(): {
  handle: NonNullable<typeof walHandle>;
  reader: Database.Database;
} {
  if (!walHandle) walHandle = openProductionShapedDb(join(getTempRoot(), "wal.db"));
  if (!walReader) {
    walReader = trackConnection(new Database(walHandle.path, { readonly: true }));
    walReader.pragma("busy_timeout = 3000");
  }
  return { handle: walHandle, reader: walReader };
}

function runWalScenario(): ScenarioSample {
  const { handle, reader } = getWalHarness();
  walSeq += 1;
  const prefix = `perf-wal-${walSeq}`;

  handle.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  const walStartKB = walKB(handle.path);

  const countRows = reader.prepare("SELECT COUNT(*) AS c FROM projects").pluck();
  // Exact, not a floor: the table carries rows from earlier iterations, so
  // "at least N" would let a stale read pass as a fresh one.
  const baselineRows = countRows.get() as number;
  let readerBusyRetries = 0;
  let readerReadCount = 0;
  let readerRowMisses = 0;

  const writeStart = performance.now();
  for (let t = 0; t < WAL_TRANSACTIONS; t += 1) {
    handle.db.transaction(() => {
      for (let i = 0; i < WAL_ROWS_PER_TRANSACTION; i += 1) {
        const n = t * WAL_ROWS_PER_TRANSACTION + i;
        handle.db
          .insert(schema.projects)
          .values(batchRow(prefix, n))
          .onConflictDoUpdate({ target: schema.projects.id, set: { lastOpened: n } })
          .run();
      }
    });
    // WAL's headline property: a reader on its own connection is never blocked
    // by the writer. Counted rather than assumed — a journal-mode regression
    // surfaces here as SQLITE_BUSY, not as a slower number.
    try {
      const seen = countRows.get() as number;
      readerReadCount += 1;
      if (seen !== baselineRows + (t + 1) * WAL_ROWS_PER_TRANSACTION) readerRowMisses += 1;
    } catch {
      readerBusyRetries += 1;
    }
  }
  const walWriteMs = performance.now() - writeStart;
  const walPeakKB = walKB(handle.path);

  // Write-lock contention, bounded rather than waited out: the writer holds an
  // IMMEDIATE transaction while a third connection tries to write behind a
  // 50ms busy timeout. Production's own timeout is 3000ms, which would turn
  // this probe into a three-second sleep and measure the constant, not the lock.
  const contender = trackConnection(new Database(handle.path));
  contender.pragma("busy_timeout = 50");
  let writeLockBusyCount = 0;
  let contentionProbeMisses = 0;
  const contentionStart = performance.now();
  try {
    handle.sqlite.exec("BEGIN IMMEDIATE");
    try {
      contender.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run(prefix, "probe");
      // No SQLITE_BUSY means the write lock was never actually held, so the
      // probe measured nothing. Say so rather than reporting a clean zero.
      contentionProbeMisses = 1;
    } catch (error) {
      if (String((error as { code?: string }).code ?? "").startsWith("SQLITE_BUSY")) {
        writeLockBusyCount = 1;
      } else {
        contentionProbeMisses = 1;
      }
    }
  } finally {
    handle.sqlite.exec("ROLLBACK");
    closeConnection(contender);
  }
  const contentionProbeMs = performance.now() - contentionStart;

  const checkpointStart = performance.now();
  handle.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  const checkpointMs = performance.now() - checkpointStart;
  const walAfterKB = walKB(handle.path);

  const written = WAL_TRANSACTIONS * WAL_ROWS_PER_TRANSACTION;
  const countWritten = handle.sqlite
    .prepare("SELECT COUNT(*) AS c FROM projects WHERE id LIKE ?")
    .pluck();
  const persisted = countWritten.get(`${prefix}-%`) as number;

  handle.db.transaction(() => {
    for (let n = 0; n < written; n += 1) {
      handle.db
        .delete(schema.projects)
        .where(eq(schema.projects.id, `${prefix}-${n}`))
        .run();
    }
  });
  // Verified, not assumed: an unverified cleanup that quietly failed would grow
  // the table every iteration and make each one slower than the last.
  const cleanupMisses = countWritten.get(`${prefix}-%`) as number;

  return {
    // The write path plus the checkpoint, deliberately excluding the
    // contention probe: that arm is pinned to the contender's 50ms busy
    // timeout, so folding it in would put a fixed floor under the headline and
    // blunt it against exactly the regressions it is here to catch. The probe
    // reports separately as `contentionProbeMs`.
    durationMs: walWriteMs + checkpointMs,
    metrics: {
      walWriteMs,
      checkpointMs,
      contentionProbeMs,
      walStartKB,
      walPeakKB,
      walAfterKB,
      // TRUNCATE reclaims the journal to zero bytes. "Smaller than the peak"
      // would pass on a partial PASSIVE checkpoint, which is the regression
      // this reading exists to catch.
      checkpointReclaimMisses: walAfterKB === 0 ? 0 : 1,
      transactionCount: WAL_TRANSACTIONS,
      statementCount: written,
      readerReadCount,
      readerBusyRetries,
      readerRowMisses,
      writeLockBusyCount,
      contentionProbeMisses,
      rowMisses: written - persisted,
      cleanupMisses,
    },
  };
}

// --- PERF-056: drizzle migration chain over a populated database --------------

function runMigrationScenario(): ScenarioSample {
  const handle = createPreMigrationDb(SEED_PROJECT_COUNT);
  try {
    const seedRowCount = handle.sqlite
      .prepare("SELECT COUNT(*) AS c FROM projects")
      .pluck()
      .get() as number;

    // The real drizzle migrator over the real generated SQL. 0009's two
    // full-table UPDATEs and 0012's `DROP COLUMN` table rewrite are the
    // O(rows) steps a populated database pays for and an empty one does not —
    // which is the axis PERF-080 (the electron-store JSON chain) never touches.
    const appliedBefore = appliedMigrationCount(handle);
    const start = performance.now();
    migrateToHead(handle);
    const migrateMs = performance.now() - start;
    // Read out of `__drizzle_migrations`, not counted off the journal: drizzle
    // decides applicability by timestamp alone, so a chain that applied nothing
    // (or half of itself) is otherwise indistinguishable from a fast one.
    const appliedCount = appliedMigrationCount(handle) - appliedBefore;

    // Untimed: in WAL mode the migrated pages are still in the journal, so
    // stat'ing the main file before a checkpoint reports 4 KB for a 4000-row
    // database.
    handle.sqlite.pragma("wal_checkpoint(TRUNCATE)");

    const columns = projectColumns(handle);
    const schemaColumnMisses = POST_MIGRATION_PROJECT_COLUMNS.filter(
      (name) => !columns.has(name)
    ).length;
    const survivingRows = handle.sqlite
      .prepare("SELECT COUNT(*) AS c FROM projects")
      .pluck()
      .get() as number;
    // 0009 rebases every row's frecency off the 3.0 default; a chain that ran
    // but skipped its data migrations would leave these untouched.
    const unrebasedRows = handle.sqlite
      .prepare("SELECT COUNT(*) AS c FROM projects WHERE frecency_score = 3.0")
      .pluck()
      .get() as number;

    return {
      durationMs: migrateMs,
      metrics: {
        migrateMs,
        migrationCount: appliedCount,
        migrationCountMisses: appliedCount === MIGRATION_COUNT - 1 ? 0 : 1,
        seedRowCount,
        dbFileKB: statSync(handle.path).size / 1024,
        msPerKRow: (migrateMs * 1000) / Math.max(1, seedRowCount),
        schemaColumnMisses,
        rowMisses: seedRowCount - survivingRows,
        dataMigrationMisses: unrebasedRows,
      },
    };
  } finally {
    disposeDb(handle);
  }
}

// --- PERF-057/058: electron-store atomic writes -------------------------------

async function runStoreWriteScenario(): Promise<ScenarioSample> {
  const { store } = await loadStoreModule();
  const snapshot = appStateSnapshot(APP_STATE_PANELS);
  const payloadBytes = JSON.stringify(snapshot).length;

  // The crash-recovery snapshot write, through the exported proxy every product
  // module uses: cache invalidation, then conf's atomic whole-file rewrite.
  const fullStart = performance.now();
  store.set("appState", snapshot);
  const fullWriteMs = performance.now() - fullStart;
  const configBytes = statSync(store.path).size;

  // The #9926 shape: every `set` re-serializes and rewrites the WHOLE file, so
  // an ordinary settings toggle costs a full config.json write once appState is
  // large. Each write is confirmed on disk individually — checking only the
  // final state would let the first eleven silently no-op.
  let appendBytes = 0;
  let changedBytes = 0;
  let writeMisses = 0;
  let appendMs = 0;
  for (let i = 0; i < SETTINGS_WRITES; i += 1) {
    const value = 1000 + i;
    const writeStart = performance.now();
    store.set("terminalConfig.scrollbackLines", value);
    // Only the write is timed. The verification read below re-parses the whole
    // config and would otherwise inflate the per-write number it exists to check.
    appendMs += performance.now() - writeStart;
    appendBytes += statSync(store.path).size;
    changedBytes += String(value).length;
    const onDisk = JSON.parse(readFileSync(store.path, "utf8")) as {
      terminalConfig?: { scrollbackLines?: number };
    };
    if (onDisk.terminalConfig?.scrollbackLines !== value) writeMisses += 1;
  }

  // Read the bytes back off disk rather than out of the proxy's cache: a failed
  // atomic write leaves the cache correct and the file stale, which is exactly
  // the silent no-op this pairing exists to catch.
  const finalOnDisk = JSON.parse(readFileSync(store.path, "utf8")) as {
    appState?: { terminals?: unknown[] };
  };

  return {
    durationMs: fullWriteMs + appendMs,
    metrics: {
      fullWriteMs,
      settingsWriteMs: appendMs,
      msPerSettingsWrite: appendMs / SETTINGS_WRITES,
      storeWrites: 1 + SETTINGS_WRITES,
      panelCount: APP_STATE_PANELS,
      payloadBytes,
      configBytes,
      bytesWritten: configBytes + appendBytes,
      // Bytes rewritten per byte of setting actually changed. A four-character
      // scrollback edit costs the whole file, every time.
      writeAmplificationRatio: appendBytes / Math.max(1, changedBytes),
      writeMisses,
      readBackMisses: finalOnDisk.appState?.terminals?.length === APP_STATE_PANELS ? 0 : 1,
    },
  };
}

async function runStoreOpenScenario(): Promise<ScenarioSample> {
  const module = await loadStoreModule();
  const { store, initializeStore, _resetStoreInstance, invalidateStoreValueCache } = module;

  // Prime config.json with a realistic body once, through the real store, so
  // every subsequent open pays a real parse plus the corrupt-config preflight.
  store.set("appState", appStateSnapshot(APP_STATE_PANELS));
  const configPath = store.path;
  const configBytes = statSync(configPath).size;

  _resetStoreInstance();
  invalidateStoreValueCache();
  const openStart = performance.now();
  const raw = initializeStore();
  const openMs = performance.now() - openStart;

  // Two read paths, measured separately because they differ by orders of
  // magnitude and the product uses only one of them. `conf` has no cache: every
  // raw `get()` re-reads and re-parses config.json. The exported proxy takes
  // one snapshot and serves the rest from memory — which is the number that
  // describes the running app.
  let uncachedHits = 0;
  const uncachedStart = performance.now();
  for (let i = 0; i < KEY_READS; i += 1) {
    if (raw.get("terminalConfig") !== undefined) uncachedHits += 1;
  }
  const uncachedKeyReadMs = performance.now() - uncachedStart;

  invalidateStoreValueCache();
  let cachedHits = 0;
  const cachedStart = performance.now();
  for (let i = 0; i < KEY_READS; i += 1) {
    if (store.get("terminalConfig") !== undefined) cachedHits += 1;
  }
  const cachedKeyReadMs = performance.now() - cachedStart;

  const terminals = (store.get("appState") as { terminals?: unknown[] } | undefined)?.terminals;
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;

  return {
    durationMs: openMs + uncachedKeyReadMs + cachedKeyReadMs,
    metrics: {
      openMs,
      uncachedKeyReadMs,
      cachedKeyReadMs,
      readCacheSpeedupRatio: cachedKeyReadMs > 0 ? uncachedKeyReadMs / cachedKeyReadMs : 0,
      configBytes,
      keyReadCount: KEY_READS * 2,
      keyReadMisses: KEY_READS - uncachedHits + (KEY_READS - cachedHits),
      // The reopened store must carry the primed data forward. An
      // electron-store that quietly reset to defaults opens fastest of all.
      hydrationMisses:
        (terminals?.length === APP_STATE_PANELS ? 0 : 1) +
        (parsed.terminalConfig === undefined ? 1 : 0),
    },
  };
}

// --- PERF-406/407: coalescing the project-state write queue -------------------

interface BurstExpectation {
  key: string;
  value: string;
}

/**
 * One burst: K updates fired with NO await between them, exactly as the
 * per-field IPC handlers do during a drag or a fleet launch.
 *
 * Every update writes a UNIQUE draft key, so the on-disk oracle proves all K
 * landed. Overwriting one shared field instead would prove only that the last
 * writer ran — the coalescing failure mode that drops the middle of a burst
 * would score perfectly. A rotating second field keeps the shape realistic
 * without weakening that.
 */
async function fireStateBurst(
  fixture: ProjectStateFixture,
  burstSize: number,
  round: number,
  latencies: number[]
): Promise<BurstRun> {
  const expected: BurstExpectation[] = Array.from({ length: burstSize }, (_, i) => ({
    key: `burst-${round}-${i}`,
    value: `draft-${round}-${i}`,
  }));

  const settled = await Promise.allSettled(
    expected.map(({ key, value }, i) => {
      const startedAt = performance.now();
      return fixture.manager
        .enqueueProjectStateUpdate(fixture.projectId, (existing) => {
          if (!existing) return null;
          const next = {
            ...existing,
            draftInputs: { ...existing.draftInputs, [key]: value },
          };
          // A rotating second field, so the burst touches the spread of state a
          // real layout change does rather than one key repeatedly.
          switch (i % 4) {
            case 0:
              return { ...next, sidebarWidth: 320 + (i % 60) };
            case 1:
              return { ...next, focusMode: i % 8 === 1 };
            case 2:
              return { ...next, activeWorktreeId: `wt-perf-${i % 24}` };
            default:
              return {
                ...next,
                terminalSizes: {
                  ...next.terminalSizes,
                  [`panel-${i % STATE_PANELS}`]: { cols: 100 + (i % 40), rows: 30 + (i % 20) },
                },
              };
          }
        })
        .then(() => {
          latencies.push(performance.now() - startedAt);
        });
    })
  );

  return {
    enqueued: settled.length,
    fulfilled: settled.filter((s) => s.status === "fulfilled").length,
    rejected: settled.filter((s) => s.status === "rejected").length,
  };
}

/**
 * Every key the whole workload owes, built BEFORE any of it runs.
 *
 * Deriving the expectation from what executed is the trap this avoids: a loop
 * that skipped rounds would shrink its own oracle to match, and a workload that
 * did nothing at all would be graded against an empty list and post the best
 * numbers in the suite.
 */
function burstExpectations(burstSize: number): BurstExpectation[] {
  const expected: BurstExpectation[] = [];
  for (let round = 0; round < STATE_BURST_REPEATS; round += 1) {
    for (let i = 0; i < burstSize; i += 1) {
      expected.push({ key: `burst-${round}-${i}`, value: `draft-${round}-${i}` });
    }
  }
  return expected;
}

interface BurstRun {
  /** Updates actually handed to the queue. */
  enqueued: number;
  /** Promises that came back fulfilled. */
  fulfilled: number;
  /** Promises that came back rejected. */
  rejected: number;
}

async function runStateBurstWorkload(
  fixture: ProjectStateFixture,
  burstSize: number,
  latencies: number[]
): Promise<BurstRun> {
  const run: BurstRun = { enqueued: 0, fulfilled: 0, rejected: 0 };
  for (let round = 0; round < STATE_BURST_REPEATS; round += 1) {
    const outcome = await fireStateBurst(fixture, burstSize, round, latencies);
    run.enqueued += outcome.enqueued;
    run.fulfilled += outcome.fulfilled;
    run.rejected += outcome.rejected;
  }
  return run;
}

/** Read back what actually landed, never what the manager's cache believes. */
async function readStateFromDisk(fixture: ProjectStateFixture): Promise<{
  draftInputs?: Record<string, string>;
  terminals?: Array<{ title?: string; cwd?: string }>;
  tabGroups?: unknown[];
  mruList?: unknown[];
}> {
  return JSON.parse(await readFile(fixture.filePath, "utf8"));
}

/**
 * Everything the burst was supposed to leave alone, plus everything it was
 * supposed to change. Graded on BOTH passes.
 *
 * Counting terminals is not preservation: a save that kept 40 entries but
 * stripped their titles and paths writes a much smaller payload and would score
 * better on every number this scenario reports.
 */
function stateBurstMisses(
  onDisk: Awaited<ReturnType<typeof readStateFromDisk>>,
  expected: BurstExpectation[]
): { updateMisses: number; preservationMisses: number } {
  const drafts = onDisk.draftInputs ?? {};
  const terminals = onDisk.terminals ?? [];
  let preservationMisses = 0;

  if (terminals.length !== STATE_PANELS) preservationMisses += 1;
  if ((onDisk.tabGroups?.length ?? 0) !== Math.ceil(STATE_PANELS / 8)) preservationMisses += 1;
  if ((onDisk.mruList?.length ?? 0) !== 24) preservationMisses += 1;
  // The seeded payload itself, not just its shape: these strings are most of
  // the bytes the coalescing is supposed to stop rewriting.
  if (terminals.some((t) => !t.title || !t.cwd)) preservationMisses += 1;
  // A seeded draft, which the burst adds to and must never replace wholesale.
  if (drafts["panel-0"] === undefined) preservationMisses += 1;

  return {
    updateMisses: expected.filter(({ key, value }) => drafts[key] !== value).length,
    preservationMisses,
  };
}

async function runStateBurstScenario(burstSize: number): Promise<ScenarioSample> {
  // Owed up front, so a workload that ran fewer rounds than it claims is graded
  // against what it PROMISED rather than against what it happened to do.
  const expected = burstExpectations(burstSize);

  // PASS 1 — timing and main-thread availability, with NO global instrumentation
  // installed. The counter proxies in pass 2 cost a trap per clone and per
  // stringify, which is work proportional to exactly the operations under
  // measurement; counting and timing in one window inflates the number the
  // counts exist to explain.
  const timed = await createProjectStateFixture(STATE_PANELS);
  let burstMs: number;
  let reading;
  let timedRun: BurstRun;
  const latencies: number[] = [];
  let onDiskTimed;

  try {
    // The probe's own window must not inherit a collection that fell due for
    // the fixture build.
    globalThis.gc?.();
    const probe = await armBystanderProbe({ cadenceMs: STATE_PROBE_CADENCE_MS });
    const startedAt = performance.now();
    let endedAt = startedAt;
    try {
      timedRun = await runStateBurstWorkload(timed, burstSize, latencies);
    } finally {
      // Workload end recorded BEFORE any analysis: `stop()` sorts the gap list
      // to compute percentiles, and that work is not the subject.
      endedAt = performance.now();
      probe.stop();
    }
    // Idempotent, and analysed once — this returns the reading `stop()` already
    // computed rather than recomputing it.
    reading = probe.stop();
    burstMs = endedAt - startedAt;
    onDiskTimed = await readStateFromDisk(timed);
  } finally {
    timed.dispose();
  }

  // PASS 2 — the same workload on a fresh fixture, counted.
  const counted = await createProjectStateFixture(STATE_PANELS);
  let counts;
  let countedRun: BurstRun;
  let onDiskCounted;
  try {
    const outcome = await withProjectStateCounters(counted, () =>
      runStateBurstWorkload(counted, burstSize, [])
    );
    counts = outcome.counts;
    countedRun = outcome.result;
    onDiskCounted = await readStateFromDisk(counted);
  } finally {
    counted.dispose();
  }

  // Both passes are graded. A pass that silently dropped half a burst would
  // otherwise hide behind the other one's clean predicate.
  const timedMisses = stateBurstMisses(onDiskTimed, expected);
  const countedMisses = stateBurstMisses(onDiskCounted, expected);

  const owed = expected.length;
  const enqueued = timedRun.enqueued + countedRun.enqueued;
  const fulfilled = timedRun.fulfilled + countedRun.fulfilled;

  return {
    durationMs: burstMs,
    metrics: {
      burstSize,
      burstRepeats: STATE_BURST_REPEATS,
      // What the scenario OWES, and what it actually handed to the queue. The
      // floors below sit on the observed pair, so a fixture or loop that quietly
      // scaled itself down is a measurement failure rather than a better number.
      updatesRequested: owed,
      updatesEnqueued: enqueued,
      updatesFulfilled: fulfilled,
      fixturePanelCount: onDiskTimed.terminals?.length ?? 0,

      // The headline: how many durable writes a burst of `burstSize` costs.
      saves: counts.saves,
      savesPerBurst: counts.saves / STATE_BURST_REPEATS,
      atomicReplaces: counts.atomicReplaces,
      clones: counts.clones,
      clonesPerBurst: counts.clones / STATE_BURST_REPEATS,
      stringifyBytes: counts.stringifyBytes,
      stringifyBytesPerBurst: counts.stringifyBytes / STATE_BURST_REPEATS,

      // What the burst cost the rest of the main process.
      ...bystanderMetrics("burst", reading),

      // What a caller actually waited for its own update to be durable.
      callerAwaitP95Ms: percentile(latencies, 95),
      callerAwaitMaxMs: latencies.length > 0 ? Math.max(...latencies) : 0,

      probeMisses: reading.probeMisses,
      // Graded across BOTH passes: a rejection in the counted pass is just as
      // much a failed durable write as one in the timed pass.
      callerResolutionMisses: timedRun.rejected + countedRun.rejected + (owed * 2 - enqueued),
      onDiskUpdateMisses: timedMisses.updateMisses + countedMisses.updateMisses,
      fixturePreservationMisses: timedMisses.preservationMisses + countedMisses.preservationMisses,
    },
  };
}

export const persistenceScenarios: PerfScenario[] = [
  {
    id: "PERF-053",
    name: "SQLite Upsert Batching (per-row vs one transaction)",
    description:
      "200 drizzle project upserts against a migrated, populated SQLite database — autocommit versus one transaction — with WAL growth and a row read-back. Engine-level: the surrounding ProjectStore work is deliberately out of frame.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 10, nightly: 14 },
    warmups: 1,
    correctness: ["rowMisses"],
    run: runBatchingScenario,
  },
  {
    id: "PERF-054",
    name: "SQLite Project Query Shapes (index vs scan)",
    description:
      "The SQL getProjectByPath issues, served by its index, against the same lookup forced into a table scan, plus getAllProjects' ORDER BY, with the query plans asserted. Path normalisation and row mapping are out of frame.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 10, nightly: 14 },
    warmups: 1,
    correctness: ["lookupMisses", "indexPlanMisses", "orderedRowMisses"],
    run: runQueryShapeScenario,
  },
  {
    id: "PERF-055",
    name: "SQLite WAL Growth, Concurrent Reader and Checkpoint",
    description:
      "40 write transactions with a concurrent read-only connection, a bounded write-lock contention probe, and a TRUNCATE checkpoint, on a connection opened with production's pragmas.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly", "soak"],
    iterations: { smoke: 2, ci: 5, nightly: 8, soak: 10 },
    warmups: 1,
    correctness: [
      "rowMisses",
      "readerRowMisses",
      "checkpointReclaimMisses",
      "contentionProbeMisses",
      "cleanupMisses",
    ],
    run: runWalScenario,
  },
  {
    id: "PERF-056",
    name: "SQLite Migration Chain on a Populated Database",
    description:
      "The real drizzle migrator walking every migration after the baseline against a database seeded with 4000 project rows, so the O(rows) data migrations and table rewrites are priced.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 2, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: ["migrationCountMisses", "schemaColumnMisses", "rowMisses", "dataMigrationMisses"],
    run: runMigrationScenario,
  },
  {
    id: "PERF-057",
    name: "electron-store Atomic Write (appState snapshot)",
    description:
      "The product's own config.json store writing a 400-panel appState snapshot, then twelve ordinary settings writes against the now-large file, measuring whole-file rewrite amplification and confirming every write on disk.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: ["writeMisses", "readBackMisses"],
    run: runStoreWriteScenario,
  },
  {
    id: "PERF-058",
    name: "electron-store Open and Cached vs Uncached Reads",
    description:
      "initializeStore() reopening a realistically-sized config.json through the real corrupt-config preflight, then 200 uncached conf reads against 200 through the product's cached store proxy.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: ["keyReadMisses", "hydrationMisses"],
    run: runStoreOpenScenario,
  },
  {
    id: "PERF-406",
    name: "Project State Write Queue — 5-update burst",
    description:
      "A real ProjectStateManager over a real temp config dir holding a 40-panel project with draft inputs and tab groups, taking ten back-to-back bursts of 5 per-field updates enqueued with no await between them. Reports durable writes, whole-state clones and payload bytes per burst alongside main-thread availability. The IPC hop, the renderer debounce and ProjectStore's derived metadata are out of frame.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: [
      "onDiskUpdateMisses",
      "callerResolutionMisses",
      "fixturePreservationMisses",
      "probeMisses",
    ],
    workloadFloors: {
      updatesRequested: 5 * STATE_BURST_REPEATS,
      updatesEnqueued: 2 * 5 * STATE_BURST_REPEATS,
      updatesFulfilled: 2 * 5 * STATE_BURST_REPEATS,
      fixturePanelCount: STATE_PANELS,
    },
    run: () => runStateBurstScenario(5),
  },
  {
    id: "PERF-407",
    name: "Project State Write Queue — 20-update burst",
    description:
      "The PERF-406 workload at the burst size a fleet launch or a drag actually produces: twenty per-field updates enqueued with no await between them, ten times over. The burst size is the variable; fixture, probe cadence and predicates are identical.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: [
      "onDiskUpdateMisses",
      "callerResolutionMisses",
      "fixturePreservationMisses",
      "probeMisses",
    ],
    workloadFloors: {
      updatesRequested: 20 * STATE_BURST_REPEATS,
      updatesEnqueued: 2 * 20 * STATE_BURST_REPEATS,
      updatesFulfilled: 2 * 20 * STATE_BURST_REPEATS,
      fixturePanelCount: STATE_PANELS,
    },
    run: () => runStateBurstScenario(20),
  },
];
