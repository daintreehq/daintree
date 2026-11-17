import type {
  CheckRun,
  CIStatus,
  FetchOptions,
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
  GitLabJob,
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
  resetRateLimitSnapshots,
  resetReadFlights,
  resolveRequestAuth,
  type QueryValue,
} from "./GitLabClient.js";
import { BoundedCache } from "./boundedCache.js";
import { GITLAB_API_TIMEOUT_MS, getInstanceHost } from "./GitLabAuth.js";
import { encodeProjectId, repoFullPath } from "./gitlabRemote.js";
import {
  absolutizeAvatarUrl,
  gitlabIssueToForgeIssue,
  gitlabJobToCheckRun,
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
const REPO_STATS_STALE_RETAIN_MS = 5 * 60 * 1000;
const CACHE_SWEEP_INTERVAL_MS = 60_000;
/**
 * One page size for BOTH the list endpoints and the stats first page — they
 * cannot diverge. GitLab pages by NUMBER, so the `"2"` cursor the stats page
 * hands back is only meaningful at the page size that produced it, and the
 * host seeds its list cache with that cursor
 * (`src/hooks/useRepositoryStats.ts`). A smaller stats page would make the
 * first load-more skip every row between the two sizes.
 */
const DEFAULT_LIST_PAGE_SIZE = 30;

/** Branches per batched GraphQL branch→MR query. */
export const GRAPHQL_BRANCH_CHUNK_SIZE = 20;

/** Merge requests per batched GraphQL number→MR query. */
export const GRAPHQL_IID_CHUNK_SIZE = 20;

/**
 * How long a batched MR read answers later reads. Long enough for the CI read
 * that follows a PR revalidation in the same pass to reuse the pipeline status
 * the PR read just fetched; far shorter than any poll interval, so it never
 * stands in for a poll.
 */
const MERGE_REQUEST_CACHE_TTL_MS = 5_000;

const issueTooltipCache = new BoundedCache<IssueTooltipData | null>({
  maxEntries: 200,
  retainMs: TOOLTIP_CACHE_TTL_MS,
});
const prTooltipCache = new BoundedCache<PRTooltipData | null>({
  maxEntries: 200,
  retainMs: TOOLTIP_CACHE_TTL_MS,
});
const avatarCache = new BoundedCache<string | null>({
  maxEntries: 1000,
  retainMs: AVATAR_CACHE_TTL_MS,
});
/**
 * Pending `/avatar` lookups, so a burst of committer chips for one author
 * shares a single request. Cleared with the caches: a lookup started before an
 * invalidation stays with the callers that already joined it, and every later
 * caller starts its own.
 */
const avatarInflight = new Map<string, Promise<string | null>>();
/**
 * Retained past its freshness TTL so a failed refresh can fall back to the
 * last good snapshot — but only for this long after it was fetched.
 */
const repoStatsCache = new BoundedCache<RepoStatsSnapshot>({
  maxEntries: 20,
  retainMs: REPO_STATS_STALE_RETAIN_MS,
});
/**
 * One merge request as a batched GraphQL read saw it, or `null` when that read
 * confirmed there is no such MR. `ciStatus` is `undefined` when the pipeline
 * field was unreadable, which says nothing about whether CI exists.
 */
interface MergeRequestLookup {
  pr: PR;
  ciStatus: CIStatus | null | undefined;
}
/** `seq` orders entries by when their read was sent; see {@link cacheMergeRequest}. */
interface CachedMergeRequest {
  seq: number;
  lookup: MergeRequestLookup | null;
}
const mergeRequestCache = new BoundedCache<CachedMergeRequest>({
  maxEntries: 500,
  // Resident past its freshness so its `seq` still turns away an older read
  // that answers late. A read caches when its own requests settle — a GraphQL
  // query and, at worst, a REST fallback after it, each bounded by the timeout.
  retainMs: 4 * GITLAB_API_TIMEOUT_MS,
});
let mergeRequestReadSeq = 0;
/** Pending number→MR chunks, so overlapping batch reads share one query. */
const mergeRequestFlights = new Map<string, Promise<Map<number, MergeRequestLookup | null>>>();
/**
 * Hosts whose GraphQL schema can't serve the number query, so their batches go
 * straight to REST instead of failing the query first on every poll. Cleared
 * with the caches, so an upgraded instance is tried again.
 */
const restOnlyBatchHosts = new Set<string>();
const allCaches: ReadonlyArray<BoundedCache<unknown>> = [
  issueTooltipCache,
  prTooltipCache,
  avatarCache,
  repoStatsCache,
  mergeRequestCache,
];

/**
 * Bumped by every invalidation. A read that started before the bump writes its
 * result under the old generation and is dropped — clearing the maps alone
 * would let an in-flight request repopulate them a moment later with data
 * fetched under the previous credential or instance.
 */
let cacheGeneration = 0;

/**
 * Armed only while something is resident, so expired entries are released
 * even when nothing reads their keys again.
 */
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

function armSweep(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    const now = Date.now();
    for (const cache of allCaches) cache.sweep(now);
    if (allCaches.some((cache) => cache.size > 0)) armSweep();
  }, CACHE_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function clearGitLabCaches(): void {
  cacheGeneration += 1;
  for (const cache of allCaches) cache.clear();
  avatarInflight.clear();
  mergeRequestFlights.clear();
  restOnlyBatchHosts.clear();
  resetReadFlights();
  if (sweepTimer !== null) {
    clearTimeout(sweepTimer);
    sweepTimer = null;
  }
  resetRateLimitSnapshots();
}

/** Current invalidation generation, for the host's avatar IPC coalescing. */
export function getGitLabCacheGeneration(): number {
  return cacheGeneration;
}

/** Resident entry counts, for tests that assert expired entries are released. */
export function gitLabCacheSizesForTests(): Record<
  "issueTooltips" | "prTooltips" | "avatars" | "repoStats" | "mergeRequests",
  number
> {
  return {
    issueTooltips: issueTooltipCache.size,
    prTooltips: prTooltipCache.size,
    avatars: avatarCache.size,
    repoStats: repoStatsCache.size,
    mergeRequests: mergeRequestCache.size,
  };
}

/** Snapshot the generation before an await; pass it to {@link cacheSet}. */
function cacheEpoch(): number {
  return cacheGeneration;
}

function cacheSet<T>(cache: BoundedCache<T>, key: string, value: T, epoch: number): void {
  if (epoch !== cacheGeneration) return;
  cache.set(key, value);
  armSweep();
}

/**
 * Entries GitLab can't identify. Without an `iid` a row maps to "#0" with an
 * empty URL — it opens nothing and no action can target it — so it is dropped
 * rather than rendered as if it were real.
 */
function withUsableNumber<T extends { iid?: number }>(items: T[]): T[] {
  return items.filter((item) => typeof item.iid === "number");
}

function tooltipKey(repo: RepoRef, number: number): string {
  return `${repo.host}/${repoFullPath(repo)}#${number}`;
}

function listQuery(opts: ListOptions, state: string | undefined) {
  return {
    ...(state !== undefined ? { state } : {}),
    per_page: opts.perPage ?? DEFAULT_LIST_PAGE_SIZE,
    page: opts.cursor ?? "1",
    order_by: mapListOrderBy(opts.sort),
    sort: opts.direction ?? "desc",
    ...(opts.search ? { search: opts.search } : {}),
    ...(opts.labels && opts.labels.length > 0 ? { labels: opts.labels.join(",") } : {}),
    // `assignee_username[]` is the documented array type on BOTH the issues
    // and merge_requests endpoints. Grape silently drops an undeclared
    // parameter, so a wrong shape here would return an UNFILTERED list rather
    // than an error — send the form the docs declare.
    ...(opts.assignee ? { assignee_username: [opts.assignee] } : {}),
  };
}

export async function listIssuesImpl(repo: RepoRef, opts: ListOptions): Promise<Page<Issue>> {
  const page = await gitlabRestPage<GitLabIssue>({
    host: repo.host,
    path: `/projects/${encodeProjectId(repo)}/issues`,
    query: listQuery(opts, mapIssueListState(opts.state)),
    ...(opts.bypassCache ? { fresh: true } : {}),
  });
  return {
    // An entry with no `iid` maps to issue #0 with an empty URL — unopenable
    // and unactionable, so it is dropped rather than rendered as a real row.
    items: withUsableNumber(page.items).map((issue) => gitlabIssueToForgeIssue(issue, repo.host)),
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
    ...(opts.bypassCache ? { fresh: true } : {}),
  });
  return {
    items: withUsableNumber(page.items).map((mr) => mergeRequestToForgePR(mr, repo.host)),
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

export async function getIssueImpl(
  repo: RepoRef,
  number: number,
  options?: FetchOptions
): Promise<Issue | null> {
  try {
    const { data } = await gitlabRest<GitLabIssue>({
      host: repo.host,
      path: `/projects/${encodeProjectId(repo)}/issues/${number}`,
      ...(options?.fresh ? { fresh: true } : {}),
    });
    return gitlabIssueToForgeIssue(data, repo.host);
  } catch (err) {
    return nullOn404<Issue>(err);
  }
}

export async function getPRImpl(
  repo: RepoRef,
  number: number,
  options?: FetchOptions
): Promise<PR | null> {
  try {
    const { data } = await gitlabRest<GitLabMergeRequest>({
      host: repo.host,
      path: `/projects/${encodeProjectId(repo)}/merge_requests/${number}`,
      ...(options?.fresh ? { fresh: true } : {}),
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
  return first && typeof first.iid === "number" ? mergeRequestToForgePR(first, repo.host) : null;
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
        detailedMergeStatus
        userNotesCount
      }
    }
  }
}`;

interface MergeRequestsResponse {
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
  const epoch = cacheEpoch();

  for (let start = 0; start < unique.length; start += GRAPHQL_BRANCH_CHUNK_SIZE) {
    const chunk = unique.slice(start, start + GRAPHQL_BRANCH_CHUNK_SIZE);
    const seq = ++mergeRequestReadSeq;
    let response: MergeRequestsResponse;
    try {
      response = await gitlabGraphQL<MergeRequestsResponse>(repo.host, BRANCH_BATCH_QUERY, {
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
      const lookup = mergeRequestLookupFromNode(node, repo.host);
      if (!lookup) continue;
      // A newly detected MR's CI read follows within the same pass.
      cacheMergeRequest(repo, lookup.pr.number, lookup, seq, epoch);
      const pr = lookup.pr;
      if (pr.headRef.length === 0) continue;
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
  return ciStatusFromPipeline(mr.head_pipeline?.status, mr.head_pipeline) ?? null;
}

/**
 * GitLab reports one head-pipeline status rather than per-check counts, so the
 * roll-up projects that single status. `undefined` when there is no status to
 * read.
 */
function ciStatusFromPipeline(status: unknown, rawData: unknown): CIStatus | undefined {
  const state = pipelineStatusToCIState(status);
  if (!state || !rawData) return undefined;
  return {
    state,
    total: 1,
    passed: state === "success" ? 1 : 0,
    failed: state === "failure" ? 1 : 0,
    pending: state === "pending" ? 1 : 0,
    rawData,
  };
}

/** Jobs per page on a pipeline's job lists: GitLab's maximum. */
const CHECKS_PAGE_SIZE = 100;

/**
 * Ceiling on pages walked per job list by one {@link getChecksImpl} call, 1000
 * jobs, far past any real pipeline. It exists so a next-page header that never
 * runs out can't loop against a rate-limited API, and it rejects rather than
 * truncating.
 */
const MAX_CHECK_PAGES = 10;

async function listPipelineJobs(
  host: string,
  path: string,
  query: Record<string, QueryValue>,
  fresh: boolean,
  incomplete: (why: string) => Error
): Promise<GitLabJob[]> {
  const jobs: GitLabJob[] = [];
  const seenPages = new Set<string>();
  const seenIds = new Set<number>();
  let page = "1";
  for (let i = 0; i < MAX_CHECK_PAGES; i++) {
    seenPages.add(page);
    const result = await gitlabRestPage<GitLabJob>({
      host,
      path,
      query: { ...query, per_page: CHECKS_PAGE_SIZE, page },
      ...(fresh ? { fresh: true } : {}),
    });
    for (const job of result.items) {
      const id = job && typeof job === "object" ? job.id : undefined;
      // Offset pages over a list that changed between reads: a retry adds an
      // attempt at the top, so an entry read already comes round again while
      // the job it pushed down is never read at all.
      if (typeof id === "number") {
        if (seenIds.has(id)) throw incomplete("the pipeline changed mid-read");
        seenIds.add(id);
      }
      jobs.push(job);
    }
    let next = result.nextCursor;
    // A full page with no next page may be a proxy that dropped GitLab's
    // pagination headers rather than the last page; the next page settles it.
    if (next === null && result.items.length >= CHECKS_PAGE_SIZE) {
      next = String(Number.parseInt(page, 10) + 1);
    }
    if (next === null) return jobs;
    // A next page that repeats one already read would loop, or drop the rest.
    if (seenPages.has(next)) throw incomplete("pagination stalled");
    page = next;
  }
  throw incomplete(`more than ${MAX_CHECK_PAGES * CHECKS_PAGE_SIZE} jobs`);
}

/**
 * GitLab names every job in a pipeline uniquely, so two entries sharing a name
 * are attempts of one job: a retried trigger job (the bridges list documents no
 * `include_retried`), or a job retried between the job and status reads. The
 * newer attempt replaces the older in place. Entries without ids to compare are
 * all kept, since dropping one would hide a check.
 */
function latestAttempts(jobs: readonly GitLabJob[]): GitLabJob[] {
  const out: GitLabJob[] = [];
  const indexByName = new Map<string, number>();
  for (const job of jobs) {
    const name = job && typeof job === "object" ? job.name : undefined;
    const at = typeof name === "string" ? indexByName.get(name) : undefined;
    if (at === undefined) {
      if (typeof name === "string") indexByName.set(name, out.length);
      out.push(job);
      continue;
    }
    const keptId = out[at].id;
    if (typeof keptId === "number" && typeof job.id === "number") {
      if (job.id > keptId) out[at] = job;
    } else {
      out.push(job);
    }
  }
  return out;
}

/**
 * Per-job CI detail for one merge request: every job, trigger job and external
 * commit status in its head pipeline, the latest attempt of each.
 *
 * `null` only when the merge request doesn't exist, and `{ checks: [] }` only
 * when GitLab says it has no pipeline. Anything else that stops a complete read
 * rejects: a short list would answer "which job failed?" wrongly.
 */
export async function getChecksImpl(
  repo: RepoRef,
  prNumber: number,
  options?: FetchOptions
): Promise<{ checks: CheckRun[] } | null> {
  const fresh = options?.fresh === true;
  let mr: GitLabMergeRequest;
  try {
    const { data } = await gitlabRest<GitLabMergeRequest>({
      host: repo.host,
      path: `/projects/${encodeProjectId(repo)}/merge_requests/${prNumber}`,
      ...(fresh ? { fresh: true } : {}),
    });
    mr = data;
  } catch (err) {
    return nullOn404(err);
  }

  const incomplete = (why: string): Error =>
    new Error(`Could not read all checks for merge request !${prNumber}: ${why}`);
  if (!mr || typeof mr !== "object" || Array.isArray(mr)) {
    throw incomplete("GitLab returned an unreadable merge request");
  }

  const pipeline = mr.head_pipeline;
  // Only an explicit `null` says no pipeline has run. GitLab leaves the field
  // out for an account that can't read pipelines, and "no checks" is the wrong
  // answer to give it.
  if (pipeline === null) return { checks: [] };
  if (!pipeline || typeof pipeline !== "object") {
    throw incomplete("GitLab didn't report the merge request's pipeline");
  }
  const pipelineId = pipeline.id;
  if (typeof pipelineId !== "number" || !Number.isSafeInteger(pipelineId) || pipelineId <= 0) {
    throw incomplete("GitLab reported a pipeline with no id");
  }
  // A fork's merge request usually runs its pipeline in the fork, where the
  // pipeline id belongs to the fork's project rather than this one.
  const projectId =
    typeof pipeline.project_id === "number" &&
    Number.isSafeInteger(pipeline.project_id) &&
    pipeline.project_id > 0
      ? String(pipeline.project_id)
      : encodeProjectId(repo);
  const sha = pipeline.sha;
  if (typeof sha !== "string" || !sha) {
    throw incomplete("GitLab reported a pipeline with no commit");
  }
  const base = `/projects/${projectId}/pipelines/${pipelineId}`;
  // The commit statuses list wants a signed-in account even on a public
  // project, where the job lists don't. A read that goes out without a token
  // can only list the pipeline's own jobs; one that carries a token reads the
  // statuses too, and any failure there rejects like the rest.
  const signedIn = (await resolveRequestAuth(repo.host)).token !== null;

  const [jobs, bridges, statuses] = await Promise.all([
    listPipelineJobs(repo.host, `${base}/jobs`, { include_retried: false }, fresh, incomplete),
    listPipelineJobs(repo.host, `${base}/bridges`, {}, fresh, incomplete),
    // An external CI (Jenkins posting commit statuses) lands in the pipeline as
    // statuses neither job list returns. This list holds every kind, so only
    // the ones the job lists didn't already give are kept.
    signedIn
      ? listPipelineJobs(
          repo.host,
          `/projects/${projectId}/repository/commits/${encodeURIComponent(sha)}/statuses`,
          {
            pipeline_id: pipelineId,
            ...(typeof pipeline.ref === "string" && pipeline.ref ? { ref: pipeline.ref } : {}),
          },
          fresh,
          incomplete
        )
      : Promise.resolve<GitLabJob[]>([]),
  ]);

  const listed = new Set<number>();
  for (const job of [...jobs, ...bridges]) {
    if (job && typeof job === "object" && typeof job.id === "number") listed.add(job.id);
  }
  const external = statuses.filter((status) => {
    if (!status || typeof status !== "object") return true;
    if (typeof status.id === "number" && listed.has(status.id)) return false;
    // GitLab before 17.9 ignores `pipeline_id` and answers for every pipeline
    // on the commit.
    return status.pipeline_id === undefined || status.pipeline_id === pipelineId;
  });

  const checks: CheckRun[] = [];
  for (const job of latestAttempts([...jobs, ...bridges, ...external])) {
    const check = gitlabJobToCheckRun(job);
    if (!check) throw incomplete("GitLab returned a job with no name");
    checks.push(check);
  }
  return { checks };
}

function mergeRequestKey(repo: RepoRef, iid: number): string {
  return `${repo.host.toLowerCase()}/${repoFullPath(repo)}!${iid}`;
}

/**
 * Overlapping reads can answer out of order: an ordinary batch sent before a
 * fresh one may land after it, and must not put the older view back.
 */
function cacheMergeRequest(
  repo: RepoRef,
  iid: number,
  lookup: MergeRequestLookup | null,
  seq: number,
  epoch: number
): void {
  const key = mergeRequestKey(repo, iid);
  const existing = mergeRequestCache.peek(key);
  if (existing && existing.seq > seq) return;
  cacheSet(mergeRequestCache, key, { seq, lookup }, epoch);
}

function mergeRequestLookupFromNode(
  node: Record<string, unknown>,
  host: string
): MergeRequestLookup | null {
  const pr = graphqlMergeRequestToForgePR(node, host);
  if (!pr) return null;
  const pipeline = node.headPipeline as { status?: unknown } | null | undefined;
  // An explicit `null` is GitLab saying the MR has no head pipeline; a missing
  // or malformed field is not evidence of that.
  const ciStatus =
    pipeline === null
      ? null
      : pipeline && typeof pipeline === "object"
        ? ciStatusFromPipeline(pipeline.status, pipeline)
        : undefined;
  return { pr, ciStatus };
}

const IID_BATCH_QUERY = `
query DaintreeMRsByIids($fullPath: ID!, $iids: [String!], $first: Int) {
  project(fullPath: $fullPath) {
    mergeRequests(iids: $iids, first: $first) {
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
        detailedMergeStatus
        userNotesCount
      }
    }
  }
}`;

/**
 * A failure that says this instance can't serve the query at all, rather than
 * that this attempt didn't land: no GraphQL endpoint, or a schema older than a
 * field or argument the query uses. Other GraphQL errors (a resolver timeout,
 * a gateway page) are transient and only omit the chunk.
 */
function isUnservableBatchQuery(err: unknown): boolean {
  if (!(err instanceof GitLabApiError)) return false;
  if (err.status === 404) return true;
  return (
    err.status === 200 &&
    /doesn't exist on type|doesn't accept argument|isn't a defined input type/i.test(err.message)
  );
}

/**
 * The same answers from one REST read per MR, for an instance whose GraphQL
 * can't serve the batch. One read still carries both the MR and its pipeline.
 */
async function fetchMergeRequestsOverRest(
  repo: RepoRef,
  chunk: number[]
): Promise<Map<number, MergeRequestLookup | null>> {
  const result = new Map<number, MergeRequestLookup | null>();
  await Promise.all(
    chunk.map(async (iid) => {
      try {
        // Fresh: joining a read already in flight would cache its older view
        // under this chunk's newer `seq`.
        const { data } = await gitlabRest<GitLabMergeRequest>({
          host: repo.host,
          path: `/projects/${encodeProjectId(repo)}/merge_requests/${iid}`,
          fresh: true,
        });
        result.set(iid, {
          pr: mergeRequestToForgePR(data, repo.host),
          ciStatus: ciStatusFromPipeline(data.head_pipeline?.status, data.head_pipeline) ?? null,
        });
      } catch (err) {
        if (err instanceof GitLabApiError && err.status === 404) result.set(iid, null);
      }
    })
  );
  return result;
}

async function fetchMergeRequestChunk(
  repo: RepoRef,
  chunk: number[]
): Promise<Map<number, MergeRequestLookup | null>> {
  const host = repo.host.toLowerCase();
  if (restOnlyBatchHosts.has(host)) return fetchMergeRequestsOverRest(repo, chunk);
  const result = new Map<number, MergeRequestLookup | null>();
  const epoch = cacheEpoch();
  let response: MergeRequestsResponse;
  try {
    response = await gitlabGraphQL<MergeRequestsResponse>(repo.host, IID_BATCH_QUERY, {
      fullPath: repoFullPath(repo),
      iids: chunk.map(String),
      first: chunk.length,
    });
  } catch (err) {
    if (!isUnservableBatchQuery(err)) return result;
    if (epoch === cacheGeneration) restOnlyBatchHosts.add(host);
    return fetchMergeRequestsOverRest(repo, chunk);
  }
  const connection = response.project?.mergeRequests;
  const nodes = connection?.nodes;
  // `project: null` is no access or no such project; absence is unconfirmed.
  if (!connection || !Array.isArray(nodes)) return result;
  for (const node of nodes) {
    const lookup = mergeRequestLookupFromNode(node, repo.host);
    if (lookup && chunk.includes(lookup.pr.number)) result.set(lookup.pr.number, lookup);
  }
  if (connection.pageInfo?.hasNextPage !== true) {
    for (const iid of chunk) if (!result.has(iid)) result.set(iid, null);
  }
  return result;
}

/**
 * Merge requests by number, as one GraphQL query per
 * {@link GRAPHQL_IID_CHUNK_SIZE} rather than one REST read per MR — and the
 * same read answers both the PR and its CI, which REST fetched separately. A
 * present key is authoritative; an omitted one didn't get an answer this time.
 * `fresh` skips both the short cache and any read already in flight, which may
 * have started before the caller's last observation. Chunks run together so a
 * large set answers within one request's time.
 */
async function lookupMergeRequests(
  repo: RepoRef,
  iids: number[],
  fresh: boolean
): Promise<Map<number, MergeRequestLookup | null>> {
  const unique = [...new Set(iids.filter((n) => Number.isInteger(n) && n > 0))].sort(
    (a, b) => a - b
  );
  const result = new Map<number, MergeRequestLookup | null>();
  const epoch = cacheEpoch();
  const missing: number[] = [];
  for (const iid of unique) {
    const cached = fresh
      ? undefined
      : mergeRequestCache.get(mergeRequestKey(repo, iid), MERGE_REQUEST_CACHE_TTL_MS);
    if (cached === undefined) missing.push(iid);
    else result.set(iid, cached.lookup);
  }

  const flights: Array<Promise<Map<number, MergeRequestLookup | null>>> = [];
  for (let start = 0; start < missing.length; start += GRAPHQL_IID_CHUNK_SIZE) {
    const chunk = missing.slice(start, start + GRAPHQL_IID_CHUNK_SIZE);
    const flightKey = `${repo.host.toLowerCase()}/${repoFullPath(repo)}!${chunk.join(",")}`;
    const pending = fresh ? undefined : mergeRequestFlights.get(flightKey);
    if (pending) {
      flights.push(pending);
      continue;
    }
    const seq = ++mergeRequestReadSeq;
    // Cached once, by the flight itself: a caller that joined it may finish much
    // later, waiting on a slower chunk of its own.
    const started: Promise<Map<number, MergeRequestLookup | null>> = fetchMergeRequestChunk(
      repo,
      chunk
    )
      .then((answers) => {
        for (const [iid, lookup] of answers) cacheMergeRequest(repo, iid, lookup, seq, epoch);
        return answers;
      })
      .finally(() => {
        if (mergeRequestFlights.get(flightKey) === started) mergeRequestFlights.delete(flightKey);
      });
    mergeRequestFlights.set(flightKey, started);
    flights.push(started);
  }
  for (const answers of await Promise.all(flights)) {
    for (const [iid, lookup] of answers) result.set(iid, lookup);
  }
  return result;
}

export async function findPRsByNumbersImpl(
  repo: RepoRef,
  prNumbers: number[],
  options?: FetchOptions
): Promise<Map<number, PR | null>> {
  const lookups = await lookupMergeRequests(repo, prNumbers, options?.fresh === true);
  const result = new Map<number, PR | null>();
  for (const [iid, lookup] of lookups) result.set(iid, lookup ? lookup.pr : null);
  return result;
}

export async function getCIStatusesImpl(
  repo: RepoRef,
  prNumbers: number[]
): Promise<Map<number, CIStatus | null>> {
  const lookups = await lookupMergeRequests(repo, prNumbers, false);
  const result = new Map<number, CIStatus | null>();
  for (const [iid, lookup] of lookups) {
    if (lookup === null) result.set(iid, null);
    else if (lookup.ciStatus !== undefined) result.set(iid, lookup.ciStatus);
  }
  return result;
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
    // The MR reads carry no merge status, head commit or commit list, and the
    // merge method is project configuration rather than a per-merge choice,
    // so the host's in-app merge (#13747) has nothing to preview here.
    mergePreviewSupported: false,
    rawData: data,
  };
}

export async function listReleasesImpl(repo: RepoRef, opts: ListOptions) {
  const page = await gitlabRestPage<GitLabRelease>({
    host: repo.host,
    path: `/projects/${encodeProjectId(repo)}/releases`,
    query: {
      per_page: opts.perPage ?? DEFAULT_LIST_PAGE_SIZE,
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
    // Older instances (pre-14.10) lack the permalink route; 404 also means
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
  const cached = issueTooltipCache.get(key, TOOLTIP_CACHE_TTL_MS);
  if (cached !== undefined) return cached;
  const epoch = cacheEpoch();
  try {
    const issue = await getIssueImpl(repo, issueNumber);
    const tooltip = issue ? issueToTooltipData(issue) : null;
    cacheSet(issueTooltipCache, key, tooltip, epoch);
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
  const cached = prTooltipCache.get(key, TOOLTIP_CACHE_TTL_MS);
  if (cached !== undefined) return cached;
  const epoch = cacheEpoch();
  try {
    const pr = await getPRImpl(repo, prNumber);
    const tooltip = pr ? prToTooltipData(pr, repo.host) : null;
    cacheSet(prTooltipCache, key, tooltip, epoch);
    return tooltip;
  } catch {
    return null;
  }
}

/**
 * A failure that says nothing about the email itself — a timeout, a throttle,
 * a server error, or anything the transport didn't classify. Caching `null`
 * for one of these would blank every commit by that author for the whole
 * hour-long avatar TTL over a momentary blip.
 */
function isDefinitiveAvatarMiss(err: unknown): boolean {
  if (!(err instanceof GitLabApiError)) return false;
  return err.status !== 0 && err.status !== 429 && err.status < 500;
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
  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail.length === 0) return null;
  // Keyed by host + email: an instance-URL change must not serve avatars
  // resolved against the previous instance.
  const key = `${instanceHost.toLowerCase()}:${normalizedEmail}`;
  const cached = avatarCache.get(key, AVATAR_CACHE_TTL_MS);
  if (cached !== undefined) return cached;
  const pending = avatarInflight.get(key);
  if (pending) return pending;
  const request = fetchAuthorAvatar(instanceHost, normalizedEmail, key).finally(() => {
    if (avatarInflight.get(key) === request) avatarInflight.delete(key);
  });
  avatarInflight.set(key, request);
  return request;
}

async function fetchAuthorAvatar(
  instanceHost: string,
  normalizedEmail: string,
  key: string
): Promise<string | null> {
  const epoch = cacheEpoch();
  try {
    const { data } = await gitlabRest<{ avatar_url?: unknown }>({
      host: instanceHost,
      path: "/avatar",
      query: { email: normalizedEmail, size: 64 },
    });
    // GitLab documents this as an absolute URL — the instance's own uploads
    // path, or an external avatar service for an unknown email — which
    // absolutizeAvatarUrl passes through untouched. It runs through the same
    // helper anyway so a relative value can't reach the renderer as one.
    const url = absolutizeAvatarUrl(data.avatar_url, instanceHost) ?? null;
    cacheSet(avatarCache, key, url, epoch);
    return url;
  } catch (err) {
    // Only an answer the instance actually gave is worth remembering as "no
    // avatar"; a transient failure is retried on the next read instead.
    if (isDefinitiveAvatarMiss(err)) cacheSet(avatarCache, key, null, epoch);
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
  const epoch = cacheEpoch();
  if (!opts?.bypassCache) {
    const cached = repoStatsCache.get(key, REPO_STATS_CACHE_TTL_MS);
    if (cached !== undefined) return { ...cached, source: "memory-cache" };
  }

  const now = Date.now();
  try {
    const [issuesPage, mrsPage] = await Promise.all([
      // The default list query, so a first-page list read in flight at the
      // same moment joins this request rather than repeating it.
      gitlabRestPage<GitLabIssue>({
        host: repo.host,
        path: `/projects/${encodeProjectId(repo)}/issues`,
        query: listQuery({}, mapIssueListState("open")),
        ...(opts?.bypassCache ? { fresh: true } : {}),
      }),
      gitlabRestPage<GitLabMergeRequest>({
        host: repo.host,
        path: `/projects/${encodeProjectId(repo)}/merge_requests`,
        query: listQuery({}, mapMRListState("open")),
        ...(opts?.bypassCache ? { fresh: true } : {}),
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
        withUsableNumber(issuesPage.items).map((issue) =>
          gitlabIssueToForgeIssue(issue, repo.host)
        ),
        issuesPage.hasMore,
        issuesPage.totalCount
      ),
      prs: toStatsPage(
        withUsableNumber(mrsPage.items).map((mr) => mergeRequestToForgePR(mr, repo.host)),
        mrsPage.hasMore,
        mrsPage.totalCount
      ),
      source: "network",
    };
    cacheSet(repoStatsCache, key, snapshot, epoch);
    return snapshot;
  } catch (err) {
    const stale = repoStatsCache.peek(key);
    const message = formatErrorMessage(err, "GitLab request failed");
    // A 429 is a block with a known end, not a generic failure: the host
    // renders its rate-limit banner and paces its polling off these fields,
    // and gets neither from an error string. GitLab has no equivalent of
    // GitHub's secondary abuse throttle, so the kind is always the quota.
    const rateLimit =
      err instanceof GitLabApiError && err.status === 429
        ? {
            rateLimitKind: "primary" as const,
            ...(err.rateLimitResetAt !== undefined
              ? { rateLimitResetAt: err.rateLimitResetAt }
              : {}),
          }
        : {};
    if (stale) {
      return {
        ...stale,
        counts: { ...stale.counts, stale: true, error: message, ...rateLimit },
        source: "memory-cache",
      };
    }
    return {
      counts: { issueCount: null, prCount: null, error: message, ...rateLimit },
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
