import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BridgeError,
  MemoryKeyStore,
  MemoryLocalStore,
  PolicyRegistry,
  loadIdentity,
  paneIdentityOf,
  type DecisionsBridge,
  type Identity,
  type QuestionOrigin,
  type StoredIdentity,
} from "@daintreehq/decisions-client";
import {
  generateDeviceKeys,
  generateEpochKeyBytes,
  serializeDeviceKeys,
} from "@daintreehq/decisions-crypto";
import { bytesToBase64Url } from "@daintreehq/decisions-protocol";

vi.mock("electron", () => ({
  net: { isOnline: () => true },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}));

import { QuestionBridge } from "../questionBridge.js";
import type { QuestionSource } from "../relayConnection.js";

const ORIGIN: QuestionOrigin = {
  host_id: "host_a",
  pane_id: "pane-1",
  terminal_generation: 1,
  ownership_principal: "principal-1",
  agent_incarnation: "0",
  agent_kind: "claude",
  agent_session_id: null,
  project_id: "p1",
  worktree_id: "wt-1",
  worktree_root: "/repo",
  workflow_gate_id: null,
};

async function storedIdentity(): Promise<StoredIdentity> {
  return {
    v: 1,
    config: {
      relayOrigin: "https://decisions.example.workers.dev",
      installationId: "inst_12345678",
      deviceId: "dev_12345678",
      label: "Test desktop",
    },
    keys: await serializeDeviceKeys(await generateDeviceKeys(true)),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
    currentEpoch: 1,
  };
}

async function identityOf(stored: StoredIdentity): Promise<Identity> {
  const keys = new MemoryKeyStore();
  await keys.save(stored);
  return loadIdentity(keys);
}

function liveBridge() {
  return {
    registerQuestion: vi.fn(async () => ({
      questionId: "q_live",
      alias: 1,
      requirement: "human-required" as const,
      status: "queued" as const,
      duplicate: false,
    })),
    getDecision: vi.fn(async () => ({ questionId: "q_live" })),
    cancelQuestion: vi.fn(async () => {}),
    listPending: vi.fn(async () => []),
  };
}

describe("QuestionBridge", () => {
  let store: MemoryLocalStore;
  let identity: Identity | null;
  let live: ReturnType<typeof liveBridge> | null;
  let current: boolean;
  let source: QuestionSource;
  let policy: PolicyRegistry;
  let fetches: number;

  beforeEach(async () => {
    store = new MemoryLocalStore();
    identity = await identityOf(await storedIdentity());
    live = null;
    current = true;
    fetches = 0;
    policy = new PolicyRegistry();
    source = {
      identity: () => identity,
      live: () => live as unknown as DecisionsBridge | null,
      store,
      policy,
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetches += 1;
      throw new Error("no network in this test");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function bridge(): QuestionBridge {
    return new QuestionBridge({ source, isCurrent: () => current });
  }

  it("asks, reads and cancels through the live attempt's bridge when there is one", async () => {
    const b = bridge();
    live = liveBridge();
    const pane = paneIdentityOf(ORIGIN);

    await b.registerQuestion({ origin: ORIGIN, input: { question: "Now?" } });
    await b.getDecision("q_live", pane);
    await b.cancelQuestion("q_live", pane);

    expect(live.registerQuestion).toHaveBeenCalledWith({
      origin: ORIGIN,
      input: { question: "Now?" },
    });
    expect(live.getDecision).toHaveBeenCalledWith("q_live", pane);
    expect(live.cancelQuestion).toHaveBeenCalledWith("q_live", pane);
    expect(await store.listQuestions()).toEqual([]);
  });

  it("commits locally between attempts and publishes nothing itself", async () => {
    const b = bridge();
    const result = await b.registerQuestion({ origin: ORIGIN, input: { question: "Later?" } });
    // Anything a pump would do runs on a later turn.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(b.state).toBe("stopped");
    expect(fetches).toBe(0);
    const row = await store.getQuestion(result.questionId);
    expect(row?.origin).toEqual(ORIGIN);
    expect(row?.local_status).toBe("queued");
    expect((await store.outboxFor(result.questionId)).map((item) => item.kind)).toEqual(["create"]);

    // The next attempt's bridge sees the same question.
    live = liveBridge();
    await b.getDecision(result.questionId, paneIdentityOf(ORIGIN));
    expect(live.getDecision).toHaveBeenCalledWith(result.questionId, paneIdentityOf(ORIGIN));
  });

  it("asks under the lifetime's own policy, as the attempts do", async () => {
    const b = bridge();
    const strict = await b.registerQuestion({
      origin: ORIGIN,
      input: { question: "Proxy?", requested_requirement: "proxy-ok" },
    });
    expect(strict.requirement).toBe("human-required");
    // The allowlist changed in Settings reaches the registry every bridge shares.
    policy.proxyAllowlisted = true;
    const allowed = await b.registerQuestion({
      origin: ORIGIN,
      input: { question: "Proxy now?", requested_requirement: "proxy-ok" },
    });
    expect(allowed.requirement).toBe("proxy-ok");
  });

  it("asks under the identity the attempts last held", async () => {
    const b = bridge();
    const rotated = await identityOf(await storedIdentity());
    identity = rotated;
    await b.registerQuestion({ origin: ORIGIN, input: { question: "Rotated?" } });
    expect(b.ctx.identity).toBe(rotated);
  });

  it("never falls back to itself once the connection has ended, as after a revocation", async () => {
    const b = bridge();
    identity = null;
    await expect(
      b.registerQuestion({ origin: ORIGIN, input: { question: "Still?" } })
    ).rejects.toThrow(BridgeError);
    await expect(b.getDecision("q_any", paneIdentityOf(ORIGIN))).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await store.listQuestions()).toEqual([]);
  });

  it("refuses a pane that is no longer the run it was let in as, and a call with no pane", async () => {
    const b = bridge();
    live = liveBridge();
    current = false;
    await expect(
      b.registerQuestion({ origin: ORIGIN, input: { question: "Mine?" } })
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(b.cancelQuestion("q_live", paneIdentityOf(ORIGIN))).rejects.toMatchObject({
      code: "forbidden",
    });
    current = true;
    await expect(b.getDecision("q_live")).rejects.toMatchObject({ code: "not_found" });
    expect(live.registerQuestion).not.toHaveBeenCalled();
    expect(live.cancelQuestion).not.toHaveBeenCalled();
    expect(live.getDecision).not.toHaveBeenCalled();
  });

  it("runs asks one at a time, so a refused one doesn't hold up the next", async () => {
    const b = bridge();
    live = liveBridge();
    let release!: () => void;
    live.registerQuestion.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          release = () => reject(new BridgeError("validation_error", "bad"));
        })
    );
    const first = b.registerQuestion({ origin: ORIGIN, input: { question: "One?" } });
    const second = b.registerQuestion({ origin: ORIGIN, input: { question: "Two?" } });
    await vi.waitFor(() => expect(live!.registerQuestion).toHaveBeenCalledTimes(1));
    release();
    await expect(first).rejects.toThrow("bad");
    await expect(second).resolves.toMatchObject({ questionId: "q_live" });
    expect(live.registerQuestion).toHaveBeenCalledTimes(2);
  });
  it("takes a session learned since a question was asked as that run's, and no other session", async () => {
    const b = bridge();
    const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Before?" } });
    const learned = { ...paneIdentityOf(ORIGIN), agent_session_id: "session-9" };
    await expect(b.getDecision(asked.questionId, learned)).resolves.toMatchObject({
      questionId: asked.questionId,
    });

    const known = await b.registerQuestion({
      origin: { ...ORIGIN, agent_session_id: "session-1" },
      input: { question: "Known?" },
    });
    await expect(
      b.getDecision(known.questionId, { ...paneIdentityOf(ORIGIN), agent_session_id: "session-2" })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(b.cancelQuestion(asked.questionId, learned)).resolves.toBeUndefined();
    expect((await store.getQuestion(asked.questionId))?.local_status).toBe("cancelled");
  });

  it("keeps a question's create for a live attempt's flush to send, and has a real cancel follow it", async () => {
    const b = bridge();
    const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Cancel me?" } });
    live = liveBridge();
    const pane = paneIdentityOf(ORIGIN);

    await b.cancelQuestion(asked.questionId, pane);

    const [create] = await store.outboxFor(asked.questionId);
    expect(create?.kind).toBe("create");
    expect((create?.payload as { maybePublished?: boolean }).maybePublished).toBe(true);
    expect(live.cancelQuestion).toHaveBeenCalledWith(asked.questionId, pane);
  });

  it("marks the create in place when the store can, never writing back a copy it read", async () => {
    const marks: string[] = [];
    const putOutbox = vi.spyOn(store, "putOutbox");
    source = {
      ...source,
      store: Object.assign(store, {
        markCreateMaybePublished: async (questionId: string) => {
          marks.push(questionId);
          return true;
        },
      }),
    };
    const b = bridge();
    const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Cancel me?" } });
    live = liveBridge();
    putOutbox.mockClear();

    await b.cancelQuestion(asked.questionId, paneIdentityOf(ORIGIN));

    expect(marks).toEqual([asked.questionId]);
    expect(putOutbox).not.toHaveBeenCalled();
    expect(live.cancelQuestion).toHaveBeenCalledTimes(1);
  });

  it("asks through the lifetime's attachments: its gate, and its resolver and spool when offline", async () => {
    const order: string[] = [];
    const resolver = { resolve: vi.fn(async () => null) };
    const spool = { put: vi.fn(), get: vi.fn(), delete: vi.fn() };
    source = {
      ...source,
      attachments: {
        resolver,
        spool,
        register: async <T>(ask: () => Promise<T>) => {
          order.push("gate:start");
          try {
            return await ask();
          } finally {
            order.push("gate:end");
          }
        },
      },
    };
    const b = bridge();
    expect(b.ctx.resolver).toBe(resolver);
    expect(b.ctx.spool).toBe(spool);

    await b.registerQuestion({ origin: ORIGIN, input: { question: "Offline?" } });
    live = liveBridge();
    live.registerQuestion.mockImplementationOnce(async () => {
      order.push("live");
      return {
        questionId: "q_live",
        alias: 2,
        requirement: "human-required" as const,
        status: "queued" as const,
        duplicate: false,
      };
    });
    await b.registerQuestion({ origin: ORIGIN, input: { question: "Live?" } });

    expect(order).toEqual(["gate:start", "gate:end", "gate:start", "live", "gate:end"]);
  });

  it("touches nothing for a cancel the live attempt finds isn't the pane's", async () => {
    const b = bridge();
    const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Theirs?" } });
    live = liveBridge();
    live.getDecision.mockRejectedValueOnce(new BridgeError("not_found", "unknown question"));
    const other = { ...paneIdentityOf(ORIGIN), pane_id: "pane-2" };

    await expect(b.cancelQuestion(asked.questionId, other)).rejects.toMatchObject({
      code: "not_found",
    });
    const [create] = await store.outboxFor(asked.questionId);
    expect((create?.payload as { maybePublished?: boolean }).maybePublished).toBeUndefined();
    expect(live.cancelQuestion).not.toHaveBeenCalled();
  });

  it("checks a queued ask's pane when its turn comes, not when it was queued", async () => {
    const b = bridge();
    live = liveBridge();
    let release!: () => void;
    live.registerQuestion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              questionId: "q_first",
              alias: 1,
              requirement: "human-required",
              status: "queued",
              duplicate: false,
            });
        })
    );
    const first = b.registerQuestion({ origin: ORIGIN, input: { question: "One?" } });
    const second = b.registerQuestion({ origin: ORIGIN, input: { question: "Two?" } });
    await vi.waitFor(() => expect(live!.registerQuestion).toHaveBeenCalledTimes(1));
    current = false;
    release();
    await expect(first).resolves.toMatchObject({ questionId: "q_first" });
    await expect(second).rejects.toMatchObject({ code: "forbidden" });
    expect(live.registerQuestion).toHaveBeenCalledTimes(1);
  });

  it("can't be made over a connection that has already ended", () => {
    identity = null;
    expect(() => bridge()).toThrow();
  });
});
