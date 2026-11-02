// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DecisionsBridge,
  MemoryKeyStore,
  MemoryLocalStore,
  RelayClient,
  currentEpochKey,
  hostRef,
  loadIdentity,
  type Identity,
  type InjectResult,
  type LearnedDecision,
  type ProxyQuestionInput,
  type QuestionOrigin,
  type StoredIdentity,
  type TerminalSink,
} from "@daintreehq/decisions-client";
import {
  buildSignedAction,
  encryptEnvelope,
  exportPublicKey,
  generateDeviceKeys,
  generateEpochKeyBytes,
  issueDeviceCert,
  newId,
  serializeDeviceKeys,
  type DeviceKeys,
} from "@daintreehq/decisions-crypto";
import { FakeAdapter, type ModelPrompt } from "@daintreehq/decisions-model";
import { SqliteHistoryStore } from "@daintreehq/decisions-model/sqlite";
import { bytesToBase64Url, type DeviceCert } from "@daintreehq/decisions-protocol";
import type { DecisionsModelAdapter } from "../../../../shared/types/decisions.js";
import { parseAnswerNotice, renderDecisionSection } from "../answerNotice.js";
import {
  DecisionModelRuntime,
  decisionModelFiles,
  parseDecisionModelEvaluation,
  proxyRefusal,
  type DecisionModelFiles,
} from "../decisionModel.js";
import { SETUP_DIAGNOSTIC_PROJECT_ID } from "../setupDiagnostic.js";
import { DESIGN_REVIEW_FINAL_GATE_ID, createTrustedPolicy } from "../workflowGates.js";
import { defaultDecisionsSettings } from "../decisionsSettings.js";

const OPTIONS = [
  { id: "rebase", label: "Rebase onto develop" },
  { id: "merge", label: "Merge develop in" },
];
/** Enough past answers for the replay to score the 30 a threshold needs. */
const PAST = 36;
const START = Date.parse("2026-10-01T09:00:00.000Z");

function iso(minutes: number): string {
  return new Date(START + minutes * 60_000).toISOString();
}

function question(n: number): string {
  return `Rebase or merge develop before opening the pull request for change ${n}?`;
}

/** A person's answer as the bridge offers it to the learner. */
function decision(n: number, overrides: Partial<LearnedDecision> = {}): LearnedDecision {
  return {
    questionId: `q-past-${String(n).padStart(4, "0")}`,
    question: question(n),
    options: OPTIONS,
    kind: "choice",
    requirement: "proxy-ok",
    projectId: "project-1",
    createdAt: iso(n * 10),
    chosenAt: iso(n * 10 + 5),
    selectedOptionIds: ["rebase"],
    text: "",
    revision: 1,
    correction: false,
    ...overrides,
  };
}

/**
 * A CLI that always rebases, citing the first example it was shown, as a
 * calibrated model would. `hold` makes its next replies wait until released.
 */
function rebasingCli(): FakeAdapter & { hold(): () => void } {
  let gate: Promise<void> = Promise.resolve();
  const cli = new FakeAdapter({
    id: "fake-cli",
    modelId: "fake-model",
    responder: async (prompt: ModelPrompt) => {
      await gate;
      const shown = [...prompt.user.matchAll(/\[example id=(\S+) chosen_at=/g)].map((m) => m[1]);
      return JSON.stringify({
        action: "answer",
        selected_option_ids: ["rebase"],
        answer_text: null,
        confidence_estimate: 0.95,
        supporting_decision_ids: shown.slice(0, 1),
        risk_flags: [],
        rationale: null,
        reason: null,
      });
    },
  });
  return Object.assign(cli, {
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      return release;
    },
  });
}

function proxyInput(overrides: Partial<ProxyQuestionInput> = {}): ProxyQuestionInput {
  return {
    questionId: "q-new-0001",
    question: question(99),
    options: OPTIONS,
    requirement: "proxy-ok",
    projectId: "project-1",
    createdAt: iso(10_000),
    kind: "choice",
    attachments: [],
    ...overrides,
  };
}

let dir: string;
let files: DecisionModelFiles;
const runtimes: DecisionModelRuntime[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "daintree-decision-model-"));
  files = decisionModelFiles(join(dir, "decisions", "keys.bin"));
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function makeRuntime(cli: Partial<Record<DecisionsModelAdapter, FakeAdapter>> = {}) {
  const onProxyChanged = vi.fn();
  const createAdapter = vi.fn((adapter: DecisionsModelAdapter) => {
    const made = cli[adapter];
    if (!made) throw new Error(`no ${adapter} in this test`);
    return made;
  });
  const runtime = new DecisionModelRuntime({ files, onProxyChanged, createAdapter });
  runtimes.push(runtime);
  return { runtime, onProxyChanged, createAdapter };
}

async function learnPast(runtime: DecisionModelRuntime, count = PAST): Promise<void> {
  for (let n = 1; n <= count; n += 1) await runtime.learner.learn(decision(n));
}

/** A runtime that has learned, been evaluated through `cli` and given a threshold its evaluation supports. */
async function armedRuntime(cli = rebasingCli()) {
  const made = makeRuntime({ claude: cli });
  await made.runtime.update({ modelLearning: true, modelAdapter: "claude" });
  await learnPast(made.runtime);
  await made.runtime.evaluate();
  await made.runtime.setAutoAnswerThreshold(0.8);
  expect(made.runtime.proxy()).not.toBeNull();
  return { ...made, cli };
}

function storedExamples() {
  const history = new SqliteHistoryStore(files.history);
  try {
    return history.all();
  } finally {
    history.close();
  }
}

describe("the decision model's runtime (#16026)", () => {
  it("opens no history, records nothing and arms nothing while learning is off", async () => {
    const { runtime, createAdapter } = makeRuntime({ claude: rebasingCli() });
    await runtime.update({ modelLearning: false, modelAdapter: "claude" });

    expect(await runtime.learner.learn(decision(1))).toBeUndefined();
    expect(existsSync(files.history)).toBe(false);
    expect(runtime.proxy()).toBeNull();
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it("keeps a person's answers with secrets filtered once learning is on, CLI or not", async () => {
    const { runtime } = makeRuntime();
    await runtime.update({ modelLearning: true, modelAdapter: null });
    await runtime.learner.learn(
      decision(1, {
        text: "Rebase it, then push with ghp_abcdefghijklmnopqrstuvwxyz0123456789 and DB_PASSWORD=hunter2",
      })
    );
    // A setup check's own test question is Daintree's, not the person's.
    await runtime.learner.learn(decision(2, { projectId: SETUP_DIAGNOSTIC_PROJECT_ID }));
    expect(runtime.proxy()).toBeNull();
    await runtime.close();

    const kept = storedExamples();
    expect(kept.map((example) => example.question_id)).toEqual([decision(1).questionId]);
    expect(kept[0]!.selected_option_ids).toEqual(["rebase"]);
    expect(kept[0]!.human_reasoning).toContain("[REDACTED]");
    expect(kept[0]!.human_reasoning).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(kept[0]!.human_reasoning).not.toContain("hunter2");
    if (process.platform !== "win32") {
      expect(statSync(files.history).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "decisions")).mode & 0o777).toBe(0o700);
    }
  });

  it("arms only once the chosen CLI's evaluation is stored and a threshold it supports is chosen", async () => {
    const cli = rebasingCli();
    const { runtime, onProxyChanged } = makeRuntime({ claude: cli });
    await runtime.update({ modelLearning: true, modelAdapter: "claude" });
    await learnPast(runtime);
    // Nothing is asked of the CLI to find out it may not answer.
    expect(cli.calls).toHaveLength(0);
    expect(runtime.proxy()).toBeNull();

    const evaluation = await runtime.evaluate();
    expect(evaluation).toMatchObject({ adapter: "claude", autoAnswerThreshold: null });
    expect(evaluation.report.calibration.points.length).toBeGreaterThanOrEqual(30);
    // A report the person hasn't chosen a threshold from arms nothing.
    expect(runtime.proxy()).toBeNull();
    expect(onProxyChanged).not.toHaveBeenCalled();
    const stored = JSON.parse(readFileSync(files.evaluation, "utf8")) as Record<string, unknown>;
    expect(stored.report).not.toHaveProperty("items");
    expect(parseDecisionModelEvaluation(stored)).toEqual(evaluation);

    // Every replayed answer was at 0.95, so 0.99 has no evidence behind it.
    await runtime.setAutoAnswerThreshold(0.99);
    expect(runtime.proxy()).toBeNull();
    expect(onProxyChanged).not.toHaveBeenCalled();

    await runtime.setAutoAnswerThreshold(0.8);
    expect(runtime.proxy()).not.toBeNull();
    expect(onProxyChanged).toHaveBeenCalledTimes(1);

    await runtime.setAutoAnswerThreshold(null);
    expect(runtime.proxy()).toBeNull();
    expect(onProxyChanged).toHaveBeenCalledTimes(2);
  });

  it("starts a new evaluation with no threshold, so it disarms until one is chosen again", async () => {
    const { runtime, onProxyChanged } = await armedRuntime();
    await runtime.evaluate();
    expect(runtime.proxy()).toBeNull();
    expect(runtime.getEvaluation()?.autoAnswerThreshold).toBeNull();
    expect(onProxyChanged).toHaveBeenCalledTimes(2);
  });

  it("answers a question it may, and refuses the rest before the CLI sees them", async () => {
    const { runtime, cli } = await armedRuntime();
    const proxy = runtime.proxy()!;
    const before = cli.calls.length;

    await expect(proxy.suggest(proxyInput(), new AbortController().signal)).resolves.toMatchObject({
      action: "answer",
      selected_option_ids: ["rebase"],
      model_id: "fake-model",
    });
    expect(cli.calls).toHaveLength(before + 1);

    const refused: Array<[Partial<ProxyQuestionInput>, string]> = [
      [{ requirement: "human-required" as never }, "human-required"],
      [{ workflowGateId: DESIGN_REVIEW_FINAL_GATE_ID }, "blocked-gate"],
      [{ workflowGateId: "design-review/draft" }, "blocked-gate"],
      [{ workflowGateId: "release/final-approval" }, "blocked-gate"],
    ];
    for (const [input, reason] of refused) {
      await expect(
        proxy.suggest(proxyInput({ questionId: newId(), ...input }), new AbortController().signal),
        reason
      ).resolves.toEqual({ action: "abstain", reason });
    }
    // The model's own topic list holds too.
    const topic = await proxy.suggest(
      proxyInput({ questionId: newId(), question: "Force-push develop to rewrite its history?" }),
      new AbortController().signal
    );
    expect(topic).toMatchObject({ action: "abstain" });
    expect((topic as { reason: string }).reason).toMatch(/^blocked-topic/);
    expect(cli.calls).toHaveLength(before + 1);
  });

  it("names what it refuses without any model", () => {
    expect(proxyRefusal(proxyInput())).toBeNull();
    expect(proxyRefusal(proxyInput({ requirement: "proxy-first" }))).toBeNull();
    expect(proxyRefusal(proxyInput({ workflowGateId: "deploy/staging" }))).toBeNull();
    expect(proxyRefusal(proxyInput({ requirement: "human-required" as never }))).toBe(
      "human-required"
    );
    expect(proxyRefusal(proxyInput({ requirement: "anything" as never }))).toBe("human-required");
    expect(proxyRefusal(proxyInput({ workflowGateId: DESIGN_REVIEW_FINAL_GATE_ID }))).toBe(
      "blocked-gate"
    );
  });

  it("drops what the model says once learning is turned off while it runs", async () => {
    const { runtime, cli, onProxyChanged } = await armedRuntime();
    const release = cli.hold();
    const calls = cli.calls.length;

    const running = runtime
      .proxy()!
      .suggest(proxyInput({ questionId: "q-new-0002" }), new AbortController().signal);
    await vi.waitFor(() => expect(cli.calls).toHaveLength(calls + 1));
    await runtime.update({ modelLearning: false, modelAdapter: "claude" });
    release();

    await expect(running).resolves.toEqual({ action: "abstain", reason: "model-off" });
    expect(runtime.proxy()).toBeNull();
    expect(onProxyChanged).toHaveBeenCalledTimes(2);
  });

  it("asks only the CLI chosen, disarms for another whose evidence it doesn't have, and keeps the proxy through a repeat", async () => {
    const claude = rebasingCli();
    const codex = rebasingCli();
    const { runtime, onProxyChanged, createAdapter } = makeRuntime({ claude, codex });
    await runtime.update({ modelLearning: true, modelAdapter: "claude" });
    await learnPast(runtime);
    await runtime.evaluate();
    await runtime.setAutoAnswerThreshold(0.8);
    const armed = runtime.proxy();
    expect(armed).not.toBeNull();

    // The same preferences again change nothing: the attempt asking this proxy carries on.
    await runtime.update({ modelLearning: true, modelAdapter: "claude" });
    expect(runtime.proxy()).toBe(armed);
    expect(onProxyChanged).toHaveBeenCalledTimes(1);

    await runtime.update({ modelLearning: true, modelAdapter: "codex" });
    expect(createAdapter.mock.calls.map(([adapter]) => adapter)).toEqual(["claude", "codex"]);
    expect(runtime.proxy()).toBeNull();
    expect(runtime.getEvaluation()).toBeNull();
    expect(onProxyChanged).toHaveBeenCalledTimes(2);
    await expect(runtime.setAutoAnswerThreshold(0.8)).rejects.toThrow();
    expect(codex.calls).toHaveLength(0);

    // Back to the CLI the stored evaluation is for: armed again, without evaluating.
    await runtime.update({ modelLearning: true, modelAdapter: "claude" });
    expect(runtime.proxy()).not.toBeNull();
    expect(onProxyChanged).toHaveBeenCalledTimes(3);

    // Evaluating codex replays through codex alone, and its report replaces claude's.
    await runtime.update({ modelLearning: true, modelAdapter: "codex" });
    const claudeCalls = claude.calls.length;
    await expect(runtime.evaluate()).resolves.toMatchObject({ adapter: "codex" });
    expect(codex.calls.length).toBeGreaterThan(0);
    expect(claude.calls).toHaveLength(claudeCalls);
    expect(runtime.proxy()).toBeNull();
  });

  it("arms a later lifetime from what was stored, without evaluating again", async () => {
    const { runtime } = await armedRuntime();
    await runtime.close();

    const cli = rebasingCli();
    const later = makeRuntime({ claude: cli });
    await later.runtime.update({ modelLearning: true, modelAdapter: "claude" });
    expect(later.runtime.proxy()).not.toBeNull();
    expect(later.runtime.getEvaluation()?.autoAnswerThreshold).toBe(0.8);
    expect(cli.calls).toHaveLength(0);
  });

  it("reads a damaged or foreign evaluation as none, which arms nothing", async () => {
    const { runtime } = await armedRuntime();
    await runtime.close();
    const good = JSON.parse(readFileSync(files.evaluation, "utf8")) as Record<string, unknown>;
    const damaged: unknown[] = [
      "not json",
      { ...good, v: 2 },
      { ...good, adapter: "openai" },
      { ...good, autoAnswerThreshold: 1.5 },
      { ...good, autoAnswerThreshold: "0.8" },
      { ...good, report: { ...(good.report as object), calibration: null } },
    ];
    for (const value of damaged) {
      writeFileSync(files.evaluation, typeof value === "string" ? value : JSON.stringify(value));
      const later = makeRuntime({ claude: rebasingCli() });
      await later.runtime.update({ modelLearning: true, modelAdapter: "claude" });
      expect(later.runtime.proxy(), JSON.stringify(value).slice(0, 60)).toBeNull();
      await later.runtime.close();
    }
  });

  it("disarms an armed proxy on close without asking for a replacement: the connection is going too", async () => {
    const { runtime, onProxyChanged } = await armedRuntime();
    const proxy = runtime.proxy()!;
    await runtime.close();
    expect(runtime.proxy()).toBeNull();
    expect(onProxyChanged).toHaveBeenCalledTimes(1);
    await expect(
      proxy.suggest(proxyInput({ questionId: "q-new-0003" }), new AbortController().signal)
    ).resolves.toEqual({ action: "abstain", reason: "model-off" });
  });

  it("cancels an evaluation closed between taking its turn and starting, before it sends anything", async () => {
    const cli = rebasingCli();
    const { runtime } = makeRuntime({ claude: cli });
    await runtime.update({ modelLearning: true, modelAdapter: "claude" });
    await learnPast(runtime);

    // The idle queue runs the evaluation's turn in the next microtask; this close lands right after it.
    const evaluating = runtime.evaluate();
    let closing: Promise<void> | null = null;
    queueMicrotask(() => {
      closing = runtime.close();
    });
    await expect(evaluating).rejects.toThrow(/cancelled/);
    await closing;
    expect(cli.calls).toHaveLength(0);
  });

  it("evaluates the CLI chosen just before it was asked, rather than cancelling", async () => {
    const claude = rebasingCli();
    const codex = rebasingCli();
    const { runtime } = makeRuntime({ claude, codex });
    await runtime.update({ modelLearning: true, modelAdapter: "claude" });
    await learnPast(runtime);

    const switched = runtime.update({ modelLearning: true, modelAdapter: "codex" });
    const evaluating = runtime.evaluate();
    await switched;
    await expect(evaluating).resolves.toMatchObject({ adapter: "codex" });
    expect(claude.calls).toHaveLength(0);
  });

  it("closes a history whose setup fails, and tries again on the next change", async () => {
    const closed = vi.fn();
    let fail = true;
    const runtime = new DecisionModelRuntime({
      files,
      onProxyChanged: () => {},
      openHistory: () => {
        const history = new SqliteHistoryStore(files.history);
        const setLearning = history.setLearningEnabled.bind(history);
        const close = history.close.bind(history);
        return Object.assign(history, {
          setLearningEnabled: (on: boolean) => {
            if (fail) throw new Error("readonly database");
            setLearning(on);
          },
          close: () => {
            closed();
            close();
          },
        });
      },
    });
    runtimes.push(runtime);
    await expect(runtime.update({ modelLearning: true, modelAdapter: null })).rejects.toThrow(
      /readonly/
    );
    expect(closed).toHaveBeenCalledTimes(1);

    fail = false;
    await runtime.update({ modelLearning: true, modelAdapter: null });
    await runtime.learner.learn(decision(1));
    await runtime.close();
    expect(closed).toHaveBeenCalledTimes(2);
    expect(storedExamples()).toHaveLength(1);
  });

  it("stops on close: an evaluation running is cancelled, and no replacement is asked for", async () => {
    const cli = rebasingCli();
    const { runtime, onProxyChanged } = makeRuntime({ claude: cli });
    await runtime.update({ modelLearning: true, modelAdapter: "claude" });
    await learnPast(runtime);
    const release = cli.hold();

    const evaluating = runtime.evaluate();
    await vi.waitFor(() => expect(cli.calls.length).toBeGreaterThan(0));
    const closed = runtime.close();
    release();

    await expect(evaluating).rejects.toThrow();
    await closed;
    expect(existsSync(files.evaluation)).toBe(false);
    expect(onProxyChanged).not.toHaveBeenCalled();
    expect(await runtime.learner.learn(decision(PAST + 1))).toBeUndefined();
  });
});

const RELAY_ORIGIN = "https://decisions.example.workers.dev";
const INSTALLATION = "inst_12345678";
const OWNER = "dev_owner_1234";
const PHONE = "dev_phone_1234";

function origin(workflowGateId: string | null = null): QuestionOrigin {
  return {
    host_id: "host_12345678",
    pane_id: "pane-1",
    terminal_generation: 1,
    ownership_principal: "principal-1",
    agent_incarnation: "incarnation-1",
    agent_kind: "claude",
    agent_session_id: "session-1",
    project_id: "project-1",
    worktree_id: "worktree-1",
    worktree_root: "/repo",
    workflow_gate_id: workflowGateId,
  };
}

function deviceInfo(cert: DeviceCert) {
  return {
    device_id: cert.device_id,
    role: cert.role,
    label: cert.label,
    created_at: new Date().toISOString(),
    revoked_at: null,
    last_seen_at: null,
    last_ack_seq: 0,
    cert,
    push_enabled: false,
  };
}

async function certFor(
  identity: Identity,
  deviceId: string,
  role: "owner-desktop" | "phone",
  keys: DeviceKeys
) {
  return issueDeviceCert({
    issuerDeviceId: OWNER,
    issuerSigningKey: identity.keys.signing.privateKey,
    installationId: INSTALLATION,
    deviceId,
    role,
    label: role,
    signingPub: await exportPublicKey(keys.signing.publicKey),
    exchangePub: await exportPublicKey(keys.exchange.publicKey),
  });
}

interface InboundEventLike {
  seq: number;
  event_id: string;
  event_type: string;
  question_id: string;
  question_revision: number;
  origin_device_id: string | null;
  data: Record<string, unknown>;
}

interface Sent {
  path: string;
  body: { action?: { record: Record<string, unknown>; envelope: unknown } } | null;
}

/**
 * A desktop's bridge asking with the runtime's proxy and learner, against a
 * relay that takes the question and the proxy's action and gives back what it
 * committed, as its ledger would: everything but the relay and the terminal is real.
 */
async function bridgeLoop(runtime: DecisionModelRuntime) {
  const ownerKeys = await generateDeviceKeys(true);
  const stored: StoredIdentity = {
    v: 1,
    config: {
      relayOrigin: RELAY_ORIGIN,
      installationId: INSTALLATION,
      deviceId: OWNER,
      label: "Desktop",
    },
    keys: await serializeDeviceKeys(ownerKeys),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
    currentEpoch: 1,
  };
  const keyStore = new MemoryKeyStore();
  await keyStore.save(stored);
  const identity = await loadIdentity(keyStore);
  const phoneKeys = await generateDeviceKeys(false);
  const devices = {
    key_epoch: 1,
    owner_device_id: OWNER,
    devices: [
      deviceInfo(await certFor(identity, OWNER, "owner-desktop", identity.keys)),
      deviceInfo(await certFor(identity, PHONE, "phone", phoneKeys)),
    ],
  };
  const sent: Sent[] = [];
  /** The relay's ledger, and how much of it the inbox has been given. */
  const ledger: Array<Omit<InboundEventLike, "seq" | "event_id">> = [];
  let given = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Sent["body"]) : null;
    const reply = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (pathname === "/api/v1/devices" && method === "GET") return reply(devices);
    if (method === "POST") {
      sent.push({ path: pathname, body });
      if (pathname === "/api/v1/questions") {
        const { question } = body as unknown as {
          question: { record: Record<string, unknown>; envelope: unknown };
        };
        const questionId = String(question.record.question_id);
        ledger.push({
          event_type: "decision.created",
          question_id: questionId,
          question_revision: 0,
          origin_device_id: OWNER,
          data: {
            record: question.record,
            envelope: question.envelope,
            requirement: question.record.requirement,
            target_host_id: question.record.target_host_id,
            expires_at: question.record.expires_at,
          },
        });
        return reply({
          question_id: questionId,
          revision: 0,
          status: "open",
          event_seq: ledger.length,
        });
      }
      if (/^\/api\/v1\/questions\/[^/]+\/proxy-(answer|abstain)$/.test(pathname)) {
        return reply({ ok: true });
      }
    }
    throw new TypeError("offline");
  }) as typeof fetch;

  const injected: string[] = [];
  const sink: TerminalSink = {
    locate: async (o) => ({
      state: "alive",
      target: {
        hostId: o.host_id,
        paneId: o.pane_id,
        terminalGeneration: o.terminal_generation,
        ownershipPrincipal: o.ownership_principal,
        agentIncarnation: o.agent_incarnation,
        agentSessionId: o.agent_session_id,
        worktreeId: o.worktree_id,
      },
    }),
    isIdle: async () => true,
    inject: async (_target, text): Promise<InjectResult> => {
      injected.push(text);
      return { outcome: "held", reason: "test" };
    },
    hasMarker: async () => false,
  };

  const policy = createTrustedPolicy({ ...defaultDecisionsSettings(), proxyAllowlisted: true });
  // A gate that would let a proxy answer, named like a design review: the model still never does.
  policy.register({ gateId: "design-review/draft", minRequirement: "proxy-ok", policyVersion: 1 });
  const store = new MemoryLocalStore();
  const proxy = runtime.proxy();
  const bridge = new DecisionsBridge({
    identity,
    keyStore,
    store,
    sink,
    policy,
    learner: runtime.learner,
    ...(proxy ? { proxy } : {}),
    client: new RelayClient({ identity, fetch: fetchImpl, maxRetries: 0 }),
    pumpIntervalMs: 0,
  });

  /** The relay commits an action it was sent (or one it claims), and the inbox takes it. */
  const commit = async (
    questionId: string,
    action: { record: Record<string, unknown>; envelope: unknown },
    kind: "proxy-answer" | "answer",
    status: string
  ) => {
    const row = await store.getQuestion(questionId);
    ledger.push({
      event_type: kind === "answer" ? "decision.answer.committed" : "decision.proxy.committed",
      question_id: questionId,
      question_revision: 1,
      origin_device_id: null,
      data: {
        action: kind,
        record: action.record,
        envelope: action.envelope,
        provenance: kind === "answer" ? "human" : "proxy",
        status,
        revision: 1,
        target_host_id: await hostRef(row!.origin.host_id),
        deliverable: true,
      },
    });
    for (; given < ledger.length; given += 1) {
      const seq = given + 1;
      await bridge.inbox.persist({
        protocol_version: 1,
        seq,
        event_id: `evt_${String(seq).padStart(8, "0")}`,
        occurred_at: new Date().toISOString(),
        ...ledger[given]!,
      } as Parameters<typeof bridge.inbox.persist>[0]);
    }
    await bridge.inbox.processPending();
  };

  /** An action on `questionId`, sealed and signed as `signer` would send it. */
  const signedAction = async (
    questionId: string,
    kind: "answer" | "proxy-answer",
    signer: { deviceId: string; keys: DeviceKeys },
    plaintext: Record<string, unknown>
  ) => {
    const actionId = newId();
    const envelope = await encryptEnvelope({
      epochKey: currentEpochKey(identity),
      installationId: INSTALLATION,
      questionId,
      recordId: actionId,
      recordType: kind,
      revision: 1,
      senderDeviceId: signer.deviceId,
      purpose: "answer-content",
      plaintext,
    });
    return buildSignedAction({
      installationId: INSTALLATION,
      questionId,
      action: kind,
      signerDeviceId: signer.deviceId,
      signingKey: signer.keys.signing.privateKey,
      expectedRevision: 0,
      envelope,
      actionId,
    });
  };

  /** A phone's answer, as the phone app sends it. */
  const phoneAnswer = async (questionId: string, option: string) => {
    const signed = await signedAction(
      questionId,
      "answer",
      { deviceId: PHONE, keys: phoneKeys },
      { content_version: 1, selected_option_ids: [option], reviewed_attachment_digests: [] }
    );
    await commit(questionId, signed, "answer", "human-answered");
  };

  /** A proxy answer this desktop's keys signed, as a relay could claim it committed. */
  const forgedProxyAnswer = async (questionId: string, option: string) => {
    const signed = await signedAction(
      questionId,
      "proxy-answer",
      { deviceId: OWNER, keys: identity.keys },
      {
        content_version: 1,
        selected_option_ids: [option],
        reviewed_attachment_digests: [],
        model_id: "elsewhere",
        prompt_template_version: "1",
        confidence: 0.99,
        retrieval_reference_ids: [],
      }
    );
    await commit(questionId, signed, "proxy-answer", "proxy-answered");
  };

  const ask = async (input: Record<string, unknown>, gate: string | null = null) => {
    const { questionId, requirement } = await bridge.registerQuestion({
      origin: origin(gate),
      input: { kind: "choice", options: OPTIONS, ...input },
    });
    await bridge.pump();
    return { questionId, requirement };
  };

  const sentFor = (questionId: string) =>
    sent.filter((request) => request.path.startsWith(`/api/v1/questions/${questionId}/`));

  return { bridge, store, injected, sent, ask, commit, phoneAnswer, forgedProxyAnswer, sentFor };
}

describe("the decision model through the bridge (#16026)", () => {
  it("answers as a proxy where policy allows, and the answer is typed labelled as one", async () => {
    const { runtime, cli } = await armedRuntime();
    const loop = await bridgeLoop(runtime);
    const calls = cli.calls.length;

    const { questionId, requirement } = await loop.ask({
      question: question(99),
      requested_requirement: "proxy-ok",
    });
    expect(requirement).toBe("proxy-ok");
    expect(cli.calls).toHaveLength(calls + 1);
    const [answer] = loop.sentFor(questionId);
    expect(answer?.path).toBe(`/api/v1/questions/${questionId}/proxy-answer`);
    // Signed by this desktop: the relay and the phone see a desktop's proxy answer, never a person's.
    expect(answer?.body?.action?.record).toMatchObject({
      action: "proxy-answer",
      signer_device_id: OWNER,
    });

    await loop.commit(questionId, answer!.body!.action!, "proxy-answer", "proxy-answered");
    await loop.bridge.pump();

    expect(loop.injected).toHaveLength(1);
    const notice = parseAnswerNotice(loop.injected[0]!);
    expect(notice).not.toBeNull();
    const typed = renderDecisionSection(notice!);
    expect(typed).toContain("source: proxy");
    expect(typed).toContain("choice: rebase");
    const audit = await loop.store.listAudit(100);
    expect(audit).toContainEqual(
      expect.objectContaining({
        event: "proxy.answer",
        question_id: questionId,
        provenance: "proxy",
      })
    );
    expect(audit).toContainEqual(
      expect.objectContaining({
        event: "answer.received",
        question_id: questionId,
        provenance: "proxy",
      })
    );
    // A proxy's answer is never learned from.
    expect(storedExamples()).toHaveLength(PAST);
  });

  it("never asks the model about a human-required question, and a proxy answer can't satisfy one", async () => {
    const { runtime, cli } = await armedRuntime();
    const loop = await bridgeLoop(runtime);
    const calls = cli.calls.length;

    // An agent may always ask for the strictest level, whatever the allowlist lets it have.
    const { questionId, requirement } = await loop.ask({
      question: question(98),
      requested_requirement: "human-required",
    });
    expect(requirement).toBe("human-required");
    expect(cli.calls).toHaveLength(calls);
    expect(loop.sentFor(questionId)).toEqual([]);

    // A relay claiming a proxy answer committed anyway is refused, and nothing is typed.
    await loop.forgedProxyAnswer(questionId, "rebase");
    await loop.bridge.pump();
    expect(await loop.store.listAudit(100)).toContainEqual(
      expect.objectContaining({
        event: "event.rejected",
        question_id: questionId,
        result: "proxy-on-human-required",
      })
    );
    expect((await loop.store.getQuestion(questionId))?.local_status).toBe("open");
    expect(loop.injected).toEqual([]);
  });

  it("abstains under a blocked gate without asking the CLI, which hands the question to the person", async () => {
    const { runtime, cli } = await armedRuntime();
    const loop = await bridgeLoop(runtime);
    const calls = cli.calls.length;

    const { questionId, requirement } = await loop.ask(
      { question: question(97), requested_requirement: "proxy-ok" },
      "design-review/draft"
    );
    expect(requirement).toBe("proxy-ok");
    expect(cli.calls).toHaveLength(calls);
    expect(loop.sentFor(questionId).map((request) => request.path)).toEqual([
      `/api/v1/questions/${questionId}/proxy-abstain`,
    ]);
    expect(await loop.store.listAudit(100)).toContainEqual(
      expect.objectContaining({
        event: "proxy.abstain",
        question_id: questionId,
        result: "blocked-gate",
      })
    );
  });

  it("asks nothing and publishes nothing while unarmed, and learns from the person's answer", async () => {
    const cli = rebasingCli();
    const { runtime } = makeRuntime({ claude: cli });
    await runtime.update({ modelLearning: true, modelAdapter: "claude" });
    const loop = await bridgeLoop(runtime);

    const { questionId } = await loop.ask({
      question: question(96),
      requested_requirement: "proxy-ok",
    });
    expect(cli.calls).toHaveLength(0);
    expect(loop.sentFor(questionId)).toEqual([]);

    await loop.phoneAnswer(questionId, "merge");
    await loop.bridge.pump();
    expect(renderDecisionSection(parseAnswerNotice(loop.injected[0]!)!)).toContain("source: human");
    await runtime.close();
    expect(storedExamples()).toEqual([
      expect.objectContaining({ question_id: questionId, selected_option_ids: ["merge"] }),
    ]);
  });
});
