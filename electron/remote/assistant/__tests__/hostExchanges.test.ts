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
    close: () => {
      open = false;
    },
  };
}

function setup(sessions: FakeSession[]) {
  let listener: ((change: ExchangeChange) => void) | null = null;
  const off = installAssistantExchangeHostWith(
    { sessions: sessions.map((s) => s.ctx), onSession: () => () => {} },
    {
      policy: () => undefined,
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
