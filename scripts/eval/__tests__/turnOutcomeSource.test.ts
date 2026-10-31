import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TURN_OUTCOME_RING,
  TurnOutcomeSourceError,
  readTurnOutcomeRing,
} from "../turnOutcomeSource.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
type Db = InstanceType<typeof DatabaseSync>;

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

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "turn-outcome-source-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function openProfileDb(dbPath: string): Db {
  const db = new DatabaseSync(dbPath);
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
    insert(db, TURN_OUTCOME_RING, turn("t-3", 3000), "t-3");
    insert(db, "pluginAuditLog", { id: "plugin-1" }, "plugin-1");
    // Ring order is insertion order, not timestamp order.
    insert(db, TURN_OUTCOME_RING, turn("t-1", 1000, "reasoning-loop"), "t-1");
    insert(db, "runHistoryRecords", { id: "run-1" }, "run-1");
    // Rows written before migration 0018 carry no record_id.
    insert(db, TURN_OUTCOME_RING, turn("t-2", 2000), null);
    db.close();

    const result = readTurnOutcomeRing(dbPath);
    expect(result.rowCount).toBe(3);
    expect(result.warnings).toEqual([]);
    expect((result.rows as Array<{ id: string }>).map((r) => r.id)).toEqual(["t-3", "t-1", "t-2"]);
    expect(result.rows[1]).toMatchObject({ outcome: "reasoning-loop" });
  });

  it("skips and names rows whose record is not valid JSON", () => {
    const dbPath = path.join(tmp, "daintree.db");
    const db = createProfileDb(dbPath);
    insert(db, TURN_OUTCOME_RING, turn("good", 1000), "good");
    insert(db, TURN_OUTCOME_RING, "{not json", "bad");
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
    insert(db, TURN_OUTCOME_RING, turn("t-1", 1000), "t-1");
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
    insert(writer, TURN_OUTCOME_RING, turn("t-1", 1000), "t-1");
    insert(writer, TURN_OUTCOME_RING, turn("t-2", 2000), "t-2");

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
    expect((result.rows as Array<{ id: string }>).map((r) => r.id)).toEqual(["t-1", "t-2"]);

    expect(fingerprint(dbPath)).toBe(dbBefore);
    expect(fingerprint(`${dbPath}-wal`)).toBe(walBefore);
  });

  it("reads a committed snapshot beside a live writer and never blocks its commit", () => {
    const dbPath = path.join(tmp, "daintree.db");
    const writer = createProfileDb(dbPath);
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    insert(writer, TURN_OUTCOME_RING, turn("t-1", 1000), "t-1");
    writer.exec("BEGIN IMMEDIATE");
    insert(writer, TURN_OUTCOME_RING, turn("t-2", 2000), "t-2");
    const dbBefore = fingerprint(dbPath);

    const during = readTurnOutcomeRing(dbPath);
    expect((during.rows as Array<{ id: string }>).map((r) => r.id)).toEqual(["t-1"]);

    expect(() => writer.exec("COMMIT")).not.toThrow();
    expect(fingerprint(dbPath)).toBe(dbBefore);
    const after = readTurnOutcomeRing(dbPath);
    expect((after.rows as Array<{ id: string }>).map((r) => r.id)).toEqual(["t-1", "t-2"]);
    writer.close();
  });
});
