import { describe, expect, it, vi } from "vitest";
import type { QuestionRow } from "@daintreehq/decisions-client";
import { PaneDecisionStates, projectPaneDecisionStates } from "../paneDecisionState.js";
import type { PaneDecisionState } from "../../../../shared/types/decisions.js";
import {
  LEGACY_ANSWER,
  SECRET,
  answers,
  askedAt,
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
  it("lists a queued or open question with its alias, asked time and expiry", () => {
    const state = only([
      row(1, { local_status: "queued" }),
      row(2, { expires_at: "2026-11-02T10:00:00.000Z" }),
    ]);

    expect(state).toEqual({
      terminalId: "pane-a",
      openQuestions: [
        { questionId: qid(1), alias: 1, status: "queued", askedAt: askedAt(1), expiresAt: null },
        {
          questionId: qid(2),
          alias: 2,
          status: "open",
          askedAt: askedAt(2),
          expiresAt: "2026-11-02T10:00:00.000Z",
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
      { questionId: qid(1), alias: 1, deliveryStatus: "needs-attention", reason: "pane_gone" },
      {
        questionId: qid(2),
        alias: 2,
        deliveryStatus: "delivery-uncertain",
        reason: "crash_unreconciled",
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
      },
    ]);
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
        { questionId: qid(1), alias: 1, status: "open", askedAt: askedAt(1), expiresAt: null },
      ],
      waitingAnswers: [
        { questionId: qid(2), alias: 2, kind: "answer", deliveryStatus: "desktop-received" },
      ],
      needsAttention: [
        { questionId: qid(3), alias: 3, deliveryStatus: "needs-attention", reason: "unspecified" },
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
