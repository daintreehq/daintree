import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  parseAnswers,
  serializeAnswers,
  type AnswerEntry,
  type InjectionIntent,
  type OutboxItem,
  type QuestionOrigin,
  type QuestionRow,
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
  hasDecisionsData,
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

const answer = (revision: number, over: Partial<AnswerEntry> = {}): AnswerEntry => ({
  entry_id: `a${revision}`,
  kind: "answer",
  action: "answer",
  revision,
  source: "human",
  correction: revision > 1,
  created_at: "2026-11-01T00:00:00.000Z",
  deliver: true,
  delivered: false,
  sealed: `{"sealed":${revision}}`,
  ...over,
});

/** The answers delivery would still type: the library's own rule (`deliver && !delivered`). */
function pendingRevisions(q: QuestionRow): number[] {
  return parseAnswers(q.answers_json)
    .filter((e) => e.deliver && !e.delivered)
    .map((e) => e.revision);
}

/** Makes `sql`'s statements throw `error` on their next read, once. */
function failNextRead(db: Database.Database, sql: string, error: Error): void {
  const original = db.prepare.bind(db);
  let failed = false;
  vi.spyOn(db, "prepare").mockImplementation(((source: string) => {
    const statement = original(source);
    if (!source.includes(sql)) return statement;
    const get = statement.get.bind(statement);
    statement.get = ((...args: unknown[]) => {
      if (!failed) {
        failed = true;
        throw error;
      }
      return get(...args);
    }) as typeof statement.get;
    return statement;
  }) as typeof db.prepare);
}

function sqliteError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("DaintreeLocalStore", () => {
  it("keeps every question, undelivered answer, intent and the event log across a restart", async () => {
    const answered = serializeAnswers([
      answer(1, { delivered: true, injection_id: "i0" }),
      answer(2),
    ]);
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
    // Delivery finds what to type by listing questions and their pending answers.
    const listed = await second.listQuestions();
    expect(listed.map((q) => q.question_id)).toEqual(["q1"]);
    expect(pendingRevisions(listed[0])).toEqual([2]);
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

  it("commits the erase with synchronous FULL and hands the connection back at its own level", async () => {
    const store = new DaintreeLocalStore(sqlite);
    await store.commitNewQuestion(row("q1", 1), item("o1", "q1"));
    await store.close();
    const levels: number[] = [];
    const original = sqlite.transaction.bind(sqlite);
    vi.spyOn(sqlite, "transaction").mockImplementation(((fn: (...args: unknown[]) => unknown) => {
      levels.push(Number(sqlite.pragma("synchronous", { simple: true })));
      return original(fn);
    }) as typeof sqlite.transaction);

    eraseDecisionsData(sqlite);

    expect(levels).toEqual([SYNCHRONOUS_FULL]);
    expect(sqlite.pragma("synchronous", { simple: true })).toBe(SYNCHRONOUS_NORMAL);
  });

  it("says whether any Decisions row is stored, finding a row in each table on its own", async () => {
    const tables = [
      "decisions_meta",
      "decisions_questions",
      "decisions_outbox",
      "decisions_inbound_events",
      "decisions_injection_intents",
      "decisions_audit",
    ];
    expect(hasDecisionsData(sqlite)).toBe(false);
    sqlite
      .prepare("INSERT INTO app_state (key, value) VALUES (?, ?)")
      .run("unrelated", JSON.stringify(1));
    expect(hasDecisionsData(sqlite)).toBe(false);

    for (const only of tables) {
      const store = new DaintreeLocalStore(sqlite);
      await store.setMeta("k", "v");
      await store.commitNewQuestion(row("q1", 1), item("o1", "q1"));
      await store.putIntent(intent("i1", "q1"));
      await store.insertEvent(event(1));
      await store.appendAudit({ at: "a", event: "x" });
      await store.close();
      for (const table of tables) {
        if (table !== only) sqlite.prepare(`DELETE FROM ${table}`).run();
      }
      expect(count(sqlite, only), only).toBeGreaterThan(0);

      expect(hasDecisionsData(sqlite), only).toBe(true);
      eraseDecisionsData(sqlite);
      expect(hasDecisionsData(sqlite), only).toBe(false);
    }
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

describe("DaintreeLocalStore ordering and failures", () => {
  it("lets a read made behind a queued write see that write", async () => {
    const store = new DaintreeLocalStore(sqlite);

    const writing = store.setMeta("k", "v");
    const read = store.getMeta("k");

    await writing;
    expect(await read).toBe("v");
  });

  it("gives other work a turn between batches of a long burst", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const commits = countCommits(sqlite);
    const writes = Array.from({ length: DECISIONS_STORE_MAX_BATCH + 1 }, (_, i) =>
      store.insertEvent(event(i + 1))
    );
    const between = new Promise<number>((resolve) => setImmediate(() => resolve(commits())));

    expect(await between).toBe(1);
    await Promise.all(writes);
    expect(commits()).toBe(2);
  });

  it("commits every queued batch before close resolves", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const total = DECISIONS_STORE_MAX_BATCH * 2 + 1;
    const writes = Array.from({ length: total }, (_, i) => store.insertEvent(event(i + 1)));

    await store.close();

    expect(count(sqlite, "decisions_inbound_events")).toBe(total);
    expect((await Promise.all(writes)).every(Boolean)).toBe(true);
  });

  it("refuses every call in a batch whose commit fails, and stores none of it", async () => {
    const store = new DaintreeLocalStore(sqlite);
    // A deferred foreign key is only checked at COMMIT, after every call ran.
    sqlite.exec(`
      CREATE TABLE commit_probe_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE commit_probe_child (
        parent INTEGER REFERENCES commit_probe_parent(id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE TRIGGER commit_probe AFTER INSERT ON decisions_audit
        BEGIN INSERT INTO commit_probe_child VALUES (999); END;
    `);

    const results = await Promise.allSettled([
      store.setMeta("k", "v"),
      store.appendAudit({ at: "a", event: "x" }),
    ]);

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(count(sqlite, "decisions_audit")).toBe(0);
    expect(count(sqlite, "decisions_meta")).toBe(0);
    expect(store.isFaulted()).toBe(true);
  });

  it("refuses the writes after a storage error in the same batch, with the rest still committing", async () => {
    const store = new DaintreeLocalStore(sqlite);
    sqlite.function("refuse_with_io_error", () => {
      throw sqliteError("SQLITE_IOERR_WRITE");
    });
    sqlite.exec(`CREATE TRIGGER io_probe BEFORE INSERT ON decisions_meta
      WHEN NEW.key = 'broken' BEGIN SELECT refuse_with_io_error(); END`);

    const results = await Promise.allSettled([
      store.setMeta("before", "1"),
      store.setMeta("broken", "1"),
      store.getMeta("before"),
      store.setMeta("after", "1"),
    ]);

    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "rejected",
    ]);
    expect(results[1]).toMatchObject({ reason: { reason: "storage-fault" } });
    expect(results[2]).toMatchObject({ value: "1" });
    expect(await store.getMeta("before")).toBe("1");
    expect(await store.getMeta("after")).toBeNull();
    expect(store.isFaulted()).toBe(true);
  });

  it("stops writing after a batch of reads fails as a whole", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const original = sqlite.transaction.bind(sqlite);
    let outer = 0;
    vi.spyOn(sqlite, "transaction").mockImplementation(((fn: (...args: unknown[]) => unknown) => {
      if (!sqlite.inTransaction && ++outer === 2) {
        return () => {
          throw sqliteError("SQLITE_IOERR_READ");
        };
      }
      return original(fn);
    }) as typeof sqlite.transaction);

    // A full batch of writes, so the read behind them runs in a batch of its own.
    const writes = Array.from({ length: DECISIONS_STORE_MAX_BATCH }, (_, i) =>
      store.setMeta(`k${i}`, "v")
    );
    const read = store.getMeta("k0");

    await Promise.all(writes);
    await expect(read).rejects.toMatchObject({ reason: "storage-fault" });
    expect(store.isFaulted()).toBe(true);
    await expect(store.setMeta("later", "v")).rejects.toMatchObject({ reason: "storage-fault" });
  });

  it("stops writing after a question can't be read, so its event can't be marked processed", async () => {
    const store = new DaintreeLocalStore(sqlite);
    await store.commitNewQuestion(row("q1", 1), item("o1", "q1"));
    await store.insertEvent(event(1));
    failNextRead(
      sqlite,
      "FROM decisions_questions WHERE question_id",
      sqliteError("SQLITE_IOERR_READ")
    );

    // The library's inbox: apply fails on the read, then it audits the error
    // and marks the event processed.
    await expect(store.getQuestion("q1")).rejects.toMatchObject({ reason: "storage-fault" });
    await expect(store.appendAudit({ at: "a", event: "event.error" })).rejects.toMatchObject({
      reason: "storage-fault",
    });
    await expect(store.markEventProcessed(1, 5)).rejects.toMatchObject({
      reason: "storage-fault",
    });

    expect((await store.unprocessedEvents(10)).map((e) => e.seq)).toEqual([1]);
    expect((await store.getQuestion("q1"))!.question_id).toBe("q1");
  });

  it("stores patches, intents and audit records as given, whatever the caller changes afterwards", async () => {
    const store = new DaintreeLocalStore(sqlite);
    await store.commitNewQuestion(row("q1", 1), item("o1", "q1"));
    const patch: Partial<QuestionRow> = { local_status: "open", origin: origin({ pane_id: "p2" }) };
    const stored = intent("i1", "q1");
    const entry = { at: "a", event: "x", detail: { n: 1 } };

    const writes = [
      store.updateQuestion("q1", patch),
      store.putIntent(stored),
      store.appendAudit(entry),
    ];
    patch.local_status = "cancelled";
    patch.origin!.pane_id = "p3";
    stored.state = "abandoned";
    entry.detail.n = 2;
    await Promise.all(writes);

    expect(await store.getQuestion("q1")).toMatchObject({
      local_status: "open",
      origin: { pane_id: "p2" },
    });
    expect((await store.getIntent("i1"))!.state).toBe("intent");
    expect((await store.listAudit(1))[0].detail).toEqual({ n: 1 });
  });

  it("replaces a queued outbox item's payload and due time, keeping its attempts", async () => {
    const store = new DaintreeLocalStore(sqlite);
    await store.commitNewQuestion(row("q1", 1), item("o1", "q1", 10));
    await store.recordOutboxFailure("o1", "network_error", 20);

    await store.putOutbox({ ...item("o1", "q1", 10), payload: { n: 2 }, next_attempt_at: 5 });
    await store.putOutbox(item("o2", "q1", 30));

    expect(await store.outboxFor("q1")).toEqual([
      {
        ...item("o1", "q1", 10),
        payload: { n: 2 },
        next_attempt_at: 5,
        attempts: 1,
        last_error: "network_error",
      },
      item("o2", "q1", 30),
    ]);
  });

  it("says an answer waits only while one waits to be typed or reported", async () => {
    const store = new DaintreeLocalStore(sqlite);
    await store.commitNewQuestion(
      row("q1", 1, { delivery_status: "relay-queued" }),
      item("o1", "q1")
    );
    await store.commitNewQuestion(
      row("q2", 2, { delivery_status: "desktop-received", history_only: true }),
      item("o2", "q2")
    );
    await store.commitNewQuestion(
      row("q3", 3, { delivery_status: "needs-attention" }),
      item("o3", "q3")
    );
    expect(await store.hasPendingDelivery()).toBe(false);

    await store.updateQuestion("q1", { delivery_status: "desktop-received" });
    expect(await store.hasPendingDelivery()).toBe(true);
    await store.updateQuestion("q1", { delivery_status: "pending-host" });
    expect(await store.hasPendingDelivery()).toBe(true);

    await store.updateQuestion("q1", { delivery_status: "terminal-delivered" });
    await store.putIntent(intent("i1", "q1", { state: "typed" }));
    expect(await store.hasPendingDelivery()).toBe(true);
    await store.updateIntent("i1", { state: "acked" });
    expect(await store.hasPendingDelivery()).toBe(false);
  });

  it("finds a waiting answer through its partial index, never a table scan", () => {
    const plan = (
      sqlite
        .prepare(
          `EXPLAIN QUERY PLAN SELECT 1 FROM decisions_questions
           WHERE delivery_status IN ('desktop-received', 'pending-host') AND history_only = 0
           LIMIT 1`
        )
        .all() as { detail: string }[]
    )
      .map((step) => step.detail)
      .join("\n");
    expect(plan).toContain("decisions_questions_pending_delivery_idx");
    expect(plan).not.toMatch(/^SCAN decisions_questions$/m);
  });

  it("tells commit listeners once per transaction that stored a write, never for reads or refusals", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const committed = vi.fn();
    const off = store.onCommit(committed);

    await Promise.all([
      store.commitNewQuestion(row("q1", 1), item("o1", "q1")),
      store.setMeta("k", "v"),
    ]);
    expect(committed).toHaveBeenCalledTimes(1);

    await store.getQuestion("q1");
    await store.listQuestions();
    expect(committed).toHaveBeenCalledTimes(1);

    await expect(store.commitNewQuestion(row("q1", 1), item("o2", "q1"))).rejects.toThrow();
    expect(committed).toHaveBeenCalledTimes(1);

    off();
    await store.setMeta("k", "w");
    expect(committed).toHaveBeenCalledTimes(1);
  });

  it("keeps a write stored when a commit listener throws", async () => {
    const store = new DaintreeLocalStore(sqlite);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const later = vi.fn();
    store.onCommit(() => {
      throw new Error("listener broke");
    });
    store.onCommit(later);

    await expect(store.setMeta("k", "v")).resolves.toBeUndefined();
    expect(await store.getMeta("k")).toBe("v");
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("refuses a new question carrying plaintext content", async () => {
    const store = new DaintreeLocalStore(sqlite);

    await expect(
      store.commitNewQuestion(row("q1", 1, { legacy_content_json: '{"q":1}' }), item("o1", "q1"))
    ).rejects.toThrow("sealed");
    expect(count(sqlite, "decisions_questions")).toBe(0);
    expect(count(sqlite, "decisions_outbox")).toBe(0);
  });

  it("erases all or nothing", async () => {
    const store = new DaintreeLocalStore(sqlite);
    await store.commitNewQuestion(row("q1", 1), item("o1", "q1"));
    await store.setMeta("k", "v");
    await store.close();
    sqlite.exec(`CREATE TRIGGER erase_probe BEFORE DELETE ON decisions_meta
      BEGIN SELECT RAISE(ABORT, 'refused'); END`);

    expect(() => eraseDecisionsData(sqlite)).toThrow("refused");

    expect(count(sqlite, "decisions_outbox")).toBe(1);
    expect(count(sqlite, "decisions_questions")).toBe(1);
  });
});
