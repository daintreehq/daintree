import { describe, expect, it } from "vitest";
import type { DecisionQuestionStanding } from "../../types/decisionsQuestion.js";
import {
  awaitsPerson,
  deliveryNeedsPerson,
  isWaitingOnPerson,
  needsPerson,
  stoppedDeliveries,
} from "../decisionWaiting.js";

const STANDINGS: DecisionQuestionStanding[] = [
  { kind: "waiting", reason: "open" },
  { kind: "waiting", reason: "reply" },
  { kind: "queued" },
  { kind: "send-failed" },
  { kind: "to-type" },
  { kind: "needs-attention", deliveryStatus: "needs-attention" },
  { kind: "needs-attention", deliveryStatus: "delivery-uncertain" },
  { kind: "settled", outcome: "answered", handled: false },
  { kind: "settled", outcome: "answered", handled: true },
  { kind: "settled", outcome: "withdrawn" },
  { kind: "settled", outcome: "expired" },
  { kind: "settled", outcome: "declined" },
];

describe("isWaitingOnPerson", () => {
  it("takes an open, replied-to or queued question and nothing else", () => {
    expect(STANDINGS.filter(awaitsPerson)).toEqual([
      { kind: "waiting", reason: "open" },
      { kind: "waiting", reason: "reply" },
      { kind: "queued" },
    ]);
  });

  it("leaves out what the person has seen or cleared", () => {
    const queued: DecisionQuestionStanding = { kind: "queued" };
    expect(isWaitingOnPerson({ standing: queued })).toBe(true);
    expect(
      isWaitingOnPerson({ standing: queued, inbox: { ask: "m1", seen: false, cleared: false } })
    ).toBe(true);
    expect(
      isWaitingOnPerson({ standing: queued, inbox: { ask: null, seen: true, cleared: false } })
    ).toBe(false);
    expect(
      isWaitingOnPerson({ standing: queued, inbox: { ask: null, seen: false, cleared: true } })
    ).toBe(false);
  });

  it("leaves out a question whose deadline passed by the clock, queued included", () => {
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    const expiresAt = "2026-11-20T11:59:00.000Z";
    expect(isWaitingOnPerson({ standing: { kind: "queued" }, expiresAt }, now)).toBe(false);
    expect(
      isWaitingOnPerson({ standing: { kind: "waiting", reason: "open" }, expiresAt }, now)
    ).toBe(false);
    expect(
      isWaitingOnPerson({ standing: { kind: "waiting", reason: "reply" }, expiresAt }, now)
    ).toBe(true);
    expect(isWaitingOnPerson({ standing: { kind: "queued" }, expiresAt }, null)).toBe(true);
    const ahead = "2026-11-20T12:01:00.000Z";
    expect(isWaitingOnPerson({ standing: { kind: "queued" }, expiresAt: ahead }, now)).toBe(true);
    expect(
      isWaitingOnPerson({ standing: { kind: "waiting", reason: "open" }, expiresAt: ahead }, now)
    ).toBe(true);
  });
});

describe("deliveryNeedsPerson (#18045)", () => {
  it("takes an answer or follow-up delivery stopped on, typed in or not, and nothing else", () => {
    expect(STANDINGS.filter(deliveryNeedsPerson)).toEqual([
      { kind: "needs-attention", deliveryStatus: "needs-attention" },
      { kind: "needs-attention", deliveryStatus: "delivery-uncertain" },
    ]);
  });
});

describe("stoppedDeliveries (#18045)", () => {
  const stopped: DecisionQuestionStanding = {
    kind: "needs-attention",
    deliveryStatus: "needs-attention",
  };
  const stall = (answerRevision: number | null, followUpIds: string[]) => ({
    answerRevision,
    followUpIds,
    reason: "pane_gone",
  });

  it("counts the answer and each follow-up delivery stopped on", () => {
    expect(stoppedDeliveries({ standing: stopped, stall: stall(2, ["f1", "f2"]) })).toBe(3);
    // Revision 0 is an answer like any other.
    expect(stoppedDeliveries({ standing: stopped, stall: stall(0, []) })).toBe(1);
    expect(stoppedDeliveries({ standing: stopped, stall: stall(null, ["f1", "f2"]) })).toBe(2);
  });

  it("counts one stop where the list carries no detail", () => {
    expect(stoppedDeliveries({ standing: stopped, stall: null })).toBe(1);
    expect(stoppedDeliveries({ standing: stopped })).toBe(1);
    expect(stoppedDeliveries({ standing: stopped, stall: stall(null, []) })).toBe(1);
  });

  it("counts nothing for a question not waiting on a stopped delivery", () => {
    for (const standing of STANDINGS.filter((each) => !deliveryNeedsPerson(each))) {
      expect(stoppedDeliveries({ standing, stall: stall(1, ["f1"]) }), standing.kind).toBe(0);
    }
  });
});

describe("needsPerson (#18045)", () => {
  it("takes a question to answer or a stopped delivery, and nothing else", () => {
    expect(STANDINGS.filter((standing) => needsPerson({ standing }))).toEqual([
      { kind: "waiting", reason: "open" },
      { kind: "waiting", reason: "reply" },
      { kind: "queued" },
      { kind: "needs-attention", deliveryStatus: "needs-attention" },
      { kind: "needs-attention", deliveryStatus: "delivery-uncertain" },
    ]);
    // A question to answer the person has already seen still leaves nothing to do.
    expect(
      needsPerson({
        standing: { kind: "queued" },
        inbox: { ask: null, seen: true, cleared: false },
      })
    ).toBe(false);
  });

  it("keeps a stopped delivery past its question's deadline, and drops an elapsed ask", () => {
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    const expiresAt = "2026-11-20T11:59:00.000Z";
    const stopped: DecisionQuestionStanding = {
      kind: "needs-attention",
      deliveryStatus: "needs-attention",
    };
    expect(needsPerson({ standing: stopped, expiresAt }, now)).toBe(true);
    expect(needsPerson({ standing: { kind: "waiting", reason: "open" }, expiresAt }, now)).toBe(
      false
    );
  });
});
