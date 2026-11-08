import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  findJournalProblems,
  findLedgerDrift,
  freezeMigrations,
  readMigrationLedger,
  readMigrationSource,
  toFrozenMigrations,
  type JournalEntry,
  type MigrationLedger,
  type MigrationSource,
} from "../migrationLedger.js";

const persistenceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsFolder = path.join(persistenceDir, "migrations");

describe("shipped migrations", () => {
  const source = readMigrationSource(migrationsFolder);
  const ledger = readMigrationLedger(path.join(persistenceDir, "frozen-migrations.json"));

  it("keeps the journal in order", () => {
    expect(findJournalProblems(source)).toEqual([]);
  });

  it("leaves every migration that shipped in a release unchanged", () => {
    expect(findLedgerDrift(ledger, source)).toEqual([]);
  });

  it("never drops below the migrations v0.49.0 shipped", () => {
    // v0.49.0 shipped 0000 to 0026. Truncating the ledger would silently stop
    // guarding them, and `npm run db:freeze` only ever appends.
    expect(ledger.migrations.length).toBeGreaterThanOrEqual(27);
  });

  it("records the same hash, when and breakpoints drizzle's migrator reads", () => {
    const fromLedgerReader = toFrozenMigrations(source).map(({ sha256, when, breakpoints }) => ({
      hash: sha256,
      folderMillis: when,
      bps: breakpoints,
    }));
    const fromDrizzle = readMigrationFiles({ migrationsFolder }).map(
      ({ hash, folderMillis, bps }) => ({ hash, folderMillis, bps })
    );
    expect(fromLedgerReader).toEqual(fromDrizzle);
  });
});

function entry(idx: number, name: string, when: number): JournalEntry {
  return { idx, tag: `${String(idx).padStart(4, "0")}_${name}`, when, breakpoints: true };
}

// SQL follows the position, not the entry, so renaming or restamping an entry
// leaves its SQL alone unless a test changes it on purpose.
function sqlAt(position: number): string {
  return `CREATE TABLE \`t${position}\` (\`id\` text PRIMARY KEY NOT NULL);\n`;
}

function sqlOf(entries: JournalEntry[]): Record<string, string> {
  return Object.fromEntries(entries.map((e, position) => [e.tag, sqlAt(position)]));
}

function sourceOf(entries: JournalEntry[], sql = sqlOf(entries)): MigrationSource {
  return { entries, sql: new Map(Object.entries(sql)) };
}

const shipped = [entry(0, "baseline", 1000), entry(1, "add_widgets", 2000)];
const unshipped = entry(2, "add_gadgets", 3000);
const shippedLedger: MigrationLedger = { migrations: toFrozenMigrations(sourceOf(shipped)) };

function withEntry(position: number, change: Partial<JournalEntry>): JournalEntry[] {
  return [...shipped, unshipped].map((e, i) => (i === position ? { ...e, ...change } : e));
}

describe("findLedgerDrift", () => {
  it("passes a journal that matches the ledger, with an unshipped migration after it", () => {
    const current = sourceOf([...shipped, unshipped]);
    expect(findJournalProblems(current)).toEqual([]);
    expect(findLedgerDrift(shippedLedger, current)).toEqual([]);
  });

  it("names a shipped migration whose SQL changed by a single byte", () => {
    const entries = [...shipped, unshipped];
    const sql = sqlOf(entries);
    sql["0001_add_widgets"] += "\n";
    expect(findLedgerDrift(shippedLedger, sourceOf(entries, sql))).toEqual([
      expect.stringMatching(/^0001_add_widgets: SQL changed after it shipped/),
    ]);
  });

  it.each([
    ["when", { when: 2500 }, /^0001_add_widgets: when changed from 2000 to 2500/],
    ["idx", { idx: 7 }, /^0001_add_widgets: idx changed from 1 to 7/],
    ["breakpoints", { breakpoints: false }, /^0001_add_widgets: breakpoints changed/],
  ] as const)("names a shipped migration whose %s changed", (_field, change, message) => {
    const entries = withEntry(1, change);
    expect(findLedgerDrift(shippedLedger, sourceOf(entries))).toEqual([
      expect.stringMatching(message),
    ]);
  });

  it("names a shipped migration whose tag was renamed along with its file", () => {
    const entries = withEntry(1, { tag: "0001_add_gizmos" });
    expect(findLedgerDrift(shippedLedger, sourceOf(entries))).toEqual([
      "0001_add_widgets: tag changed to 0001_add_gizmos after it shipped",
    ]);
  });

  it("names a shipped migration that was removed from the journal", () => {
    const entries = [shipped[0]];
    expect(findLedgerDrift(shippedLedger, sourceOf(entries))).toEqual([
      "0001_add_widgets: shipped in a release but is no longer in the journal",
    ]);
  });

  it("lets a migration that hasn't shipped change its SQL and when", () => {
    const entries = withEntry(2, { when: 3500 });
    const sql = sqlOf(entries);
    sql["0002_add_gadgets"] = "CREATE TABLE `gadgets` (`id` integer PRIMARY KEY NOT NULL);\n";
    const current = sourceOf(entries, sql);
    expect(findJournalProblems(current)).toEqual([]);
    expect(findLedgerDrift(shippedLedger, current)).toEqual([]);
  });
});

describe("findJournalProblems", () => {
  it("names an entry stamped no later than the one before it", () => {
    for (const when of [2000, 1500]) {
      expect(findJournalProblems(sourceOf(withEntry(2, { when })))).toEqual([
        expect.stringMatching(
          new RegExp(`^0002_add_gadgets: when ${when} is not later than 0001_add_widgets's 2000`)
        ),
      ]);
    }
  });

  it("names an idx that skips a number", () => {
    const entries = [...shipped, entry(3, "add_gadgets", 3000)];
    expect(findJournalProblems(sourceOf(entries))).toEqual([
      "0003_add_gadgets: idx 3 sits at position 2; idx must count up from 0",
      "0003_add_gadgets: tag must start with 0002_ to match its position",
    ]);
  });

  it("names a tag whose prefix doesn't match its idx", () => {
    const entries = withEntry(2, { tag: "0005_add_gadgets" });
    expect(findJournalProblems(sourceOf(entries))).toEqual([
      "0005_add_gadgets: tag must start with 0002_ to match its position",
    ]);
  });

  it("names a journal entry without SQL and SQL without a journal entry", () => {
    const entries = [...shipped, unshipped];
    const sql = sqlOf(entries);
    delete sql["0002_add_gadgets"];
    sql["0003_orphan"] = "SELECT 1;\n";
    expect(findJournalProblems(sourceOf(entries, sql))).toEqual([
      "0002_add_gadgets: 0002_add_gadgets.sql is missing",
      "0003_orphan: 0003_orphan.sql has no journal entry, so drizzle never applies it",
    ]);
  });
});

describe("freezeMigrations", () => {
  it("appends only the migrations the ledger doesn't hold yet", () => {
    const appended = [...shipped, unshipped, entry(3, "add_sprockets", 4000)];
    const { ledger, added } = freezeMigrations(shippedLedger, sourceOf(appended));
    expect(added.map((m) => m.tag)).toEqual(["0002_add_gadgets", "0003_add_sprockets"]);
    expect(ledger.migrations.slice(0, shipped.length)).toEqual(shippedLedger.migrations);
    expect(findLedgerDrift(ledger, sourceOf(appended))).toEqual([]);
    expect(freezeMigrations(ledger, sourceOf(appended)).added).toEqual([]);
  });

  it("refuses to re-freeze a shipped migration that changed", () => {
    const changed = sourceOf(withEntry(1, { when: 2500 }));
    expect(() => freezeMigrations(shippedLedger, changed)).toThrow(
      /0001_add_widgets: when changed from 2000 to 2500/
    );
  });

  it("refuses to freeze a malformed journal", () => {
    const outOfOrder = sourceOf(withEntry(2, { when: 1500 }));
    expect(() => freezeMigrations(shippedLedger, outOfOrder)).toThrow(
      /0002_add_gadgets: when 1500 is not later/
    );
  });
});
