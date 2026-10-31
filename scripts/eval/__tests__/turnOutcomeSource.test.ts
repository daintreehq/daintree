import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnOutcomeSourceError, readTurnOutcomeRing } from "../turnOutcomeSource.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
type Db = InstanceType<typeof DatabaseSync>;

// The ring name the app persists under, spelled out rather than imported so a
// wrong constant in the reader cannot agree with its own fixtures.
const RING = "mcpTurnOutcomeLog";

// The app's audit_rings shape: migrations 0004 and 0018.
const AUDIT_RINGS_DDL = `
  CREATE TABLE audit_rings (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    ring text NOT NULL,
    record text NOT NULL,
    created_at integer NOT NULL
  );
  CREATE INDEX audit_rings_ring_idx ON audit_rings (ring);
  ALTER TABLE audit_rings ADD record_id text;
  CREATE UNIQUE INDEX audit_rings_ring_record_id_idx ON audit_rings (ring, record_id);
`;

let tmp: string;
let openWriters: Db[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "turn-outcome-source-"));
  openWriters = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of openWriters) {
    if (db.isOpen) db.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface SqliteHooks {
  onOpen?(location: string): void;
  beforeQuery?(location: string): void;
  afterQuery?(location: string): void;
}

/**
 * Route the reader's node:sqlite through real connections that record each
 * location opened, run hooks around the ring query, and return unordered rows
 * in reverse so only an explicit ORDER BY keeps ring order.
 */
function instrumentSqlite(hooks: SqliteHooks = {}): string[] {
  const opened: string[] = [];
  const original = process.getBuiltinModule.bind(process);
  vi.spyOn(process, "getBuiltinModule").mockImplementation(((id: string) => {
    if (id !== "node:sqlite") return original(id);
    function Instrumented(location: string, options: { readOnly?: boolean; timeout?: number }) {
      const db = new DatabaseSync(location, options);
      opened.push(location);
      db.exec("PRAGMA reverse_unordered_selects = ON");
      hooks.onOpen?.(location);
      return {
        prepare(sql: string) {
          const statement = db.prepare(sql);
          const isRingQuery = sql.includes("WHERE ring = ?");
          return {
            get: (...params: never[]) => statement.get(...params),
            all: (...params: never[]) => {
              if (isRingQuery) hooks.beforeQuery?.(location);
              const rows = statement.all(...params);
              if (isRingQuery) hooks.afterQuery?.(location);
              return rows;
            },
          };
        },
        close: () => db.close(),
      };
    }
    return { DatabaseSync: Instrumented };
  }) as never);
  return opened;
}

const isImmutable = (location: string) => location.startsWith("file:");

function openProfileDb(dbPath: string): Db {
  const db = new DatabaseSync(dbPath);
  openWriters.push(db);
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

function createProfileDb(dbPath: string): Db {
  const db = openProfileDb(dbPath);
  db.exec(AUDIT_RINGS_DDL);
  return db;
}

function insert(db: Db, ring: string, record: unknown, recordId: string | null): void {
  const text = typeof record === "string" ? record : JSON.stringify(record);
  db.prepare(
    "INSERT INTO audit_rings (ring, record_id, record, created_at) VALUES (?, ?, ?, ?)"
  ).run(ring, recordId, text, Date.now());
}

function turn(id: string, timestamp: number, outcome = "answered") {
  return { id, timestamp, terminalId: "t1", sessionId: "s1", outcome };
}

function fingerprint(file: string): string {
  return fs.existsSync(file)
    ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
    : "absent";
}

function ids(rows: unknown[]): string[] {
  return (rows as Array<{ id: string }>).map((r) => r.id);
}

function idleProfile(rows: Array<[string, number]>): string {
  const dbPath = path.join(tmp, "daintree.db");
  const db = createProfileDb(dbPath);
  for (const [id, timestamp] of rows) insert(db, RING, turn(id, timestamp), id);
  db.close();
  return dbPath;
}

function expectSourceError(dbPath: string, kind: TurnOutcomeSourceError["kind"]): string {
  let caught: unknown;
  try {
    readTurnOutcomeRing(dbPath);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TurnOutcomeSourceError);
  const error = caught as TurnOutcomeSourceError;
  expect(error.kind).toBe(kind);
  expect(error.sourcePath).toBe(dbPath);
  expect(error.message).toContain(dbPath);
  return error.message;
}

describe("readTurnOutcomeRing", () => {
  it("loads only turn-outcome rows, in ring order, from among other rings", () => {
    const dbPath = path.join(tmp, "daintree.db");
    const db = createProfileDb(dbPath);
    insert(db, "mcpAuditLog", { id: "audit-1", timestamp: 1 }, "audit-1");
    insert(db, RING, turn("t-3", 3000), "t-3");
    insert(db, "pluginAuditLog", { id: "plugin-1" }, "plugin-1");
    // Ring order is insertion order, not timestamp order.
    insert(db, RING, turn("t-1", 1000, "reasoning-loop"), "t-1");
    insert(db, "runHistoryRecords", { id: "run-1" }, "run-1");
    // Rows written before migration 0018 carry no record_id.
    insert(db, RING, turn("t-2", 2000), null);
    db.close();

    instrumentSqlite();
    const result = readTurnOutcomeRing(dbPath);
    expect(result.rowCount).toBe(3);
    expect(result.warnings).toEqual([]);
    expect(ids(result.rows)).toEqual(["t-3", "t-1", "t-2"]);
    expect(result.rows[1]).toMatchObject({ outcome: "reasoning-loop" });
  });

  it("skips and names rows whose record is not valid JSON", () => {
    const dbPath = path.join(tmp, "daintree.db");
    const db = createProfileDb(dbPath);
    insert(db, RING, turn("good", 1000), "good");
    insert(db, RING, "{not json", "bad");
    const badRowId = (db.prepare("SELECT max(id) AS id FROM audit_rings").get() as { id: number })
      .id;
    db.close();

    const result = readTurnOutcomeRing(dbPath);
    expect(result.rowCount).toBe(2);
    expect(result.rows).toEqual([turn("good", 1000)]);
    expect(result.warnings).toEqual([
      `audit_rings row ${badRowId}: record is not valid JSON, skipping`,
    ]);
  });

  it("reports an empty ring as zero rows, not as a failure", () => {
    const dbPath = path.join(tmp, "daintree.db");
    const db = createProfileDb(dbPath);
    insert(db, "mcpAuditLog", { id: "audit-1" }, "audit-1");
    db.close();

    expect(readTurnOutcomeRing(dbPath)).toEqual({ rows: [], rowCount: 0, warnings: [] });
  });

  it("fails on a missing database without creating it", () => {
    const dbPath = path.join(tmp, "daintree.db");
    expect(expectSourceError(dbPath, "missing")).toContain("profile directory or its daintree.db");
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("rejects an old config.json, naming what it expected", () => {
    const configPath = path.join(tmp, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ turnOutcomeLog: [turn("t-1", 1)] }));
    const message = expectSourceError(configPath, "unsupported");
    expect(message).toContain("not a SQLite database");
    expect(message).toContain("config.json");
  });

  it("rejects a non-SQLite file named daintree.db", () => {
    const dbPath = path.join(tmp, "daintree.db");
    fs.writeFileSync(dbPath, "plain text, not a database");
    expectSourceError(dbPath, "unsupported");
  });

  it("rejects a directory given as the database", () => {
    const dir = path.join(tmp, "daintree.db");
    fs.mkdirSync(dir);
    expectSourceError(dir, "unsupported");
  });

  it("fails on a SQLite database without an audit_rings table", () => {
    const dbPath = path.join(tmp, "daintree.db");
    const db = openProfileDb(dbPath);
    db.exec("CREATE TABLE projects (id text PRIMARY KEY)");
    db.close();
    expect(expectSourceError(dbPath, "no-table")).toContain("audit_rings");
  });

  it("leaves an idle profile byte-for-byte unchanged and creates no sidecars", () => {
    const dbPath = path.join(tmp, "daintree.db");
    const configPath = path.join(tmp, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ auditEnabled: true }));
    const db = createProfileDb(dbPath);
    insert(db, RING, turn("t-1", 1000), "t-1");
    db.close();
    const before = fs.readdirSync(tmp).sort();
    expect(before).toEqual(["config.json", "daintree.db"]);
    const dbBefore = fingerprint(dbPath);
    const configBefore = fingerprint(configPath);

    expect(readTurnOutcomeRing(dbPath).rowCount).toBe(1);

    expect(fs.readdirSync(tmp).sort()).toEqual(before);
    expect(fingerprint(dbPath)).toBe(dbBefore);
    expect(fingerprint(configPath)).toBe(configBefore);
  });

  it("reads committed WAL-only rows of a crashed profile without checkpointing them", () => {
    const livePath = path.join(tmp, "live.db");
    const writer = createProfileDb(livePath);
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    insert(writer, RING, turn("t-1", 1000), "t-1");
    insert(writer, RING, turn("t-2", 2000), "t-2");

    // Copying the files while the writer still holds them is what a crash
    // leaves behind: rows that exist only in the -wal.
    const profile = path.join(tmp, "profile");
    fs.mkdirSync(profile);
    const dbPath = path.join(profile, "daintree.db");
    fs.copyFileSync(livePath, dbPath);
    fs.copyFileSync(`${livePath}-wal`, `${dbPath}-wal`);
    writer.close();
    const dbBefore = fingerprint(dbPath);
    const walBefore = fingerprint(`${dbPath}-wal`);
    expect(walBefore).not.toBe("absent");

    const result = readTurnOutcomeRing(dbPath);
    expect(ids(result.rows)).toEqual(["t-1", "t-2"]);

    expect(fingerprint(dbPath)).toBe(dbBefore);
    expect(fingerprint(`${dbPath}-wal`)).toBe(walBefore);
  });

  it("reads a committed snapshot beside a live writer and never blocks its commit", () => {
    const dbPath = path.join(tmp, "daintree.db");
    const writer = createProfileDb(dbPath);
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    insert(writer, RING, turn("t-1", 1000), "t-1");
    writer.exec("BEGIN IMMEDIATE");
    insert(writer, RING, turn("t-2", 2000), "t-2");
    const dbBefore = fingerprint(dbPath);
    let commitError: unknown = "not attempted";
    const opened = instrumentSqlite({
      // Commit while the reader's connection is still open.
      afterQuery: () => {
        try {
          writer.exec("COMMIT");
          commitError = undefined;
        } catch (error) {
          commitError = error;
        }
      },
    });

    const during = readTurnOutcomeRing(dbPath);

    expect(opened.some(isImmutable)).toBe(false);
    expect(ids(during.rows)).toEqual(["t-1"]);
    expect(commitError).toBeUndefined();
    expect(fingerprint(dbPath)).toBe(dbBefore);
    vi.restoreAllMocks();
    expect(ids(readTurnOutcomeRing(dbPath).rows)).toEqual(["t-1", "t-2"]);
  });

  it.skipIf(process.platform === "win32")(
    "finds the -wal beside the real file when the path is a symlink",
    () => {
      const livePath = path.join(tmp, "live.db");
      const writer = createProfileDb(livePath);
      writer.exec("PRAGMA wal_autocheckpoint = 0");
      insert(writer, RING, turn("t-1", 1000), "t-1");
      const profile = path.join(tmp, "profile");
      fs.mkdirSync(profile);
      const dbPath = path.join(profile, "daintree.db");
      fs.copyFileSync(livePath, dbPath);
      fs.copyFileSync(`${livePath}-wal`, `${dbPath}-wal`);
      writer.close();
      const alias = path.join(tmp, "alias.db");
      fs.symlinkSync(dbPath, alias);
      const walBefore = fingerprint(`${dbPath}-wal`);

      expect(ids(readTurnOutcomeRing(alias).rows)).toEqual(["t-1"]);
      expect(fingerprint(`${dbPath}-wal`)).toBe(walBefore);
    }
  );

  it("never reads a rollback-mode database as immutable", () => {
    const dbPath = path.join(tmp, "daintree.db");
    const db = new DatabaseSync(dbPath);
    openWriters.push(db);
    db.exec(AUDIT_RINGS_DDL);
    insert(db, RING, turn("t-1", 1000), "t-1");
    db.close();
    const opened = instrumentSqlite();

    expect(ids(readTurnOutcomeRing(dbPath).rows)).toEqual(["t-1"]);
    expect(opened.some(isImmutable)).toBe(false);
  });

  it("never reads as immutable with a -journal beside the database", () => {
    const dbPath = idleProfile([["t-1", 1000]]);
    fs.writeFileSync(`${dbPath}-journal`, "");
    const opened = instrumentSqlite();

    expect(ids(readTurnOutcomeRing(dbPath).rows)).toEqual(["t-1"]);
    expect(opened.some(isImmutable)).toBe(false);
  });
});

describe("readTurnOutcomeRing immutable fallback", () => {
  it("rereads on a WAL connection when the app starts during the read", () => {
    const dbPath = idleProfile([["t-1", 1000]]);
    const opened = instrumentSqlite({
      onOpen: (location) => {
        if (!isImmutable(location)) return;
        const app = openProfileDb(dbPath);
        app.exec("PRAGMA wal_autocheckpoint = 0");
        insert(app, RING, turn("late", 2000), "late");
      },
    });

    const result = readTurnOutcomeRing(dbPath);

    expect(opened.map(isImmutable)).toEqual([true, false]);
    expect(ids(result.rows)).toEqual(["t-1", "late"]);
  });

  it("rereads when the file changes under the read without a -wal appearing", () => {
    const dbPath = idleProfile([["t-1", 1000]]);
    const opened = instrumentSqlite({
      onOpen: (location) => {
        if (isImmutable(location)) fs.utimesSync(dbPath, new Date(), new Date(Date.now() + 60_000));
      },
    });

    expect(ids(readTurnOutcomeRing(dbPath).rows)).toEqual(["t-1"]);
    expect(opened.map(isImmutable)).toEqual([true, false]);
  });

  it("retries an immutable read that failed while the file changed", () => {
    const dbPath = idleProfile([["t-1", 1000]]);
    const opened = instrumentSqlite({
      onOpen: (location) => {
        if (isImmutable(location)) fs.utimesSync(dbPath, new Date(), new Date(Date.now() + 60_000));
      },
      beforeQuery: (location) => {
        if (isImmutable(location)) throw new Error("database disk image is malformed");
      },
    });

    expect(ids(readTurnOutcomeRing(dbPath).rows)).toEqual(["t-1"]);
    expect(opened.map(isImmutable)).toEqual([true, false]);
  });

  it("reports an immutable read failure on an unchanged file without retrying", () => {
    const dbPath = idleProfile([["t-1", 1000]]);
    const listing = fs.readdirSync(tmp).sort();
    const opened = instrumentSqlite({
      beforeQuery: () => {
        throw new Error("database disk image is malformed");
      },
    });

    expect(expectSourceError(dbPath, "unreadable")).toContain("malformed");
    expect(opened.map(isImmutable)).toEqual([true]);
    expect(fs.readdirSync(tmp).sort()).toEqual(listing);
  });
});
