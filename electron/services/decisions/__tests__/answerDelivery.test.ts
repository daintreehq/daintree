import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  MemoryKeyStore,
  PolicyRegistry,
  RelayClient,
  loadIdentity,
  markerFor,
  parseAnswers,
  parseMessages,
  sealAnswerContent,
  sealQuestionContent,
  serializeAnswers,
  serializeMessages,
  type AnswerEntry,
  type DecisionsBridge,
  type MessageDelivery,
  type Identity,
  type InjectionIntent,
  type QuestionOrigin,
  type QuestionRow,
  type PhoneImageFile,
  type PhoneImageStore,
  type StoredIdentity,
  type StoredMessage,
} from "@daintreehq/decisions-client";
import {
  encryptAttachment,
  encryptEnvelope,
  generateDeviceKeys,
  generateEpochKeyBytes,
  serializeDeviceKeys,
} from "@daintreehq/decisions-crypto";
import {
  MESSAGE_RECORD_TYPE,
  bytesToBase64Url,
  type PhoneImageReference,
} from "@daintreehq/decisions-protocol";

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
import type { AgentPromptWaitResult } from "../../viewless/agentPromptWait.js";
import type { AgentSessionPaneRequest } from "../../viewless/viewlessAgentResume.js";
import { DaintreeLocalStore } from "../daintreeLocalStore.js";
import type { DecisionSinkPtyClient } from "../daintreeTerminalSink.js";
import {
  AnswerDelivery,
  DELIVERY_CHECK_INTERVAL_MS,
  DELIVERY_SETTLE_MS,
  RECOVERY_RETRIES,
  type DiagnosticTerminals,
  type PaneSignal,
} from "../answerDelivery.js";
import { SetupDiagnostics } from "../setupDiagnostic.js";
import {
  DECISION_BLOCK_START,
  DECISION_FOLLOWUP_START,
  DECISION_THREAD_PREFACE,
} from "../answerNotice.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../persistence/migrations");

const ORIGIN_URL = "https://decisions.example.workers.dev";
const HOST = "host-own-01";
const PANE = "pane-1";
const RESUMED = "terminal-resumed-1";
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

/**
 * Gives real work its turn: the store's `setImmediate` commits, and WebCrypto,
 * which opens an answer on the thread pool in real time however the fake
 * clock stands. A count of turns alone runs out first on a loaded machine.
 */
async function yieldReal(): Promise<void> {
  const until = performance.now() + 2;
  let turns = 0;
  while (turns < 4 || performance.now() < until) {
    await new Promise((resolve) => setImmediate(resolve));
    turns += 1;
  }
}

/** Lets real work and the fake clock move together. */
async function advance(ms: number, step = 100): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await yieldReal();
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed));
  }
  await yieldReal();
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
    /**
     * Resumes a gone run's session (#16019) into `RESUMED`, which reaches its
     * prompt unless `wait` says otherwise, or hands back the `existing` pane.
     */
    resume?: {
      wait?: (terminalId: string, signal: AbortSignal) => Promise<AgentPromptWaitResult>;
      directories?: readonly string[];
      existing?: string;
      /** Held until the test lets the launch finish. */
      launchGate?: Promise<void>;
    };
    diagnostics?: DiagnosticTerminals;
    /** Lists the pty host's panes, as main's labels do, so delivery can read their sessions. */
    listTerminals?: boolean;
    /** Runs while the panes are being listed, before the list comes back. */
    whileListing?: () => Promise<void>;
    /** Where phone images go (#16233). */
    phoneImages?: PhoneImageStore;
    /**
     * Advisory outcomes typed as their own notice (#17941), under the owner's
     * policy, with what the connection's current attempt has read of the
     * ledger: none between attempts.
     */
    advisory?: {
      ledger: { attempt: boolean; state: "unapplied" | "reading" | null };
      /** The trusted policy allows advice; true unless said. */
      allowed?: boolean;
    };
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
  /** Phone images' ciphertext the relay serves, by attachment id. */
  const attachments = new Map<string, Uint8Array<ArrayBuffer>>();
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (!relay.up) throw new TypeError("fetch failed");
    const url = new URL(typeof input === "string" ? input : input.toString());
    const attachment = /\/attachments\/([^/]+)\/content$/.exec(url.pathname);
    if (attachment !== null) {
      const bytes = attachments.get(attachment[1]!);
      reports.push({ path: url.pathname, body: {} });
      return bytes === undefined
        ? new Response(JSON.stringify({ code: "not_found" }), { status: 404 })
        : new Response(bytes, { status: 200 });
    }
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
  const launches: Array<Omit<AgentSessionPaneRequest, "signal">> = [];
  const launchSignals: Array<AbortSignal | undefined> = [];
  const waits: string[] = [];
  const directories = new Set(options.resume?.directories ?? ["/repo/wt-1"]);
  const resumeOptions = options.resume;
  const resume = resumeOptions && {
    resumeSession: async (request: AgentSessionPaneRequest) => {
      const { signal, ...rest } = request;
      launches.push(rest);
      launchSignals.push(signal);
      if (resumeOptions.launchGate) await resumeOptions.launchGate;
      if (resumeOptions.existing !== undefined) {
        return {
          status: "existing" as const,
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          terminalId: resumeOptions.existing,
        };
      }
      client.terminals.set(RESUMED, {
        ...atPrompt(),
        agentState: "working" as const,
        lastStateChange: Date.now(),
        detectedAgentId: request.agentId,
        launchGeneration: 1,
        agentSessionId: request.sessionId ?? undefined,
      });
      client.generations.set(RESUMED, 1);
      principals.set(RESUMED, "principal-resumed");
      return {
        status: "launched" as const,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        terminalId: RESUMED,
        cwd: request.cwd ?? "",
        savedInLayout: true,
      };
    },
    waitForPrompt: async (
      terminalId: string,
      waitOptions: { timeoutMs: number; signal: AbortSignal }
    ): Promise<AgentPromptWaitResult> => {
      waits.push(terminalId);
      if (resumeOptions.wait) return resumeOptions.wait(terminalId, waitOptions.signal);
      settle(terminalId);
      return { terminalId, outcome: "settled", state: "waiting", waitingReason: "prompt" };
    },
    isDirectory: async (path: string) => directories.has(path),
  };
  /** Panes a view's hybrid input holds a draft for (#16282). */
  const drafts = new Set<string>();
  const advisory = options.advisory;
  /** The connection's current attempt, as far as delivery reads its ledger. */
  const attempt = {
    ledgerUnsettled: async () => advisory?.ledger.state ?? null,
  } as unknown as DecisionsBridge;
  const delivery = new AnswerDelivery({
    deps: {
      hostId: () => HOST,
      principalFor: (paneId) => principals.get(paneId) ?? null,
      getPtyClient: () => (pty.ready ? client : null),
      hasComposerDraft: (paneId) => drafts.has(paneId),
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
      ...(resume ? { resume } : {}),
      ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
      ...(options.listTerminals
        ? {
            labels: {
              projectName: async () => null,
              listTerminals: async () => {
                const list = [...client.terminals].map(([id, info]) => ({ ...info, id }));
                await options.whileListing?.();
                return list;
              },
            },
          }
        : {}),
    },
    identity,
    store,
    keys,
    client: new RelayClient({ identity, fetch, maxRetries: 0 }),
    ...(options.phoneImages ? { phoneImages: options.phoneImages } : {}),
    ...(advisory
      ? {
          advisoryDeadlines: true,
          policy: new PolicyRegistry({ advisoryQuestions: advisory.allowed !== false }),
          ledger: () => (advisory.ledger.attempt ? attempt : null),
        }
      : {}),
    onKeysUnusable: keysUnusable,
  });
  live.push(delivery);
  const patch = (fields: Partial<NotifyTerminalInfo>) =>
    client.terminals.set(PANE, { ...client.terminals.get(PANE)!, ...fields });
  const signals_ = (signal: PaneSignal) => [...signals].forEach((onPane) => onPane(signal));
  /**
   * The agent in `paneId` reaches its prompt now, as main's state events say:
   * as `info`, or as its run was, at the prompt.
   */
  function settle(paneId: string, info?: NotifyTerminalInfo): void {
    const current = client.terminals.get(paneId);
    client.terminals.set(
      paneId,
      info ?? {
        ...current,
        agentState: "waiting",
        waitingReason: "prompt",
        lastStateChange: Date.now(),
      }
    );
    for (const listener of stateListeners) {
      listener({
        terminalId: paneId,
        state: "waiting",
        previousState: "working",
        waitingReason: "prompt",
        timestamp: Date.now(),
      });
    }
    signals_("settled");
  }
  /**
   * The agent's turn: it starts working, as main's state events say. `typed`:
   * someone has typed into its line since, which holds an answer.
   */
  const works = (options: { typed?: boolean } = {}) => {
    patch({
      agentState: "working",
      lastStateChange: Date.now() - (options.typed ? 5_000 : 0),
      ...(options.typed ? { lastTypedInputAt: Date.now() } : {}),
    });
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
  const settles = () => settle(PANE, atPrompt(0));
  return {
    store,
    client,
    delivery,
    launches,
    launchSignals,
    waits,
    settle,
    principals,
    reports,
    relay,
    attachments,
    holds,
    pty,
    patch,
    works,
    settles,
    drafts,
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
    messages_json: "[]",
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
    message_id: null,
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

const M1 = "0190f0aa11112222333344445555ee01";
const M2 = "0190f0aa11112222333344445555ee02";

/**
 * A follow-up the person sent on `questionId` after its answer (#16231),
 * stored sealed as the library's inbox stores one, and waiting for the pane.
 */
async function followedUp(
  store: DaintreeLocalStore,
  questionId: string,
  messageId: string,
  text: string,
  over: {
    event_seq?: number;
    delivery?: Partial<MessageDelivery>;
    images?: PhoneImageReference[];
  } = {}
): Promise<void> {
  const images = over.images ?? [];
  const envelope = await encryptEnvelope({
    epochKey: identity.epochs.get(1)!,
    installationId: identity.config.installationId,
    questionId,
    recordId: messageId,
    recordType: MESSAGE_RECORD_TYPE,
    revision: 0,
    senderDeviceId: "phone-1",
    purpose: "message-content",
    plaintext: { content_version: 1, side: "human", text, images },
  });
  const message: StoredMessage = {
    message_id: messageId,
    message_seq: 1,
    event_seq: over.event_seq ?? 10,
    side: "human",
    expects_reply: false,
    signer_device_id: "phone-1",
    attachment_ids: images.map((image) => image.attachment_id),
    created_at: "2026-11-01T09:30:00.000Z",
    committed_at: "2026-11-01T09:30:01.000Z",
    envelope_digest: `digest-${messageId}`,
    sealed: JSON.stringify(envelope),
    target_host_id: HOST,
    delivery: {
      status: "received",
      deliver: true,
      received_at: "2026-11-01T09:30:02.000Z",
      terminal_delivered_at: null,
      injection_id: null,
      error_code: null,
      reported: null,
      ...over.delivery,
    },
  };
  const row = (await store.getQuestion(questionId))!;
  await store.updateQuestion(questionId, {
    messages_json: serializeMessages(
      [...parseMessages(row.messages_json), message].sort((a, b) => a.event_seq - b.event_seq)
    ),
  });
}

/** A question whose answer was typed in already. */
async function answeredAndTyped(store: DaintreeLocalStore, id: string, alias: number) {
  await answered(store, id, alias, "approve");
  const [entry] = parseAnswers((await store.getQuestion(id))!.answers_json);
  await store.updateQuestion(id, {
    answers_json: serializeAnswers([{ ...entry, delivered: true, injection_id: `${id}-typed` }]),
    delivery_status: "terminal-delivered",
    delivered_revision: 1,
  });
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

  it("types the notice of a question that never reached the relay, and reports no answer for it (0.9.0, #17939)", async () => {
    const h = setup();
    await answered(h.store, Q1, 1, "approve");
    // As 0.9.0's publisher settles a create whose deadline passed before it was ever sent.
    await h.store.updateQuestion(Q1, {
      local_status: "publish-failed",
      question_revision: 0,
      error_code: "never_published",
      answers_json: serializeAnswers([
        {
          entry_id: `unpublished-${Q1}`,
          kind: "unpublished",
          action: "expire",
          revision: 0,
          source: "system",
          correction: false,
          created_at: "2026-11-01T09:00:00.000Z",
          deliver: true,
          delivered: false,
          sealed: null,
        },
      ]),
    });

    h.delivery.start();
    await until(() => h.client.submitted.length === 1);
    const typed = h.client.submitted[0].text;
    expect(typed).toContain("source: system\nstatus: never-published\nauthorised: no\nnote:");
    expect(typed).not.toMatch(/^(choice|source: human)/m);
    await until(async () =>
      parseAnswers((await h.question(Q1))!.answers_json).every((entry) => entry.delivered)
    );
    // Typed once, and never reported to the relay as an answer delivered.
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toHaveLength(1);
    expect(h.terminalReports()).toEqual([]);
    await stopped(h.delivery);
  });

  it("types a setup check's answer into its diagnostic terminal alone, never into an agent's pane", async () => {
    const diagnostics = new SetupDiagnostics();
    const terminal = diagnostics.open(HOST, () => {});
    terminal.expect(Q1);
    const h = setup({ diagnostics });
    await answered(h.store, Q1, 1, "received", { origin: terminal.origin });
    await answered(h.store, Q2, 2, "approve");

    h.delivery.start();
    await until(async () => (await h.question(Q1))?.delivery_status === "terminal-delivered");
    await until(() => h.client.submitted.length === 1);

    expect(terminal.answerTypedFor(Q1)?.text).toContain("choice: received");
    // The agent's pane got only its own answer.
    expect(typedChoices(h.client.submitted[0].text)).toEqual(["approve"]);
    await until(() => h.terminalReports().length === 2);
    expect(h.terminalReports().map((report) => report.body.question_id)).toContain(Q1);
    await stopped(h.delivery);
  });

  it("leaves a diagnostic terminal's answer untyped once the terminal has closed", async () => {
    const diagnostics = new SetupDiagnostics();
    const terminal = diagnostics.open(HOST, () => {});
    terminal.expect(Q1);
    diagnostics.close(terminal);
    const located = vi.spyOn(diagnostics.sink, "locate");
    const h = setup({ diagnostics });
    const read = vi.spyOn(h.client, "getTerminalAsync");
    await answered(h.store, Q1, 1, "received", { origin: terminal.origin });

    h.delivery.start();
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);

    // Asked of the diagnostic terminals, never of the pty host as an agent's pane.
    expect(located).toHaveBeenCalled();
    expect(read.mock.calls.some(([id]) => id === terminal.origin.pane_id)).toBe(false);
    expect(h.client.submitted).toEqual([]);
    expect((await h.question(Q1))?.delivery_status).not.toBe("terminal-delivered");
    expect(h.terminalReports()).toEqual([]);
    await stopped(h.delivery);
  });

  it("types an answer into a busy pane whose CLI queues it, without waiting for the turn (#16282)", async () => {
    const h = setup();
    h.works();
    await answered(h.store, Q1, 1, "approve");

    h.delivery.start();
    await until(() => h.client.submitted.length === 1);
    expect(h.client.terminals.get(PANE)?.agentState).toBe("working");
    expect(typedChoices(h.client.submitted[0].text)).toEqual(["approve"]);
    await stopped(h.delivery);
  });

  it("holds an answer behind a hybrid-input draft, and types it once the draft empties", async () => {
    const h = setup();
    h.works();
    h.drafts.add(PANE);
    await answered(h.store, Q1, 1, "approve");

    h.delivery.start();
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toEqual([]);

    h.drafts.delete(PANE);
    h.signal("composer");
    await until(() => h.client.submitted.length === 1);
    expect(h.client.terminals.get(PANE)?.agentState).toBe("working");
    await stopped(h.delivery);
  });

  it("waits while a line typed into the busy pane may still be there, and types once it settles", async () => {
    const h = setup();
    h.works({ typed: true });
    await answered(h.store, Q1, 1, "approve");

    h.delivery.start();
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toEqual([]);
    expect((await h.question(Q1))?.delivery_status).toBe("desktop-received");

    h.settles();
    await until(() => h.client.submitted.length === 1);
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
    await until(() => h.client.submitted.length === 1);
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
    await until(() => h.client.submitted.length === 2);

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
    await until(() => h.client.submitted.length === 1);
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
    const sessionless = vi.spyOn(h.store, "listSessionlessQuestions");
    const pending = vi.spyOn(h.store, "hasPendingDelivery");
    h.delivery.start();
    await advance(1_000);
    const before = pending.mock.calls.length;
    // Start looks once for sessions learned while delivery was off; the minutes after it never look.
    expect(sessionless).toHaveBeenCalledTimes(1);

    await advance(3 * DELIVERY_CHECK_INTERVAL_MS, 10_000);
    expect(pending.mock.calls.length - before).toBe(3);
    expect(sessionless).toHaveBeenCalledTimes(1);
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
    await until(() => h.client.submitted.length === 1);

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
    await until(() => h.client.submitted.length === 1);

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
      await until(() => h.client.submitted.length === 1);
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

  describe("resuming a gone run's session (#16019)", () => {
    it.each(["claude", "codex"])(
      "reopens a gone %s run's session, makes the resumed run the destination, then types the answer there",
      async (kind) => {
        const h = setup({ resume: {} });
        const origin = { ...ORIGIN, agent_kind: kind, agent_session_id: `${kind}-session-9` };
        await answered(h.store, Q1, 1, "approve", { origin });
        h.client.terminals.delete(PANE);

        h.delivery.start();
        await until(() => h.client.submitted.length === 1);

        expect(h.launches).toEqual([
          {
            projectId: "project-1",
            worktreeId: "wt-1",
            agentId: kind,
            sessionId: `${kind}-session-9`,
            cwd: "/repo/wt-1",
          },
        ]);
        expect(h.waits).toEqual([RESUMED]);
        expect(h.client.submitted[0].id).toBe(RESUMED);
        expect(typedChoices(h.client.submitted[0].text)).toEqual(["approve"]);
        await until(async () => (await h.question(Q1))?.delivery_status === "terminal-delivered");
        const row = (await h.question(Q1))!;
        expect(row.origin).toEqual({
          ...origin,
          pane_id: RESUMED,
          terminal_generation: 1,
          ownership_principal: "principal-resumed",
          agent_incarnation: "0",
        });
        expect(row.agent_resume_strategy).toBe(`adapter:${kind}`);
        expect(row.error_code).toBeNull();

        await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
        expect(h.client.submitted).toHaveLength(1);
        await stopped(h.delivery);
      }
    );

    it("records a session learned after the run asked, so its answer can still resume it once the pane is gone", async () => {
      const h = setup({ resume: {}, listTerminals: true });
      const origin = { ...ORIGIN, agent_kind: "codex", agent_session_id: null };
      await answered(h.store, Q1, 1, "approve", { origin });
      // Codex's conversation is learned only once its turn is under way, after it asked.
      h.client.terminals.set(PANE, {
        ...atPrompt(),
        detectedAgentId: "codex",
        agentSessionId: "codex-learned-1",
        agentState: "working",
        // Someone typed into its line since: the answer waits.
        lastStateChange: Date.now() - 5_000,
        lastTypedInputAt: Date.now(),
      });

      h.delivery.start();
      h.signal("settled");
      await until(
        async () => (await h.question(Q1))?.origin.agent_session_id === "codex-learned-1"
      );
      expect(h.client.submitted).toHaveLength(0);

      h.client.terminals.delete(PANE);
      h.signal("appeared");
      await until(() => h.client.submitted.length === 1);
      expect(h.launches[0]).toMatchObject({ agentId: "codex", sessionId: "codex-learned-1" });
      await stopped(h.delivery);
    });

    it.each([
      [
        "a later launch",
        (h: ReturnType<typeof setup>) => h.client.generations.set(PANE, 8),
        { launchGeneration: 8 },
      ],
      ["a new agent incarnation", () => {}, { agentIncarnation: 1 }],
      ["another agent", () => {}, { detectedAgentId: "claude" }],
      [
        "another principal",
        (h: ReturnType<typeof setup>) => h.principals.set(PANE, "principal-2"),
        {},
      ],
    ] as const)("never takes a session from %s in the same pane", async (_name, arrange, info) => {
      const h = setup({ resume: {}, listTerminals: true });
      const origin = { ...ORIGIN, agent_kind: "codex", agent_session_id: null };
      await answered(h.store, Q1, 1, "approve", { origin });
      h.client.terminals.set(PANE, {
        ...atPrompt(),
        detectedAgentId: "codex",
        agentSessionId: "codex-other-run",
        agentState: "working",
        lastStateChange: Date.now(),
        ...info,
      });
      arrange(h);

      h.delivery.start();
      h.signal("settled");
      await advance(5_000);
      expect((await h.question(Q1))?.origin.agent_session_id).toBeNull();
      await stopped(h.delivery);
    });

    it("learns the session while the question is still open, so it resumes after the pane closes before the answer", async () => {
      const h = setup({ resume: {}, listTerminals: true });
      const origin = { ...ORIGIN, agent_kind: "codex", agent_session_id: null };
      await answered(h.store, Q1, 1, "approve", {
        origin,
        local_status: "open",
        delivery_status: "not-sent",
        answers_json: serializeAnswers([]),
      });
      h.client.terminals.set(PANE, {
        ...atPrompt(),
        detectedAgentId: "codex",
        agentSessionId: "codex-learned-2",
      });

      h.delivery.start();
      h.signal("session");
      await until(
        async () => (await h.question(Q1))?.origin.agent_session_id === "codex-learned-2"
      );
      expect(h.client.submitted).toHaveLength(0);
      await stopped(h.delivery);
    });

    it("learns at start a session Daintree found while delivery was off", async () => {
      const h = setup({ resume: {}, listTerminals: true });
      const origin = { ...ORIGIN, agent_kind: "codex", agent_session_id: null };
      await answered(h.store, Q1, 1, "approve", {
        origin,
        local_status: "open",
        delivery_status: "not-sent",
        answers_json: serializeAnswers([]),
      });
      h.client.terminals.set(PANE, {
        ...atPrompt(),
        detectedAgentId: "codex",
        agentSessionId: "codex-learned-3",
      });

      // No pane signal at all: start alone has to look.
      h.delivery.start();
      await until(
        async () => (await h.question(Q1))?.origin.agent_session_id === "codex-learned-3"
      );
      await stopped(h.delivery);
    });

    it("learns the session of a question already delivered, which a correction can reopen", async () => {
      const h = setup({ resume: {}, listTerminals: true });
      const origin = { ...ORIGIN, agent_kind: "codex", agent_session_id: null };
      await answered(h.store, Q1, 1, "approve", {
        origin,
        delivery_status: "terminal-delivered",
        delivered_revision: 1,
      });
      h.client.terminals.set(PANE, {
        ...atPrompt(),
        detectedAgentId: "codex",
        agentSessionId: "codex-learned-4",
      });

      h.delivery.start();
      h.signal("session");
      await until(
        async () => (await h.question(Q1))?.origin.agent_session_id === "codex-learned-4"
      );
      await stopped(h.delivery);
    });

    it("reads only the question missing its session after a pane signal, never the linked history (#17783)", async () => {
      const h = setup({ resume: {}, listTerminals: true });
      await answered(h.store, Q2, 2, "approve", {
        delivery_status: "terminal-delivered",
        delivered_revision: 1,
      });
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
           WHERE question_id = ?`
        )
        .run(Q2);
      const origin = { ...ORIGIN, agent_kind: "codex", agent_session_id: "" };
      await answered(h.store, Q1, 1, "approve", {
        origin,
        delivery_status: "terminal-delivered",
        delivered_revision: 1,
      });
      let materialized = 0;
      const lookups: string[] = [];
      const prepare = sqlite.prepare.bind(sqlite);
      vi.spyOn(sqlite, "prepare").mockImplementation(((source: string) => {
        const statement = prepare(source);
        if (!/FROM decisions_questions/.test(source)) return statement;
        if (source.includes("agent_session_id IS NULL")) lookups.push(source);
        const all = statement.all.bind(statement);
        statement.all = ((...args: unknown[]) => {
          const rows = all(...args) as unknown[];
          materialized += rows.length;
          return rows;
        }) as typeof statement.all;
        return statement;
      }) as typeof sqlite.prepare);
      const lists = vi.spyOn(h.store, "listQuestions");

      h.delivery.start();
      await advance(1_000);
      materialized = 0;
      h.client.terminals.set(PANE, {
        ...atPrompt(),
        detectedAgentId: "codex",
        agentSessionId: "codex-learned-5",
      });
      h.signal("session");
      await until(
        async () => (await h.question(Q1))?.origin.agent_session_id === "codex-learned-5"
      );
      expect(materialized).toBe(1);
      expect(lists).not.toHaveBeenCalled();
      // The agents delivery resumes are the ones the index holds: a roster change needs a migration.
      expect(lookups).toHaveLength(1);
      const plan = (prepare(`EXPLAIN QUERY PLAN ${lookups[0]}`).all(HOST) as { detail: string }[])
        .map((step) => step.detail)
        .join("\n");
      expect(plan).toContain("USING INDEX decisions_questions_missing_session_idx");
      await stopped(h.delivery);
    });

    it("never writes a session onto a question reassigned while the panes were being read", async () => {
      let reassign: () => Promise<void> = async () => {};
      const h = setup({ resume: {}, listTerminals: true, whileListing: () => reassign() });
      const origin = { ...ORIGIN, agent_kind: "codex", agent_session_id: null };
      await answered(h.store, Q1, 1, "approve", { origin });
      h.client.terminals.set(PANE, {
        ...atPrompt(),
        detectedAgentId: "codex",
        agentSessionId: "codex-pane-1",
      });
      reassign = async () => {
        reassign = async () => {};
        await h.store.updateQuestion(Q1, { origin: { ...origin, pane_id: "pane-2" } });
      };

      h.delivery.start();
      h.signal("session");
      await advance(5_000);
      const row = await h.question(Q1);
      expect(row?.origin.pane_id).toBe("pane-2");
      expect(row?.origin.agent_session_id).toBeNull();
      await stopped(h.delivery);
    });

    it("resumes once for every question the gone run asked, and types them all there", async () => {
      const h = setup({ resume: {} });
      await answered(h.store, Q1, 1, "approve");
      await answered(h.store, Q2, 2, "reject");
      h.client.terminals.delete(PANE);

      h.delivery.start();
      await until(async () =>
        [await h.question(Q1), await h.question(Q2)].every(
          (row) => row?.delivery_status === "terminal-delivered"
        )
      );

      expect(h.launches).toHaveLength(1);
      expect(h.waits).toHaveLength(1);
      expect(h.client.submitted.every((line) => line.id === RESUMED)).toBe(true);
      expect(h.client.submitted.flatMap((line) => typedChoices(line.text))).toEqual([
        "approve",
        "reject",
      ]);
      await stopped(h.delivery);
    });

    it("takes a busy pane already holding the session as the destination, and types once it settles", async () => {
      const h = setup({ resume: { existing: "pane-live" } });
      h.client.terminals.set("pane-live", {
        ...atPrompt(),
        agentState: "working",
        // Typed into since its turn began, so the answer waits for the turn.
        lastStateChange: Date.now() - 5_000,
        lastTypedInputAt: Date.now(),
        launchGeneration: 3,
      });
      h.client.generations.set("pane-live", 3);
      h.principals.set("pane-live", "principal-live");
      await answered(h.store, Q1, 1, "approve");
      h.client.terminals.delete(PANE);

      h.delivery.start();
      await until(async () => (await h.question(Q1))?.origin.pane_id === "pane-live");
      await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
      expect(h.waits).toEqual([]);
      expect(h.client.submitted).toEqual([]);
      expect((await h.question(Q1))?.delivery_status).toBe("desktop-received");

      h.settle("pane-live");
      await until(() => h.client.submitted.length === 1);
      expect(h.client.submitted[0].id).toBe("pane-live");
      expect(h.launches).toHaveLength(1);
      await stopped(h.delivery);
    });

    it("asks for attention, never reopening it, when the resumed run goes before the answer is typed", async () => {
      const h = setup({ resume: {} });
      await answered(h.store, Q1, 1, "approve");
      h.client.terminals.delete(PANE);

      h.delivery.start();
      await until(async () => (await h.question(Q1))?.origin.pane_id === RESUMED);
      // Closed inside its settle grace, before anything was typed.
      h.client.terminals.delete(RESUMED);
      h.client.generations.delete(RESUMED);

      await until(async () => (await h.question(Q1))?.delivery_status === "needs-attention");
      expect((await h.question(Q1))?.error_code).toBe("resume_ended");
      await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
      expect(h.launches).toHaveLength(1);
      expect(h.client.submitted).toEqual([]);
      await stopped(h.delivery);
    });

    const gone = (h: ReturnType<typeof setup>) => h.client.terminals.delete(PANE);
    const relaunched = (h: ReturnType<typeof setup>) => h.principals.set(PANE, "principal-2");
    const timesOut = async (terminalId: string): Promise<AgentPromptWaitResult> => ({
      terminalId,
      outcome: "timeout",
      state: "working",
    });

    it.each([
      [
        "it never reaches its prompt in time",
        { wait: timesOut },
        {},
        gone,
        "resume_timeout",
        "pane_gone",
        1,
      ],
      [
        "the question named no session",
        {},
        { agent_session_id: null },
        gone,
        "resume_no_session",
        "pane_gone",
        0,
      ],
      [
        "its worktree was deleted",
        { directories: [] },
        {},
        gone,
        "resume_worktree_gone",
        "pane_gone",
        0,
      ],
      [
        "its agent's resume isn't proven",
        {},
        { agent_kind: "gemini" },
        gone,
        "resume_unsupported_agent",
        "pane_gone",
        0,
      ],
      [
        "its pane was relaunched and no session was named",
        {},
        { agent_session_id: null },
        relaunched,
        "resume_no_session",
        "relaunched",
        0,
      ],
    ] as const)(
      "keeps the answer and asks for attention with the reason when %s",
      async (_label, resume, origin, change, reason, generic, launched) => {
        const h = setup({ resume });
        await answered(h.store, Q1, 1, "approve", { origin: { ...ORIGIN, ...origin } });
        const before = (await h.question(Q1))!.answers_json;
        change(h);

        h.delivery.start();
        await until(async () => (await h.question(Q1))?.delivery_status === "needs-attention");
        const row = (await h.question(Q1))!;
        expect(row.error_code).toBe(reason);
        expect(row.answers_json).toBe(before);
        expect(h.launches).toHaveLength(launched);
        expect(h.client.submitted).toEqual([]);
        // The phone hears the library's own code; the reason is kept here.
        await until(() => h.failedReports().length === 1);
        expect(h.failedReports()[0].body).toMatchObject({
          question_id: Q1,
          status: "needs-attention",
          error_code: generic,
        });

        // A person decides from here: nothing launches or types on its own.
        await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
        expect(h.launches).toHaveLength(launched);
        expect(h.client.submitted).toEqual([]);
        await stopped(h.delivery);
      }
    );

    it("resumes afresh for a question from the same run in a later pass", async () => {
      const h = setup({ resume: { wait: timesOut } });
      await answered(h.store, Q1, 1, "approve");
      h.client.terminals.delete(PANE);

      h.delivery.start();
      await until(async () => (await h.question(Q1))?.delivery_status === "needs-attention");
      expect(h.launches).toHaveLength(1);

      await answered(h.store, Q2, 2, "reject");
      h.signal("appeared");
      await until(async () => (await h.question(Q2))?.delivery_status === "needs-attention");
      expect((await h.question(Q2))?.error_code).toBe("resume_timeout");
      expect(h.launches).toHaveLength(2);
      await stopped(h.delivery);
    });

    it("ends a resume still waiting when delivery stops, recording nothing for it", async () => {
      let waitSignal: AbortSignal | undefined;
      const h = setup({
        resume: {
          wait: (terminalId, signal) => {
            waitSignal = signal;
            return new Promise((resolve) =>
              signal.addEventListener("abort", () => resolve({ terminalId, outcome: "aborted" }))
            );
          },
        },
      });
      await answered(h.store, Q1, 1, "approve");
      h.client.terminals.delete(PANE);

      h.delivery.start();
      await until(() => h.waits.length === 1);
      let done = false;
      void h.delivery.stop().then(() => {
        done = true;
      });
      expect(waitSignal?.aborted).toBe(true);
      // Ended by the abort, well inside the settle window a stuck attempt would get.
      await advance(500);
      expect(done).toBe(true);

      const row = (await h.question(Q1))!;
      expect(row.delivery_status).toBe("desktop-received");
      expect(row.error_code).toBeNull();
      expect(row.origin).toEqual(ORIGIN);
      expect(h.failedReports()).toEqual([]);
      expect(h.client.submitted).toEqual([]);
    });

    it("never waits on, or records, a launch that finishes after delivery stopped", async () => {
      let open!: () => void;
      const launchGate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const h = setup({ resume: { launchGate } });
      await answered(h.store, Q1, 1, "approve");
      h.client.terminals.delete(PANE);

      h.delivery.start();
      await until(() => h.launches.length === 1);
      await stopped(h.delivery);
      expect(h.launchSignals[0]?.aborted).toBe(true);
      open();
      await advance(DELIVERY_CHECK_INTERVAL_MS, 5_000);

      expect(h.waits).toEqual([]);
      const row = (await h.question(Q1))!;
      expect(row.delivery_status).toBe("desktop-received");
      expect(row.origin).toEqual(ORIGIN);
      expect(h.failedReports()).toEqual([]);
      expect(h.client.submitted).toEqual([]);
    });
  });
});

/**
 * A question the person declined from their phone (#17234), stored as the
 * library's inbox stores one: cancelled at the revision it was open at, its
 * content-free decline the one entry marked for delivery.
 */
async function declined(
  store: DaintreeLocalStore,
  id: string,
  alias: number,
  over: Partial<QuestionRow> = {}
): Promise<void> {
  const entry: AnswerEntry = {
    entry_id: `${id}-d1`,
    kind: "declined",
    action: "cancel",
    revision: 0,
    source: "human",
    correction: false,
    created_at: "2026-11-01T09:00:00.000Z",
    event_seq: 7,
    deliver: true,
    delivered: false,
    sealed: null,
  };
  await answered(store, id, alias, "approve", {
    question_revision: 0,
    local_status: "cancelled",
    answers_json: serializeAnswers([entry]),
    ...over,
  });
}

/** Follows a promise without awaiting it, so the fake clock can move while it settles. */
function settledValue<T>(promise: Promise<T>): { done: boolean; value?: T } {
  const seen: { done: boolean; value?: T } = { done: false };
  void promise.then((value) => {
    seen.value = value;
    seen.done = true;
  });
  return seen;
}

/** The deadline an advisory question's round 0 closed at. */
const DEADLINE = "2026-11-01T09:45:00.000Z";

/**
 * An advisory question whose round 0 expired unanswered, its notice received
 * and not yet typed (#17941), as the 0.9.0 inbox records it.
 */
async function advisoryExpired(
  store: DaintreeLocalStore,
  id: string,
  alias: number,
  over: Partial<QuestionRow> = {},
  disposition: "fallback-due" | "fallback-withheld" = "fallback-due"
): Promise<void> {
  const entry: AnswerEntry = {
    entry_id: `expired-${id}`,
    kind: "expired",
    action: "expire",
    revision: 0,
    source: "system",
    advisory_disposition: disposition,
    correction: false,
    created_at: DEADLINE,
    event_seq: 9,
    deliver: true,
    delivered: false,
    sealed: null,
  };
  await answered(store, id, alias, "approve", {
    question_revision: 0,
    local_status: "expired",
    expires_at: DEADLINE,
    content_sealed: JSON.stringify({ aad: { reply_mode: "advisory", revision: 0 } }),
    answers_json: serializeAnswers([entry]),
    ...over,
  });
}

describe("AnswerDelivery, an advisory question's unanswered deadline (#17941)", () => {
  const entryOf = async (h: ReturnType<typeof setup>, id = Q1) =>
    parseAnswers((await h.question(id))!.answers_json)[0]!;
  const settledAttempt = () => ({ ledger: { attempt: true, state: null } });

  /** The pane takes a draft the moment `questionId`'s first intent is written: its wake is queued, then held. */
  function draftOnIntent(h: ReturnType<typeof setup>, questionId: string): void {
    const putIntent = h.store.putIntent.bind(h.store);
    let first = true;
    h.store.putIntent = async (intent) => {
      await putIntent(intent);
      if (first && intent.question_id === questionId) {
        first = false;
        h.drafts.add(PANE);
      }
    };
  }

  /** The closure write delivery's engine has admitted for `questionId`, read without asking as the inbox does. */
  const admittedWrite = (h: ReturnType<typeof setup>, questionId: string) =>
    (
      h.delivery as unknown as { engine: { closureWrite(id: string): Promise<void> | null } }
    ).engine.closureWrite(questionId);

  /** As the 0.9.0 inbox applies a reopen of `questionId`, inside the lock its delivery shares. */
  async function reopen(h: ReturnType<typeof setup>, questionId: string): Promise<void> {
    await h.delivery.lock.run(async () => {
      expect(h.delivery.closureWrite(questionId)).toBeNull();
      await h.store.updateQuestion(questionId, {
        question_revision: 1,
        local_status: "open",
        expires_at: "2026-11-01T12:00:00.000Z",
      });
    });
  }

  it("types the notice into the run that asked, in Daintree's words, once, and reports no answer", async () => {
    const h = setup({ advisory: settledAttempt() });
    await advisoryExpired(h.store, Q1, 1);

    h.delivery.start();
    await until(() => h.client.submitted.length === 1, 10_000);
    const [typed] = h.client.submitted;
    expect(typed.id).toBe(PANE);
    expect(typed.text).toContain(
      `source: system\nstatus: advisory-unanswered\ndeadline: ${DEADLINE}\ndisposition: fallback-due\nauthorised: no\nnote: `
    );
    expect(typed.text).toMatch(/may now carry out the plan you stated/);
    await until(async () => (await entryOf(h)).delivered);
    expect(typed.text).toContain(markerFor((await entryOf(h)).injection_id!));
    expect(h.terminalReports()).toEqual([]);

    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toHaveLength(1);
    await stopped(h.delivery);
  });

  it("types the plan withheld under a policy that doesn't allow advice", async () => {
    const h = setup({ advisory: { ...settledAttempt(), allowed: false } });
    await advisoryExpired(h.store, Q1, 1);

    h.delivery.start();
    await until(() => h.client.submitted.length === 1, 10_000);
    const [typed] = h.client.submitted;
    expect(typed.text).toContain("disposition: fallback-withheld\nauthorised: no\n");
    expect(typed.text).toMatch(/not authorised to carry it out/);
    expect(typed.text).not.toMatch(/may now carry out/);
    expect((await entryOf(h)).advisory_disposition).toBe("fallback-withheld");
    await stopped(h.delivery);
  });

  it("types the ordinary expiry from a delivery that doesn't deliver advisory outcomes", async () => {
    const h = setup();
    await advisoryExpired(h.store, Q1, 1);

    h.delivery.start();
    await until(() => h.client.submitted.length === 1, 3 * DELIVERY_CHECK_INTERVAL_MS);
    expect(h.client.submitted[0].text).toContain("status: expired\nauthorised: no\n");
    expect(h.client.submitted[0].text).not.toMatch(/carry out the plan/);
    await stopped(h.delivery);
  });

  it("waits while the attempt holds an unapplied event of its question, past the library's longest wait, then types", async () => {
    const advisory = { ledger: { attempt: true, state: "unapplied" as "unapplied" | null } };
    const h = setup({ advisory });
    await advisoryExpired(h.store, Q1, 1);

    h.delivery.start();
    await advance(3 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toEqual([]);

    advisory.ledger.state = null;
    h.delivery.request();
    await until(() => h.client.submitted.length === 1, 10_000);
    expect(h.client.submitted[0].text).toContain("status: advisory-unanswered");
    await stopped(h.delivery);
  });

  it("types between attempts only once the library's bounded wait for a read has passed", async () => {
    const h = setup({ advisory: { ledger: { attempt: false, state: null } } });
    await advisoryExpired(h.store, Q1, 1);

    h.delivery.start();
    await advance(60_000, 5_000);
    expect(h.client.submitted).toEqual([]);
    await until(() => h.client.submitted.length === 1, 3 * DELIVERY_CHECK_INTERVAL_MS);
    expect(h.client.submitted[0].text).toContain("status: advisory-unanswered");
    await stopped(h.delivery);
  });

  it("drops a notice a reopen waits for before its line is due, never typing it, and leaves the reopened round alone", async () => {
    const h = setup({ advisory: settledAttempt() });
    await advisoryExpired(h.store, Q1, 1);

    h.delivery.start();
    // Admitted, its line coalescing and not yet due.
    await until(() => admittedWrite(h, Q1) !== null, 1_500);
    const [admitted] = await h.store.openIntents();

    // The inbox's verified reopen asks first, and waits for the write.
    const writing = h.delivery.closureWrite(Q1);
    expect(writing).not.toBeNull();
    await until(
      async () => (await h.store.getIntent(admitted.injection_id))?.state === "abandoned"
    );
    await writing;
    await reopen(h, Q1);

    h.signal("settled");
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toEqual([]);
    expect(await entryOf(h)).toMatchObject({ deliver: true, delivered: false });
    expect((await h.question(Q1))?.local_status).toBe("open");
    await stopped(h.delivery);
  });

  it("types another question's answer from the same chunk once the reopen applies, with a new injection", async () => {
    const h = setup({ advisory: settledAttempt() });
    await advisoryExpired(h.store, Q1, 1);
    await answered(h.store, Q2, 2, "compact");

    h.delivery.start();
    await until(() => admittedWrite(h, Q1) !== null, 1_500);
    const first = (await h.store.openIntents()).map((i) => i.injection_id);
    expect(first).toHaveLength(2);
    const writing = h.delivery.closureWrite(Q1);
    expect(writing).not.toBeNull();
    await until(async () =>
      (await Promise.all(first.map((id) => h.store.getIntent(id)))).every(
        (i) => i?.state === "abandoned"
      )
    );
    await writing;
    expect(h.client.submitted).toEqual([]);

    // Only the reopen's own retry types what is left.
    await reopen(h, Q1);
    await until(() => h.client.submitted.length === 1, 10_000);
    const [typed] = h.client.submitted;
    expect(typedChoices(typed.text)).toEqual(["compact"]);
    expect(typed.text).not.toContain("advisory-unanswered");
    const row = (await h.question(Q2))!;
    expect(first).not.toContain(row.last_injection_id);
    await until(async () => (await h.question(Q2))?.delivery_status === "terminal-delivered");

    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toHaveLength(1);
    await stopped(h.delivery);
  });

  it("ends a notice held behind a draft once its bound passes, then admits it again, and types it once, when the composer empties", async () => {
    const h = setup({ advisory: settledAttempt() });
    await advisoryExpired(h.store, Q1, 1);
    draftOnIntent(h, Q1);

    h.delivery.start();
    await until(async () => (await h.store.openIntents()).length === 1);
    const [first] = await h.store.openIntents();
    await until(async () => (await h.store.getIntent(first.injection_id))?.state === "abandoned");
    expect(h.client.submitted).toEqual([]);
    expect(await entryOf(h)).toMatchObject({ deliver: true, delivered: false });

    h.drafts.clear();
    h.signal("composer");
    await until(() => h.client.submitted.length === 1, 10_000);
    expect(h.client.submitted[0].text).toContain("status: advisory-unanswered");
    await until(async () => (await entryOf(h)).delivered);
    expect((await entryOf(h)).injection_id).not.toBe(first.injection_id);

    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toHaveLength(1);
    await stopped(h.delivery);
  });

  it("calls a notice whose write the host never confirmed uncertain, keeps that attempt with it, and never types it again", async () => {
    const h = setup({ advisory: settledAttempt() });
    h.client.holdWrites = true;
    await advisoryExpired(h.store, Q1, 1);

    h.delivery.start();
    await until(() => h.client.submitted.length === 1, 10_000);
    await until(
      async () => (await h.question(Q1))?.delivery_status === "delivery-uncertain",
      60_000
    );
    const entry = await entryOf(h);
    expect(entry.delivered).toBe(false);
    expect(entry.uncertain_injection_id).toBe((await h.question(Q1))?.last_injection_id);
    expect(h.terminalReports()).toEqual([]);

    h.signal("settled");
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toHaveLength(1);
    await stopped(h.delivery);
  });

  it("types nothing into a pane whose launch generation changed before its line was due, and needs a person", async () => {
    const h = setup({ advisory: settledAttempt(), listTerminals: true });
    await advisoryExpired(h.store, Q1, 1);

    h.delivery.start();
    await until(() => admittedWrite(h, Q1) !== null, 1_500);
    h.client.generations.set(PANE, 8);
    h.patch({ launchGeneration: 8 });
    await until(async () => (await h.question(Q1))?.delivery_status === "needs-attention", 60_000);
    expect(h.client.submitted).toEqual([]);
    expect((await entryOf(h)).write_refused).toBe(true);

    const [item] = await h.delivery.attentionItems();
    expect(item).toMatchObject({ questionId: Q1, canReassign: false });
    await expect(h.delivery.answerDestinations(Q1)).resolves.toEqual({ result: "unavailable" });
    await expect(h.delivery.reassignAnswer(Q1, PANE)).resolves.toEqual({
      result: "refused",
      reason: "asker-only",
    });
    expect((await h.question(Q1))?.origin).toEqual(ORIGIN);
    await stopped(h.delivery);
  });

  it("offers Try resume for a notice its run's own session can take, and types it there once tried", async () => {
    // The first resume never sees the agent at its prompt; the one a person asks for does.
    const prompt = { reached: false };
    const h = setup({
      advisory: settledAttempt(),
      listTerminals: true,
      resume: {
        wait: async (terminalId) =>
          prompt.reached
            ? { terminalId, outcome: "settled", state: "waiting", waitingReason: "prompt" }
            : { terminalId, outcome: "timeout", state: "working" },
      },
    });
    const origin = { ...ORIGIN, agent_session_id: "claude-session-9" };
    await advisoryExpired(h.store, Q1, 1, { origin });
    h.client.terminals.delete(PANE);

    h.delivery.start();
    await until(async () => (await h.question(Q1))?.delivery_status === "needs-attention", 60_000);
    expect(h.client.submitted).toEqual([]);
    const [item] = await h.delivery.attentionItems();
    expect(item).toMatchObject({ questionId: Q1, canResume: true, canReassign: false });

    prompt.reached = true;
    const resumed = settledValue(h.delivery.resumeAnswer(Q1));
    await until(() => resumed.done);
    expect(h.client.submitted).toHaveLength(1);
    expect(h.client.submitted[0].id).toBe(RESUMED);
    expect(h.client.submitted[0].text).toContain("status: advisory-unanswered");
    expect(h.launches.every((launch) => launch.sessionId === "claude-session-9")).toBe(true);
    await stopped(h.delivery);
  });

  it("clears a refused write when a person asks for the notice to be tried again", async () => {
    const h = setup({ advisory: settledAttempt(), listTerminals: true });
    await advisoryExpired(h.store, Q1, 1);
    h.delivery.start();
    await until(() => admittedWrite(h, Q1) !== null, 1_500);
    h.client.generations.set(PANE, 8);
    h.patch({ launchGeneration: 8 });
    await until(async () => (await entryOf(h)).write_refused === true, 60_000);

    // The run is back as it was: the retry types the notice and the refusal no longer stands.
    h.client.generations.set(PANE, 7);
    h.patch({ launchGeneration: 7 });
    const retried = settledValue(h.delivery.resumeAnswer(Q1));
    await until(() => retried.done);
    expect(retried.value).toMatchObject({ result: "delivered" });
    expect(h.client.submitted).toHaveLength(1);
    expect((await entryOf(h)).write_refused).toBeUndefined();
    await stopped(h.delivery);
  });

  it("refuses to move a never-published notice whose plan is due to another pane", async () => {
    const h = setup({ advisory: settledAttempt(), listTerminals: true });
    await answered(h.store, Q1, 1, "approve", {
      local_status: "publish-failed",
      question_revision: 0,
      content_sealed: '{"sealed":1}',
      delivery_status: "needs-attention",
      error_code: "pane_gone",
      answers_json: serializeAnswers([
        {
          entry_id: `unpublished-${Q1}`,
          kind: "unpublished",
          action: "expire",
          revision: 0,
          source: "system",
          fallback_due: true,
          correction: false,
          created_at: "2026-11-01T09:00:00.000Z",
          deliver: true,
          delivered: false,
          sealed: null,
        },
      ]),
    });
    await expect(h.delivery.reassignAnswer(Q1, PANE)).resolves.toEqual({
      result: "refused",
      reason: "asker-only",
    });
    await expect(h.delivery.answerDestinations(Q1)).resolves.toEqual({ result: "unavailable" });
    await stopped(h.delivery);
  });

  it.each([
    ["on the run's screen: delivered, never typed again", true, "terminal-delivered"],
    ["missing from the screen: uncertain, never typed again", false, "delivery-uncertain"],
  ])(
    "reconciles a notice a restart interrupted, by its marker %s",
    async (_label, onScreen, status) => {
      const h = setup({ advisory: settledAttempt() });
      await advisoryExpired(h.store, Q1, 1, { last_injection_id: CRASHED });
      await h.store.putIntent(intent(CRASHED, Q1, { answer_revision: 0 }));
      h.client.screens.set(PANE, onScreen ? `${markerFor(CRASHED)}\r\n❯ \r\n` : "❯ \r\n");

      h.delivery.start();
      await until(async () => (await h.question(Q1))?.delivery_status === status);
      const entry = await entryOf(h);
      if (onScreen) expect(entry).toMatchObject({ delivered: true, injection_id: CRASHED });
      else expect(entry).toMatchObject({ delivered: false, uncertain_injection_id: CRASHED });

      h.signal("settled");
      await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
      expect(h.client.submitted).toEqual([]);
      await stopped(h.delivery);
    }
  );

  it("types the notice into a resume of the asking agent's own session", async () => {
    const h = setup({ advisory: settledAttempt(), resume: {} });
    const origin = { ...ORIGIN, agent_session_id: "claude-session-9" };
    await advisoryExpired(h.store, Q1, 1, { origin });
    h.client.terminals.delete(PANE);

    h.delivery.start();
    await until(() => h.client.submitted.length === 1);
    expect(h.launches).toMatchObject([{ sessionId: "claude-session-9" }]);
    expect(h.client.submitted[0].id).toBe(RESUMED);
    expect(h.client.submitted[0].text).toContain("status: advisory-unanswered");
    await until(async () => (await entryOf(h)).delivered);
    expect((await h.question(Q1))?.origin).toMatchObject({
      pane_id: RESUMED,
      agent_session_id: "claude-session-9",
    });
    await stopped(h.delivery);
  });

  it("never resumes another session for it: a run with none known needs a person", async () => {
    const h = setup({ advisory: settledAttempt(), resume: {} });
    await advisoryExpired(h.store, Q1, 1, { origin: { ...ORIGIN, agent_session_id: null } });
    h.client.terminals.delete(PANE);

    h.delivery.start();
    await until(async () => (await h.question(Q1))?.delivery_status === "needs-attention");
    expect(h.client.submitted).toEqual([]);
    expect((await h.question(Q1))?.origin.pane_id).toBe(PANE);
    await stopped(h.delivery);
  });

  it.each([
    ["listening", false],
    ["gone", true],
  ])(
    "treats a person's decline in the advisory round as any other, its run %s",
    async (_l, gone) => {
      // Its session could be reopened: an answer would be typed there.
      const h = setup({ advisory: settledAttempt(), resume: {} });
      await declined(h.store, Q1, 1, {
        content_sealed: JSON.stringify({ aad: { reply_mode: "advisory", revision: 0 } }),
      });
      if (gone) h.client.terminals.delete(PANE);

      h.delivery.start();
      if (gone) {
        await until(async () => !(await entryOf(h)).deliver);
        expect(h.launches).toEqual([]);
        expect(h.client.submitted).toEqual([]);
        expect(await h.delivery.attentionItems()).toEqual([]);
      } else {
        await until(() => h.client.submitted.length === 1);
        expect(h.client.submitted[0].text).toContain("status: declined\nauthorised: no\n");
        expect(h.client.submitted[0].text).not.toContain("advisory-unanswered");
      }
      await stopped(h.delivery);
    }
  );
});

describe("AnswerDelivery, a timeout notice that couldn't reach its agent (#17944)", () => {
  const entryOf = async (h: ReturnType<typeof setup>, id = Q1) =>
    parseAnswers((await h.question(id))!.answers_json)[0]!;
  const settledAttempt = () => ({ ledger: { attempt: true, state: null } });
  /** The notice's trail as the store recorded it, oldest first. */
  const trail = async (h: ReturnType<typeof setup>) =>
    (await h.store.listAudit(500))
      .filter((e) => e.event === "notice.trail")
      .reverse()
      .map((e) => ({ step: e.result, ...e.detail }));
  const admittedWrite = (h: ReturnType<typeof setup>, questionId: string) =>
    (
      h.delivery as unknown as { engine: { closureWrite(id: string): Promise<void> | null } }
    ).engine.closureWrite(questionId);

  /** The run's launch generation moves on once its write is admitted: the sink refuses it, and a person decides. */
  async function refusedWrite(h: ReturnType<typeof setup>): Promise<void> {
    h.delivery.start();
    await until(() => admittedWrite(h, Q1) !== null, 1_500);
    h.client.generations.set(PANE, 8);
    h.patch({ launchGeneration: 8 });
    await until(async () => (await h.question(Q1))?.delivery_status === "needs-attention", 60_000);
  }

  it("lists the notice in the answer's place with its round, deadline and plan, and nothing to copy or move", async () => {
    const h = setup({ advisory: settledAttempt(), listTerminals: true });
    await advisoryExpired(h.store, Q1, 1);
    await refusedWrite(h);

    const [item] = await h.delivery.attentionItems();
    expect(item).toMatchObject({
      questionId: Q1,
      status: "needs-attention",
      answer: null,
      answerUnavailable: null,
      notice: {
        kind: "expired",
        revision: 0,
        deadline: DEADLINE,
        delivery: "needs-attention",
        disposition: "fallback-due",
      },
      canReassign: false,
    });
    expect(item!.origin).toMatchObject({ paneId: PANE, otherHost: null });
    await expect(h.delivery.copiedAnswer(Q1)).resolves.toBeNull();
    expect(h.client.submitted).toEqual([]);
    // The sink refused the write it had admitted: nothing was typed, and a person decides.
    expect((await trail(h)).map((t) => t.step)).toEqual(["attempted", "untyped", "needs-attention"]);
    await stopped(h.delivery);
  });

  it("says a notice the lifetime's policy no longer allows would be typed withheld", async () => {
    const h = setup({ advisory: { ...settledAttempt(), allowed: false }, listTerminals: true });
    await advisoryExpired(h.store, Q1, 1, { delivery_status: "needs-attention", error_code: "pane_gone" });
    const [item] = await h.delivery.attentionItems();
    expect(item?.notice?.disposition).toBe("fallback-withheld");
    await stopped(h.delivery);
  });

  it("keeps a notice held behind a draft out of attention, and trails each attempt until it is typed (deferred wake)", async () => {
    const h = setup({ advisory: settledAttempt() });
    await advisoryExpired(h.store, Q1, 1);
    const putIntent = h.store.putIntent.bind(h.store);
    let first = true;
    h.store.putIntent = async (intent) => {
      await putIntent(intent);
      if (first && intent.question_id === Q1) {
        first = false;
        h.drafts.add(PANE);
      }
    };

    h.delivery.start();
    await until(async () => (await h.store.openIntents()).length === 1);
    const [held] = await h.store.openIntents();
    await until(async () => (await h.store.getIntent(held.injection_id))?.state === "abandoned");
    expect(h.client.submitted).toEqual([]);
    // Waiting for its composer is no one's to decide: no attention, no stall.
    expect(await h.delivery.attentionItems()).toEqual([]);
    expect((await h.question(Q1))?.delivery_status).not.toMatch(/needs-attention|uncertain/);

    h.drafts.clear();
    h.signal("composer");
    await until(async () => (await entryOf(h)).delivered, 10_000);
    expect(h.client.submitted).toHaveLength(1);
    const typed = (await entryOf(h)).injection_id;
    expect(await trail(h)).toMatchObject([
      { step: "attempted", attempt: held.injection_id, revision: 0, deadline: DEADLINE },
      { step: "untyped", attempt: held.injection_id, pane: PANE },
      { step: "attempted", attempt: typed },
      { step: "delivered", attempt: typed },
    ]);
    expect(await h.delivery.attentionItems()).toEqual([]);
    await stopped(h.delivery);
  });

  it("after a restart that can't tell whether the notice went in, lists it uncertain, never types it again, and lets a person handle it", async () => {
    const h = setup({ advisory: settledAttempt(), listTerminals: true, resume: {} });
    const origin = { ...ORIGIN, agent_session_id: "claude-session-9" };
    await advisoryExpired(h.store, Q1, 1, { origin, last_injection_id: CRASHED });
    await h.store.putIntent(intent(CRASHED, Q1, { answer_revision: 0 }));
    h.client.screens.set(PANE, "❯ \r\n");

    h.delivery.start();
    await until(async () => (await h.question(Q1))?.delivery_status === "delivery-uncertain");
    const [item] = await h.delivery.attentionItems();
    expect(item).toMatchObject({
      status: "delivery-uncertain",
      reason: "crash_unreconciled",
      notice: { delivery: "delivery-uncertain", disposition: "fallback-due" },
      canResume: false,
      canReassign: false,
    });
    await expect(h.delivery.resumeAnswer(Q1)).resolves.toEqual({
      result: "refused",
      reason: "uncertain",
    });

    await expect(h.delivery.markHandled(Q1)).resolves.toEqual({ result: "handled" });
    expect(await h.delivery.attentionItems()).toEqual([]);
    h.signal("settled");
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toEqual([]);
    expect(h.launches).toEqual([]);
    expect(await trail(h)).toMatchObject([
      { step: "uncertain", reason: "crash_unreconciled", attempt: CRASHED },
    ]);
    await stopped(h.delivery);
  });

  it("resolves the notice once when two windows mark it handled together", async () => {
    const h = setup({ advisory: settledAttempt(), listTerminals: true });
    await advisoryExpired(h.store, Q1, 1);
    await refusedWrite(h);

    const results = await Promise.all([h.delivery.markHandled(Q1), h.delivery.markHandled(Q1)]);
    expect(results.map((r) => r.result).sort()).toEqual(["handled", "resolved"]);
    const handled = (await h.store.listAudit(500)).filter((e) => e.event === "delivery.handled");
    expect(handled).toHaveLength(1);
    expect(await h.delivery.attentionItems()).toEqual([]);
    expect((await trail(h)).map((t) => t.step)).toEqual([
      "attempted",
      "untyped",
      "needs-attention",
      "stopped",
    ]);
    expect(h.client.submitted).toEqual([]);
    await stopped(h.delivery);
  });

  it("calls a retried notice a reopen replaced before it was typed resolved, never delivered or waiting", async () => {
    const h = setup({ advisory: settledAttempt(), listTerminals: true });
    await advisoryExpired(h.store, Q1, 1);
    await refusedWrite(h);
    h.client.generations.set(PANE, 7);
    h.patch({ launchGeneration: 7 });
    // The person's phone reopens the question in the same lock turn the retry is written in.
    const update = h.store.updateQuestion.bind(h.store);
    h.store.updateQuestion = async (id, patch) => {
      const next = await update(id, patch);
      if (id === Q1 && patch.delivery_status === "desktop-received") {
        return update(id, {
          question_revision: 1,
          local_status: "open",
          expires_at: "2026-11-01T12:00:00.000Z",
        });
      }
      return next;
    };

    await expect(h.delivery.resumeAnswer(Q1)).resolves.toEqual({ result: "resolved" });
    expect(h.client.submitted).toEqual([]);
    expect((await trail(h)).map((t) => t.step)).toContain("superseded");
    await stopped(h.delivery);
  });
});

describe("AnswerDelivery, a person's decline (#17234)", () => {
  const declineOf = async (h: ReturnType<typeof setup>) =>
    parseAnswers((await h.question(Q1))!.answers_json)[0]!;

  it("types the decline into the run still listening once its line is free, once, as Daintree's block", async () => {
    const h = setup();
    h.works({ typed: true });
    await declined(h.store, Q1, 1);

    h.delivery.start();
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toEqual([]);

    h.settles();
    await until(() => h.client.submitted.length === 1);
    const [typed] = h.client.submitted;
    expect(typed.id).toBe(PANE);
    expect(typed.text).toContain(DECISION_BLOCK_START);
    expect(typed.text).toContain("source: human\nstatus: declined\nauthorised: no\nnote: ");
    expect(typed.text).not.toMatch(/^(choice|comment):/m);
    await until(async () => (await declineOf(h)).delivered);
    expect(await declineOf(h)).toMatchObject({ deliver: true, delivered: true });
    expect(typed.text).toContain(markerFor((await declineOf(h)).injection_id!));
    // A notice has no relay delivery to report.
    expect(h.terminalReports()).toEqual([]);
    expect(await h.delivery.attentionItems()).toEqual([]);

    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toHaveLength(1);
    await stopped(h.delivery);
  });

  it.each([
    ["gone", (h: ReturnType<typeof setup>) => h.client.terminals.delete(PANE)],
    ["relaunched", (h: ReturnType<typeof setup>) => h.principals.set(PANE, "principal-2")],
  ] as const)(
    "never resumes a %s run to tell it, and never asks a person about it",
    async (_label, change) => {
      // Its session could be reopened: an answer would be typed there.
      const h = setup({ resume: {} });
      const origin = { ...ORIGIN, agent_session_id: "claude-session-9" };
      await declined(h.store, Q1, 1, { origin });
      change(h);

      h.delivery.start();
      await until(async () => !(await declineOf(h)).deliver);
      const row = (await h.question(Q1))!;
      expect(await declineOf(h)).toMatchObject({ deliver: false, delivered: false });
      expect(row.origin).toEqual(origin);
      expect(row.delivery_status).toBe("desktop-received");
      expect(h.launches).toEqual([]);
      expect(h.client.submitted).toEqual([]);
      expect(h.failedReports()).toEqual([]);
      expect(await h.delivery.attentionItems()).toEqual([]);
      // Nothing is left for the minute check to look for.
      expect(await h.store.hasPendingDelivery()).toBe(false);

      await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
      expect(h.launches).toEqual([]);
      expect(h.client.submitted).toEqual([]);
      await stopped(h.delivery);
    }
  );

  it("waits for a terminal's host that is only offline, never dropping it, then types it", async () => {
    const h = setup();
    // Held behind a line typed into the busy pane, then its host goes away.
    h.works({ typed: true });
    await declined(h.store, Q1, 1);
    h.delivery.start();
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toEqual([]);

    h.pty.ready = false;
    h.settles();
    await until(async () => (await h.question(Q1))?.delivery_status === "pending-host");
    expect(await declineOf(h)).toMatchObject({ deliver: true, delivered: false });
    expect(h.client.submitted).toEqual([]);
    expect(await h.delivery.attentionItems()).toEqual([]);

    h.pty.ready = true;
    h.signal("appeared");
    await until(() => h.client.submitted.length === 1);
    expect(h.client.submitted[0].text).toContain("status: declined");
    await stopped(h.delivery);
  });

  it("never types a decline a crash may have typed, and never asks a person about it", async () => {
    const h = setup();
    await declined(h.store, Q1, 1);
    await h.store.putIntent(intent(CRASHED, Q1, { answer_revision: 0 }));
    h.client.screens.set(PANE, "❯ \r\n");

    h.delivery.start();
    await until(async () => (await h.question(Q1))?.delivery_status === "delivery-uncertain");
    expect(await h.delivery.attentionItems()).toEqual([]);

    h.signal("settled");
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toEqual([]);
    await stopped(h.delivery);
  });
});

describe("AnswerDelivery follow-ups (#16231)", () => {
  const messageOf = async (h: ReturnType<typeof setup>, id: string) =>
    parseMessages((await h.question(Q1))!.messages_json).find((m) => m.message_id === id)!;
  const receipts = (h: ReturnType<typeof setup>) =>
    h.reports
      .filter((r) => r.path.endsWith("/deliveries/messages"))
      .map((r) => `${String(r.body.message_id).slice(-4)}:${String(r.body.status)}`);

  it("types an answer and the follow-up after it in thread order, as Daintree's blocks, then reports each", async () => {
    const h = setup();
    await answered(h.store, Q1, 1, "approve");
    await followedUp(h.store, Q1, M1, "Keep the old icons, though.");

    h.delivery.start();
    await until(async () => (await messageOf(h, M1)).delivery?.status === "terminal-delivered");
    expect(h.client.submitted).toHaveLength(1);
    const typed = h.client.submitted[0].text;
    expect(typed.startsWith(DECISION_THREAD_PREFACE)).toBe(true);
    expect(typed.indexOf(DECISION_BLOCK_START)).toBeLessThan(
      typed.indexOf(DECISION_FOLLOWUP_START)
    );
    expect(typed).toContain("text: Keep the old icons, though.\n");
    expect(typed).toContain(`message_id: ${M1}\n`);
    expect(typedChoices(typed)).toEqual(["approve"]);
    expect((await h.question(Q1))?.delivery_status).toBe("terminal-delivered");

    await until(() => receipts(h).length === 2);
    expect(receipts(h)).toEqual(["ee01:received", "ee01:terminal-delivered"]);
    expect(await h.store.hasPendingDelivery()).toBe(false);
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toHaveLength(1);
  });

  it("holds a follow-up while a line typed mid-turn may be there, and types it once back at its prompt", async () => {
    const h = setup();
    await answeredAndTyped(h.store, Q1, 1);
    const before = (await h.question(Q1))!;
    await followedUp(h.store, Q1, M1, "One more thing.");
    h.works({ typed: true });

    h.delivery.start();
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    // The relay report is real async work a fixed clock step can outrun on a slow runner.
    await until(async () => (await messageOf(h, M1)).delivery?.reported === "received");
    expect(h.client.submitted).toEqual([]);
    expect((await messageOf(h, M1)).delivery).toMatchObject({
      status: "received",
      reported: "received",
    });

    h.settles();
    await until(() => h.client.submitted.length === 1);
    expect(h.client.submitted[0].text).toContain("text: One more thing.\n");
    await until(async () => (await messageOf(h, M1)).delivery?.status === "terminal-delivered");
    // The answer is exactly as it was: a follow-up never changes it.
    const after = (await h.question(Q1))!;
    expect(after).toMatchObject({
      answers_json: before.answers_json,
      delivered_revision: before.delivered_revision,
      delivery_status: before.delivery_status,
    });
  });

  it("never types a follow-up twice: one a crash left on the screen is found by its marker", async () => {
    const h = setup();
    await answeredAndTyped(h.store, Q1, 1);
    await followedUp(h.store, Q1, M1, "Typed before the crash.", {
      delivery: { reported: "received", attempt_id: CRASHED },
    });
    await h.store.putIntent(intent(CRASHED, Q1, { answer_revision: 0, message_id: M1 }));
    h.client.screens.set(PANE, `${markerFor(CRASHED)}\r\n`);

    h.delivery.start();
    await until(async () => (await messageOf(h, M1)).delivery?.status === "terminal-delivered");
    expect((await messageOf(h, M1)).delivery?.injection_id).toBe(CRASHED);
    await until(async () => (await h.store.getIntent(CRASHED))?.state === "acked");
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toEqual([]);
  });

  it("calls a crashed follow-up uncertain when its marker isn't found, and never types it again", async () => {
    const h = setup();
    await answeredAndTyped(h.store, Q1, 1);
    await followedUp(h.store, Q1, M1, "Maybe typed.", {
      delivery: { reported: "received", attempt_id: CRASHED },
    });
    // A store that lost the intent's message id still finds its follow-up by the attempt.
    await h.store.putIntent(intent(CRASHED, Q1, { answer_revision: 0 }));
    h.client.screens.set(PANE, "❯ \r\n");

    h.delivery.start();
    await until(async () => (await messageOf(h, M1)).delivery?.status === "delivery-uncertain");
    expect((await h.question(Q1))?.delivery_status).toBe("terminal-delivered");
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toEqual([]);
  });

  it.each([
    ["names its follow-up", "message-1"],
    ["names only its attempt, as a store that lost the message id leaves it", null],
  ] as const)(
    "keeps a follow-up's typed intent that %s from marking an answer delivered that never was",
    async (_label, named) => {
      const h = setup();
      await answered(h.store, Q1, 1, "approve");
      const [entry] = parseAnswers((await h.question(Q1))!.answers_json);
      // An expiry's notice is typed only while its round's question stays expired (0.9.0's `closureInForce`).
      await h.store.updateQuestion(Q1, {
        local_status: "expired",
        question_revision: 0,
        answers_json: serializeAnswers([
          { ...entry, kind: "expired", action: "expire", revision: 0 },
        ]),
      });
      await followedUp(h.store, Q1, M1, "Typed.", {
        delivery: { status: "terminal-delivered", injection_id: CRASHED, attempt_id: CRASHED },
      });
      await h.store.putIntent(
        intent(CRASHED, Q1, {
          answer_revision: 0,
          message_id: named === null ? null : M1,
          state: "typed",
        })
      );

      h.delivery.start();
      await until(async () => (await h.store.getIntent(CRASHED))?.state === "acked");
      await until(() => h.client.submitted.length === 1);
      // The expiry was typed on its own; the follow-up's record proved nothing about it.
      expect(h.client.submitted[0].text).toContain("status: expired");
      expect(h.client.submitted[0].text).not.toContain(DECISION_FOLLOWUP_START);
    }
  );

  it("copies a follow-up's photo as a path, and keeps the path so a later copy needs no download (#16233)", async () => {
    const stored: PhoneImageFile[] = [];
    const phoneImages: PhoneImageStore = {
      store: async (image) => {
        stored.push(image);
        return { path: `/repo/wt-1/.daintree/decisions/images/s/${image.attachmentId}.png` };
      },
    };
    const h = setup({ listTerminals: true, phoneImages });
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
        "1f15c4890000000d4944415478da63f8cfc0f01f0005000201a1b0b4" +
        "e60000000049454e44ae426082",
      "hex"
    );
    const attachmentId = "0190f0aa11112222333344445555a771";
    const sealed = await encryptAttachment(
      identity.epochs.get(1)!,
      { installationId: identity.config.installationId, questionId: Q1, attachmentId, keyEpoch: 1 },
      png
    );
    h.attachments.set(attachmentId, new Uint8Array(sealed.ciphertext));
    await answeredAndTyped(h.store, Q1, 1);
    await followedUp(h.store, Q1, M1, "This connector.", {
      images: [
        {
          attachment_id: attachmentId,
          mime: "image/png",
          size: png.length,
          sha256: sealed.sha256Plaintext,
          nonce: sealed.nonce,
          key_epoch: 1,
          alt: "The left one",
        },
      ],
    });
    h.client.terminals.delete(PANE);
    h.delivery.start();
    await until(async () => (await messageOf(h, M1)).delivery?.status === "needs-attention");
    // The pane was gone, so nothing was about to be typed and nothing was fetched.
    expect(stored).toEqual([]);

    const path = `/repo/wt-1/.daintree/decisions/images/s/${attachmentId}.png`;
    const copied = (await h.delivery.copiedAnswer(Q1))!;
    expect(copied).toContain(
      `text: This connector.\nimage_1: ${path}\nimage_1_alt: The left one\n`
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      questionId: Q1,
      carrier: { kind: "message", messageId: M1 },
      attachmentId,
      mime: "image/png",
    });
    expect(Buffer.from(stored[0]!.bytes).equals(png)).toBe(true);
    expect((await messageOf(h, M1)).delivery?.stored_images).toEqual([
      { attachment_id: attachmentId, path },
    ]);

    // Copied again with the relay away: the file kept is listed, not fetched.
    h.relay.up = false;
    expect(await h.delivery.copiedAnswer(Q1)).toContain(`image_1: ${path}\n`);
    expect(stored).toHaveLength(1);
  });

  it("lists a follow-up its pane couldn't take, copies it, and types it once a person resumes it", async () => {
    const h = setup({ listTerminals: true });
    await answeredAndTyped(h.store, Q1, 1);
    await followedUp(h.store, Q1, M1, "Use the staging bucket.");
    const pane = h.client.terminals.get(PANE)!;
    h.client.terminals.delete(PANE);

    h.delivery.start();
    await until(async () => (await messageOf(h, M1)).delivery?.status === "needs-attention");
    const [item] = await h.delivery.attentionItems();
    expect(item).toMatchObject({
      questionId: Q1,
      status: "needs-attention",
      reason: "pane_gone",
      answer: null,
      answerUnavailable: null,
      followUps: [
        {
          messageId: M1,
          onComputer: false,
          status: "needs-attention",
          reason: "pane_gone",
          text: "Use the staging bucket.",
          unreadable: false,
        },
      ],
      canReassign: true,
    });

    const copied = (await h.delivery.copiedAnswer(Q1))!;
    expect(copied).toContain(DECISION_FOLLOWUP_START);
    expect(copied).toContain("text: Use the staging bucket.");
    expect(copied).not.toContain(DECISION_BLOCK_START);
    expect(copied).not.toContain("[decision-injection");

    const resume = async () => {
      let outcome: unknown = null;
      void h.delivery.resumeAnswer(Q1).then((result) => (outcome = result));
      await until(() => outcome !== null);
      return outcome;
    };
    // Tried again while the pane is still gone: the same failure, in a new round of receipts.
    expect(await resume()).toMatchObject({ result: "needs-attention", reason: "pane_gone" });
    expect((await messageOf(h, M1)).delivery).toMatchObject({
      status: "needs-attention",
      retries: 1,
    });
    await until(() => receipts(h).length === 3);

    h.client.terminals.set(PANE, pane);
    expect(await resume()).toMatchObject({ result: "delivered", terminalId: PANE });
    expect(h.client.submitted).toHaveLength(1);
    expect(h.client.submitted[0].text).toContain("text: Use the staging bucket.");
    expect(await h.delivery.attentionItems()).toEqual([]);
    await until(() => receipts(h).length === 4);
    expect(receipts(h)).toEqual([
      "ee01:received",
      "ee01:needs-attention",
      "ee01:needs-attention",
      "ee01:terminal-delivered",
    ]);
    const keys = h.reports
      .filter((r) => r.path.endsWith("/deliveries/messages"))
      .map((r) => r.body.idempotency_key);
    expect(new Set(keys).size).toBe(4);
    expect((await h.question(Q1))?.delivered_revision).toBe(1);
  });

  it("holds a follow-up behind its answer while the answer needs a person, then types both in order", async () => {
    const h = setup({ listTerminals: true });
    await answered(h.store, Q1, 1, "approve", {
      delivery_status: "needs-attention",
      error_code: "pane_gone",
    });
    await followedUp(h.store, Q1, M1, "And keep it compact.");

    h.delivery.start();
    await advance(2 * DELIVERY_CHECK_INTERVAL_MS, 5_000);
    expect(h.client.submitted).toEqual([]);
    // Behind the answer, not itself held for a person: the answer's item carries it.
    expect((await messageOf(h, M1)).delivery?.status).toBe("received");
    const [item] = await h.delivery.attentionItems();
    expect(item).toMatchObject({ followUps: [], answer: { choices: ["approve"] } });

    let outcome: unknown = null;
    void h.delivery.resumeAnswer(Q1).then((result) => (outcome = result));
    await until(() => outcome !== null);
    expect(outcome).toMatchObject({ result: "delivered" });
    expect(h.client.submitted).toHaveLength(1);
    const typed = h.client.submitted[0].text;
    expect(typedChoices(typed)).toEqual(["approve"]);
    expect(typed.indexOf(DECISION_BLOCK_START)).toBeLessThan(
      typed.indexOf(DECISION_FOLLOWUP_START)
    );
    expect(typed).toContain("text: And keep it compact.");
  });

  it("lets the follow-ups after an answer marked handled go on, the answer itself never typed", async () => {
    const h = setup({ listTerminals: true });
    await answered(h.store, Q1, 1, "approve", {
      delivery_status: "needs-attention",
      error_code: "unknown_option",
    });
    h.delivery.start();
    await advance(1_000);
    expect(await h.delivery.markHandled(Q1)).toEqual({ result: "handled" });
    expect(parseAnswers((await h.question(Q1))!.answers_json)[0]).toMatchObject({
      deliver: false,
      delivered: false,
      revision: 1,
    });

    await followedUp(h.store, Q1, M1, "After the handled answer.");
    h.delivery.request();
    await until(() => h.client.submitted.length === 1);
    expect(h.client.submitted[0].text).toContain("text: After the handled answer.");
    expect(typedChoices(h.client.submitted[0].text)).toEqual([]);
    expect(await h.delivery.attentionItems()).toEqual([]);
  });

  it("releases an answer marked handled before handling stopped its delivery, when delivery starts", async () => {
    const earlier = new DaintreeLocalStore(sqlite);
    await answered(earlier, Q1, 1, "approve", {
      delivery_status: "needs-attention",
      error_code: "unknown_option",
    });
    await earlier.setMeta("daintree:handled-answers", JSON.stringify({ [Q1]: 1 }));
    await followedUp(earlier, Q1, M1, "Sent after it was handled.");
    await earlier.close();
    const h = setup();

    h.delivery.start();
    await until(() => h.client.submitted.length === 1);
    expect(h.client.submitted[0].text).toContain("text: Sent after it was handled.");
    expect(typedChoices(h.client.submitted[0].text)).toEqual([]);
    expect(parseAnswers((await h.question(Q1))!.answers_json)[0]).toMatchObject({ deliver: false });
  });

  it("gives a follow-up the resume's own reason when its run couldn't be resumed", async () => {
    const h = setup({
      listTerminals: true,
      resume: {
        wait: async (terminalId) => ({ terminalId, outcome: "timeout", state: "working" }),
      },
    });
    await answeredAndTyped(h.store, Q1, 1);
    await followedUp(h.store, Q1, M1, "Waiting for the resume.");
    h.client.terminals.delete(PANE);

    h.delivery.start();
    await until(async () => (await messageOf(h, M1)).delivery?.status === "needs-attention");
    expect((await messageOf(h, M1)).delivery?.error_code).toBe("resume_timeout");
    const [item] = await h.delivery.attentionItems();
    expect(item).toMatchObject({ reason: "resume_timeout", canResume: true });
    expect((await h.question(Q1))?.error_code).toBeNull();
  });

  it("refuses to resume or move a follow-up that may already have been typed", async () => {
    const h = setup({ listTerminals: true });
    await answeredAndTyped(h.store, Q1, 1);
    await followedUp(h.store, Q1, M1, "Maybe typed.", {
      delivery: {
        status: "delivery-uncertain",
        error_code: "crash_unreconciled",
        reported: "delivery-uncertain:crash_unreconciled:0",
      },
    });
    h.delivery.start();
    await advance(1_000);

    const [item] = await h.delivery.attentionItems();
    expect(item).toMatchObject({
      status: "delivery-uncertain",
      canResume: false,
      canReassign: false,
    });
    expect(await h.delivery.resumeAnswer(Q1)).toEqual({ result: "refused", reason: "uncertain" });
    expect(await h.delivery.reassignAnswer(Q1, PANE)).toEqual({
      result: "refused",
      reason: "uncertain",
    });
    expect(h.client.submitted).toEqual([]);
  });

  it("marks a held follow-up handled: it leaves the list, is never typed, and the next one goes on", async () => {
    const h = setup({ listTerminals: true });
    await answeredAndTyped(h.store, Q1, 1);
    await followedUp(h.store, Q1, M1, "Held for a person.", {
      delivery: {
        status: "needs-attention",
        error_code: "pane_gone",
        reported: "needs-attention:pane_gone:0",
      },
    });
    await followedUp(h.store, Q1, M2, "Sent after it.", { event_seq: 11 });

    h.delivery.start();
    await advance(2_000);
    // The library holds what follows a follow-up a person has to decide about.
    expect(h.client.submitted).toEqual([]);
    expect((await h.delivery.attentionItems()).map((i) => i.followUps.length)).toEqual([1]);

    expect(await h.delivery.markHandled(Q1)).toEqual({ result: "handled" });
    expect(await h.delivery.attentionItems()).toEqual([]);
    expect((await messageOf(h, M1)).delivery).toMatchObject({
      status: "needs-attention",
      deliver: false,
    });
    h.delivery.request();
    await until(() => h.client.submitted.length === 1);
    expect(h.client.submitted[0].text).toContain("text: Sent after it.");
    expect(h.client.submitted[0].text).not.toContain("Held for a person.");
  });
});

describe("AnswerDelivery question reads (#17097)", () => {
  const OWN = { projectId: "project-1", terminalId: PANE };

  async function withContent(store: DaintreeLocalStore, id: string, question: string) {
    await store.updateQuestion(id, {
      content_sealed: await sealQuestionContent({ identity }, id, { question }),
    });
  }

  it("reads a question whose answer was typed, after it has left the pane's state", async () => {
    const h = setup();
    await answeredAndTyped(h.store, Q1, 1);
    await withContent(h.store, Q1, "Approve the migration?");
    await followedUp(h.store, Q1, M1, "Run it after lunch.", {
      delivery: { status: "terminal-delivered" },
    });

    const read = await h.delivery.questionContent(OWN, Q1);

    expect(read).toMatchObject({
      result: "read",
      question: {
        questionId: Q1,
        question: "Approve the migration?",
        status: "human-answered",
        deliveryStatus: "terminal-delivered",
        thread: [
          { type: "answer", from: "person", text: "Go with approve.", unreadable: false },
          { type: "message", from: "person", text: "Run it after lunch." },
        ],
      },
    });
  });

  it("finds nothing for another pane, another project, or a question the store doesn't hold", async () => {
    const h = setup();
    await answered(h.store, Q1, 1, "approve");
    await withContent(h.store, Q1, "Approve the migration?");

    for (const [scope, id] of [
      [{ ...OWN, terminalId: "pane-2" }, Q1],
      [{ ...OWN, projectId: "project-2" }, Q1],
      [{ ...OWN, projectId: null }, Q1],
      [OWN, Q2],
    ] as const) {
      await expect(h.delivery.questionContent(scope, id)).resolves.toEqual({
        result: "not-found",
      });
    }
  });

  it("opens a question's image for its own pane in memory, and nothing for another (#17100)", async () => {
    const h = setup();
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
        "1f15c4890000000d4944415478da63f8cfc0f01f0005000201a1b0b4" +
        "e60000000049454e44ae426082",
      "hex"
    );
    const attachmentId = "0190f0aa11112222333344445555a772";
    const sealed = await encryptAttachment(
      identity.epochs.get(1)!,
      { installationId: identity.config.installationId, questionId: Q1, attachmentId, keyEpoch: 1 },
      png
    );
    h.attachments.set(attachmentId, new Uint8Array(sealed.ciphertext));
    await answered(h.store, Q1, 1, "approve");
    await h.store.updateQuestion(Q1, {
      content_sealed: await sealQuestionContent({ identity }, Q1, {
        question: "Ship the new header?",
        attachments: [
          {
            attachment_id: attachmentId,
            role: "after",
            mime: "image/png",
            size: png.length,
            sha256: sealed.sha256Plaintext,
            nonce: sealed.nonce,
            key_epoch: 1,
          },
        ],
      }),
    });

    for (const scope of [
      { ...OWN, terminalId: "pane-2" },
      { ...OWN, projectId: "project-2" },
      { ...OWN, projectId: null },
      // A reference naming another machine (#17229), whatever else it gets right.
      { ...OWN, hostId: "host_elsewhere" },
    ]) {
      await expect(h.delivery.questionImage(scope, Q1, attachmentId, 0)).resolves.toEqual({
        result: "not-found",
      });
    }
    // Scope is checked before anything is fetched.
    expect(h.reports.filter((r) => r.path.includes("/attachments/"))).toEqual([]);

    const read = await h.delivery.questionImage(OWN, Q1, attachmentId, 0);
    // A reference naming this machine reads the same image.
    await expect(
      h.delivery.questionImage({ ...OWN, hostId: HOST }, Q1, attachmentId, 0)
    ).resolves.toEqual(read);

    expect(read).toEqual({
      result: "read",
      part: {
        attachmentId,
        mime: "image/png",
        sha256: sealed.sha256Plaintext,
        size: png.length,
        offset: 0,
        bytes: new Uint8Array(png),
      },
    });
  });

  it("reads by a reference naming this machine, whatever its terminal became, and nothing for another machine (#17229)", async () => {
    const h = setup();
    await answeredAndTyped(h.store, Q1, 1);
    await withContent(h.store, Q1, "Approve the migration?");
    // A reference carries the question's own project and terminal, not the asking view's;
    // no terminal by that id need still run here.
    const reference = { hostId: HOST, ...OWN };

    await expect(h.delivery.questionContent(reference, Q1)).resolves.toMatchObject({
      result: "read",
      question: { questionId: Q1, question: "Approve the migration?" },
    });
    await expect(h.delivery.questionSummaries(reference, [Q1])).resolves.toEqual([
      { questionId: Q1, result: "read", line: "Approve the migration?" },
    ]);
    for (const scope of [
      { ...reference, hostId: "host_elsewhere" },
      { ...reference, projectId: "project-2" },
      { ...reference, terminalId: "pane-2" },
    ]) {
      await expect(h.delivery.questionContent(scope, Q1)).resolves.toEqual({ result: "not-found" });
      await expect(h.delivery.questionSummaries(scope, [Q1])).resolves.toEqual([
        { questionId: Q1, result: "not-found" },
      ]);
    }
  });

  it("names each question asked for once, in order, and only the pane's own", async () => {
    const h = setup();
    await answered(h.store, Q1, 1, "approve");
    await withContent(h.store, Q1, "Approve the migration?\nIt drops a column.");
    await answered(h.store, Q2, 2, "deny", { origin: { ...ORIGIN, pane_id: "pane-2" } });
    await withContent(h.store, Q2, "Delete the branch?");

    await expect(h.delivery.questionSummaries(OWN, [Q2, Q1, CRASHED, Q1])).resolves.toEqual([
      { questionId: Q2, result: "not-found" },
      { questionId: Q1, result: "read", line: "Approve the migration?" },
      { questionId: CRASHED, result: "not-found" },
    ]);
  });
});
