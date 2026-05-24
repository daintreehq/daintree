import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { configure } from "safe-stable-stringify";
import type {
  AuthValidation,
  CIStatus,
  Credentials,
  ForgeProviderImpl,
  ForgeUser,
  ForgeLabel,
  Issue,
  ListOptions,
  NormalizedIssueState,
  NormalizedPRState,
  NormalizedReviewDecision,
  PR,
  Page,
  PushErrorClassification,
  RateLimitInfo,
  RepoMetadata,
  RepoRef,
  ReviewCapability,
  ReviewThread,
} from "../../../../shared/types/forge.js";
import { GitHubAuth, GITHUB_API_TIMEOUT_MS } from "./GitHubAuth.js";
import { validateGitHubToken } from "./GitHubToken.js";
import { parseGitHubRepoUrl } from "./GitHubRepoContext.js";
import {
  LIST_ISSUES_QUERY,
  LIST_PRS_QUERY,
  SEARCH_QUERY,
  GET_ISSUE_QUERY,
  GET_PR_QUERY,
  GET_PR_REVIEW_THREADS_QUERY,
  BATCH_BRANCH_CHUNK_SIZE,
  buildBatchBranchPRQuery,
} from "./GitHubQueries.js";
import { gitHubRateLimitService } from "./GitHubRateLimitService.js";
import {
  forgeQueryCache,
  forgeQueryInflight,
  repoEventsETagCache,
} from "./GitHubCaches.js";
import { parseGitHubError } from "./GitHubErrors.js";
import { deriveRequiredCIStatus } from "./prRequiredCIStatus.js";
import { MAX_REVIEW_THREAD_PAGES } from "./GitHubCaches.js";
import type { RollupContextNode } from "./prRequiredCIStatus.js";
import { fetchActivityProbe } from "./GitHubStats.js";
import {
  forgeIssueListCache,
  forgePRListCache,
  issueTooltipCache,
  prRequiredStatusCache,
  truncateBody,
  writePRTooltip,
  type PRRequiredStatusEntry,
} from "./GitHubCaches.js";
import { buildListCacheKey, updateRepoStatsCount } from "./GitHubPRs.js";
import type { IssueTooltipData, PRTooltipData } from "../../../../shared/types/github.js";

const REPO_METADATA_QUERY = `
  query GetRepoMetadata($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef { name }
      isPrivate
      isFork
      isArchived
      description
      licenseInfo { name }
      repositoryTopics(first: 20) { nodes { topic { name } } }
    }
    rateLimit { cost remaining resetAt limit }
  }
`;

const PR_CI_STATUS_QUERY = `
  query GetPRCIStatus($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      conclusion
                      status
                      isRequired(pullRequestNumber: $number)
                    }
                    ... on StatusContext {
                      context
                      state
                      isRequired(pullRequestNumber: $number)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    rateLimit { cost remaining resetAt limit }
  }
`;

function requireClient(): NonNullable<ReturnType<typeof GitHubAuth.createClient>> {
  const client = GitHubAuth.createClient();
  if (!client) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }
  return client;
}

function isoToMs(value: unknown): number {
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

function toForgeIssue(node: Record<string, unknown>): Issue {
  const rawState = typeof node.state === "string" ? node.state : "OPEN";
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
    createdAt: isoToMs(node.createdAt ?? node.updatedAt),
    updatedAt: isoToMs(node.updatedAt),
    closedAt: isoToMsOrNull(node.closedAt),
    rawData: node,
  };
}

function toForgePR(node: Record<string, unknown>): PR {
  const merged = node.merged === true;
  const rawState = typeof node.state === "string" ? node.state : "OPEN";
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
    createdAt: isoToMs(node.createdAt ?? node.updatedAt),
    updatedAt: isoToMs(node.updatedAt),
    closedAt: isoToMsOrNull(node.closedAt),
    mergedAt: isoToMsOrNull(node.mergedAt),
    rawData: node,
  };
}

function mapIssueGraphQLStates(state: ListOptions["state"]): string[] {
  if (state === "closed") return ["CLOSED"];
  if (state === "all") return ["OPEN", "CLOSED"];
  return ["OPEN"];
}

function mapPRGraphQLStates(state: ListOptions["state"]): string[] {
  if (state === "closed") return ["CLOSED", "MERGED"];
  if (state === "all") return ["OPEN", "CLOSED", "MERGED"];
  return ["OPEN"];
}

function buildOrderBy(opts: ListOptions): { field: string; direction: string } {
  const direction = opts.direction === "asc" ? "ASC" : "DESC";
  const field = opts.sort === "updated" ? "UPDATED_AT" : "CREATED_AT";
  return { field, direction };
}

// Deterministic stringify so equivalent variables produce one cache key
// regardless of property insertion order across call sites.
const stringifyVariables = configure({ bigint: false });

// `\0` can't appear in a GraphQL document, so it can't be forged by a query
// string that happens to contain the serialized variables.
function buildCacheKey(query: string, variables: Record<string, unknown>): string {
  return `${query}\0${stringifyVariables(variables) ?? ""}`;
}

async function dispatchQuery(
  query: string,
  variables: Record<string, unknown>,
  queryLabel: string
): Promise<GraphQlQueryResponseData> {
  const client = requireClient();
  try {
    const response = (await client(query, {
      ...variables,
      request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
    })) as GraphQlQueryResponseData;
    gitHubRateLimitService.updateFromGraphQL(response, queryLabel);
    return response;
  } catch (error) {
    throw new Error(parseGitHubError(error), { cause: error });
  }
}

/**
 * Sole GraphQL entry point. Serves a 60s response cache and coalesces
 * concurrent identical queries through an in-flight singleflight map (both in
 * `GitHubCaches.ts` so a token change clears them atomically). Errors are never
 * cached — a transient failure must not block retries for the full TTL.
 */
async function runQuery(
  query: string,
  variables: Record<string, unknown>,
  queryLabel: string
): Promise<GraphQlQueryResponseData> {
  const key = buildCacheKey(query, variables);

  const cached = forgeQueryCache.get(key);
  if (cached !== undefined) return cached;

  const inflight = forgeQueryInflight.get(key);
  if (inflight !== undefined) return inflight;

  const request = dispatchQuery(query, variables, queryLabel)
    .then((response) => {
      forgeQueryCache.set(key, response);
      return response;
    })
    .finally(() => {
      forgeQueryInflight.delete(key);
    });

  forgeQueryInflight.set(key, request);
  return request;
}

/**
 * Single-flight coalescing maps for higher-level provider methods. These layer
 * on top of `runQuery`'s GraphQL-level dedup to coalesce at the call-site
 * boundary too — `listPRs`/`getCIStatus` etc. carry their own cache shape
 * (Page<T>, CIStatus) and need to dedup on the same key the cache uses, not the
 * underlying GraphQL key. Concurrent calls with the same key join the one
 * in-flight request instead of each paying full query cost — the dominant load
 * source is the worktree dashboard's fleet-wide PR/CI poll firing the same
 * lookups from every view at once.
 */
const listIssuesInflight = new Map<string, Promise<Page<Issue>>>();
const listPRsInflight = new Map<string, Promise<Page<PR>>>();
const getIssueInflight = new Map<string, Promise<Issue | null>>();
const getPRInflight = new Map<string, Promise<PR | null>>();
const getCIStatusInflight = new Map<string, Promise<CIStatus | null>>();
const findPRsByBranchesInflight = new Map<string, Promise<Map<string, PR | null>>>();

/**
 * Join an in-flight request for `key` when one exists, else start `fn` and
 * register it. `bypass` forces a fresh request (skips the join) and installs
 * itself as the new shared promise so callers arriving mid-flight get the fresh
 * result, not the stale one. Cleanup removes the entry only if it's still the
 * active promise, so a bypass replacement isn't deleted by the request it
 * superseded. Failures evict immediately so a transient error doesn't pin a
 * rejected promise for later callers.
 *
 * `fn` receives an `isCurrent()` guard: it returns `true` only while this call
 * is still the active in-flight entry. A request that was superseded by a newer
 * bypass call sees `false` and must skip any shared-cache write, so a slow
 * stale fetch can't overwrite the fresher result the bypass already committed.
 */
function dedupe<T>(
  inflight: Map<string, Promise<T>>,
  key: string,
  bypass: boolean,
  fn: (isCurrent: () => boolean) => Promise<T>
): Promise<T> {
  if (!bypass) {
    const pending = inflight.get(key);
    if (pending) return pending;
  }
  const holder: { promise: Promise<T> | null } = { promise: null };
  // Defer `fn` one microtask so `holder.promise` is assigned before it runs;
  // `isCurrent` can then compare against this call's own promise identity.
  const promise = Promise.resolve().then(() => fn(() => inflight.get(key) === holder.promise));
  holder.promise = promise;
  inflight.set(key, promise);
  const cleanup = () => {
    if (inflight.get(key) === promise) inflight.delete(key);
  };
  promise.then(cleanup, cleanup);
  return promise;
}

function listCacheState(opts: ListOptions): "open" | "closed" | "all" {
  return opts.state ?? "open";
}

function issueToTooltipData(issue: Issue): IssueTooltipData {
  return {
    number: issue.number,
    title: issue.title,
    bodyExcerpt: truncateBody(issue.body),
    state: issue.state === "closed" ? "CLOSED" : "OPEN",
    createdAt: new Date(issue.createdAt).toISOString(),
    author: { login: issue.author?.login ?? "unknown", avatarUrl: issue.author?.avatarUrl ?? "" },
    assignees: issue.assignees.map((a) => ({ login: a.login, avatarUrl: a.avatarUrl ?? "" })),
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color ?? "" })),
  };
}

/**
 * Build a {@link PRTooltipData} from a normalized forge {@link PR}. Assignees
 * and labels aren't on the forge `PR` shape, so they're read from `rawData`
 * (present when the source query selected them — `GET_PR_QUERY` and
 * `buildBatchBranchPRQuery` both do). Returns `null` when `createdAt` is
 * missing (0), since the tooltip renders a real creation date.
 */
function prToTooltipData(pr: PR): PRTooltipData | null {
  if (!pr.createdAt) return null;
  const raw = (pr.rawData ?? {}) as Record<string, unknown>;
  const assigneeNodes =
    (raw.assignees as { nodes?: Array<{ login?: string; avatarUrl?: string }> } | undefined)
      ?.nodes ?? [];
  const labelNodes =
    (raw.labels as { nodes?: Array<{ name?: string; color?: string }> } | undefined)?.nodes ?? [];
  const state: "OPEN" | "CLOSED" | "MERGED" =
    pr.merged || pr.state === "merged"
      ? "MERGED"
      : pr.state === "closed" || pr.state === "declined"
        ? "CLOSED"
        : "OPEN";
  return {
    number: pr.number,
    title: pr.title,
    bodyExcerpt: truncateBody(pr.body),
    state,
    isDraft: pr.isDraft,
    createdAt: new Date(pr.createdAt).toISOString(),
    author: { login: pr.author?.login ?? "unknown", avatarUrl: pr.author?.avatarUrl ?? "" },
    assignees: assigneeNodes
      .filter(Boolean)
      .map((a) => ({ login: a.login ?? "unknown", avatarUrl: a.avatarUrl ?? "" })),
    labels: labelNodes.filter(Boolean).map((l) => ({ name: l.name ?? "", color: l.color ?? "" })),
  };
}

function buildCIStatus(entry: PRRequiredStatusEntry, rawData: unknown): CIStatus {
  let state: CIStatus["state"] = "unknown";
  const effective = entry.ciStatus;
  if (effective === "SUCCESS") state = "success";
  else if (effective === "FAILURE" || effective === "ERROR") state = "failure";
  else if (effective === "PENDING" || effective === "EXPECTED") state = "pending";
  else if (effective === undefined && (entry.ciSummary?.requiredTotal ?? 0) === 0)
    state = "neutral";

  const total = entry.ciSummary?.requiredTotal ?? 0;
  const failed = entry.ciSummary?.requiredFailing ?? 0;
  const pending = entry.ciSummary?.requiredPending ?? 0;
  const passed = Math.max(0, total - failed - pending);
  const requiredChecksPassing =
    entry.ciSummary !== undefined
      ? entry.ciSummary.requiredTotal > 0 &&
        entry.ciSummary.requiredFailing === 0 &&
        entry.ciSummary.requiredPending === 0
      : undefined;

  return {
    state,
    total,
    passed,
    failed,
    pending,
    ...(requiredChecksPassing !== undefined ? { requiredChecksPassing } : {}),
    rawData,
  };
}

async function listIssuesImpl(repo: RepoRef, opts: ListOptions): Promise<Page<Issue>> {
  const state = listCacheState(opts);
  const sortOrder = opts.sort === "updated" ? "updated" : "created";
  const bypass = opts.bypassCache === true;
  // The GitHub forge list path issues the unfiltered repository query and
  // ignores `opts.search` (advisory — see ListOptions). Keep `search` out of
  // the cache key so it reflects what the query actually varies on; wiring
  // search would mean routing to SEARCH_QUERY and re-adding it here together.
  const cacheKey = buildListCacheKey(
    "issue",
    repo.owner,
    repo.repo,
    state,
    "",
    sortOrder,
    opts.cursor ?? ""
  );

  if (!bypass) {
    const cached = forgeIssueListCache.get(cacheKey);
    if (cached) return cached;
  }

  return dedupe(listIssuesInflight, cacheKey, bypass, async (isCurrent) => {
    const limit = opts.perPage ?? 20;
    const orderBy = buildOrderBy(opts);

    const response = await runQuery(
      LIST_ISSUES_QUERY,
      {
        owner: repo.owner,
        repo: repo.repo,
        states: mapIssueGraphQLStates(opts.state),
        cursor: opts.cursor ?? null,
        limit,
        orderBy,
      },
      "LIST_ISSUES_QUERY"
    );

    const issues = (response?.repository as Record<string, unknown> | undefined)?.issues as
      | {
          nodes?: unknown[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          totalCount?: number;
        }
      | undefined;
    const nodes = (issues?.nodes ?? []) as Array<Record<string, unknown>>;
    const page: Page<Issue> = {
      items: nodes.filter(Boolean).map(toForgeIssue),
      nextCursor: issues?.pageInfo?.endCursor ?? null,
      hasMore: issues?.pageInfo?.hasNextPage ?? false,
      ...(typeof issues?.totalCount === "number" ? { totalCount: issues.totalCount } : {}),
    };

    // Skip the shared-cache write when a newer bypass call has superseded us,
    // so a slow stale fetch can't clobber the fresher committed result.
    if (isCurrent()) {
      forgeIssueListCache.set(cacheKey, page);
      if (state === "open" && !opts.cursor && typeof issues?.totalCount === "number") {
        updateRepoStatsCount(`${repo.owner}/${repo.repo}`, "issue", issues.totalCount);
      }
    }
    return page;
  });
}

async function listPRsImpl(repo: RepoRef, opts: ListOptions): Promise<Page<PR>> {
  const state = listCacheState(opts);
  const sortOrder = opts.sort === "updated" ? "updated" : "created";
  const bypass = opts.bypassCache === true;
  // See listIssuesImpl: the forge list query ignores `opts.search`, so it's
  // kept out of the cache key.
  const cacheKey = buildListCacheKey(
    "pr",
    repo.owner,
    repo.repo,
    state,
    "",
    sortOrder,
    opts.cursor ?? ""
  );

  if (!bypass) {
    const cached = forgePRListCache.get(cacheKey);
    if (cached) return cached;
  }

  return dedupe(listPRsInflight, cacheKey, bypass, async (isCurrent) => {
    const limit = opts.perPage ?? 20;
    const orderBy = buildOrderBy(opts);

    const response = await runQuery(
      LIST_PRS_QUERY,
      {
        owner: repo.owner,
        repo: repo.repo,
        states: mapPRGraphQLStates(opts.state),
        cursor: opts.cursor ?? null,
        limit,
        orderBy,
      },
      "LIST_PRS_QUERY"
    );

    const prs = (response?.repository as Record<string, unknown> | undefined)?.pullRequests as
      | {
          nodes?: unknown[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          totalCount?: number;
        }
      | undefined;
    const nodes = (prs?.nodes ?? []) as Array<Record<string, unknown>>;
    const page: Page<PR> = {
      items: nodes.filter(Boolean).map(toForgePR),
      nextCursor: prs?.pageInfo?.endCursor ?? null,
      hasMore: prs?.pageInfo?.hasNextPage ?? false,
      ...(typeof prs?.totalCount === "number" ? { totalCount: prs.totalCount } : {}),
    };

    if (isCurrent()) {
      forgePRListCache.set(cacheKey, page);
      if (state === "open" && !opts.cursor && typeof prs?.totalCount === "number") {
        updateRepoStatsCount(`${repo.owner}/${repo.repo}`, "pr", prs.totalCount);
      }
    }
    return page;
  });
}

async function getIssueImpl(repo: RepoRef, number: number): Promise<Issue | null> {
  const key = `${repo.owner}/${repo.repo}:${number}`;
  return dedupe(getIssueInflight, key, false, async () => {
    const response = await runQuery(
      GET_ISSUE_QUERY,
      {
        owner: repo.owner,
        repo: repo.repo,
        number,
      },
      "GET_ISSUE_QUERY"
    );
    const issue = (response?.repository as Record<string, unknown> | undefined)?.issue as
      | Record<string, unknown>
      | null
      | undefined;
    if (!issue) return null;
    const forgeIssue = toForgeIssue(issue);
    // Warm the hover-tooltip cache as a side effect so a subsequent hover skips
    // a redundant fetch. The detail fetch can't *read* this cache — it holds
    // the narrower tooltip shape, not a full Issue.
    issueTooltipCache.set(key, issueToTooltipData(forgeIssue));
    return forgeIssue;
  });
}

async function getPRImpl(repo: RepoRef, number: number): Promise<PR | null> {
  const key = `${repo.owner}/${repo.repo}:${number}`;
  return dedupe(getPRInflight, key, false, async () => {
    const requestedAt = Date.now();
    const response = await runQuery(
      GET_PR_QUERY,
      {
        owner: repo.owner,
        repo: repo.repo,
        number,
      },
      "GET_PR_QUERY"
    );
    const pr = (response?.repository as Record<string, unknown> | undefined)?.pullRequest as
      | Record<string, unknown>
      | null
      | undefined;
    if (!pr) return null;
    const forgePR = toForgePR(pr);
    // Side-effect tooltip pre-warm (write-through only); guarded by the
    // ownership-token timestamp so a slow response can't clobber a fresher one.
    const tooltip = prToTooltipData(forgePR);
    if (tooltip) writePRTooltip(repo.owner, repo.repo, number, tooltip, requestedAt);
    return forgePR;
  });
}

async function findPRsByBranchesImpl(
  repo: RepoRef,
  branches: string[]
): Promise<Map<string, PR | null>> {
  if (branches.length === 0) return new Map<string, PR | null>();

  // Deduplicate while preserving order. Duplicates in the input still land
  // in the result via the same key, but each unique value is queried once.
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const branch of branches) {
    if (!seen.has(branch)) {
      seen.add(branch);
      unique.push(branch);
    }
  }

  // Coalesce concurrent fleet-wide sweeps requesting the same branch set
  // (order-independent) into one round-trip. The result Map preserves each
  // caller's branch keys regardless of the sorted key used for coalescing.
  const inflightKey = `${repo.owner}/${repo.repo}:${[...unique].sort().join(",")}`;
  return dedupe(findPRsByBranchesInflight, inflightKey, false, async () => {
    const result = new Map<string, PR | null>();

    // Skip the network entirely while rate-limited — the caller's missing-key
    // fallback handles every omitted branch. Mirrors `batchCheckLinkedPRs`.
    const block = gitHubRateLimitService.shouldBlockRequest("graphql");
    if (block.blocked) return result;

    const requestedAt = Date.now();
    // Chunks run sequentially (parallel would spike GraphQL points during a
    // fleet-wide refresh). Per-chunk failures are caught so a single transient
    // chunk error doesn't blank every branch — the caller falls back per-branch
    // for any branch the result Map omits.
    for (let start = 0; start < unique.length; start += BATCH_BRANCH_CHUNK_SIZE) {
      const chunk = unique.slice(start, start + BATCH_BRANCH_CHUNK_SIZE);
      const query = buildBatchBranchPRQuery(repo.owner, repo.repo, chunk);
      let response: Record<string, unknown>;
      try {
        response = (await runQuery(query, {}, "BATCH_BRANCH_PR_QUERY")) as Record<string, unknown>;
      } catch {
        // Omit this chunk's branches from the result — caller's missing-key
        // fallback path handles them.
        continue;
      }

      for (let i = 0; i < chunk.length; i++) {
        const branch = chunk[i];
        // A missing alias key (vs. a present key with empty nodes) indicates a
        // partial GraphQL response. Omit so the caller routes to fallback rather
        // than silently recording "no PR found".
        if (!(`b${i}` in response)) continue;
        const aliasNode = response[`b${i}`] as
          | { pullRequests?: { nodes?: unknown[] } }
          | null
          | undefined;
        if (aliasNode == null) continue;
        const nodes = (aliasNode.pullRequests?.nodes ?? []) as Array<Record<string, unknown>>;
        const first = nodes.find(Boolean);
        const forgePR = first ? toForgePR(first) : null;
        result.set(branch, forgePR);

        // Pre-warm the PR tooltip cache so a hover right after a fleet refresh
        // is instant. The batch-branch query carries assignees/labels, so the
        // warmed entry is complete (not a partial that a later hover refetches).
        if (forgePR) {
          const tooltip = prToTooltipData(forgePR);
          if (tooltip) writePRTooltip(repo.owner, repo.repo, forgePR.number, tooltip, requestedAt);
        }
      }
    }

    return result;
  });
}

async function findPRByBranchImpl(repo: RepoRef, branchName: string): Promise<PR | null> {
  // Quote the branch name so refs containing spaces or characters that would
  // otherwise be parsed as a separate search operator (`sort:`, `head:`,
  // `is:`) don't override the intended search semantics.
  const escapedBranch = branchName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const searchQuery = `repo:${repo.owner}/${repo.repo} is:pr head:"${escapedBranch}" sort:created-desc`;
  const response = await runQuery(
    SEARCH_QUERY,
    {
      searchQuery,
      type: "ISSUE",
      cursor: null,
      limit: 1,
    },
    "SEARCH_QUERY"
  );
  const nodes = ((response?.search as { nodes?: unknown[] } | undefined)?.nodes ?? []) as Array<
    Record<string, unknown>
  >;
  const first = nodes.find(Boolean);
  return first ? toForgePR(first) : null;
}

async function getCIStatusImpl(repo: RepoRef, prNumber: number): Promise<CIStatus | null> {
  // Shares the 60s required-status cache with the legacy enrich path (same key
  // and {@link PRRequiredStatusEntry} value). This is the hottest forge path —
  // the worktree dashboard polls CI per open PR across every view — so the
  // cache + single-flight collapse the fan-out to one request per PR per 60s.
  const cacheKey = `${repo.owner}/${repo.repo}:${prNumber}`;
  const cached = prRequiredStatusCache.get(cacheKey);
  if (cached) return buildCIStatus(cached, null);

  return dedupe(getCIStatusInflight, cacheKey, false, async () => {
    const response = await runQuery(
      PR_CI_STATUS_QUERY,
      {
        owner: repo.owner,
        repo: repo.repo,
        number: prNumber,
      },
      "PR_CI_STATUS_QUERY"
    );

    const pr = (response?.repository as Record<string, unknown> | undefined)?.pullRequest as
      | Record<string, unknown>
      | null
      | undefined;
    if (!pr) return null;

    const commits = pr.commits as
      | { nodes?: Array<{ commit?: { statusCheckRollup?: unknown } }> }
      | undefined;
    const rollup = commits?.nodes?.[0]?.commit?.statusCheckRollup as
      | {
          state?: string;
          contexts?: { nodes?: RollupContextNode[]; pageInfo?: { hasNextPage?: boolean } };
        }
      | undefined;

    const contextNodes = rollup?.contexts?.nodes ?? null;
    const hasNextPage = rollup?.contexts?.pageInfo?.hasNextPage === true;
    const derived = deriveRequiredCIStatus(contextNodes, hasNextPage, rollup?.state ?? null);

    const entry: PRRequiredStatusEntry = {
      ciStatus: derived.ciStatus,
      ciSummary: derived.ciSummary,
    };
    prRequiredStatusCache.set(cacheKey, entry);
    return buildCIStatus(entry, rollup ?? null);
  });
}

async function getRepoMetadataImpl(repo: RepoRef): Promise<RepoMetadata> {
  const response = await runQuery(
    REPO_METADATA_QUERY,
    {
      owner: repo.owner,
      repo: repo.repo,
    },
    "REPO_METADATA_QUERY"
  );

  const repository = (response?.repository as Record<string, unknown> | undefined) ?? {};
  const defaultBranch =
    ((repository.defaultBranchRef as { name?: unknown } | null | undefined)?.name as
      | string
      | undefined) ?? "main";
  const license =
    ((repository.licenseInfo as { name?: unknown } | null | undefined)?.name as string | null) ??
    null;
  const topicNodes = ((
    repository.repositoryTopics as { nodes?: Array<{ topic?: { name?: unknown } }> } | undefined
  )?.nodes ?? []) as Array<{ topic?: { name?: unknown } }>;
  const topics = topicNodes
    .map((n) => (typeof n.topic?.name === "string" ? n.topic.name : null))
    .filter((s): s is string => s !== null);

  return {
    defaultBranch,
    isPrivate: repository.isPrivate === true,
    isFork: repository.isFork === true,
    isArchived: repository.isArchived === true,
    description: (repository.description as string | null | undefined) ?? null,
    license,
    topics,
    rawData: repository,
  };
}

async function getReviewThreadsImpl(repo: RepoRef, prNumber: number): Promise<ReviewThread[]> {
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  while (true) {
    const response = await runQuery(
      GET_PR_REVIEW_THREADS_QUERY,
      {
        owner: repo.owner,
        repo: repo.repo,
        number: prNumber,
        cursor,
      },
      "GET_PR_REVIEW_THREADS_QUERY"
    );
    const reviewThreads = (
      (response?.repository as Record<string, unknown> | undefined)?.pullRequest as
        | {
            reviewThreads?: {
              nodes?: unknown[];
              pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            };
          }
        | undefined
    )?.reviewThreads;
    const nodes = (reviewThreads?.nodes ?? []) as Array<Record<string, unknown>>;
    for (const n of nodes) {
      if (!n) continue;
      const id = `${repo.owner}/${repo.repo}#${prNumber}:${threads.length}`;
      threads.push({ id, rawData: n });
    }
    pageCount++;
    if (pageCount >= MAX_REVIEW_THREAD_PAGES) {
      break;
    }
    if (reviewThreads?.pageInfo?.hasNextPage && reviewThreads.pageInfo.endCursor) {
      cursor = reviewThreads.pageInfo.endCursor;
      continue;
    }
    break;
  }
  return threads;
}

function getRateLimitImpl(): Promise<RateLimitInfo> {
  const state = gitHubRateLimitService.getState();
  if (!state.blocked) {
    return Promise.resolve({ limit: null, remaining: null, resetAt: null });
  }
  return Promise.resolve({
    limit: null,
    remaining: 0,
    resetAt: state.resetAt ?? null,
    ...(state.kind === "secondary" ? { secondaryThrottled: true } : {}),
  });
}

/**
 * Extracts a `GH###` code (e.g. `GH006`, `GH013`) from raw push stderr — these
 * are GitHub's stable, googleable identifiers for protected-branch and ruleset
 * rejections. Returns `null` when no recognized code is present so the banner
 * falls back to its generic state.
 */
function classifyPushErrorImpl(stderr: string): PushErrorClassification | null {
  const match = /\bGH\d{3,}\b/.exec(stderr);
  return match ? { code: match[0] } : null;
}

const reviewCapability: ReviewCapability = {
  getReviewThreads: getReviewThreadsImpl,
};

export const githubForgeProvider: ForgeProviderImpl = {
  async getCredentials(): Promise<Credentials | null> {
    const token = GitHubAuth.getToken();
    if (!token) return null;
    return { kind: "bearer", value: token };
  },

  setCredentials(credentials: Credentials | null): void {
    if (credentials === null) {
      GitHubAuth.setMemoryToken(null);
    } else if (credentials.kind === "bearer") {
      GitHubAuth.setMemoryToken(credentials.value);
    }
    // Non-bearer credentials are silently ignored — GitHub only supports bearer tokens.
  },

  async validateCredentials(): Promise<AuthValidation> {
    const token = GitHubAuth.getToken();
    if (!token) {
      return { valid: false, error: "No GitHub token configured" };
    }
    const result = await validateGitHubToken(token);
    return {
      valid: result.valid,
      scopes: result.scopes,
      expiresAt: null,
      ...(result.error ? { error: result.error } : {}),
    };
  },

  parseRemote(url: string): RepoRef | null {
    const parsed = parseGitHubRepoUrl(url);
    if (!parsed) return null;
    return {
      host: "github.com",
      owner: parsed.owner,
      repo: parsed.repo,
      rawData: { url },
    };
  },

  listIssues: listIssuesImpl,
  listPRs: listPRsImpl,
  getIssue: getIssueImpl,
  getPR: getPRImpl,
  findPRByBranch: findPRByBranchImpl,
  findPRsByBranches: findPRsByBranchesImpl,
  getCIStatus: getCIStatusImpl,
  getRepoMetadata: getRepoMetadataImpl,

  buildIssueUrl(repo: RepoRef, number: number): string {
    return `https://github.com/${repo.owner}/${repo.repo}/issues/${number}`;
  },

  buildPRUrl(repo: RepoRef, number: number): string {
    return `https://github.com/${repo.owner}/${repo.repo}/pull/${number}`;
  },

  buildIssuesUrl(repo: RepoRef, options?: { query?: string; state?: string }): string {
    const base = `https://github.com/${repo.owner}/${repo.repo}/issues`;
    const params = new URLSearchParams();
    if (options?.query) {
      const qParts: string[] = [options.query];
      if (options.state && options.state !== "all") {
        qParts.push(`is:${options.state}`);
      }
      params.set("q", qParts.join(" "));
    }
    return params.toString() ? `${base}?${params.toString()}` : base;
  },

  buildPRsUrl(repo: RepoRef, options?: { query?: string; state?: string }): string {
    const base = `https://github.com/${repo.owner}/${repo.repo}/pulls`;
    const params = new URLSearchParams();
    if (options?.query) {
      const qParts: string[] = [options.query];
      if (options.state && options.state !== "all") {
        qParts.push(`is:${options.state}`);
      }
      params.set("q", qParts.join(" "));
    }
    return params.toString() ? `${base}?${params.toString()}` : base;
  },

  buildCommitsUrl(repo: RepoRef, branch?: string): string {
    const base = `https://github.com/${repo.owner}/${repo.repo}/commits`;
    return branch ? `${base}/${encodeURIComponent(branch)}` : base;
  },

  async assignIssue(repo: RepoRef, issueNumber: number, username: string): Promise<void> {
    const token = GitHubAuth.getToken();
    if (!token) {
      throw new Error("GitHub token not configured. Set it in Settings.");
    }
    const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/assignees`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ assignees: [username] }),
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Failed to assign issue #${issueNumber} to ${username}: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
      );
    }
  },

  async validateToken(token: string): Promise<AuthValidation> {
    if (!token || !token.trim()) {
      return { valid: false, error: "Token is required" };
    }
    const result = await validateGitHubToken(token.trim());
    return {
      valid: result.valid,
      scopes: result.scopes,
      expiresAt: null,
      ...(result.error ? { error: result.error } : {}),
    };
  },

  getRateLimit: getRateLimitImpl,

  async getRepoActivityProbe(repo: RepoRef): Promise<{ freshnessToken: string }> {
    const token = GitHubAuth.getToken();
    if (!token) {
      throw new Error("GitHub token not configured");
    }
    const probe = await fetchActivityProbe(token, repo.owner, repo.repo);
    const cacheKey = `${repo.owner}/${repo.repo}`;
    // The REST events probe returns either a fresh ETag (`changed`) or signals
    // "nothing new since the cached ETag" (`unchanged`); either way the latest
    // ETag is what the host should byte-compare. On `unknown` the probe has no
    // signal to offer — surface the failure rather than fabricate a token.
    if (probe.status === "unknown") {
      throw new Error("Failed to capture repo activity probe");
    }
    const etag = probe.status === "changed" ? probe.etag : repoEventsETagCache.get(cacheKey);
    if (!etag) {
      throw new Error("Repo activity probe produced no ETag");
    }
    return { freshnessToken: etag };
  },

  classifyPushError: classifyPushErrorImpl,

  reviews: reviewCapability,
};
