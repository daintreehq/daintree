import { describe, expect, it } from "vitest";
import type {
  PaneDecisionAttention,
  PaneDecisionQuestion,
  PaneDecisionState,
  PaneDecisionWaiting,
} from "@shared/types/decisions";
import {
  chipLabel,
  chipSummary,
  decisionItems,
  deliveryNotes,
  needsAttention,
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

  it("says when an answer waits for its terminal's host rather than for idle", () => {
    const [host, idle] = decisionItems(
      pane({ waiting: [waiting(1, "answer", "pending-host"), waiting(2)] })
    );
    expect(host?.waitsFor).toBe("host");
    expect(idle?.waitsFor).toBe("idle");
    expect(host?.status).not.toBe(idle?.status);
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

  it("names a host that's away instead of promising idle delivery", () => {
    const hostOnly = decisionItems(pane({ waiting: [waiting(1, "answer", "pending-host")] }));
    const idleOnly = decisionItems(pane({ waiting: [waiting(1)] }));
    expect(deliveryNotes(hostOnly)).toHaveLength(1);
    expect(deliveryNotes(hostOnly)[0]).not.toBe(deliveryNotes(idleOnly)[0]);
  });
});
