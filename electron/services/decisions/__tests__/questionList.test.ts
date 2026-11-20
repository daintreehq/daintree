import { describe, expect, it } from "vitest";
import type { QuestionRow } from "@daintreehq/decisions-client";
import { projectDecisionQuestions, questionAsks, standingOf } from "../questionList.js";
import { NO_ADVISORY_HOST } from "../questionRound.js";
import { threadNeedsAttention } from "../attentionList.js";
import { DECLINE, SECRET, answers, askedAt, messages, qid, row } from "./questionRows.js";

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
      HOST,
      NO_ADVISORY_HOST
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
      HOST,
      NO_ADVISORY_HOST
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
      HOST,
      NO_ADVISORY_HOST
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
    expect(
      projectDecisionQuestions(rows, new Map(), HOST, NO_ADVISORY_HOST).map((item) => item.alias)
    ).toEqual([5]);
    expect(projectDecisionQuestions(rows, new Map(), null, NO_ADVISORY_HOST)).toEqual([]);
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
      HOST,
      NO_ADVISORY_HOST
    );
    const [item] = list;
    expect(Object.keys(item!).sort()).toEqual(
      [
        "agentKind",
        "alias",
        "askedAt",
        "closedReason",
        "closureNotice",
        "expiresAt",
        "projectLabel",
        "reference",
        "replyMode",
        "replyRequest",
        "requirement",
        "settledAt",
        "stall",
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
      HOST,
      NO_ADVISORY_HOST
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

  // A reply from the computer is the person's like a phone's, so it takes the question out of Needs you (#17238).
  it("counts the person's follow-up from the owner computer as their reply", () => {
    const reply = (status: "received" | "terminal-delivered") =>
      standing(
        row(1, {
          ...delivered,
          answers_json: answers({ delivered: true, event_seq: 5 }),
          messages_json: messages(
            { side: "agent", expects_reply: true, event_seq: 6, delivery: null },
            {
              message_id: "message-2",
              event_seq: 7,
              signer_device_id: "owner-1",
              signer_role: "owner-desktop",
              delivery: { status },
            }
          ),
        })
      );
    // Taken off the wait at once; typed in, it is settled.
    expect(reply("received")).toEqual({ kind: "to-type" });
    expect(reply("terminal-delivered")).toMatchObject({ kind: "settled", outcome: "answered" });
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
      // An expiry notice delivery stopped on is over, and needs no one (#18021).
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
    expect(standing(rows[4]!)).toEqual({ kind: "settled", outcome: "expired" });
  });

  it("settles a question over without an answer, whatever became of its notice or its answer (#18021)", () => {
    const expiry = {
      entry_id: "expiry-1",
      kind: "expired",
      action: "expire",
      source: "system",
    } as const;
    const unpublished = { ...expiry, entry_id: "unpublished-1", kind: "unpublished" } as const;
    const stalls = [
      { delivery_status: "needs-attention", error_code: "pane_gone" },
      { delivery_status: "delivery-uncertain", error_code: "inject_ambiguous" },
    ] as const;
    let alias = 0;
    const cases = stalls.flatMap((stall) => [
      row(++alias, {
        ...stall,
        local_status: "expired",
        expires_at: "2026-11-01T12:00:00.000Z",
        answers_json: answers({ ...expiry, created_at: "2026-11-01T12:00:02.000Z", sealed: null }),
      }),
      row(++alias, {
        ...stall,
        local_status: "publish-failed",
        answers_json: answers({ ...unpublished, sealed: null }),
      }),
      // Withdrawn after its answer stalled: the library drops the answer and leaves the status.
      row(++alias, {
        ...stall,
        local_status: "cancelled",
        answers_json: answers({ deliver: false }),
      }),
    ]);
    const list = projectDecisionQuestions(cases, new Map(), HOST, NO_ADVISORY_HOST);

    const notice = (delivery: string) => ({ delivery, disposition: null });
    expect(
      list.map((item) => [
        item.alias,
        item.standing,
        item.closedReason,
        item.closureNotice,
        item.settledAt,
      ])
    ).toEqual([
      [
        1,
        { kind: "settled", outcome: "expired" },
        "expired",
        notice("needs-attention"),
        "2026-11-01T12:00:02.000Z",
      ],
      [2, { kind: "send-failed" }, "never-published", notice("needs-attention"), null],
      [3, { kind: "settled", outcome: "withdrawn" }, "withdrawn", null, null],
      // How far each notice got still reads as recorded: possibly typed is never typed or not.
      [
        4,
        { kind: "settled", outcome: "expired" },
        "expired",
        notice("uncertain"),
        "2026-11-01T12:00:02.000Z",
      ],
      [5, { kind: "send-failed" }, "never-published", notice("uncertain"), null],
      [6, { kind: "settled", outcome: "withdrawn" }, "withdrawn", null, null],
    ]);
    // Nothing stopped that a person resolves, so no stall is raised for any of them.
    expect(list.map((item) => item.stall)).toEqual(cases.map(() => null));
  });

  it("keeps a closed question's notice in Needs attention with the person's follow-up that stopped too", () => {
    const item = projectDecisionQuestions(
      [
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
          messages_json: messages({
            message_id: "held-1",
            event_seq: 4,
            delivery: { status: "needs-attention", error_code: "pane_gone" },
          }),
        }),
      ],
      new Map(),
      HOST,
      NO_ADVISORY_HOST
    )[0]!;
    expect(item.standing).toEqual({ kind: "needs-attention", deliveryStatus: "needs-attention" });
    expect(item.stall).toEqual({ answerRevision: 1, followUpIds: ["held-1"], reason: "pane_gone" });
    expect(item.closureNotice).toEqual({ delivery: "needs-attention", disposition: null });
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
      projectDecisionQuestions([held], new Map([[qid(1), 2]]), HOST, NO_ADVISORY_HOST).map(
        (item) => item.alias
      )
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
      HOST,
      NO_ADVISORY_HOST
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
      HOST,
      NO_ADVISORY_HOST
    );
    expect(item?.standing).toMatchObject({ kind: "settled", outcome: "answered" });
    expect(item?.settledAt).toBe("2026-11-01T10:08:00.000Z");
  });

  it("settles at a correction that came after the reply, and at nothing an agent's later message superseded", () => {
    const request = {
      message_id: "message-1",
      side: "agent" as const,
      expects_reply: true,
      event_seq: 7,
      created_at: "2026-11-01T10:07:00.000Z",
      delivery: null,
    };
    const reply = {
      message_id: "message-2",
      event_seq: 8,
      created_at: "2026-11-01T10:08:00.000Z",
      delivery: { status: "terminal-delivered" as const },
    };
    const [corrected, superseded] = projectDecisionQuestions(
      [
        row(1, {
          ...delivered,
          answers_json: answers(
            { delivered: true, revision: 1, event_seq: 5, created_at: "2026-11-01T10:05:00.000Z" },
            {
              entry_id: "entry-2",
              delivered: true,
              revision: 2,
              correction: true,
              event_seq: 9,
              created_at: "2026-11-01T10:09:00.000Z",
            }
          ),
          messages_json: messages(request, reply),
        }),
        row(2, {
          ...delivered,
          answers_json: answers({
            delivered: true,
            event_seq: 5,
            created_at: "2026-11-01T10:05:00.000Z",
          }),
          messages_json: messages(
            request,
            {
              message_id: "message-3",
              side: "agent",
              expects_reply: false,
              event_seq: 8,
              created_at: "2026-11-01T10:08:00.000Z",
              delivery: null,
            },
            {
              ...reply,
              message_id: "message-4",
              event_seq: 9,
              created_at: "2026-11-01T10:09:00.000Z",
            }
          ),
        }),
      ],
      new Map(),
      HOST,
      NO_ADVISORY_HOST
    );
    expect(corrected?.settledAt).toBe("2026-11-01T10:09:00.000Z");
    expect(superseded?.standing).toMatchObject({ kind: "settled", outcome: "answered" });
    expect(superseded?.settledAt).toBe("2026-11-01T10:05:00.000Z");
  });

  it("settles a question the person declined at their decline, apart from a withdrawal and an expiry, whatever became of its notice (#17234)", () => {
    const declined = { local_status: "cancelled" as const, answers_json: answers(DECLINE) };
    const list = projectDecisionQuestions(
      [
        // Its notice waiting for the agent, typed in, or stopped: the question is settled either way.
        row(1, { ...declined, delivery_status: "desktop-received" }),
        row(2, {
          ...declined,
          delivery_status: "terminal-delivered",
          answers_json: answers({ ...DECLINE, delivered: true }),
        }),
        row(3, { ...declined, delivery_status: "delivery-uncertain" }),
        row(4, { ...declined, answers_json: answers({ ...DECLINE, deliver: false }) }),
        // Declined at revision 1, reopened, then withdrawn at revision 2.
        row(5, { ...declined, question_revision: 2 }),
        // Declined, reopened, then declined again: settled at the decline that closed it.
        row(6, {
          ...declined,
          question_revision: 2,
          answers_json: answers(DECLINE, {
            ...DECLINE,
            entry_id: "decline-2",
            revision: 2,
            created_at: "2026-11-01T11:20:00.000Z",
          }),
        }),
      ],
      new Map(),
      HOST,
      NO_ADVISORY_HOST
    );

    expect(list.map((item) => [item.alias, item.standing, item.settledAt])).toEqual([
      [1, { kind: "settled", outcome: "declined" }, "2026-11-01T11:07:00.000Z"],
      [2, { kind: "settled", outcome: "declined" }, "2026-11-01T11:07:00.000Z"],
      [3, { kind: "settled", outcome: "declined" }, "2026-11-01T11:07:00.000Z"],
      [4, { kind: "settled", outcome: "declined" }, "2026-11-01T11:07:00.000Z"],
      [5, { kind: "settled", outcome: "withdrawn" }, null],
      [6, { kind: "settled", outcome: "declined" }, "2026-11-01T11:20:00.000Z"],
    ]);
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

describe("follow-up and stall events (#17235)", () => {
  const project = (r: QuestionRow, handled: ReadonlyMap<string, number> = new Map()) =>
    projectDecisionQuestions([r], handled, HOST, NO_ADVISORY_HOST)[0]!;
  const request = (id: string, seq: number) => ({
    message_id: id,
    side: "agent" as const,
    expects_reply: true,
    event_seq: seq,
    delivery: null,
  });
  const answered = (messagesJson: string) =>
    row(1, {
      ...delivered,
      answers_json: answers({ delivered: true, event_seq: 5 }),
      messages_json: messagesJson,
    });

  it("names the agent's follow-up asking for a reply, by id, until the person replies", () => {
    expect(project(answered(messages(request("ask-1", 6)))).replyRequest).toBe("ask-1");
    // A second request is a new one, named by its own id.
    expect(
      project(
        answered(
          messages(
            request("ask-1", 6),
            { message_id: "reply-1", event_seq: 7 },
            request("ask-2", 8)
          )
        )
      ).replyRequest
    ).toBe("ask-2");
    // The latest by the ledger's order, however the thread is stored.
    expect(
      project(
        answered(
          messages(
            request("ask-2", 8),
            { message_id: "reply-1", event_seq: 7 },
            request("ask-1", 6)
          )
        )
      ).replyRequest
    ).toBe("ask-2");
    // Replied to, or superseded by a follow-up asking nothing: none.
    expect(
      project(answered(messages(request("ask-1", 6), { message_id: "reply-1", event_seq: 7 })))
        .replyRequest
    ).toBeNull();
    expect(
      project(
        answered(
          messages(request("ask-1", 6), {
            message_id: "note-1",
            side: "agent",
            expects_reply: false,
            event_seq: 7,
            delivery: null,
          })
        )
      ).replyRequest
    ).toBeNull();
    // A question still open waits for its answer, not a reply.
    expect(project(row(1, { messages_json: messages(request("ask-1", 6)) })).replyRequest).toBe(
      null
    );
  });

  it("names a reply request even while the question's standing shows its answer needing attention", () => {
    const item = project(
      row(1, {
        local_status: "human-answered",
        delivery_status: "needs-attention",
        error_code: "pane_gone",
        answers_json: answers({ event_seq: 5 }),
        messages_json: messages(request("ask-1", 6)),
      })
    );
    expect(item.standing.kind).toBe("needs-attention");
    expect(item.replyRequest).toBe("ask-1");
  });

  it("names what delivery stopped on, by id, with the library's code for why", () => {
    expect(project(answered("[]")).stall).toBeNull();
    expect(
      project(
        row(1, {
          local_status: "human-answered",
          delivery_status: "needs-attention",
          error_code: "pane_gone",
          answers_json: answers({ revision: 2 }),
          messages_json: messages({
            message_id: "held-1",
            delivery: { status: "needs-attention", error_code: "inject_rejected" },
          }),
        })
      ).stall
    ).toEqual({ answerRevision: 2, followUpIds: ["held-1"], reason: "pane_gone" });
    // With the answer handled, only the follow-ups are held, for their own reason.
    const handledAnswer = row(1, {
      local_status: "human-answered",
      delivery_status: "needs-attention",
      error_code: "pane_gone",
      answers_json: answers({ revision: 2 }),
      messages_json: messages(
        {
          message_id: "held-1",
          event_seq: 10,
          delivery: { status: "delivery-uncertain", error_code: "inject_ambiguous" },
        },
        { message_id: "held-2", event_seq: 11, delivery: { status: "needs-attention" } }
      ),
    });
    expect(project(handledAnswer, new Map([[qid(1), 2]])).stall).toEqual({
      answerRevision: null,
      followUpIds: ["held-1", "held-2"],
      reason: "inject_ambiguous",
    });
    // Free text never passes for a code.
    expect(
      project(
        row(1, {
          local_status: "human-answered",
          delivery_status: "needs-attention",
          error_code: `free text ${SECRET}`,
          answers_json: answers({}),
        })
      ).stall?.reason
    ).toBe("unspecified");
  });
});

describe("questionAsks", () => {
  const agent = (id: string, seq: number, expectsReply = false) => ({
    message_id: id,
    side: "agent" as const,
    expects_reply: expectsReply,
    event_seq: seq,
    delivery: null,
  });

  it("names each question's latest agent follow-up by ledger seq, or null for the question alone", () => {
    const rows = [
      row(1),
      // Out of order in the array: the ledger seq decides which is latest.
      row(2, { messages_json: messages(agent("note-2", 9), agent("note-1", 4)) }),
      row(3, {
        local_status: "human-answered",
        answers_json: answers({ event_seq: 5 }),
        messages_json: messages(agent("ask-3", 6, true)),
      }),
    ];
    const asks = questionAsks(rows, new Set([qid(1), qid(2), qid(3)]));
    expect(asks).toEqual(
      new Map([
        [qid(1), null],
        [qid(2), "note-2"],
        [qid(3), "ask-3"],
      ])
    );
  });

  it("doesn't take the person's own follow-ups as something asked of them", () => {
    const asks = questionAsks(
      [
        row(1, {
          messages_json: messages(agent("note-1", 4), { message_id: "mine", event_seq: 8 }),
        }),
      ],
      new Set([qid(1)])
    );
    expect(asks.get(qid(1))).toBe("note-1");
  });

  it("reads only the questions named", () => {
    expect(questionAsks([row(1), row(2)], new Set([qid(2)]))).toEqual(new Map([[qid(2), null]]));
  });
});
