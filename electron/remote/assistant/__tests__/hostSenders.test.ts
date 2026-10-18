import { describe, expect, it, vi } from "vitest";
import type { LinkSession } from "../../link/session.js";
import type { MetricsSessionContext } from "../../metrics/hostMetricsHost.js";
import type { RetiredExchangeStore } from "../../exchange/RetiredExchangeStore.js";
import { installAssistantSenderHostWith, senderIdForCredential } from "../hostSenders.js";
import { AssistantLinkMethod, RetiredExchangeMethod } from "../linkMethods.js";
import { SenderSessions } from "../senderSessions.js";

const CREDENTIAL_A = "A".repeat(43);
const CREDENTIAL_B = "B".repeat(43);

interface FakeSession {
  ctx: MetricsSessionContext;
  session: LinkSession;
  authenticate(credential: string): unknown;
  answer(method: string, payload: unknown): unknown;
}

function fakeSession(id: string): FakeSession {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const session = {
    isOpen: true,
    call: vi.fn(async () => null),
    registerCallHandler: (
      method: string,
      schema: { parse(v: unknown): unknown },
      handler: (p: unknown) => unknown
    ) => {
      handlers.set(method, (payload) => handler(schema.parse(payload)));
    },
  } as unknown as LinkSession;
  return {
    ctx: { session, sessionId: id, client: {} } as unknown as MetricsSessionContext,
    session,
    authenticate: (credential) => handlers.get(AssistantLinkMethod.AUTHENTICATE)!({ credential }),
    answer: (method, payload) => {
      const handler = handlers.get(method);
      if (!handler) throw Object.assign(new Error("unsupported"), { code: "UNSUPPORTED" });
      return handler(payload);
    },
  };
}

const RECORD = {
  taskId: "task-1",
  senderId: senderIdForCredential(CREDENTIAL_A),
  messageId: "m-1",
  state: "failed",
  outcome: "messaging_retired",
  tombstonedAt: null,
};

function setup(sessions: FakeSession[], retired?: Partial<RetiredExchangeStore>) {
  const senders = new SenderSessions();
  let expire: (info: { sessionId: string }) => void = () => {};
  const off = installAssistantSenderHostWith(
    { sessions: sessions.map((s) => s.ctx), onSession: () => () => {} },
    {
      senders,
      ...(retired ? { retired: retired as RetiredExchangeStore } : {}),
      onSessionExpired: (listener) => {
        expire = listener;
        return () => {};
      },
    }
  );
  return { senders, off, expire: (sessionId: string) => expire({ sessionId }) };
}

describe("installAssistantSenderHostWith (#13493, #13496)", () => {
  it("binds each session to the sender its credential proves, and nothing it sends", () => {
    const a = fakeSession("link-a");
    const b = fakeSession("link-b");
    const { senders } = setup([a, b]);
    a.authenticate(CREDENTIAL_A);
    b.authenticate(CREDENTIAL_B);
    expect(senders.senderOf(a.session)).toBe(senderIdForCredential(CREDENTIAL_A));
    expect(senders.senderOf(b.session)).toBe(senderIdForCredential(CREDENTIAL_B));
  });

  it("never lets a session, or a resumed transport of it, prove another sender", () => {
    const a = fakeSession("link-a");
    const resumed = fakeSession("link-a");
    const { senders, expire } = setup([a, resumed]);
    a.authenticate(CREDENTIAL_A);
    expect(() => a.authenticate(CREDENTIAL_B)).toThrow(/another assistant sender/);
    expect(() => resumed.authenticate(CREDENTIAL_B)).toThrow(/another assistant sender/);
    // Proving the same one again is fine.
    resumed.authenticate(CREDENTIAL_A);
    expect(senders.senderOf(resumed.session)).toBe(senderIdForCredential(CREDENTIAL_A));

    // Gone for good, the session id holds nothing.
    expire("link-a");
    const next = fakeSession("link-a");
    setup([next]);
    expect(() => next.authenticate(CREDENTIAL_B)).not.toThrow();
  });

  it("answers a v0.44 Shell's reads from the sender's own retired records", () => {
    const a = fakeSession("link-a");
    const get = vi.fn((sender: { senderId: string }, key: { messageId: string }) =>
      sender.senderId === RECORD.senderId && key.messageId === "m-1" ? RECORD : null
    );
    const listChangesSince = vi.fn(() => ({
      records: [RECORD],
      cursor: 9,
      hasMore: false,
      reset: false,
    }));
    setup([a], { get: get as never, listChangesSince: listChangesSince as never });
    a.authenticate(CREDENTIAL_A);

    expect(a.answer(RetiredExchangeMethod.GET_EXCHANGE, { messageId: "m-1" })).toBe(RECORD);
    expect(a.answer(RetiredExchangeMethod.LIST_EXCHANGES, { cursor: 3 })).toMatchObject({
      records: [RECORD],
    });
    expect(listChangesSince).toHaveBeenCalledWith(
      { kind: "sender", senderId: RECORD.senderId },
      3,
      undefined
    );
    expect(a.answer(RetiredExchangeMethod.CANCEL_EXCHANGE, { messageId: "m-1" })).toBe(RECORD);
    expect(a.answer(RetiredExchangeMethod.GET_RESPONSES, { messageId: "m-1" })).toEqual({
      responses: [],
    });
    expect(() => a.answer(RetiredExchangeMethod.CANCEL_EXCHANGE, { messageId: "nope" })).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" })
    );
  });

  it("answers a resend from its record, and takes nothing new", () => {
    const a = fakeSession("link-a");
    setup([a], {
      get: ((_s: unknown, key: { messageId: string }) =>
        key.messageId === "m-1" ? RECORD : null) as never,
    });
    a.authenticate(CREDENTIAL_A);
    const send = {
      messageId: "m-1",
      contextId: "c",
      referenceTaskIds: [],
      projectId: "proj-2",
      slot: 0,
      generation: "open",
      body: "hello",
    };
    expect(a.answer(RetiredExchangeMethod.SEND, send)).toEqual({
      disposition: "existing",
      record: RECORD,
    });
    expect(() => a.answer(RetiredExchangeMethod.SEND, { ...send, messageId: "m-2" })).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED" })
    );
  });

  it("refuses a read before a sender is proven, and answers unsupported with no records", () => {
    const anonymous = fakeSession("anon");
    setup([anonymous], { get: vi.fn() as never });
    expect(() =>
      anonymous.answer(RetiredExchangeMethod.GET_EXCHANGE, { messageId: "m-1" })
    ).toThrow(expect.objectContaining({ code: "PERMISSION" }));

    const b = fakeSession("link-b");
    setup([b]);
    b.authenticate(CREDENTIAL_B);
    expect(() => b.answer(RetiredExchangeMethod.GET_EXCHANGE, { messageId: "m-1" })).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED" })
    );
  });

  it("registers none of the inbox's other methods", () => {
    const a = fakeSession("link-a");
    setup([a]);
    a.authenticate(CREDENTIAL_A);
    for (const method of [
      "assistant.list-lanes",
      "assistant.enroll-started",
      "assistant.start",
      "assistant.read-quota",
      "assistant.send-to-hub",
    ]) {
      expect(() => a.answer(method, {})).toThrow(expect.objectContaining({ code: "UNSUPPORTED" }));
    }
  });
});
