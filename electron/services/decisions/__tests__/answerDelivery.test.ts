import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
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
import { AnswerDelivery, DELIVERY_CHECK_INTERVAL_MS, type PaneSignal } from "../answerDelivery.js";

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
  submitted: Array<{ id: string; text: string; at: number }> = [];
  screens = new Map<string, string>();

  async getTerminalAsync(id: string, submissionToken?: string) {
    const info = this.terminals.get(id);
    if (info === undefined) return null;
    if (submissionToken === undefined) return { ...info };
    return {
      ...info,
      submission: { token: submissionToken, phase: "pty_written" as const, at: Date.now() },
    };
  }

  submit(id: string, text: string) {
    this.submitted.push({ id, text, at: Date.now() });
  }

  withdrawGuardedSubmission() {}

  async getSerializedStateAsync(id: string) {
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
let sqlite: Database.Database;
let stored: StoredIdentity;
let identity: Identity;

beforeEach(async () => {
  stored ??= await ownerIdentity();
  const keys = new MemoryKeyStore();
  await keys.save(stored);
  identity = await loadIdentity(keys);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-decisions-delivery-"));
  sqlite = openDb(path.join(dir, "app.db"), migrationsFolder).sqlite;
  // The store commits on setImmediate, which stays real.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
});

afterEach(() => {
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
}

function setup(options: { store?: DaintreeLocalStore; ptyReady?: boolean } = {}) {
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
    reports.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) });
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
        const scope = notify.openWakeScope();
        return {
          queueWake: (pane, projectId, wake) => scope.enqueueWake(pane, projectId, wake),
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
  const patch = (fields: Partial<NotifyTerminalInfo>) =>
    client.terminals.set(PANE, { ...client.terminals.get(PANE)!, ...fields });
  const signals_ = (signal: PaneSignal) => [...signals].forEach((onPane) => onPane(signal));
  /** The agent's turn: it starts working, as main's state events say. */
  const works = () => {
    patch({ agentState: "working", lastStateChange: Date.now() });
    for (const listener of stateListeners) {
      listener({ terminalId: PANE, state: "working", previousState: "waiting", timestamp: Date.now() });
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
function intent(id: string, questionId: string, over: Partial<InjectionIntent> = {}): InjectionIntent {
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
    expect(await h.store.openIntents()).toEqual([]);

    // Typed once, however long it waits afterwards.
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toHaveLength(1);
    await h.delivery.stop();
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
    await h.delivery.stop();
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
    [
      "gone",
      (h: ReturnType<typeof setup>) => h.client.terminals.delete(PANE),
      "pane_gone",
    ],
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
      await h.delivery.stop();
    }
  );

  it("types two answers for one pane that arrive five seconds apart, in order and spaced", async () => {
    const h = setup();
    h.delivery.start();
    await advance(500);

    await answered(h.store, Q1, 1, "first");
    h.delivery.request();
    await until(() => h.client.submitted.length === 1, 10_000);
    // The agent takes the first answer and works on it.
    h.works();
    await advance(5_000);
    await answered(h.store, Q2, 2, "second");
    h.delivery.request();
    await advance(1_000);
    expect(h.client.submitted).toHaveLength(1);

    h.settles();
    await until(() => h.client.submitted.length === 2, 15_000);

    expect(h.client.submitted.map((s) => typedChoices(s.text))).toEqual([["first"], ["second"]]);
    expect(h.client.submitted[1].at - h.client.submitted[0].at).toBeGreaterThanOrEqual(
      MIN_NOTIFY_INTERVAL_MS
    );
    await until(async () => (await h.question(Q2))?.delivery_status === "terminal-delivered");
    await h.delivery.stop();
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
    await h.delivery.stop();
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
    await h.delivery.stop();
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
    await h.delivery.stop();
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
    await h.delivery.stop();
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
    await h.delivery.stop();
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
    await h.delivery.stop();
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
    await h.delivery.stop();
  });

  it("settles an answer queued to type when stopped, so the next start types it", async () => {
    const h = setup();
    await answered(h.store, Q1, 1, "approve");
    h.delivery.start();
    await until(async () => (await h.store.openIntents()).length === 1, 5_000);
    expect(h.client.submitted).toEqual([]);

    await h.delivery.stop();
    expect(h.holds).toEqual({ taken: 1, released: 1 });
    expect(h.watching()).toBe(0);
    expect(await h.store.openIntents()).toEqual([]);
    expect((await h.question(Q1))?.delivery_status).toBe("desktop-received");
    await advance(DELIVERY_CHECK_INTERVAL_MS, 10_000);
    expect(h.client.submitted).toEqual([]);

    const next = setup({ store: h.store });
    next.delivery.start();
    await until(() => next.client.submitted.length === 1);
    await next.delivery.stop();
  });
});
