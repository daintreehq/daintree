import type { AnswerEntry, QuestionRow } from "@daintreehq/decisions-client";

/** Planted in every text-bearing field, so a test can prove none of it reaches a view. */
export const SECRET = "SECRET-TEXT-must-never-leave";

export function entry(overrides: Partial<AnswerEntry> = {}): AnswerEntry {
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

export function row(
  alias: number,
  overrides: Partial<Omit<QuestionRow, "origin">> & { origin?: Partial<QuestionRow["origin"]> } = {}
): QuestionRow {
  const { origin, ...rest } = overrides;
  return {
    question_id: `qid-${alias}`,
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
    origin_created_at: `2026-11-01T10:0${alias % 10}:00.000Z`,
    expires_at: null,
    local_status: "open",
    delivery_status: "not-sent",
    last_injection_id: null,
    last_attempt_at: null,
    agent_resume_strategy: null,
    error_code: null,
    content_sealed: `{"ciphertext":"${SECRET}"}`,
    legacy_content_json: `{"question":"${SECRET}"}`,
    answers_json: "[]",
    history_only: false,
    delivered_revision: 0,
    attachment_digests: [SECRET],
    ...rest,
  };
}

export function answers(...entries: Array<Partial<AnswerEntry> & { text?: string }>): string {
  return JSON.stringify(entries.map((e) => entry(e)));
}
