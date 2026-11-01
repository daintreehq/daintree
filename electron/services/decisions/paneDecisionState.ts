import { parseAnswers, type QuestionRow } from "@daintreehq/decisions-client";
import type {
  DecisionDeliveryStatus,
  PaneDecisionAttention,
  PaneDecisionState,
} from "../../../shared/types/decisions.js";

export type PaneDecisionStatePublisher = (projectId: string, state: PaneDecisionState) => void;

type PaneContent = Omit<PaneDecisionState, "revision">;

export interface ProjectedPane {
  projectId: string;
  content: PaneContent;
}

type AttentionStatus = PaneDecisionAttention["deliveryStatus"];

/**
 * The library's codes are short identifiers (`pane_gone`, `inject_ambiguous`).
 * Anything else is passed on as `unspecified` rather than trimmed into shape,
 * so free text can never reach a view through this field.
 */
const REASON_CODE = /^[a-z0-9_.-]{1,48}$/;

function reasonOf(code: string | null): string {
  return typeof code === "string" && REASON_CODE.test(code) ? code : "unspecified";
}

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
 *   without keeping it.
 * - **Waiting:** otherwise, an answer entry still marked for delivery and not
 *   yet delivered, the same test the delivery engine uses.
 *
 * Imported history is never delivered and shows nowhere. Rows are taken in
 * question order, and a pane belongs to the project of its newest question,
 * settled or not, so settling that question never moves the pane back.
 */
export function projectPaneDecisionStates(
  rows: readonly QuestionRow[]
): Map<string, ProjectedPane> {
  const sorted = [...rows].filter((row) => !row.history_only).sort(byAlias);
  const projectOf = new Map<string, string>();
  for (const { origin } of sorted) {
    if (origin.pane_id && origin.project_id) projectOf.set(origin.pane_id, origin.project_id);
  }

  const panes = new Map<string, ProjectedPane>();
  for (const row of sorted) {
    const paneId = row.origin.pane_id;
    const projectId = projectOf.get(paneId);
    if (!paneId || !projectId) continue;

    const deliveryStatus: DecisionDeliveryStatus = row.delivery_status;
    const open = row.local_status === "queued" || row.local_status === "open";
    const attention = isAttention(deliveryStatus);
    const pending = attention
      ? []
      : parseAnswers(row.answers_json).filter((entry) => entry.deliver && !entry.delivered);
    if (!open && !attention && pending.length === 0) continue;

    let pane = panes.get(paneId);
    if (!pane) {
      pane = { projectId, content: emptyContent(paneId) };
      panes.set(paneId, pane);
    }

    const { question_id: questionId, alias } = row;
    if (row.local_status === "queued" || row.local_status === "open") {
      pane.content.openQuestions.push({
        questionId,
        alias,
        status: row.local_status,
        askedAt: row.origin_created_at,
        expiresAt: row.expires_at ?? null,
      });
    }
    if (isAttention(deliveryStatus)) {
      pane.content.needsAttention.push({
        questionId,
        alias,
        deliveryStatus,
        reason: reasonOf(row.error_code),
      });
    } else if (pending.length > 0) {
      pane.content.waitingAnswers.push({
        questionId,
        alias,
        kind: pending.some((entry) => entry.kind !== "expired") ? "answer" : "expired",
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
  private revision = 0;

  constructor(
    private readonly publish: PaneDecisionStatePublisher,
    private readonly now: () => number = Date.now
  ) {}

  get(terminalId: string): PaneDecisionState | null {
    return this.panes.get(terminalId)?.state ?? null;
  }

  /** Replaces every pane's state with what these rows show, pushing only the panes that changed. */
  replace(rows: readonly QuestionRow[]): void {
    const next = projectPaneDecisionStates(rows);
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
  }

  /** Lets every pane go; with `notify`, each one's views first get an empty state. */
  clear(notify: boolean): void {
    const held = [...this.panes];
    this.panes.clear();
    if (!notify) return;
    for (const [terminalId, { projectId }] of held) this.send(projectId, emptyContent(terminalId));
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
