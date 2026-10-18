import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
}));

import { openDb } from "../../../services/persistence/db.js";
import { RETIRED_OUTCOME, RetiredExchangeStore } from "../RetiredExchangeStore.js";
import type { SenderActor } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../services/persistence/migrations");

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const shellA: SenderActor = { kind: "sender", senderId: "shell-a" };
const shellB: SenderActor = { kind: "sender", senderId: "shell-b" };

let dir: string;
let sqlite: Database.Database;
let now: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-retired-store-"));
  sqlite = openDb(path.join(dir, "app.db"), migrationsFolder).sqlite;
  now = Date.UTC(2026, 9, 18, 12);
});

afterEach(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A record as a v0.44 host wrote it, by the columns its store kept. */
function seed(row: {
  messageId: string;
  state: string;
  revision: number;
  senderId?: string;
}): void {
  const senderId = row.senderId ?? shellA.senderId;
  sqlite
    .prepare(
      `INSERT INTO assistant_exchanges (task_id, sender_id, message_id, context_id, reference_task_ids,
         receiver_host_id, receiver_lane_id, enrollment_generation, state, outcome, payload_digest,
         body_digest, body_bytes, created_at, updated_at, expires_at, revision, accepted_at)
       VALUES (?, ?, ?, ?, '[]', 'local', 'proj-2:0', 'open', ?, NULL, 'p', 'b', 12, ?, ?, ?, ?, ?)`
    )
    .run(
      `task-${senderId}-${row.messageId}`,
      senderId,
      row.messageId,
      `ctx-${row.messageId}`,
      row.state,
      now,
      now,
      now + DAY,
      row.revision,
      now
    );
  sqlite
    .prepare(
      "INSERT INTO assistant_exchange_clock (id, revision, min_cursor) VALUES (1, ?, 0) ON CONFLICT(id) DO UPDATE SET revision = max(revision, excluded.revision)"
    )
    .run(row.revision);
}

function store(): RetiredExchangeStore {
  return new RetiredExchangeStore(sqlite, { now: () => now });
}

const key = (sender: SenderActor, messageId: string) => ({
  senderId: sender.senderId,
  messageId,
});

describe("RetiredExchangeStore (#13496)", () => {
  it("ends every open exchange across batches, and finds nothing open after", () => {
    for (let i = 1; i <= 5; i++) seed({ messageId: `open-${i}`, state: "working", revision: i });
    seed({ messageId: "done", state: "completed", revision: 6 });
    const retired = store();

    const batches: Array<{ failed: number; hasMore: boolean }> = [];
    let batch: { failed: number; hasMore: boolean };
    do {
      batch = retired.retireOpen(2);
      batches.push(batch);
    } while (batch.hasMore);

    expect(batches.map((b) => b.failed)).toEqual([2, 2, 1]);
    expect(retired.retireOpen()).toEqual({ failed: 0, hasMore: false });
    for (let i = 1; i <= 5; i++) {
      expect(retired.get(shellA, key(shellA, `open-${i}`))).toMatchObject({
        state: "failed",
        outcome: RETIRED_OUTCOME,
        terminalAt: now,
      });
    }
    expect(retired.get(shellA, key(shellA, "done"))).toMatchObject({
      state: "completed",
      outcome: null,
      revision: 6,
    });
  });

  it("shows a Shell reading past its last cursor each exchange that ended, and only those", () => {
    seed({ messageId: "open", state: "input-required", revision: 1 });
    seed({ messageId: "done", state: "completed", revision: 2 });
    const retired = store();
    retired.retireOpen();

    const changes = retired.listChangesSince(shellA, 2);
    expect(changes.reset).toBe(false);
    expect(changes.records.map((record) => record.messageId)).toEqual(["open"]);
    expect(changes.records[0]).toMatchObject({ state: "failed", outcome: RETIRED_OUTCOME });
    expect(retired.listChangesSince(shellA, changes.cursor).records).toEqual([]);
  });

  it("answers each sender only from its own records, the same message id included", () => {
    seed({ messageId: "m-1", state: "working", revision: 1 });
    seed({ messageId: "m-1", state: "completed", revision: 2, senderId: shellB.senderId });
    const retired = store();
    retired.retireOpen();

    expect(retired.get(shellA, key(shellA, "m-1"))).toMatchObject({ state: "failed" });
    expect(retired.get(shellB, key(shellB, "m-1"))).toMatchObject({ state: "completed" });
    // Naming another sender's key reads nothing.
    expect(retired.get(shellA, key(shellB, "m-1"))).toBeNull();
    expect(retired.listChangesSince(shellB, 0).records.map((record) => record.senderId)).toEqual([
      shellB.senderId,
    ]);
  });

  it("tombstones past the TTL, purges past retention, and resets a cursor from before the purge", () => {
    seed({ messageId: "open", state: "working", revision: 1 });
    const retired = store();
    retired.retireOpen();
    const before = retired.listChangesSince(shellA, 0);
    expect(before.records).toHaveLength(1);

    now += DAY + HOUR;
    expect(retired.sweep()).toMatchObject({ expired: 1, purged: 0, hasMore: false });
    expect(retired.get(shellA, key(shellA, "open"))).toMatchObject({
      state: "failed",
      outcome: RETIRED_OUTCOME,
      tombstonedAt: now,
    });

    now += 8 * DAY;
    expect(retired.sweep()).toMatchObject({ purged: 1 });
    expect(retired.get(shellA, key(shellA, "open"))).toBeNull();
    const after = retired.listChangesSince(shellA, before.cursor - 1);
    expect(after).toMatchObject({ reset: true, records: [], hasMore: false });
  });

  it("fails closed with no database rather than reading as never sent", () => {
    const retired = new RetiredExchangeStore(null);
    expect(() => retired.get(shellA, key(shellA, "m-1"))).toThrow(
      expect.objectContaining({ code: "PERSIST_FAILED" })
    );
    expect(() => retired.retireOpen()).toThrow(expect.objectContaining({ code: "PERSIST_FAILED" }));
  });
});
