import { describe, expect, it, vi } from "vitest";
import type {
  AssistantExchangeStore,
  ExchangeChange,
} from "../../exchange/AssistantExchangeStore.js";
import type { LinkSession } from "../../link/session.js";
import type { MetricsSessionContext } from "../../metrics/hostMetricsHost.js";
import { installAssistantExchangeHostWith, senderIdForCredential } from "../hostExchanges.js";
import { AssistantLinkMethod } from "../linkMethods.js";

const CREDENTIAL_A = "A".repeat(43);
const CREDENTIAL_B = "B".repeat(43);

interface FakeSession {
  ctx: MetricsSessionContext;
  calls: Array<{ method: string; payload: unknown }>;
  authenticate(credential: string): void;
  /** The host's answer to one of the Shell's calls on this session. */
  answer(method: string, payload: unknown): unknown;
  close(): void;
}

function fakeSession(id: string): FakeSession {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const calls: Array<{ method: string; payload: unknown }> = [];
  let open = true;
  const session = {
    get isOpen() {
      return open;
    },
    call: vi.fn(async (method: string, payload: unknown) => {
      calls.push({ method, payload });
      return null;
    }),
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
    calls,
    authenticate: (credential) => {
      handlers.get(AssistantLinkMethod.AUTHENTICATE)!({ credential });
    },
    answer: (method, payload) => handlers.get(method)!(payload),
    close: () => {
      open = false;
    },
  };
}

function setup(
  sessions: FakeSession[],
  extra: Partial<Parameters<typeof installAssistantExchangeHostWith>[1]> = {}
) {
  let listener: ((change: ExchangeChange) => void) | null = null;
  const off = installAssistantExchangeHostWith(
    { sessions: sessions.map((s) => s.ctx), onSession: () => () => {} },
    {
      policy: () => undefined,
      ...extra,
      store: {} as AssistantExchangeStore,
      onExchangeChanged: (l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    }
  );
  return {
    off,
    change: (credential: string, revision: number) =>
      listener?.({ senderId: senderIdForCredential(credential), revision }),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("installAssistantExchangeHostWith change events", () => {
  it("tells only the open sessions that authenticated the record's sender, once per burst", async () => {
    const a1 = fakeSession("a1");
    const a2 = fakeSession("a2");
    const b = fakeSession("b");
    const anonymous = fakeSession("anon");
    const closed = fakeSession("closed");
    const h = setup([a1, a2, b, anonymous, closed]);
    a1.authenticate(CREDENTIAL_A);
    a2.authenticate(CREDENTIAL_A);
    b.authenticate(CREDENTIAL_B);
    closed.authenticate(CREDENTIAL_A);
    closed.close();

    h.change(CREDENTIAL_A, 4);
    h.change(CREDENTIAL_A, 7);
    h.change(CREDENTIAL_A, 5);
    await flush();

    const announced = { method: AssistantLinkMethod.EXCHANGE_CHANGED, payload: { revision: 7 } };
    expect(a1.calls).toEqual([announced]);
    expect(a2.calls).toEqual([announced]);
    expect(b.calls).toEqual([]);
    expect(anonymous.calls).toEqual([]);
    expect(closed.calls).toEqual([]);
  });

  it("says nothing once torn down, even for a change already queued", async () => {
    const a = fakeSession("a");
    const h = setup([a]);
    a.authenticate(CREDENTIAL_A);
    h.change(CREDENTIAL_A, 1);
    h.off();
    await flush();
    h.change(CREDENTIAL_A, 2);
    await flush();
    expect(a.calls).toEqual([]);
  });
});

describe("assistant.start (#13511)", () => {
  const payload = { projectId: "proj-1", slot: 1, askingHelpSessionId: "hub-help-1" };
  // Enough of a policy to authenticate against; starting asks it nothing more.
  const policy = () => ({ sessionSender: () => undefined, bindSender: () => [] }) as never;

  it("starts one for the sender the session proved, on that session, never the payload's word", async () => {
    const a = fakeSession("link-a");
    const startAssistant = vi.fn(async () => ({
      status: "started" as const,
      lane: { slot: 1, sessionId: "session-1", agentId: "codex" },
    }));
    setup([a], { policy, startAssistant });
    a.authenticate(CREDENTIAL_A);

    await expect(a.answer(AssistantLinkMethod.START, payload)).resolves.toEqual({
      status: "started",
      lane: { slot: 1, sessionId: "session-1", agentId: "codex" },
    });
    expect(startAssistant).toHaveBeenCalledWith(payload, {
      senderId: senderIdForCredential(CREDENTIAL_A),
      linkSessionId: "link-a",
    });
  });

  it("refuses a session that hasn't proved a sender, and a host that can't start one", async () => {
    const anonymous = fakeSession("anon");
    const startAssistant = vi.fn();
    setup([anonymous], { policy, startAssistant });
    await expect(
      Promise.resolve().then(() => anonymous.answer(AssistantLinkMethod.START, payload))
    ).rejects.toMatchObject({ code: "PERMISSION" });
    expect(startAssistant).not.toHaveBeenCalled();

    const b = fakeSession("link-b");
    setup([b], { policy });
    b.authenticate(CREDENTIAL_B);
    await expect(
      Promise.resolve().then(() => b.answer(AssistantLinkMethod.START, payload))
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("refuses a payload naming anything but the project, the lane, an agent and who asked", () => {
    const a = fakeSession("link-a");
    setup([a], { policy, startAssistant: vi.fn() });
    a.authenticate(CREDENTIAL_A);
    expect(() =>
      a.answer(AssistantLinkMethod.START, { ...payload, senderId: "someone-else" })
    ).toThrow();
  });
});
