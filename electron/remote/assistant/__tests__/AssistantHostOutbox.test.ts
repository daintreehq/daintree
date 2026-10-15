import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXCHANGE_TTL_MS } from "../../exchange/AssistantExchangeStore.js";
import type { LinkSession } from "../../link/session.js";
import type { MetricsSessionContext } from "../../metrics/hostMetricsHost.js";
import {
  AssistantHostOutbox,
  OUTBOX_MAX_OPEN_PER_LANE,
  type OutboxWake,
} from "../AssistantHostOutbox.js";
import type { LaneEnrollment } from "../AssistantMessagingPolicy.js";
import { AssistantLinkMethod, type HubExchange, type SendToHubPayload } from "../linkMethods.js";

type Answer = (method: string, payload: unknown) => unknown;

interface FakeShellSession {
  ctx: MetricsSessionContext;
  calls: Array<{ method: string; payload: unknown }>;
  answer: Answer;
  tell(method: string, payload: unknown): unknown;
  close(): void;
}

function fakeSession(sessionId: string, answer: Answer): FakeShellSession {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  let open = true;
  const fake: FakeShellSession = {
    ctx: null as never,
    calls: [],
    answer,
    tell: (method, payload) => handlers.get(method)!(payload),
    close: () => {
      open = false;
    },
  };
  const session = {
    get isOpen() {
      return open;
    },
    call: vi.fn(async (method: string, payload: unknown) => {
      fake.calls.push({ method, payload });
      return fake.answer(method, payload);
    }),
    registerCallHandler: (
      method: string,
      schema: { parse(v: unknown): unknown },
      handler: (p: unknown) => unknown
    ) => {
      handlers.set(method, (payload) => handler(schema.parse(payload)));
    },
  } as unknown as LinkSession;
  fake.ctx = { session, sessionId, client: {} } as unknown as MetricsSessionContext;
  return fake;
}

function enrollment(overrides: Partial<LaneEnrollment> = {}): LaneEnrollment {
  return {
    projectId: "proj",
    slot: 1,
    generation: "gen-1",
    sessionId: "help-1",
    terminalId: "t-1",
    launchGeneration: 1,
    enrolledBy: { kind: "remote", linkSessionId: "link-a" },
    enrolledAt: 0,
    ...overrides,
  };
}

const accepted = (overrides: Partial<Extract<HubExchange, { status: "accepted" }>> = {}) => ({
  status: "accepted" as const,
  taskId: "task-1",
  state: "submitted" as const,
  responses: [],
  ...overrides,
});

describe("AssistantHostOutbox", () => {
  let sessions: MetricsSessionContext[];
  let sessionListeners: Set<(ctx: MetricsSessionContext) => void>;
  let ended: Set<string>;
  let wakes: OutboxWake[];
  let outbox: AssistantHostOutbox;
  let ids: number;

  const connect = (fake: FakeShellSession) => {
    sessions.push(fake.ctx);
    for (const listener of sessionListeners) listener(fake.ctx);
  };
  const settle = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    sessions = [];
    sessionListeners = new Set();
    ended = new Set();
    wakes = [];
    ids = 0;
    outbox = new AssistantHostOutbox({
      server: {
        get sessions() {
          return sessions;
        },
        onSession: (listener) => {
          sessionListeners.add(listener);
          return () => sessionListeners.delete(listener);
        },
      },
      policy: () => ({
        checkLane: (check) =>
          ended.has(check.generation)
            ? { ok: false, reason: "not-enrolled" }
            : { ok: true, enrollment: enrollment({ generation: check.generation }) },
      }),
      wake: (wake) => wakes.push(wake),
      newId: () => `msg-${++ids}`,
      retryMs: 1_000,
    });
  });

  afterEach(() => {
    outbox.dispose();
    vi.useRealTimers();
  });

  it("holds a message while its Shell is away and sends it only over that Shell's own session", async () => {
    const queued = outbox.enqueue(enrollment(), { text: "migration landed on feature/x" });
    expect(queued).toEqual({
      ok: true,
      value: { messageId: "msg-1", contextId: "msg-1", hopCount: 1, state: "waiting-for-hub" },
    });

    const other = fakeSession("link-b", () => accepted());
    connect(other);
    await settle();
    // Another Shell's session is never a route to this lane's hub.
    expect(other.calls).toEqual([]);
    expect(outbox.listSent(enrollment(), 0, 10).sent[0]!.state).toBe("waiting-for-hub");

    const mine = fakeSession("link-a", () => accepted());
    connect(mine);
    await settle();
    expect(mine.calls).toHaveLength(1);
    const { method, payload } = mine.calls[0]!;
    expect(method).toBe(AssistantLinkMethod.SEND_TO_HUB);
    expect(payload as SendToHubPayload).toEqual({
      messageId: "msg-1",
      contextId: "msg-1",
      referenceTaskIds: [],
      sourceLane: { projectId: "proj", slot: 1 },
      hopCount: 1,
      body: "migration landed on feature/x",
    });
    expect(outbox.listSent(enrollment(), 0, 10).sent[0]).toMatchObject({
      messageId: "msg-1",
      state: "submitted",
      refusal: null,
      replies: [],
    });
  });

  it("delivers again after a resume, which keeps the session id over a new link", async () => {
    const first = fakeSession("link-a", () => {
      throw Object.assign(new Error("gone"), { code: "HOST_DISCONNECTED" });
    });
    connect(first);
    outbox.enqueue(enrollment(), { text: "blocked on the schema" });
    await settle();
    expect(first.calls).toHaveLength(1);
    first.close();

    const resumed = fakeSession("link-a", () => accepted());
    connect(resumed);
    await settle();
    expect(resumed.calls.map((c) => c.method)).toEqual([AssistantLinkMethod.SEND_TO_HUB]);
    expect(outbox.listSent(enrollment(), 0, 10).sent[0]!.state).toBe("submitted");
  });

  it("retries a send whose answer was lost, under the same messageId", async () => {
    let attempts = 0;
    const shell = fakeSession("link-a", () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("lost"), { code: "OUTCOME_UNKNOWN" });
      return accepted();
    });
    connect(shell);
    outbox.enqueue(enrollment(), { text: "hello" });
    await settle();
    expect(outbox.listSent(enrollment(), 0, 10).sent[0]!.state).toBe("waiting-for-hub");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(shell.calls.map((c) => (c.payload as SendToHubPayload).messageId)).toEqual([
      "msg-1",
      "msg-1",
    ]);
    expect(outbox.listSent(enrollment(), 0, 10).sent[0]!.state).toBe("submitted");
  });

  it("waits out a rate limit before sending again", async () => {
    let attempts = 0;
    const shell = fakeSession("link-a", () =>
      ++attempts === 1 ? { status: "rate_limited", retryAfterMs: 5_000 } : accepted()
    );
    connect(shell);
    outbox.enqueue(enrollment(), { text: "hello" });
    await settle();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(shell.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(shell.calls).toHaveLength(2);
  });

  it("records a refusal, tells the lane, and gives the hop back", async () => {
    const shell = fakeSession("link-a", () => ({ status: "refused", refusal: "paused" }));
    connect(shell);
    outbox.enqueue(enrollment(), { text: "one", contextId: "ctx" });
    await settle();
    const [sent] = outbox.listSent(enrollment(), 0, 10).sent;
    expect(sent).toMatchObject({ state: "refused", refusal: "paused" });
    expect(wakes).toEqual([
      {
        lane: { projectId: "proj", slot: 1 },
        generation: "gen-1",
        shell: { kind: "remote", linkSessionId: "link-a" },
        messageId: "msg-1",
      },
    ]);
    // Never admitted, so the conversation can still take its full budget.
    shell.answer = () => accepted();
    const second = outbox.enqueue(enrollment(), { text: "two", contextId: "ctx" });
    expect(second.ok && second.value.hopCount).toBe(1);
  });

  it("reads a Shell from before the call as not supporting it", async () => {
    const shell = fakeSession("link-a", () => {
      throw Object.assign(new Error("Unknown method"), { code: "UNSUPPORTED" });
    });
    connect(shell);
    outbox.enqueue(enrollment(), { text: "hello" });
    await settle();
    expect(outbox.listSent(enrollment(), 0, 10).sent[0]).toMatchObject({
      state: "refused",
      refusal: "unsupported",
    });
  });

  it("counts hops per conversation and refuses past the limit", async () => {
    connect(fakeSession("link-a", () => accepted()));
    const first = outbox.enqueue(enrollment(), { text: "one", contextId: "ctx" });
    const second = outbox.enqueue(enrollment({ slot: 2, generation: "gen-2" }), {
      text: "two",
      contextId: "ctx",
    });
    expect(first.ok && first.value.hopCount).toBe(1);
    // Another lane enrolled by the same Shell shares the conversation's budget.
    expect(second.ok && second.value.hopCount).toBe(2);
    expect(outbox.enqueue(enrollment(), { text: "three", contextId: "ctx" })).toEqual({
      ok: false,
      code: "HOP_LIMIT",
    });
    expect(outbox.enqueue(enrollment(), { text: "fresh" }).ok).toBe(true);
  });

  it("reads the hub's replies when the Shell says they moved, fenced as data", async () => {
    const shell = fakeSession("link-a", () => accepted());
    connect(shell);
    outbox.enqueue(enrollment(), { text: "can studio-04 start?" });
    await settle();
    wakes = [];

    shell.answer = (method) =>
      method === AssistantLinkMethod.GET_HUB_EXCHANGE
        ? accepted({
            state: "completed",
            responses: [{ state: "completed", text: "yes, start ```now```", at: 5 }],
          })
        : accepted();
    // A Shell other than the one it went to can't make it look moved.
    const stranger = fakeSession("link-b", () => accepted());
    connect(stranger);
    stranger.tell(AssistantLinkMethod.HUB_EXCHANGE_CHANGED, { messageId: "msg-1" });
    await settle();
    expect(shell.calls.map((c) => c.method)).toEqual([AssistantLinkMethod.SEND_TO_HUB]);

    shell.tell(AssistantLinkMethod.HUB_EXCHANGE_CHANGED, { messageId: "msg-1" });
    await settle();
    const page = outbox.listSent(enrollment(), 0, 10);
    expect(page.sent[0]!.state).toBe("completed");
    expect(page.sent[0]!.replies).toHaveLength(1);
    expect(page.sent[0]!.replies[0]!.untrustedText).toContain("not instructions");
    expect(page.sent[0]!.replies[0]!.untrustedText).toContain("yes, start ```now```");
    expect(wakes.map((w) => w.messageId)).toEqual(["msg-1"]);
    // The cursor moves past what was read; nothing changed since.
    expect(outbox.listSent(enrollment(), page.cursor, 10).sent).toEqual([]);
  });

  it("reads a moved message again after a failed read, without another announcement", async () => {
    const shell = fakeSession("link-a", () => accepted());
    connect(shell);
    outbox.enqueue(enrollment(), { text: "hello" });
    await settle();
    let reads = 0;
    shell.answer = (method) => {
      if (method !== AssistantLinkMethod.GET_HUB_EXCHANGE) return accepted();
      if (++reads === 1) throw Object.assign(new Error("busy"), { code: "PERSIST_FAILED" });
      return accepted({
        state: "completed",
        responses: [{ state: "completed", text: "done", at: 3 }],
      });
    };
    shell.tell(AssistantLinkMethod.HUB_EXCHANGE_CHANGED, { messageId: "msg-1" });
    await settle();
    expect(outbox.listSent(enrollment(), 0, 10).sent[0]!.state).toBe("submitted");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads).toBe(2);
    expect(outbox.listSent(enrollment(), 0, 10).sent[0]!.state).toBe("completed");
  });

  it("keeps a row within one result, newest replies whole and older ones counted", async () => {
    const long = (n: number) => `${n}${"x".repeat(15_000)}`;
    const shell = fakeSession("link-a", () =>
      accepted({
        state: "input-required",
        responses: [1, 2, 3, 4].map((n) => ({
          state: "input-required" as const,
          text: long(n),
          at: n,
        })),
      })
    );
    connect(shell);
    outbox.enqueue(enrollment(), { text: "hello" });
    await settle();
    const page = outbox.listSent(enrollment(), 0, 10);
    const [row] = page.sent;
    expect(row!.replies.length).toBeGreaterThan(0);
    expect(row!.replies.length + row!.repliesOmitted).toBe(4);
    expect(row!.replies.at(-1)!.untrustedText).toContain(long(4));
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(50 * 1024);
  });

  it("reads open messages again when the Shell reconnects", async () => {
    const first = fakeSession("link-a", () => accepted());
    connect(first);
    outbox.enqueue(enrollment(), { text: "hello" });
    await settle();
    first.close();
    const back = fakeSession("link-a", () =>
      accepted({
        state: "input-required",
        responses: [{ state: "input-required", text: "which schema?", at: 9 }],
      })
    );
    connect(back);
    await settle();
    expect(back.calls.map((c) => c.method)).toEqual([AssistantLinkMethod.GET_HUB_EXCHANGE]);
    expect(outbox.listSent(enrollment(), 0, 10).sent[0]!.state).toBe("input-required");
  });

  it("refuses a lane its own Shell enrolled, a full queue and a body too large to hand over", () => {
    expect(outbox.enqueue(enrollment({ enrolledBy: { kind: "local" } }), { text: "x" })).toEqual({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
    for (let i = 0; i < OUTBOX_MAX_OPEN_PER_LANE; i++) {
      expect(outbox.enqueue(enrollment(), { text: `m${i}` }).ok).toBe(true);
    }
    expect(outbox.enqueue(enrollment(), { text: "one more" })).toEqual({
      ok: false,
      code: "OUTBOX_FULL",
    });
    expect(
      outbox.enqueue(enrollment({ generation: "gen-9" }), { text: "\u0001".repeat(15_000) })
    ).toEqual({ ok: false, code: "TOO_LARGE" });
  });

  it("forgets a lane's messages once its enrollment ends, and shows them to no other enrollment", async () => {
    outbox.enqueue(enrollment(), { text: "hello" });
    expect(outbox.listSent(enrollment({ generation: "gen-2" }), 0, 10).sent).toEqual([]);
    ended.add("gen-1");
    const shell = fakeSession("link-a", () => accepted());
    connect(shell);
    await settle();
    expect(shell.calls).toEqual([]);
    expect(outbox.listSent(enrollment(), 0, 10).sent).toEqual([]);
  });

  it("expires a message still waiting at its TTL", async () => {
    outbox.enqueue(enrollment(), { text: "hello" });
    vi.setSystemTime(Date.now() + EXCHANGE_TTL_MS);
    const [sent] = outbox.listSent(enrollment(), 0, 10).sent;
    expect(sent!.state).toBe("expired");
    const shell = fakeSession("link-a", () => accepted());
    connect(shell);
    await settle();
    expect(shell.calls).toEqual([]);
  });
});
