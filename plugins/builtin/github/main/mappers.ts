import type {
  CIStatusState,
  ForgeLabel,
  ForgeUser,
  Issue,
  IssueComment,
  LinkedPRSummary,
  ListOptions,
  NormalizedIssueState,
  NormalizedPRState,
  NormalizedReviewDecision,
  NormalizedReviewState,
  PR,
  PullRequestReview,
} from "../../../../shared/types/forge.js";
import type {
  GitHubIssue,
  GitHubPR,
  GitHubPRCIStatus,
  GitHubUser,
  LinkedPRInfo,
} from "../shared/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isoToMs(value: unknown): number {
  if (typeof value !== "string") return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function isoToMsOrNull(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function toForgeUser(node: unknown): ForgeUser | undefined {
  if (!node || typeof node !== "object") return undefined;
  const n = node as { login?: unknown; avatarUrl?: unknown };
  if (typeof n.login !== "string") return undefined;
  return {
    login: n.login,
    ...(typeof n.avatarUrl === "string" ? { avatarUrl: n.avatarUrl } : {}),
    rawData: node,
  };
}

function toForgeUsers(node: unknown): ForgeUser[] {
  const nodes = (node as { nodes?: unknown[] } | undefined)?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.map(toForgeUser).filter((u): u is ForgeUser => u !== undefined);
}

function toForgeLabels(node: unknown): ForgeLabel[] {
  const nodes = (node as { nodes?: unknown[] } | undefined)?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: ForgeLabel[] = [];
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const label = n as { name?: unknown; color?: unknown };
    if (typeof label.name !== "string") continue;
    out.push({
      name: label.name,
      ...(typeof label.color === "string" ? { color: label.color } : {}),
    });
  }
  return out;
}

function normalizeIssueState(rawState: string): NormalizedIssueState {
  return rawState.toUpperCase() === "CLOSED" ? "closed" : "open";
}

function normalizePRState(rawState: string, merged: boolean): NormalizedPRState {
  if (merged) return "merged";
  const upper = rawState.toUpperCase();
  if (upper === "CLOSED") return "closed";
  if (upper === "MERGED") return "merged";
  return "open";
}

/**
 * Pick the PR an issue is "being worked on" by from a GraphQL
 * `timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT])`
 * selection. `CrossReferencedEvent` carries the PR under `source`,
 * `ConnectedEvent` under `subject`; both shapes are read, deduped by PR number,
 * and the freshest (most recently updated, then highest-numbered) one wins.
 *
 * Lives here rather than in `GitHubIssues.ts` so both mapper families can share
 * one implementation — `mappers.ts` is a leaf module, so importing it drags in
 * no auth/cache/query machinery. Takes `unknown` and narrows structurally: the
 * callers hold raw GraphQL nodes, and a malformed timeline must degrade to "no
 * linked PR" rather than throw inside a list mapper.
 */
export function extractLinkedPR(timelineItems: unknown): LinkedPRInfo | undefined {
  if (!isRecord(timelineItems)) return undefined;
  const nodes = timelineItems.nodes;
  if (!Array.isArray(nodes)) return undefined;

  const prs: LinkedPRInfo[] = [];
  const seenPRNumbers = new Set<number>();

  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const prData = isRecord(node.source)
      ? node.source
      : isRecord(node.subject)
        ? node.subject
        : undefined;
    if (!prData) continue;

    // A PR needs a usable number AND url to be actionable, so anything short of
    // a real positive integer and a non-empty url is treated as "no linked PR"
    // rather than emitted as a half-formed reference.
    const number = prData.number;
    const url = prData.url;
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) continue;
    if (typeof url !== "string" || url.length === 0) continue;
    if (seenPRNumbers.has(number)) continue;
    seenPRNumbers.add(number);

    const rawState = typeof prData.state === "string" ? prData.state.toUpperCase() : "";
    const state: LinkedPRInfo["state"] =
      prData.merged === true ? "MERGED" : rawState === "CLOSED" ? "CLOSED" : "OPEN";

    prs.push({
      number,
      state,
      url,
      ...(typeof prData.updatedAt === "string" ? { updatedAt: prData.updatedAt } : {}),
    });
  }

  if (prs.length === 0) return undefined;
  prs.sort(compareLinkedPRFreshness);
  return prs[0];
}

function compareLinkedPRFreshness(a: LinkedPRInfo, b: LinkedPRInfo): number {
  const aParsed = typeof a.updatedAt === "string" ? Date.parse(a.updatedAt) : 0;
  const bParsed = typeof b.updatedAt === "string" ? Date.parse(b.updatedAt) : 0;
  const aTime = Number.isFinite(aParsed) ? aParsed : 0;
  const bTime = Number.isFinite(bParsed) ? bParsed : 0;
  if (aTime !== bTime) return bTime - aTime;
  return b.number - a.number;
}

/**
 * Narrow a {@link LinkedPRInfo} (GitHub-shaped, raw `OPEN|CLOSED|MERGED`) to the
 * cross-provider {@link LinkedPRSummary} the forge `Issue` contract declares.
 */
function toLinkedPRSummary(linked: LinkedPRInfo | undefined): LinkedPRSummary | undefined {
  if (!linked) return undefined;
  const ciStatus = mapListCIStatus(linked.ciStatus);
  return {
    number: linked.number,
    state: normalizePRState(linked.state, linked.state === "MERGED"),
    url: linked.url,
    ...(ciStatus ? { ciStatus } : {}),
  };
}

export function toForgeIssue(node: Record<string, unknown>): Issue {
  const rawState = typeof node.state === "string" ? node.state : "OPEN";
  const comments = node.comments as { totalCount?: unknown } | undefined;
  const commentCount = typeof comments?.totalCount === "number" ? comments.totalCount : undefined;
  // `timelineItems` is selected by LIST_ISSUES_QUERY, SEARCH_QUERY and
  // GET_ISSUE_QUERY. Queries that don't project it yield `undefined` here,
  // which is the same "no linked PR" answer as an empty timeline (#11527).
  const linkedPR = toLinkedPRSummary(extractLinkedPR(node.timelineItems));
  return {
    number: node.number as number,
    title: (node.title as string) ?? "",
    body: (node.bodyText as string) ?? "",
    state: normalizeIssueState(rawState),
    rawState,
    url: (node.url as string) ?? "",
    author: toForgeUser(node.author),
    assignees: toForgeUsers(node.assignees),
    labels: toForgeLabels(node.labels),
    ...(commentCount !== undefined ? { commentCount } : {}),
    ...(linkedPR ? { linkedPR } : {}),
    createdAt: isoToMs(node.createdAt ?? node.updatedAt),
    updatedAt: isoToMs(node.updatedAt),
    closedAt: isoToMsOrNull(node.closedAt),
    rawData: node,
  };
}

/**
 * GraphQL `IssueComment` node → normalized {@link IssueComment}. `databaseId`
 * is GitHub's REST numeric id, stringified so it matches what the REST write
 * path (`addIssueCommentImpl`) returns for the same comment — the two ids stay
 * interchangeable for any later edit/delete.
 *
 * Falls back to the GraphQL node id when `databaseId` is missing or not a
 * finite number, so `id` is always something that identifies the comment. An
 * empty-string id would silently collide across every degraded node and make
 * two different comments look like one.
 */
export function toForgeIssueComment(node: Record<string, unknown>): IssueComment {
  const author = toForgeUser(node.author);
  const databaseId =
    typeof node.databaseId === "number" && Number.isFinite(node.databaseId)
      ? String(node.databaseId)
      : undefined;
  return {
    id: databaseId ?? (typeof node.id === "string" ? node.id : ""),
    body: typeof node.body === "string" ? node.body : "",
    url: typeof node.url === "string" ? node.url : "",
    ...(author ? { author } : {}),
    createdAt: isoToMs(node.createdAt),
    rawData: node,
  };
}

/**
 * Map a GitHub REST user object ({@link https://docs.github.com/en/rest/issues})
 * to a {@link ForgeUser}. REST uses `avatar_url` where the GraphQL projection
 * (consumed by {@link toForgeUser}) uses `avatarUrl`, so REST responses need
 * their own mapper.
 */
export function restUserToForgeUser(node: unknown): ForgeUser | undefined {
  if (!node || typeof node !== "object") return undefined;
  const n = node as { login?: unknown; avatar_url?: unknown };
  if (typeof n.login !== "string") return undefined;
  return {
    login: n.login,
    ...(typeof n.avatar_url === "string" ? { avatarUrl: n.avatar_url } : {}),
    rawData: node,
  };
}

/**
 * Normalize a GitHub REST issue payload (e.g. the `POST .../issues` create
 * response) to the contract {@link Issue}. The REST field names diverge from
 * the GraphQL ones {@link toForgeIssue} handles — `html_url` vs `url`, `body`
 * vs `bodyText`, snake_case timestamps, and flat `labels`/`assignees` arrays
 * rather than `{ nodes: [...] }` connections — so a dedicated mapper is needed.
 */
export function restToForgeIssue(raw: Record<string, unknown>): Issue {
  const rawState = typeof raw.state === "string" ? raw.state : "open";
  const assignees = Array.isArray(raw.assignees)
    ? raw.assignees.map(restUserToForgeUser).filter((u): u is ForgeUser => u !== undefined)
    : [];
  const labels: ForgeLabel[] = [];
  if (Array.isArray(raw.labels)) {
    for (const entry of raw.labels) {
      if (typeof entry === "string") {
        labels.push({ name: entry });
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const label = entry as { name?: unknown; color?: unknown };
      if (typeof label.name !== "string") continue;
      labels.push({
        name: label.name,
        ...(typeof label.color === "string" ? { color: label.color } : {}),
      });
    }
  }
  return {
    number: raw.number as number,
    title: typeof raw.title === "string" ? raw.title : "",
    body: typeof raw.body === "string" ? raw.body : "",
    state: normalizeIssueState(rawState),
    rawState,
    url: typeof raw.html_url === "string" ? raw.html_url : "",
    author: restUserToForgeUser(raw.user),
    assignees,
    labels,
    createdAt: isoToMs(raw.created_at ?? raw.updated_at),
    updatedAt: isoToMs(raw.updated_at),
    closedAt: isoToMsOrNull(raw.closed_at),
    rawData: raw,
  };
}

/**
 * Normalize a GitHub REST pull-request payload (the `POST .../pulls` create and
 * `PATCH .../pulls/{n}` edit responses) to the contract {@link PR}. REST field
 * names diverge from the GraphQL projection {@link toForgePR} handles — `body`
 * vs `bodyText`, `draft` vs `isDraft`, snake_case timestamps, nested
 * `base.ref`/`head.ref` rather than `baseRefName`/`headRefName` — so a dedicated
 * mapper is needed.
 */
export function restToForgePR(raw: Record<string, unknown>): PR {
  const merged = raw.merged === true || typeof raw.merged_at === "string";
  const rawState = typeof raw.state === "string" ? raw.state : "open";
  const base = raw.base as { ref?: unknown } | undefined;
  const head = raw.head as { ref?: unknown } | undefined;
  const mergeable = typeof raw.mergeable === "boolean" ? raw.mergeable : null;
  return {
    number: raw.number as number,
    title: typeof raw.title === "string" ? raw.title : "",
    body: typeof raw.body === "string" ? raw.body : "",
    state: normalizePRState(rawState, merged),
    rawState,
    isDraft: raw.draft === true,
    merged,
    url: typeof raw.html_url === "string" ? raw.html_url : "",
    author: restUserToForgeUser(raw.user),
    baseRef: typeof base?.ref === "string" ? base.ref : "",
    headRef: typeof head?.ref === "string" ? head.ref : "",
    mergeable,
    createdAt: isoToMs(raw.created_at ?? raw.updated_at),
    updatedAt: isoToMs(raw.updated_at),
    closedAt: isoToMsOrNull(raw.closed_at),
    mergedAt: isoToMsOrNull(raw.merged_at),
    rawData: raw,
  };
}

function normalizeReviewState(rawState: string): NormalizedReviewState {
  switch (rawState.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
      return "dismissed";
    case "PENDING":
      return "pending";
    default:
      return "unknown";
  }
}

/**
 * Map a GitHub REST review payload (the body returned by the submit-review and
 * dismiss-review endpoints) to the contract {@link PullRequestReview}. GitHub
 * ids are numeric; the contract keeps them as strings so non-numeric forges fit.
 */
export function restToForgeReview(raw: Record<string, unknown>): PullRequestReview {
  const rawState = typeof raw.state === "string" ? raw.state : "";
  return {
    id: String(raw.id),
    state: normalizeReviewState(rawState),
    rawState,
    body: typeof raw.body === "string" ? raw.body : "",
    url: typeof raw.html_url === "string" ? raw.html_url : "",
    author: restUserToForgeUser(raw.user),
    submittedAt: isoToMsOrNull(raw.submitted_at),
    commitId: typeof raw.commit_id === "string" ? raw.commit_id : null,
    rawData: raw,
  };
}

/**
 * Map a GitHub REST label array (the body returned by the add/remove-label
 * endpoints) to the contract {@link ForgeLabel}[]. Entries without a string
 * `name` are skipped.
 */
export function restToForgeLabels(raw: unknown): ForgeLabel[] {
  if (!Array.isArray(raw)) return [];
  const labels: ForgeLabel[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const label = entry as { name?: unknown; color?: unknown };
    if (typeof label.name !== "string") continue;
    labels.push({
      name: label.name,
      ...(typeof label.color === "string" ? { color: label.color } : {}),
    });
  }
  return labels;
}

export function toForgePR(node: Record<string, unknown>): PR {
  const merged = node.merged === true;
  const rawState = typeof node.state === "string" ? node.state : "OPEN";
  const commits = node.commits as
    | { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: unknown } | null } | null }> }
    | undefined;
  const rollupState = commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  const ciStatus = mapListCIStatus(
    typeof rollupState === "string" ? (rollupState as GitHubPRCIStatus) : undefined
  );
  const comments = node.comments as { totalCount?: unknown } | undefined;
  const commentCount = typeof comments?.totalCount === "number" ? comments.totalCount : undefined;
  return {
    number: node.number as number,
    title: (node.title as string) ?? "",
    body: (node.bodyText as string) ?? "",
    state: normalizePRState(rawState, merged),
    rawState,
    isDraft: node.isDraft === true,
    merged,
    url: (node.url as string) ?? "",
    author: toForgeUser(node.author),
    baseRef: (node.baseRefName as string) ?? "",
    headRef: (node.headRefName as string) ?? "",
    mergeable: undefined,
    reviewDecision: node.reviewDecision as NormalizedReviewDecision | undefined,
    ...(commentCount !== undefined ? { commentCount } : {}),
    ...(ciStatus ? { ciStatus } : {}),
    createdAt: isoToMs(node.createdAt ?? node.updatedAt),
    updatedAt: isoToMs(node.updatedAt),
    closedAt: isoToMsOrNull(node.closedAt),
    mergedAt: isoToMsOrNull(node.mergedAt),
    rawData: node,
  };
}

/**
 * GitHub list-shape CI roll-up → forge {@link CIStatusState}. `ERROR` folds
 * into `failure` and `EXPECTED` into `pending` — the forge set is boolean-ish
 * by design. `undefined` when the list shape carried no roll-up.
 */
function mapListCIStatus(raw: GitHubPRCIStatus | undefined): CIStatusState | undefined {
  if (raw === "SUCCESS") return "success";
  if (raw === "FAILURE" || raw === "ERROR") return "failure";
  if (raw === "PENDING" || raw === "EXPECTED") return "pending";
  return undefined;
}

function gitHubUserToForgeUser(user: GitHubUser): ForgeUser {
  return { login: user.login, avatarUrl: user.avatarUrl, rawData: null };
}

/**
 * Map a legacy {@link GitHubIssue} list item (the stats first-page shape) to
 * the contract {@link Issue}. The list shape carries no `body`/`createdAt`, so
 * `body` falls back to `""` and `createdAt` to the item's `updatedAt` —
 * matching {@link toForgeIssue}'s `createdAt ?? updatedAt` fallback.
 */
export function gitHubIssueToForgeIssue(item: GitHubIssue): Issue {
  const updatedAt = isoToMs(item.updatedAt);
  const linkedPR = toLinkedPRSummary(item.linkedPR);
  return {
    number: item.number,
    title: item.title,
    body: "",
    state: normalizeIssueState(item.state),
    rawState: item.state,
    url: item.url,
    author: gitHubUserToForgeUser(item.author),
    assignees: item.assignees.map(gitHubUserToForgeUser),
    labels: (item.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    commentCount: item.commentCount,
    ...(linkedPR ? { linkedPR } : {}),
    createdAt: updatedAt,
    updatedAt,
    rawData: item,
  };
}

/**
 * Map a legacy {@link GitHubPR} list item (the stats first-page shape) to the
 * contract {@link PR}. Same `body`/`createdAt` fallbacks as
 * {@link gitHubIssueToForgeIssue}; `baseRef` is absent from the list shape and
 * falls back to `""`.
 */
export function gitHubPRToForgePR(item: GitHubPR): PR {
  const updatedAt = isoToMs(item.updatedAt);
  const merged = item.state === "MERGED";
  const ciStatus = mapListCIStatus(item.ciStatus);
  return {
    number: item.number,
    title: item.title,
    body: item.bodyText ?? "",
    state: normalizePRState(item.state, merged),
    rawState: item.state,
    isDraft: item.isDraft,
    merged,
    url: item.url,
    author: gitHubUserToForgeUser(item.author),
    baseRef: "",
    headRef: item.headRefName ?? "",
    mergeable: undefined,
    reviewDecision: item.reviewDecision,
    ...(item.commentCount !== undefined ? { commentCount: item.commentCount } : {}),
    ...(ciStatus ? { ciStatus } : {}),
    createdAt: updatedAt,
    updatedAt,
    rawData: item,
  };
}

export function mapIssueGraphQLStates(state: ListOptions["state"]): string[] {
  if (state === "closed") return ["CLOSED"];
  if (state === "all") return ["OPEN", "CLOSED"];
  return ["OPEN"];
}

export function mapPRGraphQLStates(state: ListOptions["state"]): string[] {
  if (state === "merged") return ["MERGED"];
  if (state === "closed") return ["CLOSED", "MERGED"];
  if (state === "all") return ["OPEN", "CLOSED", "MERGED"];
  return ["OPEN"];
}
