import type {
  CIStatusState,
  ForgeLabel,
  ForgeUser,
  Issue,
  IssueComment,
  IssueTooltipData,
  ListOptions,
  NormalizedIssueState,
  NormalizedPRState,
  PR,
  PRTooltipData,
  Release,
} from "../../../../shared/types/forge.js";
import type {
  GitLabIssue,
  GitLabMergeRequest,
  GitLabNote,
  GitLabRelease,
  GitLabUser,
} from "../shared/types.js";
import { repoWebUrl } from "./gitlabRemote.js";

const TOOLTIP_EXCERPT_MAX = 280;

export function isoToMs(value: unknown): number {
  if (typeof value !== "string") return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

export function isoToMsOrNull(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Self-hosted GitLab returns upload-backed avatars as host-relative paths
 * (`/uploads/-/system/...`); prefix the instance so the renderer can load them.
 */
export function absolutizeAvatarUrl(avatarUrl: unknown, host: string): string | undefined {
  if (typeof avatarUrl !== "string" || avatarUrl.length === 0) return undefined;
  if (/^https?:\/\//i.test(avatarUrl)) return avatarUrl;
  return avatarUrl.startsWith("/") ? `https://${host}${avatarUrl}` : undefined;
}

export function gitlabUserToForgeUser(
  user: GitLabUser | null | undefined,
  host: string
): ForgeUser | undefined {
  if (!user || typeof user.username !== "string" || user.username.length === 0) return undefined;
  const avatarUrl = absolutizeAvatarUrl(user.avatar_url, host);
  return {
    login: user.username,
    ...(avatarUrl ? { avatarUrl } : {}),
    rawData: user,
  };
}

function gitlabUsersToForgeUsers(
  users: GitLabUser[] | null | undefined,
  host: string
): ForgeUser[] {
  if (!Array.isArray(users)) return [];
  return users
    .map((u) => gitlabUserToForgeUser(u, host))
    .filter((u): u is ForgeUser => u !== undefined);
}

/** Issue/MR payloads carry labels as plain name strings — no colors. */
export function gitlabLabelsToForgeLabels(labels: unknown): ForgeLabel[] {
  if (!Array.isArray(labels)) return [];
  return labels.filter((l): l is string => typeof l === "string").map((name) => ({ name }));
}

export function normalizeGitLabIssueState(rawState: string): NormalizedIssueState {
  return rawState.toLowerCase() === "closed" ? "closed" : "open";
}

/**
 * GitLab MR states: `opened | closed | locked | merged`. `locked` is the
 * transient mid-merge state, so it normalizes to `open`; `rawState` preserves
 * the verbatim value for anything that needs the distinction.
 */
export function normalizeGitLabMRState(rawState: string): NormalizedPRState {
  const lower = rawState.toLowerCase();
  if (lower === "merged") return "merged";
  if (lower === "closed") return "closed";
  return "open";
}

/**
 * Draft detection across GitLab versions: the boolean `draft` field is
 * current, `work_in_progress` predates it, and very old self-managed
 * instances only carry the title convention (`Draft:`/`[Draft]`/`WIP:`).
 */
export function isDraftMergeRequest(
  mr: Pick<GitLabMergeRequest, "draft" | "work_in_progress" | "title">
): boolean {
  if (mr.draft === true || mr.work_in_progress === true) return true;
  return isDraftTitle(mr.title ?? "");
}

export function isDraftTitle(title: string): boolean {
  return /^\s*(?:\[draft\]|\(draft\)|draft:|\[wip\]|\(wip\)|wip:)/i.test(title);
}

/** Strip every GitLab-recognized draft/WIP prefix from an MR title. */
export function stripDraftPrefix(title: string): string {
  let result = title;
  const prefix = /^\s*(?:\[draft\]|\(draft\)|draft:|\[wip\]|\(wip\)|wip:)\s*/i;
  while (prefix.test(result)) {
    result = result.replace(prefix, "");
  }
  return result.trim();
}

/**
 * Pipeline status → forge CI roll-up. GitLab reports a single head-pipeline
 * status rather than per-check counts, so the roll-up is that status folded
 * into the shared vocabulary: user-interrupted and blocked states are
 * `neutral` (not failures), everything in flight is `pending`.
 */
export function pipelineStatusToCIState(status: unknown): CIStatusState | undefined {
  if (typeof status !== "string") return undefined;
  switch (status.toLowerCase()) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "canceled":
    case "canceling":
    case "skipped":
    case "manual":
      return "neutral";
    case "created":
    case "waiting_for_resource":
    case "waiting_for_callback":
    case "preparing":
    case "pending":
    case "running":
    case "scheduled":
      return "pending";
    default:
      return "unknown";
  }
}

/**
 * Mergeability from the modern `detailed_merge_status` when present, falling
 * back to `has_conflicts`. `null` when GitLab hasn't computed it (matching
 * the contract's "not computed yet" meaning).
 */
function mergeableFromMR(mr: GitLabMergeRequest): boolean | null {
  if (typeof mr.detailed_merge_status === "string") {
    if (mr.detailed_merge_status === "mergeable") return true;
    if (
      mr.detailed_merge_status === "checking" ||
      mr.detailed_merge_status === "unchecked" ||
      mr.detailed_merge_status === "preparing"
    ) {
      return null;
    }
    return false;
  }
  if (mr.has_conflicts === true) return false;
  return null;
}

/** Map a REST merge-request payload onto the contract PR (numbering by `iid`). */
export function mergeRequestToForgePR(mr: GitLabMergeRequest, host: string): PR {
  const rawState = typeof mr.state === "string" ? mr.state : "opened";
  const merged = rawState.toLowerCase() === "merged" || typeof mr.merged_at === "string";
  const ciStatus = pipelineStatusToCIState(mr.head_pipeline?.status);
  const author = gitlabUserToForgeUser(mr.author, host);
  return {
    number: mr.iid ?? 0,
    title: mr.title ?? "",
    body: mr.description ?? "",
    state: merged ? "merged" : normalizeGitLabMRState(rawState),
    rawState,
    isDraft: isDraftMergeRequest(mr),
    merged,
    url: mr.web_url ?? "",
    ...(author ? { author } : {}),
    baseRef: mr.target_branch ?? "",
    headRef: mr.source_branch ?? "",
    mergeable: mergeableFromMR(mr),
    ...(typeof mr.user_notes_count === "number" ? { commentCount: mr.user_notes_count } : {}),
    ...(ciStatus && ciStatus !== "unknown" ? { ciStatus } : {}),
    createdAt: isoToMs(mr.created_at ?? mr.updated_at),
    updatedAt: isoToMs(mr.updated_at),
    closedAt: isoToMsOrNull(mr.closed_at),
    mergedAt: isoToMsOrNull(mr.merged_at),
    rawData: mr,
  };
}

/** Map a REST issue payload onto the contract Issue (numbering by `iid`). */
export function gitlabIssueToForgeIssue(issue: GitLabIssue, host: string): Issue {
  const rawState = typeof issue.state === "string" ? issue.state : "opened";
  const author = gitlabUserToForgeUser(issue.author, host);
  return {
    number: issue.iid ?? 0,
    title: issue.title ?? "",
    body: issue.description ?? "",
    state: normalizeGitLabIssueState(rawState),
    rawState,
    url: issue.web_url ?? "",
    ...(author ? { author } : {}),
    assignees: gitlabUsersToForgeUsers(issue.assignees, host),
    labels: gitlabLabelsToForgeLabels(issue.labels),
    ...(typeof issue.user_notes_count === "number" ? { commentCount: issue.user_notes_count } : {}),
    createdAt: isoToMs(issue.created_at ?? issue.updated_at),
    updatedAt: isoToMs(issue.updated_at),
    closedAt: isoToMsOrNull(issue.closed_at),
    rawData: issue,
  };
}

function truncateExcerpt(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= TOOLTIP_EXCERPT_MAX) return trimmed;
  return `${trimmed.slice(0, TOOLTIP_EXCERPT_MAX)}…`;
}

export function issueToTooltipData(issue: Issue): IssueTooltipData {
  return {
    number: issue.number,
    title: issue.title,
    bodyExcerpt: truncateExcerpt(issue.body),
    state: issue.state,
    rawState: issue.rawState,
    createdAt: issue.createdAt,
    ...(issue.author ? { author: issue.author } : {}),
    assignees: issue.assignees,
    labels: issue.labels,
  };
}

export function prToTooltipData(pr: PR, host: string): PRTooltipData {
  // Tooltips are built from the REST single-MR fetch, whose payload rides on
  // `rawData` and carries assignees/labels the PR contract itself doesn't
  // model. Read them defensively so a non-REST rawData shape degrades to
  // empty arrays instead of throwing.
  const raw = (pr.rawData ?? null) as GitLabMergeRequest | null;
  const assignees = Array.isArray(raw?.assignees)
    ? raw.assignees
        .map((a) => gitlabUserToForgeUser(a, host))
        .filter((u): u is NonNullable<typeof u> => u !== undefined)
    : [];
  return {
    number: pr.number,
    title: pr.title,
    bodyExcerpt: truncateExcerpt(pr.body),
    state: pr.state,
    rawState: pr.rawState,
    isDraft: pr.isDraft,
    createdAt: pr.createdAt,
    ...(pr.author ? { author: pr.author } : {}),
    assignees,
    labels: gitlabLabelsToForgeLabels(raw?.labels),
  };
}

/**
 * Map a REST release payload. GitLab has no draft releases; `upcoming_release`
 * marks a future-dated release, the closest analogue to a prerelease flag.
 */
export function gitlabReleaseToForgeRelease(
  release: GitLabRelease,
  repo: { host: string; owner: string; repo: string }
): Release {
  const tagName = release.tag_name ?? "";
  const publishedAt = isoToMsOrNull(release.released_at);
  return {
    id: tagName,
    tagName,
    name: release.name ?? tagName,
    body: release.description ?? "",
    isDraft: false,
    isPrerelease: release.upcoming_release === true,
    url:
      typeof release._links?.self === "string" && release._links.self.length > 0
        ? release._links.self
        : `${repoWebUrl(repo)}/-/releases/${encodeURIComponent(tagName)}`,
    publishedAt,
    createdAt: isoToMs(release.created_at ?? release.released_at),
    rawData: release,
  };
}

/** Map a REST note (comment) created on an issue. Notes carry no web URL, so build the anchor. */
export function gitlabNoteToIssueComment(
  note: GitLabNote,
  issueUrl: string,
  host: string
): IssueComment {
  const author = gitlabUserToForgeUser(note.author, host);
  return {
    id: String(note.id ?? ""),
    body: note.body ?? "",
    url: note.id != null ? `${issueUrl}#note_${note.id}` : issueUrl,
    ...(author ? { author } : {}),
    createdAt: isoToMs(note.created_at),
    rawData: note,
  };
}

/** Contract list state → GitLab REST `state` filter for issues. */
export function mapIssueListState(state: ListOptions["state"]): string | undefined {
  if (state === "closed") return "closed";
  if (state === "all") return undefined;
  // "merged" is PR-only; issues treat it as the default open set.
  return "opened";
}

/** Contract list state → GitLab REST `state` filter for merge requests. */
export function mapMRListState(state: ListOptions["state"]): string | undefined {
  if (state === "closed") return "closed";
  if (state === "merged") return "merged";
  if (state === "all") return undefined;
  return "opened";
}

/** Contract sort key → GitLab `order_by`. Unknown keys fall back to created. */
export function mapListOrderBy(sort: string | undefined): string {
  if (sort === "updated" || sort === "updated_at") return "updated_at";
  return "created_at";
}

/**
 * GraphQL merge-request node (camelCase, string `iid`) → contract PR. Used by
 * the batched branch→MR lookup; the REST mapper handles everything else.
 */
export function graphqlMergeRequestToForgePR(
  node: Record<string, unknown>,
  host: string
): PR | null {
  const iid = Number.parseInt(String(node.iid ?? ""), 10);
  if (!Number.isFinite(iid) || iid <= 0) return null;
  const rawState = typeof node.state === "string" ? node.state : "opened";
  const merged = rawState.toLowerCase() === "merged" || typeof node.mergedAt === "string";
  const author = node.author as { username?: unknown; avatarUrl?: unknown } | null | undefined;
  const authorUser: ForgeUser | undefined =
    author && typeof author.username === "string" && author.username.length > 0
      ? {
          login: author.username,
          ...(absolutizeAvatarUrl(author.avatarUrl, host)
            ? { avatarUrl: absolutizeAvatarUrl(author.avatarUrl, host) }
            : {}),
          rawData: author,
        }
      : undefined;
  const headPipeline = node.headPipeline as { status?: unknown } | null | undefined;
  const ciStatus = pipelineStatusToCIState(
    typeof headPipeline?.status === "string" ? headPipeline.status.toLowerCase() : undefined
  );
  const title = typeof node.title === "string" ? node.title : "";
  return {
    number: iid,
    title,
    body: typeof node.description === "string" ? node.description : "",
    state: merged ? "merged" : normalizeGitLabMRState(rawState),
    rawState,
    isDraft: node.draft === true || isDraftTitle(title),
    merged,
    url: typeof node.webUrl === "string" ? node.webUrl : "",
    ...(authorUser ? { author: authorUser } : {}),
    baseRef: typeof node.targetBranch === "string" ? node.targetBranch : "",
    headRef: typeof node.sourceBranch === "string" ? node.sourceBranch : "",
    mergeable: null,
    ...(ciStatus && ciStatus !== "unknown" ? { ciStatus } : {}),
    createdAt: isoToMs(node.createdAt ?? node.updatedAt),
    updatedAt: isoToMs(node.updatedAt),
    closedAt: isoToMsOrNull(node.closedAt),
    mergedAt: isoToMsOrNull(node.mergedAt),
    rawData: node,
  };
}
