import { describe, expect, it } from "vitest";
import type {
  DecisionQuestionListItem,
  DecisionQuestionStanding,
  MarkDecisionQuestionsPayload,
} from "../../../../shared/types/decisionsQuestion.js";
import {
  QUESTION_MARKS_META_KEY,
  applyQuestionMarks,
  markKey,
  parseQuestionMarks,
  readQuestionMarks,
  serializeQuestionMarks,
  withInbox,
  type QuestionMark,
} from "../questionMarks.js";

const OWN = "host_own_0001";
const HOST = "host_studio_01";

/** Every question's ask taken as reported, not guessed, as this computer's own always are. */
class EveryAskReported extends Map<string, string | null> {
  override has(): boolean {
    return true;
  }
}
const REPORTED: ReadonlyMap<string, string | null> = new EveryAskReported();

function item(
  n: number,
  standing: DecisionQuestionStanding = { kind: "waiting", reason: "open" },
  overrides: Partial<DecisionQuestionListItem> = {}
): DecisionQuestionListItem {
  return {
    reference: {
      hostId: OWN,
      projectId: "project-1",
      terminalId: `pane-${n}`,
      questionId: `q_question_${n}`,
    },
    alias: n,
    agentKind: "claude",
    projectLabel: null,
    worktreeId: "wt",
    worktreeRoot: "/repo",
    requirement: "human-required",
    askedAt: "2026-11-01T10:00:00.000Z",
    expiresAt: null,
    settledAt: null,
    standing,
    replyRequest: null,
    stall: null,
    ...overrides,
  };
}

function hostItem(n: number, overrides: Partial<DecisionQuestionListItem> = {}) {
  const base = item(n, { kind: "waiting", reason: "open" }, overrides);
  return {
    ...base,
    reference: { ...base.reference, hostId: HOST },
    remoteHost: { hostId: "studio", name: "Studio", connected: false },
  };
}

function mark(of: DecisionQuestionListItem, overrides: Partial<QuestionMark> = {}): QuestionMark {
  return {
    hostId: of.reference.hostId,
    questionId: of.reference.questionId,
    ask: null,
    seen: true,
    cleared: false,
    ...overrides,
  };
}

function marksOf(...list: QuestionMark[]): Map<string, QuestionMark> {
  return new Map(list.map((m) => [markKey(m), m]));
}

function payload(
  action: MarkDecisionQuestionsPayload["action"],
  ...questions: Array<{ of: DecisionQuestionListItem; ask?: string | null }>
): MarkDecisionQuestionsPayload {
  return {
    action,
    questions: questions.map(({ of, ask }) => ({
      reference: of.reference,
      ask: ask === undefined ? (of.inbox?.ask ?? null) : ask,
    })),
  };
}

describe("withInbox", () => {
  it("names what each question in Needs you asks now, and nothing for the rest", () => {
    const open = item(1);
    const queued = item(2, { kind: "queued" });
    const reply = item(3, { kind: "waiting", reason: "reply" }, { replyRequest: "ask-3" });
    const settled = item(4, { kind: "settled", outcome: "expired" });
    const stalled = item(5, { kind: "needs-attention", deliveryStatus: "needs-attention" });
    const asks = new Map([
      [markKey(open.reference), "note-1"],
      [markKey(queued.reference), null],
      [markKey(reply.reference), "ask-3"],
    ]);
    const listed = withInbox([open, queued, reply, settled, stalled], asks, new Map());
    expect(listed.map((question) => question.inbox)).toEqual([
      { ask: "note-1", seen: false, cleared: false },
      { ask: null, seen: false, cleared: false },
      { ask: "ask-3", seen: false, cleared: false },
      undefined,
      undefined,
    ]);
  });

  it("takes a question's reply request as its ask when no ask was reported for it", () => {
    const old = hostItem(1, {
      standing: { kind: "waiting", reason: "reply" },
      replyRequest: "r-1",
    });
    const open = hostItem(2);
    const [reply, plain] = withInbox([old, open], new Map(), new Map());
    expect(reply!.inbox?.ask).toBe("r-1");
    expect(plain!.inbox?.ask).toBeNull();
  });

  it("holds a mark only at the ask it was made at", () => {
    const q = item(1);
    const asks = new Map([[markKey(q.reference), "note-2"]]);
    const stale = marksOf(mark(q, { ask: "note-1", seen: true, cleared: true }));
    expect(withInbox([q], asks, stale)[0]!.inbox).toEqual({
      ask: "note-2",
      seen: false,
      cleared: false,
    });
    const current = marksOf(mark(q, { ask: "note-2", seen: false, cleared: true }));
    expect(withInbox([q], asks, current)[0]!.inbox).toEqual({
      ask: "note-2",
      seen: false,
      cleared: true,
    });
  });

  it("keeps the same question id on two machines apart", () => {
    const own = item(1);
    const theirs = hostItem(1);
    const listed = withInbox([own, theirs], new Map(), marksOf(mark(theirs)));
    expect(listed.map((question) => question.inbox?.seen)).toEqual([false, true]);
  });
});

describe("applyQuestionMarks", () => {
  const listed = (...questions: DecisionQuestionListItem[]) =>
    withInbox(questions, new Map(), new Map());

  it("records seen, clear and restore apart, each at the ask shown", () => {
    const [q] = listed(item(1));
    const seen = applyQuestionMarks(new Map(), [q!], payload("seen", { of: q! }), OWN, REPORTED);
    expect(seen.marked).toBe(1);
    expect([...seen.marks.values()]).toEqual([mark(q!, { seen: true, cleared: false })]);

    const cleared = applyQuestionMarks(
      seen.marks,
      [q!],
      payload("clear", { of: q! }),
      OWN,
      REPORTED
    );
    expect([...cleared.marks.values()]).toEqual([mark(q!, { seen: true, cleared: true })]);

    // Restoring takes it back into Needs you without forgetting it was seen.
    const restored = applyQuestionMarks(
      cleared.marks,
      [q!],
      payload("restore", { of: q! }),
      OWN,
      REPORTED
    );
    expect([...restored.marks.values()]).toEqual([mark(q!, { seen: true, cleared: false })]);
  });

  it("drops a mark that a restore leaves holding nothing", () => {
    const [q] = listed(item(1));
    const cleared = applyQuestionMarks(
      new Map(),
      [q!],
      payload("clear", { of: q! }),
      OWN,
      REPORTED
    );
    const restored = applyQuestionMarks(
      cleared.marks,
      [q!],
      payload("restore", { of: q! }),
      OWN,
      REPORTED
    );
    expect(restored.marks.size).toBe(0);
    expect(restored.marked).toBe(1);
  });

  it("seeing a cleared question never restores it", () => {
    const [q] = listed(item(1));
    const cleared = applyQuestionMarks(
      new Map(),
      [q!],
      payload("clear", { of: q! }),
      OWN,
      REPORTED
    );
    const seen = applyQuestionMarks(
      cleared.marks,
      [q!],
      payload("seen", { of: q! }),
      OWN,
      REPORTED
    );
    expect([...seen.marks.values()]).toEqual([mark(q!, { seen: true, cleared: true })]);
  });

  it("leaves a question that asks something new since it was shown, or isn't in Needs you", () => {
    const [open, settled] = listed(item(1), item(2, { kind: "settled", outcome: "declined" }));
    const result = applyQuestionMarks(
      new Map(),
      [open!, settled!],
      payload("clear", { of: open!, ask: "older-note" }, { of: settled!, ask: null }),
      OWN,
      REPORTED
    );
    expect(result).toEqual({ marks: new Map(), marked: 0 });
  });

  it("leaves a question the list doesn't hold", () => {
    const missing = item(9);
    const result = applyQuestionMarks(
      new Map(),
      [],
      payload("clear", { of: missing }),
      OWN,
      REPORTED
    );
    expect(result).toEqual({ marks: new Map(), marked: 0 });
  });

  it("counts only the questions it changed", () => {
    const [q] = listed(item(1));
    const once = applyQuestionMarks(new Map(), [q!], payload("seen", { of: q! }), OWN, REPORTED);
    expect(once.marked).toBe(1);
    expect(
      applyQuestionMarks(once.marks, [q!], payload("seen", { of: q! }), OWN, REPORTED).marked
    ).toBe(0);
  });

  it("lets go of marks the list proves over, and keeps those it can't", () => {
    const questions = listed(
      item(1),
      item(2, { kind: "settled", outcome: "answered", handled: false }),
      item(3, { kind: "needs-attention", deliveryStatus: "delivery-uncertain" }),
      item(4, { kind: "to-type" }),
      item(5, { kind: "send-failed" })
    );
    const asked = withInbox(
      [item(6)],
      new Map([[markKey(item(6).reference), "note-2"]]),
      new Map()
    );
    const goneOwn = item(7);
    const awayHost = hostItem(8);
    const record = marksOf(
      mark(questions[0]!),
      mark(questions[1]!),
      mark(questions[2]!),
      mark(questions[3]!),
      mark(questions[4]!),
      mark(asked[0]!, { ask: "note-1" }),
      mark(goneOwn),
      mark(awayHost, { cleared: true })
    );
    const { marks } = applyQuestionMarks(
      record,
      [...questions, ...asked],
      { action: "seen", questions: [] },
      OWN,
      REPORTED
    );
    // Still waiting at its ask; masked by a stopped delivery; a Host's while its list is away.
    expect([...marks.keys()].sort()).toEqual(
      [questions[0]!, questions[2]!, awayHost].map((q) => markKey(q.reference)).sort()
    );
  });
});

describe("applyQuestionMarks with a Host from before #17895", () => {
  it("keeps a mark at another ask while the list only guesses the question's ask", () => {
    const old = hostItem(1);
    const other = item(2);
    const listed = withInbox([old, other], new Map(), new Map());
    // Cleared at the agent's follow-up m2 over a v2 link; the Host now speaks v1.
    const record = marksOf(mark(old, { ask: "m2", seen: false, cleared: true }));
    expect(listed[0]!.inbox).toEqual({ ask: null, seen: false, cleared: false });

    const kept = applyQuestionMarks(
      record,
      listed,
      payload("seen", { of: listed[1]! }),
      OWN,
      new Map()
    );
    expect(kept.marks.get(markKey(old.reference))).toEqual(record.get(markKey(old.reference)));

    // Once a reported ask says otherwise, it is stale.
    const reported = new Map([[markKey(old.reference), null]]);
    const pruned = applyQuestionMarks(
      record,
      listed,
      payload("seen", { of: listed[1]! }),
      OWN,
      reported
    );
    expect(pruned.marks.has(markKey(old.reference))).toBe(false);
  });

  it("starts a mark at the ask shown, carrying nothing of one kept at another ask", () => {
    const old = hostItem(1);
    const [listed] = withInbox([old], new Map(), new Map());
    const record = marksOf(mark(old, { ask: "m2", seen: true, cleared: true }));
    const { marks, marked } = applyQuestionMarks(
      record,
      [listed!],
      payload("seen", { of: listed! }),
      OWN,
      new Map()
    );
    expect(marked).toBe(1);
    expect([...marks.values()]).toEqual([mark(old, { ask: null, seen: true, cleared: false })]);
  });
});

describe("the stored record", () => {
  it("reads back what it wrote", () => {
    const record = marksOf(
      mark(item(1), { ask: "note-1", cleared: true }),
      mark(hostItem(2), { seen: false, cleared: true })
    );
    expect(parseQuestionMarks(serializeQuestionMarks(record))).toEqual(record);
  });

  it("hides nothing when the record, or a mark in it, is damaged", () => {
    expect(parseQuestionMarks("{not json").size).toBe(0);
    expect(parseQuestionMarks(JSON.stringify({ marks: "nope" })).size).toBe(0);
    const good = mark(item(1));
    const parsed = parseQuestionMarks(
      JSON.stringify({
        marks: [
          good,
          { ...good, questionId: "" },
          { ...mark(item(2)), seen: false, cleared: false },
          { ...mark(item(3)), ask: 7 },
        ],
      })
    );
    expect([...parsed.values()]).toEqual([good]);
  });

  it("rejects when the store can't be read, rather than reading as no marks", async () => {
    const failing = {
      getMeta: async () => {
        throw new Error("SQLITE_BUSY");
      },
      setMeta: async () => {},
    };
    await expect(readQuestionMarks(failing)).rejects.toThrow("SQLITE_BUSY");
    const stored = serializeQuestionMarks(marksOf(mark(item(1))));
    const reading = {
      getMeta: async (key: string) => (key === QUESTION_MARKS_META_KEY ? stored : null),
      setMeta: async () => {},
    };
    expect((await readQuestionMarks(reading)).size).toBe(1);
  });
});
