import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  MemoryKeyStore,
  RelayClient,
  loadIdentity,
  markerFor,
  parseAnswers,
  sealAnswerContent,
  serializeAnswers,
  type AnswerEntry,
  type Identity,
  type InjectionIntent,
  type QuestionOrigin,
  type QuestionRow,
  type StoredIdentity,
} from "@daintreehq/decisions-client";
import {
  generateDeviceKeys,
  generateEpochKeyBytes,
  serializeDeviceKeys,
} from "@daintreehq/decisions-crypto";
import { bytesToBase64Url } from "@daintreehq/decisions-protocol";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
  net: { isOnline: () => true },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}));

import {
  TerminalNotifyService,
  type NotifyStateChange,
  type NotifyTerminalInfo,
  type TerminalNotifyPtyClient,
} from "../../mcp-server/terminalNotify.js";
import { MIN_NOTIFY_INTERVAL_MS } from "../../../../shared/types/terminalNotify.js";
import { openDb } from "../../persistence/db.js";
import { DaintreeLocalStore } from "../daintreeLocalStore.js";
import type { DecisionSinkPtyClient } from "../daintreeTerminalSink.js";
import {
  AnswerDelivery,
  DELIVERY_CHECK_INTERVAL_MS,
  DELIVERY_SETTLE_MS,
  RECOVERY_RETRIES,
  type PaneSignal,
} from "../answerDelivery.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../persistence/migrations");

const ORIGIN_URL = "https://decisions.example.workers.dev";
const HOST = "host-own-01";
const PANE = "pane-1";
const Q1 = "0190f0aa11112222333344445555aa01";
const Q2 = "0190f0aa11112222333344445555aa02";
const CRASHED = "0190f0aa11112222333344445555cc01";

const ORIGIN: QuestionOrigin = {
  host_id: HOST,
  pane_id: PANE,
  terminal_generation: 7,
  ownership_principal: "principal-1",
  agent_incarnation: "0",
  agent_kind: "claude",
  agent_session_id: "session-1",
  project_id: "project-1",
  worktree_id: "wt-1",
  worktree_root: "/repo/wt-1",
  workflow_gate_id: null,
};

class FakePtyClient implements TerminalNotifyPtyClient, DecisionSinkPtyClient {
  terminals = new Map<string, NotifyTerminalInfo>();
  generations = new Map<string, number>();
  submitted: Array<{ id: string; text: string; token?: string; at: number }> = [];
  screens = new Map<string, string>();
  /** A submitted line's phase until a test moves it; written unless held. */
  holdWrites = false;
  readonly phases = new Map<string, "queued" | "pty_written">();
  /** Strict reads that fail before one answers, as a host that is slow to start. */
  failStrictReads = 0;
  /** Screen reads that come back empty, as the client answers one that timed out. */
  failScreenReads = 0;
  /** Screen reads answered before every later one comes back empty. */
  screenReadsLeft = Number.MAX_SAFE_INTEGER;
  screenReads = 0;

  async getTerminalAsync(id: string, submissionToken?: string, options?: { strict?: boolean }) {
    if (options?.strict === true && this.failStrictReads > 0) {
      this.failStrictReads -= 1;
      throw new Error("timed out");
    }
    const info = this.terminals.get(id);
    if (info === undefined) return null;
    if (submissionToken === undefined) return { ...info };
    // Only a line this pane was really given has a record.
    const phase = this.phases.get(submissionToken);
    const given = this.submitted.some((s) => s.id === id && s.token === submissionToken);
    if (!given || phase === undefined) return { ...info };
    return { ...info, submission: { token: submissionToken, phase, at: Date.now() } };
  }

  submit(id: string, text: string, token?: string) {
    this.submitted.push({ id, text, token, at: Date.now() });
    if (token !== undefined) this.phases.set(token, this.holdWrites ? "queued" : "pty_written");
  }

  /** The host writes every held line. */
  writeHeld() {
    for (const [token, phase] of this.phases)
      if (phase === "queued") this.phases.set(token, "pty_written");
  }

  withdrawGuardedSubmission() {}

  async getSerializedStateAsync(id: string) {
    this.screenReads += 1;
    if (this.failScreenReads > 0) {
      this.failScreenReads -= 1;
      return null;
    }
    if (this.screenReadsLeft <= 0) return null;
    this.screenReadsLeft -= 1;
    const data = this.screens.get(id);
    return data === undefined ? null : { data };
  }

  getLiveGeneration(id: string) {
    return this.generations.get(id) ?? null;
  }

  isLiveGeneration(id: string, generation: number) {
    return this.generations.get(id) === generation;
  }

  on() {}
  off() {}
}

function atPrompt(settledAgoMs = 60_000): NotifyTerminalInfo {
  return {
    projectId: "project-1",
    agentState: "waiting",
    waitingReason: "prompt",
    lastStateChange: Date.now() - settledAgoMs,
    detectedAgentId: "claude",
    hasPty: true,
    launchGeneration: 7,
    agentIncarnation: 0,
    agentSessionId: "session-1",
    worktreeId: "wt-1",
  };
}

async function ownerIdentity(): Promise<StoredIdentity> {
  const keys = await generateDeviceKeys(true);
  return {
    v: 1,
    config: {
      relayOrigin: ORIGIN_URL,
      installationId: "inst_12345678",
      deviceId: "dev_12345678",
      label: "Test desktop",
    },
    keys: await serializeDeviceKeys(keys),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
    currentEpoch: 1,
  };
}

let dir: string;
let dbPath: string;
let sqlite: Database.Database;
/** Every delivery a test made, stopped after it whether or not it got that far. */
const live: AnswerDelivery[] = [];
let stored: StoredIdentity;
let identity: Identity;

beforeEach(async () => {
  stored ??= await ownerIdentity();
  const keys = new MemoryKeyStore();
  await keys.save(stored);
  identity = await loadIdentity(keys);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-decisions-delivery-"));
  dbPath = path.join(dir, "app.db");
  sqlite = openDb(dbPath, migrationsFolder).sqlite;
  // The store commits on setImmediate, which stays real.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
});

afterEach(async () => {
  const stops = live.splice(0).map((delivery) => delivery.stop());
  await advance(4_000, 500);
  await Promise.all(stops);
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (sqlite.open) sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Lets the store's real `setImmediate` commits and the fake clock move together. */
async function advance(ms: number, step = 100): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed));
  }
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Stops a delivery, moving the clock while a line it submitted settles. */
async function stopped(delivery: AnswerDelivery): Promise<void> {
  const stopping = delivery.stop();
  await advance(DELIVERY_SETTLE_MS + 500, 250);
  await stopping;
}

/** Moves the clock until `done` holds, failing after `maxMs`. */
async function until(done: () => boolean | Promise<boolean>, maxMs = 30_000): Promise<void> {
  for (let elapsed = 0; elapsed <= maxMs; elapsed += 100) {
    if (await done()) return;
    await advance(100);
  }
  throw new Error("the condition never held");
}

interface Report {
  path: string;
  body: Record<string, unknown>;
  /** What another connection to the database read as committed when the report was sent. */
  committed?: { delivery_status: string; intent: string | null };
}

/** Reads a question's delivery state and an intent's state from a second connection: only what was committed. */
function readCommitted(questionId: string, injectionId: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const q = db
      .prepare("SELECT delivery_status FROM decisions_questions WHERE question_id = ?")
      .get(questionId) as { delivery_status: string } | undefined;
    const i = db
      .prepare("SELECT state FROM decisions_injection_intents WHERE injection_id = ?")
      .get(injectionId) as { state: string } | undefined;
    return { delivery_status: q?.delivery_status ?? "missing", intent: i?.state ?? null };
  } finally {
    db.close();
  }
}

function setup(
  options: {
    store?: DaintreeLocalStore;
    ptyReady?: boolean;
    /** The first hold fails: thrown at once, or rejected later. */
    failFirstHold?: "sync" | "async";
  } = {}
) {
  const store = options.store ?? new DaintreeLocalStore(sqlite);
  const client = new FakePtyClient();
  client.terminals.set(PANE, atPrompt());
  client.generations.set(PANE, 7);
  const stateListeners = new Set<(payload: NotifyStateChange) => void>();
  const notify = new TerminalNotifyService({
    getPtyClient: () => client,
    onStateChanged: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onKilled: () => () => {},
    onTrashed: () => () => {},
    // The MCP server is off: the hold is what lets an answer through.
    isEnabled: () => false,
    publish: () => {},
  });
  const principals = new Map([[PANE, "principal-1"]]);
  const signals = new Set<(signal: PaneSignal) => void>();
  const reports: Report[] = [];
  const relay = { up: true };
  const holds = { taken: 0, released: 0 };
  const pty = { ready: options.ptyReady ?? true };
  const keysUnusable = vi.fn();
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (!relay.up) throw new TypeError("fetch failed");
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const report: Report = { path: url.pathname, body };
    if (url.pathname.endsWith("/deliveries/terminal")) {
      report.committed = readCommitted(String(body.question_id), String(body.injection_id));
    }
    reports.push(report);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const keys = new MemoryKeyStore();
  void keys.save(stored);
  const delivery = new AnswerDelivery({
    deps: {
      hostId: () => HOST,
      principalFor: (paneId) => principals.get(paneId) ?? null,
      getPtyClient: () => (pty.ready ? client : null),
      holdWakes: () => {
        holds.taken += 1;
        if (holds.taken === 1 && options.failFirstHold === "sync") throw new Error("no hold");
        if (holds.taken === 1 && options.failFirstHold === "async") {
          return Promise.reject(new Error("no hold"));
        }
        const scope = notify.openWakeScope();
        return {
          queueWake: (pane, projectId, wake) => scope.enqueueWake(pane, projectId, wake),
          cancelQueued: () => scope.cancelQueued(),
          release: () => {
            holds.released += 1;
            scope.release();
          },
        };
      },
      watchPanes: (onPane) => {
        signals.add(onPane);
        return () => signals.delete(onPane);
      },
    },
    identity,
    store,
    keys,
    client: new RelayClient({ identity, fetch, maxRetries: 0 }),
    onKeysUnusable: keysUnusable,
  });
  live.push(delivery);
  const patch = (fields: Partial<NotifyTerminalInfo>) =>
    client.terminals.set(PANE, { ...client.terminals.get(PANE)!, ...fields });
  const signals_ = (signal: PaneSignal) => [...signals].forEach((onPane) => onPane(signal));
  /** The agent's turn: it starts working, as main's state events say. */
  const works = () => {
    patch({ agentState: "working", lastStateChange: Date.now() });
    for (const listener of stateListeners) {
      listener({
        terminalId: PANE,
        state: "working",
        previousState: "waiting",
        timestamp: Date.now(),
      });
    }
  };
  /** The agent's turn ends at its prompt. */
  const settles = () => {
    client.terminals.set(PANE, atPrompt(0));
    for (const listener of stateListeners) {
      listener({
        terminalId: PANE,
        state: "waiting",
        previousState: "working",
        waitingReason: "prompt",
        timestamp: Date.now(),
      });
    }
    signals_("settled");
  };
  return {
    store,
    client,
    delivery,
    principals,
    reports,
    relay,
    holds,
    pty,
    patch,
    works,
    settles,
    signal: signals_,
    watching: () => signals.size,
    question: (id: string) => store.getQuestion(id),
    terminalReports: () => reports.filter((r) => r.path.endsWith("/deliveries/terminal")),
    failedReports: () => reports.filter((r) => r.path.endsWith("/deliveries/failed")),
  };
}

/** A question from the asking run, answered with `choice` and stored as received. */
async function answered(
  store: DaintreeLocalStore,
  id: string,
  alias: number,
  choice: string,
  over: Partial<QuestionRow> = {}
): Promise<void> {
  const entry: AnswerEntry = {
    entry_id: `${id}-a1`,
    kind: "answer",
    action: "answer",
    revision: 1,
    source: "human",
    correction: false,
    created_at: "2026-11-01T09:00:00.000Z",
    deliver: true,
    delivered: false,
    sealed: await sealAnswerContent({ identity }, id, `${id}-a1`, 1, {
      choices: [{ id: choice, label: choice }],
      text: `Go with ${choice}.`,
      reviewed_attachment_digests: [],
    }),
  };
  const row: QuestionRow = {
    question_id: id,
    alias,
    origin: ORIGIN,
    requirement: "human-required",
    question_revision: 1,
    remote_event_seq: null,
    origin_created_at: "2026-11-01T08:00:00.000Z",
    expires_at: null,
    local_status: "human-answered",
    delivery_status: "desktop-received",
    last_injection_id: null,
    last_attempt_at: null,
    agent_resume_strategy: null,
    error_code: null,
    content_sealed: '{"sealed":1}',
    answers_json: serializeAnswers([entry]),
    history_only: false,
    delivered_revision: 0,
    attachment_digests: [],
    ...over,
  };
  await store.commitNewQuestion(row, {
    id: `${id}-outbox`,
    kind: "create",
    question_id: id,
    payload: {},
    attempts: 0,
    next_attempt_at: 0,
    created_at: 0,
    last_error: null,
  });
  await store.deleteOutbox(`${id}-outbox`);
}

/** An injection the library recorded before typing, as a crash would leave it. */
function intent(
  id: string,
  questionId: string,
  over: Partial<InjectionIntent> = {}
): InjectionIntent {
  return {
    injection_id: id,
    question_id: questionId,
    answer_revision: 1,
    host_id: HOST,
    pane_id: PANE,
    terminal_generation: 7,
    ownership_principal: "principal-1",
    agent_incarnation: "0",
    state: "intent",
    created_at: Date.now(),
    updated_at: Date.now(),
    ...over,
  };
}

function typedChoices(text: string): string[] {
  return [...text.matchAll(/^choice: (.+)$/gm)].map((match) => match[1]);
}

describe("AnswerDelivery", () => {
  it("types an answer that arrived while Decisions wasn't running into the run that asked, then reports it", async () => {
    // Stored by an earlier lifetime; this one opens its own store over the same database.
    const earlier = new DaintreeLocalStore(sqlite);
    await answered(earlier, Q1, 1, "approve");
    await earlier.close();
    const h = setup();

    h.delivery.start();
    await until(() => h.client.submitted.length === 1);
    expect(h.client.submitted[0].id).toBe(PANE);
    expect(typedChoices(h.client.submitted[0].text)).toEqual(["approve"]);

    await until(async () => (await h.question(Q1))?.delivery_status === "terminal-delivered");
    const row = (await h.question(Q1))!;
    expect(parseAnswers(row.answers_json)[0]).toMatchObject({ delivered: true });
    await until(() => h.terminalReports().length === 1);
    expect(h.terminalReports()[0].body).toMatchObject({
      question_id: Q1,
      answer_revision: 1,
      injection_id: row.last_injection_id,
    });
    // Recorded here first: the relay hears of it only once that is committed.
    expect(h.terminalReports()[0].committed).toEqual({
      delivery_status: "terminal-delivered",
      intent: "typed",
    });
    expect(await h.store.openIntents()).toEqual([]);

    // Typed once, however long it waits afterwards.
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toHaveLength(1);
    await stopped(h.delivery);
  });

  it("waits while the pane is busy, and types the answer once it settles at its prompt", async () => {
    const h = setup();
    h.works();
    await answered(h.store, Q1, 1, "approve");

    h.delivery.start();
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toEqual([]);
    expect((await h.question(Q1))?.delivery_status).toBe("desktop-received");

    h.settles();
    await until(() => h.client.submitted.length === 1, 5_000);
    expect(typedChoices(h.client.submitted[0].text)).toEqual(["approve"]);
    await stopped(h.delivery);
  });

  it.each([
    [
      "relaunched under a new principal",
      (h: ReturnType<typeof setup>) => h.principals.set(PANE, "principal-2"),
      "relaunched",
    ],
    [
      "respawned at another generation",
      (h: ReturnType<typeof setup>) => h.client.generations.set(PANE, 8),
      "generation_mismatch",
    ],
    [
      "moved to another worktree",
      (h: ReturnType<typeof setup>) => h.patch({ worktreeId: "wt-2" }),
      "pane_gone",
    ],
    ["gone", (h: ReturnType<typeof setup>) => h.client.terminals.delete(PANE), "pane_gone"],
  ] as const)(
    "never types an answer whose run was %s anywhere, and leaves it needing attention",
    async (_label, change, code) => {
      const h = setup();
      await answered(h.store, Q1, 1, "approve");
      change(h);

      h.delivery.start();
      await until(async () => (await h.question(Q1))?.delivery_status === "needs-attention");
      expect((await h.question(Q1))?.error_code).toBe(code);
      expect(h.client.submitted).toEqual([]);
      await until(() => h.failedReports().length === 1);
      expect(h.failedReports()[0].body).toMatchObject({
        question_id: Q1,
        status: "needs-attention",
        error_code: code,
      });

      await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
      expect(h.client.submitted).toEqual([]);
      await stopped(h.delivery);
    }
  );

  it("types two answers for one pane that arrive five seconds apart, in order and spaced", async () => {
    const h = setup();
    h.delivery.start();
    await advance(500);

    await answered(h.store, Q1, 1, "first");
    h.delivery.request();
    await until(() => h.client.submitted.length === 1, 10_000);
    const firstAt = h.client.submitted[0].at;
    // The agent takes the first answer and works on it.
    h.works();
    await advance(500);
    await answered(h.store, Q2, 2, "second");
    h.delivery.request();
    await advance(500);
    expect(h.client.submitted).toHaveLength(1);

    // Back at its prompt well inside the pane's spacing: the second answer waits it out.
    h.settles();
    await advance(firstAt + MIN_NOTIFY_INTERVAL_MS - 200 - Date.now());
    expect(h.client.submitted).toHaveLength(1);
    await until(() => h.client.submitted.length === 2, 15_000);

    expect(h.client.submitted.map((s) => typedChoices(s.text))).toEqual([["first"], ["second"]]);
    expect(h.client.submitted[1].at - firstAt).toBeGreaterThanOrEqual(MIN_NOTIFY_INTERVAL_MS);
    await until(async () => (await h.question(Q2))?.delivery_status === "terminal-delivered");
    await stopped(h.delivery);
  });

  it("joins answers that waited on a busy pane into one paste, in question order", async () => {
    const h = setup();
    h.works();
    // Answered out of order: the later question first.
    await answered(h.store, Q2, 2, "second");
    await answered(h.store, Q1, 1, "first");
    h.delivery.start();
    await advance(5_000);

    h.settles();
    await until(() => h.client.submitted.length === 1, 5_000);
    await advance(10_000);

    expect(h.client.submitted).toHaveLength(1);
    expect(typedChoices(h.client.submitted[0].text)).toEqual(["first", "second"]);
    await stopped(h.delivery);
  });

  it("takes a crashed injection whose marker is on the run's screen as delivered, and never retypes it", async () => {
    const h = setup();
    await answered(h.store, Q1, 1, "approve");
    await h.store.putIntent(intent(CRASHED, Q1));
    h.client.screens.set(PANE, `${markerFor(CRASHED)}\r\n❯ \r\n`);

    h.delivery.start();
    await until(async () => (await h.question(Q1))?.delivery_status === "terminal-delivered");
    await until(() => h.terminalReports().length === 1);
    expect(h.terminalReports()[0].body).toMatchObject({ injection_id: CRASHED });

    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toEqual([]);
    await stopped(h.delivery);
  });

  it("calls a crashed injection with no marker on screen uncertain, and never types it again", async () => {
    const h = setup();
    await answered(h.store, Q1, 1, "approve");
    await h.store.putIntent(intent(CRASHED, Q1));
    h.client.screens.set(PANE, "❯ \r\n");

    h.delivery.start();
    await until(async () => (await h.question(Q1))?.delivery_status === "delivery-uncertain");
    expect((await h.question(Q1))?.error_code).toBe("crash_unreconciled");
    expect((await h.store.getIntent(CRASHED))?.state).toBe("uncertain");

    h.signal("settled");
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toEqual([]);
    await stopped(h.delivery);
  });

  it("keeps an answer recorded as typed delivered, though its pane closed before it was reported", async () => {
    const h = setup();
    // A crash after the typed record and before the answer was marked delivered.
    await answered(h.store, Q1, 1, "approve");
    await h.store.putIntent(intent(CRASHED, Q1, { state: "typed" }));
    h.client.terminals.delete(PANE);

    h.delivery.start();
    await until(() => h.terminalReports().length === 1);
    const row = (await h.question(Q1))!;
    expect(row.delivery_status).toBe("terminal-delivered");
    expect(parseAnswers(row.answers_json)[0]).toMatchObject({
      delivered: true,
      injection_id: CRASHED,
    });
    expect((await h.store.getIntent(CRASHED))?.state).toBe("acked");
    expect(h.client.submitted).toEqual([]);
    await stopped(h.delivery);
  });

  it("types while the relay is out of reach, and reports once it is back", async () => {
    const h = setup();
    h.relay.up = false;
    await answered(h.store, Q1, 1, "approve");

    h.delivery.start();
    await until(async () => (await h.question(Q1))?.delivery_status === "terminal-delivered");
    expect(h.client.submitted).toHaveLength(1);
    const injection = (await h.question(Q1))!.last_injection_id!;
    expect((await h.store.getIntent(injection))?.state).toBe("typed");

    h.relay.up = true;
    // The socket coming up, or the minute check, asks again.
    h.delivery.request();
    await until(async () => (await h.store.getIntent(injection))?.state === "acked");
    expect(h.terminalReports()).toHaveLength(1);
    expect(h.client.submitted).toHaveLength(1);
    await stopped(h.delivery);
  });

  it("reads only the pending index each minute while nothing waits", async () => {
    const h = setup();
    const lists = vi.spyOn(h.store, "listQuestions");
    const pending = vi.spyOn(h.store, "hasPendingDelivery");
    h.delivery.start();
    await advance(1_000);
    const before = pending.mock.calls.length;

    await advance(3 * DELIVERY_CHECK_INTERVAL_MS, 10_000);
    expect(pending.mock.calls.length - before).toBe(3);
    expect(lists).not.toHaveBeenCalled();

    // Found by the next minute's read, with nothing else asking.
    await answered(h.store, Q1, 1, "approve");
    await until(() => h.client.submitted.length === 1, DELIVERY_CHECK_INTERVAL_MS + 10_000);
    await stopped(h.delivery);
  });

  it("reconciles a crash only once the pty host can be asked", async () => {
    const h = setup({ ptyReady: false });
    await answered(h.store, Q1, 1, "approve");
    await h.store.putIntent(intent(CRASHED, Q1));
    h.client.screens.set(PANE, `${markerFor(CRASHED)}\r\n`);

    h.delivery.start();
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    // Unreadable is not "not found": nothing was called uncertain.
    expect((await h.store.getIntent(CRASHED))?.state).toBe("intent");
    expect((await h.question(Q1))?.delivery_status).toBe("desktop-received");

    h.pty.ready = true;
    h.signal("appeared");
    await until(async () => (await h.question(Q1))?.delivery_status === "terminal-delivered");
    expect(h.client.submitted).toEqual([]);
    await stopped(h.delivery);
  });

  it("settles an answer queued to type when stopped, so the next start types it", async () => {
    const h = setup();
    await answered(h.store, Q1, 1, "approve");
    h.delivery.start();
    await until(async () => (await h.store.openIntents()).length === 1, 5_000);
    expect(h.client.submitted).toEqual([]);

    await stopped(h.delivery);
    expect(h.holds).toEqual({ taken: 1, released: 1 });
    expect(h.watching()).toBe(0);
    expect(await h.store.openIntents()).toEqual([]);
    expect((await h.question(Q1))?.delivery_status).toBe("desktop-received");
    await advance(DELIVERY_CHECK_INTERVAL_MS, 10_000);
    expect(h.client.submitted).toEqual([]);

    const next = setup({ store: h.store });
    next.delivery.start();
    await until(() => next.client.submitted.length === 1);
    await stopped(next.delivery);
  });
  it("waits for an answer already submitted to be written before it stops, and records it delivered", async () => {
    const h = setup();
    h.client.holdWrites = true;
    await answered(h.store, Q1, 1, "approve");
    h.delivery.start();
    await until(() => h.client.submitted.length === 1, 5_000);

    let stopped = false;
    const stopping = h.delivery.stop().then(() => {
      stopped = true;
    });
    await advance(1_000);
    expect(stopped).toBe(false);

    h.client.writeHeld();
    await until(() => stopped, DELIVERY_SETTLE_MS);
    await stopping;
    const row = (await h.question(Q1))!;
    expect(row.delivery_status).toBe("terminal-delivered");
    expect((await h.store.getIntent(row.last_injection_id!))?.state).toMatch(/^(typed|acked)$/);
  });

  it("stops taking writes once a submitted answer outlasts the settle window, leaving it for recovery", async () => {
    const h = setup();
    h.client.holdWrites = true;
    await answered(h.store, Q1, 1, "approve");
    h.delivery.start();
    await until(() => h.client.submitted.length === 1, 5_000);

    let stopped = false;
    void h.delivery.stop().then(() => {
      stopped = true;
    });
    await advance(DELIVERY_SETTLE_MS - 200);
    expect(stopped).toBe(false);
    await advance(400);
    expect(stopped).toBe(true);

    // Neither delivered nor given up on: the next start looks for its marker.
    await advance(5_000);
    const intents = await h.store.openIntents();
    expect(intents.map((i) => i.state)).toEqual(["intent"]);
    expect((await h.question(Q1))?.delivery_status).toBe("desktop-received");
  });

  it.each(["sync", "async"] as const)(
    "asks for the wake hold again after a first hold that failed %s",
    async (failFirstHold) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = setup({ failFirstHold });
      await answered(h.store, Q1, 1, "approve");
      h.delivery.start();
      await advance(1_000);
      expect(h.holds.taken).toBe(1);
      expect(h.client.submitted).toEqual([]);

      h.signal("appeared");
      await until(() => h.client.submitted.length === 1, 5_000);
      expect(h.holds.taken).toBe(2);
    }
  );

  it("leaves a crashed injection unreconciled while the pty host doesn't answer, then finds its marker", async () => {
    const h = setup();
    await answered(h.store, Q1, 1, "approve");
    await h.store.putIntent(intent(CRASHED, Q1));
    h.client.screens.set(PANE, `${markerFor(CRASHED)}\r\n`);
    h.client.failStrictReads = 1;

    h.delivery.start();
    await advance(5_000);
    expect((await h.store.getIntent(CRASHED))?.state).toBe("intent");
    expect((await h.question(Q1))?.delivery_status).toBe("desktop-received");

    h.signal("appeared");
    await until(async () => (await h.question(Q1))?.delivery_status === "terminal-delivered");
    expect(h.client.submitted).toEqual([]);
  });

  it("reads a crashed injection's screen again after a read that failed, rather than calling it uncertain", async () => {
    const h = setup();
    await answered(h.store, Q1, 1, "approve");
    await h.store.putIntent(intent(CRASHED, Q1));
    h.client.screens.set(PANE, `${markerFor(CRASHED)}\r\n`);
    h.client.failScreenReads = 1;

    h.delivery.start();
    await advance(5_000);
    expect((await h.store.getIntent(CRASHED))?.state).toBe("intent");

    h.signal("appeared");
    await until(async () => (await h.question(Q1))?.delivery_status === "terminal-delivered");
    expect(h.client.submitted).toEqual([]);
  });

  it("acts on the screen recovery read, never on a second read that could fail", async () => {
    const h = setup();
    await answered(h.store, Q1, 1, "approve");
    await h.store.putIntent(intent(CRASHED, Q1));
    h.client.screens.set(PANE, `${markerFor(CRASHED)}\r\n`);
    h.client.screenReadsLeft = 1;

    h.delivery.start();
    await until(async () => (await h.question(Q1))?.delivery_status === "terminal-delivered");
    expect(h.client.screenReads).toBe(1);
    expect(h.client.submitted).toEqual([]);
  });

  it("calls crashed injections uncertain once their run's screen stays unreadable past the retries", async () => {
    const CRASHED_2 = "0190f0aa11112222333344445555cc02";
    const h = setup();
    await answered(h.store, Q1, 1, "approve");
    await answered(h.store, Q2, 2, "reject");
    await h.store.putIntent(intent(CRASHED, Q1));
    await h.store.putIntent(intent(CRASHED_2, Q2));
    h.client.screens.set(PANE, `${markerFor(CRASHED)}\r\n${markerFor(CRASHED_2)}\r\n`);
    h.client.failScreenReads = Number.MAX_SAFE_INTEGER;

    // One attempt counts once, however many of its injections it couldn't read.
    h.delivery.start();
    await advance(2_000);
    for (let i = 1; i < RECOVERY_RETRIES; i += 1) {
      h.signal("appeared");
      await advance(2_000);
    }
    expect((await h.store.getIntent(CRASHED))?.state).toBe("intent");
    expect((await h.store.getIntent(CRASHED_2))?.state).toBe("intent");

    h.signal("appeared");
    await until(async () => (await h.question(Q2))?.delivery_status === "delivery-uncertain");
    expect((await h.question(Q1))?.delivery_status).toBe("delivery-uncertain");
    expect(h.client.submitted).toEqual([]);
  });

  it("keeps an answer whose marker an earlier recovery found delivered, though its intent wasn't updated", async () => {
    const h = setup();
    await answered(h.store, Q1, 1, "approve");
    const row = (await h.question(Q1))!;
    const [entry] = parseAnswers(row.answers_json);
    await h.store.updateQuestion(Q1, {
      answers_json: serializeAnswers([{ ...entry, delivered: true, injection_id: CRASHED }]),
      delivery_status: "terminal-delivered",
      delivered_revision: 1,
      last_injection_id: CRASHED,
    });
    await h.store.putIntent(intent(CRASHED, Q1));
    // The marker is gone from the screen now.
    h.client.screens.set(PANE, "❯ \r\n");

    h.delivery.start();
    await until(async () => (await h.store.getIntent(CRASHED))?.state === "acked");
    expect((await h.question(Q1))?.delivery_status).toBe("terminal-delivered");
    expect(h.client.submitted).toEqual([]);
  });

  it("tries again after each settled pane's grace, however busy the other panes are", async () => {
    const h = setup();
    const pending = vi.spyOn(h.store, "hasPendingDelivery");
    h.delivery.start();
    await advance(1_000);
    const before = pending.mock.calls.length;

    // A settle every second, for ten seconds: the first is looked at on time.
    for (let i = 0; i < 10; i += 1) {
      h.signal("settled");
      await advance(1_000);
    }
    expect(pending.mock.calls.length - before).toBeGreaterThanOrEqual(5);
  });
});
