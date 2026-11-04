import { describe, expect, it } from "vitest";
import type {
  DecisionsAttentionItem,
  DecisionsFollowUpPreview,
} from "@shared/types/decisionsAttention";
import { canCopy, copyLabel, outcomeText, statusText, subjectOf } from "../decisionsAttentionModel";

function followUp(over: Partial<DecisionsFollowUpPreview> = {}): DecisionsFollowUpPreview {
  return {
    messageId: "message-1",
    status: "needs-attention",
    reason: "pane_gone",
    text: "Keep the old icons.",
    unreadable: false,
    sentAt: "2026-11-01T10:00:00.000Z",
    ...over,
  };
}

const ANSWER: DecisionsAttentionItem["answer"] = {
  source: "human",
  choices: ["Approve"],
  text: null,
  correction: false,
  answeredAt: "2026-11-01T09:00:00.000Z",
};

type Fields = Pick<DecisionsAttentionItem, "status" | "answer" | "answerUnavailable" | "followUps">;

function item(over: Partial<Fields> = {}): Fields {
  return {
    status: "needs-attention",
    answer: ANSWER,
    answerUnavailable: null,
    followUps: [],
    ...over,
  };
}

describe("follow-ups in the needs-attention list (#16231)", () => {
  it("names what of the question needs a person", () => {
    expect(subjectOf(item())).toBe("answer");
    expect(subjectOf(item({ answer: null, answerUnavailable: "unreadable" }))).toBe("answer");
    expect(subjectOf(item({ answer: null, followUps: [followUp()] }))).toBe("follow-up");
    expect(subjectOf(item({ answer: null, followUps: [followUp(), followUp()] }))).toBe(
      "follow-ups"
    );
    expect(subjectOf(item({ followUps: [followUp()] }))).toBe("answer and follow-up");
    expect(subjectOf(item({ followUps: [followUp(), followUp()] }))).toBe("answer and follow-ups");
  });

  it("says what needs attention, or may have been delivered, in agreement with it", () => {
    expect(statusText(item())).toBe("Answer needs attention");
    expect(statusText(item({ answer: null, followUps: [followUp(), followUp()] }))).toBe(
      "Follow-ups need attention"
    );
    expect(
      statusText(
        item({
          status: "delivery-uncertain",
          answer: null,
          followUps: [followUp({ status: "delivery-uncertain" })],
        })
      )
    ).toBe("This follow-up may or may not have been delivered");
  });

  it("copies only when everything that needs a person can be opened", () => {
    expect(canCopy(item())).toBe(true);
    expect(canCopy(item({ answer: null, followUps: [followUp({ text: null })] }))).toBe(true);
    expect(canCopy(item({ answer: null, answerUnavailable: "unreadable" }))).toBe(false);
    expect(
      canCopy(item({ answer: null, followUps: [followUp({ text: null, unreadable: true })] }))
    ).toBe(false);
    expect(canCopy(item({ followUps: [followUp({ unreadable: true })] }))).toBe(false);
    expect(copyLabel(item({ followUps: [followUp()] }))).toBe("Copy answer and follow-up");
  });

  it("tells what became of a follow-up, in agreement with how many there were", () => {
    const delivered = { result: "delivered", terminalId: "pane-1", title: "Claude" } as const;
    expect(outcomeText(4, delivered, "follow-up")).toBe("Follow-up to q-4 typed into “Claude”");
    expect(
      outcomeText(
        4,
        { result: "waiting", terminalId: "p", title: null, waitsFor: "idle" },
        "follow-ups"
      )
    ).toBe("Follow-ups to q-4 go to its terminal, typed in once it's idle");
    expect(
      outcomeText(
        4,
        { result: "needs-attention", status: "needs-attention", reason: "pane_gone" },
        "answer and follow-ups"
      )
    ).toBe("Answer and follow-ups to q-4 weren't typed in and still need attention");
    expect(outcomeText(4, { result: "refused", reason: "uncertain" }, "follow-up")).toBe(
      "Follow-up to q-4 may already have been typed in, so it isn't typed again"
    );
    // An answer alone reads as it always has.
    expect(outcomeText(4, delivered)).toBe("Answer to q-4 typed into “Claude”");
  });
});
