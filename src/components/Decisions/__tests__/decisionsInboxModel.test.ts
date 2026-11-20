import { describe, expect, it } from "vitest";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { PaneDecisionState } from "@shared/types/decisions";
import { decisionItems } from "@/components/Terminal/decisionsChipModel";
import type {
  DecisionPendingDelivery,
  DecisionQuestionListItem,
  DecisionQuestionStanding,
  DecisionThreadEntry,
  DecisionThreadMessage,
} from "@shared/types/decisionsQuestion";
import type { AnswerPhase, DeclinePhase } from "@/store/decisionsAnswerStore";
import {
  CLEARED_ELAPSED_NOTE,
  CLEARED_NOTE,
  ELAPSED_NOTE,
  agentName,
  askerNotes,
  answerFate,
  askKey,
  askShownIn,
  askedOnHost,
  attentionNotice,
  attentionText,
  AWAY_NOTE,
  clearAllText,
  clearGoneText,
  clearText,
  closedTime,
  connectionNotice,
  findAsked,
  folds,
  goneAsks,
  dismissFate,
  deliveryFacts,
  groupOf,
  headerFacts,
  hiddenIn,
  inboxGroupOf,
  inboxGroups,
  inboxRowNote,
  inWindowProject,
  isAttention,
  landedBy,
  markedText,
  movedText,
  nextWaiting,
  originFacts,
  paneTitle,
  recordedLabel,
  referenceKey,
  replyLine,
  replyLineKey,
  replyToShow,
  resolveSelection,
  rowNote,
  scopedQuestions,
  scopeOffered,
  seeableAsk,
  shownGroups,
  shownItems,
  standingText,
  waitingText,
  whereFacts,
  worktreeName,
  type PaneTitleInputs,
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

  it("shows History a page at a time from the newest, keeping the question selected in view (#18033)", () => {
    const history = Array.from({ length: 10 }, (_, i) =>
      item(
        `h${i + 1}`,
        { kind: "settled", outcome: "expired" },
        {
          settledAt: `2026-11-02T10:${String(i).padStart(2, "0")}:00.000Z`,
        }
      )
    );
    const groups = inboxGroups([item("q1", OPEN), ...history]);
    const ids = (shown: ReturnType<typeof shownGroups>) =>
      shown.groups.map((group) => group.items.map((entry) => entry.reference.questionId));

    const page = shownGroups(groups, 3, null);
    // Every open question stays; History keeps its newest three.
    expect(ids(page)).toEqual([["q1"], ["h10", "h9", "h8"]]);
    expect(page.hidden).toBe(7);

    expect(page.next?.reference.questionId).toBe("h7");

    // A question selected further down stays in view on its own, after the page: never the
    // rows between, however far down it is.
    const middle = groups[1]!.items.find((entry) => entry.reference.questionId === "h4")!;
    const kept = shownGroups(groups, 3, middle);
    expect(ids(kept)).toEqual([["q1"], ["h10", "h9", "h8", "h4"]]);
    expect(kept.hidden).toBe(6);
    expect(kept.next?.reference.questionId).toBe("h7");
    // One already on the page stays where it is.
    expect(ids(shownGroups(groups, 3, groups[1]!.items[1]!))).toEqual(ids(page));
    // Selected as the next older one, the row after it is next.
    const following = groups[1]!.items[3]!;
    expect(shownGroups(groups, 3, following).next?.reference.questionId).toBe("h6");

    // The oldest row alone left out is the next one.
    expect(shownGroups(groups, 9, null)).toMatchObject({ hidden: 1 });
    expect(shownGroups(groups, 9, null).next?.reference.questionId).toBe("h1");

    expect(shownGroups(groups, 50, null)).toEqual({ groups, hidden: 0, next: null });
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

  it("names where a question was asked by the facts that are known, worktree before project", () => {
    const origin = { agent: "Claude", pane: null, host: null, away: false };
    // The worktree tells runs in one project apart, so a long project name gives way first.
    expect(originFacts({ ...origin, where: whereFacts("Daintree", "feature-x") })).toEqual([
      "Claude",
      "feature-x",
      "Daintree",
    ]);
    expect(originFacts({ ...origin, agent: "Codex", where: whereFacts(null, "w") })).toEqual([
      "Codex",
      "w",
    ]);
    expect(whereFacts("Daintree", null)).toEqual(["Daintree"]);
  });

  describe("telling two agents in one place apart (#18039)", () => {
    const MAIN_CHECKOUT = whereFacts("Daintree", "daintree");
    const run = (over: Partial<PaneTitleInputs> = {}): PaneTitleInputs => ({
      title: "Claude",
      agentId: "claude",
      agentState: "working",
      cwd: "/Users/me/Projects/daintree",
      ...over,
    });
    const title = (over: Partial<PaneTitleInputs> = {}) => paneTitle(run(over), "claude", "Claude");

    it("names the asking pane ahead of the place, so the place gives way first", () => {
      expect(MAIN_CHECKOUT).toEqual(["Daintree"]);
      const facts = (pane: string) =>
        originFacts({ agent: "Claude", pane, host: null, away: false, where: MAIN_CHECKOUT });
      expect(facts("Index migrations")).toEqual(["Claude in “Index migrations”", "Daintree"]);
      // Two of the same agent in the main checkout no longer read the same.
      expect(facts("Index migrations")).not.toEqual(facts("Fix auth tests"));
      expect(
        originFacts({
          agent: "Claude",
          pane: "Index migrations",
          host: null,
          away: false,
          where: whereFacts("Daintree", "feature-x"),
        })
      ).toEqual(["Claude in “Index migrations”", "feature-x", "Daintree"]);
    });

    it("puts a closed question's outcome after who asked, ahead of the place", () => {
      expect(
        originFacts(
          {
            agent: "Claude",
            pane: "Index migrations",
            host: "Mini",
            away: true,
            where: ["Daintree"],
          },
          "Expired unanswered"
        )
      ).toEqual([
        "Claude in “Index migrations” on Mini",
        "Expired unanswered",
        AWAY_NOTE,
        "Daintree",
      ]);
    });

    it("names a Remote Host's question by its Host whether or not it's connected", () => {
      const host = { agent: "Claude", pane: null, host: "Studio", where: MAIN_CHECKOUT };
      expect(originFacts({ ...host, away: false })).toEqual(["Claude on Studio", "Daintree"]);
      expect(originFacts({ ...host, away: true })).toEqual([
        "Claude on Studio",
        AWAY_NOTE,
        "Daintree",
      ]);
      expect(originFacts({ ...host, host: "Mini", away: false })).toEqual([
        "Claude on Mini",
        "Daintree",
      ]);
      // A local question names no Host, and nothing says it's away.
      expect(
        originFacts({ agent: "Claude", pane: null, host: null, away: false, where: MAIN_CHECKOUT })
      ).toEqual(["Claude", "Daintree"]);
    });

    it("heads the detail with the pane or the Host, then the place, leaving the agent to the question", () => {
      expect(
        headerFacts({
          agent: "Claude",
          pane: "Index migrations",
          host: null,
          away: false,
          where: MAIN_CHECKOUT,
        })
      ).toEqual(["“Index migrations”", "Daintree"]);
      expect(
        headerFacts({
          agent: "Claude",
          pane: null,
          host: "Studio",
          away: true,
          where: ["Daintree"],
        })
      ).toEqual(["On Studio", AWAY_NOTE, "Daintree"]);
      expect(
        headerFacts({ agent: "Claude", pane: null, host: "Mini", away: false, where: ["Daintree"] })
      ).toEqual(["On Mini", "Daintree"]);
      expect(
        headerFacts({
          agent: "Claude",
          pane: null,
          host: null,
          away: false,
          where: whereFacts("Daintree", "feature-x"),
        })
      ).toEqual(["feature-x", "Daintree"]);
    });

    it("titles the pane as its header does: the person's title, else the agent's task, else its title", () => {
      expect(title({ title: "Backend", titleMode: "user" })).toBe("Backend");
      // A title set by hand outranks whatever the agent says it is doing.
      expect(
        title({ title: "Backend", titleMode: "user", lastObservedTitle: "Fix auth tests" })
      ).toBe("Backend");
      expect(title({ lastObservedTitle: "Fix auth tests" })).toBe("Fix auth tests");
      expect(title({ title: "Claude [Z.ai]", titleMode: "custom" })).toBe("Claude [Z.ai]");
      // A preset's name stays ahead of the task, so two presets on one task still differ.
      expect(
        title({ title: "Claude [Z.ai]", titleMode: "custom", lastObservedTitle: "Fix flaky tests" })
      ).toBe("Claude [Z.ai]: Fix flaky tests");
      // Before detection the pane's own title stands, but no task it reported yet.
      expect(
        title({
          agentId: undefined,
          launchAgentId: "claude",
          title: "Claude [Z.ai]",
          titleMode: "custom",
          lastObservedTitle: "Fix auth tests",
        })
      ).toBe("Claude [Z.ai]");
      expect(title({ agentId: undefined, title: "Claude Opus" })).toBe("Claude Opus");
      // A given name that is only the agent's, or that the task repeats, isn't said twice.
      expect(
        title({ title: "Claude", titleMode: "custom", lastObservedTitle: "Fix auth tests" })
      ).toBe("Fix auth tests");
      const repeated = title({
        title: "Ops-West",
        titleMode: "custom",
        lastObservedTitle: "Ops-West: Fix auth",
      });
      expect(repeated).toMatch(/Fix auth/);
      expect(repeated).not.toMatch(/Ops-West.*Ops-West/);
      // An agent that has exited has no task now, whatever it last said.
      expect(
        title({ title: "Claude [Z.ai]", agentState: "exited", lastObservedTitle: "Fix auth tests" })
      ).toBe("Claude [Z.ai]");
    });

    it("keeps only the person's own title for a pane another agent has taken over", () => {
      expect(
        title({ agentId: "codex", title: "Codex", lastObservedTitle: "Migrate billing" })
      ).toBeNull();
      expect(title({ agentId: "codex", title: "Claude [Z.ai]", titleMode: "custom" })).toBeNull();
      // Launched as another agent, not yet detected.
      expect(title({ agentId: undefined, launchAgentId: "codex", title: "Codex" })).toBeNull();
      expect(
        title({
          agentId: "codex",
          title: "Backend",
          titleMode: "user",
          lastObservedTitle: "Migrate billing",
        })
      ).toBe("Backend");
    });

    it("has no title for a pane that only names its agent, or none at all", () => {
      expect(title()).toBeNull();
      expect(title({ title: "  claude " })).toBeNull();
      expect(title({ title: "Claude", titleMode: "custom" })).toBeNull();
      expect(paneTitle(run(), "claude", " Claude ")).toBeNull();
      // The agent naming itself is no task.
      expect(title({ lastObservedTitle: "Claude Code" })).toBeNull();
      expect(title({ title: undefined })).toBeNull();
      expect(title({ title: "   ", titleMode: "user" })).toBeNull();
      // Only the agent's own name is dropped: a title that differs by a symbol is a title.
      expect(paneTitle(run({ title: "C++", titleMode: "user" }), "claude", "C")).toBe("C++");
    });
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

  describe("a question the inbox is asked to show (#18047)", () => {
    const settled: DecisionQuestionStanding = {
      kind: "settled",
      outcome: "answered",
      handled: true,
    };
    const waiting = item("q1", OPEN);
    const closed = item("q2", settled, {
      reference: { hostId: "h1", projectId: "p1", terminalId: "t2", questionId: "q2" },
    });
    const hostCopy = item("q2", OPEN, {
      reference: { hostId: "build-box", projectId: "p9", terminalId: "t2", questionId: "q2" },
      remoteHost: { hostId: "build-box", name: "Build box", connected: true },
    });
    const groups = inboxGroups([hostCopy, waiting, closed]);
    const keyOf = (listed: DecisionQuestionListItem) => referenceKey(listed.reference);

    it("shows it in any group, ahead of the pane's first and the first waiting", () => {
      expect(
        resolveSelection(groups, null, "t1", "local", null, undefined, {
          terminalId: "t2",
          questionId: "q2",
        })
      ).toBe(closed);
      expect(
        resolveSelection(groups, null, null, "local", null, undefined, {
          terminalId: "t2",
          questionId: "q2",
          reference: hostCopy.reference,
        })
      ).toBe(hostCopy);
    });

    it("names a question by every part of its reference", () => {
      const ordered = groups.flatMap((group) => group.items);
      expect(
        findAsked(ordered, { terminalId: "t2", questionId: "q2", reference: closed.reference })
      ).toBe(closed);
      for (const part of ["hostId", "projectId", "terminalId"] as const) {
        expect(
          findAsked(ordered, {
            terminalId: "t2",
            questionId: "q2",
            reference: { ...closed.reference, [part]: "elsewhere" },
          }),
          part
        ).toBeUndefined();
      }
    });

    it("names one of a pane's by both its terminal and its id", () => {
      const ordered = groups.flatMap((group) => group.items);
      expect(findAsked(ordered, { terminalId: "t2", questionId: "q2" })).toBe(closed);
      expect(findAsked(ordered, { terminalId: "t9", questionId: "q2" })).toBeUndefined();
      expect(findAsked(ordered, { terminalId: "t2", questionId: "q9" })).toBeUndefined();
    });

    it("names one of this computer's panes' by terminal and id, never a Remote Host's alike", () => {
      const onlyHost = inboxGroups([hostCopy, waiting]);
      expect(
        findAsked(
          onlyHost.flatMap((group) => group.items),
          {
            terminalId: "t2",
            questionId: "q2",
          }
        )
      ).toBeUndefined();
      expect(
        resolveSelection(onlyHost, null, null, "local", null, undefined, {
          terminalId: "t2",
          questionId: "q2",
        })
      ).toBe(hostCopy);
    });

    it("names one of a Remote Host window's panes on that Host (#18049)", () => {
      const ordered = groups.flatMap((group) => group.items);
      expect(findAsked(ordered, { terminalId: "t2", questionId: "q2" }, "build-box")).toBe(
        hostCopy
      );
      expect(findAsked(ordered, { terminalId: "t2", questionId: "q2" }, "studio")).toBeUndefined();
      expect(
        resolveSelection(groups, null, null, "build-box", null, undefined, {
          terminalId: "t2",
          questionId: "q2",
        })
      ).toBe(hostCopy);
    });

    it("takes the place of what the inbox chose by itself once it is listed, never of a pick", () => {
      const asked = { terminalId: "t2", questionId: "q2" };
      // Listed after the opening: the inbox's own choice gives way to it.
      expect(
        resolveSelection(
          groups,
          { key: keyOf(waiting), index: 1, picked: false },
          null,
          "local",
          null,
          undefined,
          asked
        )
      ).toBe(closed);
      // Picked by the person, or in a picked row's place: theirs stays.
      expect(
        resolveSelection(
          groups,
          { key: keyOf(waiting), index: 1, picked: true },
          null,
          "local",
          null,
          undefined,
          asked
        )
      ).toBe(waiting);
      expect(
        resolveSelection(
          groups,
          { key: "gone", index: 0, picked: true },
          null,
          "local",
          null,
          undefined,
          asked
        )
      ).toBe(hostCopy);
    });

    it("falls back as before while it isn't listed", () => {
      const missing = { terminalId: "t9", questionId: "q9" };
      expect(resolveSelection(groups, null, "t1", "local", null, undefined, missing)).toBe(waiting);
      expect(resolveSelection(groups, null, null, "local", null, undefined, missing)).toBe(
        hostCopy
      );
      expect(
        resolveSelection(
          groups,
          { key: keyOf(closed), index: 2, picked: false },
          null,
          "local",
          null,
          undefined,
          missing
        )
      ).toBe(closed);
    });
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
      // The question it opened on by itself went: nothing takes its place, drawn or not.
      expect(resolveSelection(groups, { key: "gone", index: 0, picked: false }, null)).toBeNull();
      expect(
        resolveSelection(
          groups,
          { key: "gone", index: 0, picked: false },
          null,
          LOCAL_HOST_ID,
          null,
          new Set(["cleared", "history"])
        )
      ).toBeNull();
      // One the person picked went: they were reading there, so its neighbour does, once drawn.
      expect(
        resolveSelection(
          groups,
          { key: "gone", index: 0, picked: true },
          null,
          LOCAL_HOST_ID,
          null,
          new Set(["cleared"])
        )
      ).toBe(cleared);
      // Once it went, a fresh look still finds the pane's own.
      expect(resolveSelection(groups, { key: "gone", index: 0, picked: false }, "t2")).toBe(closed);
    });
  });

  describe("folding History and Cleared (#18023)", () => {
    const settled: DecisionQuestionStanding = { kind: "settled", outcome: "expired" };
    const asking = item("q1", OPEN);
    const typing = item("q2", { kind: "to-type" });
    const cleared = item("q3", OPEN, { inbox: { ask: null, seen: true, cleared: true } });
    const closed = item("q4", settled);
    const older = item("q5", settled);
    const groups = inboxGroups([asking, typing, cleared, closed, older]);
    const keyOf = (entry: DecisionQuestionListItem) => referenceKey(entry.reference);

    it("folds only what is over or set aside", () => {
      expect(groups.map((group) => [group.id, folds(group.id)])).toEqual([
        ["needs-you", false],
        ["delivering", false],
        ["cleared", true],
        ["history", true],
      ]);
      expect(folds("awaiting")).toBe(false);
      expect(folds("attention")).toBe(false);
    });

    it("draws a folding group's rows only while it is open, and says which shut group hides one", () => {
      expect(shownItems(groups, new Set())).toEqual([asking, typing]);
      expect(shownItems(groups, new Set(["history"]))).toEqual([asking, typing, closed, older]);
      expect(shownItems(groups, new Set(["cleared", "history"]))).toEqual([
        asking,
        typing,
        cleared,
        closed,
        older,
      ]);
      expect(hiddenIn(groups, keyOf(closed), new Set())).toBe("history");
      expect(hiddenIn(groups, keyOf(cleared), new Set(["history"]))).toBe("cleared");
      expect(hiddenIn(groups, keyOf(closed), new Set(["history"]))).toBeNull();
      expect(hiddenIn(groups, keyOf(cleared), new Set(["cleared"]))).toBeNull();
      expect(hiddenIn(groups, keyOf(asking), new Set())).toBeNull();
      expect(hiddenIn(groups, "gone", new Set())).toBeNull();
    });

    it("keeps a chosen question a shut group hides", () => {
      const choice = { key: keyOf(closed), index: 1, picked: true };
      expect(resolveSelection(groups, choice, null, LOCAL_HOST_ID, null, new Set())).toBe(closed);
      expect(
        resolveSelection(groups, { ...choice, picked: false }, null, LOCAL_HOST_ID, null, new Set())
      ).toBe(closed);
    });

    it("takes a picked question's place from the drawn rows, never one a shut group hides", () => {
      // Drawn: asking, typing. A pick that went from the end lands on the last drawn row.
      expect(resolveSelection(groups, { key: "gone", index: 2, picked: true }, null)).toBe(typing);
      expect(
        resolveSelection(
          groups,
          { key: "gone", index: 2, picked: true },
          null,
          LOCAL_HOST_ID,
          null,
          new Set(["history"])
        )
      ).toBe(closed);
      expect(resolveSelection(groups, { key: "gone", index: 0, picked: true }, null)).toBe(asking);
      expect(resolveSelection(groups, { key: "gone", index: -1, picked: true }, null)).toBe(asking);
      // Nothing drawn: no place to take, so the pane's own, else nothing.
      const passive = inboxGroups([cleared, closed]);
      expect(resolveSelection(passive, { key: "gone", index: 0, picked: true }, null)).toBeNull();
      const own = { ...closed, reference: { ...closed.reference, terminalId: "t7" } };
      expect(
        resolveSelection(inboxGroups([cleared, own]), { key: "gone", index: 0, picked: true }, "t7")
      ).toBe(own);
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

  it("takes a question as asked on a view's machine only by that machine, whatever its ids (#18049)", () => {
    const studio = { hostId: "studio", name: "Studio", connected: true };
    const own = item("q1", OPEN);
    const theirs = item("q2", OPEN, { remoteHost: studio });
    expect(askedOnHost(own, "local")).toBe(true);
    expect(askedOnHost(theirs, "local")).toBe(false);
    expect(askedOnHost(theirs, "studio")).toBe(true);
    expect(askedOnHost(own, "studio")).toBe(false);
    expect(askedOnHost(theirs, "build-box")).toBe(false);
  });

  it("opens at the opener's question on the view's own machine when terminal ids repeat across machines", () => {
    // This computer, Studio and Build box each have a terminal "t1" with a question.
    const own = item("q1", OPEN, { askedAt: "2026-11-02T10:00:00.000Z" });
    const studio = item("q2", OPEN, {
      askedAt: "2026-11-02T10:01:00.000Z",
      remoteHost: { hostId: "studio", name: "Studio", connected: true },
    });
    const buildBox = item("q3", OPEN, {
      askedAt: "2026-11-02T10:02:00.000Z",
      remoteHost: { hostId: "build-box", name: "Build box", connected: false },
    });
    const groups = inboxGroups([own, studio, buildBox]);
    expect(resolveSelection(groups, null, "t1")).toBe(own);
    expect(resolveSelection(groups, null, "t1", "local")).toBe(own);
    expect(resolveSelection(groups, null, "t1", "studio")).toBe(studio);
    expect(resolveSelection(groups, null, "t1", "build-box")).toBe(buildBox);
    // A Host whose questions aren't listed: no pane of its is the opener's, so the first waiting.
    expect(resolveSelection(inboxGroups([own, buildBox]), null, "t1", "studio")).toBe(own);
    expect(resolveSelection(inboxGroups([studio, buildBox]), null, "t1", "local")).toBe(studio);
  });

  describe("the window's own project (#18051)", () => {
    const at = (questionId: string, projectId: string, terminalId = "t1") => ({
      hostId: "h1",
      projectId,
      terminalId,
      questionId,
    });
    const LOCAL_P1 = { hostId: "local", projectId: "p1" };
    const STUDIO_P1 = { hostId: "studio", projectId: "p1" };
    const here = item("q1", { kind: "settled", outcome: "expired" });
    const hereWaiting = item("q2", OPEN, { reference: at("q2", "p1", "t2") });
    const there = item("q3", OPEN, { reference: at("q3", "p2", "t3"), projectLabel: "Other" });
    // The same bare project id, reported by a Remote Host that is away under its own question host.
    const studio = item("q4", OPEN, {
      reference: { ...at("q4", "p1", "t4"), hostId: "qhost_studio" },
      remoteHost: { hostId: "studio", name: "Studio", connected: false },
    });

    it("matches the window's Host as well as its project", () => {
      expect(inWindowProject(here, LOCAL_P1)).toBe(true);
      expect(inWindowProject(there, LOCAL_P1)).toBe(false);
      // Studio's p1 is another computer's project in a local window, and the one a Studio window shows.
      expect(inWindowProject(studio, LOCAL_P1)).toBe(false);
      expect(inWindowProject(studio, STUDIO_P1)).toBe(true);
      expect(inWindowProject(here, STUDIO_P1)).toBe(false);
      expect(inWindowProject(here, null)).toBe(false);
    });

    it("offers to narrow only while the list holds the window's project and another", () => {
      expect(scopeOffered([], LOCAL_P1)).toBe(false);
      expect(scopeOffered([here, hereWaiting], LOCAL_P1)).toBe(false);
      // Nothing of the window's own: narrowing could only show an empty list.
      expect(scopeOffered([there, studio], LOCAL_P1)).toBe(false);
      expect(scopeOffered([here, there], LOCAL_P1)).toBe(true);
      expect(scopeOffered([studio, here], LOCAL_P1)).toBe(true);
      expect(scopeOffered([studio, here], STUDIO_P1)).toBe(true);
      expect(scopeOffered([here, there], null)).toBe(false);
    });

    it("lists the window's project's questions, in the list's order, once narrowed", () => {
      const all = [there, hereWaiting, studio, here];
      expect(scopedQuestions(all, "all", LOCAL_P1)).toEqual(all);
      expect(scopedQuestions(all, "project", LOCAL_P1)).toEqual([hereWaiting, here]);
      expect(scopedQuestions(all, "project", STUDIO_P1)).toEqual([studio]);
    });

    it("opens on the window's project's question that needs the person, behind the pane's own", () => {
      const groups = inboxGroups([there, studio, here, hereWaiting]);
      expect(resolveSelection(groups, null, null)).toBe(there);
      expect(resolveSelection(groups, null, null, "local", LOCAL_P1)).toBe(hereWaiting);
      expect(resolveSelection(groups, null, null, "studio", STUDIO_P1)).toBe(studio);
      // The pane that opened the inbox still leads, in History too.
      expect(resolveSelection(groups, null, "t1", "local", LOCAL_P1)).toBe(here);
      // None needs the person: a delivery keeps the list's order.
      const delivering = item("q5", { kind: "to-type" }, { reference: at("q5", "p1", "t5") });
      const thereDelivering = { ...there, standing: { kind: "to-type" as const } };
      const quiet = inboxGroups([here, thereDelivering, delivering]);
      expect(resolveSelection(quiet, null, null, "local", LOCAL_P1)).toBe(thereDelivering);
      // Set aside on this computer, or past its deadline, it no longer needs the person.
      const cleared = { ...hereWaiting, inbox: { ask: null, seen: true, cleared: true } };
      expect(resolveSelection(inboxGroups([there, cleared]), null, null, "local", LOCAL_P1)).toBe(
        there
      );
      expect(resolveSelection(inboxGroups([cleared]), null, null, "local", LOCAL_P1)).toBeNull();
      const nowMs = Date.parse("2026-11-02T12:00:00.000Z");
      const elapsed = { ...hereWaiting, expiresAt: "2026-11-02T11:00:00.000Z" };
      expect(
        resolveSelection(inboxGroups([there, elapsed], nowMs), null, null, "local", LOCAL_P1)
      ).toBe(there);
      // With nothing waiting, Awaiting update keeps its own order.
      const thereElapsed = { ...there, expiresAt: "2026-11-02T11:00:00.000Z" };
      expect(
        resolveSelection(inboxGroups([thereElapsed, elapsed], nowMs), null, null, "local", LOCAL_P1)
      ).toBe(thereElapsed);
      // Of this project's, the first that waits.
      const hereLater = item("q6", OPEN, { reference: at("q6", "p1", "t6") });
      expect(
        resolveSelection(
          inboxGroups([there, hereWaiting, hereLater]),
          null,
          null,
          "local",
          LOCAL_P1
        )
      ).toBe(hereWaiting);
    });

    it("names what Clear Needs you reaches when it could be more than the window's project", () => {
      expect(clearAllText("all", false)).toBe("Clear Needs you");
      const everywhere = clearAllText("all", true);
      const narrowed = clearAllText("project", true);
      expect(new Set([clearAllText("all", false), everywhere, narrowed]).size).toBe(3);
      expect(everywhere).toMatch(/all projects/);
      expect(narrowed).toMatch(/this project/);
      expect(clearAllText("project", false)).toBe(narrowed);
    });

    it("speaks for the window's project alone once narrowed", () => {
      const closed = inboxGroups([here]);
      const quiet = waitingText(closed, "connected", [], "project");
      expect(quiet).toMatch(/in this project/);
      expect(quiet).not.toBe(waitingText(closed, "connected"));
      // An empty narrowed list says there is nothing in the project, not that nothing waits.
      const none = waitingText([], "connected", [], "project");
      expect(none).toMatch(/in this project/);
      expect(none).not.toBe(quiet);
      // A Host whose rows aren't shown says nothing here; one whose rows are still names itself.
      expect(waitingText(closed, "connected", ["Lab"], "project")).toBe(quiet);
      expect(waitingText(closed, "unknown", ["Lab"], "project")).not.toMatch(/Lab/);
      // Its status unknown, an empty narrowed list still speaks for the project alone.
      const unknownNone = waitingText([], "unknown", ["Lab"], "project");
      expect(unknownNone).toMatch(/^No questions in this project\. /);
      expect(unknownNone).toMatch(/status couldn't be read/);
      expect(unknownNone).not.toMatch(/Lab/);
      const studioClosed = {
        ...studio,
        standing: { kind: "settled" as const, outcome: "expired" as const },
      };
      expect(waitingText(inboxGroups([studioClosed]), "connected", ["Lab"], "project")).toMatch(
        /Studio is away/
      );
      expect(waitingText(inboxGroups([hereWaiting]), "connected", [], "project")).toBeNull();
    });
  });

  it("keeps the chosen question once its answer is listed under another pane (#18027)", () => {
    const chosen = item("q2", OPEN).reference;
    const choice = { key: referenceKey(chosen), index: 1, picked: true };
    const moved = item("q2", OPEN, { reference: { ...chosen, projectId: "p2", terminalId: "t7" } });
    const groups = inboxGroups([item("q1", OPEN), item("q3", OPEN), moved]);
    expect(resolveSelection(groups, choice, null)).toBe(moved);
    // Another host's question by the same id is a different question.
    const elsewhere = item("q2", OPEN, { reference: { ...chosen, hostId: "h2" } });
    const others = inboxGroups([item("q1", OPEN), item("q3", OPEN), elsewhere]);
    expect(resolveSelection(others, choice, null)).toBe(others[0]!.items[1]);
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
  });
});

describe("what stopped, said once (#18026)", () => {
  const STOPPED: DecisionQuestionStanding = {
    kind: "needs-attention",
    deliveryStatus: "needs-attention",
  };
  const UNCERTAIN: DecisionQuestionStanding = {
    kind: "needs-attention",
    deliveryStatus: "delivery-uncertain",
  };
  const ATLAS = { hostId: "atlas", name: "Atlas", connected: true };

  function stalled(
    standing: DecisionQuestionStanding,
    stall: DecisionQuestionListItem["stall"],
    over: Partial<DecisionQuestionListItem> = {}
  ): DecisionQuestionListItem {
    return item("q4", standing, { closedReason: null, closureNotice: null, stall, ...over });
  }

  function expired(
    standing: DecisionQuestionStanding,
    notice: "needs-attention" | "uncertain",
    followUpIds: string[] = [],
    over: Partial<DecisionQuestionListItem> = {}
  ): DecisionQuestionListItem {
    return stalled(
      standing,
      { answerRevision: 0, followUpIds, reason: "resume_exited" },
      {
        closedReason: "expired",
        closureNotice: { delivery: notice, disposition: "fallback-due" },
        ...over,
      }
    );
  }

  const followUpsOnly = (standing: DecisionQuestionStanding, followUpIds: string[]) =>
    stalled(standing, { answerRevision: null, followUpIds, reason: "pane_gone" });

  it("names what stopped in the row, and keeps the row's words when nothing was recorded", () => {
    expect(
      inboxRowNote(stalled(STOPPED, { answerRevision: 2, followUpIds: [], reason: "pane_gone" }))
    ).toBe("Answer not typed in");
    expect(inboxRowNote(followUpsOnly(STOPPED, ["m1", "m2"]))).toBe("Follow-ups not typed in");
    expect(inboxRowNote(followUpsOnly(STOPPED, ["m1"]))).toBe("Follow-up not typed in");
    expect(inboxRowNote(followUpsOnly(UNCERTAIN, ["m1"]))).toBe(
      "Follow-up may not have been typed in"
    );
    expect(inboxRowNote(expired(STOPPED, "needs-attention", ["m1"]))).toBe(
      "Timeout notice and follow-up not typed in"
    );
    // The notice stopped, a follow-up may have been typed: the row can only say "may not".
    expect(inboxRowNote(expired(UNCERTAIN, "needs-attention", ["m1"]))).toBe(
      "Timeout notice and follow-up may not have been typed in"
    );
    expect(inboxRowNote(expired(UNCERTAIN, "uncertain"))).toBe(
      "Timeout notice may not have been typed in"
    );
    expect(rowNote(STOPPED)).toBe("Delivery stopped");
    expect(rowNote(UNCERTAIN)).toBe("May not have been delivered");
  });

  it("says the same to the ear, in agreement with how many things stopped", () => {
    expect(standingText(STOPPED, followUpsOnly(STOPPED, ["m1", "m2"]))).toBe(
      "Follow-ups weren't typed in and need attention"
    );
    expect(standingText(STOPPED, followUpsOnly(STOPPED, ["m1"]))).toBe(
      "Follow-up wasn't typed in and needs attention"
    );
    expect(
      standingText(UNCERTAIN, {
        closedReason: null,
        stall: { answerRevision: 1, followUpIds: [], reason: "inject_ambiguous" },
      })
    ).toBe("Answer may or may not have been typed in");
    expect(standingText(STOPPED)).toBe("Delivery stopped and needs attention");
  });

  it("says what stopped and why, in the notification's words, then what to do here", () => {
    expect(
      attentionText(stalled(STOPPED, { answerRevision: 2, followUpIds: [], reason: "pane_gone" }))
    ).toBe(
      "The answer wasn't typed in. The terminal that asked was closed. Choose what happens to it."
    );
    expect(
      attentionText(
        stalled(STOPPED, { answerRevision: 2, followUpIds: ["m1"], reason: "resume_exited" })
      )
    ).toBe(
      "The answer and your follow-up weren't typed in. The resumed agent exited before the answer was typed in. Choose what happens to them."
    );
    // The notice's own code reads as the notice's.
    expect(attentionText(expired(STOPPED, "needs-attention"))).toBe(
      "The timeout notice wasn't typed in. The resumed agent exited before the timeout notice was typed in. Choose what happens to it."
    );
    // A code with no words leaves only what stopped.
    expect(
      attentionText(
        stalled(STOPPED, { answerRevision: null, followUpIds: ["m1"], reason: "unspecified" })
      )
    ).toBe("Your follow-up wasn't typed in. Choose what happens to it.");
  });

  it("stays as unsure as the record is, and tells the notice's own delivery from the follow-ups'", () => {
    expect(
      attentionText(
        stalled(UNCERTAIN, { answerRevision: 1, followUpIds: [], reason: "inject_ambiguous" })
      )
    ).toBe(
      "The answer may or may not have been typed in. Typing it in was interrupted, so it isn't typed again on its own. Check the terminal before anything is sent again."
    );
    // The notice stopped for certain: the uncertainty is the follow-ups'.
    expect(attentionText(expired(UNCERTAIN, "needs-attention", ["m1", "m2"]))).toBe(
      "The timeout notice wasn't typed in. The resumed agent exited before the timeout notice was typed in. Your follow-ups may or may not have been typed in. Check the terminal before anything is sent again."
    );
    // The notice is unsure, and the list can't say which follow-up is: each may or may not be in.
    expect(attentionText(expired(UNCERTAIN, "uncertain", ["m1"]))).toBe(
      "The timeout notice and your follow-up may or may not have been typed in. The resumed agent exited before the timeout notice was typed in. Check the terminal before anything is sent again."
    );
  });

  it("hedges only what the list can't say: which a held slot holds, or anything when nothing was recorded", () => {
    // A Host from before #17943 reports no round.
    const legacy = stalled(
      STOPPED,
      { answerRevision: 1, followUpIds: ["m1"], reason: "inject_rejected" },
      { closedReason: undefined, closureNotice: undefined }
    );
    expect(inboxRowNote(legacy)).toBe("Answer or timeout notice and follow-up not typed in");
    expect(attentionText(legacy)).toBe(
      "The answer or timeout notice and your follow-up weren't typed in. The terminal refused the answer or timeout notice. Choose what happens to them."
    );
    // A round reported without its closing notice can't tell the notice from the answer either.
    expect(
      inboxRowNote(
        stalled(
          UNCERTAIN,
          { answerRevision: 0, followUpIds: [], reason: "pane_gone" },
          { closedReason: "expired", closureNotice: undefined }
        )
      )
    ).toBe("Answer or timeout notice may not have been typed in");
    // A code only an answer has says what the slot holds.
    expect(
      attentionText({ ...legacy, stall: { ...legacy.stall!, reason: "unknown_option" } })
    ).toBe(
      "The answer and your follow-up weren't typed in. The answer doesn't fit what the question allows. Choose what happens to them."
    );
    expect(attentionText({ ...legacy, standing: UNCERTAIN, stall: null })).toBe(
      "An answer, a notice or a follow-up may or may not have been typed in. Check the terminal before anything is sent again."
    );
  });

  it("names the Remote Host that keeps it instead of inviting a choice, and where its words would say this computer", () => {
    expect(
      attentionText(
        stalled(
          STOPPED,
          { answerRevision: 1, followUpIds: [], reason: "answer_unreadable" },
          { remoteHost: ATLAS }
        )
      )
    ).toBe(
      "The answer wasn't typed in. The answer couldn't be decrypted on Atlas. Atlas keeps it, so it can't be resolved from this computer."
    );
    const text = attentionText(expired(UNCERTAIN, "uncertain", ["m1"], { remoteHost: ATLAS }));
    expect(text).toMatch(
      /Check the terminal before anything is sent again\. Atlas keeps them, so they can't be resolved from this computer\.$/
    );
    expect(text).not.toMatch(/Choose/);
  });

  it("claims the notice only when the warning states the notice's own delivery", () => {
    expect(attentionNotice(expired(STOPPED, "needs-attention"))).toEqual({
      closedReason: "expired",
      delivery: "needs-attention",
    });
    // Uncertain only because of a follow-up: the notice itself stopped.
    expect(attentionNotice(expired(UNCERTAIN, "needs-attention", ["m1"]))).toEqual({
      closedReason: "expired",
      delivery: "needs-attention",
    });
    expect(
      attentionNotice(expired(UNCERTAIN, "uncertain", ["m1"], { closedReason: "never-published" }))
    ).toEqual({ closedReason: "never-published", delivery: "uncertain" });
    // Follow-ups alone, an answer, or a slot the list can't name: the warning says nothing of the notice.
    expect(
      attentionNotice(
        expired(UNCERTAIN, "uncertain", ["m1"], {
          stall: { answerRevision: null, followUpIds: ["m1"], reason: "pane_gone" },
        })
      )
    ).toBeNull();
    expect(
      attentionNotice(stalled(STOPPED, { answerRevision: 1, followUpIds: [], reason: "pane_gone" }))
    ).toBeNull();
    expect(
      attentionNotice(expired(STOPPED, "needs-attention", [], { closureNotice: undefined }))
    ).toBeNull();
    expect(attentionNotice({ ...expired(STOPPED, "needs-attention"), standing: OPEN })).toBeNull();
  });
});

describe("a request for a reply on its row (#18040)", () => {
  const REPLY: DecisionQuestionStanding = { kind: "waiting", reason: "reply" };

  function said(
    messageId: string,
    text: string | null,
    over: Partial<DecisionThreadMessage> = {}
  ): DecisionThreadMessage {
    return {
      type: "message",
      messageId,
      from: "agent",
      text,
      images: [],
      expectsReply: true,
      sentAt: "2026-11-02T10:05:00.000Z",
      deliveryStatus: null,
      unreadable: false,
      ...over,
    };
  }

  it("names the request only while the question waits on the person for a reply", () => {
    const asking = item("q1", REPLY, { replyRequest: "ask-1" });
    expect(replyToShow(asking)).toBe("ask-1");
    expect(replyLineKey(asking)).toBe(`${referenceKey(asking.reference)}\u0000ask-1`);
    expect(replyLineKey({ ...asking, replyRequest: "ask-2" })).not.toBe(replyLineKey(asking));

    // A delivery that stopped leads with that, whatever the agent asked; an open one asks its question.
    for (const standing of [
      { kind: "needs-attention", deliveryStatus: "needs-attention" },
      { kind: "waiting", reason: "open" },
      { kind: "to-type" },
      { kind: "settled", outcome: "answered", handled: false },
    ] as const) {
      const other = item("q1", standing, { replyRequest: "ask-1" });
      expect(replyToShow(other)).toBeNull();
      expect(replyLineKey(other)).toBeNull();
    }
  });

  it("reads the request's first line with words, escape sequences and controls gone", () => {
    const shown = {
      thread: [
        said("ask-0", "An older ask"),
        said("ask-1", "\u001b[0m\r\n \u200b \n  Which \u001b[1mregion\u001b[0m?\u0007\nEU or US."),
        // A window title whose sequence spans a line break.
        said("ask-2", "\u001b]0;build\nlog\u0007Which zone?\nOr both."),
      ],
    };
    expect(replyLine(shown, "ask-1")).toBe("Which region?");
    expect(replyLine(shown, "ask-2")).toBe("Which zone?");
    expect(replyLine(shown, "ask-0")).toBe("An older ask");
  });

  it("has no line for a request it can't read, one without words, or a message that isn't the agent's", () => {
    const shown = {
      thread: [
        said("unreadable", "Words it couldn't check", { unreadable: true }),
        said("wordless", " \n\u001b[0m\n "),
        said("person", "Keep going", { from: "person" }),
      ] satisfies DecisionThreadEntry[],
    };
    for (const id of ["unreadable", "wordless", "person", "absent"]) {
      expect(replyLine(shown, id)).toBeNull();
    }
  });
});

describe("askerNotes (#18029)", () => {
  const OPEN = { kind: "waiting", reason: "open" } as const;
  type Asker = NonNullable<DecisionQuestionListItem["asker"]>;
  const at = (asker: Asker, over: Partial<DecisionQuestionListItem> = {}) =>
    askerNotes(item("q1", OPEN, { asker, ...over }));
  const resumable = { directory: "present", resume: "resumable" } as const;

  it("says each way the terminal that asked was seen, and lets each be cleared in one step", () => {
    expect(at({ target: "closed", ...resumable })?.row).toBe("Terminal ended · Resume possible");
    expect(at({ target: "trashed", ...resumable })).toMatchObject({
      row: "Terminal in Trash · Resume possible",
      detail: expect.stringMatching(/^The terminal that asked is in the Trash\. /),
    });
    expect(at({ target: "replaced", ...resumable })?.detail).toBe(
      "The terminal that asked was restarted or reused since it asked. When an answer is sent, Daintree can try to resume its Claude session in a new terminal to take it."
    );
    expect(at({ target: "moved", directory: "present", resume: "other-worktree" })).toMatchObject({
      row: "Terminal moved · Can't resume",
      detail:
        "The terminal that asked is now in another worktree. Its session runs there now, so it isn't resumed in the worktree it asked from.",
    });
    for (const target of ["closed", "trashed", "moved", "replaced", "agent-undetected"] as const) {
      expect(at({ target, ...resumable })?.gone).toBe(true);
    }
  });

  it("names the agent whose session would be tried", () => {
    expect(at({ target: "closed", ...resumable }, { agentKind: "codex" })?.detail).toContain(
      `its ${agentName("codex")} session`
    );
  });

  it("warns the composer only when nothing observed can take the answer and its session can't be resumed", () => {
    expect(at({ target: "closed", ...resumable })?.composer).toBeNull();
    expect(at({ target: "closed", directory: "unknown", resume: "unknown" })?.composer).toBeNull();
    const refused = at({ target: "closed", directory: "missing", resume: "worktree-missing" });
    expect(refused?.row).toBe("Terminal ended · Folder missing · Can't resume");
    expect(refused?.composer).toBe(
      "Nothing observed can take this answer now. The terminal that asked is no longer running. The folder it asked from is gone. Its session can't be resumed without that folder."
    );
    expect(at({ target: "trashed", directory: "present", resume: "ended" })?.composer).toMatch(
      /already resumed once/
    );
    expect(
      at(
        { target: "trashed", directory: "present", resume: "unsupported-agent" },
        { agentKind: "gemini" }
      )?.detail
    ).toContain(`doesn't resume ${agentName("gemini")} sessions`);
  });

  it("names a folder seen gone even when another check refuses the resume first", () => {
    const notes = at({ target: "closed", directory: "missing", resume: "no-session" });
    expect(notes?.row).toBe("Terminal ended · Folder missing · Can't resume");
    expect(notes?.detail).toBe(
      "The terminal that asked is no longer running. The folder it asked from is gone. No session id was recorded when it asked, so its session can't be resumed."
    );
  });

  it("says no agent is detected, without claiming one is gone or that a resume follows", () => {
    const notes = at({ target: "agent-undetected", ...resumable });
    expect(notes).toEqual({
      row: "Agent not detected",
      detail: "The terminal that asked is still open, but no agent is detected in it any more.",
      composer:
        "No agent is detected in the terminal that asked. An answer isn't typed in while none is detected there.",
      gone: true,
    });
    expect(
      at({ target: "agent-undetected", directory: "missing", resume: "worktree-missing" })?.row
    ).toBe("Agent not detected · Folder missing");
  });

  it("claims nothing of a running or unread asker, a later standing, or a connected Host", () => {
    expect(at({ target: "running", ...resumable })).toBeNull();
    expect(at({ target: "unknown", directory: "unknown", resume: "unknown" })).toBeNull();
    expect(askerNotes(item("q1", OPEN))).toBeNull();
    const closed = { target: "closed", directory: "present", resume: "no-session" } as const;
    expect(askerNotes(item("q1", { kind: "to-type" }, { asker: closed }))).toBeNull();
    expect(
      askerNotes(item("q1", { kind: "waiting", reason: "reply" }, { asker: closed }))
    ).toBeNull();
    expect(
      askerNotes(
        item("q1", OPEN, { remoteHost: { hostId: "studio", name: "Studio", connected: true } })
      )
    ).toBeNull();
  });

  it("names a folder gone under a terminal still open, without calling the asker gone", () => {
    expect(at({ target: "running", directory: "missing", resume: "worktree-missing" })).toEqual({
      row: "Folder missing",
      detail: "The terminal that asked is still open, but the folder it asked from is gone.",
      composer: null,
      gone: false,
    });
  });

  it("says only that the folder is gone when the terminal couldn't be read", () => {
    expect(at({ target: "unknown", directory: "missing", resume: "worktree-missing" })).toEqual({
      row: "Folder missing",
      detail: "The folder it asked from is gone.",
      composer: null,
      gone: false,
    });
    expect(at({ target: "running", directory: "none", resume: "no-worktree" })).toBeNull();
  });

  it("says a Host's terminal is unknown while the Host is away, whatever it last said", () => {
    const notes = askerNotes(
      item(
        "q1",
        { kind: "queued" },
        {
          remoteHost: { hostId: "studio", name: "Studio", connected: false },
          asker: { target: "closed", directory: "present", resume: "no-session" },
        }
      )
    );
    expect(notes).toMatchObject({ row: "Terminal status unknown", gone: false, composer: null });
  });
});

describe("goneAsks (#18029)", () => {
  const OPEN = { kind: "waiting", reason: "open" } as const;
  const closed = { target: "closed", directory: "present", resume: "resumable" } as const;
  const inbox = { ask: null, seen: false, cleared: false };

  it("takes only Needs you's asks with no agent, never one cleared, elapsed, or still running", () => {
    const now = Date.parse("2026-11-02T12:00:00.000Z");
    const gone = item("q1", OPEN, { asker: closed, inbox });
    const list = [
      gone,
      item("q2", OPEN, { asker: { ...closed, target: "running" }, inbox }),
      item("q3", OPEN, { asker: closed, inbox: { ...inbox, cleared: true } }),
      item("q4", OPEN, { asker: closed, inbox, expiresAt: "2026-11-02T11:00:00.000Z" }),
      item("q5", OPEN, { asker: closed }),
      item("q6", { kind: "queued" }, { asker: { ...closed, target: "running" }, inbox }),
    ];
    const queued = item("q7", { kind: "queued" }, { asker: closed, inbox });
    expect(goneAsks([...list, queued], now)).toEqual([gone, queued]);
  });

  it("counts them in its label", () => {
    expect(clearGoneText(1)).toBe("Clear 1 question with no agent detected");
    expect(clearGoneText(3)).toBe("Clear 3 questions with no agent detected");
  });
});

describe("moving on once the person's action takes a question out of Needs you (#18035)", () => {
  const at = (questionId: string) => ({
    hostId: "h1",
    projectId: "p1",
    terminalId: "t1",
    questionId,
  });

  describe("nextWaiting", () => {
    it("goes to the first question in Needs you the person hasn't seen, never the one it came from", () => {
      const seen = { ask: null, seen: true, cleared: false };
      const unseen = { ask: null, seen: false, cleared: false };
      const first = item("q1", OPEN, { inbox: seen });
      const second = item("q2", OPEN, { inbox: unseen });
      const third = item("q3", OPEN, { inbox: unseen });
      const groups = inboxGroups([first, second, third]);
      expect(nextWaiting(groups, referenceKey(at("q1")))).toBe(second);
      expect(nextWaiting(groups, referenceKey(at("q2")))).toBe(third);
      // From the middle of the group, the first unseen leads, not the one after it; one this
      // computer never marked counts as unseen.
      const unmarkedFirst = item("q1", OPEN);
      const middle = inboxGroups([unmarkedFirst, second, third]);
      expect(nextWaiting(middle, referenceKey(at("q2")))).toBe(unmarkedFirst);
      // With every one seen, the first other than where it came from.
      const allSeen = inboxGroups([first, { ...second, inbox: seen }]);
      expect(nextWaiting(allSeen, referenceKey(at("q2")))).toBe(first);
      expect(nextWaiting(allSeen, referenceKey(at("q1")))?.reference.questionId).toBe("q2");
    });

    it("finds nothing once the question it came from was the only one waiting", () => {
      const only = item("q1", OPEN);
      const groups = inboxGroups([only, item("q2", { kind: "to-type" })]);
      expect(nextWaiting(groups, referenceKey(at("q1")))).toBeNull();
      expect(nextWaiting(inboxGroups([]), null)).toBeNull();
    });
  });

  describe("landedBy", () => {
    const standings: Record<string, DecisionQuestionStanding> = {
      typing: { kind: "to-type" },
      stopped: { kind: "needs-attention", deliveryStatus: "needs-attention" },
      uncertain: { kind: "needs-attention", deliveryStatus: "delivery-uncertain" },
      answered: { kind: "settled", outcome: "answered", handled: false },
      handled: { kind: "settled", outcome: "answered", handled: true },
      declined: { kind: "settled", outcome: "declined" },
      withdrawn: { kind: "settled", outcome: "withdrawn" },
      expired: { kind: "settled", outcome: "expired" },
      unsent: { kind: "send-failed" },
      waiting: OPEN,
      reply: { kind: "waiting", reason: "reply" },
      queued: { kind: "queued" },
    };
    const where = (name: string) => {
      const listed = item("q1", standings[name]!);
      return [listed, inboxGroupOf(listed)] as const;
    };

    it("takes an answer into delivery or past it, and nothing else", () => {
      for (const name of ["typing", "stopped", "uncertain", "answered", "handled"]) {
        expect(landedBy("answer", ...where(name))).toBe(true);
      }
      for (const name of ["declined", "withdrawn", "expired", "unsent", "waiting", "reply"]) {
        expect(landedBy("answer", ...where(name))).toBe(false);
      }
    });

    it("takes a dismissal or withdrawal to History as such, never one the phone answered or the deadline closed", () => {
      expect(landedBy("dismiss", ...where("declined"))).toBe(true);
      expect(landedBy("withdraw", ...where("withdrawn"))).toBe(true);
      const elsewhere = [
        "typing",
        "stopped",
        "uncertain",
        "answered",
        "expired",
        "unsent",
        "waiting",
      ];
      for (const name of [...elsewhere, "withdrawn"]) {
        expect(landedBy("dismiss", ...where(name))).toBe(false);
      }
      for (const name of [...elsewhere, "declined"]) {
        expect(landedBy("withdraw", ...where(name))).toBe(false);
      }
    });

    it("takes a clear to Cleared, never to Awaiting update by the clock", () => {
      const cleared = item("q1", OPEN, { inbox: { ask: null, seen: true, cleared: true } });
      expect(landedBy("clear", cleared, inboxGroupOf(cleared))).toBe(true);
      for (const name of ["typing", "declined", "withdrawn", "waiting", "queued"]) {
        expect(landedBy("clear", ...where(name))).toBe(false);
      }
      const nowMs = Date.parse("2026-11-02T12:00:00.000Z");
      const elapsed = item("q1", OPEN, { expiresAt: "2026-11-02T11:00:00.000Z" });
      expect(inboxGroupOf(elapsed, nowMs)).toBe("awaiting");
      expect(landedBy("clear", elapsed, inboxGroupOf(elapsed, nowMs))).toBe(false);
      expect(landedBy("answer", elapsed, inboxGroupOf(elapsed, nowMs))).toBe(false);
    });
  });

  describe("answerFate", () => {
    const record = (over: Partial<Parameters<typeof answerFate>[0]> = {}) => ({
      submission: null,
      preparing: false,
      hold: null,
      ...over,
    });
    const submission = (answerId: string, phase: AnswerPhase) => ({ answerId, phase });
    const sent: AnswerPhase = { kind: "settled", outcome: { status: "sent" } };

    it("is taken only once the relay took the submission this Send made", () => {
      expect(answerFate(record(), null)).toBe("open");
      expect(answerFate(record({ submission: submission("new", sent) }), null)).toBe("taken");
      expect(answerFate(record({ submission: submission("new", sent) }), "old")).toBe("taken");
      // The record's earlier answer, taken before this Send, says nothing of it.
      expect(answerFate(record({ submission: submission("old", sent) }), "old")).toBe("open");
    });

    it("waits while it is being read, sent, followed or queued", () => {
      expect(answerFate(record({ preparing: true }), null)).toBe("open");
      for (const phase of [
        { kind: "sending" },
        { kind: "checking" },
        { kind: "lost" },
        { kind: "settled", outcome: { status: "queued" } },
      ] satisfies AnswerPhase[]) {
        expect(answerFate(record({ submission: submission("new", phase) }), null)).toBe("open");
      }
    });

    it("fails once refused, turned away, or held before anything was signed", () => {
      for (const phase of [
        { kind: "refused", reason: "not-found" },
        { kind: "settled", outcome: { status: "already-answered" } },
        { kind: "settled", outcome: { status: "closed", reason: "expired" } },
        { kind: "settled", outcome: { status: "closed", reason: "cancelled" } },
        { kind: "settled", outcome: { status: "changed" } },
        { kind: "settled", outcome: { status: "unsupported", by: "relay" } },
        { kind: "settled", outcome: { status: "rejected", code: "bad_signature" } },
      ] satisfies AnswerPhase[]) {
        expect(answerFate(record({ submission: submission("new", phase) }), null)).toBe("failed");
      }
      expect(answerFate(record({ hold: "closed" }), null)).toBe("failed");
      expect(
        answerFate(record({ hold: "changed", submission: submission("old", sent) }), "old")
      ).toBe("failed");
    });
  });

  describe("dismissFate", () => {
    const decline = (phase: DeclinePhase) => ({ phase });

    it("is taken only once declined, waits while queued, and fails once refused or settled otherwise", () => {
      expect(dismissFate(decline({ kind: "settled", outcome: { status: "declined" } }))).toBe(
        "taken"
      );
      // A phone's dismissal lists it declined just the same while this one waits.
      for (const phase of [
        { kind: "settled", outcome: { status: "queued" } },
        { kind: "sending" },
        { kind: "checking" },
        { kind: "lost" },
      ] satisfies DeclinePhase[]) {
        expect(dismissFate(decline(phase))).toBe("open");
      }
      expect(dismissFate(null)).toBe("open");
      for (const phase of [
        { kind: "refused", reason: "not-owner" },
        { kind: "settled", outcome: { status: "already-answered" } },
        { kind: "settled", outcome: { status: "changed" } },
        { kind: "settled", outcome: { status: "closed", reason: "cancelled" } },
        { kind: "settled", outcome: { status: "unsupported", by: "asking-desktop" } },
        { kind: "settled", outcome: { status: "rejected", code: "bad_signature" } },
      ] satisfies DeclinePhase[]) {
        expect(dismissFate(decline(phase))).toBe("failed");
      }
    });
  });

  describe("askKey", () => {
    it("changes when the agent asks for a reply or something new, and not otherwise", () => {
      const asking = item("q1", OPEN, { inbox: { ask: null, seen: true, cleared: false } });
      const same = askKey(asking);
      const delivered = item("q1", { kind: "to-type" }, { inbox: asking.inbox });
      expect(askKey(delivered)).toBe(same);
      expect(askKey({ ...asking, replyRequest: "msg-2" })).not.toBe(same);
      expect(askKey({ ...asking, inbox: { ask: "msg-3", seen: false, cleared: false } })).not.toBe(
        same
      );
    });
  });

  describe("movedText", () => {
    it("names the question, the group it's in now, and the one shown in its place", () => {
      expect(movedText("answer", "q-2", "Being delivered", "q-4", null)).toBe(
        "Answer sent for question q-2. It's in Being delivered now. Showing q-4."
      );
      expect(movedText("dismiss", "q-2", "History", "q-4", "ignored")).toBe(
        "Question q-2 declined. It's in History now. Showing q-4."
      );
    });

    it("says what the line above the list says once nothing else waits, its own sentences kept", () => {
      expect(movedText("clear", "q-2", "Cleared", null, "No questions waiting on you")).toBe(
        "Question q-2 cleared on this computer. It's in Cleared now. No questions waiting on you."
      );
      const away =
        "None of the questions here wait on you. Studio Mac is away, so its questions are as last reported.";
      expect(movedText("withdraw", "q-2", "History", null, away)).toBe(
        `Question q-2 withdrawn. It's in History now. ${away}`
      );
      expect(movedText("withdraw", "q-2", "History", null, null)).toBe(
        "Question q-2 withdrawn. It's in History now."
      );
    });
  });
});

describe("what holds a delivery (#18032)", () => {
  const QUEUES = "claude";
  const PROMPT_ONLY = "gemini";
  const RECORDED = "2026-11-02T11:30:00.000Z";

  function pending(over: Partial<DecisionPendingDelivery> = {}): DecisionQuestionStanding {
    return {
      kind: "to-type",
      delivery: {
        answer: true,
        followUps: 0,
        first: "answer",
        recordedAt: RECORDED,
        hostAway: false,
        ...over,
      },
    };
  }

  type Pane = NonNullable<Parameters<typeof deliveryFacts>[1]>;
  function pane(over: Partial<Pane> = {}): Pane {
    return {
      detectedAgentId: QUEUES,
      agentState: "waiting",
      waitingReason: "prompt",
      draft: false,
      ...over,
    };
  }

  const facts = (standing: DecisionQuestionStanding, seen: Pane | null) =>
    deliveryFacts(item("q1", standing), seen);
  const waitOf = (seen: Pane | null, over: Partial<DecisionPendingDelivery> = {}) =>
    facts(pending(over), seen)?.wait;

  it("picks agents that do and don't take a line mid-turn", () => {
    expect(getEffectiveAgentConfig(QUEUES)?.capabilities?.queuesInputWhileWorking).toBe(true);
    expect(getEffectiveAgentConfig(PROMPT_ONLY)?.capabilities?.queuesInputWhileWorking).not.toBe(
      true
    );
  });

  it("says what the pane's chip says of a lone answer while a CLI that takes no line mid-turn works", () => {
    const [chip] = decisionItems(
      {
        terminalId: "t1",
        revision: 1,
        openQuestions: [],
        waitingAnswers: [
          { questionId: "q1", alias: 1, kind: "answer", deliveryStatus: "desktop-received" },
        ],
        needsAttention: [],
      },
      "prompt"
    );
    const working = { agentState: "working", waitingReason: undefined } as const;
    expect(facts(pending(), pane({ ...working, detectedAgentId: PROMPT_ONLY }))?.text).toBe(
      chip!.status
    );
    // One that takes a line mid-turn is held by what's in its composer, which isn't seen here.
    expect(facts(pending(), pane({ ...working, detectedAgentId: QUEUES }))?.wait).toBeNull();
  });

  it("names a choice dialog or an error on screen whatever else holds, as the gate blocks on them first", () => {
    for (const draft of [false, true]) {
      expect(waitOf(pane({ waitingReason: "approval", draft }))).toBe("choice-dialog");
      expect(waitOf(pane({ waitingReason: "error", draft }))).toBe("error");
    }
  });

  it("waits out a turn of a CLI that takes no line mid-turn before any draft", () => {
    const turn: Partial<Pane> = {
      detectedAgentId: PROMPT_ONLY,
      agentState: "working",
      waitingReason: undefined,
    };
    expect(waitOf(pane({ ...turn, draft: true }))).toBe("prompt");
    // At its prompt, the draft is what holds it.
    expect(waitOf(pane({ detectedAgentId: PROMPT_ONLY, draft: true }))).toBe("draft");
  });

  it("names a draft in this view wherever the gate reads the composer", () => {
    const turn: Partial<Pane> = { agentState: "working", waitingReason: undefined };
    expect(waitOf(pane({ ...turn, draft: true }))).toBe("draft");
    expect(waitOf(pane({ draft: true }))).toBe("draft");
    expect(waitOf(pane({ waitingReason: "question", draft: true }))).toBe("draft");
  });

  it("guesses nothing where what was seen doesn't say what holds it", () => {
    // At its prompt with no draft here: text in its own line, or a draft in another view.
    expect(waitOf(pane())).toBeNull();
    expect(waitOf(pane({ waitingReason: "question" }))).toBeNull();
    expect(waitOf(pane({ waitingReason: undefined }))).toBeNull();
    // Waiting for no reason it names, or past its run, the gate never reaches the composer.
    expect(waitOf(pane({ waitingReason: undefined, draft: true }))).toBeNull();
    for (const agentState of ["directing", "completed", "exited"] as const) {
      expect(waitOf(pane({ agentState, waitingReason: undefined, draft: true }))).toBeNull();
    }
    expect(waitOf(pane({ agentState: "working", waitingReason: undefined }))).toBeNull();
    expect(waitOf(pane({ agentState: "idle", waitingReason: undefined, draft: true }))).toBeNull();
    expect(waitOf(pane({ detectedAgentId: undefined, waitingReason: "approval" }))).toBeNull();
    // Not seen running here: nothing about it, unless the store says it waits for its host.
    expect(waitOf(null)).toBeNull();
    expect(waitOf(null, { hostAway: true })).toBe("host");
    // Seen running, its host is back, whatever the store last recorded.
    expect(waitOf(pane({ waitingReason: "approval" }), { hostAway: true })).toBe("choice-dialog");
    expect(facts(pending(), pane())?.text).toBe("Answer received, waiting to be typed in");
  });

  it("points at the terminal only for what a person there can deal with", () => {
    const clearable = (seen: Pane | null, over: Partial<DecisionPendingDelivery> = {}) =>
      facts(pending(over), seen)?.clearable;
    expect(clearable(pane({ waitingReason: "approval" }))).toBe(true);
    expect(clearable(pane({ waitingReason: "error" }))).toBe(true);
    expect(clearable(pane({ draft: true }))).toBe(true);
    expect(clearable(pane({ agentState: "working", waitingReason: undefined }))).toBe(false);
    expect(
      clearable(
        pane({ detectedAgentId: PROMPT_ONLY, agentState: "working", waitingReason: undefined })
      )
    ).toBe(false);
    expect(clearable(null, { hostAway: true })).toBe(false);
    expect(clearable(pane())).toBe(false);
    expect(clearable(null)).toBe(false);
  });

  it("says what waits, the answer and its follow-ups agreeing in number", () => {
    const dialog = pane({ waitingReason: "approval" });
    const said = (over: Partial<DecisionPendingDelivery>) => facts(pending(over), dialog)!.text;
    const clause = "once the choice dialog in the terminal is closed";
    expect(said({})).toBe(`Answer received, typing it in ${clause}`);
    expect(said({ answer: false, followUps: 1, first: "follow-up" })).toBe(
      `Follow-up received, typing it in ${clause}`
    );
    expect(said({ answer: false, followUps: 3, first: "follow-up" })).toBe(
      `3 follow-ups received, typing them in ${clause}`
    );
    expect(said({ followUps: 1 })).toBe(`Answer and follow-up received, typing them in ${clause}`);
    expect(said({ followUps: 2 })).toBe(
      `Answer and 2 follow-ups received, typing them in ${clause}`
    );
  });

  it("says each hold apart, of the terminal from outside it, in one sentence without a period", () => {
    const texts = [
      facts(pending({ hostAway: true }), null),
      facts(pending(), pane({ waitingReason: "approval" })),
      facts(pending(), pane({ waitingReason: "error" })),
      facts(pending(), pane({ draft: true })),
      facts(
        pending(),
        pane({ detectedAgentId: PROMPT_ONLY, agentState: "working", waitingReason: undefined })
      ),
      facts(pending(), pane()),
    ].map((said) => said!.text);
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) {
      expect(text.endsWith(".")).toBe(false);
      expect(text).not.toMatch(/\bhere\b/);
    }
  });

  it("keeps when the one waiting longest was recorded, labelled by what it is", () => {
    for (const first of ["answer", "follow-up"] as const) {
      expect(facts(pending({ followUps: 1, first }), null)).toMatchObject({
        first,
        recordedAt: RECORDED,
      });
    }
    expect(recordedLabel("answer")).toMatch(/^Answer /);
    expect(recordedLabel("follow-up")).toMatch(/^Follow-up /);
  });

  it("says no more than that it waits for a question whose machine didn't say what waits", () => {
    expect(facts({ kind: "to-type" }, pane({ waitingReason: "approval" }))).toBeNull();
    expect(facts(OPEN, null)).toBeNull();
    // A stale notice can leave one waiting with no answer or follow-up: it names neither.
    expect(standingText({ kind: "to-type" })).not.toMatch(/answer|follow-up/i);
  });
});
