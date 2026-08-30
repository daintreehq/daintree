import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { allScenarios, EXPECTED_SCENARIO_IDS } from "../scenarios";
import {
  cleanupTempRoot,
  DB_SOURCE_PATH,
  PRODUCTION_PRAGMAS,
  SEED_PROJECT_COUNT,
} from "../lib/persistenceFixture";
import type { ScenarioSample } from "../types";

const context = { mode: "ci" as const, now: () => performance.now() };

// Vitest tears its forked workers down by signal, so the fixture's own
// process-exit cleanup never runs here.
afterAll(() => {
  cleanupTempRoot();
});

async function runScenario(id: string): Promise<ScenarioSample> {
  const scenario = allScenarios.find((s) => s.id === id);
  expect(scenario).toBeDefined();
  return await scenario!.run(context);
}

describe("persistence perf fixture", () => {
  it("refuses to benchmark electron-store outside the temp root", async () => {
    const { inheritedUserData } = await import("../lib/persistenceFixture");
    // vitest.setup.ts points DAINTREE_USER_DATA at a temp dir, so the guard
    // must accept it. What it must never accept is a real profile path.
    expect(inheritedUserData()).toBe(true);
    expect(process.env.DAINTREE_USER_DATA?.length).toBeGreaterThan(0);
  });

  it("uses the same pragma sequence openDb() does", () => {
    const source = readFileSync(DB_SOURCE_PATH, "utf8");
    const start = source.indexOf("export function openDb(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\nexport function", start + 1);
    const body = source.slice(start, end === -1 ? undefined : end);

    const pragmas = [...body.matchAll(/sqlite\.pragma\("([^"]+)"\)/g)].map((match) => match[1]);
    // If this fails, production changed journal mode / durability and the
    // benchmark is now measuring a database the product never opens.
    expect(pragmas).toEqual([...PRODUCTION_PRAGMAS]);
  });

  it("no longer declares the synthetic PERF-050..052 scenarios", () => {
    for (const id of ["PERF-050", "PERF-051", "PERF-052"]) {
      expect(EXPECTED_SCENARIO_IDS.has(id)).toBe(false);
      expect(allScenarios.some((s) => s.id === id)).toBe(false);
    }
  });
});

describe("PERF-053 SQLite upsert batching", () => {
  it("writes every row through both paths and separates the commit counts", async () => {
    const sample = await runScenario("PERF-053");
    const metrics = sample.metrics!;

    // The correctness pairing: neither phase may score well by not writing.
    expect(metrics.rowMisses).toBe(0);
    expect(metrics.rowsChangedCount).toBeGreaterThan(0);
    // Same statements, different number of commits — the whole comparison.
    expect(metrics.perRowStatementCount).toBe(metrics.txnStatementCount);
    expect(metrics.txnTransactionCount).toBe(1);
    expect(metrics.perRowTransactionCount).toBeGreaterThan(1);
    expect(metrics.perRowMs).toBeGreaterThan(0);
    expect(metrics.txnMs).toBeGreaterThan(0);
  });
});

describe("PERF-054 SQLite query shapes", () => {
  it("keeps the indexed and scan arms on the plans they claim", async () => {
    const sample = await runScenario("PERF-054");
    const metrics = sample.metrics!;

    expect(metrics.indexPlanMisses).toBe(0);
    expect(metrics.lookupMisses).toBe(0);
    expect(metrics.orderedRowMisses).toBe(0);
    // A scan of the table's tail must cost visibly more than an index seek. If
    // this collapses toward 1 the probe stopped reaching deep rows and the
    // comparison is measuring nothing.
    expect(metrics.indexSpeedupRatio).toBeGreaterThan(3);
  });
});

describe("PERF-055 WAL behaviour", () => {
  it("keeps a concurrent reader unblocked and reclaims the journal", async () => {
    const sample = await runScenario("PERF-055");
    const metrics = sample.metrics!;

    expect(metrics.rowMisses).toBe(0);
    // WAL's defining property, asserted rather than assumed.
    expect(metrics.readerBusyRetries).toBe(0);
    expect(metrics.readerRowMisses).toBe(0);
    expect(metrics.readerReadCount).toBeGreaterThan(0);
    // The contention probe must actually have hit the held write lock.
    expect(metrics.contentionProbeMisses).toBe(0);
    expect(metrics.writeLockBusyCount).toBe(1);
    expect(metrics.walPeakKB).toBeGreaterThan(0);
    expect(metrics.checkpointReclaimMisses).toBe(0);
    // Iterations must be independent: an unverified cleanup would leave the
    // table growing and make each later iteration slower than the first.
    expect(metrics.cleanupMisses).toBe(0);
  });
});

describe("PERF-056 drizzle migration chain", () => {
  it("migrates a populated database and lands the schema and the data changes", async () => {
    const sample = await runScenario("PERF-056");
    const metrics = sample.metrics!;

    expect(metrics.seedRowCount).toBe(SEED_PROJECT_COUNT);
    expect(metrics.rowMisses).toBe(0);
    // A chain that ran only its DDL would be fast and wrong.
    expect(metrics.schemaColumnMisses).toBe(0);
    expect(metrics.dataMigrationMisses).toBe(0);
    // Read out of __drizzle_migrations, so it fails if the timed pass applied
    // nothing or only part of the chain.
    expect(metrics.migrationCountMisses).toBe(0);
    expect(metrics.migrationCount).toBeGreaterThan(5);
    expect(metrics.dbFileKB).toBeGreaterThan(100);
  });
});

describe("PERF-057/058 electron-store", () => {
  it("writes appState through the real store and confirms every write on disk", async () => {
    const sample = await runScenario("PERF-057");
    const metrics = sample.metrics!;

    // Per-write, not just final-state: eleven silent no-ops followed by one
    // real write would satisfy an end-state-only check.
    expect(metrics.writeMisses).toBe(0);
    expect(metrics.readBackMisses).toBe(0);
    expect(metrics.configBytes).toBeGreaterThan(100_000);
    // Every `set` rewrites the whole file — the number this scenario exists for.
    expect(metrics.writeAmplificationRatio).toBeGreaterThan(1);
    expect(metrics.storeWrites).toBeGreaterThan(1);
  });

  it("reopens a populated config.json and shows what the read cache is worth", async () => {
    const sample = await runScenario("PERF-058");
    const metrics = sample.metrics!;

    expect(metrics.keyReadMisses).toBe(0);
    // A store that silently reset to defaults opens fastest of all.
    expect(metrics.hydrationMisses).toBe(0);
    expect(metrics.configBytes).toBeGreaterThan(10_000);
    // conf re-reads and re-parses config.json on every raw get; the product's
    // proxy takes one snapshot. If this collapses to 1 the cached arm stopped
    // being cached and the pair is measuring the same thing twice.
    expect(metrics.readCacheSpeedupRatio).toBeGreaterThan(2);
  });
});
