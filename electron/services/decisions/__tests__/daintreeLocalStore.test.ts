import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
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

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/logger.js")>();
  return {
    ...actual,
    logWarn: vi.fn((...args: Parameters<typeof actual.logWarn>) => logWarn(...args)),
  };
});

import { openDb } from "../../persistence/db.js";
import { resetWritesSuppressedForTesting, setWritesSuppressed } from "../../diskPressureState.js";
import {
  DaintreeLocalStore,
  DECISIONS_STORE_MAX_BATCH,
  DecisionsStoreUnavailableError,
  eraseDecisionsData,
  hasDecisionsData,
} from "../daintreeLocalStore.js";
import { DECLINE, answers, messages } from "./questionRows.js";

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
  messages_json: "[]",
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
  message_id: null,
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

  it("lists questions by status and pane in alias order, decoding only the rows it returns", async () => {
    const store = new DaintreeLocalStore(sqlite);
    await store.commitNewQuestion(row("q1", 1, { local_status: "queued" }), item("o1", "q1"));
    await store.commitNewQuestion(row("q2", 2, { local_status: "cancelled" }), item("o2", "q2"));
    await store.commitNewQuestion(
      row("q3", 3, { local_status: "queued", origin: origin({ pane_id: "pane-2" }) }),
      item("o3", "q3")
    );
    await store.commitNewQuestion(row("q4", 4, { local_status: "open" }), item("o4", "q4"));
    // A settled row the filter leaves out is never parsed, so one that wouldn't
    // parse can't fail a read of the open questions.
    sqlite
      .prepare(
        "UPDATE decisions_questions SET attachment_digests = 'not json' WHERE question_id = ?"
      )
      .run("q2");

    const ids = async (filter?: Parameters<DaintreeLocalStore["listQuestions"]>[0]) =>
      (await store.listQuestions(filter)).map((q) => q.question_id);
    expect(await ids({ status: ["queued", "open"] })).toEqual(["q1", "q3", "q4"]);
    expect(await ids({ status: ["queued"], paneId: "pane-1" })).toEqual(["q1"]);
    expect(await ids({ paneId: "pane-2" })).toEqual(["q3"]);
    expect(await ids({ status: [] })).toEqual([]);
    await expect(store.listQuestions()).rejects.toThrow();

    const plan = sqlite
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM decisions_questions WHERE local_status IN (?, ?) ORDER BY alias ASC"
      )
      .all("queued", "open") as { detail: string }[];
    expect(plan.map((step) => step.detail).join("\n")).toContain("decisions_questions_status_idx");
  });

  it("reads only the questions still missing a session on this host, never the linked history (#17783)", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const unlinked = (over: Partial<QuestionOrigin>) =>
      origin({ agent_kind: "codex", agent_session_id: null, ...over });
    await store.commitNewQuestion(
      row("open", 1, { origin: unlinked({}), local_status: "open" }),
      item("o1", "open")
    );
    // A delivered question still counts: a correction can reopen it after its pane is gone.
    await store.commitNewQuestion(
      row("delivered", 2, {
        origin: unlinked({ agent_kind: "claude" }),
        local_status: "human-answered",
        delivery_status: "terminal-delivered",
      }),
      item("o2", "delivered")
    );
    await store.commitNewQuestion(
      row("empty", 3, { origin: unlinked({ agent_session_id: "" }) }),
      item("o3", "empty")
    );
    await store.commitNewQuestion(
      row("remote", 4, { origin: unlinked({ host_id: "host-remote" }) }),
      item("o4", "remote")
    );
    await store.commitNewQuestion(
      row("gemini", 5, { origin: unlinked({ agent_kind: "gemini" }) }),
      item("o5", "gemini")
    );
    const columns = (
      sqlite.prepare("SELECT name FROM pragma_table_info('decisions_questions')").all() as {
        name: string;
      }[]
    )
      .map((c) => c.name)
      .filter((name) => name !== "question_id" && name !== "alias");
    sqlite
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
         INSERT INTO decisions_questions (question_id, alias, ${columns.join(", ")})
         SELECT 'history-' || i, 100 + i, ${columns.join(", ")} FROM n, decisions_questions
         WHERE question_id = 'open'`
      )
      .run();
    // Statistics taken while all of them still waited for a session, so they
    // overstate the index by ten thousand rows once those are linked.
    sqlite.exec("ANALYZE");
    // Linked, and unable even to decode: reading one would throw.
    sqlite
      .prepare(
        `UPDATE decisions_questions SET agent_session_id = 'session-' || alias,
           attachment_digests = 'not json' WHERE question_id LIKE 'history-%'`
      )
      .run();

    let materialized = 0;
    const prepare = sqlite.prepare.bind(sqlite);
    const prepared: string[] = [];
    vi.spyOn(sqlite, "prepare").mockImplementation(((source: string) => {
      const statement = prepare(source);
      if (!/FROM decisions_questions/.test(source)) return statement;
      prepared.push(source);
      const all = statement.all.bind(statement);
      statement.all = ((...args: unknown[]) => {
        const rows = all(...args) as unknown[];
        materialized += rows.length;
        return rows;
      }) as typeof statement.all;
      return statement;
    }) as typeof sqlite.prepare);

    const ids = async (hostId: string, kinds: string[]) =>
      (await store.listSessionlessQuestions(hostId, kinds)).map((q) => q.question_id);
    expect(await ids("host-local", ["claude", "codex"])).toEqual(["open", "delivered", "empty"]);
    expect(materialized).toBe(3);
    expect(await ids("host-local", [])).toEqual([]);
    expect(prepared).toHaveLength(1);
    const plan = (
      prepare(`EXPLAIN QUERY PLAN ${prepared[0]}`).all("host-local") as {
        detail: string;
      }[]
    )
      .map((step) => step.detail)
      .join("\n");
    expect(plan).toContain(
      "USING INDEX decisions_questions_missing_session_idx (origin_host_id=?)"
    );
    expect(plan).not.toContain("TEMP B-TREE");

    expect(await ids("host-local", ["codex", "claude", "codex"])).toEqual([
      "open",
      "delivered",
      "empty",
    ]);
    expect(prepared).toHaveLength(1);
    expect(await ids("host-remote", ["codex"])).toEqual(["remote"]);
    expect(await ids("host-local", ["gemini"])).toEqual(["gemini"]);
    expect(await ids("host-local", ["it's"])).toEqual([]);
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

  it("names each withdrawal and decline queued, retrying or not, with a decline's round (#18052)", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const queued = (
      id: string,
      kind: OutboxItem["kind"],
      qid: string,
      payload: unknown = {},
      at = 1
    ): OutboxItem => ({ ...item(id, qid, at), kind, payload });
    const decline = (revision: unknown) => ({
      signed: { record: { expected_revision: revision, decline_id: "d1" } },
      seq: 3,
    });
    const read = async () =>
      (await store.pendingClosings()).sort((a, b) =>
        a.questionId === b.questionId
          ? a.closing.localeCompare(b.closing)
          : a.questionId.localeCompare(b.questionId)
      );
    expect(await store.pendingClosings()).toEqual([]);

    await store.putOutbox(queued("o1", "cancel", "q1"));
    // Backed off well past now: still queued.
    await store.putOutbox(queued("o2", "owner-decline", "q2", decline(2), Date.now() + 600_000));
    await store.recordOutboxFailure("o2", "relay unreachable", Date.now() + 900_000);
    await store.putOutbox(queued("o3", "owner-decline", "q3", decline(1)));
    await store.putOutbox(queued("o4", "cancel", "q3"));
    // A decline whose round can't be read is named without one.
    await store.putOutbox(queued("o5", "owner-decline", "q4", decline("2")));
    // Nothing else closes a question.
    await store.putOutbox(queued("o6", "create", "q5"));
    await store.putOutbox(queued("o7", "owner-answer", "q6", decline(1)));

    expect(await read()).toEqual([
      { questionId: "q1", closing: "withdrawing", revision: null },
      { questionId: "q2", closing: "declining", revision: 2 },
      { questionId: "q3", closing: "declining", revision: 1 },
      { questionId: "q3", closing: "withdrawing", revision: null },
      { questionId: "q4", closing: "declining", revision: null },
    ]);
    await store.deleteOutbox("o1");
    await store.deleteOutbox("o4");
    expect((await read()).map(({ questionId, closing }) => [questionId, closing])).toEqual([
      ["q2", "declining"],
      ["q3", "declining"],
      ["q4", "declining"],
    ]);
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

  it("stops writing after the database runs out of room, even once there is room again", async () => {
    logWarn.mockClear();
    const store = new DaintreeLocalStore(sqlite);
    const faults: string[] = [];
    store.onFault((reason) => faults.push(reason));
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    const pages = Number(sqlite.pragma("page_count", { simple: true }));
    sqlite.pragma(`max_page_count = ${pages}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // SQLITE_FULL: room, not the database, ran out (#16605).
    const big = "x".repeat(64 * 1024);
    await expect(store.setMeta("big", big)).rejects.toMatchObject({ reason: "disk-full" });
    expect(store.isFaulted()).toBe(true);
    expect(store.faultReason()).toBe("disk-full");

    sqlite.pragma(`max_page_count = ${pages * 1000}`);
    await expect(store.setMeta("small", "1")).rejects.toMatchObject({ reason: "disk-full" });
    expect(await store.getMeta("small")).toBeNull();
    expect(sqlite.pragma("synchronous", { simple: true })).toBe(SYNCHRONOUS_NORMAL);
    expect(faults).toEqual(["disk-full"]);
    // One line, when it stopped, with the cause's code, where the batch was
    // (#16840), and nothing it was writing.
    const latched = logWarn.mock.calls.filter(([message]) =>
      String(message).includes("stopped taking writes")
    );
    expect(latched).toEqual([
      [
        expect.any(String),
        {
          reason: "disk-full",
          code: "SQLITE_FULL",
          step: "call",
          writes: true,
          calls: 1,
          elapsedMs: expect.any(Number),
        },
      ],
    ]);
    warn.mockRestore();
  });

  it("tells its fault listeners once, with the first reason, and keeps that reason", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const faults: string[] = [];
    const removed: string[] = [];
    store.onFault((reason) => faults.push(reason));
    store.onFault((reason) => removed.push(reason))();
    expect(store.faultReason()).toBeNull();

    setWritesSuppressed(true);
    await expect(store.setMeta("k", "v")).rejects.toMatchObject({ reason: "disk-pressure" });
    setWritesSuppressed(false);
    failNextRead(sqlite, "FROM decisions_meta WHERE key", sqliteError("SQLITE_IOERR_READ"));
    await expect(store.getMeta("k")).rejects.toMatchObject({ reason: "storage-fault" });

    expect(faults).toEqual(["disk-pressure"]);
    expect(removed).toEqual([]);
    expect(store.faultReason()).toBe("disk-pressure");
  });

  it("keeps any other storage error a storage fault", async () => {
    const store = new DaintreeLocalStore(sqlite);
    failNextRead(sqlite, "FROM decisions_meta WHERE key", sqliteError("SQLITE_CORRUPT"));

    await expect(store.getMeta("k")).rejects.toMatchObject({ reason: "storage-fault" });
    expect(store.faultReason()).toBe("storage-fault");
  });

  it("still tells its other fault listeners when one throws", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const later: string[] = [];
    store.onFault(() => {
      throw new Error("listener broke");
    });
    store.onFault((reason) => later.push(reason));
    setWritesSuppressed(true);

    await expect(store.setMeta("k", "v")).rejects.toMatchObject({ reason: "disk-pressure" });
    expect(later).toEqual(["disk-pressure"]);
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
    logWarn.mockClear();
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
    expect(stopLines()).toEqual([
      expect.objectContaining({ step: "commit", writes: true, calls: 2 }),
    ]);
  });

  it("says a batch that couldn't raise its commit level failed before it began", async () => {
    const store = new DaintreeLocalStore(sqlite);
    logWarn.mockClear();
    const original = sqlite.pragma.bind(sqlite);
    vi.spyOn(sqlite, "pragma").mockImplementation(((source: string, options?: never) => {
      if (source === "synchronous = FULL") throw sqliteError("SQLITE_IOERR_WRITE");
      return original(source, options);
    }) as typeof sqlite.pragma);

    await expect(store.setMeta("k", "v")).rejects.toMatchObject({ reason: "storage-fault" });

    expect(stopLines()).toEqual([
      {
        reason: "storage-fault",
        code: "SQLITE_IOERR_WRITE",
        step: "setup",
        writes: true,
        calls: 1,
        elapsedMs: expect.any(Number),
      },
    ]);
  });

  it("refuses the writes after a storage error in the same batch, with the rest still committing", async () => {
    const store = new DaintreeLocalStore(sqlite);
    logWarn.mockClear();
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
    // The call that failed, in a batch of four that committed (#16840).
    expect(stopLines()).toEqual([
      {
        reason: "storage-fault",
        code: "SQLITE_IOERR_WRITE",
        step: "call",
        writes: true,
        calls: 4,
        elapsedMs: expect.any(Number),
      },
    ]);
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

  it("says a person's decline waits only while its notice is still to be typed (#17234)", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const declined = {
      local_status: "cancelled" as const,
      delivery_status: "desktop-received" as const,
      answers_json: answers(DECLINE),
    };
    await store.commitNewQuestion(row("q1", 1, declined), item("o1", "q1"));
    expect(await store.hasPendingDelivery()).toBe(true);

    // Dropped for a run that has gone: the row keeps its status, and nothing waits.
    await store.updateQuestion("q1", { answers_json: answers({ ...DECLINE, deliver: false }) });
    expect(await store.hasPendingDelivery()).toBe(false);
    await store.updateQuestion("q1", { delivery_status: "pending-host" });
    expect(await store.hasPendingDelivery()).toBe(false);

    // Entries that can't be read are taken as waiting, and never fail the read.
    for (const unreadable of ["not json", '["damaged"]', "[5]", '{"deliver":true}', "{}", '"x"']) {
      await store.updateQuestion("q1", { answers_json: unreadable });
      expect(await store.hasPendingDelivery()).toBe(true);
    }
    await store.updateQuestion("q1", { answers_json: answers({ ...DECLINE, deliver: false }) });
    expect(await store.hasPendingDelivery()).toBe(false);
  });

  it("says a follow-up waits while one waits to be typed or its receipt to be sent (#16231)", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const settled = { status: "terminal-delivered" as const, injection_id: "i1" };
    await store.commitNewQuestion(
      row("q1", 1, {
        delivery_status: "terminal-delivered",
        messages_json: messages({ delivery: { ...settled, reported: "terminal-delivered:i1:0" } }),
      }),
      item("o1", "q1")
    );
    await store.commitNewQuestion(
      row("q2", 2, { delivery_status: "terminal-delivered", history_only: true }),
      item("o2", "q2")
    );
    expect(await store.hasPendingDelivery()).toBe(false);

    // Received and never yet reported to the relay.
    await store.updateQuestion("q2", { messages_json: messages({ delivery: { reported: null } }) });
    expect(await store.hasPendingDelivery()).toBe(false);
    await store.updateQuestion("q1", {
      messages_json: messages(
        { delivery: { ...settled, reported: "terminal-delivered:i1:0" } },
        {
          message_id: "message-2",
          event_seq: 11,
          delivery: { reported: null },
        }
      ),
    });
    expect(await store.hasPendingDelivery()).toBe(true);

    // Waiting for the pane, its receipt sent.
    await store.updateQuestion("q1", { messages_json: messages({}) });
    expect(await store.hasPendingDelivery()).toBe(true);

    // Typed, its receipt still owed.
    await store.updateQuestion("q1", { messages_json: messages({ delivery: settled }) });
    expect(await store.hasPendingDelivery()).toBe(true);

    // Held for a person, its receipt still owed: delivery sends it.
    for (const status of ["needs-attention", "delivery-uncertain"] as const) {
      await store.updateQuestion("q1", {
        messages_json: messages({ delivery: { status, error_code: "pane_gone" } }),
      });
      expect(await store.hasPendingDelivery()).toBe(true);
    }

    // Held for a person and reported: nothing for delivery to do until a person acts.
    await store.updateQuestion("q1", {
      messages_json: messages({
        delivery: {
          status: "needs-attention",
          error_code: "pane_gone",
          reported: "needs-attention:pane_gone:0",
        },
      }),
    });
    expect(await store.hasPendingDelivery()).toBe(false);

    // Withdrawn while waiting, and an agent's own message: neither is typed.
    await store.updateQuestion("q1", {
      messages_json: messages(
        { delivery: { deliver: false } },
        { message_id: "message-2", side: "agent", delivery: null }
      ),
    });
    expect(await store.hasPendingDelivery()).toBe(false);
  });

  it("finds a waiting answer through its partial indexes, never a table scan", async () => {
    // The statements the store itself prepares, explained as SQLite will run them.
    const prepared: string[] = [];
    const prepare = sqlite.prepare.bind(sqlite);
    vi.spyOn(sqlite, "prepare").mockImplementation(((source: string) => {
      prepared.push(source);
      return prepare(source);
    }) as typeof sqlite.prepare);
    await new DaintreeLocalStore(sqlite).hasPendingDelivery();
    const queries = prepared.filter((source) => /^\s*SELECT 1 FROM/.test(source));
    expect(queries).toHaveLength(3);

    for (const query of queries) {
      const plan = (prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[])
        .map((step) => step.detail)
        .join("\n");
      expect(plan).toMatch(
        /USING (COVERING )?INDEX decisions_(questions_pending_delivery|questions_waiting_messages|injection_intents_open)_idx/
      );
      expect(plan).not.toMatch(/^SCAN decisions_(questions|injection_intents)$/m);
    }
  });

  it.each([
    ["intent", true],
    ["typed", true],
    ["acked", false],
    ["uncertain", false],
    ["abandoned", false],
  ] as const)("counts an injection left %s as waiting: %s", async (state, waiting) => {
    const store = new DaintreeLocalStore(sqlite);
    await store.commitNewQuestion(
      row("q1", 1, { delivery_status: "terminal-delivered" }),
      item("o1", "q1")
    );
    await store.putIntent(intent("i1", "q1", { state }));
    expect(await store.hasPendingDelivery()).toBe(waiting);
  });

  it("writes a create back as the publisher gives it, so a claim it withdraws stays withdrawn", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const claimed = { signed: 1, attachments: [], uploaded: ["a1"], maybePublished: true };
    await store.commitNewQuestion(row("q1", 1), { ...item("o1", "q1"), payload: claimed });

    // 0.9.0's publisher unclaims a create the relay showed it never took, before it closes the question.
    const { maybePublished: _claim, ...unsent } = claimed;
    await store.putOutbox({ ...item("o1", "q1"), payload: unsent });

    const [create] = await store.outboxFor("q1");
    expect(create.payload).toEqual({ signed: 1, attachments: [], uploaded: ["a1"] });

    // And a claim it makes stays, so a cancel from another bridge sends a real cancel after it.
    await store.putOutbox({ ...item("o1", "q1"), payload: claimed });
    expect((await store.outboxFor("q1"))[0].payload).toEqual(claimed);
  });

  it("keeps a cancelled question cancelled when a stale flush reports its create refused", async () => {
    const store = new DaintreeLocalStore(sqlite);
    await store.commitNewQuestion(row("q1", 1, { local_status: "cancelled" }), item("o1", "q1"));
    await store.commitNewQuestion(row("q2", 2), item("o2", "q2"));

    const failed = { local_status: "publish-failed" as const, error_code: "validation_error" };
    await store.updateQuestion("q1", { ...failed, last_attempt_at: "2026-11-02T00:00:00.000Z" });
    await store.updateQuestion("q2", failed);

    expect(await store.getQuestion("q1")).toMatchObject({
      local_status: "cancelled",
      error_code: null,
      last_attempt_at: "2026-11-02T00:00:00.000Z",
    });
    expect(await store.getQuestion("q2")).toMatchObject(failed);
  });

  it("keeps a question past a later event when its create's receipt is read after it (#17234)", async () => {
    const store = new DaintreeLocalStore(sqlite);
    // Declined on the phone at seq 9, before the create's response (seq 4) was read.
    await store.commitNewQuestion(
      row("q1", 1, { local_status: "cancelled", remote_event_seq: 9, error_code: "pane_gone" }),
      item("o1", "q1")
    );
    await store.commitNewQuestion(row("q2", 2), item("o2", "q2"));
    const receipt = (seq: number) =>
      ({ local_status: "open", remote_event_seq: seq, error_code: null }) as const;

    await store.updateQuestion("q1", receipt(4));
    await store.updateQuestion("q2", receipt(5));

    expect(await store.getQuestion("q1")).toMatchObject({
      local_status: "cancelled",
      remote_event_seq: 9,
      error_code: "pane_gone",
    });
    expect(await store.getQuestion("q2")).toMatchObject({
      local_status: "open",
      remote_event_seq: 5,
    });

    // A reopen is a later event, and applies.
    await store.updateQuestion("q1", { ...receipt(12), question_revision: 1 });
    expect(await store.getQuestion("q1")).toMatchObject({
      local_status: "open",
      remote_event_seq: 12,
      question_revision: 1,
    });
  });

  it("never writes back a create it has deleted, from a copy a flush still holds", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const create = { ...item("o1", "q1"), payload: { attachments: [], uploaded: [] } };
    await store.commitNewQuestion(row("q1", 1), create);
    await store.putOutbox({ ...item("o2", "q1"), kind: "cancel", payload: {} });
    await store.deleteOutbox("o2");
    await store.deleteOutbox("o1");

    await expect(
      store.putOutbox({ ...create, payload: { attachments: [], uploaded: ["a1"] } })
    ).rejects.toThrow(/no longer queued/);
    expect(await store.outboxFor("q1")).toEqual([]);
    // Only a create is held to that: other items, and new creates, are written as asked.
    await store.putOutbox({ ...item("o2", "q1"), kind: "cancel", payload: {} });
    await store.putOutbox(item("o3", "q1"));
    expect((await store.outboxFor("q1")).map((i) => i.id)).toEqual(["o2", "o3"]);
    expect(store.isFaulted()).toBe(false);
  });

  it("lists every attachment a pending create names, whatever its question's state, retry time or uploads", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const create = (id: string, qid: string, ids: string[], uploaded: string[] = []) => ({
      ...item(id, qid),
      payload: { attachments: ids.map((attachment_id) => ({ attachment_id })), uploaded },
    });
    await store.commitNewQuestion(row("q1", 1), create("o1", "q1", ["a1", "a2"], ["a1"]));
    await store.commitNewQuestion(
      row("q2", 2, { local_status: "cancelled" }),
      create("o2", "q2", ["a3"])
    );
    await store.recordOutboxFailure("o2", "network_error", Number.MAX_SAFE_INTEGER);
    await store.commitNewQuestion(row("q3", 3), create("o3", "q3", []));
    await store.putOutbox({
      ...item("o4", "q1"),
      kind: "cancel",
      payload: { attachments: [{ attachment_id: "not-a-create" }] },
    });

    expect(await store.referencedAttachmentIds()).toEqual(new Set(["a1", "a2", "a3"]));
    await store.deleteOutbox("o1");
    expect(await store.referencedAttachmentIds()).toEqual(new Set(["a3"]));
  });

  it.each([
    ["an attachment without its id", { attachments: [{ id: "no attachment_id" }] }],
    ["no attachments at all", { signed: { attachment_ids: ["a1"] }, uploaded: [] }],
    ["attachments that aren't a list", { attachments: { attachment_id: "a1" } }],
    ["a payload that isn't an object", 7],
    ["a null payload", null],
  ])(
    "refuses to list attachments for a create with %s, rather than reporting none",
    async (_case, payload) => {
      const store = new DaintreeLocalStore(sqlite);
      await store.commitNewQuestion(row("q1", 1), { ...item("o1", "q1"), payload });
      await expect(store.referencedAttachmentIds()).rejects.toThrow(/unreadable/);
    }
  );

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

describe("DaintreeLocalStore thread messages (Decisions 0.4.0)", () => {
  /** A database migrated only as far as `lastTag`, as an app from before the next migration left it. */
  function openAt(lastTag: string): Database.Database {
    const folder = path.join(dir, "migrations");
    fs.cpSync(migrationsFolder, folder, { recursive: true });
    const journalPath = path.join(folder, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    const last = journal.entries.findIndex((e) => e.tag === lastTag);
    expect(last).toBeGreaterThan(-1);
    for (const later of journal.entries.slice(last + 1)) {
      fs.rmSync(path.join(folder, `${later.tag}.sql`));
    }
    journal.entries = journal.entries.slice(0, last + 1);
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    const older = path.join(dir, "older.db");
    return openDb(older, folder).sqlite;
  }

  /** A row in `table` with every column given a placeholder, then `values` over it. */
  function insertRaw(db: Database.Database, table: string, values: Record<string, unknown>): void {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
      type: string;
    }[];
    const row = Object.fromEntries(
      columns.map((c) => [c.name, /int/i.test(c.type) ? 0 : "x"] as const)
    );
    Object.assign(row, values);
    const names = Object.keys(row);
    db.prepare(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map((n) => `@${n}`).join(", ")})`
    ).run(row);
  }

  it("keeps a question's messages and a follow-up's intent across a restart", async () => {
    const messages = JSON.stringify([{ message_id: "m1", side: "human" }]);
    const first = new DaintreeLocalStore(sqlite);
    await first.commitNewQuestion(row("q1", 1, { messages_json: messages }), item("o1", "q1"));
    await first.putIntent(intent("i1", "q1", { answer_revision: 0, message_id: "m1" }));
    await first.close();
    sqlite.close();

    sqlite = openDb(dbPath, migrationsFolder).sqlite;
    const second = new DaintreeLocalStore(sqlite);
    expect((await second.getQuestion("q1"))?.messages_json).toBe(messages);
    expect(await second.getIntent("i1")).toMatchObject({ answer_revision: 0, message_id: "m1" });
  });

  it("holds a question for an answer's uncertain typing, never for a follow-up's", async () => {
    const store = new DaintreeLocalStore(sqlite);
    await store.commitNewQuestion(row("q1", 1), item("o1", "q1"));
    await store.putIntent(
      intent("i1", "q1", { answer_revision: 0, message_id: "m1", state: "uncertain" })
    );
    expect(await store.hasUncertainIntent("q1")).toBe(false);

    await store.putIntent(intent("i2", "q1", { state: "uncertain" }));
    expect(await store.hasUncertainIntent("q1")).toBe(true);
  });

  it("migrates a store from before threads: no messages, and every intent an answer's", async () => {
    const older = openAt("0024_decisions_pending_delivery");
    insertRaw(older, "decisions_questions", {
      question_id: "q1",
      alias: 1,
      answers_json: "[]",
      attachment_digests: "[]",
      expires_at: null,
    });
    insertRaw(older, "decisions_injection_intents", {
      injection_id: "i1",
      question_id: "q1",
      answer_revision: 1,
      state: "uncertain",
    });
    const olderPath = older.name;
    older.close();

    const migrated = openDb(olderPath, migrationsFolder).sqlite;
    extra.push(migrated);
    const store = new DaintreeLocalStore(migrated);
    expect((await store.getQuestion("q1"))?.messages_json).toBe("[]");
    expect(await store.getIntent("i1")).toMatchObject({ answer_revision: 1, message_id: null });
    expect(await store.hasUncertainIntent("q1")).toBe(true);
  });
});

describe("DaintreeLocalStore relay deletions (#16233)", () => {
  const deletion = (seq: number, questionId: string | null) => ({
    seq,
    event_id: `e${seq}`,
    event_type: "decision.deleted",
    json: JSON.stringify({ seq, event_type: "decision.deleted", question_id: questionId }),
    received_at: 1,
    processed_at: null,
  });

  it("names a question once its deletion is applied and the commit holding it is on disk", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const heard: Array<{ id: string; processedOnDisk: unknown }> = [];
    // What another connection reads is only what has committed.
    store.onQuestionDeleted((id) =>
      heard.push({
        id,
        processedOnDisk: (
          reader()
            .prepare("SELECT processed_at FROM decisions_inbound_events WHERE seq = 1")
            .get() as { processed_at: number | null }
        ).processed_at,
      })
    );
    await store.commitNewQuestion(row("q1", 1, { local_status: "open" }), item("o1", "q1"));
    await store.insertEvent(deletion(1, "q1"));
    expect(await store.deletedQuestionIds()).toEqual(new Set());

    // The inbox applies it, then marks it processed: applied but not yet processed names nothing.
    await store.updateQuestion("q1", { local_status: "cancelled", remote_event_seq: 1 });
    expect(await store.deletedQuestionIds()).toEqual(new Set());
    await store.markEventProcessed(1, 5);
    expect(heard).toEqual([{ id: "q1", processedOnDisk: 5 }]);
    expect(await store.deletedQuestionIds()).toEqual(new Set(["q1"]));
    // Still known after a restart.
    expect(await new DaintreeLocalStore(sqlite).deletedQuestionIds()).toEqual(new Set(["q1"]));
  });

  it("names nothing for a deletion that wasn't applied, or another kind of event", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const heard: string[] = [];
    store.onQuestionDeleted((id) => heard.push(id));
    await store.commitNewQuestion(row("q1", 1, { local_status: "open" }), item("o1", "q1"));
    await store.commitNewQuestion(
      row("q2", 2, { local_status: "cancelled", history_only: true }),
      item("o2", "q2")
    );
    await store.commitNewQuestion(row("q3", 3, { local_status: "cancelled" }), item("o3", "q3"));
    await store.insertEvent(deletion(1, "q1"));
    await store.insertEvent(deletion(2, "q2"));
    await store.insertEvent(deletion(3, "q-unknown"));
    await store.insertEvent(deletion(4, null));
    // Withdrawn by a cancel, not deleted by the relay.
    await store.insertEvent({
      ...deletion(5, "q3"),
      event_type: "decision.cancelled",
      json: JSON.stringify({ seq: 5, event_type: "decision.cancelled", question_id: "q3" }),
    });
    for (const seq of [1, 2, 3, 4, 5]) await store.markEventProcessed(seq, 5);

    expect(heard).toEqual([]);
    expect(await store.deletedQuestionIds()).toEqual(new Set());
  });

  it("reads applied deletions through an index of them alone, however long the event history (#17791)", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const created = sqlite.prepare(
      `INSERT INTO decisions_inbound_events
         (seq, event_id, event_type, json, received_at, processed_at)
       VALUES (?, ?, 'decision.created', '{}', 1, 2)`
    );
    sqlite.transaction(() => {
      for (let seq = 1; seq <= 500; seq++) created.run(seq, `c${seq}`);
    })();
    const prepare = vi.spyOn(sqlite, "prepare");

    const empty = await store.deletedQuestionIds();
    const read = prepare.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes("'decision.deleted'"));
    prepare.mockRestore();
    expect(empty).toEqual(new Set());
    expect(read).toBeDefined();
    const usesIndex = /USING (COVERING )?INDEX decisions_inbound_events_deleted_idx\b/;
    const plan = () =>
      (sqlite.prepare(`EXPLAIN QUERY PLAN ${read}`).all() as { detail: string }[])
        .map((step) => step.detail)
        .join("\n");
    expect(plan()).toMatch(usesIndex);

    // A few deletions, one applied, one refused and one unreadable, still read
    // through it and still name only the question actually withdrawn.
    await store.commitNewQuestion(row("q1", 1, { local_status: "open" }), item("o1", "q1"));
    await store.commitNewQuestion(
      row("q2", 2, { local_status: "cancelled", history_only: true }),
      item("o2", "q2")
    );
    await store.insertEvent(deletion(501, "q1"));
    await store.insertEvent(deletion(502, "q2"));
    await store.insertEvent({ ...deletion(503, null), json: "not json" });
    await store.updateQuestion("q1", { local_status: "cancelled", remote_event_seq: 501 });
    for (const seq of [501, 502, 503]) await store.markEventProcessed(seq, 5);
    // Neither an unprocessed deletion nor another processed kind of event belongs in it.
    await store.insertEvent(deletion(504, "q-pending"));
    await store.insertEvent({
      ...deletion(505, "q1"),
      event_type: "decision.answered",
      json: JSON.stringify({ seq: 505, event_type: "decision.answered", question_id: "q1" }),
    });
    await store.markEventProcessed(505, 5);
    expect(await store.deletedQuestionIds()).toEqual(new Set(["q1"]));
    expect(plan()).toMatch(usesIndex);
    // The same once `PRAGMA optimize` has gathered statistics, which also
    // count the index's rows: the three processed deletions alone.
    sqlite.exec("ANALYZE");
    expect(plan()).toMatch(usesIndex);
    const stat = sqlite
      .prepare("SELECT stat FROM sqlite_stat1 WHERE idx = 'decisions_inbound_events_deleted_idx'")
      .get() as { stat: string } | undefined;
    expect(stat?.stat.split(" ")[0]).toBe("3");
  });
});

/**
 * Another connection holding the database's write lock, as the maintenance
 * worker's audit-ring write does (#16840). It holds it until `release()`,
 * then commits after `holdMs` more on its own thread, so the store's thread
 * can be waiting on the lock meanwhile.
 */
async function holdWriteLock(file: string, holdMs: number) {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require(workerData.module);
      const db = new Database(workerData.file);
      db.pragma("busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        "INSERT INTO decisions_meta (key, value) VALUES ('held', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run();
      parentPort.postMessage("locked");
      parentPort.once("message", () => {
        setTimeout(() => {
          db.exec("COMMIT");
          db.close();
          parentPort.postMessage("released");
        }, workerData.holdMs);
      });
    `,
    {
      eval: true,
      workerData: {
        module: createRequire(import.meta.url).resolve("better-sqlite3"),
        file,
        holdMs,
      },
    }
  );
  workers.push(worker);
  const messages: string[] = [];
  const next = () =>
    new Promise<string>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", (message: string) => {
        worker.off("error", reject);
        messages.push(message);
        resolve(message);
      });
    });
  expect(await next()).toBe("locked");
  const released = next();
  return {
    release: () => worker.postMessage("release"),
    released,
  };
}

const workers: Worker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

describe("DaintreeLocalStore under write-lock contention (#16840)", () => {
  it("waits out another connection's write lock in a batch that reads before it writes", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const faults: string[] = [];
    store.onFault((reason) => faults.push(reason));
    const lock = await holdWriteLock(dbPath, 300);
    releaseAsImmediateBegins(sqlite, lock.release);

    // nextAlias reads the last alias, then writes the next one. Begun deferred,
    // nothing releases the lock, and its write is refused at once.
    const alias = store.nextAlias();

    await expect(alias).resolves.toBe(1);
    expect(await lock.released).toBe("released");
    expect(faults).toEqual([]);
    expect(store.isFaulted()).toBe(false);
    expect(await store.getMeta("held")).toBe("1");
    expect(await store.getMeta("alias")).toBe("1");
  });

  it("stops writing once the lock outlasts the busy timeout, saying it failed to begin and how long it waited", async () => {
    const store = new DaintreeLocalStore(sqlite);
    const faults: string[] = [];
    store.onFault((reason) => faults.push(reason));
    sqlite.pragma("busy_timeout = 100");
    logWarn.mockClear();
    const lock = await holdWriteLock(dbPath, 0);

    await expect(store.nextAlias()).rejects.toMatchObject({ reason: "storage-busy" });
    lock.release();
    expect(await lock.released).toBe("released");

    expect(faults).toEqual(["storage-busy"]);
    const latched = logWarn.mock.calls.filter(([message]) =>
      String(message).includes("stopped taking writes")
    );
    expect(latched).toEqual([
      [
        expect.any(String),
        {
          reason: "storage-busy",
          code: "SQLITE_BUSY",
          step: "begin",
          writes: true,
          calls: 1,
          elapsedMs: expect.any(Number),
        },
      ],
    ]);
    // Waited out the timeout rather than refused at once.
    expect((latched[0]![1] as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(50);
    // The lock is gone, but this store still never writes again.
    await expect(store.setMeta("later", "1")).rejects.toMatchObject({ reason: "storage-busy" });
    expect(await store.getMeta("alias")).toBeNull();
  });

  it.each(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_TIMEOUT"])(
    "takes %s as the database being busy, and says which call failed",
    async (code) => {
      const store = new DaintreeLocalStore(sqlite);
      logWarn.mockClear();
      failNextRead(sqlite, "FROM decisions_meta WHERE key", sqliteError(code));

      await expect(store.getMeta("k")).rejects.toMatchObject({ reason: "storage-busy" });

      expect(store.faultReason()).toBe("storage-busy");
      expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("stopped taking writes"), {
        reason: "storage-busy",
        code,
        step: "call",
        writes: false,
        calls: 1,
        elapsedMs: expect.any(Number),
      });
    }
  );

  it("keeps a lock held on this connection's own tables a storage fault", async () => {
    const store = new DaintreeLocalStore(sqlite);
    failNextRead(sqlite, "FROM decisions_meta WHERE key", sqliteError("SQLITE_LOCKED"));

    await expect(store.getMeta("k")).rejects.toMatchObject({ reason: "storage-fault" });
    expect(store.faultReason()).toBe("storage-fault");
  });
});

/** What each "stopped taking writes" line carried, in order. */
function stopLines(): unknown[] {
  return logWarn.mock.calls
    .filter(([message]) => String(message).includes("stopped taking writes"))
    .map(([, fields]) => fields);
}

/**
 * Calls `release` as the store's next batch begins with `BEGIN IMMEDIATE`,
 * and never for one begun deferred, so the lock is still held when the batch
 * starts however late it is scheduled.
 */
function releaseAsImmediateBegins(db: Database.Database, release: () => void): void {
  const original = db.transaction.bind(db);
  vi.spyOn(db, "transaction").mockImplementation(((fn: (...args: unknown[]) => unknown) => {
    const transaction = original(fn);
    if (db.inTransaction) return transaction;
    return Object.assign((...args: unknown[]) => transaction(...args), {
      default: transaction.default,
      deferred: transaction.deferred,
      exclusive: transaction.exclusive,
      immediate: (...args: unknown[]) => {
        release();
        return transaction.immediate(...args);
      },
    });
  }) as typeof db.transaction);
}
