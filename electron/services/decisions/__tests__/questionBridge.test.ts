import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BridgeError,
  INVOLVEMENT_META,
  MemoryKeyStore,
  MemoryLocalStore,
  PolicyRegistry,
  loadIdentity,
  paneIdentityOf,
  type DecisionsBridge,
  type Identity,
  type InvolvementView,
  type QuestionOrigin,
  type StoredIdentity,
} from "@daintreehq/decisions-client";
import {
  buildSignedInvolvement,
  decryptEnvelope,
  generateDeviceKeys,
  generateEpochKeyBytes,
  serializeDeviceKeys,
  verifyRecordAndEnvelope,
} from "@daintreehq/decisions-crypto";
import { MESSAGE_RECORD_TYPE, bytesToBase64Url } from "@daintreehq/decisions-protocol";

vi.mock("electron", () => ({
  net: { isOnline: () => true },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}));

import { QuestionBridge } from "../questionBridge.js";
import { RetiredAttemptError } from "../relayTransport.js";
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
    postMessage: vi.fn(async () => ({
      questionId: "q_live",
      messageId: "m_live",
      alias: 1,
      status: "queued" as const,
      expectsReply: true,
    })),
    listPending: vi.fn(async () => []),
    answerQuestion: vi.fn(async (input: { questionId: string; expectedRevision: number }) => ({
      answerId: "answer_live_0001",
      questionId: input.questionId,
      expectedRevision: input.expectedRevision,
      status: "sent" as const,
    })),
    getAnswerResult: vi.fn(async (answerId: string) => ({
      answerId,
      questionId: "q_live",
      expectedRevision: 0,
      status: "already-answered" as const,
    })),
    declineQuestion: vi.fn(
      async (input: { questionId: string; expectedRevision: number; declineId?: string }) => ({
        declineId: input.declineId ?? "decline_live_0001",
        questionId: input.questionId,
        expectedRevision: input.expectedRevision,
        status: "declined" as const,
      })
    ),
    getDeclineResult: vi.fn(async (declineId: string) => ({
      declineId,
      questionId: "q_live",
      expectedRevision: 0,
      status: "unsupported" as const,
      by: "asking-desktop" as const,
    })),
    sendFollowUp: vi.fn(async (input: { questionId: string; messageId?: string }) => ({
      messageId: input.messageId ?? "message_live_0001",
      questionId: input.questionId,
      status: "sent" as const,
    })),
    getFollowUpResult: vi.fn(async (messageId: string) => ({
      messageId,
      questionId: "q_live",
      status: "sent" as const,
    })),
    getInvolvement: vi.fn(async (): Promise<InvolvementView> => ({
      status: "available",
      mode: "recommend",
      normalMode: "recommend",
      consultCount: 2,
      revision: 3,
      overrideActive: false,
      until: null,
      setAt: "2026-11-17T09:00:00.000Z",
      lastSyncedAt: "2026-11-17T09:00:05.000Z",
      stale: false,
    })),
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

  it("posts a follow-up through the live attempt's bridge, for the pane that called", async () => {
    const b = bridge();
    live = liveBridge();
    const pane = paneIdentityOf(ORIGIN);
    const followUp = { question_id: "q_live", text: "And then?", expects_reply: true };

    await expect(b.postMessage(followUp, pane)).resolves.toMatchObject({ messageId: "m_live" });

    expect(live.postMessage).toHaveBeenCalledWith(followUp, pane);
    expect(fetches).toBe(0);
  });

  it("commits a follow-up between attempts, sealed and signed, for the next attempt to publish after its question", async () => {
    const b = bridge();
    const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Later?" } });
    const followUp = { question_id: asked.questionId, text: "And then?", expects_reply: true };

    const posted = await b.postMessage(followUp, paneIdentityOf(ORIGIN));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(posted).toMatchObject({
      questionId: asked.questionId,
      alias: asked.alias,
      status: "queued",
      expectsReply: true,
    });
    expect(b.state).toBe("stopped");
    expect(fetches).toBe(0);
    const outbox = await store.outboxFor(asked.questionId);
    expect(outbox.map((item) => item.kind)).toEqual(["create", "message"]);
    const { signed } = outbox[1]!.payload as {
      signed: { record: Record<string, unknown>; envelope: Record<string, unknown> };
    };
    expect(
      await verifyRecordAndEnvelope(
        signed.record,
        signed.envelope as never,
        identity!.keys.signing.publicKey
      )
    ).toBe(true);
    expect(signed.record).toMatchObject({
      question_id: asked.questionId,
      message_id: posted.messageId,
      side: "agent",
      expects_reply: true,
      signer_device_id: identity!.config.deviceId,
    });
    expect(JSON.stringify(outbox[1]!.payload)).not.toContain("And then?");
    // A message never touches the question it follows up.
    expect(await store.getQuestion(asked.questionId)).toMatchObject({
      local_status: "queued",
      messages_json: "[]",
    });
  });

  it("refuses a follow-up on another pane's question or an unknown one alike, and from a pane no longer current", async () => {
    const b = bridge();
    const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Mine?" } });
    const followUp = { question_id: asked.questionId, text: "Mine too?", expects_reply: false };
    const other = { ...paneIdentityOf(ORIGIN), pane_id: "pane-2" };
    const relaunched = { ...paneIdentityOf(ORIGIN), ownership_principal: "principal-2" };

    for (const pane of [other, relaunched]) {
      await expect(b.postMessage(followUp, pane)).rejects.toMatchObject({
        code: "not_found",
        message: "unknown question",
      });
    }
    await expect(
      b.postMessage({ ...followUp, question_id: "q_unknown" }, paneIdentityOf(ORIGIN))
    ).rejects.toMatchObject({ code: "not_found", message: "unknown question" });
    for (const malformed of [
      { ...followUp, text: "   " },
      { ...followUp, question_id: 7 },
      { question_id: asked.questionId, text: "No flag" },
      null,
    ]) {
      await expect(b.postMessage(malformed, paneIdentityOf(ORIGIN))).rejects.toMatchObject({
        code: "validation_error",
      });
    }
    current = false;
    await expect(b.postMessage(followUp, paneIdentityOf(ORIGIN))).rejects.toMatchObject({
      code: "forbidden",
    });
    current = true;
    live = liveBridge();
    current = false;
    await expect(b.postMessage(followUp, paneIdentityOf(ORIGIN))).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(live.postMessage).not.toHaveBeenCalled();
    expect((await store.outboxFor(asked.questionId)).map((item) => item.kind)).toEqual(["create"]);
  });

  it("finishes a post committed between attempts before the next goes to an attempt just live", async () => {
    const b = bridge();
    const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Handover?" } });
    const pane = paneIdentityOf(ORIGIN);
    const order: string[] = [];
    let commit!: () => void;
    const putOutbox = store.putOutbox.bind(store);
    vi.spyOn(store, "putOutbox").mockImplementation(async (item) => {
      if (item.kind === "message") {
        await new Promise<void>((resolve) => (commit = resolve));
        order.push("offline");
      }
      return putOutbox(item);
    });

    const offline = b.postMessage(
      { question_id: asked.questionId, text: "First", expects_reply: false },
      pane
    );
    await vi.waitFor(() => expect(commit).toBeTypeOf("function"));
    live = liveBridge();
    live.postMessage.mockImplementation(async () => {
      order.push("live");
      return {
        questionId: asked.questionId,
        messageId: "m_live",
        alias: asked.alias,
        status: "queued",
        expectsReply: true,
      };
    });
    const online = b.postMessage(
      { question_id: asked.questionId, text: "Second", expects_reply: true },
      pane
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(live.postMessage).not.toHaveBeenCalled();

    commit();
    await expect(offline).resolves.toMatchObject({ questionId: asked.questionId });
    await expect(online).resolves.toMatchObject({ messageId: "m_live" });
    expect(order).toEqual(["offline", "live"]);
  });

  it("picks a post's bridge, and checks its pane, once the asker has been read", async () => {
    const b = bridge();
    const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Learned?" } });
    // A session learned since the question was asked: the asker is read from the store first.
    const learned = { ...paneIdentityOf(ORIGIN), agent_session_id: "session-9" };
    const followUp = { question_id: asked.questionId, text: "Now?", expects_reply: false };
    const getQuestion = store.getQuestion.bind(store);
    const holdRead = () => {
      let release!: () => void;
      vi.spyOn(store, "getQuestion").mockImplementationOnce(async (id) => {
        await new Promise<void>((resolve) => (release = resolve));
        return getQuestion(id);
      });
      return () => release();
    };

    // An attempt goes live while the asker is read: the post goes to it, as the question's asker.
    let release = holdRead();
    const toLive = b.postMessage(followUp, learned);
    await vi.waitFor(() => expect(store.getQuestion).toHaveBeenCalled());
    live = liveBridge();
    release();
    await expect(toLive).resolves.toMatchObject({ messageId: "m_live" });
    expect(live.postMessage).toHaveBeenCalledWith(followUp, paneIdentityOf(ORIGIN));

    // The pane stops being the run it was while the asker is read: nothing is posted or committed.
    vi.mocked(store.getQuestion).mockClear();
    live = null;
    release = holdRead();
    const revoked = b.postMessage(followUp, learned);
    await vi.waitFor(() => expect(store.getQuestion).toHaveBeenCalled());
    current = false;
    release();
    await expect(revoked).rejects.toMatchObject({ code: "forbidden" });
    expect((await store.outboxFor(asked.questionId)).map((item) => item.kind)).toEqual(["create"]);
  });

  it("runs posts one at a time, checking each pane when its turn comes", async () => {
    const b = bridge();
    live = liveBridge();
    let release!: () => void;
    live.postMessage.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          release = () => reject(new BridgeError("invalid_state", "q-1 was cancelled"));
        })
    );
    const pane = paneIdentityOf(ORIGIN);
    const first = b.postMessage({ question_id: "q_live", text: "One", expects_reply: false }, pane);
    const second = b.postMessage({ question_id: "q_live", text: "Two", expects_reply: true }, pane);
    await vi.waitFor(() => expect(live!.postMessage).toHaveBeenCalledTimes(1));
    release();
    await expect(first).rejects.toMatchObject({ code: "invalid_state" });
    await expect(second).resolves.toMatchObject({ messageId: "m_live" });
    expect(live.postMessage).toHaveBeenCalledTimes(2);

    live.postMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              questionId: "q_live",
              messageId: "m_third",
              alias: 1,
              status: "queued",
              expectsReply: false,
            });
        })
    );
    const third = b.postMessage(
      { question_id: "q_live", text: "Three", expects_reply: false },
      pane
    );
    const fourth = b.postMessage(
      { question_id: "q_live", text: "Four", expects_reply: false },
      pane
    );
    await vi.waitFor(() => expect(live!.postMessage).toHaveBeenCalledTimes(3));
    current = false;
    release();
    await expect(third).resolves.toMatchObject({ messageId: "m_third" });
    await expect(fourth).rejects.toMatchObject({ code: "forbidden" });
    expect(live.postMessage).toHaveBeenCalledTimes(3);
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
    const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Rotated?" } });
    expect(b.ctx.identity).toBe(rotated);
    const again = await identityOf(await storedIdentity());
    identity = again;
    await b.postMessage(
      { question_id: asked.questionId, text: "Signed now", expects_reply: false },
      paneIdentityOf(ORIGIN)
    );
    expect(b.ctx.identity).toBe(again);
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
    await expect(
      b.postMessage(
        { question_id: asked.questionId, text: "Still me", expects_reply: false },
        learned
      )
    ).resolves.toMatchObject({ questionId: asked.questionId });
    await expect(
      b.postMessage(
        { question_id: known.questionId, text: "Not me", expects_reply: false },
        { ...paneIdentityOf(ORIGIN), agent_session_id: "session-2" }
      )
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

  describe("get_involvement (#17228)", () => {
    /** The copy an attempt keeps once it has verified a phone's preference with the relay. */
    async function verifiedCopy(syncedAt: number): Promise<void> {
      const phone = await generateDeviceKeys(false);
      const record = await buildSignedInvolvement({
        installationId: identity!.config.installationId,
        signerDeviceId: "dev_phone_1234",
        signingKey: phone.signing.privateKey,
        revision: 2,
        normalMode: "involve-early",
        consultCount: 1,
        override: null,
        createdAt: "2026-11-17T08:00:00.000Z",
      });
      await store.setMeta(
        INVOLVEMENT_META,
        JSON.stringify({ record, high_water: 2, synced_at: syncedAt })
      );
    }

    it("has none before a relay attempt has read one, and asks the relay nothing", async () => {
      const b = bridge();

      await expect(b.getInvolvement()).resolves.toEqual({
        status: "unavailable",
        reason: "not-synced",
        lastSyncedAt: null,
        stale: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fetches).toBe(0);
    });

    it("answers from the live attempt while there is one", async () => {
      const b = bridge();
      await verifiedCopy(Date.parse("2026-11-17T08:30:00.000Z"));
      live = liveBridge();

      const view = await b.getInvolvement();

      expect(live.getInvolvement).toHaveBeenCalledTimes(1);
      expect(view).toBe(await live.getInvolvement.mock.results[0]!.value);
      expect(view).toMatchObject({ status: "available", revision: 3, stale: false });
    });

    it("answers between attempts from the copy the last one verified, as possibly out of date", async () => {
      const b = bridge();
      await verifiedCopy(Date.parse("2026-11-17T08:30:00.000Z"));

      await expect(b.getInvolvement()).resolves.toMatchObject({
        status: "available",
        mode: "involve-early",
        revision: 2,
        setAt: "2026-11-17T08:00:00.000Z",
        lastSyncedAt: "2026-11-17T08:30:00.000Z",
        stale: true,
      });
      expect(fetches).toBe(0);

      // The next attempt's word replaces it as soon as it is live.
      live = liveBridge();
      await expect(b.getInvolvement()).resolves.toMatchObject({ revision: 3, stale: false });
    });

    it("reads again from what answers now when the live attempt retires partway through a read", async () => {
      const b = bridge();
      await verifiedCopy(Date.parse("2026-11-17T08:30:00.000Z"));
      const retiring = liveBridge();
      retiring.getInvolvement.mockImplementation(async () => {
        live = null;
        throw new RetiredAttemptError();
      });
      live = retiring;

      await expect(b.getInvolvement()).resolves.toMatchObject({
        status: "available",
        revision: 2,
        stale: true,
      });
      expect(retiring.getInvolvement).toHaveBeenCalledTimes(1);

      const failing = liveBridge();
      failing.getInvolvement.mockRejectedValue(new Error("store is full"));
      live = failing;
      await expect(b.getInvolvement()).rejects.toThrow("store is full");
    });

    it("never falls back to itself once the connection has ended", async () => {
      const b = bridge();
      await verifiedCopy(Date.parse("2026-11-17T08:30:00.000Z"));
      live = liveBridge();
      identity = null;

      await expect(b.getInvolvement()).rejects.toMatchObject({ code: "forbidden" });
      expect(live.getInvolvement).not.toHaveBeenCalled();
    });
  });

  describe("a person's cancel", () => {
    const SCOPE = { hostId: "host_a", projectId: "p1", terminalId: "pane-1" };

    /** As the relay's create receipt leaves it: the create gone, the question open. */
    async function published(questionId: string): Promise<void> {
      for (const item of await store.outboxFor(questionId)) await store.deleteOutbox(item.id);
      await store.updateQuestion(questionId, { local_status: "open" });
    }

    async function requests(): Promise<Array<{ result?: string; detail?: unknown }>> {
      const entries = (await store.listAudit(100)).filter(
        (entry) => entry.event === "question.cancel-requested"
      );
      // Ids, levels and statuses only: the question's words never reach the audit.
      expect(JSON.stringify(entries)).not.toContain("Ship");
      return entries;
    }

    it("withdraws through the live attempt even after the run that asked was relaunched", async () => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Ship?" } });
      current = false;
      live = liveBridge();

      await expect(b.cancelForPerson(asked.questionId, SCOPE)).resolves.toEqual({
        result: "cancelling",
      });

      // The view's scope stood in for the asker, so the library is asked without a pane.
      expect(live.cancelQuestion).toHaveBeenCalledWith(asked.questionId);
      const [create] = await store.outboxFor(asked.questionId);
      expect((create?.payload as { maybePublished?: boolean }).maybePublished).toBe(true);
      expect(await requests()).toMatchObject([
        { question_id: asked.questionId, result: "person", detail: { status: "queued" } },
      ]);
      // An agent's cancel from that run is still refused.
      await expect(
        b.cancelQuestion(asked.questionId, paneIdentityOf(ORIGIN))
      ).rejects.toMatchObject({ code: "forbidden" });
    });

    it("drops a question that was never sent, between attempts, publishing nothing", async () => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Ship?" } });

      await expect(b.cancelForPerson(asked.questionId, SCOPE)).resolves.toEqual({
        result: "cancelled",
      });

      expect((await store.getQuestion(asked.questionId))?.local_status).toBe("cancelled");
      expect(await store.outboxFor(asked.questionId)).toEqual([]);
      expect(fetches).toBe(0);
      expect(await requests()).toMatchObject([
        { result: "person", detail: { status: "cancelled" } },
      ]);
    });

    it("commits a cancel for the next attempt to send when the question is already on the relay", async () => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Ship?" } });
      await published(asked.questionId);

      await expect(b.cancelForPerson(asked.questionId, SCOPE)).resolves.toEqual({
        result: "cancelling",
      });

      expect((await store.outboxFor(asked.questionId)).map((item) => item.kind)).toEqual([
        "cancel",
      ]);
      // Open until the relay's event says otherwise.
      expect((await store.getQuestion(asked.questionId))?.local_status).toBe("open");
      expect(fetches).toBe(0);
      expect(await requests()).toMatchObject([{ detail: { status: "open" } }]);
    });

    it("refuses another pane's, project's or host's question exactly like an unknown one, touching nothing", async () => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Ship?" } });
      live = liveBridge();

      for (const scope of [
        { ...SCOPE, terminalId: "pane-2" },
        { ...SCOPE, projectId: "p2" },
        { ...SCOPE, projectId: null },
        { ...SCOPE, hostId: "host_b" },
        { ...SCOPE, hostId: null },
      ]) {
        await expect(b.cancelForPerson(asked.questionId, scope)).resolves.toEqual({
          result: "refused",
          reason: "not-found",
        });
      }
      await expect(b.cancelForPerson("q_unknown_123", SCOPE)).resolves.toEqual({
        result: "refused",
        reason: "not-found",
      });
      // Imported history is never one of the pane's questions, however it matches.
      await store.updateQuestion(asked.questionId, { history_only: true });
      await expect(b.cancelForPerson(asked.questionId, SCOPE)).resolves.toEqual({
        result: "refused",
        reason: "not-found",
      });

      expect(live.cancelQuestion).not.toHaveBeenCalled();
      const [create] = await store.outboxFor(asked.questionId);
      expect((create?.payload as { maybePublished?: boolean }).maybePublished).toBeUndefined();
      expect(await requests()).toEqual([]);
    });

    it("refuses a question that has stopped waiting, saying why, and sends nothing", async () => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Ship?" } });
      await published(asked.questionId);
      live = liveBridge();

      for (const [status, reason] of [
        ["human-answered", "answered"],
        ["proxy-answered", "answered"],
        ["expired", "expired"],
        ["publish-failed", "publish-failed"],
      ] as const) {
        await store.updateQuestion(asked.questionId, { local_status: status });
        await expect(b.cancelForPerson(asked.questionId, SCOPE)).resolves.toEqual({
          result: "refused",
          reason,
        });
      }

      expect(live.cancelQuestion).not.toHaveBeenCalled();
      expect(await store.outboxFor(asked.questionId)).toEqual([]);
      expect(await requests()).toEqual([]);
    });

    it("answers a question already withdrawn as cancelled, asking for nothing again", async () => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Ship?" } });
      await store.updateQuestion(asked.questionId, { local_status: "cancelled" });
      live = liveBridge();

      await expect(b.cancelForPerson(asked.questionId, SCOPE)).resolves.toEqual({
        result: "cancelled",
      });
      expect(live.cancelQuestion).not.toHaveBeenCalled();
      expect(await requests()).toEqual([]);
    });

    it("refuses once the connection has ended", async () => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Ship?" } });
      identity = null;

      await expect(b.cancelForPerson(asked.questionId, SCOPE)).rejects.toMatchObject({
        code: "forbidden",
      });
      expect((await store.getQuestion(asked.questionId))?.local_status).toBe("queued");
    });

    it("takes its turn behind a follow-up being posted", async () => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: { question: "Ship?" } });
      live = liveBridge();
      let release!: () => void;
      live.postMessage.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                questionId: asked.questionId,
                messageId: "m_first",
                alias: 1,
                status: "queued",
                expectsReply: false,
              });
          })
      );
      const post = b.postMessage(
        { question_id: asked.questionId, text: "One more thing", expects_reply: false },
        paneIdentityOf(ORIGIN)
      );
      const cancel = b.cancelForPerson(asked.questionId, SCOPE);
      await vi.waitFor(() => expect(live!.postMessage).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(live.cancelQuestion).not.toHaveBeenCalled();

      release();
      await post;
      await expect(cancel).resolves.toEqual({ result: "cancelling" });
      expect(live.cancelQuestion).toHaveBeenCalledTimes(1);
    });
  });

  describe("a person's answer (#17101)", () => {
    const HOST = "host_a";
    const ANSWER_ID = "0190f0aa-1111-4222-8333-444455556666";
    const CHOICE = {
      question: "Which cache?",
      kind: "choice",
      options: [
        { id: "pg", label: "Postgres" },
        { id: "redis", label: "Redis" },
      ],
    };

    function payload(questionId: string, over: Record<string, unknown> = {}) {
      return {
        reference: { hostId: HOST, projectId: "p1", terminalId: "pane-1", questionId },
        answerId: ANSWER_ID,
        expectedRevision: 0,
        selectedOptionIds: ["pg"],
        reviewedAttachmentDigests: [],
        ...over,
      };
    }

    async function nothingSigned(): Promise<void> {
      expect(await store.getMeta(`owner-answer:${ANSWER_ID}`)).toBeNull();
      const items = await Promise.all(
        (await store.listQuestions()).map((row) => store.outboxFor(row.question_id))
      );
      expect(items.flat().filter((item) => item.kind === "owner-answer")).toEqual([]);
    }

    it("refuses an agent's answer on the bridge agents ask on, signing nothing", async () => {
      const b = bridge();
      live = liveBridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: CHOICE });

      await expect(
        b.answerQuestion({
          questionId: asked.questionId,
          expectedRevision: 0,
          selectedOptionIds: ["pg"],
          answerId: ANSWER_ID,
        })
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(b.getAnswerResult(ANSWER_ID)).rejects.toMatchObject({ code: "forbidden" });

      expect(live.answerQuestion).not.toHaveBeenCalled();
      expect(live.getAnswerResult).not.toHaveBeenCalled();
      await nothingSigned();
    });

    it("answers this computer's own question on the live attempt, even after the run that asked was relaunched", async () => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: CHOICE });
      current = false;
      live = liveBridge();

      await expect(
        b.answerForPerson(
          payload(asked.questionId, {
            expectedRevision: 3,
            text: "For now.",
            explicitApproval: true,
            reason: "Saw both images.",
            reviewedAttachmentDigests: ["b".repeat(64), "c".repeat(64)],
          }),
          HOST
        )
      ).resolves.toEqual({
        result: "submitted",
        answerId: "answer_live_0001",
        outcome: { status: "sent" },
      });

      expect(live.answerQuestion).toHaveBeenCalledExactlyOnceWith({
        questionId: asked.questionId,
        expectedRevision: 3,
        selectedOptionIds: ["pg"],
        reviewedAttachmentDigests: ["b".repeat(64), "c".repeat(64)],
        answerId: ANSWER_ID,
        text: "For now.",
        explicitApproval: true,
        reason: "Saw both images.",
      });
    });

    it.each([
      ["another machine", { hostId: "host_b" }],
      ["another project", { projectId: "p2" }],
      ["another terminal", { terminalId: "pane-2" }],
    ])("refuses a reference naming %s for a question this computer asked", async (_label, over) => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: CHOICE });
      live = liveBridge();
      const request = payload(asked.questionId);

      await expect(
        b.answerForPerson({ ...request, reference: { ...request.reference, ...over } }, HOST)
      ).resolves.toEqual({ result: "refused", reason: "not-found" });

      expect(live.answerQuestion).not.toHaveBeenCalled();
    });

    it("refuses a reference naming this computer for a question it doesn't hold", async () => {
      const b = bridge();
      live = liveBridge();

      await expect(b.answerForPerson(payload("q_unknown_1234"), HOST)).resolves.toEqual({
        result: "refused",
        reason: "not-found",
      });
      await expect(b.answerForPerson(payload("q_unknown_1234"), null)).resolves.toEqual({
        result: "refused",
        reason: "not-found",
      });
      expect(live.answerQuestion).not.toHaveBeenCalled();
    });

    it("signs a Remote Host's question with this computer's key between attempts, and the same answer id stays one answer", async () => {
      const b = bridge();
      const questionId = "q_remote_host_0001";
      const request = payload(questionId, {
        reference: { hostId: "host_studio", projectId: "p9", terminalId: "pane-9", questionId },
        expectedRevision: 2,
        selectedOptionIds: ["approve"],
        text: "Ship it.",
        explicitApproval: true,
        reason: "Both images match.",
        reviewedAttachmentDigests: ["a".repeat(64)],
      });

      await expect(b.answerForPerson(request, HOST)).resolves.toEqual({
        result: "submitted",
        answerId: ANSWER_ID,
        outcome: { status: "queued" },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fetches).toBe(0);

      // No copy of the question here: the answer alone is committed, for the next attempt to send.
      expect(await store.getQuestion(questionId)).toBeNull();
      const items = await store.outboxFor(questionId);
      expect(items.map((item) => item.kind)).toEqual(["owner-answer"]);
      const { signed } = items[0]!.payload as {
        signed: { record: Record<string, unknown>; envelope: Record<string, unknown> };
      };
      expect(
        await verifyRecordAndEnvelope(
          signed.record,
          signed.envelope as never,
          identity!.keys.signing.publicKey
        )
      ).toBe(true);
      expect(signed.record).toMatchObject({
        question_id: questionId,
        action: "answer",
        action_id: ANSWER_ID,
        expected_revision: 2,
        signer_device_id: identity!.config.deviceId,
      });
      // The whole answer the person gave, sealed as it was submitted.
      expect(
        await decryptEnvelope(signed.envelope as never, identity!.epochs, {
          installationId: identity!.config.installationId,
          questionId,
          recordType: "answer",
          revision: 3,
        })
      ).toEqual({
        content_version: 1,
        selected_option_ids: ["approve"],
        text: "Ship it.",
        explicit_approval: true,
        reason: "Both images match.",
        reviewed_attachment_digests: ["a".repeat(64)],
      });

      // A retry after a lost result is the same answer, never a second one.
      await expect(b.answerForPerson(request, HOST)).resolves.toMatchObject({
        result: "submitted",
        answerId: ANSWER_ID,
      });
      expect((await store.outboxFor(questionId)).map((item) => item.id)).toEqual([items[0]!.id]);
      await expect(b.answerResultForPerson(ANSWER_ID)).resolves.toEqual({
        result: "read",
        questionId,
        expectedRevision: 2,
        outcome: { status: "queued" },
      });

      // The same id for another answer is refused, and changes nothing.
      await expect(
        b.answerForPerson({ ...request, selectedOptionIds: ["reject"] }, HOST)
      ).resolves.toMatchObject({ result: "refused", reason: "invalid" });
      expect(await store.outboxFor(questionId)).toHaveLength(1);
    });

    it("reads an answer's outcome from the live attempt, and nothing for an id never submitted", async () => {
      const b = bridge();
      await expect(b.answerResultForPerson(ANSWER_ID)).resolves.toEqual({ result: "not-found" });
      live = liveBridge();

      await expect(b.answerResultForPerson(ANSWER_ID)).resolves.toEqual({
        result: "read",
        questionId: "q_live",
        expectedRevision: 0,
        outcome: { status: "already-answered" },
      });
      expect(live.getAnswerResult).toHaveBeenCalledWith(ANSWER_ID);
    });

    const OUTCOMES = [
      { status: "queued" },
      { status: "sent" },
      { status: "already-answered" },
      { status: "changed" },
      { status: "closed", reason: "expired" },
      { status: "closed", reason: "cancelled" },
      { status: "closed", reason: "not-found" },
      { status: "unsupported", by: "relay" },
      { status: "unsupported", by: "asking-desktop" },
      { status: "rejected", code: "rate_limited" },
    ] as const;

    it.each(OUTCOMES)(
      "hands back the library's outcome $status whole, from a submission and a later read",
      async (outcome) => {
        const b = bridge();
        live = liveBridge();
        const questionId = "q_remote_host_0001";
        const settled = { answerId: ANSWER_ID, questionId, expectedRevision: 4, ...outcome };
        live.answerQuestion.mockResolvedValueOnce(settled as never);
        live.getAnswerResult.mockResolvedValueOnce(settled as never);
        const request = payload(questionId, {
          reference: { hostId: "host_studio", projectId: "p9", terminalId: "pane-9", questionId },
          expectedRevision: 4,
        });

        await expect(b.answerForPerson(request, HOST)).resolves.toEqual({
          result: "submitted",
          answerId: ANSWER_ID,
          outcome,
        });
        await expect(b.answerResultForPerson(ANSWER_ID)).resolves.toEqual({
          result: "read",
          questionId,
          expectedRevision: 4,
          outcome,
        });
      }
    );

    it("commits between attempts only in its turn under the lifetime's lock, after a live attempt's settling", async () => {
      // The lifetime's lock, which delivery and every attempt's bridge share; each turn asked for is counted.
      let tail: Promise<unknown> = Promise.resolve();
      let turns = 0;
      const shared = {
        run<T>(fn: () => Promise<T>): Promise<T> {
          turns += 1;
          const turn = tail.then(fn);
          tail = turn.catch(() => {});
          return turn;
        },
      };
      source = { ...source, lock: shared as never };
      const b = bridge();
      const questionId = "q_remote_host_0001";
      let settle!: () => void;
      const settling = shared.run(() => new Promise<void>((resolve) => (settle = resolve)));
      try {
        const answering = b.answerForPerson(
          payload(questionId, {
            reference: { hostId: "host_studio", projectId: "p9", terminalId: "pane-9", questionId },
          }),
          HOST
        );
        // The answer asked for its turn behind the settling, and wrote nothing while it waited.
        await vi.waitFor(() => expect(turns).toBe(2));
        expect(await store.outboxFor(questionId)).toEqual([]);
        expect(await store.getMeta(`owner-answer:${ANSWER_ID}`)).toBeNull();

        settle();
        await expect(answering).resolves.toMatchObject({ outcome: { status: "queued" } });
        expect((await store.outboxFor(questionId)).map((item) => item.kind)).toEqual([
          "owner-answer",
        ]);
      } finally {
        settle();
        await settling;
      }
    });

    it("checks this computer's own question against its rules before signing", async () => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: CHOICE });

      const refused = await b.answerForPerson(
        payload(asked.questionId, { selectedOptionIds: ["mysql"] }),
        HOST
      );

      expect(refused).toMatchObject({ result: "refused", reason: "invalid" });
      await nothingSigned();
    });

    it("never signs on a Remote Host's own lifetime", async () => {
      const b = bridge();
      const hostIdentity = { ...identity!, role: "desktop-host" } as Identity;
      source.identity = () => hostIdentity;
      live = liveBridge();

      await expect(
        b.answerForPerson(
          payload("q_remote_host_0001", {
            reference: {
              hostId: "host_owner",
              projectId: "p1",
              terminalId: "pane-1",
              questionId: "q_remote_host_0001",
            },
          }),
          HOST
        )
      ).resolves.toEqual({ result: "refused", reason: "not-owner" });
      expect(live.answerQuestion).not.toHaveBeenCalled();
      await nothingSigned();
    });

    it("is not running once the connection has ended", async () => {
      const b = bridge();
      identity = null;

      await expect(b.answerForPerson(payload("q_remote_host_0001"), HOST)).resolves.toEqual({
        result: "not-running",
      });
    });

    it("goes again to the attempt that answers now when the live one retires partway", async () => {
      const b = bridge();
      const retiring = liveBridge();
      const next = liveBridge();
      retiring.answerQuestion.mockImplementation(async () => {
        live = next;
        throw new RetiredAttemptError();
      });
      live = retiring;
      const request = payload("q_remote_host_0001", {
        reference: {
          hostId: "host_studio",
          projectId: "p9",
          terminalId: "pane-9",
          questionId: "q_remote_host_0001",
        },
        expectedRevision: 5,
        selectedOptionIds: ["approve"],
        text: "Ship it.",
        explicitApproval: true,
        reason: "Both match.",
        reviewedAttachmentDigests: ["d".repeat(64)],
      });

      await expect(b.answerForPerson(request, HOST)).resolves.toMatchObject({
        result: "submitted",
        outcome: { status: "sent" },
      });
      // The same answer, whole, on the attempt that answers now.
      expect(next.answerQuestion).toHaveBeenCalledExactlyOnceWith(
        retiring.answerQuestion.mock.calls[0]![0]
      );

      const reading = liveBridge();
      reading.getAnswerResult.mockImplementation(async () => {
        live = next;
        throw new RetiredAttemptError();
      });
      live = reading;
      await expect(b.answerResultForPerson(ANSWER_ID)).resolves.toMatchObject({ result: "read" });
      expect(next.getAnswerResult).toHaveBeenCalledExactlyOnceWith(ANSWER_ID);
    });
  });

  describe("a person's dismissal (#17239)", () => {
    const HOST = "host_a";
    const DECLINE_ID = "0190f0aa-1111-4222-8333-44445555dddd";
    const CHOICE = {
      question: "Which cache?",
      kind: "choice",
      options: [{ id: "pg", label: "Postgres" }],
    };

    function payload(questionId: string, over: Record<string, unknown> = {}) {
      return {
        reference: { hostId: HOST, projectId: "p1", terminalId: "pane-1", questionId },
        declineId: DECLINE_ID,
        expectedRevision: 0,
        ...over,
      };
    }

    /** Nothing was signed for `questionId`, held here or not: no record of the id, and no outbox item. */
    async function nothingSigned(questionId: string): Promise<void> {
      expect(await store.getMeta(`owner-decline:${DECLINE_ID}`)).toBeNull();
      expect(await store.outboxFor(questionId)).toEqual([]);
    }

    it("refuses an agent's decline on the bridge agents ask on, signing nothing", async () => {
      const b = bridge();
      live = liveBridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: CHOICE });

      await expect(
        b.declineQuestion({
          questionId: asked.questionId,
          expectedRevision: 0,
          declineId: DECLINE_ID,
        })
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(b.getDeclineResult(DECLINE_ID)).rejects.toMatchObject({ code: "forbidden" });

      expect(live.declineQuestion).not.toHaveBeenCalled();
      expect(live.getDeclineResult).not.toHaveBeenCalled();
      await nothingSigned(asked.questionId);
    });

    it("declines this computer's own question on the live attempt at the revision read, even after the run that asked was relaunched", async () => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: CHOICE });
      current = false;
      live = liveBridge();

      await expect(
        b.declineForPerson(payload(asked.questionId, { expectedRevision: 3 }), HOST)
      ).resolves.toEqual({
        result: "submitted",
        declineId: DECLINE_ID,
        outcome: { status: "declined" },
      });
      expect(live.declineQuestion).toHaveBeenCalledExactlyOnceWith({
        questionId: asked.questionId,
        expectedRevision: 3,
        declineId: DECLINE_ID,
      });
      // A decline, never the desktop's withdrawal.
      expect(live.cancelQuestion).not.toHaveBeenCalled();
    });

    it.each([
      ["another machine", { hostId: "host_b" }],
      ["another project", { projectId: "p2" }],
      ["another terminal", { terminalId: "pane-2" }],
    ])("refuses a reference naming %s for a question this computer asked", async (_label, over) => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: CHOICE });
      live = liveBridge();
      const request = payload(asked.questionId);

      await expect(
        b.declineForPerson({ ...request, reference: { ...request.reference, ...over } }, HOST)
      ).resolves.toEqual({ result: "refused", reason: "not-found" });
      expect(live.declineQuestion).not.toHaveBeenCalled();
    });

    it("refuses a reference naming this computer for a question it doesn't hold", async () => {
      const b = bridge();
      live = liveBridge();

      await expect(b.declineForPerson(payload("q_unknown_1234"), HOST)).resolves.toEqual({
        result: "refused",
        reason: "not-found",
      });
      await expect(b.declineForPerson(payload("q_unknown_1234"), null)).resolves.toEqual({
        result: "refused",
        reason: "not-found",
      });
      expect(live.declineQuestion).not.toHaveBeenCalled();
    });

    it("signs a Remote Host's question with this computer's key between attempts, and the same decline id stays one decline", async () => {
      const b = bridge();
      const questionId = "q_remote_host_0001";
      const request = payload(questionId, {
        reference: { hostId: "host_studio", projectId: "p9", terminalId: "pane-9", questionId },
        expectedRevision: 2,
      });

      await expect(b.declineForPerson(request, HOST)).resolves.toEqual({
        result: "submitted",
        declineId: DECLINE_ID,
        outcome: { status: "queued" },
      });
      const outbox = await store.outboxFor(questionId);
      expect(outbox.map((item) => item.kind)).toEqual(["owner-decline"]);
      const signed = (outbox[0]!.payload as { signed: { record: Record<string, unknown> } }).signed;
      expect(signed.record).toMatchObject({
        action: "cancel",
        decline: true,
        expected_revision: 2,
        action_id: DECLINE_ID,
        signer_device_id: identity!.config.deviceId,
      });

      // The same id again is the same decline, never a second one.
      await expect(b.declineForPerson(request, HOST)).resolves.toMatchObject({
        outcome: { status: "queued" },
      });
      expect((await store.outboxFor(questionId)).map((item) => item.kind)).toEqual([
        "owner-decline",
      ]);
      await expect(b.declineResultForPerson(DECLINE_ID)).resolves.toEqual({
        result: "read",
        questionId,
        expectedRevision: 2,
        outcome: { status: "queued" },
      });
      // Reused for another revision, it's refused before anything else is signed.
      await expect(
        b.declineForPerson({ ...request, expectedRevision: 3 }, HOST)
      ).resolves.toMatchObject({ result: "refused", reason: "invalid" });
    });

    it("reads a decline's outcome from the live attempt, and nothing for an id never submitted", async () => {
      const b = bridge();
      await expect(b.declineResultForPerson(DECLINE_ID)).resolves.toEqual({ result: "not-found" });
      live = liveBridge();
      await expect(b.declineResultForPerson(DECLINE_ID)).resolves.toEqual({
        result: "read",
        questionId: "q_live",
        expectedRevision: 0,
        outcome: { status: "unsupported", by: "asking-desktop" },
      });
    });

    it("never signs on a Remote Host's own lifetime", async () => {
      const b = bridge();
      const hostIdentity = { ...identity!, role: "desktop-host" } as Identity;
      source.identity = () => hostIdentity;
      live = liveBridge();
      const questionId = "q_remote_host_0001";

      await expect(
        b.declineForPerson(
          payload(questionId, {
            reference: { hostId: "host_owner", projectId: "p1", terminalId: "pane-1", questionId },
          }),
          HOST
        )
      ).resolves.toEqual({ result: "refused", reason: "not-owner" });
      expect(live.declineQuestion).not.toHaveBeenCalled();
      await nothingSigned(questionId);
    });

    it("is not running once the connection ends under the signing, and lets anything else through", async () => {
      const b = bridge();
      live = liveBridge();
      const questionId = "q_remote_host_0001";
      const request = payload(questionId, {
        reference: { hostId: "host_studio", projectId: "p9", terminalId: "pane-9", questionId },
      });
      // Revoked after the role was read: the library refuses before it signs.
      live.declineQuestion.mockRejectedValueOnce(new BridgeError("forbidden", "revoked"));
      await expect(b.declineForPerson(request, HOST)).resolves.toEqual({ result: "not-running" });
      live.getDeclineResult.mockRejectedValueOnce(new BridgeError("forbidden", "revoked"));
      await expect(b.declineResultForPerson(DECLINE_ID)).resolves.toEqual({
        result: "not-running",
      });

      live.declineQuestion.mockRejectedValueOnce(new BridgeError("invalid_state", "unexpected"));
      await expect(b.declineForPerson(request, HOST)).rejects.toMatchObject({
        code: "invalid_state",
      });
      live.declineQuestion.mockRejectedValueOnce(new Error("store closed"));
      await expect(b.declineForPerson(request, HOST)).rejects.toThrow("store closed");
    });

    it("is not running once the connection has ended", async () => {
      const b = bridge();
      identity = null;

      await expect(b.declineForPerson(payload("q_remote_host_0001"), HOST)).resolves.toEqual({
        result: "not-running",
      });
      await expect(b.declineResultForPerson(DECLINE_ID)).resolves.toEqual({
        result: "not-running",
      });
    });

    it("goes again to the attempt that answers now when the live one retires partway", async () => {
      const b = bridge();
      const retiring = liveBridge();
      const next = liveBridge();
      retiring.declineQuestion.mockImplementation(async () => {
        live = next;
        throw new RetiredAttemptError();
      });
      live = retiring;
      const questionId = "q_remote_host_0001";
      const request = payload(questionId, {
        reference: { hostId: "host_studio", projectId: "p9", terminalId: "pane-9", questionId },
        expectedRevision: 5,
      });

      await expect(b.declineForPerson(request, HOST)).resolves.toMatchObject({
        result: "submitted",
        outcome: { status: "declined" },
      });
      // The same decline, under the same id, on the attempt that answers now.
      expect(next.declineQuestion).toHaveBeenCalledExactlyOnceWith(
        retiring.declineQuestion.mock.calls[0]![0]
      );

      const reading = liveBridge();
      reading.getDeclineResult.mockImplementation(async () => {
        live = next;
        throw new RetiredAttemptError();
      });
      live = reading;
      await expect(b.declineResultForPerson(DECLINE_ID)).resolves.toMatchObject({ result: "read" });
      expect(next.getDeclineResult).toHaveBeenCalledExactlyOnceWith(DECLINE_ID);
    });
  });

  describe("a person's follow-up (#17238)", () => {
    const HOST = "host_a";
    const MESSAGE_ID = "0190f0aa-2222-4222-8333-444455550001";
    const CHOICE = {
      question: "Which cache?",
      kind: "choice",
      options: [
        { id: "pg", label: "Postgres" },
        { id: "redis", label: "Redis" },
      ],
    };
    const REMOTE = {
      hostId: "host_studio",
      projectId: "p9",
      terminalId: "pane-9",
      questionId: "q_remote_host_0001",
    };

    function payload(questionId: string, over: Record<string, unknown> = {}) {
      return {
        reference: { hostId: HOST, projectId: "p1", terminalId: "pane-1", questionId },
        messageId: MESSAGE_ID,
        text: "Prefer the one already deployed.",
        ...over,
      };
    }

    async function nothingSigned(): Promise<void> {
      expect(await store.getMeta(`owner-message:${MESSAGE_ID}`)).toBeNull();
      const items = await Promise.all(
        (await store.listQuestions()).map((row) => store.outboxFor(row.question_id))
      );
      expect(items.flat().filter((item) => item.kind === "owner-message")).toEqual([]);
    }

    it("refuses an agent's follow-up for the person on the bridge agents ask on, signing nothing", async () => {
      const b = bridge();
      live = liveBridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: CHOICE });

      await expect(
        b.sendFollowUp({ questionId: asked.questionId, text: "Approved.", messageId: MESSAGE_ID })
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(b.getFollowUpResult(MESSAGE_ID)).rejects.toMatchObject({ code: "forbidden" });

      expect(live.sendFollowUp).not.toHaveBeenCalled();
      expect(live.getFollowUpResult).not.toHaveBeenCalled();
      await nothingSigned();
    });

    it("sends on this computer's own question from the live attempt, even after the run that asked was relaunched", async () => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: CHOICE });
      current = false;
      live = liveBridge();

      await expect(b.followUpForPerson(payload(asked.questionId), HOST)).resolves.toEqual({
        result: "submitted",
        messageId: MESSAGE_ID,
        outcome: { status: "sent" },
      });
      expect(live.sendFollowUp).toHaveBeenCalledExactlyOnceWith({
        questionId: asked.questionId,
        text: "Prefer the one already deployed.",
        messageId: MESSAGE_ID,
      });
    });

    it.each([
      ["another machine", { hostId: "host_b" }],
      ["another project", { projectId: "p2" }],
      ["another terminal", { terminalId: "pane-2" }],
    ])("refuses a reference naming %s for a question this computer asked", async (_label, over) => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: CHOICE });
      live = liveBridge();
      const request = payload(asked.questionId);

      await expect(
        b.followUpForPerson({ ...request, reference: { ...request.reference, ...over } }, HOST)
      ).resolves.toEqual({ result: "refused", reason: "not-found" });
      expect(live.sendFollowUp).not.toHaveBeenCalled();
    });

    it("refuses a reference naming this computer for a question it doesn't hold", async () => {
      const b = bridge();
      live = liveBridge();

      for (const hostId of [HOST, null]) {
        await expect(b.followUpForPerson(payload("q_unknown_1234"), hostId)).resolves.toEqual({
          result: "refused",
          reason: "not-found",
        });
      }
      expect(live.sendFollowUp).not.toHaveBeenCalled();
    });

    it("signs a Remote Host's question with this computer's key between attempts, and the same id stays one message", async () => {
      const b = bridge();
      const request = payload(REMOTE.questionId, { reference: REMOTE });

      await expect(b.followUpForPerson(request, HOST)).resolves.toEqual({
        result: "submitted",
        messageId: MESSAGE_ID,
        outcome: { status: "queued" },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fetches).toBe(0);

      expect(await store.getQuestion(REMOTE.questionId)).toBeNull();
      const items = await store.outboxFor(REMOTE.questionId);
      expect(items.map((item) => item.kind)).toEqual(["owner-message"]);
      const { signed } = items[0]!.payload as {
        signed: { record: Record<string, unknown>; envelope: Record<string, unknown> };
      };
      expect(
        await verifyRecordAndEnvelope(
          signed.record,
          signed.envelope as never,
          identity!.keys.signing.publicKey
        )
      ).toBe(true);
      // The person's message, never one that expects a reply, and only the words they wrote.
      expect(signed.record).toMatchObject({
        question_id: REMOTE.questionId,
        message_id: MESSAGE_ID,
        side: "human",
        expects_reply: false,
        signer_device_id: identity!.config.deviceId,
      });
      expect(
        await decryptEnvelope(signed.envelope as never, identity!.epochs, {
          installationId: identity!.config.installationId,
          questionId: REMOTE.questionId,
          recordType: MESSAGE_RECORD_TYPE,
          revision: 0,
        })
      ).toEqual({
        content_version: 1,
        side: "human",
        text: "Prefer the one already deployed.",
        images: [],
      });

      // A retry after a lost result is the same message, never a second one.
      await expect(b.followUpForPerson(request, HOST)).resolves.toMatchObject({
        result: "submitted",
        messageId: MESSAGE_ID,
      });
      expect((await store.outboxFor(REMOTE.questionId)).map((item) => item.id)).toEqual([
        items[0]!.id,
      ]);
      await expect(b.followUpResultForPerson(MESSAGE_ID)).resolves.toEqual({
        result: "read",
        questionId: REMOTE.questionId,
        outcome: { status: "queued" },
      });

      // The same id for other words is refused, and changes nothing.
      await expect(
        b.followUpForPerson({ ...request, text: "Something else." }, HOST)
      ).resolves.toMatchObject({ result: "refused", reason: "invalid" });
      expect(await store.outboxFor(REMOTE.questionId)).toHaveLength(1);
    });

    it("refuses words the protocol doesn't take, signing nothing", async () => {
      const b = bridge();

      await expect(
        b.followUpForPerson(payload(REMOTE.questionId, { reference: REMOTE, text: "   " }), HOST)
      ).resolves.toMatchObject({ result: "refused", reason: "invalid" });
      await nothingSigned();
    });

    const OUTCOMES = [
      { status: "queued" },
      { status: "sent" },
      { status: "closed", reason: "expired" },
      { status: "closed", reason: "cancelled" },
      { status: "closed", reason: "not-found" },
      { status: "unsupported", by: "relay" },
      { status: "unsupported", by: "asking-desktop" },
      { status: "rejected", code: "invalid_state" },
      { status: "rejected", code: "rate_limited" },
    ] as const;

    it.each(OUTCOMES)(
      "hands back the library's outcome $status whole, from a submission and a later read",
      async (outcome) => {
        const b = bridge();
        live = liveBridge();
        const settled = { messageId: MESSAGE_ID, questionId: REMOTE.questionId, ...outcome };
        live.sendFollowUp.mockResolvedValueOnce(settled as never);
        live.getFollowUpResult.mockResolvedValueOnce(settled as never);

        await expect(
          b.followUpForPerson(payload(REMOTE.questionId, { reference: REMOTE }), HOST)
        ).resolves.toEqual({ result: "submitted", messageId: MESSAGE_ID, outcome });
        await expect(b.followUpResultForPerson(MESSAGE_ID)).resolves.toEqual({
          result: "read",
          questionId: REMOTE.questionId,
          outcome,
        });
      }
    );

    it("reads nothing for an id never submitted", async () => {
      const b = bridge();
      await expect(b.followUpResultForPerson(MESSAGE_ID)).resolves.toEqual({
        result: "not-found",
      });
    });

    it("is not running when the live attempt finds the device revoked partway", async () => {
      const b = bridge();
      live = liveBridge();
      live.sendFollowUp.mockRejectedValueOnce(new BridgeError("forbidden", "revoked"));
      live.getFollowUpResult.mockRejectedValueOnce(new BridgeError("forbidden", "revoked"));

      await expect(
        b.followUpForPerson(payload(REMOTE.questionId, { reference: REMOTE }), HOST)
      ).resolves.toEqual({ result: "not-running" });
      await expect(b.followUpResultForPerson(MESSAGE_ID)).resolves.toEqual({
        result: "not-running",
      });
    });

    it("takes a question kept only as history as one this computer doesn't hold", async () => {
      const b = bridge();
      const asked = await b.registerQuestion({ origin: ORIGIN, input: CHOICE });
      await store.updateQuestion(asked.questionId, { history_only: true });
      live = liveBridge();

      // Naming this computer, it names nothing; named as a Host's, it is sent without a local copy.
      await expect(b.followUpForPerson(payload(asked.questionId), HOST)).resolves.toEqual({
        result: "refused",
        reason: "not-found",
      });
      const remote = { ...REMOTE, questionId: asked.questionId };
      await expect(
        b.followUpForPerson(payload(asked.questionId, { reference: remote }), HOST)
      ).resolves.toMatchObject({ result: "submitted" });
      expect(live.sendFollowUp).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ questionId: asked.questionId })
      );
    });

    it("never signs on a Remote Host's own lifetime, and is not running once the connection has ended", async () => {
      const b = bridge();
      const hostIdentity = { ...identity!, role: "desktop-host" } as Identity;
      source.identity = () => hostIdentity;
      live = liveBridge();

      await expect(
        b.followUpForPerson(payload(REMOTE.questionId, { reference: REMOTE }), HOST)
      ).resolves.toEqual({ result: "refused", reason: "not-owner" });
      expect(live.sendFollowUp).not.toHaveBeenCalled();
      await nothingSigned();

      source.identity = () => null;
      await expect(
        b.followUpForPerson(payload(REMOTE.questionId, { reference: REMOTE }), HOST)
      ).resolves.toEqual({ result: "not-running" });
    });

    it("goes again to the attempt that sends now when the live one retires partway", async () => {
      const b = bridge();
      const retiring = liveBridge();
      const next = liveBridge();
      retiring.sendFollowUp.mockImplementation(async () => {
        live = next;
        throw new RetiredAttemptError();
      });
      live = retiring;
      const request = payload(REMOTE.questionId, { reference: REMOTE });

      await expect(b.followUpForPerson(request, HOST)).resolves.toMatchObject({
        result: "submitted",
        outcome: { status: "sent" },
      });
      expect(next.sendFollowUp).toHaveBeenCalledExactlyOnceWith(
        retiring.sendFollowUp.mock.calls[0]![0]
      );

      const reading = liveBridge();
      reading.getFollowUpResult.mockImplementation(async () => {
        live = next;
        throw new RetiredAttemptError();
      });
      live = reading;
      await expect(b.followUpResultForPerson(MESSAGE_ID)).resolves.toMatchObject({
        result: "read",
      });
      expect(next.getFollowUpResult).toHaveBeenCalledExactlyOnceWith(MESSAGE_ID);
    });
  });
});
