import { describe, expect, it } from "vitest";
import { LIMITS } from "@daintreehq/decisions-protocol";
import type {
  DecisionQuestionAttachment,
  DecisionQuestionContent,
} from "@shared/types/decisionsQuestion";
import {
  ANSWER_TEXT_BYTES,
  answerPayload,
  composeShape,
  composeVerdict,
  isAnswerable,
  reviewedDigests,
  type ComposeInput,
} from "../decisionComposeModel";

const OPTIONS = [
  { id: "a", label: "A", description: null },
  { id: "b", label: "B", description: null },
];

function image(id: string): DecisionQuestionAttachment {
  return {
    attachmentId: id,
    role: "after",
    alt: null,
    mime: "image/png",
    size: 10,
    sha256: id.repeat(64).slice(0, 64),
  };
}

function question(over: Partial<DecisionQuestionContent> = {}): DecisionQuestionContent {
  return {
    questionId: "q1",
    alias: 1,
    terminalId: "t1",
    reference: { hostId: "h", projectId: "p", terminalId: "t1", questionId: "q1" },
    revision: 3,
    question: "Which?",
    context: null,
    kind: "choice",
    options: OPTIONS,
    allowText: false,
    requirement: "human-required",
    askedAt: "2026-11-02T10:00:00.000Z",
    expiresAt: null,
    status: "open",
    closedReason: null,
    deliveryStatus: "relay-queued",
    attachments: [],
    thread: [],
    ...over,
  };
}

type Over = Partial<Omit<ComposeInput, "question" | "draft">> & {
  selected?: string | null;
  text?: string;
};

function input(content: DecisionQuestionContent, over: Over = {}): ComposeInput {
  const { selected = null, text = "", ...rest } = over;
  return {
    question: content,
    draft: { revision: content.revision, selected, text },
    reviewed: {},
    unshown: {},
    stale: false,
    closed: false,
    ...rest,
  };
}

describe("composeShape", () => {
  it("offers what the phone offers for each kind", () => {
    const choice = composeShape(question());
    expect([choice.hasOptions, choice.textAllowed, choice.mixed]).toEqual([true, false, false]);

    const note = composeShape(question({ allowText: true }));
    expect([note.hasOptions, note.textAllowed, note.textIsAnswer]).toEqual([true, true, false]);

    const text = composeShape(question({ kind: "text", options: OPTIONS, allowText: true }));
    expect([text.hasOptions, text.textAllowed, text.textIsAnswer]).toEqual([false, true, true]);

    const mixed = composeShape(question({ kind: "mixed", allowText: true }));
    expect(mixed.mixed).toBe(true);
    // A mixed question with nothing to choose is a text question.
    expect(composeShape(question({ kind: "mixed", options: [], allowText: true })).mixed).toBe(
      false
    );

    const approval = composeShape(question({ kind: "approval" }));
    expect(approval.approval).toBe(true);
    expect(approval.legend).not.toBe(choice.legend);
    expect(approval.sendLabel).not.toBe(choice.sendLabel);
  });
});

describe("composeVerdict", () => {
  it("needs a choice where options are offered, and the note stays optional", () => {
    const content = question({ allowText: true });
    expect(composeVerdict(input(content)).canSend).toBe(false);
    expect(composeVerdict(input(content, { text: "just words" })).canSend).toBe(false);
    expect(composeVerdict(input(content, { selected: "a" })).canSend).toBe(true);
    expect(composeVerdict(input(content, { selected: "a", text: "and why" })).canSend).toBe(true);
  });

  it("takes either a choice or words on a mixed question", () => {
    const content = question({ kind: "mixed", allowText: true });
    const none = composeVerdict(input(content));
    expect(none.canSend).toBe(false);
    expect(none.hint).not.toBe(composeVerdict(input(question())).hint);
    expect(composeVerdict(input(content, { text: "my own" })).canSend).toBe(true);
    expect(composeVerdict(input(content, { selected: "b" })).canSend).toBe(true);
  });

  it("needs words, not whitespace, on a text question", () => {
    const content = question({ kind: "text", options: [], allowText: true });
    expect(composeVerdict(input(content, { text: "  \n " })).canSend).toBe(false);
    expect(composeVerdict(input(content, { text: "Ship it" })).canSend).toBe(true);
  });

  it("holds an approval until every image is opened under the digest it lists", () => {
    const content = question({ kind: "approval", attachments: [image("x"), image("y")] });
    const [x, y] = content.attachments;
    const none = composeVerdict(input(content, { selected: "a" }));
    expect(none).toMatchObject({ canSend: false, remainingImages: 2 });
    const one = composeVerdict(
      input(content, { selected: "a", reviewed: { [x!.attachmentId]: x!.sha256 } })
    );
    expect(one).toMatchObject({ canSend: false, remainingImages: 1 });
    expect(one.hint).not.toBe(none.hint);
    // An image seen under another digest isn't the image the question was asked with.
    const replaced = composeVerdict(
      input(content, {
        selected: "a",
        reviewed: { [x!.attachmentId]: x!.sha256, [y!.attachmentId]: "0".repeat(64) },
      })
    );
    expect(replaced.remainingImages).toBe(1);
    const all = composeVerdict(
      input(content, {
        selected: "a",
        reviewed: { [x!.attachmentId]: x!.sha256, [y!.attachmentId]: y!.sha256 },
      })
    );
    expect(all).toMatchObject({ canSend: true, remainingImages: 0, hint: null });
  });

  describe("an approval with an image that couldn't be shown (#18043)", () => {
    const APPROVAL = [
      { id: "approve", label: "Approve", description: null },
      { id: "reject", label: "Reject", description: null },
    ];
    const content = question({
      kind: "approval",
      options: APPROVAL,
      allowText: true,
      attachments: [image("x"), image("y")],
    });
    const [x, y] = content.attachments;
    const seenX = { [x!.attachmentId]: x!.sha256 };
    const failedY = { [y!.attachmentId]: y!.sha256 };

    it("takes Reject, with or without a note, and holds Approve, naming the image", () => {
      const none = composeVerdict(input(content, { reviewed: seenX, unshown: failedY }));
      expect(none).toMatchObject({
        canSend: false,
        remainingImages: 1,
        blockedOptions: ["approve"],
      });
      expect(none.hint).toMatch(/^After image 2 couldn't be shown/);
      expect(none.hint).toMatch(/approved/);

      const reject = composeVerdict(
        input(content, {
          selected: "reject",
          text: "send new ones",
          reviewed: seenX,
          unshown: failedY,
        })
      );
      expect(reject.canSend).toBe(true);
      // Still says why Approve isn't on offer.
      expect(reject.hint).toBe(none.hint);
      expect(
        composeVerdict(input(content, { selected: "reject", reviewed: seenX, unshown: failedY }))
          .canSend
      ).toBe(true);

      // A draft holding Approve from before can't go on it either.
      const approve = composeVerdict(
        input(content, { selected: "approve", reviewed: seenX, unshown: failedY })
      );
      expect(approve.canSend).toBe(false);
      expect(approve.hint).toBe(none.hint);
    });

    it("keeps Reject waiting on an image that can still be opened, as on the phone", () => {
      const verdict = composeVerdict(input(content, { selected: "reject", unshown: failedY }));
      expect(verdict).toMatchObject({ canSend: false, blockedOptions: ["approve", "reject"] });
      // Only the one that can be opened is asked for.
      expect(verdict.hint).toBe("Open the remaining image to decide");
    });

    it("doesn't excuse a replaced image, listed under another digest", () => {
      const verdict = composeVerdict(
        input(content, {
          selected: "reject",
          reviewed: seenX,
          unshown: { [y!.attachmentId]: "0".repeat(64) },
        })
      );
      expect(verdict).toMatchObject({ canSend: false, blockedOptions: ["approve", "reject"] });
    });

    it("excuses nothing an agent's own options call Reject", () => {
      const custom = question({
        kind: "approval",
        options: [
          { id: "ship", label: "Ship it", description: null },
          { id: "reject", label: "Ship anyway", description: null },
        ],
        attachments: [image("x"), image("y")],
      });
      const verdict = composeVerdict(
        input(custom, { selected: "reject", reviewed: seenX, unshown: failedY })
      );
      expect(verdict).toMatchObject({ canSend: false, blockedOptions: ["ship", "reject"] });
      expect(verdict.hint).toMatch(/decided/);
    });

    it("names one image and counts the rest when several couldn't be shown", () => {
      const verdict = composeVerdict(
        input(content, { unshown: { ...failedY, [x!.attachmentId]: x!.sha256 } })
      );
      expect(verdict.blockedOptions).toEqual(["approve"]);
      expect(verdict.hint).toMatch(/^After image 1 and 1 other image couldn't be shown/);
    });

    it("says an over-long note before the image when Reject is chosen", () => {
      const verdict = composeVerdict(
        input(content, {
          selected: "reject",
          text: "x".repeat(ANSWER_TEXT_BYTES + 1),
          reviewed: seenX,
          unshown: failedY,
        })
      );
      expect(verdict.canSend).toBe(false);
      expect(verdict.hint).toMatch(/^Shorten/);
    });

    it("has nothing to excuse once every image has been seen", () => {
      const verdict = composeVerdict(
        input(content, {
          selected: "approve",
          reviewed: { ...seenX, [y!.attachmentId]: y!.sha256 },
          unshown: failedY,
        })
      );
      expect(verdict).toMatchObject({ canSend: true, hint: null, blockedOptions: [] });
    });
  });

  it("doesn't hold a choice question on its images", () => {
    const content = question({ attachments: [image("x")] });
    expect(composeVerdict(input(content, { selected: "a" }))).toMatchObject({
      canSend: true,
      remainingImages: 0,
    });
  });

  it("holds text to the protocol's own answer limit", () => {
    // Mirrored rather than imported, so the renderer doesn't take in the protocol's schemas.
    expect(ANSWER_TEXT_BYTES).toBe(LIMITS.answerTextBytes);
  });

  it("refuses text over the protocol's limit, counted in UTF-8 bytes", () => {
    const content = question({ kind: "text", options: [], allowText: true });
    // Three bytes each: fits in characters, not in bytes.
    const over = "€".repeat(Math.floor(ANSWER_TEXT_BYTES / 3) + 1);
    const verdict = composeVerdict(input(content, { text: over }));
    expect(verdict.canSend).toBe(false);
    expect(verdict.textOver).toBe(new TextEncoder().encode(over).length - ANSWER_TEXT_BYTES);
    expect(verdict.hint).not.toBeNull();
    expect(composeVerdict(input(content, { text: "x".repeat(ANSWER_TEXT_BYTES) })).canSend).toBe(
      true
    );
  });

  it("takes a choice only while it is still one of the question's options", () => {
    const content = question();
    expect(composeVerdict(input(content, { selected: "gone" })).canSend).toBe(false);
    const payload = answerPayload(content, { revision: 3, selected: "gone", text: "" }, {}, "x1");
    expect(payload.selectedOptionIds).toEqual([]);
  });

  it("names the remaining images before the missing choice, since the choice waits on them", () => {
    const content = question({ kind: "approval", attachments: [image("x")] });
    const verdict = composeVerdict(input(content));
    expect(verdict.remainingImages).toBe(1);
    expect(verdict.hint).not.toBe(composeVerdict(input(question({ kind: "approval" }))).hint);
  });

  it("never sends a stale or closed draft, and says nothing to do when closed", () => {
    const content = question();
    const stale = composeVerdict(input(content, { selected: "a", stale: true }));
    expect(stale.canSend).toBe(false);
    expect(stale.hint).not.toBeNull();
    const closed = composeVerdict(input(content, { selected: "a", closed: true, stale: true }));
    expect(closed).toMatchObject({ canSend: false, hint: null });
    // Closed alone holds an otherwise complete answer.
    expect(composeVerdict(input(content, { selected: "a", closed: true }))).toMatchObject({
      canSend: false,
      hint: null,
    });
  });
});

describe("isAnswerable", () => {
  it("answers only a waiting question that hasn't expired", () => {
    const now = Date.parse("2026-11-02T12:00:00.000Z");
    expect(isAnswerable({ status: "open", expiresAt: null }, now)).toBe(true);
    expect(isAnswerable({ status: "queued", expiresAt: null }, now)).toBe(true);
    expect(isAnswerable({ status: "open", expiresAt: "2026-11-02T12:00:01.000Z" }, now)).toBe(true);
    // Expired by the clock before the store has recorded it.
    expect(isAnswerable({ status: "open", expiresAt: "2026-11-02T12:00:00.000Z" }, now)).toBe(
      false
    );
    for (const status of [
      "human-answered",
      "proxy-answered",
      "cancelled",
      "expired",
      "publish-failed",
    ] as const) {
      expect(isAnswerable({ status, expiresAt: null }, now)).toBe(false);
    }
  });
});

describe("answerPayload", () => {
  it("names the question by its reference at the revision the person read", () => {
    const content = question({ allowText: true });
    const payload = answerPayload(content, { revision: 2, selected: "b", text: " " }, {}, "ans-1");
    expect(payload).toEqual({
      reference: content.reference,
      answerId: "ans-1",
      expectedRevision: 2,
      selectedOptionIds: ["b"],
      reviewedAttachmentDigests: [],
    });
  });

  it("sends an approval as an explicit approval with the images the person opened", () => {
    const content = question({ kind: "approval", attachments: [image("x"), image("y")] });
    const [x] = content.attachments;
    const payload = answerPayload(
      content,
      { revision: 3, selected: "a", text: "" },
      { [x!.attachmentId]: x!.sha256 },
      "ans-2"
    );
    expect(payload.explicitApproval).toBe(true);
    expect(payload.reviewedAttachmentDigests).toEqual([x!.sha256]);
  });

  it("leaves out what the question doesn't take", () => {
    // A text question's leftover choice, and a choice question's leftover words.
    const text = answerPayload(
      question({ kind: "text", allowText: true }),
      { revision: 3, selected: "a", text: "words" },
      {},
      "ans-3"
    );
    expect(text.selectedOptionIds).toEqual([]);
    expect(text.text).toBe("words");
    const choice = answerPayload(
      question({ allowText: false }),
      { revision: 3, selected: "a", text: "words" },
      {},
      "ans-4"
    );
    expect(choice.text).toBeUndefined();
    expect(choice.explicitApproval).toBeUndefined();
  });

  it("lists only images opened under their own digest", () => {
    const attachments = [image("x"), image("y")];
    expect(reviewedDigests(attachments, { x: "0".repeat(64), y: attachments[1]!.sha256 })).toEqual([
      attachments[1]!.sha256,
    ]);
  });
});
