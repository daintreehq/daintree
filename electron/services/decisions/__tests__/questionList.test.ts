import { describe, expect, it } from "vitest";
import type { QuestionRow } from "@daintreehq/decisions-client";
import { projectDecisionQuestions, standingOf } from "../questionList.js";
import { threadNeedsAttention } from "../attentionList.js";
import { SECRET, answers, askedAt, messages, qid, row } from "./questionRows.js";

const HOST = "host_1";

function standing(r: QuestionRow, handled: ReadonlyMap<string, number> = new Map()) {
  return standingOf(r, handled);
}

const delivered = {
  local_status: "human-answered" as const,
  delivery_status: "terminal-delivered" as const,
  answers_json: answers({ delivered: true }),
};

describe("projectDecisionQuestions", () => {
  it("lists every question this computer asked, across projects and terminals, oldest first", () => {
    const list = projectDecisionQuestions(
      [
        row(3, { origin: { project_id: "project-b", pane_id: "pane-b" } }),
        row(1),
        row(2, { origin: { project_id: "project-c", pane_id: "pane-c", worktree_id: "w-2" } }),
      ],
      new Map(),
      HOST
    );

    expect(list.map((item) => item.reference)).toEqual([
      { hostId: HOST, projectId: "project-1", terminalId: "pane-a", questionId: qid(1) },
      { hostId: HOST, projectId: "project-c", terminalId: "pane-c", questionId: qid(2) },
      { hostId: HOST, projectId: "project-b", terminalId: "pane-b", questionId: qid(3) },
    ]);
    expect(list[1]).toMatchObject({
      alias: 2,
      agentKind: "claude",
      worktreeId: "w-2",
      requirement: "human-required",
      askedAt: askedAt(2),
      expiresAt: null,
      settledAt: null,
      standing: { kind: "waiting", reason: "open" },
    });
  });

  it("carries each question's own agent, requirement and worktree", () => {
    const list = projectDecisionQuestions(
      [
        row(1, {
          requirement: "proxy-ok",
          origin: { agent_kind: "codex", worktree_id: "w-1", worktree_root: "/repos/one" },
        }),
        row(2, {
          requirement: "proxy-first",
          expires_at: "2026-12-01T00:00:00.000Z",
          origin: { agent_kind: "gemini", worktree_id: "w-2", worktree_root: "/repos/two" },
        }),
      ],
      new Map(),
      HOST
    );
    expect(
      list.map(({ agentKind, requirement, worktreeId, worktreeRoot, expiresAt }) => ({
        agentKind,
        requirement,
        worktreeId,
        worktreeRoot,
        expiresAt,
      }))
    ).toEqual([
      {
        agentKind: "codex",
        requirement: "proxy-ok",
        worktreeId: "w-1",
        worktreeRoot: "/repos/one",
        expiresAt: null,
      },
      {
        agentKind: "gemini",
        requirement: "proxy-first",
        worktreeId: "w-2",
        worktreeRoot: "/repos/two",
        expiresAt: "2026-12-01T00:00:00.000Z",
      },
    ]);
  });

  it("keeps a closed terminal's questions, settled or not: nothing checks a terminal still runs", () => {
    // Nothing here knows which terminals run; a question outlives its terminal in the store.
    const list = projectDecisionQuestions(
      [
        row(1, { origin: { pane_id: "closed-pane" } }),
        row(2, { ...delivered, origin: { pane_id: "closed-pane" } }),
      ],
      new Map(),
      HOST
    );
    expect(list.map((item) => [item.reference.terminalId, item.standing.kind])).toEqual([
      ["closed-pane", "waiting"],
      ["closed-pane", "settled"],
    ]);
  });

  it("lists nothing another machine asked, nothing imported, and nothing without a host id", () => {
    const rows = [
      row(1, { origin: { host_id: "host_remote" } }),
      row(2, { history_only: true }),
      row(3, { origin: { project_id: "" } }),
      row(4, { origin: { pane_id: "" } }),
      row(5),
    ];
    expect(projectDecisionQuestions(rows, new Map(), HOST).map((item) => item.alias)).toEqual([5]);
    expect(projectDecisionQuestions(rows, new Map(), null)).toEqual([]);
  });

  it("copies ids, labels, times and statuses only: no question, answer or follow-up text", () => {
    const list = projectDecisionQuestions(
      [
        row(1, {
          ...delivered,
          answers_json: answers({ delivered: true, choices: [{ id: SECRET, label: SECRET }] }),
          messages_json: messages({ side: "agent", delivery: null }),
        }),
      ],
      new Map(),
      HOST
    );
    const [item] = list;
    expect(Object.keys(item!).sort()).toEqual(
      [
        "agentKind",
        "alias",
        "askedAt",
        "expiresAt",
        "projectLabel",
        "reference",
        "requirement",
        "settledAt",
        "standing",
        "worktreeId",
        "worktreeRoot",
      ].sort()
    );
    // The project's name and the worktree's path are this computer's own labels, not content.
    const { projectLabel: _label, worktreeRoot: _root, ...rest } = item!;
    expect(JSON.stringify(rest)).not.toContain(SECRET);
  });

  it("trims the project's label, and names none when the question carries a blank one", () => {
    const [named, blank, none] = projectDecisionQuestions(
      [
        row(1, { origin: { project_label: "  daintree  " } }),
        row(2, { origin: { project_label: "  " } }),
        row(3, { origin: { project_label: undefined } }),
      ],
      new Map(),
      HOST
    );
    expect([named?.projectLabel, blank?.projectLabel, none?.projectLabel]).toEqual([
      "daintree",
      null,
      null,
    ]);
  });
});

describe("standingOf", () => {
  it("waits for the person while open, queued while unsent, and failed when it couldn't be sent", () => {
    expect(standing(row(1))).toEqual({ kind: "waiting", reason: "open" });
    expect(standing(row(1, { local_status: "queued" }))).toEqual({ kind: "queued" });
    expect(standing(row(1, { local_status: "publish-failed" }))).toEqual({ kind: "send-failed" });
  });

  it("waits for a reply when the agent's latest follow-up expects one after the person's answer", () => {
    const asked = (overrides: Partial<QuestionRow>) =>
      standing(
        row(1, {
          ...delivered,
          answers_json: answers({ delivered: true, event_seq: 5 }),
          ...overrides,
        })
      );
    expect(
      asked({
        messages_json: messages({
          side: "agent",
          expects_reply: true,
          event_seq: 6,
          delivery: null,
        }),
      })
    ).toEqual({ kind: "waiting", reason: "reply" });
    // The person replied after it, or the follow-up asked for nothing: settled.
    expect(
      asked({
        messages_json: messages(
          { side: "agent", expects_reply: true, event_seq: 6, delivery: null },
          { message_id: "message-2", event_seq: 7, delivery: { status: "terminal-delivered" } }
        ),
      })
    ).toMatchObject({ kind: "settled", outcome: "answered" });
    expect(
      asked({
        messages_json: messages({
          side: "agent",
          expects_reply: false,
          event_seq: 6,
          delivery: null,
        }),
      })
    ).toMatchObject({ kind: "settled", outcome: "answered" });
    // An answer after the request answers it too.
    expect(
      asked({
        answers_json: answers({ delivered: true, event_seq: 8 }),
        messages_json: messages({
          side: "agent",
          expects_reply: true,
          event_seq: 6,
          delivery: null,
        }),
      })
    ).toMatchObject({ kind: "settled", outcome: "answered" });
  });

  it("never counts the model's own answer as the person replying", () => {
    expect(
      standing(
        row(1, {
          local_status: "proxy-answered",
          delivery_status: "terminal-delivered",
          answers_json: answers({
            delivered: true,
            source: "proxy",
            action: "proxy-answer",
            event_seq: 8,
          }),
          messages_json: messages({
            side: "agent",
            expects_reply: true,
            event_seq: 6,
            delivery: null,
          }),
        })
      )
    ).toEqual({ kind: "waiting", reason: "reply" });
  });

  it("waits to be typed in while an answer or the person's follow-up is received and not yet typed", () => {
    expect(
      standing(
        row(1, {
          local_status: "human-answered",
          delivery_status: "desktop-received",
          answers_json: answers({}),
        })
      )
    ).toEqual({ kind: "to-type" });
    expect(
      standing(
        row(1, {
          ...delivered,
          messages_json: messages({ delivery: { status: "received" } }),
        })
      )
    ).toEqual({ kind: "to-type" });
  });

  it("needs attention exactly when the list of answers needing attention would show it", () => {
    const rows = [
      row(1, {
        local_status: "human-answered",
        delivery_status: "needs-attention",
        answers_json: answers({}),
      }),
      row(2, {
        local_status: "human-answered",
        delivery_status: "delivery-uncertain",
        answers_json: answers({}),
      }),
      row(3, {
        ...delivered,
        messages_json: messages({ delivery: { status: "needs-attention" } }),
      }),
      row(4, {
        ...delivered,
        messages_json: messages({ delivery: { status: "delivery-uncertain" } }),
      }),
      // An expiry notice delivery stopped on needs a person too.
      row(5, {
        local_status: "expired",
        delivery_status: "needs-attention",
        answers_json: answers({ kind: "expired", action: "expire", source: "system" }),
      }),
      // A refused answer leaves its question open and needing attention.
      row(6, { delivery_status: "needs-attention" }),
      row(7),
      row(8, delivered),
    ];
    for (const r of rows) {
      expect(standing(r).kind === "needs-attention", `q-${r.alias}`).toBe(
        threadNeedsAttention(r, new Map())
      );
    }
    expect(standing(rows[1]!)).toEqual({
      kind: "needs-attention",
      deliveryStatus: "delivery-uncertain",
    });
    expect(standing(rows[3]!)).toEqual({
      kind: "needs-attention",
      deliveryStatus: "delivery-uncertain",
    });
    expect(standing(rows[0]!)).toEqual({
      kind: "needs-attention",
      deliveryStatus: "needs-attention",
    });
  });

  it("settles a handled answer, keeping it listed, until a correction needs the person again", () => {
    const held = row(1, {
      local_status: "human-answered",
      delivery_status: "needs-attention",
      answers_json: answers({ revision: 2 }),
    });
    expect(standing(held, new Map([[qid(1), 2]]))).toEqual({
      kind: "settled",
      outcome: "answered",
      handled: true,
    });
    expect(standing(held, new Map([[qid(1), 1]]))).toMatchObject({ kind: "needs-attention" });
    // Handled, but a follow-up after it is held: the person decides again.
    expect(
      standing(
        row(1, {
          local_status: "human-answered",
          delivery_status: "needs-attention",
          answers_json: answers({ revision: 2 }),
          messages_json: messages({ delivery: { status: "needs-attention" } }),
        }),
        new Map([[qid(1), 2]])
      )
    ).toMatchObject({ kind: "needs-attention" });
    expect(
      projectDecisionQuestions([held], new Map([[qid(1), 2]]), HOST).map((item) => item.alias)
    ).toEqual([1]);
  });

  it("settles a delivered answer, a withdrawal and an expiry, with when each settled", () => {
    const answered = row(1, {
      ...delivered,
      answers_json: answers(
        { delivered: true, revision: 1, created_at: "2026-11-01T10:05:00.000Z" },
        {
          entry_id: "entry-2",
          delivered: true,
          revision: 2,
          correction: true,
          created_at: "2026-11-01T10:09:00.000Z",
        }
      ),
    });
    const withdrawn = row(2, { local_status: "cancelled", delivery_status: "relay-queued" });
    const expiredNotice = row(3, {
      local_status: "expired",
      expires_at: "2026-11-01T11:00:00.000Z",
      answers_json: answers({
        kind: "expired",
        action: "expire",
        source: "system",
        delivered: true,
        created_at: "2026-11-01T11:00:02.000Z",
      }),
    });
    const expiredBare = row(4, { local_status: "expired", expires_at: "2026-11-01T12:00:00.000Z" });
    const list = projectDecisionQuestions(
      [answered, withdrawn, expiredNotice, expiredBare],
      new Map(),
      HOST
    );

    expect(list.map((item) => [item.standing, item.settledAt])).toEqual([
      [{ kind: "settled", outcome: "answered", handled: false }, "2026-11-01T10:09:00.000Z"],
      [{ kind: "settled", outcome: "withdrawn" }, null],
      [{ kind: "settled", outcome: "expired" }, "2026-11-01T11:00:02.000Z"],
      [{ kind: "settled", outcome: "expired" }, "2026-11-01T12:00:00.000Z"],
    ]);
  });

  it("settles a thread when the person replies to the agent's request, at the reply", () => {
    const [item] = projectDecisionQuestions(
      [
        row(1, {
          ...delivered,
          answers_json: answers({
            delivered: true,
            event_seq: 5,
            created_at: "2026-11-01T10:05:00.000Z",
          }),
          messages_json: messages(
            // A follow-up of the person's before the request settles nothing.
            {
              message_id: "message-0",
              event_seq: 6,
              created_at: "2026-11-01T10:06:00.000Z",
              delivery: { status: "terminal-delivered" },
            },
            {
              message_id: "message-1",
              side: "agent",
              expects_reply: true,
              event_seq: 7,
              created_at: "2026-11-01T10:07:00.000Z",
              delivery: null,
            },
            {
              message_id: "message-2",
              event_seq: 8,
              created_at: "2026-11-01T10:08:00.000Z",
              delivery: { status: "terminal-delivered" },
            },
            {
              message_id: "message-3",
              event_seq: 9,
              created_at: "2026-11-01T10:09:00.000Z",
              delivery: { status: "terminal-delivered" },
            }
          ),
        }),
      ],
      new Map(),
      HOST
    );
    expect(item?.standing).toMatchObject({ kind: "settled", outcome: "answered" });
    expect(item?.settledAt).toBe("2026-11-01T10:08:00.000Z");
  });

  it("settles a closed question even when its delivery status is left from before", () => {
    expect(
      standing(row(1, { local_status: "cancelled", delivery_status: "desktop-received" }))
    ).toEqual({ kind: "settled", outcome: "withdrawn" });
    expect(
      standing(
        row(1, {
          local_status: "expired",
          delivery_status: "desktop-received",
          answers_json: answers({ kind: "expired", action: "expire", source: "system" }),
        })
      )
    ).toEqual({ kind: "settled", outcome: "expired" });
  });
});
