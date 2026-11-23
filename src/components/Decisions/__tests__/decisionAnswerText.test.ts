import { describe, expect, it } from "vitest";
import type {
  DecisionQuestionContent,
  DecisionThreadAnswer,
} from "@shared/types/decisionsQuestion";
import { progressText } from "../decisionAnswerText";

function answer(entryId: string, delivered?: boolean): DecisionThreadAnswer {
  return {
    type: "answer",
    entryId,
    revision: 1,
    from: "person",
    onComputer: entryId === "mine",
    correction: entryId !== "mine",
    confirmsModel: false,
    choices: [],
    text: "Hold",
    reason: null,
    images: [],
    sentAt: "2026-11-02T10:02:00.000Z",
    unreadable: false,
    ...(delivered !== undefined ? { delivered } : {}),
  };
}

function question(
  thread: DecisionThreadAnswer[],
  deliveryStatus: DecisionQuestionContent["deliveryStatus"]
): DecisionQuestionContent {
  return {
    questionId: "q1",
    alias: 1,
    terminalId: "t1",
    reference: { hostId: "h", projectId: "p", terminalId: "t1", questionId: "q1" },
    revision: 2,
    question: "Ship it?",
    context: null,
    kind: "text",
    options: [],
    allowText: true,
    requirement: "human-required",
    askedAt: "2026-11-02T10:00:00.000Z",
    expiresAt: null,
    status: "human-answered",
    closedReason: null,
    deliveryStatus,
    attachments: [],
    thread,
  };
}

const SENT = { kind: "settled", outcome: { status: "sent" } } as const;

describe("progressText (#17943)", () => {
  it("reads this answer's own delivery, not a later correction's", () => {
    // Typed in, then corrected from a phone while the terminal was away.
    const typed = question([answer("mine", true), answer("phone", false)], "desktop-received");
    expect(progressText(SENT, typed, "mine")).toMatch(/typed into the terminal$/);
    const replaced = question(
      [answer("mine", false), answer("phone", false)],
      "terminal-delivered"
    );
    expect(progressText(SENT, replaced, "mine")).toMatch(/later answer came after it/);
  });

  it("follows the question's delivery for the latest answer, and for a Host from before it", () => {
    expect(
      progressText(SENT, question([answer("mine", false)], "desktop-received"), "mine")
    ).toMatch(/Waiting for it to be typed/);
    expect(progressText(SENT, question([answer("mine")], "terminal-delivered"), "mine")).toMatch(
      /typed into the terminal$/
    );
  });
});
