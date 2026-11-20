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
  attentionText,
  clearText,
  closedTime,
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
  waitingText,
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
    const groups = inboxGroups(ordered);
    const keyOf = (index: number) => referenceKey(ordered[index]!.reference);
    expect(resolveSelection([], null, null)).toBeNull();
    expect(resolveSelection([], { key: "gone", index: 1, picked: true }, null)).toBeNull();
    expect(resolveSelection(groups, null, null)).toBe(ordered[0]);
    expect(resolveSelection(groups, null, "t2")).toBe(ordered[1]);
    expect(resolveSelection(groups, null, "gone")).toBe(ordered[0]);
    expect(resolveSelection(groups, { key: keyOf(2), index: 0, picked: false }, "t2")).toBe(
      ordered[2]
    );
    // A picked row that went: the one now at its place, or the last when it was past the end,
    // ahead of the opener's.
    expect(resolveSelection(groups, { key: "gone", index: 1, picked: true }, null)).toBe(
      ordered[1]
    );
    expect(resolveSelection(groups, { key: "gone", index: 2, picked: true }, "t2")).toBe(
      ordered[2]
    );
    expect(resolveSelection(groups, { key: "gone", index: 9, picked: true }, null)).toBe(
      ordered[2]
    );
  });

  describe("what the inbox opens on by itself (#18022)", () => {
    const settled: DecisionQuestionStanding = { kind: "settled", outcome: "expired" };
    const cleared = item("q1", OPEN, {
      inbox: { ask: null, seen: true, cleared: true },
      reference: { hostId: "h1", projectId: "p1", terminalId: "t1", questionId: "q1" },
    });
    const closed = item("q2", settled, {
      reference: { hostId: "h1", projectId: "p1", terminalId: "t2", questionId: "q2" },
    });

    it("opens on nothing while only Cleared and History have questions", () => {
      const groups = inboxGroups([cleared, closed]);
      expect(groups.map((group) => group.id)).toEqual(["cleared", "history"]);
      expect(resolveSelection(groups, null, null)).toBeNull();
      expect(resolveSelection(groups, null, "elsewhere")).toBeNull();
    });

    it("opens on the first question of each group that still needs something, ahead of Cleared and History", () => {
      const nowMs = Date.parse("2026-11-02T12:00:00.000Z");
      const lead: Array<[string, DecisionQuestionListItem]> = [
        ["needs-you", item("q3", OPEN)],
        ["delivering", item("q3", { kind: "to-type" })],
        ["attention", item("q3", { kind: "needs-attention", deliveryStatus: "needs-attention" })],
        // Its deadline passed by this computer's clock.
        ["awaiting", item("q3", OPEN, { expiresAt: "2026-11-02T11:00:00.000Z" })],
      ];
      for (const [group, waiting] of lead) {
        const behind = { ...waiting, reference: { ...waiting.reference, questionId: "q4" } };
        const groups = inboxGroups([cleared, closed, waiting, behind], nowMs);
        expect(groups[0]!.id).toBe(group);
        expect(groups[0]!.items).toEqual([waiting, behind]);
        expect(resolveSelection(groups, null, null)).toBe(waiting);
      }
      // Of two groups that need something, the first.
      const typing = item("q5", { kind: "to-type" });
      const asking = item("q6", OPEN);
      expect(resolveSelection(inboxGroups([typing, asking]), null, null)).toBe(asking);
    });

    it("opens on the pane's own question whatever its group", () => {
      const waiting = item("q3", OPEN, {
        reference: { hostId: "h1", projectId: "p1", terminalId: "t9", questionId: "q3" },
      });
      const groups = inboxGroups([cleared, closed, waiting]);
      expect(resolveSelection(groups, null, "t2")).toBe(closed);
      expect(resolveSelection(groups, null, "t1")).toBe(cleared);
      // Of the pane's questions, the first listed.
      const later = item("q7", OPEN, {
        reference: { hostId: "h1", projectId: "p1", terminalId: "t2", questionId: "q7" },
      });
      expect(resolveSelection(inboxGroups([closed, later]), null, "t2")).toBe(later);
    });

    it("never moves onto a Cleared or History neighbour from a question the person didn't pick", () => {
      const groups = inboxGroups([cleared, closed]);
      // The question it opened on by itself went: nothing takes its place.
      expect(resolveSelection(groups, { key: "gone", index: 0, picked: false }, null)).toBeNull();
      // One the person picked went: they were reading there, so its neighbour does.
      expect(resolveSelection(groups, { key: "gone", index: 0, picked: true }, null)).toBe(cleared);
      // Once it went, a fresh look still finds the pane's own.
      expect(resolveSelection(groups, { key: "gone", index: 0, picked: false }, "t2")).toBe(closed);
    });
  });

  describe("the line above the list while Needs you is empty (#18022)", () => {
    const closed = item("q2", { kind: "settled", outcome: "expired" });
    const delivering = item("q3", { kind: "to-type" });

    it("says nothing waits only while Needs you is empty, seen questions counting as waiting", () => {
      const seen = item("q1", OPEN, { inbox: { ask: null, seen: true, cleared: false } });
      expect(waitingText(inboxGroups([seen, closed]), "connected")).toBeNull();
      expect(waitingText(inboxGroups([delivering, closed]), "connected")).toBe(
        "No questions waiting on you"
      );
      expect(waitingText(inboxGroups([closed]), "connected")).toBe("No questions waiting on you");
    });

    it("waits for Decisions' status before saying anything, and leaves an unreadable store to its notice", () => {
      expect(waitingText(inboxGroups([closed]), "pending")).toBeNull();
      expect(waitingText(inboxGroups([closed]), "pending", ["Studio"])).toBeNull();
      expect(waitingText([], "unreadable")).toBeNull();
    });

    it("speaks only for the questions shown when the list can't be taken at its word", () => {
      const unknown = waitingText(inboxGroups([closed]), "unknown");
      expect(unknown).toMatch(/^None of the questions here wait on you\. /);
      expect(unknown).toMatch(/status couldn't be read/);
      // The connection notice says why it isn't connected.
      expect(waitingText(inboxGroups([closed]), "unavailable")).toBe(
        "None of the questions here wait on you"
      );
      expect(waitingText([], "unavailable")).toBe("No questions on this computer");
      expect(waitingText([], "unknown")).toMatch(/^No questions on this computer\. /);
    });

    it("names a Remote Host that's away, wherever its questions are listed", () => {
      const away = (name: string, questionId: string) =>
        item(
          questionId,
          { kind: "settled", outcome: "answered", handled: false },
          {
            reference: { hostId: name, projectId: "p1", terminalId: "t1", questionId },
            remoteHost: { hostId: name, name, connected: false },
          }
        );
      const one = waitingText(
        inboxGroups([away("Studio", "q4"), away("Studio", "q5")]),
        "connected"
      );
      expect(one).toMatch(/^None of the questions here wait on you\. /);
      expect(one).toMatch(/Studio is away, so its questions are as last reported/);
      expect(
        waitingText(inboxGroups([away("Studio", "q4"), away("Lab", "q5")]), "connected")
      ).toMatch(/2 Remote Hosts are away/);
      const back = item("q6", OPEN, {
        inbox: { ask: null, seen: false, cleared: true },
        remoteHost: { hostId: "Studio", name: "Studio", connected: true },
      });
      expect(waitingText(inboxGroups([back]), "connected")).toBe("No questions waiting on you");
      // A row of its in Cleared names it as well as one in History.
      const set = {
        ...back,
        remoteHost: { hostId: "Studio", name: "Studio", connected: false },
      };
      expect(waitingText(inboxGroups([set]), "connected")).toMatch(/Studio is away/);
    });

    it("names a Remote Host the list says is away even with no question of its listed", () => {
      expect(waitingText([], "connected", ["Studio"])).toBe(
        "No questions on this computer. Studio is away, so its questions are as last reported."
      );
      expect(waitingText(inboxGroups([closed]), "connected", ["Studio"])).toMatch(
        /^None of the questions here wait on you\. Studio is away/
      );
      // Once per Host, from the list or a row of its.
      const row = item(
        "q8",
        { kind: "settled", outcome: "expired" },
        {
          remoteHost: { hostId: "studio", name: "Studio", connected: false },
        }
      );
      expect(waitingText(inboxGroups([row]), "connected", ["Studio"])).toMatch(/\. Studio is away/);
      // Each reason that holds, alongside a connection notice or an unknown status.
      expect(waitingText([], "unavailable", ["Studio"])).toBe(
        "No questions on this computer. Studio is away, so its questions are as last reported."
      );
      const both = waitingText([], "unknown", ["Studio"]);
      expect(both).toMatch(/status couldn't be read/);
      expect(both).toMatch(/Studio is away/);
      // The list's and the rows' Hosts together, and both reasons with rows listed.
      expect(waitingText(inboxGroups([row]), "connected", ["Lab"])).toMatch(
        /2 Remote Hosts are away/
      );
      const listed = waitingText(inboxGroups([closed]), "unknown", ["Studio"]);
      expect(listed).toMatch(/^None of the questions here wait on you\. /);
      expect(listed).toMatch(/status couldn't be read.*Studio is away/);
    });
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

describe("closedTime (#18025)", () => {
  it("is when the question closed, else when it was asked", () => {
    const asked = "2026-11-02T08:00:00.000Z";
    expect(closedTime({ askedAt: asked, settledAt: "2026-11-02T11:00:00.000Z" })).toEqual({
      at: "2026-11-02T11:00:00.000Z",
      kind: "closed",
    });
    expect(closedTime({ askedAt: asked, settledAt: null })).toEqual({ at: asked, kind: "asked" });
    expect(closedTime({ askedAt: asked, settledAt: "not a date" })).toEqual({
      at: asked,
      kind: "asked",
    });

describe("attentionText (#18054)", () => {
  const STOPPED: DecisionQuestionStanding = {
    kind: "needs-attention",
    deliveryStatus: "needs-attention",
  };
  const UNCERTAIN: DecisionQuestionStanding = {
    kind: "needs-attention",
    deliveryStatus: "delivery-uncertain",
  };
  const stall = (over: Partial<NonNullable<DecisionQuestionListItem["stall"]>> = {}) => ({
    answerRevision: 1,
    followUpIds: [] as string[],
    reason: "pane_gone",
    ...over,
  });

  it("names the answer that stopped and why, in the words the attention list uses", () => {
    expect(attentionText(STOPPED, { stall: stall() })).toBe(
      "Typing the answer into the terminal stopped. Choose what happens to it. The terminal that asked was closed."
    );
  });

  it("names a follow-up apart from the answer, and says why in its own words", () => {
    expect(
      attentionText(STOPPED, {
        stall: stall({ answerRevision: null, followUpIds: ["m1"], reason: "message_unreadable" }),
      })
    ).toBe(
      "Typing the follow-up into the terminal stopped. Choose what happens to it. The follow-up couldn't be decrypted on this computer."
    );
    expect(
      attentionText(UNCERTAIN, {
        stall: stall({ answerRevision: null, followUpIds: ["m1", "m2"], reason: "x.y" }),
      })
    ).toBe(
      "The follow-ups may or may not have been typed into the terminal. Check the terminal before anything is sent again."
    );
  });

  it("agrees with several follow-ups, and with an answer beside them, definite or not", () => {
    expect(
      attentionText(STOPPED, {
        stall: stall({ answerRevision: null, followUpIds: ["m1", "m2"], reason: "unspecified" }),
      })
    ).toBe("Typing the follow-ups into the terminal stopped. Choose what happens to them.");
    expect(
      attentionText(UNCERTAIN, {
        stall: stall({ followUpIds: ["m1"], reason: "inject_ambiguous" }),
      })
    ).toBe(
      "The answer or the follow-up may or may not have been typed into the terminal. Check the terminal before anything is sent again. Typing it in was interrupted, so it isn't typed again on its own."
    );
  });

  it("names a timeout notice by how the question closed, with a follow-up beside it", () => {
    const round = {
      closedReason: "expired" as const,
      closureNotice: { delivery: "needs-attention" as const, disposition: null },
    };
    expect(attentionText(STOPPED, { ...round, stall: stall({ reason: "unspecified" }) })).toBe(
      "Typing the notice that the question expired unanswered into the terminal stopped. Choose what happens to it."
    );
    expect(
      attentionText(STOPPED, {
        ...round,
        stall: stall({ followUpIds: ["m1"], reason: "unspecified" }),
      })
    ).toBe(
      "Typing the notice that the question expired unanswered and the follow-up into the terminal stopped. Choose what happens to them."
    );
  });

  it("falls back to naming both when the list carries no stall", () => {
    expect(attentionText(STOPPED)).toContain("An answer or follow-up was recorded");
    expect(attentionText(UNCERTAIN, { closedReason: "declined" })).toContain(
      "The notice that you declined it, or a follow-up,"
    );
  });
});
