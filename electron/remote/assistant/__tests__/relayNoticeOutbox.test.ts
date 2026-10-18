import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayedNotice } from "../../../services/mcp-server/terminalNotify.js";
import type { LinkSession } from "../../link/session.js";
import type { MetricsSessionContext } from "../../metrics/hostMetricsHost.js";
import { AssistantLinkMethod, type RelayNoticesPayload } from "../linkMethods.js";
import {
  MAX_RELAY_NOTICES_PER_LINK,
  RELAY_NOTICE_TTL_MS,
  RelayNoticeOutbox,
} from "../relayNoticeOutbox.js";

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
    ctx: { session: session as unknown as LinkSession, sessionId, client: {} } as MetricsSessionContext,
  };
}

function harness() {
  const sessions: MetricsSessionContext[] = [];
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
    newId: () => `notice-${++nextId}`,
  });
  return {
    outbox,
    attach: (ctx: MetricsSessionContext) => {
      sessions.push(ctx);
      onSession(ctx);
    },
    detach: (ctx: MetricsSessionContext) => {
      sessions.splice(sessions.indexOf(ctx), 1);
    },
  };
}

const notice = (linkSessionId = "link-1", terminalId = "t-1"): RelayedNotice => ({
  linkSessionId,
  helpSessionId: "help-1",
  callId: "call-1",
  terminalId,
  observation: { kind: "state", state: "waiting", waitingReason: "prompt", handback: false },
});

describe("RelayNoticeOutbox (#13500)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends at once over the link the call came in on, observations only", async () => {
    const h = harness();
    const link = fakeSession("link-1");
    const other = fakeSession("link-2");
    h.attach(link.ctx);
    h.attach(other.ctx);
    h.outbox.enqueue([notice()]);
    await vi.advanceTimersByTimeAsync(0);

    expect(link.payloads).toEqual([
      {
        notices: [
          {
            noticeId: "notice-1",
            helpSessionId: "help-1",
            callId: "call-1",
            terminalId: "t-1",
            observation: { kind: "state", state: "waiting", waitingReason: "prompt", handback: false },
          },
        ],
      },
    ]);
    expect(other.payloads).toEqual([]);
    h.outbox.dispose();
  });

  it("holds a notice raised while the link is away and sends it when the session resumes", async () => {
    const h = harness();
    h.outbox.enqueue([notice()]);
    await vi.advanceTimersByTimeAsync(60_000);

    const resumed = fakeSession("link-1");
    h.attach(resumed.ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(resumed.payloads.flatMap((p) => p.notices.map((n) => n.noticeId))).toEqual(["notice-1"]);
    h.outbox.dispose();
  });

  it("drops a notice once the grace a dropped link has to resume is over", async () => {
    const h = harness();
    h.outbox.enqueue([notice()]);
    await vi.advanceTimersByTimeAsync(RELAY_NOTICE_TTL_MS + 1);

    const resumed = fakeSession("link-1");
    h.attach(resumed.ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(resumed.payloads).toEqual([]);
    h.outbox.dispose();
  });

  it("drops what waits for a link that ended, and queues nothing more for it", async () => {
    const h = harness();
    h.outbox.enqueue([notice()]);
    h.outbox.endLink("link-1");
    h.outbox.enqueue([notice()]);

    const later = fakeSession("link-1");
    h.attach(later.ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(later.payloads).toEqual([]);
    h.outbox.dispose();
  });

  it("sends again under the same ids when an answer is lost", async () => {
    const h = harness();
    const link = fakeSession("link-1");
    link.answers.push(() => Promise.reject(Object.assign(new Error("lost"), { code: "OUTCOME_UNKNOWN" })));
    h.attach(link.ctx);
    h.outbox.enqueue([notice()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(link.payloads).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(link.payloads).toHaveLength(2);
    expect(link.payloads[1]!.notices[0]!.noticeId).toBe(link.payloads[0]!.notices[0]!.noticeId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(link.payloads).toHaveLength(2);
    h.outbox.dispose();
  });

  it("gives up on a Shell that can't take notices", async () => {
    const h = harness();
    const link = fakeSession("link-1");
    link.answers.push(() => Promise.reject(Object.assign(new Error("old"), { code: "UNSUPPORTED" })));
    h.attach(link.ctx);
    h.outbox.enqueue([notice()]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(link.payloads).toHaveLength(1);
    h.outbox.dispose();
  });

  it("keeps the newest of a link's notices past its bound", async () => {
    const h = harness();
    h.outbox.enqueue(
      Array.from({ length: MAX_RELAY_NOTICES_PER_LINK + 2 }, (_, i) => notice("link-1", `t-${i}`))
    );
    const link = fakeSession("link-1");
    h.attach(link.ctx);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    const sent = link.payloads.flatMap((p) => p.notices.map((n) => n.terminalId));
    expect(sent).toHaveLength(MAX_RELAY_NOTICES_PER_LINK);
    expect(sent[0]).toBe("t-2");
    h.outbox.dispose();
  });
});
