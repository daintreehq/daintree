import type {
  ForgeLabel,
  ForgeUser,
  Issue,
  IssueComment,
  NormalizedIssueState,
} from "../../../../shared/types/forge.js";
import { beadNumber } from "./issueNumbers.js";

/**
 * The bead fields this provider reads. Every other member, including the
 * Beads-only ones (priority, type, dependencies), rides through in `rawData`.
 */
export interface BeadNode {
  id: string;
  title: string;
  description?: string | null;
  status?: string | null;
  assignee?: string | null;
  created_by?: string | null;
  labels?: string[] | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  comment_count?: number | null;
  [member: string]: unknown;
}

export interface BeadComment {
  id: string;
  issue_id: string;
  author: string;
  text: string;
  created_at: string;
}

export const BRANCH_PREFIX = "bead/";

/**
 * Only `closed` reads as closed. A workspace's custom statuses aren't known
 * here, and one wrongly shown as open stays pickable where one wrongly shown
 * as closed would disappear; `bd serve`'s default listing already leaves out
 * the custom done and frozen ones.
 */
export function normalizeBeadState(status: string | null | undefined): NormalizedIssueState {
  return status === "closed" ? "closed" : "open";
}

function toEpoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function mapActor(actor: string): ForgeUser {
  return { login: actor, rawData: { actor } };
}

export function mapLabels(labels: string[] | null | undefined): ForgeLabel[] {
  return (labels ?? []).map((name) => ({ name }));
}

/**
 * `id` and `key` are both the bead id, so every link the host stores names
 * the bead itself. `url` stays empty: `bd serve` has no page to open.
 */
export function mapBead(node: BeadNode): Issue {
  const state = normalizeBeadState(node.status);
  return {
    number: beadNumber(node.id),
    title: node.title,
    body: node.description ?? "",
    state,
    rawState: node.status ?? "",
    url: "",
    ...(node.created_by ? { author: mapActor(node.created_by) } : {}),
    assignees: node.assignee ? [mapActor(node.assignee)] : [],
    labels: mapLabels(node.labels),
    ...(typeof node.comment_count === "number" ? { commentCount: node.comment_count } : {}),
    createdAt: toEpoch(node.created_at) ?? 0,
    updatedAt: toEpoch(node.updated_at) ?? 0,
    closedAt: state === "closed" ? toEpoch(node.closed_at) : null,
    id: node.id,
    key: node.id,
    branchName: `${BRANCH_PREFIX}${node.id}`,
    rawData: node,
  };
}

export function mapComment(comment: BeadComment): IssueComment {
  return {
    id: comment.id,
    body: comment.text,
    url: "",
    ...(comment.author ? { author: mapActor(comment.author) } : {}),
    createdAt: toEpoch(comment.created_at) ?? 0,
    rawData: comment,
  };
}
