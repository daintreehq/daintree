import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionsRelayCheck,
  DecisionsSetupCheckRun,
  DecisionsSetupCheckStep,
} from "../../../../shared/types/decisions.js";

vi.mock("electron", () => ({
  net: { isOnline: () => true },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}));

const relay = vi.hoisted(() => ({
  devices: vi.fn(),
  pushConfig: vi.fn(),
  downloadAttachment: vi.fn(),
  verifiedDevices: vi.fn(),
  recognises: vi.fn(),
}));

vi.mock("@daintreehq/decisions-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@daintreehq/decisions-client")>();
  // Only the check's own signed client is faked; the bridge keeps the library's.
  class RelayClient {
    devices = relay.devices;
    pushConfig = relay.pushConfig;
    downloadAttachment = relay.downloadAttachment;
  }
  return { ...actual, RelayClient, verifiedDevices: relay.verifiedDevices };
});

vi.mock("../relayIdentity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../relayIdentity.js")>();
  return {
    ...actual,
    relayRequests: vi.fn(async () => ({ fetch: vi.fn(), lastFailure: () => null })),
    relayRecognises: (...args: unknown[]) => relay.recognises(...args),
  };
});

import {
  MemoryKeyStore,
  MemoryLocalStore,
  MemorySpool,
  PolicyRegistry,
  RelayError,
  batchNotices,
  formatAnswerNotice,
  loadIdentity,
  targetOf,
  type Identity,
  type StoredIdentity,
} from "@daintreehq/decisions-client";
import {
  generateDeviceKeys,
  generateEpochKeyBytes,
  serializeDeviceKeys,
} from "@daintreehq/decisions-crypto";
import { bytesToBase64Url } from "@daintreehq/decisions-protocol";
import type { QuestionSource } from "../relayConnection.js";
import { SetupCheck, type SetupCheckDeps, type SetupCheckStatus } from "../setupCheck.js";
import { SETUP_CHECK_IMAGE, SetupDiagnostics } from "../setupDiagnostic.js";

const ORIGIN = "https://decisions.example.workers.dev";
const RELAY = {
  relayOrigin: ORIGIN,
  installationId: "inst_12345678",
  deviceId: "dev_12345678",
  hostId: "host_12345678",
};
const CLAIMED: DecisionsRelayCheck = {
  result: "claimed",
  origin: ORIGIN,
  compatibility: {
    relay: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
    daintree: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
    diverges: false,
  },
};

async function ownerIdentity(): Promise<Identity> {
  const stored: StoredIdentity = {
    v: 1,
    config: {
      relayOrigin: ORIGIN,
      installationId: RELAY.installationId,
      deviceId: RELAY.deviceId,
      label: "Test desktop",
    },
    keys: await serializeDeviceKeys(await generateDeviceKeys(true)),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
    currentEpoch: 1,
  };
  const keys = new MemoryKeyStore();
  await keys.save(stored);
  return loadIdentity(keys);
}

function phone(id: string, pushEnabled: boolean) {
  return {
    device_id: id,
    revoked_at: null,
    push_enabled: pushEnabled,
    cert: { role: "phone" },
  };
}

interface Harness {
  check: SetupCheck;
  store: MemoryLocalStore;
  spool: MemorySpool;
  diagnostics: SetupDiagnostics;
  runs: DecisionsSetupCheckRun[];
  refresh: ReturnType<typeof vi.fn>;
  /** Tells the check a store write committed. */
  commit(): void;
  /** Resolves once `step` reports `running`. */
  reached(step: DecisionsSetupCheckStep): Promise<void>;
  /** The test question as the store holds it. */
  question(): Promise<NonNullable<Awaited<ReturnType<MemoryLocalStore["getQuestion"]>>>>;
}

async function harness(
  overrides: Partial<SetupCheckDeps> = {},
  /** Another image than the check's own, for its diagnostic origin to attach. */
  image?: Uint8Array
): Promise<Harness & { identity: Identity }> {
  const identity = await ownerIdentity();
  const store = new MemoryLocalStore();
  const spool = new MemorySpool();
  const diagnostics = new SetupDiagnostics();
  const source: QuestionSource = {
    identity: () => identity,
    // No live attempt: the question is committed locally, as between attempts.
    live: () => null,
    store,
    policy: new PolicyRegistry(),
    attachments: {
      resolver: image
        ? {
            resolve: async (origin) =>
              diagnostics.handles(origin.pane_id) ? { bytes: new Uint8Array(image) } : null,
          }
        : diagnostics.attachmentResolver({ resolve: async () => null }),
      spool,
      register: (ask) => ask(),
    },
  };
  const commits = new Set<() => void>();
  const statusListeners = new Set<(status: SetupCheckStatus) => void>();
  let status: SetupCheckStatus = { state: "connected" };
  const emit = (next: SetupCheckStatus) => {
    status = next;
    for (const listener of [...statusListeners]) listener(next);
  };
  const refresh = vi.fn(() => {
    emit({ state: "connecting" });
    queueMicrotask(() => emit({ state: "connected" }));
    return true;
  });
  const runs: DecisionsSetupCheckRun[] = [];
  const waiters: Array<() => void> = [];
  let revision = 0;
  const check = new SetupCheck(
    {
      relay: RELAY,
      checkRelay: async () => CLAIMED,
      questionSource: () => source,
      refreshConnection: refresh,
      status: () => status,
      onStatus: (listener) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      onCommit: (listener) => {
        commits.add(listener);
        return () => commits.delete(listener);
      },
      diagnostics,
      nextRevision: () => ++revision,
      timeouts: { publishMs: 2_000, answerMs: 2_000, socketMs: 2_000, pollMs: 20 },
      ...overrides,
    },
    (run) => {
      runs.push(run);
      for (const wake of waiters.splice(0)) wake();
    }
  );
  return {
    identity,
    check,
    store,
    spool,
    diagnostics,
    runs,
    refresh,
    commit: () => {
      for (const listener of [...commits]) listener();
    },
    reached: (step) =>
      new Promise<void>((resolve) => {
        const look = () => {
          if (runs.at(-1)?.steps[step].state === "running") resolve();
          else waiters.push(look);
        };
        look();
      }),
    question: async () => {
      const [row] = await store.listQuestions();
      expect(row).toBeDefined();
      return row!;
    },
  };
}

/** Marks the test question published, as the relay's answer to its create does. */
async function publish(h: Harness): Promise<string> {
  await h.reached("attachment");
  await vi.waitFor(async () => {
    expect(await h.store.listQuestions()).toHaveLength(1);
  });
  const row = await h.question();
  await h.store.updateQuestion(row.question_id, { local_status: "open" });
  h.commit();
  return row.question_id;
}

/** A person's answer, as delivery types it into the diagnostic terminal. */
async function typeAnswer(h: Harness, questionId: string): Promise<void> {
  await h.reached("question");
  const row = await h.question();
  const injectionId = "inj_0123456789abcdef";
  const text = batchNotices(
    [
      formatAnswerNotice({
        kind: "answer",
        questionId,
        alias: row.alias,
        revision: 1,
        source: "human",
        choices: [{ id: "received", label: "Received" }],
        injectionId,
      }),
    ],
    Number.MAX_SAFE_INTEGER
  )[0]!;
  const typed = await h.diagnostics.sink.inject(targetOf(row.origin), text, injectionId);
  expect(typed.outcome).toBe("delivered");
}

/** A person's answer, typed by delivery into the diagnostic terminal and recorded. */
async function answer(h: Harness, questionId: string): Promise<void> {
  await typeAnswer(h, questionId);
  await h.store.updateQuestion(questionId, {
    local_status: "human-answered",
    delivery_status: "terminal-delivered",
  });
  h.commit();
}

describe("SetupCheck", () => {
  beforeEach(() => {
    relay.devices.mockReset().mockResolvedValue({ owner_device_id: RELAY.deviceId, devices: [] });
    relay.recognises.mockReset().mockReturnValue(true);
    relay.pushConfig.mockReset().mockResolvedValue({ vapid_public_key: "BPublicKey" });
    relay.verifiedDevices.mockReset().mockResolvedValue([phone("dev_phone_1", true)]);
    relay.downloadAttachment.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes every step once the phone's answer is typed into the diagnostic terminal, which then closes", async () => {
    const h = await harness();
    relay.downloadAttachment.mockImplementation(async (id: string) => h.spool.get(id));
    const done = h.check.start();

    const questionId = await publish(h);
    // The terminal is shown while the question waits.
    expect(h.runs.at(-1)!.diagnostic?.title).toMatch(/runs no agent/);
    await answer(h, questionId);
    const run = await done;

    expect(run.state).toBe("passed");
    expect(h.check.failedStep()).toBeNull();
    for (const step of ["relay", "claim", "socket", "push", "attachment"] as const) {
      expect(run.steps[step].state, step).toBe("passed");
    }
    expect(run.steps.attachment).toEqual({
      state: "passed",
      observation: { result: "matched", bytes: SETUP_CHECK_IMAGE.length },
    });
    expect(run.steps.push).toEqual({
      state: "passed",
      observation: { result: "configured", phones: 1, pushEnabled: 1 },
    });
    const question = run.steps.question;
    expect(question.state).toBe("passed");
    expect(question.state === "passed" && question.observation.result === "typed").toBe(true);
    if (question.state === "passed" && question.observation.result === "typed") {
      expect(question.observation.text).toContain("choice_label: Received");
    }
    // The relay's own device list was judged against the connection's identity.
    expect(relay.recognises).toHaveBeenCalledExactlyOnceWith(
      { owner_device_id: RELAY.deviceId, devices: [] },
      h.identity
    );
    // A fresh attempt was asked for, and the question was asked as a person's to answer.
    expect(h.refresh).toHaveBeenCalledOnce();
    const row = await h.question();
    expect(row.requirement).toBe("human-required");
    expect(row.attachment_digests).toHaveLength(1);
    expect(row.origin.pane_id.startsWith("daintree-decisions-check-")).toBe(true);
    // Answered, so nothing is cancelled; the terminal closed with the run.
    expect((await h.store.outboxFor(questionId)).some((item) => item.kind === "cancel")).toBe(
      false
    );
    expect(run.diagnostic).toBeNull();
    expect(h.diagnostics.isCurrent({ ...row.origin })).toBe(false);
  });

  it("passes on what delivery did, though a late create receipt set the row back to open", async () => {
    const h = await harness();
    relay.downloadAttachment.mockImplementation(async (id: string) => h.spool.get(id));
    const done = h.check.start();
    const questionId = await publish(h);

    await typeAnswer(h, questionId);
    // The library writes `open` on every create receipt, even after an answer arrived.
    await h.store.updateQuestion(questionId, {
      local_status: "open",
      delivery_status: "terminal-delivered",
    });
    h.commit();

    expect((await done).steps.question.state).toBe("passed");
  });

  it("doesn't pass on a delivery recorded without the answer typed here, or typing never recorded", async () => {
    let h = await harness({ timeouts: { answerMs: 120, pollMs: 20 } });
    relay.downloadAttachment.mockImplementation(async (id: string) => h.spool.get(id));
    let done = h.check.start();
    let questionId = await publish(h);
    await h.reached("question");
    await h.store.updateQuestion(questionId, {
      local_status: "human-answered",
      delivery_status: "terminal-delivered",
    });
    h.commit();
    expect((await done).steps.question.state).toBe("failed");

    h = await harness({ timeouts: { answerMs: 120, pollMs: 20 } });
    relay.downloadAttachment.mockImplementation(async (id: string) => h.spool.get(id));
    done = h.check.start();
    questionId = await publish(h);
    await typeAnswer(h, questionId);
    expect((await done).steps.question).toEqual({
      state: "failed",
      observation: { result: "not-answered" },
    });
  });

  it("stops at the first step that fails, naming it, and runs nothing after it", async () => {
    const h = await harness({
      checkRelay: async () => ({ ...CLAIMED, result: "unclaimed" }) as DecisionsRelayCheck,
    });

    const run = await h.check.start();

    expect(run.state).toBe("failed");
    expect(h.check.failedStep()).toBe("relay");
    expect(run.steps.relay.state).toBe("failed");
    for (const step of ["claim", "socket", "push", "attachment", "question"] as const) {
      expect(run.steps[step].state, step).toBe("skipped");
    }
    expect(relay.devices).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(await h.store.listQuestions()).toHaveLength(0);
  });

  it("fails the claim when the relay lists another owner, or refuses this computer", async () => {
    relay.recognises.mockReturnValue(false);
    let run = await (await harness()).check.start();
    expect(run.steps.claim).toEqual({
      state: "failed",
      observation: { result: "not-recognised" },
    });

    relay.recognises.mockReturnValue(true);
    relay.devices.mockRejectedValue(new RelayError("not_authenticated", "no", 401));
    run = await (await harness()).check.start();
    expect(run.steps.claim).toEqual({
      state: "failed",
      observation: { result: "refused", origin: ORIGIN, reason: "not-recognised" },
    });
    expect(run.steps.socket.state).toBe("skipped");
  });

  it("fails the claim without the connection's identity, signing nothing", async () => {
    const h = await harness({ questionSource: () => null });

    const run = await h.check.start();

    expect(run.steps.claim).toEqual({ state: "failed", observation: { result: "not-set-up" } });
    expect(relay.devices).not.toHaveBeenCalled();
  });

  it("reports what a fresh attempt saw, and never a connection it couldn't refresh as connected", async () => {
    let h = await harness({
      refreshConnection: () => false,
      status: () => ({ state: "replaced" }),
    });
    let run = await h.check.start();
    expect(run.steps.socket).toEqual({ state: "failed", observation: { result: "replaced" } });

    h = await harness({
      refreshConnection: () => false,
      status: () => ({ state: "connected" }),
    });
    run = await h.check.start();
    expect(run.steps.socket).toEqual({
      state: "failed",
      observation: { result: "not-connected" },
    });
  });

  it("fails the socket step when the fresh attempt closes, or hears nothing in time", async () => {
    const listeners = new Set<(status: SetupCheckStatus) => void>();
    const onStatus: SetupCheckDeps["onStatus"] = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    let h = await harness({
      onStatus,
      refreshConnection: () => {
        queueMicrotask(() => {
          for (const listener of listeners) listener({ state: "reconnecting" });
        });
        return true;
      },
    });
    let run = await h.check.start();
    expect(run.steps.socket).toEqual({ state: "failed", observation: { result: "no-hello" } });

    h = await harness({
      onStatus,
      refreshConnection: () => true,
      timeouts: { socketMs: 30, pollMs: 20 },
    });
    run = await h.check.start();
    expect(run.steps.socket).toEqual({ state: "failed", observation: { result: "no-hello" } });
  });

  it.each([
    ["no phone is paired", [], { result: "no-phone" }],
    [
      "no paired phone has notifications on",
      [phone("dev_phone_1", false), phone("dev_phone_2", false)],
      { result: "push-off", phones: 2 },
    ],
  ])("fails the push step when %s", async (_label, devices, observation) => {
    relay.verifiedDevices.mockResolvedValue(devices);
    const h = await harness();

    const run = await h.check.start();

    expect(run.steps.push).toEqual({ state: "failed", observation });
    expect(await h.store.listQuestions()).toHaveLength(0);
  });

  it("fails the push step without a push key, and counts only unrevoked phones", async () => {
    relay.pushConfig.mockResolvedValue({ vapid_public_key: "" });
    let run = await (await harness()).check.start();
    expect(run.steps.push).toEqual({ state: "failed", observation: { result: "no-push-key" } });

    relay.pushConfig.mockResolvedValue({ vapid_public_key: "BPublicKey" });
    relay.verifiedDevices.mockResolvedValue([
      phone("dev_phone_1", true),
      { ...phone("dev_phone_2", true), revoked_at: "2026-11-01T00:00:00.000Z" },
      { ...phone(RELAY.deviceId, true), cert: { role: "owner-desktop" } },
      { ...phone("dev_host_1", true), cert: { role: "desktop-host" } },
    ]);
    const h = await harness();
    relay.downloadAttachment.mockImplementation(async (id: string) => h.spool.get(id));
    const done = h.check.start();
    await h.reached("attachment");
    run = h.runs.at(-1)!;
    expect(run.steps.push).toEqual({
      state: "passed",
      observation: { result: "configured", phones: 1, pushEnabled: 1 },
    });
    await h.check.cancel();
    await done;
  });

  it("fails the attachment step when what comes back doesn't decrypt to the image, and cancels the question", async () => {
    const h = await harness();
    relay.downloadAttachment.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    const done = h.check.start();

    const questionId = await publish(h);
    const run = await done;

    expect(run.steps.attachment).toEqual({ state: "failed", observation: { result: "mismatch" } });
    expect(run.steps.question.state).toBe("skipped");
    expect((await h.store.outboxFor(questionId)).some((item) => item.kind === "cancel")).toBe(true);
    expect(run.diagnostic).toBeNull();
  });

  it("fails the attachment step when the image decrypts to another than the one sent", async () => {
    // Other bytes behind the same PNG signature: they decrypt cleanly, so only the comparison can catch them.
    const other = new Uint8Array(SETUP_CHECK_IMAGE);
    other[other.length - 13] ^= 0xff;
    const h = await harness({}, other);
    relay.downloadAttachment.mockImplementation(async (id: string) => h.spool.get(id));
    const done = h.check.start();

    const questionId = await publish(h);
    const run = await done;

    expect(run.steps.attachment).toEqual({ state: "failed", observation: { result: "mismatch" } });
    expect(run.steps.question.state).toBe("skipped");
    expect((await h.store.outboxFor(questionId)).some((item) => item.kind === "cancel")).toBe(true);
  });

  it("fails the attachment step when the relay doesn't take the question in time", async () => {
    const h = await harness({ timeouts: { publishMs: 60, pollMs: 20 } });

    const run = await h.check.start();

    expect(run.steps.attachment).toEqual({
      state: "failed",
      observation: { result: "not-published" },
    });
    // Never sent, so the cancel drops it here.
    expect((await h.question()).local_status).toBe("cancelled");
  });

  it("fails the question step when no answer comes in time, and cancels the question", async () => {
    const h = await harness({ timeouts: { answerMs: 80, pollMs: 20 } });
    relay.downloadAttachment.mockImplementation(async (id: string) => h.spool.get(id));
    const done = h.check.start();

    const questionId = await publish(h);
    const run = await done;

    expect(run.state).toBe("failed");
    expect(h.check.failedStep()).toBe("question");
    expect(run.steps.question).toEqual({
      state: "failed",
      observation: { result: "not-answered" },
    });
    expect((await h.store.outboxFor(questionId)).some((item) => item.kind === "cancel")).toBe(true);
  });

  it("fails the question step when the question expires", async () => {
    const h = await harness();
    relay.downloadAttachment.mockImplementation(async (id: string) => h.spool.get(id));
    const done = h.check.start();

    const questionId = await publish(h);
    await h.reached("question");
    await h.store.updateQuestion(questionId, { local_status: "expired" });
    h.commit();
    const run = await done;

    expect(run.steps.question).toEqual({ state: "failed", observation: { result: "expired" } });
  });

  it("is cancelled while waiting on the phone, closing the terminal and cancelling the question", async () => {
    const h = await harness();
    relay.downloadAttachment.mockImplementation(async (id: string) => h.spool.get(id));
    const done = h.check.start();
    const questionId = await publish(h);
    await h.reached("question");

    const run = await h.check.cancel();

    expect(await done).toEqual(run);
    expect(run.state).toBe("cancelled");
    expect(h.check.failedStep()).toBeNull();
    expect(run.steps.question.state).toBe("skipped");
    expect(run.diagnostic).toBeNull();
    expect((await h.store.outboxFor(questionId)).some((item) => item.kind === "cancel")).toBe(true);
  });

  it("reports an error nobody foresaw as the step's own, never its text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    relay.pushConfig.mockRejectedValue(new TypeError("https://secret.example/ticket=abc"));
    const run = await (await harness()).check.start();

    expect(run.steps.push).toEqual({ state: "failed", observation: { result: "unexpected" } });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    warn.mockRestore();
  });

  it("raises its revision with every change it reports", async () => {
    const h = await harness({
      checkRelay: async () => ({ ...CLAIMED, result: "unclaimed" }) as DecisionsRelayCheck,
    });

    await h.check.start();

    const revisions = h.runs.map((run) => run.revision);
    expect(revisions.length).toBeGreaterThan(1);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
    expect(new Set(revisions).size).toBe(revisions.length);
  });
});
