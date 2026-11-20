import { describe, expect, it } from "vitest";
import type { DecisionThreadAnswer, DecisionThreadMessage } from "@shared/types/decisionsQuestion";
import {
  choiceLabels,
  closureNoticeText,
  emptyEntryText,
  planHeading,
  positionText,
  questionStatusText,
  replyModeText,
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
      threadEntryHeading({ type: "declined", entryId: "d", sentAt: "2026-11-02T10:00:00.000Z" }),
    ]);
    expect(headings.size).toBe(8);
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
    expect(computer).toMatch(/^Answer .*computer/);
    expect(threadEntryHeading(answer({ onComputer: true, correction: true }))).toMatch(
      /^Correction .*computer/
    );
    // A model answer is the model's wherever it was signed.
    expect(threadEntryHeading(answer({ from: "model", onComputer: true }))).toBe(
      threadEntryHeading(answer({ from: "model" }))
    );
  });

  it("tells a question the person declined apart from one withdrawn, and from every other status (#17234)", () => {
    const declined = questionStatusText({ status: "cancelled", closedReason: "declined" });
    const others = (
      [
        ["queued", null],
        ["open", null],
        ["proxy-answered", null],
        ["human-answered", null],
        ["cancelled", "withdrawn"],
        ["expired", "expired"],
        ["publish-failed", null],
      ] as const
    ).map(([status, closedReason]) => questionStatusText({ status, closedReason }));
    expect(new Set(others).size).toBe(others.length);
    expect(others).not.toContain(declined);
  });

  it("names a follow-up sent from the computer, and the agent's request for a reply (#17238)", () => {
    const computer = threadEntryHeading(message({ from: "person", onComputer: true }));
    expect(computer).not.toBe(threadEntryHeading(message({ from: "person" })));
    expect(computer).toMatch(/computer/);
    // A Remote Host from before it doesn't say: its person's messages are a phone's.
    expect(threadEntryHeading(message({ from: "person", onComputer: undefined }))).toBe(
      threadEntryHeading(message({ from: "person", onComputer: false }))
    );
    const asking = threadEntryHeading(message({ from: "agent", expectsReply: true }));
    expect(asking).not.toBe(threadEntryHeading(message({ from: "agent" })));
    expect(asking).toMatch(/reply/);
  });

  it("says why an entry has nothing to read, and nothing when it does", () => {
    // A notice carries nothing to read, and isn't missing anything.
    expect(
      emptyEntryText({ type: "declined", entryId: "d", sentAt: "2026-11-02T10:00:00.000Z" })
    ).toBeNull();
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

  describe("rounds and closing notices (#17943)", () => {
    it("tells an advisory expiry, a withdrawal and a never-published question apart", () => {
      const texts = [
        questionStatusText({ status: "expired", closedReason: "expired", replyMode: "blocking" }),
        questionStatusText({ status: "expired", closedReason: "expired", replyMode: "advisory" }),
        questionStatusText({ status: "cancelled", closedReason: "withdrawn" }),
        questionStatusText({ status: "cancelled", closedReason: "declined" }),
        questionStatusText({ status: "publish-failed", closedReason: "never-published" }),
        questionStatusText({ status: "publish-failed", closedReason: null }),
      ];
      expect(new Set(texts).size).toBe(texts.length);
    });

    it("names the mode only where its machine said", () => {
      expect(replyModeText(undefined)).toBeNull();
      expect(replyModeText("advisory")).not.toBe(replyModeText("blocking"));
    });

    it("heads the plan by whether it can still come", () => {
      expect(planHeading("open")).toBe(planHeading("queued"));
      expect(planHeading("open")).not.toBe(planHeading("expired"));
    });

    it("says how far the closing notice got, and what an advisory one says of the plan", () => {
      expect(closureNoticeText({ closedReason: null, closureNotice: null })).toBeNull();
      // A withdrawal types nothing.
      expect(
        closureNoticeText({
          closedReason: "withdrawn",
          closureNotice: { delivery: "pending", disposition: null },
        })
      ).toBeNull();
      const delivered = closureNoticeText({
        closedReason: "expired",
        closureNotice: { delivery: "delivered", disposition: null },
      });
      expect(delivered).toMatch(/was typed into the terminal\.$/);
      const deliveries = (
        ["pending", "delivered", "uncertain", "needs-attention", "stopped"] as const
      ).map((delivery) =>
        closureNoticeText({
          closedReason: "declined",
          closureNotice: { delivery, disposition: null },
        })
      );
      expect(new Set(deliveries).size).toBe(deliveries.length);
      const due = closureNoticeText({
        closedReason: "expired",
        closureNotice: { delivery: "delivered", disposition: "fallback-due" },
      });
      const withheld = closureNoticeText({
        closedReason: "expired",
        closureNotice: { delivery: "pending", disposition: "fallback-withheld" },
      });
      expect(due).toMatch(/may go ahead/);
      expect(withheld).toMatch(/doesn't clear the agent/);
    });
  });
});
