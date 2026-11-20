import { describe, expect, it } from "vitest";
import type { DecisionQuestionStanding } from "../../types/decisionsQuestion.js";
import { awaitsPerson, isWaitingOnPerson } from "../decisionWaiting.js";

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
