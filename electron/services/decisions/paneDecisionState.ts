import {
  isPendingMessage,
  parseAnswers,
  parseMessages,
  type QuestionRow,
} from "@daintreehq/decisions-client";
import {
  answerNeedsAttention,
  heldFollowUps,
  heldTimeoutNotice,
  reasonOf,
  type HandledAnswers,
} from "./attentionList.js";
import { replyModeOfRow } from "./questionRound.js";
import { replyRequestMessage, standingOf } from "./questionList.js";
import { deliverySubject } from "../../../shared/utils/decisionsDeliveryReasons.js";
import type {
  DecisionDeliveryStatus,
  PaneDecisionAttention,
  PaneDecisionQuestion,
  PaneDecisionState,
} from "../../../shared/types/decisions.js";
import type { RunDecisionAttention } from "../runAnswerAttentionSource.js";

export type PaneDecisionStatePublisher = (projectId: string, state: PaneDecisionState) => void;

/**
 * Every pane with answers needing a person or questions open for one, and how
 * many of each; an empty map when none has any.
 */
export type AnswerAttentionPublisher = (counts: ReadonlyMap<string, RunDecisionAttention>) => void;

type PaneContent = Omit<PaneDecisionState, "revision">;

/**
 * The questions with a withdrawal or the person's decline queued on this
 * machine for the relay (#18052), by question id: read from the outbox, so
 * every view sees one at once, whichever view started it.
 */
export type PendingClosings = ReadonlyMap<string, NonNullable<PaneDecisionQuestion["closing"]>>;

export interface ProjectedPane {
  projectId: string;
  content: PaneContent;
}

type AttentionStatus = PaneDecisionAttention["deliveryStatus"];

function isAttention(status: DecisionDeliveryStatus): status is AttentionStatus {
  return status === "needs-attention" || status === "delivery-uncertain";
}

function byAlias(a: QuestionRow, b: QuestionRow): number {
  return a.alias - b.alias || (a.question_id < b.question_id ? -1 : 1);
}

/**
 * What each pane has outstanding, from the store's question rows. Only ids,
 * aliases, times, statuses and reason codes are copied, field by field: a
 * row's content and its answers' sealed text are never read.
 *
 * - **Open:** `queued` or `open`, whatever has arrived for it since.
 * - **Needs attention:** delivery stopped at `needs-attention` or
 *   `delivery-uncertain`. That status is the observation, with or without an
 *   answer still marked for delivery: the inbox flags an answer it refused
 *   without keeping it. A follow-up held for a person (#16231) counts too,
 *   with its own status and code once the answer is past needing one.
 * - **Waiting:** otherwise, an answer entry still marked for delivery and not
 *   yet delivered, the same test the delivery engine uses. A person's decline
 *   (#17234) isn't one: they chose not to answer, so the pane drops the
 *   question even while its notice waits to be typed.
 * - **Reply requested:** answered, and its agent asked for a reply the person
 *   hasn't given (#18052).
 * - **Follow-up waiting:** answered, with nothing of the answer left to type,
 *   and a follow-up of the person's received and not yet typed (#18052).
 *
 * The last two, and which questions wait on the person, are read as the list
 * of every question reads them (`standingOf`), so the chip and the inbox never
 * disagree. Imported history is never delivered and shows nowhere, and what a
 * person marked handled, or a question over without an answer whose notice
 * stopped (#18021), adds no warning. Rows are taken in question order, and a
 * pane belongs to the project of its newest question, settled or not, so
 * settling that question never moves the pane back. `closings` marks the open
 * questions a withdrawal or decline is under way for.
 */
export function projectPaneDecisionStates(
  rows: readonly QuestionRow[],
  handled: HandledAnswers = new Map(),
  closings: PendingClosings = new Map()
): Map<string, ProjectedPane> {
  const sorted = [...rows].filter((row) => !row.history_only).sort(byAlias);
  const projectOf = new Map<string, string>();
  // The newest row decides even when its project is missing: the pane then
  // shows nowhere rather than in a project an older question named.
  for (const { origin } of sorted) {
    if (origin.pane_id) projectOf.set(origin.pane_id, origin.project_id);
  }

  const panes = new Map<string, ProjectedPane>();
  for (const row of sorted) {
    const paneId = row.origin.pane_id;
    const projectId = projectOf.get(paneId);
    if (!paneId || !projectId) continue;

    const deliveryStatus: DecisionDeliveryStatus = row.delivery_status;
    const open = row.local_status === "queued" || row.local_status === "open";
    const held = heldFollowUps(row);
    // A handled answer's status is past needing a person; its follow-ups may not be.
    const answerHeld = isAttention(deliveryStatus) && answerNeedsAttention(row, handled);
    const attention = answerHeld || held.length > 0;
    const standing = standingOf(row, handled);
    // What waits on the person comes first, as the list shows it.
    const reply =
      standing.kind === "waiting" && standing.reason === "reply" ? replyRequestMessage(row) : null;
    const pending =
      attention || reply !== null || isAttention(deliveryStatus)
        ? []
        : parseAnswers(row.answers_json).filter(
            (entry) => entry.deliver && !entry.delivered && entry.kind !== "declined"
          );
    const followUp =
      standing.kind === "to-type" &&
      pending.length === 0 &&
      parseMessages(row.messages_json).some(isPendingMessage);
    if (!open && !attention && reply === null && pending.length === 0 && !followUp) continue;

    let pane = panes.get(paneId);
    if (!pane) {
      pane = { projectId, content: emptyContent(paneId) };
      panes.set(paneId, pane);
    }

    const { question_id: questionId, alias } = row;
    if (row.local_status === "queued" || row.local_status === "open") {
      const closing = closings.get(questionId);
      pane.content.openQuestions.push({
        questionId,
        alias,
        status: row.local_status,
        askedAt: row.origin_created_at,
        expiresAt: row.expires_at ?? null,
        replyMode: replyModeOfRow(row, parseAnswers(row.answers_json)),
        ...(closing !== undefined ? { closing } : {}),
      });
    }
    if (reply !== null) {
      (pane.content.replyRequests ??= []).push({
        questionId,
        alias,
        requestedAt: reply.created_at,
      });
    }
    if (followUp) (pane.content.waitingFollowUps ??= []).push({ questionId, alias });
    if (attention) {
      const uncertain =
        (answerHeld && deliveryStatus === "delivery-uncertain") ||
        held.some((message) => message.delivery?.status === "delivery-uncertain");
      pane.content.needsAttention.push({
        questionId,
        alias,
        deliveryStatus: uncertain ? "delivery-uncertain" : "needs-attention",
        reason: reasonOf(answerHeld ? row.error_code : (held[0]!.delivery?.error_code ?? null)),
        // A timeout notice stands in the answer's place, as the list and the notification name it.
        subject: deliverySubject(
          answerHeld,
          held.length,
          answerHeld && heldTimeoutNotice(row) !== null
        ),
      });
    } else if (pending.length > 0 && !isAttention(deliveryStatus)) {
      pane.content.waitingAnswers.push({
        questionId,
        alias,
        // A notice that the question never reached the relay (0.9.0) is no answer, nor an expiry.
        kind: pending.some((entry) => entry.kind === "answer")
          ? "answer"
          : pending.some((entry) => entry.kind === "unpublished")
            ? "never-published"
            : "expired",
        deliveryStatus,
      });
    }
  }
  return panes;
}

function emptyContent(terminalId: string): PaneContent {
  return { terminalId, openQuestions: [], waitingAnswers: [], needsAttention: [] };
}

interface HeldPane {
  projectId: string;
  key: string;
  state: PaneDecisionState;
}

/**
 * Each pane's last published state, for one Decisions service. A pane is held
 * only while it has something outstanding; when it has nothing left its
 * views get one empty state and it is let go.
 *
 * Revisions only rise: the counter outlives `clear`, so a later lifetime
 * outranks a view's old snapshot, and it never falls behind the wall clock,
 * so a restarted process outranks its previous run too. A Shell's views
 * outlive a Remote Host's restart, and would otherwise refuse the new run's
 * pushes until it caught up with the old one's count.
 */
export class PaneDecisionStates {
  private readonly panes = new Map<string, HeldPane>();
  /** Open questions the person hasn't cleared, by terminal, as the last `replace` was told. */
  private questions: ReadonlyMap<string, number> = new Map();
  private revision = 0;

  constructor(
    private readonly publish: PaneDecisionStatePublisher,
    private readonly now: () => number = Date.now,
    private readonly publishAttention: AnswerAttentionPublisher = () => {}
  ) {}

  get(terminalId: string): PaneDecisionState | null {
    return this.panes.get(terminalId)?.state ?? null;
  }

  /**
   * Replaces every pane's state with what these rows show, `handled` the
   * answers a person marked handled and `closings` the withdrawals and
   * declines queued, pushing only the panes that changed. `questions` counts
   * each terminal's questions open in Needs you that the person hasn't
   * cleared, for the fleet alone: pane chrome doesn't show it.
   */
  replace(
    rows: readonly QuestionRow[],
    handled: HandledAnswers = new Map(),
    questions: ReadonlyMap<string, number> = new Map(),
    closings: PendingClosings = new Map()
  ): void {
    this.questions = questions;
    const next = projectPaneDecisionStates(rows, handled, closings);
    for (const [terminalId, held] of [...this.panes]) {
      if (next.get(terminalId)?.projectId === held.projectId) continue;
      this.panes.delete(terminalId);
      this.send(held.projectId, emptyContent(terminalId));
    }
    for (const [terminalId, { projectId, content }] of next) {
      const key = JSON.stringify(content);
      if (this.panes.get(terminalId)?.key === key) continue;
      this.panes.set(terminalId, { projectId, key, state: this.send(projectId, content) });
    }
    this.sendAttention();
  }

  /** Replaces the open question counts alone, as a deadline passing changes them. */
  setQuestions(questions: ReadonlyMap<string, number>): void {
    this.questions = questions;
    this.sendAttention();
  }

  /** Lets every pane go; with `notify`, each one's views first get an empty state. */
  clear(notify: boolean): void {
    const held = [...this.panes];
    this.panes.clear();
    this.questions = new Map();
    // Whatever happens to the views, no run keeps a count once the panes go.
    this.sendAttention();
    if (!notify) return;
    for (const [terminalId, { projectId }] of held) this.send(projectId, emptyContent(terminalId));
  }

  /**
   * Each terminal's answers needing a person and open questions, for the
   * fleet; best effort like `send`. A question can wait on a terminal no pane
   * is held for (a reply its agent asked for), and a clear changes no pane.
   */
  private sendAttention(): void {
    const counts = new Map<string, RunDecisionAttention>();
    for (const [terminalId, { state }] of this.panes) {
      const answers = state.needsAttention.length;
      if (answers > 0) counts.set(terminalId, { answers, questions: 0 });
    }
    for (const [terminalId, questions] of this.questions) {
      if (questions <= 0) continue;
      counts.set(terminalId, { answers: counts.get(terminalId)?.answers ?? 0, questions });
    }
    try {
      this.publishAttention(counts);
    } catch (err) {
      console.warn("[Decisions] An answer attention update failed:", err);
    }
  }

  /** Pane chrome is best effort: a failed push must never unwind a store write that caused it. */
  private send(projectId: string, content: PaneContent): PaneDecisionState {
    this.revision = Math.max(this.revision + 1, this.now());
    const state: PaneDecisionState = { ...content, revision: this.revision };
    try {
      this.publish(projectId, state);
    } catch (err) {
      console.warn("[Decisions] A pane state push failed:", err);
    }
    return state;
  }
}
