import { describe, expect, it } from "vitest";
import { LIMITS } from "@daintreehq/decisions-protocol";
import type {
  DecisionQuestionReference,
  DecisionQuestionStanding,
  DecisionQuestionStatus,
  DecisionThreadAnswer,
  DecisionThreadEntry,
  DecisionThreadMessage,
} from "@shared/types/decisionsQuestion";
import {
  deliveryStalled,
  FOLLOW_UP_TEXT_BYTES,
  followUpAttemptText,
  followUpProgressText,
  followUpVerdict,
  replyRequest,
  takesFollowUp,
} from "../decisionFollowUpModel";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");

function message(over: Partial<DecisionThreadMessage> = {}): DecisionThreadMessage {
  return {
    type: "message",
    messageId: "m1",
    from: "agent",
    text: "Which region?",
    images: [],
    expectsReply: false,
    sentAt: "2026-11-02T11:00:00.000Z",
    deliveryStatus: null,
    unreadable: false,
    ...over,
  };
}

function answer(over: Partial<DecisionThreadAnswer> = {}): DecisionThreadAnswer {
  return {
    type: "answer",
    entryId: "a1",
    revision: 1,
    from: "person",
    onComputer: false,
    correction: false,
    confirmsModel: false,
    choices: [{ id: "yes", label: "Yes" }],
    text: null,
    reason: null,
    images: [],
    sentAt: "2026-11-02T11:30:00.000Z",
    unreadable: false,
    ...over,
  };
}

describe("takesFollowUp (#17238)", () => {
  it.each<[DecisionQuestionStatus, boolean]>([
    ["open", true],
    ["human-answered", true],
    ["proxy-answered", true],
    // Not with the relay yet, or never: a follow-up has nowhere to go.
    ["queued", false],
    ["publish-failed", false],
    ["cancelled", false],
    ["expired", false],
  ])("a question %s takes one: %s", (status, takes) => {
    expect(takesFollowUp({ status, expiresAt: null }, NOW)).toBe(takes);
  });

  it("stops an open question at its expiry, but never an answered one", () => {
    const past = "2026-11-02T11:59:59.000Z";
    expect(takesFollowUp({ status: "open", expiresAt: past }, NOW)).toBe(false);
    expect(takesFollowUp({ status: "open", expiresAt: "2026-11-02T12:00:01.000Z" }, NOW)).toBe(
      true
    );
    // The answer deadline says nothing about the thread once it was answered.
    expect(takesFollowUp({ status: "human-answered", expiresAt: past }, NOW)).toBe(true);
  });
});

describe("deliveryStalled (#18028)", () => {
  const reference: DecisionQuestionReference = {
    hostId: "host_1",
    projectId: "project-a",
    terminalId: "t1",
    questionId: "q1",
  };
  const stopped: DecisionQuestionStanding = {
    kind: "needs-attention",
    deliveryStatus: "needs-attention",
  };
  const uncertain: DecisionQuestionStanding = {
    kind: "needs-attention",
    deliveryStatus: "delivery-uncertain",
  };
  const handled: DecisionQuestionStanding = { kind: "settled", outcome: "answered", handled: true };

  it("holds while the list says the same question's delivery needs a person, stopped or uncertain", () => {
    expect(deliveryStalled({ reference }, { reference, standing: stopped })).toBe(true);
    expect(deliveryStalled({ reference }, { reference, standing: uncertain })).toBe(true);
  });

  it("ends once the list stops saying so, and holds nothing without the list", () => {
    expect(deliveryStalled({ reference }, { reference, standing: handled })).toBe(false);
    expect(deliveryStalled({ reference }, { reference, standing: { kind: "to-type" } })).toBe(
      false
    );
    expect(deliveryStalled({ reference }, null)).toBe(false);
  });

  it("never takes another question's stall, even one with the same id on another machine", () => {
    const elsewhere = { ...reference, hostId: "host_2" };
    expect(deliveryStalled({ reference }, { reference: elsewhere, standing: stopped })).toBe(false);
    const another = { ...reference, questionId: "q2" };
    expect(deliveryStalled({ reference }, { reference: another, standing: stopped })).toBe(false);
  });
});

describe("replyRequest", () => {
  const thread = (...entries: DecisionThreadEntry[]) => ({ thread: entries });

  it("is the agent's latest message while it asks for a reply and nothing came after it", () => {
    const asking = message({ messageId: "m2", expectsReply: true });
    expect(replyRequest(thread(message(), asking))).toBe(asking);
    expect(replyRequest(thread(asking, message({ messageId: "m3", from: "person" })))).toBeNull();
    // A later message of the agent's supersedes the request.
    expect(replyRequest(thread(asking, message({ messageId: "m3" })))).toBeNull();
    expect(replyRequest(thread(message()))).toBeNull();
    expect(replyRequest(thread())).toBeNull();
  });

  it("is answered by the person's answer, correction or confirmation after it, never the model's", () => {
    const asking = message({ messageId: "m2", expectsReply: true });
    expect(replyRequest(thread(answer(), asking))).toBe(asking);
    expect(replyRequest(thread(asking, answer({ entryId: "a2", correction: true })))).toBeNull();
    expect(replyRequest(thread(asking, answer({ entryId: "a2", confirmsModel: true })))).toBeNull();
    expect(replyRequest(thread(asking, answer({ entryId: "a2", from: "model" })))).toBe(asking);
  });
});

describe("followUpVerdict", () => {
  it("mirrors the protocol's bound on a message's words", () => {
    // Mirrored rather than imported, so the renderer doesn't take in the protocol's schemas.
    expect(FOLLOW_UP_TEXT_BYTES).toBe(LIMITS.messageTextBytes);
  });

  it("sends words within the bound, counted in UTF-8 bytes, and nothing blank", () => {
    expect(followUpVerdict("Keep the old icons.")).toEqual({
      canSend: true,
      hint: null,
      textOver: 0,
    });
    expect(followUpVerdict(" \n\t ")).toMatchObject({ canSend: false, hint: null });
    expect(followUpVerdict("é".repeat(FOLLOW_UP_TEXT_BYTES / 2))).toMatchObject({ canSend: true });
    const over = followUpVerdict("é".repeat(FOLLOW_UP_TEXT_BYTES / 2 + 1));
    expect(over).toMatchObject({ canSend: false, textOver: 2 });
    expect(over.hint).toBe("Shorten your follow-up by 2 bytes");
  });
});

describe("what the composer says", () => {
  it("names how far a follow-up got, from its thread entry once the relay took it", () => {
    const sent = { kind: "settled", outcome: { status: "sent" } } as const;
    expect(followUpProgressText(sent, { thread: [] }, "m1")).toBe("Follow-up sent");
    expect(
      followUpProgressText(
        sent,
        { thread: [message({ from: "person", deliveryStatus: "received" })] },
        "m1"
      )
    ).toBe("Follow-up sent. Waiting for it to be typed into the terminal…");
    expect(
      followUpProgressText(
        sent,
        { thread: [message({ from: "person", deliveryStatus: "terminal-delivered" })] },
        "m1"
      )
    ).toBe("Follow-up sent and typed into the terminal");
    // Its own entry, never another of the person's messages.
    expect(
      followUpProgressText(
        sent,
        {
          thread: [
            message({ messageId: "m0", from: "person", deliveryStatus: "terminal-delivered" }),
            message({ from: "person", deliveryStatus: "needs-attention" }),
          ],
        },
        "m1"
      )
    ).toMatch(/couldn't be typed in/);
    // Withdrawn with its question, or handled: kept in the thread, never typed.
    expect(
      followUpProgressText(
        sent,
        {
          thread: [message({ from: "person", deliveryStatus: "received", deliveryStopped: true })],
        },
        "m1"
      )
    ).toMatch(/won't be typed/);
    // Handled after an attempt that may have typed it: that stays said.
    expect(
      followUpProgressText(
        sent,
        {
          thread: [
            message({
              from: "person",
              deliveryStatus: "delivery-uncertain",
              deliveryStopped: true,
            }),
          ],
        },
        "m1"
      )
    ).toBe("Follow-up sent. It may or may not have been typed in, and it won't be tried again.");
    expect(
      followUpProgressText({ kind: "settled", outcome: { status: "queued" } }, { thread: [] }, "m1")
    ).toBe("Follow-up queued. It's sent once the relay can be reached.");
    expect(followUpProgressText({ kind: "lost" }, { thread: [] }, "m1")).toBe(
      "Couldn't confirm whether your follow-up was sent."
    );
  });

  it("says nothing was sent for every outcome that took nothing, naming what needs an update", () => {
    const said = (outcome: Parameters<typeof followUpAttemptText>[0]) =>
      followUpAttemptText(outcome);
    expect(said({ kind: "settled", outcome: { status: "sent" } })).toBeNull();
    expect(said({ kind: "settled", outcome: { status: "queued" } })).toBeNull();
    for (const outcome of [
      { status: "closed", reason: "expired" },
      { status: "closed", reason: "cancelled" },
      { status: "closed", reason: "not-found" },
      { status: "unsupported", by: "relay" },
      { status: "unsupported", by: "asking-desktop" },
      { status: "rejected", code: "invalid_state" },
    ] as const) {
      expect(said({ kind: "settled", outcome })).toMatch(/wasn't sent|nothing was sent/);
    }
    expect(said({ kind: "settled", outcome: { status: "unsupported", by: "relay" } })).toContain(
      "relay needs an update"
    );
    expect(
      said({ kind: "settled", outcome: { status: "unsupported", by: "asking-desktop" } })
    ).toContain("computer that asked needs an update");
    for (const reason of ["not-found", "not-owner", "invalid", "off"] as const) {
      expect(said({ kind: "refused", reason })).toMatch(/nothing was sent/);
    }
    // Each says its own reason.
    const closed = (["expired", "cancelled", "not-found"] as const).map((reason) =>
      said({ kind: "settled", outcome: { status: "closed", reason } })
    );
    expect(new Set(closed).size).toBe(3);
    expect(
      said({ kind: "settled", outcome: { status: "rejected", code: "rate_limited" } })
    ).toContain("rate_limited");
  });
});
