import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayedNotice } from "../../../services/mcp-server/terminalNotify.js";
import type { LinkSession } from "../../link/session.js";
import type { MetricsSessionContext } from "../../metrics/hostMetricsHost.js";
import { AssistantLinkMethod, type RelayNoticesPayload } from "../linkMethods.js";
import {
  MAX_RELAY_NOTICES_PER_SENDER,
  RELAY_NOTICE_TTL_MS,
  RelayNoticeOutbox,
} from "../relayNoticeOutbox.js";
import { SenderSessions } from "../senderSessions.js";

type Answer = () => Promise<unknown>;

/** A link session the host can call the Shell over; each call takes the next queued answer. */
function fakeSession(sessionId: string) {
  const payloads: RelayNoticesPayload[] = [];
  const answers: Answer[] = [];
  const session = {
    isOpen: true,
    call: vi.fn(async (method: string, payload: RelayNoticesPayload) => {
      expect(method).toBe(AssistantLinkMethod.RELAY_NOTICES);
      payloads.push(payload);
      return (answers.shift() ?? (async () => null))();
    }),
  };
  return {
    session,
    payloads,
    answers,
    ctx: {
      session: session as unknown as LinkSession,
      sessionId,
      client: {},
    } as MetricsSessionContext,
  };
}

function harness() {
  const sessions: MetricsSessionContext[] = [];
  const senders = new SenderSessions();
  let onSession: (ctx: MetricsSessionContext) => void = () => {};
  let nextId = 0;
  const outbox = new RelayNoticeOutbox({
    server: {
      sessions,
      onSession: (listener) => {
        onSession = listener;
        return () => {};
      },
    },
    senders: () => senders,
    newId: () => `notice-${++nextId}`,
  });
  return {
    outbox,
    senders,
    /** A session that attaches having proved `senderId`, or none yet. */
    attach: (ctx: MetricsSessionContext, senderId: string | null = "sender-a") => {
      if (senderId !== null) senders.bind(ctx.session, senderId, ctx.sessionId);
      sessions.push(ctx);
      onSession(ctx);
    },
    detach: (ctx: MetricsSessionContext) => {
      sessions.splice(sessions.indexOf(ctx), 1);
    },
  };
}

/** The host's `lastStateChange` for the state a notice reports, on the host's clock. */
const TRANSITION_AT = Date.parse("2026-10-18T09:58:12.345Z");

const notice = (terminalId = "t-1", callId = "call-1"): RelayedNotice => ({
  helpSessionId: "help-1",
  callId,
  terminalId,
  observation: { kind: "state", state: "waiting", waitingReason: "prompt", handback: false },
  lastTransitionAt: TRANSITION_AT,
});

const sentIds = (payloads: RelayNoticesPayload[]) =>
  payloads.flatMap((p) => p.notices.map((n) => n.noticeId));

describe("RelayNoticeOutbox (#13500, #13930)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends at once over a session that proved the call's sender, observations only", async () => {
    const h = harness();
    const link = fakeSession("link-1");
    const other = fakeSession("link-2");
    h.attach(link.ctx, "sender-a");
    h.attach(other.ctx, "sender-b");
    h.outbox.enqueue("sender-a", [notice()]);
    await vi.advanceTimersByTimeAsync(0);

    expect(link.payloads).toEqual([
      {
        notices: [
          {
            noticeId: "notice-1",
            helpSessionId: "help-1",
            callId: "call-1",
            terminalId: "t-1",
            observation: {
              kind: "state",
              state: "waiting",
              waitingReason: "prompt",
              handback: false,
            },
            lastTransitionAt: TRANSITION_AT,
          },
        ],
      },
    ]);
    expect(other.payloads).toEqual([]);
    h.outbox.dispose();
  });

  it("sends nothing over a session that hasn't proved a sender", async () => {
    const h = harness();
    const anonymous = fakeSession("link-1");
    h.attach(anonymous.ctx, null);
    h.outbox.enqueue("sender-a", [notice()]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(anonymous.payloads).toEqual([]);
    h.outbox.dispose();
  });

  it("holds a notice raised while the link is away and sends it when the session resumes", async () => {
    const h = harness();
    const first = fakeSession("link-1");
    h.attach(first.ctx);
    h.detach(first.ctx);
    h.outbox.enqueue("sender-a", [notice()]);
    await vi.advanceTimersByTimeAsync(60_000);

    // A resumed transport is a new session object; its id carries the sender it proved.
    const resumed = fakeSession("link-1");
    h.attach(resumed.ctx, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(sentIds(resumed.payloads)).toEqual(["notice-1"]);
    h.outbox.dispose();
  });

  it("sends what waited over the Shell's next session once it proves the sender (#13930)", async () => {
    const h = harness();
    h.outbox.enqueue("sender-a", [notice()]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    const next = fakeSession("link-2");
    h.attach(next.ctx, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(next.payloads).toEqual([]);

    h.senders.bind(next.ctx.session, "sender-a", "link-2");
    h.outbox.flushSender("sender-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(sentIds(next.payloads)).toEqual(["notice-1"]);
    h.outbox.dispose();
  });

  it("drops a notice once its Shell no longer takes it", async () => {
    const h = harness();
    h.outbox.enqueue("sender-a", [notice()]);
    expect([...h.outbox.waitingCalls("sender-a", "help-1")]).toEqual(["call-1"]);
    await vi.advanceTimersByTimeAsync(RELAY_NOTICE_TTL_MS + 1);
    expect([...h.outbox.waitingCalls("sender-a", "help-1")]).toEqual([]);

    const later = fakeSession("link-1");
    h.attach(later.ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(later.payloads).toEqual([]);
    h.outbox.dispose();
  });

  it("names the calls with notices waiting, by sender and help session", () => {
    const h = harness();
    h.outbox.enqueue("sender-a", [notice("t-1", "call-1"), notice("t-2", "call-2")]);
    h.outbox.enqueue("sender-b", [notice("t-3", "call-3")]);
    expect([...h.outbox.waitingCalls("sender-a", "help-1")].sort()).toEqual(["call-1", "call-2"]);
    expect([...h.outbox.waitingCalls("sender-a", "help-2")]).toEqual([]);
    expect([...h.outbox.waitingCalls("sender-b", "help-1")]).toEqual(["call-3"]);
    h.outbox.dispose();
  });

  it("sends again under the same ids when an answer is lost, over whichever session is open", async () => {
    const h = harness();
    const link = fakeSession("link-1");
    link.answers.push(() =>
      Promise.reject(Object.assign(new Error("lost"), { code: "OUTCOME_UNKNOWN" }))
    );
    h.attach(link.ctx);
    const queued = notice();
    h.outbox.enqueue("sender-a", [queued]);
    // Whatever becomes of the object handed in, the queued notice keeps what it said.
    queued.lastTransitionAt = 0;
    await vi.advanceTimersByTimeAsync(0);
    expect(link.payloads).toHaveLength(1);

    h.detach(link.ctx);
    const next = fakeSession("link-2");
    h.attach(next.ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(sentIds(next.payloads)).toEqual(sentIds(link.payloads));
    // The resend reports the state it was queued with, not whatever is current now.
    expect(next.payloads[0]!.notices[0]!.lastTransitionAt).toBe(TRANSITION_AT);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(next.payloads).toHaveLength(1);
    h.outbox.dispose();
  });

  it("sends a notice no transition matches with null, not a time of its own", async () => {
    const h = harness();
    const link = fakeSession("link-1");
    h.attach(link.ctx);
    h.outbox.enqueue("sender-a", [
      { ...notice(), observation: { kind: "closed" }, lastTransitionAt: null },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(link.payloads[0]!.notices[0]!.lastTransitionAt).toBeNull();
    h.outbox.dispose();
  });

  it("gives up on a Shell that can't take notices", async () => {
    const h = harness();
    const link = fakeSession("link-1");
    link.answers.push(() =>
      Promise.reject(Object.assign(new Error("old"), { code: "UNSUPPORTED" }))
    );
    h.attach(link.ctx);
    h.outbox.enqueue("sender-a", [notice()]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(link.payloads).toHaveLength(1);
    h.outbox.dispose();
  });

  it("never crowds out a notice that is out to the Shell now, and says which it did", async () => {
    const sessions: MetricsSessionContext[] = [];
    const senders = new SenderSessions();
    const dropped: string[] = [];
    let nextId = 0;
    const outbox = new RelayNoticeOutbox({
      server: { sessions, onSession: () => () => {} },
      senders: () => senders,
      newId: () => `notice-${++nextId}`,
      onDropped: (_senderId, notices) => dropped.push(...notices.map((n) => n.callId)),
    });
    const link = fakeSession("link-1");
    link.answers.push(() => new Promise(() => {}));
    senders.bind(link.ctx.session, "sender-a", "link-1");
    sessions.push(link.ctx);

    outbox.enqueue("sender-a", [notice("t-0", "out-now")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(link.payloads).toHaveLength(1);
    outbox.enqueue(
      "sender-a",
      Array.from({ length: MAX_RELAY_NOTICES_PER_SENDER }, (_, i) =>
        notice(`t-${i + 1}`, `later-${i}`)
      )
    );

    expect(dropped).toEqual(["later-0"]);
    expect(outbox.waitingCalls("sender-a", "help-1").has("out-now")).toBe(true);
    outbox.dispose();
  });

  it("keeps the newest of a sender's notices past its bound", async () => {
    const h = harness();
    h.outbox.enqueue(
      "sender-a",
      Array.from({ length: MAX_RELAY_NOTICES_PER_SENDER + 2 }, (_, i) => notice(`t-${i}`))
    );
    const link = fakeSession("link-1");
    h.attach(link.ctx);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    const sent = link.payloads.flatMap((p) => p.notices.map((n) => n.terminalId));
    expect(sent).toHaveLength(MAX_RELAY_NOTICES_PER_SENDER);
    expect(sent[0]).toBe("t-2");
    h.outbox.dispose();
  });
});
