import type { AnswerContent, AnswerEntry, QuestionRow } from "@daintreehq/decisions-client";

/** Planted in every text-bearing field, so a test can prove none of it reaches a view. */
export const SECRET = "SECRET-TEXT-must-never-leave";

/**
 * A question's id. Its text sorts against alias order, as does its asked-at
 * time, so only a sort by alias puts rows in question order.
 */
export function qid(alias: number): string {
  return `q_${String.fromCharCode(122 - (alias % 26))}_${alias}`;
}

export function askedAt(alias: number): string {
  return `2026-11-01T10:${String(59 - alias).padStart(2, "0")}:00.000Z`;
}

type EntryOverrides = Partial<AnswerEntry> & Partial<AnswerContent>;

export function entry(overrides: EntryOverrides = {}): AnswerEntry {
  return {
    entry_id: "entry-1",
    kind: "answer",
    action: "answer",
    revision: 1,
    source: "human",
    correction: false,
    created_at: "2026-11-01T10:05:00.000Z",
    deliver: true,
    delivered: false,
    sealed: `{"ciphertext":"${SECRET}"}`,
    ...overrides,
  };
}

/**
 * An answer from a store written before content was sealed: the library
 * keeps its content in clear on the entry.
 */
export const LEGACY_ANSWER: EntryOverrides = {
  sealed: undefined,
  choices: [{ id: SECRET, label: SECRET }],
  text: SECRET,
  reviewed_attachment_digests: [SECRET],
  confidence: 0.5,
  model_id: SECRET,
};

export function row(
  alias: number,
  overrides: Partial<Omit<QuestionRow, "origin">> & { origin?: Partial<QuestionRow["origin"]> } = {}
): QuestionRow {
  const { origin, ...rest } = overrides;
  return {
    question_id: qid(alias),
    alias,
    origin: {
      host_id: "host_1",
      pane_id: "pane-a",
      terminal_generation: 3,
      ownership_principal: `principal ${SECRET}`,
      agent_incarnation: "incarnation-1",
      agent_kind: "claude",
      agent_session_id: "session-1",
      project_id: "project-1",
      worktree_id: "worktree-1",
      worktree_root: `/Users/someone/${SECRET}`,
      workflow_gate_id: null,
      project_label: SECRET,
      machine_label: SECRET,
      ...origin,
    },
    requirement: "human-required",
    question_revision: 1,
    remote_event_seq: null,
    origin_created_at: askedAt(alias),
    expires_at: null,
    local_status: "open",
    delivery_status: "not-sent",
    last_injection_id: null,
    last_attempt_at: null,
    agent_resume_strategy: null,
    error_code: null,
    content_sealed: `{"ciphertext":"${SECRET}"}`,
    legacy_content_json: JSON.stringify({
      question: SECRET,
      context: SECRET,
      options: [{ id: SECRET, label: SECRET, description: SECRET }],
      attachments: [{ alt: SECRET }],
    }),
    answers_json: "[]",
    history_only: false,
    delivered_revision: 0,
    attachment_digests: [SECRET],
    ...rest,
  };
}

export function answers(...entries: EntryOverrides[]): string {
  return JSON.stringify(entries.map((e) => entry(e)));
}

/** One question of each kind a pane can show: open, an answer waiting, and one needing attention. */
export function outstandingRows(
  origin: Partial<QuestionRow["origin"]> = {},
  aliases: readonly [number, number, number] = [1, 2, 3]
): QuestionRow[] {
  const [open, waiting, attention] = aliases;
  return [
    row(open, { origin }),
    row(waiting, {
      origin,
      local_status: "human-answered",
      delivery_status: "desktop-received",
      answers_json: answers({}),
    }),
    row(attention, {
      origin,
      local_status: "human-answered",
      delivery_status: "needs-attention",
      error_code: "pane_gone",
      answers_json: answers({}),
    }),
  ];
}
