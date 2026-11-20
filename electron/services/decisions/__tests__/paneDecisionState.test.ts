import { describe, expect, it, vi } from "vitest";
import type { QuestionRow } from "@daintreehq/decisions-client";
import { PaneDecisionStates, projectPaneDecisionStates } from "../paneDecisionState.js";
import type { PaneDecisionState } from "../../../../shared/types/decisions.js";
import type { RunDecisionAttention } from "../../runAnswerAttentionSource.js";
import {
  DECLINE,
  LEGACY_ANSWER,
  SECRET,
  answers,
  askedAt,
  messages,
  outstandingRows,
  qid,
  row,
} from "./questionRows.js";

function only(rows: QuestionRow[], paneId = "pane-a") {
  return projectPaneDecisionStates(rows).get(paneId)?.content;
}

function empty(terminalId: string) {
  return { terminalId, openQuestions: [], waitingAnswers: [], needsAttention: [] };
}

describe("projectPaneDecisionStates", () => {
  it("lists a question whose follow-up needs a person, with the follow-up's status and code (#16231)", () => {
    const delivered = {
      local_status: "human-answered" as const,
      delivery_status: "terminal-delivered" as const,
      answers_json: answers({ delivered: true }),
    };
    const state = only([
      row(1, {
        ...delivered,
        messages_json: messages({
          delivery: { status: "needs-attention", error_code: "pane_gone" },
        }),
      }),
      row(2, {
        ...delivered,
        messages_json: messages(
          { delivery: { status: "needs-attention", error_code: "pane_gone" } },
          {
            message_id: "message-2",
            event_seq: 11,
            delivery: { status: "delivery-uncertain", error_code: "inject_ambiguous" },
          }
        ),
      }),
      // Handled, typed, or still waiting: nothing for a person.
      row(3, {
        ...delivered,
        messages_json: messages(
          { delivery: { status: "needs-attention", error_code: "pane_gone", deliver: false } },
          { message_id: "message-2", event_seq: 11, delivery: { status: "terminal-delivered" } },
          { message_id: "message-3", event_seq: 12 }
        ),
      }),
    ]);

    expect(state?.needsAttention).toEqual([
      {
        questionId: qid(1),
        alias: 1,
        deliveryStatus: "needs-attention",
        reason: "pane_gone",
        subject: "follow-up",
      },
      {
        questionId: qid(2),
        alias: 2,
        deliveryStatus: "delivery-uncertain",
        reason: "pane_gone",
        subject: "follow-ups",
      },
    ]);
    expect(state?.waitingAnswers).toEqual([]);
    expect(JSON.stringify(state)).not.toContain(SECRET);
  });

  it("shows a follow-up's own status and code over its question's handled answer", () => {
    const refused = row(1, {
      local_status: "human-answered",
      delivery_status: "delivery-uncertain",
      error_code: "unknown_option",
      answers_json: answers({}),
      messages_json: messages({ delivery: { status: "needs-attention", error_code: "pane_gone" } }),
    });
    const handled = new Map([[qid(1), 1]]);
    expect(
      projectPaneDecisionStates([refused], handled).get("pane-a")?.content.needsAttention
    ).toEqual([
      {
        questionId: qid(1),
        alias: 1,
        deliveryStatus: "needs-attention",
        reason: "pane_gone",
        subject: "follow-up",
      },
    ]);
    // Not handled, the answer's own status and code show, and it is named with the follow-up.
    expect(projectPaneDecisionStates([refused]).get("pane-a")?.content.needsAttention).toEqual([
      {
        questionId: qid(1),
        alias: 1,
        deliveryStatus: "delivery-uncertain",
        reason: "unknown_option",
        subject: "answer and follow-up",
      },
    ]);
  });

  it("lists a queued or open question with its alias, asked time and expiry", () => {
    const state = only([
      row(1, { local_status: "queued" }),
      row(2, { expires_at: "2026-11-02T10:00:00.000Z" }),
    ]);

    expect(state).toEqual({
      terminalId: "pane-a",
      openQuestions: [
        {
          questionId: qid(1),
          alias: 1,
          status: "queued",
          askedAt: askedAt(1),
          expiresAt: null,
          replyMode: "blocking",
        },
        {
          questionId: qid(2),
          alias: 2,
          status: "open",
          askedAt: askedAt(2),
          expiresAt: "2026-11-02T10:00:00.000Z",
          replyMode: "blocking",
        },
      ],
      waitingAnswers: [],
      needsAttention: [],
    });
  });

  it.each(["cancelled", "expired", "publish-failed", "human-answered", "proxy-answered"] as const)(
    "doesn't list a %s question as open",
    (local_status) => {
      expect(only([row(1, { local_status })])).toBeUndefined();
    }
  );

  it("lists an answer marked for delivery and not yet delivered as waiting, with its status", () => {
    const state = only([
      row(1, {
        local_status: "human-answered",
        delivery_status: "desktop-received",
        answers_json: answers({}),
      }),
      row(2, {
        local_status: "human-answered",
        delivery_status: "pending-host",
        answers_json: answers({}),
      }),
    ]);

    expect(state?.waitingAnswers).toEqual([
      { questionId: qid(1), alias: 1, kind: "answer", deliveryStatus: "desktop-received" },
      { questionId: qid(2), alias: 2, kind: "answer", deliveryStatus: "pending-host" },
    ]);
    expect(state?.openQuestions).toEqual([]);
    expect(state?.needsAttention).toEqual([]);
  });

  it("follows each entry's own flags, not the question's delivered revision", () => {
    const state = only([
      row(1, {
        local_status: "human-answered",
        delivery_status: "terminal-delivered",
        delivered_revision: 2,
        answers_json: answers(
          { revision: 1, delivered: true },
          { revision: 2, correction: true, deliver: false }
        ),
      }),
      row(2, {
        local_status: "human-answered",
        delivery_status: "desktop-received",
        delivered_revision: 5,
        answers_json: answers({ revision: 1 }),
      }),
    ]);

    expect(state?.waitingAnswers.map((w) => w.alias)).toEqual([2]);
  });

  it("names an expiry notice waiting on its own as expired, and an answer beside one as an answer", () => {
    const state = only([
      row(1, {
        local_status: "expired",
        answers_json: answers({
          kind: "expired",
          action: "expire",
          source: "system",
          sealed: null,
        }),
      }),
      row(2, {
        local_status: "human-answered",
        answers_json: answers(
          { kind: "expired", action: "expire", source: "system", sealed: null },
          { entry_id: "entry-2", revision: 2 }
        ),
      }),
    ]);

    expect(state?.waitingAnswers.map(({ alias, kind }) => ({ alias, kind }))).toEqual([
      { alias: 1, kind: "expired" },
      { alias: 2, kind: "answer" },
    ]);
  });

  it("never names the notice of a question that never reached the relay an answer (0.9.0, #17939)", () => {
    const state = only([
      row(1, {
        local_status: "publish-failed",
        error_code: "never_published",
        answers_json: answers({
          kind: "unpublished",
          action: "expire",
          source: "system",
          sealed: null,
        }),
      }),
    ]);

    // Nor an expiry (#17943): no phone ever showed it.
    expect(state?.waitingAnswers.map(({ alias, kind }) => ({ alias, kind }))).toEqual([
      { alias: 1, kind: "never-published" },
    ]);
  });

  it("drops a question the person declined, whether its notice waits, was typed or stopped (#17234)", () => {
    const declined = { local_status: "cancelled" as const, answers_json: answers(DECLINE) };
    const state = only([
      row(1, { ...declined, delivery_status: "desktop-received" }),
      row(2, { ...declined, delivery_status: "pending-host" }),
      row(3, {
        ...declined,
        delivery_status: "delivery-uncertain",
        error_code: "inject_ambiguous",
      }),
      row(4, { ...declined, delivery_status: "needs-attention", error_code: "pane_gone" }),
      row(5, {
        ...declined,
        delivery_status: "terminal-delivered",
        answers_json: answers({ ...DECLINE, delivered: true }),
      }),
      row(6),
    ]);

    expect(state).toEqual({
      ...empty("pane-a"),
      openQuestions: [expect.objectContaining({ questionId: qid(6), alias: 6 })],
    });
  });

  it("drops a question over without an answer, however its notice or withdrawn answer stopped (#18021)", () => {
    const notice = { action: "expire", source: "system", sealed: null } as const;
    const rows = (["needs-attention", "delivery-uncertain"] as const).flatMap(
      (delivery_status, i) => {
        const stopped = { delivery_status, error_code: "pane_gone" };
        const n = i * 4;
        return [
          row(n + 1, {
            ...stopped,
            local_status: "expired",
            answers_json: answers({ ...notice, kind: "expired" }),
          }),
          row(n + 2, {
            ...stopped,
            local_status: "publish-failed",
            answers_json: answers({ ...notice, kind: "unpublished" }),
          }),
          // Withdrawn after its answer stalled: the library drops the answer and leaves the status.
          row(n + 3, {
            ...stopped,
            local_status: "cancelled",
            answers_json: answers({ deliver: false }),
          }),
          // Declined at revision 1, reopened, then withdrawn at revision 2.
          row(n + 4, {
            ...stopped,
            local_status: "cancelled",
            question_revision: 2,
            answers_json: answers({ ...DECLINE, deliver: false }),
          }),
        ];
      }
    );

    expect(only([...rows, row(20)])).toEqual({
      ...empty("pane-a"),
      openQuestions: [expect.objectContaining({ questionId: qid(20), alias: 20 })],
    });
  });

  it("keeps a closed question's stopped notice with the person's follow-up still to be typed", () => {
    const state = only([
      row(1, {
        local_status: "expired",
        delivery_status: "needs-attention",
        error_code: "pane_gone",
        answers_json: answers({
          kind: "expired",
          action: "expire",
          source: "system",
          sealed: null,
          event_seq: 5,
        }),
        // Sent before the deadline, as a closed thread takes none.
        messages_json: messages({ event_seq: 4 }),
      }),
    ]);

    expect(state?.needsAttention).toEqual([
      {
        questionId: qid(1),
        alias: 1,
        deliveryStatus: "needs-attention",
        reason: "pane_gone",
        subject: "timeout notice",
      },
    ]);
  });

  it("keeps a pane in the project of its newest question once that one closes with its notice stopped", () => {
    const panes = projectPaneDecisionStates([
      row(1),
      row(2, {
        origin: { project_id: "project-2" },
        local_status: "expired",
        delivery_status: "needs-attention",
        error_code: "pane_gone",
        answers_json: answers({
          kind: "expired",
          action: "expire",
          source: "system",
          sealed: null,
        }),
      }),
    ]);

    expect(panes.get("pane-a")?.projectId).toBe("project-2");
    expect(panes.get("pane-a")?.content.openQuestions.map((q) => q.alias)).toEqual([1]);
    expect(panes.get("pane-a")?.content.needsAttention).toEqual([]);
  });

  it("lets a question the person marked handled decide its pane's project, and show nothing there", () => {
    // Still open, its refused answer marked handled: it adds no open question either.
    const refused = row(2, {
      question_id: "q_handled_0002",
      origin: { project_id: "project-2" },
      delivery_status: "needs-attention",
      error_code: "choice_required",
    });
    const panes = projectPaneDecisionStates([row(1), refused], new Map([["q_handled_0002", 0]]));

    expect(panes.get("pane-a")?.projectId).toBe("project-2");
    expect(panes.get("pane-a")?.content.openQuestions.map((q) => q.alias)).toEqual([1]);
    expect(panes.get("pane-a")?.content.needsAttention).toEqual([]);
  });

  it("lists stopped deliveries as needing attention with the recorded reason, not as waiting", () => {
    const state = only([
      row(1, {
        local_status: "human-answered",
        delivery_status: "needs-attention",
        error_code: "pane_gone",
        answers_json: answers({}),
      }),
      row(2, {
        local_status: "human-answered",
        delivery_status: "delivery-uncertain",
        error_code: "crash_unreconciled",
        answers_json: answers({}),
      }),
    ]);

    expect(state?.needsAttention).toEqual([
      {
        questionId: qid(1),
        alias: 1,
        deliveryStatus: "needs-attention",
        reason: "pane_gone",
        subject: "answer",
      },
      {
        questionId: qid(2),
        alias: 2,
        deliveryStatus: "delivery-uncertain",
        reason: "crash_unreconciled",
        subject: "answer",
      },
    ]);
    expect(state?.waitingAnswers).toEqual([]);
  });

  it("lists an answer the inbox refused, which keeps no entry, as needing attention on a still-open question", () => {
    const state = only([
      row(1, { delivery_status: "needs-attention", error_code: "choice_required" }),
    ]);

    expect(state?.openQuestions.map((q) => q.alias)).toEqual([1]);
    expect(state?.needsAttention).toEqual([
      {
        questionId: qid(1),
        alias: 1,
        deliveryStatus: "needs-attention",
        reason: "choice_required",
        subject: "answer",
      },
    ]);
  });

  it("names a timeout notice that stopped, alone or with a follow-up, as the list and the notification do (#18054)", () => {
    const stopped = {
      local_status: "expired" as const,
      delivery_status: "needs-attention" as const,
      error_code: "pane_gone",
      answers_json: answers({ kind: "expired", action: "expire", source: "system", sealed: null }),
    };
    const state = only([
      // A follow-up still to be typed keeps the notice with the person (#18021); a lone stopped one is over.
      row(1, {
        ...stopped,
        messages_json: messages({ event_seq: 4 }),
        answers_json: answers({
          kind: "expired",
          action: "expire",
          source: "system",
          sealed: null,
          event_seq: 5,
        }),
      }),
      row(2, {
        ...stopped,
        messages_json: messages({
          delivery: { status: "needs-attention", error_code: "pane_gone" },
        }),
      }),
    ]);

    expect(state?.needsAttention.map(({ alias, subject }) => ({ alias, subject }))).toEqual([
      { alias: 1, subject: "timeout notice" },
      { alias: 2, subject: "timeout notice and follow-up" },
    ]);
  });

  it("carries an advisory round's mode on its open question (#18054)", () => {
    const state = only([
      row(1, {
        content_sealed: JSON.stringify({ aad: { revision: 0, reply_mode: "advisory" } }),
        question_revision: 0,
      }),
    ]);

    expect(state?.openQuestions.map((question) => question.replyMode)).toEqual(["advisory"]);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["free text", `could not type ${SECRET}`],
    ["capitalised", "Pane_Gone"],
    ["too long", "a".repeat(49)],
  ])("reports a %s reason as unspecified", (_label, error_code) => {
    const state = only([
      row(1, { local_status: "human-answered", delivery_status: "needs-attention", error_code }),
    ]);

    expect(state?.needsAttention[0]?.reason).toBe("unspecified");
  });

  it("ignores an old error code once delivery is no longer stopped", () => {
    const state = only([
      row(1, {
        local_status: "human-answered",
        delivery_status: "desktop-received",
        error_code: "pane_gone",
        answers_json: answers({}),
      }),
    ]);

    expect(state?.needsAttention).toEqual([]);
    expect(state?.waitingAnswers.map((w) => w.alias)).toEqual([1]);
  });

  it("leaves out imported history, delivered answers and unreadable answers", () => {
    const panes = projectPaneDecisionStates([
      row(1, { history_only: true }),
      row(2, {
        local_status: "human-answered",
        delivery_status: "terminal-delivered",
        answers_json: answers({ delivered: true }),
      }),
      row(3, { local_status: "human-answered", answers_json: "not json" }),
      row(4, { local_status: "human-answered", answers_json: '{"not":"a list"}' }),
    ]);

    expect(panes.size).toBe(0);
  });

  it("keeps panes apart, each in alias order, whatever order the rows, ids and times are in", () => {
    const paneB = { pane_id: "pane-b", project_id: "project-2" };
    const panes = projectPaneDecisionStates([
      row(30, { origin: paneB }),
      row(10),
      row(2),
      row(9, { origin: paneB }),
    ]);

    expect(panes.get("pane-a")?.projectId).toBe("project-1");
    expect(panes.get("pane-a")?.content.openQuestions.map((q) => q.alias)).toEqual([2, 10]);
    expect(panes.get("pane-b")?.projectId).toBe("project-2");
    expect(panes.get("pane-b")?.content.openQuestions.map((q) => q.alias)).toEqual([9, 30]);
  });

  it("keeps an earlier run's questions on the pane id that asked them", () => {
    const state = only([row(1, { origin: { terminal_generation: 1 } }), row(2)]);

    expect(state?.openQuestions.map((q) => q.alias)).toEqual([1, 2]);
  });

  it("puts a pane in the project of its newest question by alias", () => {
    const panes = projectPaneDecisionStates([
      row(10, { origin: { project_id: "project-2" } }),
      row(2),
    ]);

    expect(panes.get("pane-a")?.projectId).toBe("project-2");
  });

  it("keeps a pane in its newest question's project after that question settles", () => {
    const panes = projectPaneDecisionStates([
      row(1),
      row(2, {
        origin: { project_id: "project-2" },
        local_status: "human-answered",
        delivery_status: "terminal-delivered",
        answers_json: answers({ delivered: true }),
      }),
    ]);

    expect(panes.get("pane-a")?.projectId).toBe("project-2");
    expect(panes.get("pane-a")?.content.openQuestions.map((q) => q.alias)).toEqual([1]);
  });

  it("shows a pane nowhere when its newest question names no project", () => {
    const panes = projectPaneDecisionStates([row(1), row(2, { origin: { project_id: "" } })]);

    expect(panes.size).toBe(0);
  });

  it("never carries question, answer, option, origin or attachment text", () => {
    const panes = projectPaneDecisionStates([
      row(1),
      row(2, {
        local_status: "human-answered",
        delivery_status: "desktop-received",
        answers_json: answers(LEGACY_ANSWER),
      }),
      row(3, {
        local_status: "human-answered",
        delivery_status: "needs-attention",
        error_code: SECRET,
        answers_json: answers(LEGACY_ANSWER),
      }),
    ]);

    expect(panes.get("pane-a")?.content).toEqual({
      terminalId: "pane-a",
      openQuestions: [
        {
          questionId: qid(1),
          alias: 1,
          status: "open",
          askedAt: askedAt(1),
          expiresAt: null,
          replyMode: "blocking",
        },
      ],
      waitingAnswers: [
        { questionId: qid(2), alias: 2, kind: "answer", deliveryStatus: "desktop-received" },
      ],
      needsAttention: [
        {
          questionId: qid(3),
          alias: 3,
          deliveryStatus: "needs-attention",
          reason: "unspecified",
          subject: "answer",
        },
      ],
    });
    expect(JSON.stringify([...panes.values()])).not.toContain("SECRET");
  });
});

function recorder(now = () => 0) {
  const pushes: Array<{ projectId: string; state: PaneDecisionState }> = [];
  const states = new PaneDecisionStates(
    (projectId, state) => pushes.push({ projectId, state }),
    now
  );
  return { pushes, states };
}

describe("PaneDecisionStates", () => {
  it("pushes each pane that changed, with a rising revision, and answers a read with the same", () => {
    const { pushes, states } = recorder();

    states.replace([row(1), row(2, { origin: { pane_id: "pane-b" } })]);
    states.replace([row(1), row(2, { origin: { pane_id: "pane-b" } }), row(3)]);

    expect(
      pushes.map(({ projectId, state }) => [projectId, state.terminalId, state.revision])
    ).toEqual([
      ["project-1", "pane-a", 1],
      ["project-1", "pane-b", 2],
      ["project-1", "pane-a", 3],
    ]);
    expect(states.get("pane-a")).toEqual(pushes[2]?.state);
    expect(states.get("pane-b")).toEqual(pushes[1]?.state);
  });

  it("pushes nothing for a feed that changes nothing a view shows", () => {
    const { pushes, states } = recorder();

    states.replace([row(1), row(2)]);
    states.replace([
      row(2, { remote_event_seq: 9, last_attempt_at: "2026-11-01T11:00:00.000Z" }),
      row(1, { content_sealed: "changed" }),
    ]);

    expect(pushes).toHaveLength(1);
  });

  it("sends one fully empty state to a pane with nothing left, then lets it go", () => {
    const { pushes, states } = recorder();

    states.replace(outstandingRows());
    states.replace([]);

    expect(pushes[0]?.state.waitingAnswers).toHaveLength(1);
    expect(pushes[0]?.state.needsAttention).toHaveLength(1);
    expect(pushes.map(({ projectId, state }) => [projectId, state])).toEqual([
      ["project-1", expect.objectContaining({ revision: 1 })],
      ["project-1", { ...empty("pane-a"), revision: 2 }],
    ]);
    expect(states.get("pane-a")).toBeNull();
  });

  it("clears a pane fully from the project it left before showing it in the new one", () => {
    const { pushes, states } = recorder();

    states.replace(outstandingRows());
    states.replace([...outstandingRows(), row(4, { origin: { project_id: "project-2" } })]);

    expect(pushes.slice(1).map(({ projectId, state }) => [projectId, state])).toEqual([
      ["project-1", { ...empty("pane-a"), revision: 2 }],
      [
        "project-2",
        expect.objectContaining({
          terminalId: "pane-a",
          openQuestions: [
            expect.objectContaining({ alias: 1 }),
            expect.objectContaining({ alias: 4 }),
          ],
          revision: 3,
        }),
      ],
    ]);
  });

  it("clears every pane fully on a stop, quietly at quit, and keeps counting revisions after", () => {
    const { pushes, states } = recorder();

    states.replace([...outstandingRows(), ...outstandingRows({ pane_id: "pane-b" }, [4, 5, 6])]);
    states.clear(true);
    expect(pushes.slice(2).map(({ state }) => state)).toEqual([
      { ...empty("pane-a"), revision: 3 },
      { ...empty("pane-b"), revision: 4 },
    ]);
    expect(states.get("pane-a")).toBeNull();

    states.replace([row(1)]);
    states.clear(false);
    expect(pushes.map(({ state }) => state.revision)).toEqual([1, 2, 3, 4, 5]);
    expect(states.get("pane-a")).toBeNull();
  });

  it("never falls behind the wall clock, so a restarted process outranks its last run", () => {
    let clock = 1_000;
    const before = recorder(() => clock);
    before.states.replace([row(1)]);
    before.states.replace([row(1), row(2)]);
    clock = 900;
    before.states.replace([row(1)]);

    clock = 5_000;
    const after = recorder(() => clock);
    after.states.replace([row(1)]);

    expect(before.pushes.map(({ state }) => state.revision)).toEqual([1_000, 1_001, 1_002]);
    expect(after.pushes.map(({ state }) => state.revision)).toEqual([5_000]);
  });

  it("keeps its own state when a push throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const states = new PaneDecisionStates(() => {
      throw new Error("view gone");
    });

    states.replace([row(1)]);

    expect(states.get("pane-a")?.openQuestions).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("PaneDecisionStates answer attention", () => {
  const stopped = (n: number, paneId = "pane-a") =>
    row(n, {
      local_status: "human-answered",
      delivery_status: "needs-attention",
      error_code: "pane_gone",
      answers_json: answers({}),
      origin: { pane_id: paneId },
    });

  it("tells the fleet how many answers each pane has that need a person", () => {
    const counts: Array<Map<string, RunDecisionAttention>> = [];
    const states = new PaneDecisionStates(
      () => {},
      () => 0,
      (next) => counts.push(new Map(next))
    );

    states.replace([stopped(1), stopped(2), row(3, { origin: { pane_id: "pane-b" } })]);

    expect([...counts.at(-1)!]).toEqual([["pane-a", { answers: 2, questions: 0 }]]);
  });

  it("tells the fleet each terminal's open questions beside its answers, held pane or not", () => {
    const counts: Array<Map<string, RunDecisionAttention>> = [];
    const pushes: string[] = [];
    const states = new PaneDecisionStates(
      (_projectId, state) => pushes.push(state.terminalId),
      () => 0,
      (next) => counts.push(new Map(next))
    );

    states.replace(
      [stopped(1)],
      new Map(),
      new Map([
        ["pane-a", 1],
        ["pane-c", 2],
        ["pane-d", 0],
      ])
    );
    expect(new Map(counts.at(-1))).toEqual(
      new Map([
        ["pane-a", { answers: 1, questions: 1 }],
        ["pane-c", { answers: 0, questions: 2 }],
      ])
    );

    // A question cleared changes no pane, and still reaches the fleet.
    const pushed = pushes.length;
    states.replace([stopped(1)], new Map(), new Map([["pane-a", 1]]));
    expect(pushes.length).toBe(pushed);
    expect(new Map(counts.at(-1))).toEqual(new Map([["pane-a", { answers: 1, questions: 1 }]]));
  });

  it("stops counting a question once it closes with only its notice stopped, or is withdrawn (#18021)", () => {
    const counts: Array<Map<string, RunDecisionAttention>> = [];
    const pushes: PaneDecisionState[] = [];
    const states = new PaneDecisionStates(
      (_projectId, state) => pushes.push(state),
      () => 0,
      (next) => counts.push(new Map(next))
    );
    const notice = { action: "expire", source: "system", sealed: null } as const;
    const paneIds = ["pane-a", "pane-b", "pane-c", "pane-d", "pane-e", "pane-f"];
    const closed = (["needs-attention", "delivery-uncertain"] as const).flatMap((status, i) => {
      const at = (n: number) => ({
        ...stopped(i * 3 + n, paneIds[i * 3 + n - 1]),
        delivery_status: status,
      });
      return [
        {
          ...at(1),
          local_status: "expired" as const,
          answers_json: answers({ ...notice, kind: "expired" }),
        },
        {
          ...at(2),
          local_status: "publish-failed" as const,
          answers_json: answers({ ...notice, kind: "unpublished" }),
        },
        { ...at(3), local_status: "cancelled" as const, answers_json: answers({ deliver: false }) },
      ];
    });

    states.replace(paneIds.map((paneId, i) => stopped(i + 1, paneId)));
    expect([...counts.at(-1)!]).toEqual(
      paneIds.map((paneId) => [paneId, { answers: 1, questions: 0 }])
    );
    const before = pushes.length;
    states.replace(closed);
    expect(counts.at(-1)?.size).toBe(0);
    // Each pane's views get one empty state, and are let go.
    expect(pushes.slice(before)).toEqual(
      paneIds.map((paneId) => expect.objectContaining(empty(paneId)))
    );
    for (const paneId of paneIds) expect(states.get(paneId)).toBeNull();
  });

  it("tells the fleet of questions on terminals with no pane held, and of a count changed alone", () => {
    const counts: Array<Map<string, RunDecisionAttention>> = [];
    const pushes: string[] = [];
    const states = new PaneDecisionStates(
      (_projectId, state) => pushes.push(state.terminalId),
      () => 0,
      (next) => counts.push(new Map(next))
    );
    states.replace([], new Map(), new Map([["pane-z", 1]]));
    expect(new Map(counts.at(-1))).toEqual(new Map([["pane-z", { answers: 0, questions: 1 }]]));

    // A deadline passing takes a question out with no row and no pane push.
    states.setQuestions(new Map());
    expect(counts.at(-1)?.size).toBe(0);
    expect(pushes).toEqual([]);

    // A held pane's stopped answers stay through it.
    states.replace([stopped(1)], new Map(), new Map([["pane-a", 1]]));
    const pushed = pushes.length;
    states.setQuestions(new Map());
    expect(new Map(counts.at(-1))).toEqual(new Map([["pane-a", { answers: 1, questions: 0 }]]));
    expect(pushes.length).toBe(pushed);
  });

  it("clears every count once the panes go, whether or not the views are told", () => {
    for (const notify of [true, false]) {
      const counts: Array<Map<string, RunDecisionAttention>> = [];
      const states = new PaneDecisionStates(
        () => {},
        () => 0,
        (next) => counts.push(new Map(next))
      );
      states.replace([stopped(1)], new Map(), new Map([["pane-b", 1]]));
      states.clear(notify);
      expect(counts.at(-1)?.size).toBe(0);
    }
  });

  it("keeps a failed count update from unwinding the pane push", () => {
    const pushes: string[] = [];
    const states = new PaneDecisionStates(
      (_projectId, state) => pushes.push(state.terminalId),
      () => 0,
      () => {
        throw new Error("fleet gone");
      }
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => states.replace([stopped(1)])).not.toThrow();
    expect(pushes).toEqual(["pane-a"]);
    warn.mockRestore();
  });
});
