import { describe, expect, it } from "vitest";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { PaneDecisionState } from "@shared/types/decisions";
import { decisionItems } from "@/components/Terminal/decisionsChipModel";
import type {
  DecisionQuestionListItem,
  DecisionQuestionStanding,
  DecisionThreadEntry,
  DecisionThreadMessage,
} from "@shared/types/decisionsQuestion";
import {
  CLEARED_ELAPSED_NOTE,
  CLEARED_NOTE,
  ELAPSED_NOTE,
  agentName,
  askShownIn,
  clearText,
  connectionNotice,
  groupOf,
  inboxGroupOf,
  inboxGroups,
  inboxRowNote,
  isAttention,
  markedText,
  originFacts,
  referenceKey,
  resolveSelection,
  seeableAsk,
  staleNote,
  standingText,
  worktreeName,
} from "../decisionsInboxModel";

function item(
  questionId: string,
  standing: DecisionQuestionStanding,
  over: Partial<DecisionQuestionListItem> = {}
): DecisionQuestionListItem {
  return {
    reference: { hostId: "h1", projectId: "p1", terminalId: "t1", questionId },
    alias: Number(questionId.replace(/\D/g, "")) || 1,
    agentKind: "claude",
    projectLabel: "Daintree",
    worktreeId: "w1",
    worktreeRoot: "/Users/me/Projects/daintree",
    requirement: "human-required",
    askedAt: "2026-11-02T10:00:00.000Z",
    expiresAt: null,
    settledAt: null,
    standing,
    replyRequest: null,
    stall: null,
    ...over,
  };
}

const OPEN: DecisionQuestionStanding = { kind: "waiting", reason: "open" };

describe("decisionsInboxModel", () => {
  it("places every standing in exactly one of the issue's groups", () => {
    expect(groupOf({ kind: "waiting", reason: "open" })).toBe("needs-you");
    expect(groupOf({ kind: "waiting", reason: "reply" })).toBe("needs-you");
    expect(groupOf({ kind: "queued" })).toBe("needs-you");
    expect(groupOf({ kind: "to-type" })).toBe("delivering");
    expect(groupOf({ kind: "needs-attention", deliveryStatus: "needs-attention" })).toBe(
      "attention"
    );
    expect(groupOf({ kind: "needs-attention", deliveryStatus: "delivery-uncertain" })).toBe(
      "attention"
    );
    expect(groupOf({ kind: "send-failed" })).toBe("history");
    expect(groupOf({ kind: "settled", outcome: "answered", handled: false })).toBe("history");
    expect(groupOf({ kind: "settled", outcome: "answered", handled: true })).toBe("history");
    expect(groupOf({ kind: "settled", outcome: "withdrawn" })).toBe("history");
    expect(groupOf({ kind: "settled", outcome: "expired" })).toBe("history");
    expect(groupOf({ kind: "settled", outcome: "declined" })).toBe("history");
  });

  it("lists the non-empty groups in order, keeping the list's order outside history", () => {
    const groups = inboxGroups([
      item("q1", { kind: "settled", outcome: "expired" }),
      item("q2", OPEN),
      item("q5", { kind: "needs-attention", deliveryStatus: "needs-attention" }),
      item("q3", { kind: "to-type" }),
      item("q4", { kind: "queued" }),
    ]);
    expect(groups.map((group) => group.id)).toEqual([
      "needs-you",
      "delivering",
      "attention",
      "history",
    ]);
    expect(groups[0]!.items.map((entry) => entry.reference.questionId)).toEqual(["q2", "q4"]);
  });

  it("shows the most recently closed history first, by settled time else asked time", () => {
    // Asked in the opposite order to the one they settled in.
    const groups = inboxGroups([
      item(
        "q1",
        { kind: "settled", outcome: "answered", handled: false },
        {
          askedAt: "2026-11-02T09:00:00.000Z",
          settledAt: "2026-11-02T12:00:00.000Z",
        }
      ),
      item(
        "q2",
        { kind: "settled", outcome: "withdrawn" },
        {
          askedAt: "2026-11-02T13:00:00.000Z",
        }
      ),
      item(
        "q3",
        { kind: "settled", outcome: "expired" },
        {
          askedAt: "2026-11-02T10:30:00.000Z",
          settledAt: "2026-11-02T11:00:00.000Z",
        }
      ),
      item("q4", { kind: "send-failed" }, { askedAt: "not a time" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((entry) => entry.reference.questionId)).toEqual([
      "q2",
      "q1",
      "q3",
      "q4",
    ]);
  });

  it("lists nothing for an empty list", () => {
    expect(inboxGroups([])).toEqual([]);
  });

  it("says a waiting or queued question in the pane chip's own words", () => {
    const chip = decisionItems({
      terminalId: "t1",
      revision: 1,
      openQuestions: [
        {
          questionId: "q1",
          alias: 1,
          status: "open",
          askedAt: "2026-11-02T10:00:00.000Z",
          expiresAt: null,
        },
        {
          questionId: "q2",
          alias: 2,
          status: "queued",
          askedAt: "2026-11-02T10:00:00.000Z",
          expiresAt: null,
        },
      ],
      waitingAnswers: [],
      needsAttention: [],
    } satisfies PaneDecisionState);
    expect(standingText(OPEN)).toBe(chip.find((entry) => entry.kind === "open")!.status);
    expect(standingText({ kind: "queued" })).toBe(
      chip.find((entry) => entry.kind === "queued")!.status
    );
  });

  it("says every standing in its own sentence, without a closing period", () => {
    const standings: DecisionQuestionStanding[] = [
      OPEN,
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
    const texts = standings.map((standing) => standingText(standing));
    expect(new Set(texts).size).toBe(standings.length);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
      expect(text.endsWith(".")).toBe(false);
      expect(text[0]).toBe(text[0]!.toUpperCase());
    }
  });

  it("says a handled answer was handled, and never that a settled answer was typed in", () => {
    const handled = standingText({ kind: "settled", outcome: "answered", handled: true });
    const answered = standingText({ kind: "settled", outcome: "answered", handled: false });
    expect(handled).toMatch(/handled/i);
    expect(answered).not.toMatch(/handled/i);
    // Settled says only that it was answered: how far the answer got isn't the list's to say.
    expect(answered).not.toMatch(/typed/i);
    expect(handled).not.toMatch(/typed/i);
  });

  it("marks only what needs a person's decision about its delivery", () => {
    expect(isAttention({ kind: "needs-attention", deliveryStatus: "needs-attention" })).toBe(true);
    expect(isAttention({ kind: "send-failed" })).toBe(false);
    expect(isAttention(OPEN)).toBe(false);
  });

  it("names the agent by its display name, else the recorded kind", () => {
    expect(agentName("claude")).toBe(getEffectiveAgentConfig("claude")!.name);
    expect(agentName("some-unknown-agent")).toBe("some-unknown-agent");
  });

  it("names the worktree by its project's name, else its folder, else nothing", () => {
    expect(worktreeName({ worktreeRoot: "/a/b/feature-x" }, "Feature X")).toBe("Feature X");
    expect(worktreeName({ worktreeRoot: "/a/b/feature-x" }, null)).toBe("feature-x");
    expect(worktreeName({ worktreeRoot: "" }, null)).toBeNull();
  });

  it("names where a question was asked by the facts that are known, in order", () => {
    expect(originFacts({ agent: "Claude", project: "Daintree", worktree: "main" })).toEqual([
      "Claude",
      "Daintree",
      "main",
    ]);
    expect(originFacts({ agent: "Codex", project: null, worktree: "w" })).toEqual(["Codex", "w"]);
  });

  it("tells references apart by each of their four parts", () => {
    const base = item("q1", OPEN).reference;
    const keys = new Set([
      referenceKey(base),
      referenceKey({ ...base, hostId: "h2" }),
      referenceKey({ ...base, projectId: "p2" }),
      referenceKey({ ...base, terminalId: "t2" }),
      referenceKey({ ...base, questionId: "q2" }),
    ]);
    expect(keys.size).toBe(5);
    expect(referenceKey({ ...base })).toBe(referenceKey(base));
  });

  it("keeps the chosen question, else the one now in its place, else the opener's, else the first", () => {
    const ordered = [
      item("q1", OPEN),
      item("q2", OPEN, {
        reference: { hostId: "h1", projectId: "p1", terminalId: "t2", questionId: "q2" },
      }),
      item("q3", OPEN),
    ];
    const keyOf = (index: number) => referenceKey(ordered[index]!.reference);
    expect(resolveSelection([], null, null)).toBeNull();
    expect(resolveSelection(ordered, null, null)).toBe(ordered[0]);
    expect(resolveSelection(ordered, null, "t2")).toBe(ordered[1]);
    expect(resolveSelection(ordered, null, "gone")).toBe(ordered[0]);
    expect(resolveSelection(ordered, { key: keyOf(2), index: 0 }, "t2")).toBe(ordered[2]);
    // Its row went: the one now at its place, or the last when it was past the end.
    expect(resolveSelection(ordered, { key: "gone", index: 1 }, null)).toBe(ordered[1]);
    expect(resolveSelection(ordered, { key: "gone", index: 9 }, null)).toBe(ordered[2]);
  });

  it("says nothing about the relay while connected or before main has said", () => {
    expect(connectionNotice(null)).toBeNull();
    expect(connectionNotice({ state: "connected", relayOrigin: "https://r.example" })).toBeNull();
    expect(connectionNotice({ state: "off" })).toBeNull();
  });

  it("tells no relay set up, a problem, a revoked computer and a dropped connection apart", () => {
    const origin = "https://r.example";
    const none = connectionNotice({ state: "not-connected" });
    const storage = connectionNotice({
      state: "not-connected",
      relayOrigin: origin,
      problem: "storage",
    });
    const keys = connectionNotice({ state: "not-connected", relayOrigin: origin, problem: "keys" });
    const otherRelay = connectionNotice({
      state: "not-connected",
      relayOrigin: origin,
      problem: "other-relay",
    });
    // Each problem says its own cause.
    expect(storage!.text).toMatch(/database/);
    expect(keys!.text).toMatch(/keys/);
    expect(otherRelay!.text).toMatch(/another relay/);
    const revoked = connectionNotice({ state: "revoked", relayOrigin: origin });
    const dropped = connectionNotice({ state: "reconnecting", relayOrigin: origin });
    const connecting = connectionNotice({ state: "connecting", relayOrigin: origin });
    const notices = [none, storage, keys, otherRelay, revoked, dropped];
    for (const notice of notices) expect(notice).not.toBeNull();
    expect(new Set(notices.map((notice) => notice!.text)).size).toBe(notices.length);
    expect(connecting).toEqual(dropped);
    // A problem or a revocation isn't something that waits for a reconnect.
    for (const stopped of [storage, keys, otherRelay, revoked]) {
      expect(stopped!.severity).toBe("warning");
      expect(stopped!.text).not.toMatch(/reconnect/);
    }
    expect(dropped!.text).toMatch(/reconnect/);
  });
});

describe("seen and cleared on this computer (#17895)", () => {
  const marked = (questionId: string, seen: boolean, cleared: boolean, ask: string | null = null) =>
    item(questionId, OPEN, { inbox: { ask, seen, cleared } });

  it("lists a cleared question under Cleared, before History, and a seen one still in Needs you", () => {
    const groups = inboxGroups([
      marked("q1", true, false),
      marked("q2", false, true),
      item("q3", { kind: "settled", outcome: "expired" }),
      marked("q4", false, false),
    ]);
    expect(
      groups.map((group) => [group.id, group.items.map((i) => i.reference.questionId)])
    ).toEqual([
      ["needs-you", ["q1", "q4"]],
      ["cleared", ["q2"]],
      ["history", ["q3"]],
    ]);
    expect(groups.find((group) => group.id === "cleared")?.title).toBe("Cleared");
  });

  it("goes by standing for anything not in Needs you, whatever it carries", () => {
    expect(
      inboxGroupOf(
        item("q1", { kind: "to-type" }, { inbox: { ask: null, seen: true, cleared: true } })
      )
    ).toBe("delivering");
    expect(inboxGroupOf(marked("q2", false, true))).toBe("cleared");
  });

  it("lets a cleared row's group heading say it was cleared, as Needs you's does for an open one", () => {
    expect(inboxGroupOf(marked("q1", false, true))).toBe("cleared");
    expect(inboxGroupOf(marked("q1", true, false))).toBe("needs-you");
    expect(inboxRowNote(marked("q1", false, true))).toBeNull();
    expect(inboxRowNote(marked("q1", true, false))).toBeNull();
    expect(inboxRowNote(item("q1", { kind: "waiting", reason: "reply" }))).toBe(
      standingText({ kind: "waiting", reason: "reply" })
    );
  });

  it("still says what sets a cleared row apart: a reply the agent asked for, or a queued send", () => {
    const inbox = { ask: null, seen: false, cleared: true };
    const reply = item("q1", { kind: "waiting", reason: "reply" }, { inbox });
    const queued = item("q2", { kind: "queued" }, { inbox });
    expect(inboxGroupOf(reply)).toBe("cleared");
    expect(inboxGroupOf(queued)).toBe("cleared");
    expect(inboxRowNote(reply)).toBe(standingText({ kind: "waiting", reason: "reply" }));
    expect(inboxRowNote(queued)).toBe(standingText({ kind: "queued" }));
    for (const row of [reply, queued]) expect(inboxRowNote(row)).not.toBe(CLEARED_NOTE);
  });

  describe("seeableAsk", () => {
    const shown = (questionId: string, thread: DecisionThreadEntry[] = []) => ({
      reference: { hostId: "h1", projectId: "p1", terminalId: "t9", questionId },
      thread,
    });
    const agentMessage = (messageId: string, unreadable = false): DecisionThreadMessage => ({
      type: "message",
      messageId,
      from: "agent",
      text: null,
      images: [],
      expectsReply: false,
      sentAt: "2026-11-02T10:00:00.000Z",
      deliveryStatus: null,
      unreadable,
    });

    it("lets a read of the question alone see an ask with no follow-up, wherever its pane moved", () => {
      expect(seeableAsk(marked("q1", false, false), shown("q1"))).toEqual({ ask: null });
    });

    it("needs the follow-up the ask takes in, readable, in the read shown", () => {
      const q = marked("q1", false, false, "note-2");
      expect(seeableAsk(q, shown("q1", [agentMessage("note-1")]))).toBeNull();
      expect(seeableAsk(q, shown("q1", [agentMessage("note-2", true)]))).toBeNull();
      expect(
        seeableAsk(q, shown("q1", [{ ...agentMessage("note-2"), from: "person" }]))
      ).toBeNull();
      expect(seeableAsk(q, shown("q1", [agentMessage("note-1"), agentMessage("note-2")]))).toEqual({
        ask: "note-2",
      });
    });

    it("sees nothing of another question, of one already seen, or of one with nothing to mark", () => {
      expect(seeableAsk(marked("q1", false, false), shown("q2"))).toBeNull();
      expect(seeableAsk(marked("q1", true, true), shown("q1"))).toBeNull();
      expect(seeableAsk(item("q1", OPEN), shown("q1"))).toBeNull();
      // A cleared question can still be seen: seeing never takes it back into Needs you.
      expect(seeableAsk(marked("q1", false, true), shown("q1"))).toEqual({ ask: null });
    });

    it("lets a read show an ask whose follow-up couldn't be opened, for clearing (askShownIn)", () => {
      const q = marked("q1", true, false, "note-2");
      expect(askShownIn(q, shown("q1", [agentMessage("note-1")]))).toBe(false);
      expect(askShownIn(q, shown("q1", [agentMessage("note-2", true)]))).toBe(true);
      expect(askShownIn(marked("q1", false, false), shown("q1"))).toBe(true);
    });
  });

  it("says what a clear or restore did, only when it did something", () => {
    expect(markedText("clear", { result: "marked", marked: 3 })).toContain("3 questions");
    expect(markedText("restore", { result: "marked", marked: 1 })).toContain("1 question");
    expect(markedText("clear", { result: "marked", marked: 0 })).toBeNull();
    expect(markedText("clear", { result: "failed" })).not.toBeNull();
    expect(markedText("clear", { result: "failed" })).not.toBe(
      markedText("restore", { result: "failed" })
    );
  });

  describe("deadlines and how a question closed (#17943)", () => {
    const NOW = Date.parse("2026-11-20T14:00:00.000Z");
    const past = new Date(NOW - 1).toISOString();
    const ahead = new Date(NOW + 60_000).toISOString();

    it("moves an ask past its deadline by the clock to Awaiting update, never a reply asked for", () => {
      const elapsed = item("q1", OPEN, { expiresAt: past });
      const queued = item("q2", { kind: "queued" }, { expiresAt: past });
      const reply = item("q3", { kind: "waiting", reason: "reply" }, { expiresAt: past });
      const waiting = item("q4", OPEN, { expiresAt: ahead });
      expect(inboxGroupOf(elapsed, NOW)).toBe("awaiting");
      expect(inboxGroupOf(queued, NOW)).toBe("awaiting");
      expect(inboxGroupOf(reply, NOW)).toBe("needs-you");
      expect(inboxGroupOf(waiting, NOW)).toBe("needs-you");
      // Without a clock, as it always was.
      expect(inboxGroupOf(elapsed)).toBe("needs-you");

      const groups = inboxGroups([elapsed, queued, reply, waiting], NOW);
      expect(groups.map((group) => group.id)).toEqual(["needs-you", "awaiting"]);
      expect(groups[1]!.title).toBe("Awaiting update");
      expect(inboxRowNote(elapsed, NOW)).toBe(ELAPSED_NOTE);
    });

    it("keeps a cleared ask under Cleared past its deadline, and says only that it passed", () => {
      const inbox = { ask: null, seen: false, cleared: true };
      const cleared = item("q1", OPEN, { expiresAt: past, inbox });
      expect(inboxGroupOf(cleared, NOW)).toBe("cleared");
      expect(inboxRowNote(cleared, NOW)).toBe(CLEARED_ELAPSED_NOTE);
      expect(inboxRowNote(cleared, NOW)).not.toContain(CLEARED_NOTE);
      // A queued send past it reads the same; before it, there is nothing to add.
      const queued = item("q4", { kind: "queued" }, { expiresAt: past, inbox });
      expect(inboxRowNote(queued, NOW)).toBe(CLEARED_ELAPSED_NOTE);
      const upcoming = item("q2", OPEN, { expiresAt: ahead, inbox });
      expect(inboxGroupOf(upcoming, NOW)).toBe("cleared");
      expect(inboxRowNote(upcoming, NOW)).toBeNull();
      // A reply asked for after an answer isn't bound by the deadline it was asked under.
      const reply = item("q3", { kind: "waiting", reason: "reply" }, { expiresAt: past, inbox });
      expect(inboxRowNote(reply, NOW)).toBe(standingText({ kind: "waiting", reason: "reply" }));
    });

    it("tells each way a question closed without an answer apart", () => {
      const settled = (outcome: "withdrawn" | "expired" | "declined") =>
        ({ kind: "settled", outcome }) as const;
      const texts = [
        standingText(settled("declined")),
        standingText(settled("withdrawn")),
        standingText(settled("expired"), { replyMode: "blocking" }),
        standingText(settled("expired"), { replyMode: "advisory" }),
        standingText({ kind: "send-failed" }, { closedReason: "never-published" }),
        standingText({ kind: "send-failed" }),
      ];
      expect(new Set(texts).size).toBe(texts.length);
      // A legacy or older Host's expiry reads as every expiry did.
      expect(standingText(settled("expired"))).toBe(
        standingText(settled("expired"), { replyMode: "blocking" })
      );
      expect(inboxRowNote(item("q1", settled("expired"), { replyMode: "advisory" }))).toBe(
        standingText(settled("expired"), { replyMode: "advisory" })
      );
    });

    it("says a Remote Host's question is as last reported only while its Host is away", () => {
      expect(staleNote(item("q1", OPEN))).toBeNull();
      expect(
        staleNote(
          item("q1", OPEN, { remoteHost: { hostId: "h", name: "Studio", connected: true } })
        )
      ).toBeNull();
      expect(
        staleNote(
          item("q1", OPEN, { remoteHost: { hostId: "h", name: "Studio", connected: false } })
        )
      ).toMatch(/Studio.*last reported/);
    });

    it("says Clear stays on this computer and declines nothing, and Restore sends nothing", () => {
      expect(clearText(false)).toMatch(/this computer only/);
      expect(clearText(false)).toMatch(/Nothing is declined or sent/);
      expect(clearText(true)).toMatch(/Nothing is sent/);
    });
  });
});
