import type {
  AnswerContent,
  AnswerEntry,
  MessageDelivery,
  QuestionRow,
  StoredMessage,
} from "@daintreehq/decisions-client";

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
    messages_json: "[]",
    history_only: false,
    delivered_revision: 0,
    attachment_digests: [SECRET],
    ...rest,
  };
}

export function answers(...entries: EntryOverrides[]): string {
  return JSON.stringify(entries.map((e) => entry(e)));
}

type MessageOverrides = Partial<Omit<StoredMessage, "delivery">> & {
  delivery?: Partial<MessageDelivery> | null;
};

/** A follow-up from the person (#16231), received and not yet typed, its `received` receipt sent. */
export function message(overrides: MessageOverrides = {}): StoredMessage {
  const { delivery, ...rest } = overrides;
  return {
    message_id: "message-1",
    message_seq: 1,
    event_seq: 10,
    side: "human",
    expects_reply: false,
    signer_device_id: "phone-1",
    attachment_ids: [],
    created_at: "2026-11-01T10:06:00.000Z",
    committed_at: "2026-11-01T10:06:01.000Z",
    envelope_digest: "digest-1",
    sealed: `{"ciphertext":"${SECRET}"}`,
    target_host_id: "host_1",
    ...rest,
    delivery:
      delivery === null
        ? null
        : {
            status: "received",
            deliver: true,
            received_at: "2026-11-01T10:06:02.000Z",
            terminal_delivered_at: null,
            injection_id: null,
            error_code: null,
            reported: "received",
            ...delivery,
          },
  };
}

export function messages(...list: MessageOverrides[]): string {
  return JSON.stringify(list.map((m) => message(m)));
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
