import { describe, expect, it } from "vitest";
import type {
  PaneDecisionAttention,
  PaneDecisionQuestion,
  PaneDecisionState,
  PaneDecisionWaiting,
} from "@shared/types/decisions";
import {
  answerNote,
  cancelNote,
  chipLabel,
  chipSummary,
  deadlineNote,
  decisionItems,
  deliveryNotes,
  isCancellable,
  itemSentence,
  paneWaitOf,
  needsAttention,
  readsPaneWait,
} from "../decisionsChipModel";

function pane(
  parts: {
    open?: PaneDecisionQuestion[];
    waiting?: PaneDecisionWaiting[];
    attention?: PaneDecisionAttention[];
  } = {}
): PaneDecisionState {
  return {
    terminalId: "t1",
    openQuestions: parts.open ?? [],
    waitingAnswers: parts.waiting ?? [],
    needsAttention: parts.attention ?? [],
    revision: 1,
  };
}

function open(alias: number, status: "open" | "queued" = "open"): PaneDecisionQuestion {
  return {
    questionId: `q${alias}`,
    alias,
    status,
    askedAt: "2026-11-02T10:00:00.000Z",
    expiresAt: null,
  };
}

function waiting(
  alias: number,
  kind: "answer" | "expired" = "answer",
  deliveryStatus: PaneDecisionWaiting["deliveryStatus"] = "desktop-received"
): PaneDecisionWaiting {
  return { questionId: `q${alias}`, alias, kind, deliveryStatus };
}

function stopped(
  alias: number,
  deliveryStatus: PaneDecisionAttention["deliveryStatus"] = "needs-attention",
  reason = "relaunched"
): PaneDecisionAttention {
  return { questionId: `q${alias}`, alias, deliveryStatus, reason };
}

describe("decisionItems", () => {
  it("lists what needs a person first, then what is about to be typed, then what is still out", () => {
    const items = decisionItems(
      pane({
        open: [open(45, "queued"), open(44)],
        waiting: [waiting(43), waiting(40, "expired")],
        attention: [stopped(39, "delivery-uncertain"), stopped(41)],
      })
    );
    expect(items.map((item) => [item.label, item.kind])).toEqual([
      ["q-41", "attention"],
      ["q-39", "uncertain"],
      ["q-43", "answer"],
      ["q-40", "expired"],
      ["q-44", "open"],
      ["q-45", "queued"],
    ]);
  });

  it("explains a reason code it knows and leaves out one it doesn't", () => {
    const [known, unknown] = decisionItems(
      pane({
        attention: [
          stopped(1, "needs-attention", "pane_gone"),
          stopped(2, "needs-attention", "x.y"),
        ],
      })
    );
    expect(known?.reason).not.toBeNull();
    expect(unknown?.reason).toBeNull();
  });

  it("says when an answer waits for its terminal's host rather than for the pane", () => {
    const [host, here] = decisionItems(
      pane({ waiting: [waiting(1, "answer", "pending-host"), waiting(2)] })
    );
    expect(host?.waitsFor).toBe("host");
    expect(here?.waitsFor).toBe("composer");
    expect(host?.status).not.toBe(here?.status);
  });

  it("says what the pane's answer waits on, never that the terminal is idle (#16282)", () => {
    const state = pane({ waiting: [waiting(1), waiting(2, "expired")] });
    const statuses = (["draft", "composer", "prompt"] as const).map((wait) => {
      const items = decisionItems(state, wait);
      expect(items.map((item) => item.waitsFor)).toEqual([wait, wait]);
      for (const item of items) expect(item.status).not.toMatch(/idle/);
      return items[0]!.status;
    });
    expect(new Set(statuses).size).toBe(3);
  });
});

describe("paneWaitOf", () => {
  it("puts a draft here first, then whether the agent's CLI takes a line mid-turn", () => {
    expect(paneWaitOf({ hasDraft: true, queuesInput: true })).toBe("draft");
    expect(paneWaitOf({ hasDraft: true, queuesInput: false })).toBe("draft");
    expect(paneWaitOf({ hasDraft: false, queuesInput: true })).toBe("composer");
    expect(paneWaitOf({ hasDraft: false, queuesInput: false })).toBe("prompt");
  });
});

describe("readsPaneWait", () => {
  /** Whether anything the chip says comes out differently for another wait. */
  function wordingTurnsOnWait(state: PaneDecisionState): boolean {
    const said = (["draft", "composer", "prompt"] as const).map((wait) => {
      const items = decisionItems(state, wait);
      return JSON.stringify([
        items.map((item) => [item.status, itemSentence(item)]),
        chipSummary(items),
        deliveryNotes(items, wait),
      ]);
    });
    return new Set(said).size > 1;
  }

  it("is set wherever the chip's wording turns on the pane's wait", () => {
    for (const state of [
      pane({ open: [open(42)] }),
      pane({ open: [open(42, "queued")] }),
      pane({ waiting: [waiting(41)] }),
      pane({ waiting: [waiting(40, "expired")] }),
      pane({ attention: [stopped(39)], waiting: [waiting(41)] }),
    ]) {
      expect(wordingTurnsOnWait(state)).toBe(true);
      expect(readsPaneWait(state)).toBe(true);
    }
  });

  it("is clear when nothing is out or waiting, so the drafts go unread", () => {
    for (const state of [
      pane(),
      pane({ attention: [stopped(39), stopped(38, "delivery-uncertain")] }),
    ]) {
      expect(wordingTurnsOnWait(state)).toBe(false);
      expect(readsPaneWait(state)).toBe(false);
    }
    expect(readsPaneWait(null)).toBe(false);
  });
});

describe("chipLabel", () => {
  it("names a single question by its alias, with what happened to it", () => {
    expect(chipLabel(decisionItems(pane({ open: [open(42)] }))).text).toBe("q-42");
    expect(chipLabel(decisionItems(pane({ waiting: [waiting(41)] }))).text).toMatch(/^q-41 /);
  });

  it("counts several, and says how many Daintree is about to type in", () => {
    const some = chipLabel(
      decisionItems(pane({ open: [open(1), open(2)], waiting: [waiting(3)] }))
    );
    expect(some.text).toBe("3");
    expect(some.detail).toContain("1");

    expect(chipLabel(decisionItems(pane({ open: [open(1), open(2)] }))).detail).toBeNull();

    const all = chipLabel(decisionItems(pane({ waiting: [waiting(1), waiting(2, "expired")] })));
    expect(all.text).toBe("2");
    expect(all.detail).not.toBeNull();
    expect(all.detail).not.toContain("·");
  });
});

describe("chipSummary", () => {
  it("is one item's sentence, naming the question", () => {
    expect(chipSummary(decisionItems(pane({ attention: [stopped(38)] })))).toContain("q-38");
  });

  it("breaks several down without folding queued questions into open ones", () => {
    const summary = chipSummary(
      decisionItems(
        pane({ open: [open(1), open(2, "queued")], attention: [stopped(3), stopped(4)] })
      )
    );
    expect(summary).toMatch(/^4 /);
    expect(summary).toMatch(/2\sneed attention/);
    expect(summary).toMatch(/1\s[^;]*waiting/);
    expect(summary).toMatch(/1\s[^;]*queued/);
  });

  it("agrees the verb with a count of one", () => {
    const summary = chipSummary(decisionItems(pane({ open: [open(1)], attention: [stopped(2)] })));
    expect(summary).toMatch(/1\sneeds attention/);
  });
});

describe("deliveryNotes", () => {
  it("promises typing only for what will be typed in on its own", () => {
    const attentionOnly = decisionItems(pane({ attention: [stopped(1)] }));
    const routineOnly = decisionItems(pane({ open: [open(1)] }));
    const both = decisionItems(pane({ open: [open(1)], attention: [stopped(2)] }));

    expect(needsAttention(attentionOnly)).toBe(true);
    expect(deliveryNotes(attentionOnly)).toHaveLength(1);
    expect(deliveryNotes(routineOnly)).toHaveLength(1);
    expect(deliveryNotes(attentionOnly)[0]).not.toBe(deliveryNotes(routineOnly)[0]);
    expect(deliveryNotes(both)).toEqual([
      ...deliveryNotes(routineOnly),
      ...deliveryNotes(attentionOnly),
    ]);
  });

  it("names a host that's away instead of promising delivery here", () => {
    const hostOnly = decisionItems(pane({ waiting: [waiting(1, "answer", "pending-host")] }));
    const hereOnly = decisionItems(pane({ waiting: [waiting(1)] }));
    expect(deliveryNotes(hostOnly)).toHaveLength(1);
    expect(deliveryNotes(hostOnly)[0]).not.toBe(deliveryNotes(hereOnly)[0]);
  });

  it("says what answers here wait on, by the pane's wait", () => {
    const items = decisionItems(pane({ open: [open(1)] }));
    const notes = (["draft", "composer", "prompt"] as const).map(
      (wait) => deliveryNotes(items, wait)[0]
    );
    expect(new Set(notes).size).toBe(3);
    for (const note of notes) expect(note).not.toMatch(/idle/);
  });
});

describe("answering here (#17102)", () => {
  it("invites an answer only while a question still waits for one", () => {
    const note = (state: PaneDecisionState, cancelling?: Set<string>) =>
      answerNote(decisionItems(state, "composer", cancelling));
    expect(note(pane({ open: [open(1)] }))).toMatch(/^Open a question to answer it here/);
    expect(note(pane({ open: [open(1, "queued")] }))).not.toBeNull();
    expect(note(pane({ open: [open(1)], waiting: [waiting(2)] }))).not.toBeNull();
    expect(note(pane({ waiting: [waiting(1)], attention: [stopped(2)] }))).toBeNull();
    expect(note(pane({ waiting: [waiting(1, "expired")] }))).toBeNull();
    // A question being withdrawn takes no answer.
    expect(note(pane({ open: [open(1)] }), new Set(["q1"]))).toBeNull();
  });

  it("says a waiting question can be answered here, in its row and its sentence", () => {
    const [waitingRow, queuedRow] = decisionItems(pane({ open: [open(1), open(2, "queued")] }));
    const plain = decisionItems(pane({ waiting: [waiting(3)] }))[0]!;
    for (const item of [waitingRow!, queuedRow!]) {
      expect(item.status).toMatch(/here/);
      expect(itemSentence(item)).toMatch(/here/);
    }
    // Only a question already on the phones can be answered there.
    expect(waitingRow!.status).toMatch(/^Waiting for an answer.*phone/);
    expect(itemSentence(waitingRow!)).toMatch(/is waiting for an answer.*phone/);
    expect(queuedRow!.status).toMatch(/^Queued to send/);
    expect(queuedRow!.status).not.toMatch(/phone/);
    expect(itemSentence(queuedRow!)).toMatch(/is queued to send/);
    expect(plain.status).not.toMatch(/answer it here|here or on your phone/);
  });
});

describe("a person's dismissal or withdrawal", () => {
  it("offers Dismiss only on questions still waiting for an answer", () => {
    const items = decisionItems(
      pane({
        open: [open(1), open(2, "queued")],
        waiting: [waiting(3), waiting(4, "expired")],
        attention: [stopped(5), stopped(6, "delivery-uncertain")],
      })
    );
    expect(items.filter(isCancellable).map((item) => item.label)).toEqual(["q-1", "q-2"]);
  });

  it("shows a withdrawal the relay hasn't confirmed as cancelling, last, with no cancel and no answer coming", () => {
    const state = pane({ open: [open(1), open(2, "queued"), open(3)] });
    const items = decisionItems(state, "composer", new Set(["q1", "q2"]));

    expect(items.map((item) => [item.label, item.kind])).toEqual([
      ["q-3", "open"],
      ["q-1", "cancelling"],
      ["q-2", "cancelling"],
    ]);
    expect(items.filter(isCancellable).map((item) => item.label)).toEqual(["q-3"]);
    expect(chipSummary(items)).toBe(
      "3 Decisions questions: 1\u00a0waiting for an answer; 2\u00a0cancelling"
    );

    const withdrawn = decisionItems(pane({ open: [open(1)] }), "composer", new Set(["q1"]));
    expect(chipLabel(withdrawn)).toEqual({ text: "q-1 cancelling", detail: null });
    expect(itemSentence(withdrawn[0]!)).toMatch(/^Question q-1 is being cancelled/);
    // Nothing will be typed in for it, so the pane makes no promise.
    expect(deliveryNotes(withdrawn)).toEqual([]);
    expect(deliveryNotes(decisionItems(pane({ open: [open(1)] })))).toHaveLength(1);
  });

  it("shows a dismissal from here as dismissing, after the questions still waiting, with no Dismiss and no answer coming (#17239)", () => {
    const state = pane({ open: [open(1), open(2, "queued"), open(3)] });
    const items = decisionItems(state, "composer", new Set(["q3"]), new Set(["q1", "q3"]));

    // A withdrawal wins over a dismissal of the same question: only the withdrawal was committed last.
    expect(items.map((item) => [item.label, item.kind])).toEqual([
      ["q-2", "queued"],
      ["q-1", "dismissing"],
      ["q-3", "cancelling"],
    ]);
    expect(items.filter(isCancellable).map((item) => item.label)).toEqual(["q-2"]);
    expect(chipSummary(items)).toBe(
      "3 Decisions questions: 1\u00a0queued to send; 1\u00a0dismissing; 1\u00a0cancelling"
    );

    const dismissed = decisionItems(
      pane({ open: [open(1)] }),
      "composer",
      undefined,
      new Set(["q1"])
    );
    expect(chipLabel(dismissed)).toEqual({ text: "q-1 dismissing", detail: null });
    expect(itemSentence(dismissed[0]!)).toMatch(/^Question q-1 was dismissed here/);
    expect(deliveryNotes(dismissed)).toEqual([]);
    expect(cancelNote(dismissed)).toBeNull();
    // A follow-up held on a question being dismissed lists it under attention too, but it isn't answered.
    const held = decisionItems(
      pane({ open: [open(1)], attention: [stopped(1)] }),
      "composer",
      undefined,
      new Set(["q1"])
    );
    expect(cancelNote(held)).toBeNull();
  });

  it("marks only questions the pane still lists as waiting", () => {
    // An answer that arrived for a withdrawn question is shown as the answer it is.
    const items = decisionItems(pane({ waiting: [waiting(1)] }), "composer", new Set(["q1"]));
    expect(items.map((item) => item.kind)).toEqual(["answer"]);
  });

  it("says why answered and expired rows offer no Dismiss, and nothing when every row is waiting", () => {
    const note = (state: PaneDecisionState) => cancelNote(decisionItems(state));
    expect(note(pane({ open: [open(1), open(2, "queued")] }))).toBeNull();
    expect(note(pane({ open: [open(1)], waiting: [waiting(2)] }))).toBe(
      "Answered questions can't be dismissed"
    );
    expect(note(pane({ attention: [stopped(2, "delivery-uncertain")] }))).toBe(
      "Answered questions can't be dismissed"
    );
    expect(note(pane({ waiting: [waiting(2, "expired")] }))).toBe(
      "Expired questions can't be dismissed"
    );
    expect(note(pane({ waiting: [waiting(2, "expired")], attention: [stopped(3)] }))).toBe(
      "Answered and expired questions can't be dismissed"
    );
    // A follow-up held on a question still waiting lists it under attention too, but it isn't answered.
    expect(note(pane({ open: [open(1)], attention: [stopped(1)] }))).toBeNull();
    expect(note(pane({ open: [open(1)], attention: [stopped(1), stopped(2)] }))).toBe(
      "Answered questions can't be dismissed"
    );
    const withdrawn = decisionItems(
      pane({ open: [open(1)], attention: [stopped(1)] }),
      "composer",
      new Set(["q1"])
    );
    expect(cancelNote(withdrawn)).toBeNull();
  });
});

describe("deadlineNote (#17943)", () => {
  const NOW = Date.parse("2026-11-20T14:00:00.000Z");
  const timed = (alias: number, ms: number | null, status: "open" | "queued" = "open") =>
    decisionItems(
      pane({
        open: [
          { ...open(alias, status), expiresAt: ms === null ? null : new Date(ms).toISOString() },
        ],
      })
    )[0]!;

  it("says when to reply by while it's ahead, and that it passed once it has", () => {
    expect(deadlineNote(timed(1, NOW + 60_000), NOW)).toMatch(/^Reply by /);
    expect(deadlineNote(timed(1, NOW + 60_000, "queued"), NOW)).toMatch(/^Reply by /);
    expect(deadlineNote(timed(1, NOW), NOW)).toMatch(/Deadline passed/);
  });

  it("says nothing for a question that never expires, or a row that isn't waiting", () => {
    expect(deadlineNote(timed(1, null), NOW)).toBeNull();
    const [answer] = decisionItems(pane({ waiting: [waiting(2)] }));
    expect(deadlineNote(answer!, NOW)).toBeNull();
  });
});
