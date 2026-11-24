import type {
  ForgeUser,
  Issue,
  IssueComment,
  NormalizedIssueState,
} from "../../../../shared/types/forge.js";
import { siteIdOf } from "../shared/connection.js";
import { adfToText } from "./adf.js";

/** Jira's search returns only ids unless the fields are named. */
export const ISSUE_FIELDS = [
  "summary",
  "description",
  "status",
  "assignee",
  "reporter",
  "labels",
  "created",
  "updated",
  "resolutiondate",
] as const;

const MAX_BRANCH_SLUG_LENGTH = 50;

/** Cloud users carry an `accountId`; Server and Data Center users a `name` and `key` instead. */
export interface JiraUserNode {
  accountId?: string | null;
  name?: string | null;
  key?: string | null;
  displayName?: string | null;
  emailAddress?: string | null;
  avatarUrls?: Record<string, string> | null;
}

export interface JiraIssueNode {
  id: string;
  key: string;
  fields?: {
    summary?: string | null;
    description?: unknown;
    status?: {
      name?: string | null;
      statusCategory?: { key?: string | null } | null;
    } | null;
    assignee?: JiraUserNode | null;
    reporter?: JiraUserNode | null;
    labels?: string[] | null;
    created?: string | null;
    updated?: string | null;
    resolutiondate?: string | null;
  } | null;
}

export interface JiraCommentNode {
  id: string;
  author?: JiraUserNode | null;
  body?: unknown;
  created?: string | null;
}

/**
 * Jira keeps every workflow's statuses in three categories, and only `done` is
 * finished. Anything else reads as open: an issue wrongly shown as open is still
 * pickable, one wrongly shown as closed disappears.
 */
export function normalizeIssueState(categoryKey: string | null | undefined): NormalizedIssueState {
  return categoryKey === "done" ? "closed" : "open";
}

function toEpoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** The number in `ENG-12`, which is what the issue flows address it by. */
export function issueNumberOf(key: string): number {
  return Number(/-(\d+)$/.exec(key)?.[1] ?? 0);
}

/**
 * `ENG-12-fix-the-login`, the form Jira's own Create branch offers. The key stays
 * upper-case: Jira only links a branch to an issue through the exact key.
 */
export function suggestBranchName(key: string, summary: string): string {
  const slug = summary
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return key;
  if (slug.length <= MAX_BRANCH_SLUG_LENGTH) return `${key}-${slug}`;
  const cut = slug.slice(0, MAX_BRANCH_SLUG_LENGTH);
  const lastBreak = cut.lastIndexOf("-");
  return `${key}-${lastBreak > 0 ? cut.slice(0, lastBreak) : cut}`;
}

/**
 * What Jira assigns a user by: the `accountId` on Cloud, the username (`name`)
 * on Server and Data Center. A site only ever sends the one it uses.
 */
export function userIdOf(node: JiraUserNode | null | undefined): string | null {
  return node?.accountId || node?.name || null;
}

/**
 * `login` is what the host compares to tell the viewer from another assignee.
 * A Server or Data Center username is unique and readable, so it's the login
 * there; a Cloud account id is neither, so Cloud keeps the display name.
 */
export function mapUser(node: JiraUserNode): ForgeUser {
  const avatarUrl = node.avatarUrls?.["48x48"];
  return {
    login: node.name || node.displayName || node.accountId || "Unknown",
    ...(avatarUrl ? { avatarUrl } : {}),
    rawData: { accountId: node.accountId ?? null, ...(node.name ? { name: node.name } : {}) },
  };
}

/**
 * The id a link stores: the site's base without its scheme, then Jira's own id
 * (`acme.atlassian.net/10042`, `jira.example.com:8443/jira/10042`). Jira's id is
 * only unique within a site, and a link prefers it to the key, so a bare `10042`
 * would open an unrelated issue after the connection moves to another site.
 */
export function stableIssueId(siteUrl: string, jiraId: string): string {
  return `${siteIdOf(siteUrl)}/${jiraId}`;
}

export function mapIssue(node: JiraIssueNode, siteUrl: string): Issue {
  const fields = node.fields ?? {};
  const state = normalizeIssueState(fields.status?.statusCategory?.key);
  const title = fields.summary ?? "";
  return {
    number: issueNumberOf(node.key),
    title,
    body: adfToText(fields.description),
    state,
    rawState: fields.status?.name ?? "",
    url: `${siteUrl}/browse/${node.key}`,
    ...(fields.reporter ? { author: mapUser(fields.reporter) } : {}),
    assignees: fields.assignee ? [mapUser(fields.assignee)] : [],
    labels: (fields.labels ?? []).map((name) => ({ name })),
    createdAt: toEpoch(fields.created) ?? 0,
    updatedAt: toEpoch(fields.updated) ?? 0,
    closedAt: state === "closed" ? toEpoch(fields.resolutiondate) : null,
    id: stableIssueId(siteUrl, node.id),
    key: node.key,
    branchName: suggestBranchName(node.key, title),
    // Not the node: a description's document tree can dwarf everything else here.
    rawData: { id: node.id, key: node.key },
  };
}

/** `issueKey` is the key Jira answered with, which a renamed project changes. */
export function mapComment(node: JiraCommentNode, siteUrl: string, issueKey: string): IssueComment {
  const id = String(node.id);
  return {
    id,
    body: adfToText(node.body),
    url: `${siteUrl}/browse/${issueKey}?focusedCommentId=${encodeURIComponent(id)}`,
    ...(node.author ? { author: mapUser(node.author) } : {}),
    createdAt: toEpoch(node.created) ?? 0,
    rawData: { id },
  };
}
