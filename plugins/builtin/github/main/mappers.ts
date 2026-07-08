import type {
  CIStatusState,
  ForgeLabel,
  ForgeUser,
  Issue,
  LinkedPRSummary,
  ListOptions,
  NormalizedIssueState,
  NormalizedPRState,
  NormalizedReviewDecision,
  PR,
} from "../../../../shared/types/forge.js";
import type { GitHubIssue, GitHubPR, GitHubPRCIStatus, GitHubUser } from "../shared/types.js";

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

export function toForgeIssue(node: Record<string, unknown>): Issue {
  const rawState = typeof node.state === "string" ? node.state : "OPEN";
  const comments = node.comments as { totalCount?: unknown } | undefined;
  const commentCount = typeof comments?.totalCount === "number" ? comments.totalCount : undefined;
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
    createdAt: isoToMs(node.createdAt ?? node.updatedAt),
    updatedAt: isoToMs(node.updatedAt),
    closedAt: isoToMsOrNull(node.closedAt),
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
  const linkedCI = mapListCIStatus(item.linkedPR?.ciStatus);
  const linkedPR: LinkedPRSummary | undefined = item.linkedPR
    ? {
        number: item.linkedPR.number,
        state: normalizePRState(item.linkedPR.state, item.linkedPR.state === "MERGED"),
        url: item.linkedPR.url,
        ...(linkedCI ? { ciStatus: linkedCI } : {}),
      }
    : undefined;
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
