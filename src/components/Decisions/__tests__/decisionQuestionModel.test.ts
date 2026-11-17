import { describe, expect, it } from "vitest";
import type { DecisionThreadAnswer, DecisionThreadMessage } from "@shared/types/decisionsQuestion";
import {
  choiceLabels,
  emptyEntryText,
  positionText,
  threadEntryHeading,
} from "../decisionQuestionModel";

function answer(over: Partial<DecisionThreadAnswer> = {}): DecisionThreadAnswer {
  return {
    type: "answer",
    entryId: "a1",
    revision: 1,
    from: "person",
    onComputer: false,
    correction: false,
    confirmsModel: false,
    choices: [],
    text: null,
    reason: null,
    images: [],
    sentAt: "2026-11-02T10:00:00.000Z",
    unreadable: false,
    ...over,
  };
}

function message(over: Partial<DecisionThreadMessage> = {}): DecisionThreadMessage {
  return {
    type: "message",
    messageId: "m1",
    from: "agent",
    text: "More detail",
    images: [],
    expectsReply: false,
    sentAt: "2026-11-02T10:00:00.000Z",
    deliveryStatus: null,
    unreadable: false,
    ...over,
  };
}

describe("decisionQuestionModel", () => {
  it("names a choice by its label when chosen, else the option's, else its id", () => {
    const options = [
      { id: "a", label: "Renamed A", description: null },
      { id: "b", label: "Option B", description: null },
    ];
    const labels = choiceLabels(
      answer({
        choices: [
          { id: "a", label: "Chosen A" },
          { id: "b", label: null },
          { id: "gone", label: null },
        ],
      }),
      options
    );
    expect(labels).toEqual(["Chosen A", "Option B", "gone"]);
  });

  it("tells answers apart by who sent them and what they did", () => {
    const headings = new Set([
      threadEntryHeading(answer()),
      threadEntryHeading(answer({ correction: true })),
      threadEntryHeading(answer({ confirmsModel: true })),
      threadEntryHeading(answer({ from: "model" })),
      threadEntryHeading(message({ from: "person" })),
      threadEntryHeading(message({ from: "agent" })),
      threadEntryHeading({ type: "expired", entryId: "e", sentAt: "2026-11-02T10:00:00.000Z" }),
    ]);
    expect(headings.size).toBe(7);
    expect(threadEntryHeading(message({ from: "person" }))).not.toBe(
      threadEntryHeading(message({ from: "agent" }))
    );
    // A confirmation of the model's answer reads as one even when it also corrects.
    expect(threadEntryHeading(answer({ confirmsModel: true, correction: true }))).toBe(
      threadEntryHeading(answer({ confirmsModel: true }))
    );
    // The model's own answer is never attributed to a person.
    expect(threadEntryHeading(answer({ from: "model", confirmsModel: true }))).toBe(
      threadEntryHeading(answer({ from: "model" }))
    );
  });

  it("names an answer given on the computer apart from a phone's (#17102)", () => {
    const computer = threadEntryHeading(answer({ onComputer: true }));
    expect(computer).not.toBe(threadEntryHeading(answer()));
    expect(computer).toMatch(/computer/);
    expect(threadEntryHeading(answer({ onComputer: true, correction: true }))).not.toBe(computer);
    // A model answer is the model's wherever it was signed.
    expect(threadEntryHeading(answer({ from: "model", onComputer: true }))).toBe(
      threadEntryHeading(answer({ from: "model" }))
    );
  });

  it("says why an entry has nothing to read, and nothing when it does", () => {
    expect(emptyEntryText(answer({ text: "Yes" }))).toBeNull();
    expect(emptyEntryText(answer({ choices: [{ id: "a", label: "A" }] }))).toBeNull();
    // Unreadable wins over words that may be left over, and reads differently from an empty entry.
    const unreadable = emptyEntryText(message({ unreadable: true, text: "leftover" }));
    expect(unreadable).not.toBeNull();
    expect(unreadable).not.toBe(emptyEntryText(message({ text: null })));
    const imagesOnly = emptyEntryText(
      message({
        text: null,
        images: [{ attachmentId: "i", alt: null, mime: "image/png", size: 1 }],
      })
    );
    const nothing = emptyEntryText(message({ text: null }));
    expect(imagesOnly).not.toBeNull();
    expect(nothing).not.toBeNull();
    expect(imagesOnly).not.toBe(nothing);
  });

  it("gives a position only when there is more than one question", () => {
    expect(positionText(0, 1)).toBeNull();
    expect(positionText(1, 3)).toBe("2 of 3");
  });
});
