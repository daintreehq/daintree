import { describe, expect, it } from "vitest";
import type {
  DecisionsAnswerDestination,
  DecisionsAttentionItem,
  DecisionsFollowUpPreview,
} from "@shared/types/decisionsAttention";
import {
  attentionFingerprint,
  canCopy,
  canOpenQuestion,
  copyLabel,
  destinationGroups,
  destinationRowDetail,
  fromLines,
  groupForPane,
  handledConfirmBody,
  handledConfirmTitle,
  handledNeedsConfirm,
  hasFullerQuestion,
  moveConfirmBody,
  noticeDeliveryText,
  noticeOutcomeText,
  noticePlanText,
  originParts,
  outcomeText,
  reasonText,
  remainingText,
  sameAttention,
  statusText,
  subjectOf,
  toLines,
} from "../decisionsAttentionModel";

function followUp(over: Partial<DecisionsFollowUpPreview> = {}): DecisionsFollowUpPreview {
  return {
    messageId: "message-1",
    onComputer: false,
    status: "needs-attention",
    reason: "pane_gone",
    text: "Keep the old icons.",
    unreadable: false,
    sentAt: "2026-11-01T10:00:00.000Z",
    ...over,
  };
}

const ANSWER: DecisionsAttentionItem["answer"] = {
  source: "human",
  choices: ["Approve"],
  text: null,
  correction: false,
  answeredAt: "2026-11-01T09:00:00.000Z",
};

type Fields = Pick<
  DecisionsAttentionItem,
  "status" | "answer" | "answerUnavailable" | "notice" | "followUps"
>;

function item(over: Partial<Fields> = {}): Fields {
  return {
    status: "needs-attention",
    answer: ANSWER,
    answerUnavailable: null,
    notice: null,
    followUps: [],
    ...over,
  };
}

const NOTICE: NonNullable<DecisionsAttentionItem["notice"]> = {
  kind: "expired",
  revision: 0,
  deadline: "2026-11-01T09:45:00.000Z",
  delivery: "needs-attention",
  disposition: "fallback-due",
};

describe("follow-ups in the needs-attention list (#16231)", () => {
  it("names what of the question needs a person", () => {
    expect(subjectOf(item())).toBe("answer");
    expect(subjectOf(item({ answer: null, answerUnavailable: "unreadable" }))).toBe("answer");
    expect(subjectOf(item({ answer: null, followUps: [followUp()] }))).toBe("follow-up");
    expect(subjectOf(item({ answer: null, followUps: [followUp(), followUp()] }))).toBe(
      "follow-ups"
    );
    expect(subjectOf(item({ followUps: [followUp()] }))).toBe("answer and follow-up");
    expect(subjectOf(item({ followUps: [followUp(), followUp()] }))).toBe("answer and follow-ups");
  });

  it("says what wasn't typed in, or may have been, without restating the dialog's title (#18055)", () => {
    expect(statusText(item())).toBe("Answer not typed in");
    expect(statusText(item({ answer: null, followUps: [followUp(), followUp()] }))).toBe(
      "Follow-ups not typed in"
    );
    expect(statusText(item({ followUps: [followUp()] }))).toBe("Answer and follow-up not typed in");
    expect(
      statusText(
        item({
          status: "delivery-uncertain",
          answer: null,
          followUps: [followUp({ status: "delivery-uncertain" })],
        })
      )
    ).toBe("This follow-up may or may not have been delivered");
  });

  it("copies only when everything that needs a person can be opened", () => {
    expect(canCopy(item())).toBe(true);
    expect(canCopy(item({ answer: null, followUps: [followUp({ text: null })] }))).toBe(true);
    expect(canCopy(item({ answer: null, answerUnavailable: "unreadable" }))).toBe(false);
    expect(
      canCopy(item({ answer: null, followUps: [followUp({ text: null, unreadable: true })] }))
    ).toBe(false);
    expect(canCopy(item({ followUps: [followUp({ unreadable: true })] }))).toBe(false);
    expect(copyLabel(item({ followUps: [followUp()] }))).toBe("Copy answer and follow-up");
  });

  it("explains a follow-up's own code in its words, and counts questions", () => {
    expect(reasonText("inject_rejected", "follow-up")).toBe("The terminal refused the follow-up.");
    expect(reasonText("resume_exited", "follow-ups")).toBe(
      "The resumed agent exited before the follow-ups were typed in."
    );
    expect(reasonText("inject_rejected", "answer and follow-up")).toBe(
      "The terminal refused the answer."
    );
    expect(reasonText("message_unreadable", "follow-up")).toBe(
      "The follow-up couldn't be decrypted on this computer."
    );
    expect(remainingText(1)).toBe("1 question needs attention");
  });

  it("tells what became of a follow-up, in agreement with how many there were", () => {
    const delivered = { result: "delivered", terminalId: "pane-1", title: "Claude" } as const;
    expect(outcomeText(4, delivered, "follow-up")).toBe("Follow-up to q-4 typed into “Claude”");
    expect(
      outcomeText(
        4,
        { result: "waiting", terminalId: "p", title: null, waitsFor: "composer" },
        "follow-ups"
      )
    ).toBe("Follow-ups to q-4 go to its terminal, typed in once its composer is empty");
    expect(
      outcomeText(4, { result: "waiting", terminalId: "p", title: null, waitsFor: "prompt" })
    ).toBe("Answer to q-4 goes to its terminal, typed in at the agent's next prompt");
    expect(
      outcomeText(
        4,
        { result: "needs-attention", status: "needs-attention", reason: "pane_gone" },
        "answer and follow-ups"
      )
    ).toBe("Answer and follow-ups to q-4 weren't typed in and still need attention");
    expect(outcomeText(4, { result: "refused", reason: "uncertain" }, "follow-up")).toBe(
      "Follow-up to q-4 may already have been typed in, so it isn't typed again"
    );
    // Only the agent that asked for advice takes what is typed for it (#17941).
    expect(outcomeText(4, { result: "refused", reason: "asker-only" }, "follow-ups")).toBe(
      "q-4 asked for advice, so only the agent that asked it can take its follow-ups"
    );
    expect(outcomeText(7, { result: "refused", reason: "asker-only" })).toBe(
      "q-7 asked for advice, so only the agent that asked it can take its answer"
    );
    // An answer alone reads as it always has.
    expect(outcomeText(4, delivered)).toBe("Answer to q-4 typed into “Claude”");
  });
});

describe("Mark handled's confirmation (#16638)", () => {
  it("asks first only while the answer can still be resumed or sent on", () => {
    expect(handledNeedsConfirm({ canResume: true, canReassign: true })).toBe(true);
    expect(handledNeedsConfirm({ canResume: false, canReassign: true })).toBe(true);
    expect(handledNeedsConfirm({ canResume: true, canReassign: false })).toBe(true);
    // A delivery that may already have gone in offers neither: Mark handled is the way out.
    expect(handledNeedsConfirm({ canResume: false, canReassign: false })).toBe(false);
  });

  it("names the question and agrees with what it takes off the list", () => {
    expect(handledConfirmTitle(7)).toBe("Mark q-7 handled?");

    const one = handledConfirmBody("answer");
    expect(one).toContain("Its answer leaves this list");
    expect(one).toContain("won't type it in");
    expect(one).toContain("so it can't be copied or sent to an agent");

    const several = handledConfirmBody("answer and follow-ups");
    expect(several).toContain("Its answer and follow-ups leave this list");
    expect(several).toContain("won't type them in");
    expect(several).toContain("so they can't be copied or sent to an agent");
  });
});

describe("a timeout notice in the needs-attention list (#17944)", () => {
  const notice = (over: Partial<Fields> = {}) => item({ answer: null, notice: NOTICE, ...over });

  it("names the notice in the answer's place, and the follow-ups beside it", () => {
    expect(subjectOf(notice())).toBe("timeout notice");
    expect(subjectOf(notice({ followUps: [followUp()] }))).toBe("timeout notice and follow-up");
    expect(subjectOf(notice({ followUps: [followUp(), followUp()] }))).toBe(
      "timeout notice and follow-ups"
    );
    // A real answer waiting beside it is still what leads.
    expect(subjectOf(item({ notice: NOTICE }))).toBe("answer");
    expect(subjectOf(notice({ answerUnavailable: "unreadable" }))).toBe("answer");
  });

  it("says whether it wasn't typed in or may already have been, apart from how the question ended", () => {
    expect(statusText(notice())).toBe("Timeout notice not typed in");
    expect(statusText(notice({ followUps: [followUp(), followUp()] }))).toBe(
      "Timeout notice and follow-ups not typed in"
    );
    expect(statusText(notice({ status: "delivery-uncertain" }))).toBe(
      "This timeout notice may or may not have been delivered"
    );
    expect(noticeOutcomeText(NOTICE)).toBe("Its deadline passed without an answer.");
    expect(noticeOutcomeText({ kind: "never-published" })).toContain("before it reached the relay");
  });

  it("says what the notice says of the plan, apart from how far it got, never that anything was carried out", () => {
    expect(noticePlanText(NOTICE)).toBe(
      "The notice says the agent may go ahead with its stated plan. Nothing was decided or approved."
    );
    expect(noticePlanText({ disposition: "fallback-withheld" })).toBe(
      "The notice says the agent isn't cleared to go ahead with its plan."
    );
    expect(noticePlanText({ disposition: null })).toBeNull();
    for (const disposition of ["fallback-due", "fallback-withheld"] as const) {
      expect(noticePlanText({ disposition })).not.toMatch(/went ahead|carried out|told|did /);
    }
    // How far it got is said once, in its own words.
    expect(noticeDeliveryText(NOTICE)).toBe("not typed in");
    expect(noticeDeliveryText({ delivery: "delivery-uncertain" })).toBe(
      "may or may not have been typed in"
    );
  });

  it("keeps a confirmation only while main's token for the question is the one it asked with", () => {
    expect(
      sameAttention({ questionId: "q", token: "t-1" }, { questionId: "q", token: "t-1" })
    ).toBe(true);
    // A correction, a new follow-up, a replaced round or a move in another window: a new token.
    expect(
      sameAttention({ questionId: "q", token: "t-1" }, { questionId: "q", token: "t-2" })
    ).toBe(false);
    expect(
      sameAttention({ questionId: "q", token: "t-1" }, { questionId: "r", token: "t-1" })
    ).toBe(false);
  });

  it("reads the question list again only for a change to what needs a person", () => {
    const question = (
      questionId: string,
      kind: string,
      over: {
        deliveryStatus?: string;
        terminalId?: string;
        closureNotice?: { delivery: string; disposition: string | null };
      } = {}
    ) => ({
      reference: {
        hostId: "h",
        projectId: "p",
        terminalId: over.terminalId ?? "pane-1",
        questionId,
      },
      standing: { kind, ...(over.deliveryStatus ? { deliveryStatus: over.deliveryStatus } : {}) },
      stall:
        kind === "needs-attention"
          ? { answerRevision: 0, followUpIds: [], reason: "pane_gone" }
          : null,
      ...(over.closureNotice ? { closureNotice: over.closureNotice } : {}),
    });
    const notice = { delivery: "needs-attention", disposition: "fallback-due" };
    const held = attentionFingerprint([
      question("a", "needs-attention", {
        deliveryStatus: "needs-attention",
        closureNotice: notice,
      }),
    ]);
    // A question that doesn't need a person changes nothing here.
    expect(
      attentionFingerprint([
        question("a", "needs-attention", {
          deliveryStatus: "needs-attention",
          closureNotice: notice,
        }),
        question("b", "waiting"),
      ])
    ).toBe(held);
    expect(attentionFingerprint([question("a", "settled")])).not.toBe(held);
    // Moved to another pane by another window, stopped again for the same reason.
    expect(
      attentionFingerprint([
        question("a", "needs-attention", {
          deliveryStatus: "needs-attention",
          closureNotice: notice,
          terminalId: "pane-2",
        }),
      ])
    ).not.toBe(held);
    // Only the notice's own delivery changed.
    expect(
      attentionFingerprint([
        question("a", "needs-attention", {
          deliveryStatus: "needs-attention",
          closureNotice: { ...notice, delivery: "uncertain" },
        }),
      ])
    ).not.toBe(held);
  });

  it("copies nothing of the notice, only the follow-ups beside it", () => {
    expect(canCopy(notice())).toBe(false);
    expect(canCopy(notice({ followUps: [followUp()] }))).toBe(true);
    expect(copyLabel(notice({ followUps: [followUp()] }))).toBe("Copy follow-up");
    expect(copyLabel(notice({ followUps: [followUp(), followUp()] }))).toBe("Copy follow-ups");
  });

  it("explains its code in its words, and what became of it after an action", () => {
    expect(reasonText("inject_rejected", "timeout notice")).toBe(
      "The terminal refused the timeout notice."
    );
    expect(reasonText("resume_exited", "timeout notice and follow-ups")).toBe(
      "The resumed agent exited before the timeout notice was typed in."
    );
    expect(
      outcomeText(7, { result: "delivered", terminalId: "p", title: "Build" }, "timeout notice")
    ).toBe("Timeout notice for q-7 typed into “Build”");
    expect(outcomeText(7, { result: "resolved" }, "timeout notice")).toBe(
      "Timeout notice for q-7 no longer needs attention"
    );
    expect(outcomeText(7, { result: "refused", reason: "uncertain" }, "timeout notice")).toBe(
      "Timeout notice for q-7 may already have been typed in, so it isn't typed again"
    );
    expect(outcomeText(7, { result: "refused", reason: "changed" }, "timeout notice")).toBe(
      "q-7 changed after this list was read, so nothing was done"
    );
    // The notice sent with them was replaced: only the follow-ups still wait.
    expect(
      outcomeText(
        7,
        {
          result: "waiting",
          terminalId: "p",
          title: null,
          waitsFor: "prompt",
          followUpsOnly: true,
        },
        "timeout notice and follow-ups"
      )
    ).toBe("Follow-ups to q-7 go to its terminal, typed in at the agent's next prompt");
    expect(
      outcomeText(
        7,
        {
          result: "needs-attention",
          status: "needs-attention",
          reason: "pane_gone",
          followUpsOnly: true,
        },
        "timeout notice and follow-up"
      )
    ).toBe("Follow-up to q-7 wasn't typed in and still needs attention");
  });

  it("offers in Mark handled's confirmation only what a notice has", () => {
    const one = handledConfirmBody("timeout notice");
    expect(one).toContain("Its timeout notice leaves this list");
    expect(one).toContain("Try resume goes with it");
    expect(one).not.toContain("Choose destination");
    expect(one).not.toContain("Copy");
    expect(handledConfirmBody("timeout notice and follow-ups")).toContain(
      "Copy and Try resume go with them"
    );
  });

  it("names the computer a question was asked on when it isn't this one", () => {
    const base = {
      questionId: "q",
      alias: 7,
      status: "needs-attention" as const,
      reason: "resume_other_host",
      question: null,
      fullQuestion: null,
      plan: null,
      reference: null,
      askedAt: "2026-11-01T09:00:00.000Z",
      answer: null,
      answerUnavailable: null,
      notice: NOTICE,
      followUps: [],
      canResume: false,
      canReassign: false,
      token: "token",
    };
    const origin = {
      projectId: "p",
      projectName: "Helios",
      worktreeId: "w",
      worktreeName: null,
      agentId: "claude",
      agentName: "Claude",
      paneId: "pane-1",
      paneTitle: null,
    };
    const atlas = { ...base, origin: { ...origin, otherHost: { hostId: "h", name: "Atlas" } } };
    expect(originParts(atlas, null).pane).toBe("Claude on Atlas");
    expect(fromLines(atlas, null).primary).toBe("Atlas");
    const unknown = { ...base, origin: { ...origin, otherHost: { hostId: "h", name: null } } };
    expect(originParts(unknown, null).pane).toBe("Claude on another computer");
    const here = { ...base, origin: { ...origin, otherHost: null } };
    expect(originParts(here, null).pane).toBe("Claude, terminal closed");
  });
});

describe("Choose destination's menu and confirmation (#18056)", () => {
  function destination(
    terminalId: string,
    over: Partial<DecisionsAnswerDestination> = {}
  ): DecisionsAnswerDestination {
    return {
      terminalId,
      title: terminalId,
      agentId: "claude",
      agentName: "Claude",
      projectId: "helios",
      projectName: "Helios",
      worktreeId: "w",
      worktreeName: "main",
      askedHere: false,
      waitsFor: "composer",
      ...over,
    };
  }

  it("promises the wait the chosen agent's delivery makes, for whatever moves, never typed twice", () => {
    for (const subject of ["answer", "follow-ups", "answer and follow-ups"] as const) {
      const composer = moveConfirmBody(subject, "composer");
      const prompt = moveConfirmBody(subject, "prompt");
      const twice =
        subject === "answer" ? "It's never typed in twice" : "They're never typed in twice";
      for (const body of [composer, prompt]) {
        expect(body).toContain(`types the ${subject} in`);
        expect(body).toContain(twice);
        expect(body).toContain("audit trail records the move");
      }
      expect(composer).toContain("its composer is empty, even while it's working");
      expect(composer).not.toContain("prompt");
      expect(prompt).toContain("at its prompt");
      expect(prompt).toContain("never while it's working");
      expect(prompt).not.toContain("even while");
    }
  });

  it("puts the asking project's agents first, then each other project's in main's order, by id", () => {
    const groups = destinationGroups(
      [
        destination("zeta-1", { projectId: "zeta", projectName: "Zeta" }),
        destination("asker", { askedHere: true }),
        destination("twin-1", { projectId: "twin", projectName: "Zeta" }),
        destination("zeta-2", { projectId: "zeta", projectName: "Zeta" }),
        destination("sibling"),
        destination("nameless", { projectId: "anon", projectName: null }),
      ],
      "helios"
    );
    expect(
      groups.map((group) => [
        group.projectId,
        group.label,
        group.destinations.map((d) => d.terminalId),
      ])
    ).toEqual([
      ["helios", "Asking project · Helios", ["asker", "sibling"]],
      ["zeta", "Other project · Zeta", ["zeta-1", "zeta-2"]],
      // Another project of the same name keeps a section of its own.
      ["twin", "Other project · Zeta", ["twin-1"]],
      ["anon", "Other project", ["nameless"]],
    ]);
  });

  it("knows the asking project by id, not by the pane that asked, which may be gone", () => {
    const groups = destinationGroups(
      [
        destination("zeta-1", { projectId: "zeta", projectName: "Zeta" }),
        destination("sibling", { projectName: null }),
      ],
      "helios"
    );
    expect(groups.map((group) => [group.label, group.destinations[0]!.terminalId])).toEqual([
      ["Asking project", "sibling"],
      ["Other project · Zeta", "zeta-1"],
    ]);
  });

  it("names no asking project when none of its agents are running, and no section for an empty list", () => {
    expect(
      destinationGroups(
        [destination("atlas-1", { projectId: "atlas", projectName: null })],
        "helios"
      )
    ).toEqual([
      {
        projectId: "atlas",
        label: "Other project",
        destinations: [expect.objectContaining({ terminalId: "atlas-1" })],
      },
    ]);
    expect(destinationGroups([], "helios")).toEqual([]);
  });

  it("leaves the project to the menu's section label, and keeps it in the confirmation's To", () => {
    const chosen = destination("atlas-1", { projectId: "atlas", projectName: "Atlas" });
    expect(destinationRowDetail(chosen, "main")).toBe("Claude · main");
    expect(destinationRowDetail(chosen, null)).toBe("Claude");
    expect(toLines(chosen, "main").detail).toBe("Claude · Atlas · main");
  });
});

describe("an opening for a pane, and the whole question (#18055)", () => {
  const origin = (
    paneId: string,
    otherHost: { hostId: string; name: string | null } | null = null
  ) => ({
    origin: { paneId, otherHost },
  });

  it("puts this computer's items for the pane first and the rest after, each in the order given", () => {
    const a = { id: "a", ...origin("pane-2") };
    const b = { id: "b", ...origin("pane-1") };
    const c = { id: "c", ...origin("pane-1", { hostId: "host-2", name: "Studio" }) };
    const d = { id: "d", ...origin("pane-1") };
    expect(groupForPane([a, b, c, d], "pane-1")).toEqual({ forPane: [b, d], elsewhere: [a, c] });
    expect(groupForPane([a, b], null)).toBeNull();
  });

  it("opens a question in the question view only where this computer can reach it", () => {
    const reference = { hostId: "h", projectId: "p", terminalId: "t", questionId: "qid-00001" };
    const at = (otherHost: { hostId: string; name: string | null } | null) => ({
      reference,
      origin: { otherHost },
    });
    expect(canOpenQuestion(at(null))).toBe(true);
    expect(canOpenQuestion(at({ hostId: "h2", name: "Studio" }))).toBe(true);
    expect(canOpenQuestion(at({ hostId: "h2", name: null }))).toBe(false);
    expect(canOpenQuestion({ ...at(null), reference: null })).toBe(false);
    expect(canOpenQuestion({ ...at({ hostId: "h2", name: "Studio" }), reference: null })).toBe(
      false
    );
  });

  it("offers more of the question only when it says more than its first line", () => {
    expect(hasFullerQuestion({ question: "Ship it?", fullQuestion: "Ship it?" })).toBe(false);
    expect(
      hasFullerQuestion({ question: "Ship it?", fullQuestion: "Ship it?\nIt's Friday." })
    ).toBe(true);
    expect(hasFullerQuestion({ question: null, fullQuestion: null })).toBe(false);
    expect(hasFullerQuestion({ question: "Ship it?", fullQuestion: null })).toBe(false);
  });
});
