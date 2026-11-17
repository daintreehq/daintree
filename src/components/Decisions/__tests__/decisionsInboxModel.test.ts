import { describe, expect, it } from "vitest";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { PaneDecisionState } from "@shared/types/decisions";
import { decisionItems } from "@/components/Terminal/decisionsChipModel";
import type {
  DecisionQuestionListItem,
  DecisionQuestionStanding,
} from "@shared/types/decisionsQuestion";
import {
  agentName,
  connectionNotice,
  groupOf,
  inboxGroups,
  isAttention,
  originText,
  referenceKey,
  resolveSelection,
  sameReference,
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
      item("q3", { kind: "to-type" }),
      item("q4", { kind: "queued" }),
    ]);
    expect(groups.map((group) => group.id)).toEqual(["needs-you", "delivering", "history"]);
    expect(groups[0]!.items.map((entry) => entry.reference.questionId)).toEqual(["q2", "q4"]);
  });

  it("shows the most recently closed history first, by settled time else asked time", () => {
    const groups = inboxGroups([
      item(
        "q1",
        { kind: "settled", outcome: "answered", handled: false },
        {
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
    const texts = standings.map(standingText);
    expect(new Set(texts).size).toBe(standings.length);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
      expect(text.endsWith(".")).toBe(false);
      expect(text[0]).toBe(text[0]!.toUpperCase());
    }
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

  it("joins where a question was asked, leaving out what isn't known", () => {
    expect(originText({ agent: "Claude", project: "Daintree", worktree: "main" })).toBe(
      "Claude · Daintree · main"
    );
    expect(originText({ agent: "Codex", project: null, worktree: null })).toBe("Codex");
  });

  it("tells references apart by every part", () => {
    const a = item("q1", OPEN).reference;
    expect(sameReference(a, { ...a })).toBe(true);
    expect(sameReference(a, { ...a, projectId: "p2" })).toBe(false);
    expect(referenceKey(a)).not.toBe(referenceKey({ ...a, terminalId: "t2" }));
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

  it("tells no relay set up, a revoked computer and a dropped connection apart", () => {
    const none = connectionNotice({ state: "not-connected" });
    const revoked = connectionNotice({ state: "revoked", relayOrigin: "https://r.example" });
    const dropped = connectionNotice({ state: "reconnecting", relayOrigin: "https://r.example" });
    const connecting = connectionNotice({ state: "connecting", relayOrigin: "https://r.example" });
    expect(none).not.toBeNull();
    expect(revoked?.severity).toBe("warning");
    expect(dropped).toEqual(connecting);
    expect(new Set([none?.text, revoked?.text, dropped?.text]).size).toBe(3);
  });
});
