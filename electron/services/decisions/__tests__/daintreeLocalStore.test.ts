import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type {
  InjectionIntent,
  OutboxItem,
  QuestionOrigin,
  QuestionRow,
} from "@daintreehq/decisions-client";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
}));

import { openDb } from "../../persistence/db.js";
import { resetWritesSuppressedForTesting, setWritesSuppressed } from "../../diskPressureState.js";
import {
  DaintreeLocalStore,
  DECISIONS_STORE_MAX_BATCH,
  DecisionsStoreUnavailableError,
  eraseDecisionsData,
} from "../daintreeLocalStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../persistence/migrations");

const SYNCHRONOUS_NORMAL = 1;
const SYNCHRONOUS_FULL = 2;

let dir: string;
let dbPath: string;
let sqlite: Database.Database;
const extra: Database.Database[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-decisions-store-"));
  dbPath = path.join(dir, "app.db");
  sqlite = openDb(dbPath, migrationsFolder).sqlite;
});

afterEach(() => {
  resetWritesSuppressedForTesting();
  for (const db of [sqlite, ...extra.splice(0)]) if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function reader(): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  extra.push(db);
  return db;
}

const origin = (over: Partial<QuestionOrigin> = {}): QuestionOrigin => ({
  host_id: "host-local",
  pane_id: "pane-1",
  terminal_generation: 1,
  ownership_principal: "principal-1",
  agent_incarnation: "inc-1",
  agent_kind: "claude",
  agent_session_id: "sess-1",
  project_id: "proj-1",
  worktree_id: "wt-1",
  worktree_root: "/work/proj-1",
  workflow_gate_id: null,
  ...over,
});

const row = (id: string, alias: number, over: Partial<QuestionRow> = {}): QuestionRow => ({
  question_id: id,
  alias,
  origin: origin(),
  requirement: "human-required",
  question_revision: 0,
  remote_event_seq: null,
  origin_created_at: "2026-11-01T00:00:00.000Z",
  expires_at: null,
  local_status: "queued",
  delivery_status: "not-sent",
  last_injection_id: null,
  last_attempt_at: null,
  agent_resume_strategy: null,
  error_code: null,
  content_sealed: '{"sealed":1}',
  answers_json: "[]",
  history_only: false,
  delivered_revision: 0,
  attachment_digests: [],
  ...over,
});

const item = (id: string, qid: string, at = 1): OutboxItem => ({
  id,
  kind: "create",
  question_id: qid,
  payload: { n: 1 },
  attempts: 0,
  next_attempt_at: at,
  created_at: at,
  last_error: null,
});

const intent = (id: string, qid: string, over: Partial<InjectionIntent> = {}): InjectionIntent => ({
  injection_id: id,
  question_id: qid,
  answer_revision: 1,
  host_id: "host-local",
  pane_id: "pane-1",
  terminal_generation: 1,
  ownership_principal: "principal-1",
  agent_incarnation: "inc-1",
  state: "intent",
  created_at: 1,
  updated_at: 1,
  ...over,
});

const event = (seq: number) => ({
  seq,
  event_id: `e${seq}`,
  event_type: "decision.answered",
  json: "{}",
  received_at: 1,
  processed_at: null,
});

/** Counts the transactions the store opens on `db`, leaving out the savepoints inside them. */
function countCommits(db: Database.Database): () => number {
  let outer = 0;
  const original = db.transaction.bind(db);
  vi.spyOn(db, "transaction").mockImplementation(((fn: (...args: unknown[]) => unknown) => {
    if (!db.inTransaction) outer++;
    return original(fn);
  }) as typeof db.transaction);
  return () => outer;
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("DaintreeLocalStore", () => {
  it("keeps every question, undelivered answer, intent and the event log across a restart", async () => {
    const answered = JSON.stringify([{ entry_id: "a1", kind: "answer", revision: 1, sealed: "x" }]);
    const first = new DaintreeLocalStore(sqlite);
    expect(await first.nextAlias()).toBe(1);
    await first.commitNewQuestion(
      row("q1", 1, { origin: origin({ project_label: "Daintree", machine_label: "Studio" }) }),
      item("o1", "q1")
    );
    await first.recordOutboxFailure("o1", "network_error", 50);
    await first.updateQuestion("q1", {
      local_status: "human-answered",
      delivery_status: "desktop-received",
      answers_json: answered,
    });
    await first.putIntent(intent("i1", "q1"));
    await first.insertEvent(event(1));
    await first.insertEvent(event(2));
    await first.advanceCursor();
    await first.markEventProcessed(1, 5);
    await first.appendAudit({ at: "a", event: "question.created", question_id: "q1" });
    await first.close();
    sqlite.close();

    sqlite = openDb(dbPath, migrationsFolder).sqlite;
    const second = new DaintreeLocalStore(sqlite);
    const question = (await second.getQuestion("q1"))!;
    expect(question).toMatchObject({
      local_status: "human-answered",
      delivery_status: "desktop-received",
      delivered_revision: 0,
      answers_json: answered,
    });
    expect(question.origin).toEqual(origin({ project_label: "Daintree", machine_label: "Studio" }));
    expect(await second.outboxFor("q1")).toEqual([
      { ...item("o1", "q1"), attempts: 1, last_error: "network_error", next_attempt_at: 50 },
    ]);
    expect((await second.openIntents()).map((i) => i.injection_id)).toEqual(["i1"]);
    expect(await second.getCursor()).toBe(2);
    expect((await second.unprocessedEvents(10)).map((e) => e.seq)).toEqual([2]);
    expect((await second.listAudit(10)).map((a) => a.event)).toEqual(["question.created"]);
    expect(await second.nextAlias()).toBe(2);
  });

  it("has a question on disk, visible to another connection, by the time its commit resolves", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const other = reader();

    const committing = store.commitNewQuestion(row("q1", 1), item("o1", "q1"));
    expect(count(other, "decisions_questions")).toBe(0);
    await committing;

    expect(count(other, "decisions_questions")).toBe(1);
    expect(count(other, "decisions_outbox")).toBe(1);
  });

  it("commits calls made together in one transaction, and calls awaited in turn one at a time", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const commits = countCommits(sqlite);

    await Promise.all([
      store.commitNewQuestion(row("q1", 1), item("o1", "q1")),
      store.insertEvent(event(1)),
      store.insertEvent(event(2)),
      store.advanceCursor(),
      store.appendAudit({ at: "a", event: "x" }),
    ]);
    expect(commits()).toBe(1);
    expect(await store.getCursor()).toBe(2);

    await store.insertEvent(event(3));
    await store.advanceCursor();
    expect(commits()).toBe(3);
  });

  it("splits a burst larger than one batch, and settles every call", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const commits = countCommits(sqlite);
    const total = DECISIONS_STORE_MAX_BATCH + 10;

    const inserted = await Promise.all(
      Array.from({ length: total }, (_, i) => store.insertEvent(event(i + 1)))
    );

    expect(inserted.every(Boolean)).toBe(true);
    expect(commits()).toBe(2);
    expect(await store.advanceCursor()).toBe(total);
  });

  it("commits writes with synchronous FULL and hands the connection back at its own level", async () => {
    const store = new DaintreeLocalStore(sqlite);
    await store.commitNewQuestion(row("q1", 1), item("o1", "q1"));
    // The level each of the store's transactions commits at, read as it begins.
    const levels: number[] = [];
    const original = sqlite.transaction.bind(sqlite);
    vi.spyOn(sqlite, "transaction").mockImplementation(((fn: (...args: unknown[]) => unknown) => {
      if (!sqlite.inTransaction)
        levels.push(Number(sqlite.pragma("synchronous", { simple: true })));
      return original(fn);
    }) as typeof sqlite.transaction);
    expect(sqlite.pragma("synchronous", { simple: true })).toBe(SYNCHRONOUS_NORMAL);

    await store.appendAudit({ at: "a", event: "x" });
    await Promise.all([store.appendAudit({ at: "b", event: "y" }), store.getQuestion("q1")]);
    await store.getQuestion("q1");

    expect(levels).toEqual([SYNCHRONOUS_FULL, SYNCHRONOUS_FULL]);
    expect(sqlite.pragma("synchronous", { simple: true })).toBe(SYNCHRONOUS_NORMAL);
  });

  it("rolls a question back with its outbox item, while another call in the same batch commits", async () => {
    const store = new DaintreeLocalStore(sqlite);
    sqlite.exec(`CREATE TRIGGER decisions_refuse_outbox BEFORE INSERT ON decisions_outbox
      WHEN NEW.id = 'broken' BEGIN SELECT RAISE(ABORT, 'refused'); END`);

    const results = await Promise.allSettled([
      store.commitNewQuestion(row("q1", 1), item("broken", "q1")),
      store.commitNewQuestion(row("q2", 2), item("o2", "q2")),
    ]);

    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
    expect(await store.getQuestion("q1")).toBeNull();
    expect(await store.getQuestion("q2")).not.toBeNull();
    expect(store.isFaulted()).toBe(false);
  });

  it("rolls an intent's settlement back when its question can't be updated", async () => {
    const store = new DaintreeLocalStore(sqlite);
    await store.commitNewQuestion(row("q1", 1), item("o1", "q1"));
    await store.putIntent(intent("i1", "q1"));
    sqlite.exec(`CREATE TRIGGER decisions_refuse_question BEFORE UPDATE ON decisions_questions
      BEGIN SELECT RAISE(ABORT, 'refused'); END`);

    await expect(
      store.settleIntent("i1", { state: "uncertain" }, "q1", {
        delivery_status: "delivery-uncertain",
      })
    ).rejects.toThrow("refused");

    expect((await store.getIntent("i1"))!.state).toBe("intent");
    expect(await store.hasUncertainIntent("q1")).toBe(false);
  });

  it("stores what a call was given, not what its caller changed afterwards", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const question = row("q1", 1);
    const outbox = item("o1", "q1");

    const committing = store.commitNewQuestion(question, outbox);
    question.local_status = "cancelled";
    question.origin.pane_id = "pane-other";
    outbox.payload = { n: 2 };
    await committing;

    const stored = (await store.getQuestion("q1"))!;
    expect(stored.local_status).toBe("queued");
    expect(stored.origin.pane_id).toBe("pane-1");
    expect((await store.outboxFor("q1"))[0].payload).toEqual({ n: 1 });
  });

  it("refuses plaintext content, which it has nowhere to keep", async () => {
    const store = new DaintreeLocalStore(sqlite);
    await store.commitNewQuestion(row("q1", 1), item("o1", "q1"));

    await expect(store.updateQuestion("q1", { legacy_content_json: '{"q":1}' })).rejects.toThrow(
      "sealed"
    );
    expect(await store.updateQuestion("q1", { legacy_content_json: null })).toMatchObject({
      question_id: "q1",
    });
  });

  describe("while disk space is critical", () => {
    it("refuses a question queued before the pressure began, and keeps reading", async () => {
      const store = new DaintreeLocalStore(sqlite);
      await store.commitNewQuestion(row("q1", 1), item("o1", "q1"));

      const committing = store.commitNewQuestion(row("q2", 2), item("o2", "q2"));
      setWritesSuppressed(true);

      await expect(committing).rejects.toMatchObject({ reason: "disk-pressure" });
      await expect(store.appendAudit({ at: "a", event: "x" })).rejects.toBeInstanceOf(
        DecisionsStoreUnavailableError
      );
      expect(await store.getQuestion("q2")).toBeNull();
      expect((await store.getQuestion("q1"))!.question_id).toBe("q1");
      expect(count(sqlite, "decisions_audit")).toBe(0);
    });

    it("keeps refusing writes once the pressure lifts, until a fresh store is opened", async () => {
      const store = new DaintreeLocalStore(sqlite);
      await store.insertEvent(event(1));
      setWritesSuppressed(true);
      await expect(store.updateQuestion("q1", { local_status: "open" })).rejects.toMatchObject({
        reason: "disk-pressure",
      });

      setWritesSuppressed(false);
      // The library marks an event processed after a failed apply; that must
      // not land once the apply's write was refused.
      await expect(store.markEventProcessed(1, 5)).rejects.toMatchObject({
        reason: "disk-pressure",
      });
      expect(store.isFaulted()).toBe(true);
      expect((await store.unprocessedEvents(10)).map((e) => e.seq)).toEqual([1]);

      const fresh = new DaintreeLocalStore(sqlite);
      await fresh.markEventProcessed(1, 5);
      expect(await fresh.unprocessedEvents(10)).toEqual([]);
    });
  });

  it("stops writing after the database refuses a write, even once there is room again", async () => {
    const store = new DaintreeLocalStore(sqlite);
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    const pages = Number(sqlite.pragma("page_count", { simple: true }));
    sqlite.pragma(`max_page_count = ${pages}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const big = "x".repeat(64 * 1024);
    await expect(store.setMeta("big", big)).rejects.toMatchObject({ reason: "storage-fault" });
    expect(store.isFaulted()).toBe(true);

    sqlite.pragma(`max_page_count = ${pages * 1000}`);
    await expect(store.setMeta("small", "1")).rejects.toMatchObject({ reason: "storage-fault" });
    expect(await store.getMeta("small")).toBeNull();
    expect(sqlite.pragma("synchronous", { simple: true })).toBe(SYNCHRONOUS_NORMAL);
    warn.mockRestore();
  });

  it("settles queued calls on close, refuses calls after it, and leaves the connection open", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const committing = store.commitNewQuestion(row("q1", 1), item("o1", "q1"));

    await store.close();
    await committing;
    await store.close();

    await expect(store.getQuestion("q1")).rejects.toMatchObject({ reason: "closed" });
    expect(sqlite.open).toBe(true);
    expect(count(sqlite, "decisions_questions")).toBe(1);
  });

  it("erases everything Decisions stored and nothing else", async () => {
    const store = new DaintreeLocalStore(sqlite);
    await store.nextAlias();
    await store.commitNewQuestion(row("q1", 1), item("o1", "q1"));
    await store.putIntent(intent("i1", "q1"));
    await store.insertEvent(event(1));
    await store.appendAudit({ at: "a", event: "x" });
    await store.close();
    sqlite
      .prepare("INSERT INTO app_state (key, value) VALUES (?, ?)")
      .run("unrelated", JSON.stringify(1));

    eraseDecisionsData(sqlite);

    for (const table of [
      "decisions_meta",
      "decisions_questions",
      "decisions_outbox",
      "decisions_inbound_events",
      "decisions_injection_intents",
      "decisions_audit",
    ]) {
      expect(count(sqlite, table), table).toBe(0);
    }
    expect(sqlite.prepare("SELECT value FROM app_state WHERE key = 'unrelated'").get()).toEqual({
      value: "1",
    });
    expect(await new DaintreeLocalStore(sqlite).nextAlias()).toBe(1);
  });

  it("refuses to erase while disk space is critical", async () => {
    const store = new DaintreeLocalStore(sqlite);
    await store.commitNewQuestion(row("q1", 1), item("o1", "q1"));
    await store.close();
    setWritesSuppressed(true);

    expect(() => eraseDecisionsData(sqlite)).toThrow(DecisionsStoreUnavailableError);
    expect(count(sqlite, "decisions_questions")).toBe(1);
  });
});
