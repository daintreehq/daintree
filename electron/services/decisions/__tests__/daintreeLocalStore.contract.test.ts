import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type {
  LocalStore,
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
import { DaintreeLocalStore } from "../daintreeLocalStore.js";

/**
 * The client library's store contract, ported from
 * daintreehq/decisions packages/client/tests/store.test.ts at v0.1.0 (the
 * pinned release): its `LocalStore contract` and `atomic intent settlement`
 * blocks, run against Daintree's store over the app database. The package
 * doesn't export them, so a library upgrade re-ports them from its tag.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../persistence/migrations");

let dir: string;
const open: { store: LocalStore; sqlite: Database.Database }[] = [];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-decisions-contract-"));
});

afterEach(async () => {
  for (const { store, sqlite } of open.splice(0)) {
    await store.close();
    if (sqlite.open) sqlite.close();
  }
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function make(): LocalStore {
  const { sqlite } = openDb(path.join(dir, `s${n++}.db`), migrationsFolder);
  const store = new DaintreeLocalStore(sqlite);
  open.push({ store, sqlite });
  return store;
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
  attachment_digests: ["a".repeat(64)],
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

describe("LocalStore contract: daintree", () => {
  it("round-trips a question with its full origin map and JSON fields", async () => {
    const s = make();
    await s.commitNewQuestion(row("q1", 1), item("o1", "q1"));
    const got = (await s.getQuestion("q1"))!;
    expect(got.origin).toEqual(origin());
    expect(got.origin.ownership_principal).toBe("principal-1");
    expect(got.origin.agent_incarnation).toBe("inc-1");
    expect(got.attachment_digests).toEqual(["a".repeat(64)]);
    expect(got.history_only).toBe(false);
    await s.updateQuestion("q1", {
      local_status: "open",
      remote_event_seq: 7,
      origin: { ...origin(), pane_id: "pane-9", ownership_principal: "principal-9" },
    });
    const up = (await s.getQuestion("q1"))!;
    expect(up).toMatchObject({ local_status: "open", remote_event_seq: 7 });
    expect(up.origin.pane_id).toBe("pane-9");
    expect(up.origin.ownership_principal).toBe("principal-9");
    expect(up.origin.worktree_root).toBe("/work/proj-1");
  });

  it("commits question and outbox item atomically; duplicates fail without a stray outbox row", async () => {
    const s = make();
    await s.commitNewQuestion(row("q1", 1), item("o1", "q1"));
    await expect(s.commitNewQuestion(row("q1", 2), item("o2", "q1"))).rejects.toThrow();
    expect((await s.outboxFor("q1")).map((o) => o.id)).toEqual(["o1"]);
  });

  it("aliases are monotonic", async () => {
    const s = make();
    expect([await s.nextAlias(), await s.nextAlias(), await s.nextAlias()]).toEqual([1, 2, 3]);
  });

  it("outbox: due ordering, failure backoff, delete", async () => {
    const s = make();
    await s.commitNewQuestion(row("q1", 1), item("o1", "q1", 10));
    await s.commitNewQuestion(row("q2", 2), item("o2", "q2", 5));
    expect((await s.dueOutbox(100, 10)).map((o) => o.id)).toEqual(["o2", "o1"]);
    await s.recordOutboxFailure("o2", "network_error", 1000);
    const due = await s.dueOutbox(100, 10);
    expect(due.map((o) => o.id)).toEqual(["o1"]);
    const failed = (await s.outboxFor("q2"))[0]!;
    expect(failed).toMatchObject({ attempts: 1, last_error: "network_error", payload: { n: 1 } });
    await s.deleteOutbox("o1");
    expect(await s.outboxFor("q1")).toEqual([]);
  });

  it("events: duplicate insert is ignored; cursor only advances over contiguous seqs", async () => {
    const s = make();
    const ev = (seq: number) => ({
      seq,
      event_id: `e${seq}`,
      event_type: "decision.created",
      json: "{}",
      received_at: 1,
      processed_at: null,
    });
    expect(await s.insertEvent(ev(1))).toBe(true);
    expect(await s.insertEvent(ev(1))).toBe(false);
    await s.insertEvent(ev(3));
    expect(await s.advanceCursor()).toBe(1);
    await s.insertEvent(ev(2));
    expect(await s.advanceCursor()).toBe(3);
    await s.forceCursor(2); // never moves backwards
    expect(await s.getCursor()).toBe(3);
    await s.forceCursor(9);
    expect(await s.getCursor()).toBe(9);
    await s.markEventProcessed(1, 5);
    expect((await s.unprocessedEvents(10)).map((e) => e.seq)).toEqual([2, 3]);
  });

  it("intents, pane counts, audit", async () => {
    const s = make();
    await s.commitNewQuestion(row("q1", 1, { local_status: "open" }), item("o1", "q1"));
    await s.commitNewQuestion(
      row("q2", 2, { origin: origin({ pane_id: "p2" }) }),
      item("o2", "q2")
    );
    expect(await s.countOpenForPane("host-local", "pane-1")).toBe(1);
    const base = {
      injection_id: "i1",
      question_id: "q1",
      answer_revision: 1,
      host_id: "h",
      pane_id: "p",
      terminal_generation: 1,
      ownership_principal: "principal-1",
      agent_incarnation: "inc-1",
      created_at: 1,
      updated_at: 1,
    };
    await s.putIntent({ ...base, state: "intent" });
    await s.putIntent({ ...base, injection_id: "i2", state: "acked" });
    expect((await s.openIntents()).map((i) => i.injection_id)).toEqual(["i1"]);
    expect(await s.getIntent("i1")).toMatchObject({
      ownership_principal: "principal-1",
      agent_incarnation: "inc-1",
    });
    await s.updateIntent("i1", { state: "uncertain" });
    expect(await s.openIntents()).toEqual([]);
    await s.appendAudit({ at: "a", event: "x", question_id: "q1" });
    await s.appendAudit({ at: "b", event: "y" });
    expect((await s.listAudit(10)).map((a) => a.event)).toEqual(["x", "y"]);
  });
});

describe("atomic intent settlement: daintree", () => {
  const base = {
    injection_id: "i1",
    question_id: "q1",
    answer_revision: 1,
    host_id: "h",
    pane_id: "p",
    terminal_generation: 1,
    ownership_principal: "principal-1",
    agent_incarnation: "inc-1",
    created_at: 1,
    updated_at: 1,
  };

  it("settleIntent updates the intent and the question together; hasUncertainIntent reflects it", async () => {
    const s = make();
    await s.commitNewQuestion(row("q1", 1, { local_status: "open" }), item("o1", "q1"));
    await s.putIntent({ ...base, state: "intent" });
    expect(await s.hasUncertainIntent("q1")).toBe(false);
    await s.settleIntent("i1", { state: "uncertain", updated_at: 9 }, "q1", {
      delivery_status: "delivery-uncertain",
      error_code: "x",
    });
    expect(await s.hasUncertainIntent("q1")).toBe(true);
    expect((await s.getIntent("i1"))!.state).toBe("uncertain");
    expect(await s.getQuestion("q1")).toMatchObject({
      delivery_status: "delivery-uncertain",
      error_code: "x",
    });
    expect(await s.hasUncertainIntent("other")).toBe(false);
  });

  it("concurrent partial updates do not clobber each other", async () => {
    const s = make();
    await s.commitNewQuestion(row("q1", 1), item("o1", "q1"));
    await Promise.all([
      s.updateQuestion("q1", { local_status: "open" }),
      s.updateQuestion("q1", { delivery_status: "desktop-received" }),
      s.updateQuestion("q1", { error_code: "e" }),
    ]);
    expect(await s.getQuestion("q1")).toMatchObject({
      local_status: "open",
      delivery_status: "desktop-received",
      error_code: "e",
    });
  });
});
