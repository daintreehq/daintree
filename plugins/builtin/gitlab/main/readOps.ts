import type {
  CIStatus,
  Issue,
  IssueTooltipData,
  ListOptions,
  Page,
  PR,
  PRTooltipData,
  RateLimitInfo,
  RepoMetadata,
  RepoRef,
  RepoStatsSnapshot,
  StatsPage,
} from "../../../../shared/types/forge.js";
import type {
  GitLabIssue,
  GitLabMergeRequest,
  GitLabProject,
  GitLabRelease,
} from "../shared/types.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import {
  GitLabApiError,
  gitlabGraphQL,
  gitlabRest,
  gitlabRestPage,
  getRateLimitSnapshot,
} from "./GitLabClient.js";
import { getInstanceHost } from "./GitLabAuth.js";
import { encodeProjectId, repoFullPath } from "./gitlabRemote.js";
import {
  gitlabIssueToForgeIssue,
  gitlabReleaseToForgeRelease,
  graphqlMergeRequestToForgePR,
  issueToTooltipData,
  mapIssueListState,
  mapListOrderBy,
  mapMRListState,
  mergeRequestToForgePR,
  pipelineStatusToCIState,
  prToTooltipData,
} from "./mappers.js";

const TOOLTIP_CACHE_TTL_MS = 30_000;
const AVATAR_CACHE_TTL_MS = 60 * 60 * 1000;
const REPO_STATS_CACHE_TTL_MS = 30_000;
const STATS_FIRST_PAGE_SIZE = 20;

/** Branches per batched GraphQL branch→MR query. */
export const GRAPHQL_BRANCH_CHUNK_SIZE = 20;

interface CacheEntry<T> {
  value: T;
  at: number;
}

const issueTooltipCache = new Map<string, CacheEntry<IssueTooltipData | null>>();
const prTooltipCache = new Map<string, CacheEntry<PRTooltipData | null>>();
const avatarCache = new Map<string, CacheEntry<string | null>>();
const repoStatsCache = new Map<string, CacheEntry<RepoStatsSnapshot>>();

export function clearGitLabCaches(): void {
  issueTooltipCache.clear();
  prTooltipCache.clear();
  avatarCache.clear();
  repoStatsCache.clear();
}

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string, ttlMs: number): T | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > ttlMs) {
    map.delete(key);
    return undefined;
  }
  return entry.value;
}

function tooltipKey(repo: RepoRef, number: number): string {
  return `${repo.host}/${repoFullPath(repo)}#${number}`;
}

function listQuery(opts: ListOptions, state: string | undefined) {
  return {
    ...(state !== undefined ? { state } : {}),
    per_page: opts.perPage ?? 30,
    page: opts.cursor ?? "1",
    order_by: mapListOrderBy(opts.sort),
    sort: opts.direction ?? "desc",
    ...(opts.search ? { search: opts.search } : {}),
    ...(opts.labels && opts.labels.length > 0 ? { labels: opts.labels.join(",") } : {}),
    ...(opts.assignee ? { assignee_username: opts.assignee } : {}),
  };
}

export async function listIssuesImpl(repo: RepoRef, opts: ListOptions): Promise<Page<Issue>> {
  const page = await gitlabRestPage<GitLabIssue>({
    host: repo.host,
    path: `/projects/${encodeProjectId(repo)}/issues`,
    query: listQuery(opts, mapIssueListState(opts.state)),
  });
  return {
    items: page.items.map((issue) => gitlabIssueToForgeIssue(issue, repo.host)),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    ...(page.totalCount !== undefined ? { totalCount: page.totalCount } : {}),
  };
}

export async function listPRsImpl(repo: RepoRef, opts: ListOptions): Promise<Page<PR>> {
  const page = await gitlabRestPage<GitLabMergeRequest>({
    host: repo.host,
    path: `/projects/${encodeProjectId(repo)}/merge_requests`,
    query: listQuery(opts, mapMRListState(opts.state)),
  });
  return {
    items: page.items.map((mr) => mergeRequestToForgePR(mr, repo.host)),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    ...(page.totalCount !== undefined ? { totalCount: page.totalCount } : {}),
  };
}

/** `null` on 404 per contract; every other failure propagates. */
function nullOn404<T>(err: unknown): T | null {
  if (err instanceof GitLabApiError && err.status === 404) return null;
  throw err;
}

export async function getIssueImpl(repo: RepoRef, number: number): Promise<Issue | null> {
  try {
    const { data } = await gitlabRest<GitLabIssue>({
      host: repo.host,
      path: `/projects/${encodeProjectId(repo)}/issues/${number}`,
    });
    return gitlabIssueToForgeIssue(data, repo.host);
  } catch (err) {
    return nullOn404<Issue>(err);
  }
}

export async function getPRImpl(repo: RepoRef, number: number): Promise<PR | null> {
  try {
    const { data } = await gitlabRest<GitLabMergeRequest>({
      host: repo.host,
      path: `/projects/${encodeProjectId(repo)}/merge_requests/${number}`,
    });
    return mergeRequestToForgePR(data, repo.host);
  } catch (err) {
    return nullOn404<PR>(err);
  }
}

/**
 * Newest MR (any state) whose source branch matches — mirroring the GitHub
 * provider's `head:` search semantics so a merged MR still badges its
 * worktree.
 */
export async function findPRByBranchImpl(repo: RepoRef, branchName: string): Promise<PR | null> {
  const page = await gitlabRestPage<GitLabMergeRequest>({
    host: repo.host,
    path: `/projects/${encodeProjectId(repo)}/merge_requests`,
    query: {
      source_branch: branchName,
      order_by: "created_at",
      sort: "desc",
      per_page: 1,
    },
  });
  const first = page.items[0];
  return first ? mergeRequestToForgePR(first, repo.host) : null;
}

const BRANCH_BATCH_QUERY = `
query DaintreeMRsForBranches($fullPath: ID!, $branches: [String!]) {
  project(fullPath: $fullPath) {
    mergeRequests(sourceBranches: $branches, sort: CREATED_DESC, first: 100) {
      pageInfo { hasNextPage }
      nodes {
        iid
        title
        description
        state
        draft
        sourceBranch
        targetBranch
        webUrl
        createdAt
        updatedAt
        mergedAt
        closedAt
        author { username avatarUrl }
        headPipeline { status }
      }
    }
  }
}`;

interface BranchBatchResponse {
  project: {
    mergeRequests: {
      pageInfo?: { hasNextPage?: boolean } | null;
      nodes: Array<Record<string, unknown>>;
    } | null;
  } | null;
}

/**
 * Batched branch→MR lookup via GraphQL `mergeRequests(sourceBranches:)` —
 * one query per {@link GRAPHQL_BRANCH_CHUNK_SIZE} branches instead of one
 * REST call per branch. Branches in a successful chunk with no returned MR
 * are confirmed absent (`null`); branches in a failed chunk are omitted so
 * the host's per-branch fallback re-resolves them. Nodes arrive
 * created-desc, so the first node per branch is the newest — matching
 * {@link findPRByBranchImpl}. When the 100-node window truncates
 * (`pageInfo.hasNextPage`), branches with no returned node are omitted
 * rather than confirmed absent, since their newest MR may lie beyond the
 * window.
 */
export async function findPRsByBranchesImpl(
  repo: RepoRef,
  branches: string[]
): Promise<Map<string, PR | null>> {
  const unique = [...new Set(branches.filter((b) => typeof b === "string" && b.length > 0))];
  const result = new Map<string, PR | null>();

  for (let start = 0; start < unique.length; start += GRAPHQL_BRANCH_CHUNK_SIZE) {
    const chunk = unique.slice(start, start + GRAPHQL_BRANCH_CHUNK_SIZE);
    let response: BranchBatchResponse;
    try {
      response = await gitlabGraphQL<BranchBatchResponse>(repo.host, BRANCH_BATCH_QUERY, {
        fullPath: repoFullPath(repo),
        branches: chunk,
      });
    } catch {
      // Omit the chunk — the host falls back to per-branch resolution.
      continue;
    }
    const connection = response.project?.mergeRequests;
    const nodes = connection?.nodes;
    if (!connection || !Array.isArray(nodes)) {
      // `project: null` means no access / not found — absence is unconfirmed.
      continue;
    }
    const found = new Map<string, PR>();
    for (const node of nodes) {
      const pr = graphqlMergeRequestToForgePR(node, repo.host);
      if (!pr || pr.headRef.length === 0) continue;
      if (!found.has(pr.headRef)) found.set(pr.headRef, pr);
    }
    // A truncated window (100+ MRs across the chunk's branches) means a
    // branch with no returned node might still have an MR beyond the window —
    // only a complete window confirms absence. Omitted branches route to the
    // host's per-branch fallback per the contract.
    const windowComplete = connection.pageInfo?.hasNextPage !== true;
    for (const branch of chunk) {
      const pr = found.get(branch);
      if (pr) {
        result.set(branch, pr);
      } else if (windowComplete) {
        result.set(branch, null);
      }
    }
  }

  return result;
}

/**
 * CI roll-up from the MR's head pipeline. GitLab reports one pipeline status
 * rather than per-check counts, so the roll-up projects that single status.
 */
export async function getCIStatusImpl(repo: RepoRef, prNumber: number): Promise<CIStatus | null> {
  let mr: GitLabMergeRequest;
  try {
    const { data } = await gitlabRest<GitLabMergeRequest>({
      host: repo.host,
      path: `/projects/${encodeProjectId(repo)}/merge_requests/${prNumber}`,
    });
    mr = data;
  } catch (err) {
    return nullOn404<CIStatus>(err);
  }
  const state = pipelineStatusToCIState(mr.head_pipeline?.status);
  if (!state || !mr.head_pipeline) return null;
  return {
    state,
    total: 1,
    passed: state === "success" ? 1 : 0,
    failed: state === "failure" ? 1 : 0,
    pending: state === "pending" ? 1 : 0,
    rawData: mr.head_pipeline,
  };
}

export async function getRepoMetadataImpl(repo: RepoRef): Promise<RepoMetadata> {
  const { data } = await gitlabRest<GitLabProject>({
    host: repo.host,
    path: `/projects/${encodeProjectId(repo)}`,
    query: { license: true },
  });
  return {
    defaultBranch: data.default_branch ?? "main",
    isPrivate: data.visibility !== "public",
    isFork: data.forked_from_project != null,
    isArchived: data.archived === true,
    description: data.description ?? null,
    license: data.license?.nickname ?? data.license?.name ?? null,
    ...(Array.isArray(data.topics) ? { topics: data.topics } : {}),
    rawData: data,
  };
}

export async function listReleasesImpl(repo: RepoRef, opts: ListOptions) {
  const page = await gitlabRestPage<GitLabRelease>({
    host: repo.host,
    path: `/projects/${encodeProjectId(repo)}/releases`,
    query: {
      per_page: opts.perPage ?? 30,
      page: opts.cursor ?? "1",
    },
  });
  return {
    items: page.items.map((release) =>
      gitlabReleaseToForgeRelease(release, { host: repo.host, owner: repo.owner, repo: repo.repo })
    ),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    ...(page.totalCount !== undefined ? { totalCount: page.totalCount } : {}),
  };
}

export async function getLatestReleaseImpl(repo: RepoRef) {
  try {
    const { data } = await gitlabRest<GitLabRelease>({
      host: repo.host,
      path: `/projects/${encodeProjectId(repo)}/releases/permalink/latest`,
    });
    return gitlabReleaseToForgeRelease(data, {
      host: repo.host,
      owner: repo.owner,
      repo: repo.repo,
    });
  } catch (err) {
    // Older instances (pre-13.12) lack the permalink route; 404 also means
    // "no releases yet". Either way fall back to the newest list entry.
    if (!(err instanceof GitLabApiError && err.status === 404)) throw err;
  }
  const page = await listReleasesImpl(repo, { perPage: 1 });
  return page.items[0] ?? null;
}

export async function getIssueTooltipImpl(
  repo: RepoRef,
  issueNumber: number
): Promise<IssueTooltipData | null> {
  const key = tooltipKey(repo, issueNumber);
  const cached = cacheGet(issueTooltipCache, key, TOOLTIP_CACHE_TTL_MS);
  if (cached !== undefined) return cached;
  try {
    const issue = await getIssueImpl(repo, issueNumber);
    const tooltip = issue ? issueToTooltipData(issue) : null;
    issueTooltipCache.set(key, { value: tooltip, at: Date.now() });
    return tooltip;
  } catch {
    return null;
  }
}

export async function getPRTooltipImpl(
  repo: RepoRef,
  prNumber: number
): Promise<PRTooltipData | null> {
  const key = tooltipKey(repo, prNumber);
  const cached = cacheGet(prTooltipCache, key, TOOLTIP_CACHE_TTL_MS);
  if (cached !== undefined) return cached;
  try {
    const pr = await getPRImpl(repo, prNumber);
    const tooltip = pr ? prToTooltipData(pr, repo.host) : null;
    prTooltipCache.set(key, { value: tooltip, at: Date.now() });
    return tooltip;
  } catch {
    return null;
  }
}

/**
 * Commit-author avatar via the public `/avatar?email=` endpoint on the
 * configured instance. Works unauthenticated (it falls back to Gravatar
 * server-side), cached per email.
 */
export async function resolveAuthorAvatarImpl(
  instanceHost: string,
  email: string
): Promise<string | null> {
  const key = email.trim().toLowerCase();
  if (key.length === 0) return null;
  const cached = cacheGet(avatarCache, key, AVATAR_CACHE_TTL_MS);
  if (cached !== undefined) return cached;
  try {
    const { data } = await gitlabRest<{ avatar_url?: unknown }>({
      host: instanceHost,
      path: "/avatar",
      query: { email: key, size: 64 },
    });
    const url =
      typeof data.avatar_url === "string" && data.avatar_url.length > 0 ? data.avatar_url : null;
    avatarCache.set(key, { value: url, at: Date.now() });
    return url;
  } catch {
    avatarCache.set(key, { value: null, at: Date.now() });
    return null;
  }
}

function toStatsPage<T>(
  items: T[],
  hasMore: boolean,
  totalCount: number | undefined
): StatsPage<T> {
  return {
    items,
    endCursor: hasMore ? "2" : null,
    hasNextPage: hasMore,
    ...(totalCount !== undefined ? { totalCount } : {}),
  };
}

/**
 * Toolbar counts + first pages in two REST calls: the first page of open
 * issues and open MRs each carry `x-total`, so no separate count probes are
 * needed. Cached briefly to absorb mount bursts; `bypassCache` skips the
 * cache for explicit refreshes.
 */
export async function getRepoStatsImpl(
  repo: RepoRef,
  opts?: { bypassCache?: boolean }
): Promise<RepoStatsSnapshot> {
  const key = `${repo.host}/${repoFullPath(repo)}`;
  if (!opts?.bypassCache) {
    const cached = cacheGet(repoStatsCache, key, REPO_STATS_CACHE_TTL_MS);
    if (cached !== undefined) return { ...cached, source: "memory-cache" };
  }

  const now = Date.now();
  try {
    const [issuesPage, mrsPage] = await Promise.all([
      gitlabRestPage<GitLabIssue>({
        host: repo.host,
        path: `/projects/${encodeProjectId(repo)}/issues`,
        query: {
          state: "opened",
          per_page: STATS_FIRST_PAGE_SIZE,
          order_by: "created_at",
          sort: "desc",
        },
      }),
      gitlabRestPage<GitLabMergeRequest>({
        host: repo.host,
        path: `/projects/${encodeProjectId(repo)}/merge_requests`,
        query: {
          state: "opened",
          per_page: STATS_FIRST_PAGE_SIZE,
          order_by: "created_at",
          sort: "desc",
        },
      }),
    ]);

    const snapshot: RepoStatsSnapshot = {
      counts: {
        issueCount: issuesPage.totalCount ?? null,
        prCount: mrsPage.totalCount ?? null,
        lastUpdated: now,
        issueCountRefreshedAt: now,
        prCountRefreshedAt: now,
      },
      issues: toStatsPage(
        issuesPage.items.map((issue) => gitlabIssueToForgeIssue(issue, repo.host)),
        issuesPage.hasMore,
        issuesPage.totalCount
      ),
      prs: toStatsPage(
        mrsPage.items.map((mr) => mergeRequestToForgePR(mr, repo.host)),
        mrsPage.hasMore,
        mrsPage.totalCount
      ),
      source: "network",
    };
    repoStatsCache.set(key, { value: snapshot, at: now });
    return snapshot;
  } catch (err) {
    const stale = repoStatsCache.get(key)?.value;
    const message = formatErrorMessage(err, "GitLab request failed");
    if (stale) {
      return {
        ...stale,
        counts: { ...stale.counts, stale: true, error: message },
        source: "memory-cache",
      };
    }
    return {
      counts: { issueCount: null, prCount: null, error: message },
      issues: null,
      prs: null,
      source: "network",
    };
  }
}

/**
 * Rate-limit projection for the CONFIGURED instance — snapshots are kept per
 * host so an unauthenticated public-instance request can't masquerade as the
 * credentialed instance's quota.
 */
export async function getRateLimitImpl(): Promise<RateLimitInfo> {
  const snapshot = getRateLimitSnapshot(await getInstanceHost());
  return snapshot?.info ?? { limit: null, remaining: null, resetAt: null };
}
