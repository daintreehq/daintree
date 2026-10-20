import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbWorkerOp } from "../dbWorkerProtocol.js";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    getAppPath: () => "/fake/appPath",
  },
}));

const harness = vi.hoisted(() => ({
  db: null as Database.Database | null,
}));

const mockRunDbWork = vi.hoisted(() => vi.fn());
const mockFence = vi.hoisted(() => vi.fn());

vi.mock("../dbWorkerClient.js", () => ({
  runDbWork: mockRunDbWork,
  fenceDbWorkerWrites: mockFence,
}));

vi.mock("../db.js", () => ({
  getSharedSqlite: () => harness.db,
}));

import { AuditRingStore } from "../auditRingStore.js";
import { applyRingDelta, prepareRingStatements, replaceRing } from "../auditRingSql.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../migrations");

interface Rec {
  id?: string;
  v: string;
}

const rec = (id: string, v = id): Rec => ({ id, v });

// The real audit_rings DDL, so the test exercises the shipped unique index.
function createSchema(db: Database.Database): void {
  for (const file of ["0004_audit_rings.sql", "0018_audit_ring_record_ids.sql"]) {
    for (const statement of fs
      .readFileSync(path.join(migrationsFolder, file), "utf8")
      .split("--> statement-breakpoint")) {
      db.exec(statement);
    }
  }
  // Test-only row counters: every row the store touches, on either executor.
  db.exec(`
    CREATE TABLE op_log (kind TEXT NOT NULL);
    CREATE TRIGGER log_insert AFTER INSERT ON audit_rings BEGIN INSERT INTO op_log VALUES ('insert'); END;
    CREATE TRIGGER log_update AFTER UPDATE ON audit_rings BEGIN INSERT INTO op_log VALUES ('update'); END;
    CREATE TRIGGER log_delete AFTER DELETE ON audit_rings BEGIN INSERT INTO op_log VALUES ('delete'); END;
  `);
}

function opCounts(): Record<string, number> {
  const rows = harness
    .db!.prepare("SELECT kind, COUNT(*) AS n FROM op_log GROUP BY kind")
    .all() as { kind: string; n: number }[];
  harness.db!.exec("DELETE FROM op_log");
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}

function rowIds(ring: string): Map<string, number> {
  const rows = harness
    .db!.prepare("SELECT id, record_id FROM audit_rings WHERE ring = ? ORDER BY id ASC")
    .all(ring) as { id: number; record_id: string }[];
  return new Map(rows.map((r) => [r.record_id, r.id]));
}

// Stand-in for the DB worker: executes the op on the same database with the
// shared executors and resolves the applied flag, as the real worker does.
function workerExecutes(op: DbWorkerOp): boolean {
  const db = harness.db!;
  const stmts = prepareRingStatements(db);
  if (op.op === "ringWriteAll") return replaceRing(db, stmts, op.ring, op.rows, op.maxRecords);
  if (op.op === "ringApply") return applyRingDelta(db, stmts, op.ring, op.upserts, op.deletes);
  throw new Error(`unexpected op ${op.op}`);
}

interface Held {
  op: DbWorkerOp;
  fallback: () => unknown;
  resolve: (value: unknown) => void;
}

function holdWorker(): Held[] {
  const held: Held[] = [];
  mockRunDbWork.mockImplementation(
    (op: DbWorkerOp, fallback: () => unknown) =>
      new Promise((resolve) => held.push({ op, fallback, resolve }))
  );
  return held;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function sentOps(): DbWorkerOp[] {
  return mockRunDbWork.mock.calls.map((call) => call[0] as DbWorkerOp);
}

describe("AuditRingStore", () => {
  let store: AuditRingStore;

  beforeEach(() => {
    vi.clearAllMocks();
    harness.db = new Database(":memory:");
    createSchema(harness.db);
    mockRunDbWork.mockImplementation((op: DbWorkerOp) => Promise.resolve(workerExecutes(op)));
    store = new AuditRingStore();
  });

  afterEach(() => {
    harness.db?.close();
    harness.db = null;
  });

  it("writes one row, not the whole ring, when a full ring evicts its oldest record for a new one", async () => {
    const records = Array.from({ length: 500 }, (_, i) => rec(`r${i}`));
    store.writeAll("mcpAuditLog", records, 500);
    await settle();
    expect(sentOps().map((op) => op.op)).toEqual(["ringWriteAll"]);
    const idsBefore = rowIds("mcpAuditLog");
    opCounts();

    store.writeAll("mcpAuditLog", [...records.slice(1), rec("r500")], 500);
    await settle();

    const delta = sentOps()[1]!;
    expect(delta).toEqual({
      op: "ringApply",
      ring: "mcpAuditLog",
      upserts: [{ recordId: "r500", record: JSON.stringify(rec("r500")) }],
      deletes: ["r0"],
    });
    expect(opCounts()).toEqual({ insert: 1, delete: 1 });

    const idsAfter = rowIds("mcpAuditLog");
    for (let i = 1; i < 500; i++) {
      expect(idsAfter.get(`r${i}`)).toBe(idsBefore.get(`r${i}`));
    }
    expect(store.readAll<Rec>("mcpAuditLog").map((r) => r.id)).toEqual([
      ...records.slice(1).map((r) => r.id),
      "r500",
    ]);
  });

  it("persists an in-place update as a single row update that keeps the record's position", async () => {
    const records = [rec("a"), rec("b"), rec("c")];
    store.writeAll("mcpAuditLog", records, 10);
    await settle();
    const idsBefore = rowIds("mcpAuditLog");
    opCounts();

    // Owners mutate records in place (pre-auth coalescing), so object identity
    // cannot be the change signal.
    records[1]!.v = "b-coalesced";
    store.writeAll("mcpAuditLog", records, 10);
    await settle();

    expect(opCounts()).toEqual({ update: 1 });
    expect(rowIds("mcpAuditLog")).toEqual(idsBefore);
    expect(store.readAll<Rec>("mcpAuditLog").map((r) => r.v)).toEqual(["a", "b-coalesced", "c"]);
  });

  it("sends nothing when a flush changes nothing", async () => {
    store.writeAll("mcpAuditLog", [rec("a")], 10);
    await settle();
    store.writeAll("mcpAuditLog", [rec("a")], 10);
    await settle();
    expect(mockRunDbWork).toHaveBeenCalledTimes(1);
  });

  it("falls back to a full replacement when surviving records change order", async () => {
    store.writeAll("mcpAuditLog", [rec("a"), rec("b")], 10);
    await settle();
    store.writeAll("mcpAuditLog", [rec("b"), rec("a")], 10);
    await settle();
    expect(sentOps()[1]!.op).toBe("ringWriteAll");
    expect(store.readAll<Rec>("mcpAuditLog").map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("falls back to a full replacement when a new record lands before a survivor", async () => {
    store.writeAll("mcpAuditLog", [rec("a"), rec("b")], 10);
    await settle();
    store.writeAll("mcpAuditLog", [rec("a"), rec("new"), rec("b")], 10);
    await settle();
    expect(sentOps()[1]!.op).toBe("ringWriteAll");
    expect(store.readAll<Rec>("mcpAuditLog").map((r) => r.id)).toEqual(["a", "new", "b"]);
  });

  it("keeps records without unique ids, rewriting the ring each flush", async () => {
    const records: Rec[] = [{ v: "no-id" }, rec("dup", "1"), rec("dup", "2")];
    store.writeAll("forgeAuditLog", records, 10);
    await settle();
    store.writeAll("forgeAuditLog", [...records, rec("x")], 10);
    await settle();
    expect(sentOps().map((op) => op.op)).toEqual(["ringWriteAll", "ringWriteAll"]);
    expect(store.readAll<Rec>("forgeAuditLog").map((r) => r.v)).toEqual(["no-id", "1", "2", "x"]);
  });

  it("replaces legacy unkeyed rows on the first write of a session", async () => {
    harness
      .db!.prepare("INSERT INTO audit_rings (ring, record, created_at) VALUES (?, ?, ?)")
      .run("runHistoryRecords", JSON.stringify(rec("old")), 1);
    const hydrated = store.readAll<Rec>("runHistoryRecords");
    expect(hydrated.map((r) => r.id)).toEqual(["old"]);

    store.writeAll("runHistoryRecords", [...hydrated, rec("new")], 10);
    await settle();
    expect(sentOps()[0]!.op).toBe("ringWriteAll");
    expect([...rowIds("runHistoryRecords").keys()]).toEqual(["old", "new"]);
  });

  it("trims to maxRecords before diffing, so retention deletes the evicted rows", async () => {
    store.writeAll("pluginAuditLog", [rec("a"), rec("b"), rec("c"), rec("d")], 3);
    await settle();
    expect(store.readAll<Rec>("pluginAuditLog").map((r) => r.id)).toEqual(["b", "c", "d"]);

    store.writeAll("pluginAuditLog", [rec("a"), rec("b"), rec("c"), rec("d"), rec("e")], 3);
    await settle();
    expect(sentOps()[1]).toMatchObject({ op: "ringApply", deletes: ["b"] });
    expect(store.readAll<Rec>("pluginAuditLog").map((r) => r.id)).toEqual(["c", "d", "e"]);
  });

  it("keeps one write in flight per ring and coalesces later flushes into one delta", async () => {
    const held = holdWorker();
    store.writeAll("mcpAuditLog", [rec("a")], 10);
    store.writeAll("mcpAuditLog", [rec("a"), rec("b")], 10);
    store.writeAll("mcpAuditLog", [rec("a"), rec("b"), rec("c")], 10);
    expect(held).toHaveLength(1);

    held[0]!.resolve(workerExecutes(held[0]!.op));
    await settle();
    expect(held).toHaveLength(2);
    expect(held[1]!.op).toMatchObject({
      op: "ringApply",
      upserts: [{ recordId: "b" }, { recordId: "c" }],
      deletes: [],
    });
  });

  it("does not hold back other rings while one ring's write is in flight", () => {
    const held = holdWorker();
    store.writeAll("mcpAuditLog", [rec("a")], 10);
    store.writeAll("forgeAuditLog", [rec("f")], 10);
    expect(held.map((h) => h.op)).toMatchObject([
      { ring: "mcpAuditLog" },
      { ring: "forgeAuditLog" },
    ]);
  });

  it("re-sends a fenced write as a full replacement even without another flush", async () => {
    const held = holdWorker();
    store.writeAll("mcpAuditLog", [rec("a")], 10);
    held[0]!.resolve(workerExecutes(held[0]!.op));
    await settle();

    store.writeAll("mcpAuditLog", [rec("a"), rec("b")], 10);
    expect(held[1]!.op.op).toBe("ringApply");
    // Another ring's sync write moved the DB-wide fence; the worker no-op'd.
    held[1]!.resolve(false);
    await settle();

    expect(held).toHaveLength(3);
    expect(held[2]!.op).toMatchObject({ op: "ringWriteAll" });
    held[2]!.resolve(workerExecutes(held[2]!.op));
    await settle();
    expect(store.readAll<Rec>("mcpAuditLog").map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("never resurrects history when a sync clear lands while a delta is queued", async () => {
    const held = holdWorker();
    store.writeAll("mcpAuditLog", [rec("a")], 10);
    held[0]!.resolve(workerExecutes(held[0]!.op));
    await settle();

    store.writeAll("mcpAuditLog", [rec("a"), rec("b")], 10);
    const queued = held[1]!;
    store.writeAll("mcpAuditLog", [], 10, { sync: true });
    expect(mockFence).toHaveBeenCalledWith("mcpAuditLog");
    expect(store.readAll("mcpAuditLog")).toEqual([]);

    // The worker sees the advanced fence and no-ops the stale delta.
    queued.resolve(false);
    await settle();
    expect(held).toHaveLength(2);
    expect(store.readAll("mcpAuditLog")).toEqual([]);

    // The sync write is the new baseline: the next append is a delta from empty.
    store.writeAll("mcpAuditLog", [rec("c")], 10);
    await settle();
    expect(held[2]!.op).toMatchObject({ op: "ringApply", upserts: [{ recordId: "c" }] });
  });

  it("drops a queued snapshot superseded by a sync write", async () => {
    const held = holdWorker();
    store.writeAll("mcpAuditLog", [rec("a")], 10);
    store.writeAll("mcpAuditLog", [rec("a"), rec("stale")], 10);
    store.writeAll("mcpAuditLog", [rec("a"), rec("final")], 10, { sync: true });

    held[0]!.resolve(false);
    await settle();
    expect(held).toHaveLength(1);
    expect(store.readAll<Rec>("mcpAuditLog").map((r) => r.id)).toEqual(["a", "final"]);
  });

  it("sync writes fence queued worker writes first, then persist on the main connection", () => {
    const txSpy = vi.spyOn(harness.db!, "transaction");
    store.writeAll("mcpAuditLog", [rec("a"), rec("b")], 5, { sync: true });

    expect(mockRunDbWork).not.toHaveBeenCalled();
    expect(mockFence).toHaveBeenCalledTimes(1);
    expect(mockFence.mock.invocationCallOrder[0]!).toBeLessThan(txSpy.mock.invocationCallOrder[0]!);
    expect(store.readAll<Rec>("mcpAuditLog").map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("applies a delta through the main-connection fallback", async () => {
    store.writeAll("forgeAuditLog", [rec("a")], 10);
    await settle();
    mockRunDbWork.mockImplementation((_op: unknown, fallback: () => unknown) =>
      Promise.resolve(fallback())
    );
    opCounts();

    store.writeAll("forgeAuditLog", [rec("a"), rec("b")], 10);
    await settle();
    expect(sentOps()[1]!.op).toBe("ringApply");
    expect(opCounts()).toEqual({ insert: 1 });
    expect(store.readAll<Rec>("forgeAuditLog").map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("forgets the acknowledged state after a failed write and replaces the ring next time", async () => {
    const held = holdWorker();
    store.writeAll("mcpAuditLog", [rec("a")], 10);
    held[0]!.resolve(workerExecutes(held[0]!.op));
    await settle();

    store.writeAll("mcpAuditLog", [rec("a"), rec("b")], 10);
    held[1]!.resolve(undefined);
    await settle();
    expect(held).toHaveLength(2);

    store.writeAll("mcpAuditLog", [rec("a"), rec("b"), rec("c")], 10);
    expect(held[2]!.op.op).toBe("ringWriteAll");
  });
});
