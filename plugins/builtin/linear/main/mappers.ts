import type { ForgeUser, Issue, NormalizedIssueState } from "../../../../shared/types/forge.js";

/** The issue fields every query in this plugin selects. */
export const ISSUE_FIELDS = `
  id
  identifier
  number
  title
  description
  url
  branchName
  createdAt
  updatedAt
  completedAt
  canceledAt
  state { name type }
  assignee { id name displayName avatarUrl }
  creator { id name displayName avatarUrl }
  labels { nodes { name color } }
`;

export interface LinearUserNode {
  id: string;
  name?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface LinearIssueNode {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description?: string | null;
  url: string;
  branchName?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  canceledAt?: string | null;
  state?: { name?: string | null; type?: string | null } | null;
  assignee?: LinearUserNode | null;
  creator?: LinearUserNode | null;
  labels?: { nodes?: Array<{ name: string; color?: string | null }> | null } | null;
}

/**
 * Workflow-state types Linear counts as finished. Anything else, including a
 * type added after this list was written, reads as open: an issue wrongly
 * shown as open is still pickable, one wrongly shown as closed disappears.
 */
export const CLOSED_STATE_TYPES = ["completed", "canceled", "duplicate"] as const;

export function normalizeIssueState(type: string | null | undefined): NormalizedIssueState {
  return (CLOSED_STATE_TYPES as readonly string[]).includes(type ?? "") ? "closed" : "open";
}

function toEpoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function mapUser(node: LinearUserNode): ForgeUser {
  return {
    // `displayName` is the short handle Linear shows in mentions; `name` the full one.
    login: node.displayName || node.name || node.id,
    ...(node.avatarUrl ? { avatarUrl: node.avatarUrl } : {}),
    rawData: { id: node.id },
  };
}

export function mapIssue(node: LinearIssueNode): Issue {
  const state = normalizeIssueState(node.state?.type);
  const closedAt =
    state === "closed" ? (toEpoch(node.completedAt) ?? toEpoch(node.canceledAt)) : null;
  return {
    number: node.number,
    title: node.title,
    body: node.description ?? "",
    state,
    rawState: node.state?.name ?? node.state?.type ?? "",
    url: node.url,
    ...(node.creator ? { author: mapUser(node.creator) } : {}),
    assignees: node.assignee ? [mapUser(node.assignee)] : [],
    labels: (node.labels?.nodes ?? []).map((label) => ({
      name: label.name,
      ...(label.color ? { color: label.color.replace(/^#/, "") } : {}),
    })),
    createdAt: toEpoch(node.createdAt) ?? 0,
    updatedAt: toEpoch(node.updatedAt) ?? 0,
    closedAt,
    id: node.id,
    key: node.identifier,
    ...(node.branchName ? { branchName: node.branchName } : {}),
    rawData: node,
  };
}
