import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { GitHubAuth, GITHUB_API_TIMEOUT_MS } from "./GitHubAuth.js";
import {
  LIST_PRS_QUERY,
  SEARCH_QUERY,
  GET_PR_QUERY,
  GET_PR_REVIEW_THREADS_QUERY,
  buildBatchRequiredChecksQuery,
  buildBatchPRsQuery,
  GRAPHQL_BATCH_CHUNK_SIZE,
} from "./GitHubQueries.js";
import { gitHubRateLimitService } from "./GitHubRateLimitService.js";
import { parseGitHubError } from "./GitHubErrors.js";
import { withRepoContextRetry } from "./GitHubRepoContext.js";
import {
  repoStatsCache,
  repoStatsAndPageSnapshotCache,
  restCountsCache,
  bumpETagCacheVersion,
  prListCache,
  prTooltipCache,
  prTooltipWrittenAt,
  reviewThreadsCache,
  prRequiredStatusCache,
  truncateBody,
  isoToEpochMs,
  getRepoListEpoch,
  MAX_REVIEW_THREAD_PAGES,
  REVIEW_THREADS_PER_PAGE,
  type PRRequiredStatusEntry,
} from "./GitHubCaches.js";
import { GitHubStatsCache } from "./GitHubStatsCache.js";
import {
  deriveRequiredCIStatus,
  deriveGlobalCIStatus,
  normalizeRawState,
} from "./prRequiredCIStatus.js";
import type { RollupContextNode, GlobalCIDeriveInput } from "./prRequiredCIStatus.js";
import type { GitHubPR, GitHubListOptions, GitHubListResponse } from "../shared/types.js";
import type {
  ForgeLabel,
  ForgeUser,
  NormalizedPRState,
  PRTooltipData,
} from "../../../../shared/types/forge.js";
import type { RepoContext, RepoStats } from "./types.js";

/** Page size used when a caller names none. Mirrored by the action's default. */
export const DEFAULT_LIST_PER_PAGE = 20;

/** GitHub's GraphQL connections cap `first:` at 100. */
const MAX_LIST_PER_PAGE = 100;

/**
 * Collapse a requested page size onto the value actually sent to GitHub, so the
 * cache key and the query can never disagree: an omitted `perPage` and an
 * explicit `20` are the same request and must share a cache entry, while an
 * out-of-range value is clamped rather than sent on to be rejected.
 */
export function normalizeListPerPage(perPage: number | undefined): number {
  if (typeof perPage !== "number" || !Number.isFinite(perPage)) return DEFAULT_LIST_PER_PAGE;
  const truncated = Math.trunc(perPage);
  if (truncated < 1) return 1;
  if (truncated > MAX_LIST_PER_PAGE) return MAX_LIST_PER_PAGE;
  return truncated;
}

/** Anything that isn't an explicit ascending request sorts newest-first. */
export function normalizeListDirection(direction: string | undefined): "asc" | "desc" {
  return direction === "asc" ? "asc" : "desc";
}

/** GitHub orders issue/PR connections by creation or update time only. */
export function normalizeListSortOrder(sort: string | undefined): "created" | "updated" {
  return sort === "updated" ? "updated" : "created";
}

/**
 * Cache/in-flight identity for one list page. EVERY option that changes what
 * the provider fetches must appear here — a key missing a dimension hands the
 * second caller the first caller's payload off the shared `dedupe()` promise
 * (#11527 for `perPage`/`direction`, which were readable by `readOps` long
 * before the action could set them).
 *
 * Takes named fields rather than positionals: the tuple is now long enough that
 * a transposed pair would silently produce a plausible-but-wrong key.
 *
 * The `${type}:${owner}/${repo}:` prefix is load-bearing — `GitHubCaches` sweeps
 * a repo's pages by prefix match, so nothing repo-identifying may move after it.
 */
export function buildListCacheKey(params: {
  type: "issue" | "pr";
  owner: string;
  repo: string;
  state: string;
  search: string;
  sortOrder: string;
  direction: string;
  perPage: number;
  cursor: string;
}): string {
  const { type, owner, repo, state, search, sortOrder, direction, perPage, cursor } = params;
  // `cursor` stays last: it is an opaque provider blob that may itself contain
  // the separator, so no fixed-width field may follow it.
  return `${type}:${owner}/${repo}:${state}:${search}:${sortOrder}:${direction}:${perPage}:${cursor}`;
}

export function updateRepoStatsCount(cacheKey: string, type: "issue" | "pr", count: number): void {
  const now = Date.now();
  const cached = repoStatsCache.get(cacheKey);
  // Stamp only the updated kind's refreshed-at: a PR list write-back says
  // nothing about the issue count, and a shared stamp would make a stale
  // issue count look freshly read — outranking a real issue-list observation
  // in the renderer arbitration and suppressing its dropdown-open refresh.
  if (cached) {
    const updated: RepoStats = {
      ...cached,
      lastUpdated: now,
    };
    if (type === "issue") {
      updated.issueCount = count;
      updated.issueCountRefreshedAt = now;
    } else {
      updated.prCount = count;
      updated.prCountRefreshedAt = now;
    }
    repoStatsCache.set(cacheKey, updated);
  } else {
    const persistentCache = GitHubStatsCache.getInstance();
    const diskCached = persistentCache.get(cacheKey);

    const newStats: RepoStats = {
      issueCount: type === "issue" ? count : (diskCached?.issueCount ?? 0),
      prCount: type === "pr" ? count : (diskCached?.prCount ?? 0),
      lastUpdated: now,
    };
    if (type === "issue") {
      newStats.issueCountRefreshedAt = now;
    } else {
      newStats.prCountRefreshedAt = now;
    }
    repoStatsCache.set(cacheKey, newStats);
  }

  // A list query's `totalCount` is a direct GitHub observation. The background
  // poll keeps re-serving `repoStatsAndPageSnapshotCache` (10 min TTL) and
  // `restCountsCache` (1 h TTL) for as long as the `/events` probe reports no
  // change, so a disagreeing entry must drop here — otherwise the next poll
  // resurrects the stale count (rolling the toolbar badge back) until the
  // entry's own TTL expires. A disagreeing snapshot's first-page items are
  // stale by the same evidence, so the whole entry goes, and dropping the
  // REST entry discards its ETag baselines, forcing the next count poll to an
  // unconditional re-read instead of a 304 replay of the stale value.
  let droppedBaseline = false;
  const snapshot = repoStatsAndPageSnapshotCache.get(cacheKey);
  if (snapshot) {
    const snapshotCount = type === "issue" ? snapshot.stats.issueCount : snapshot.stats.prCount;
    if (snapshotCount !== count) {
      repoStatsAndPageSnapshotCache.invalidate(cacheKey);
      droppedBaseline = true;
    }
  }
  const restCounts = restCountsCache.get(cacheKey);
  if (restCounts) {
    const restCount =
      type === "issue" ? restCounts.combinedCount - restCounts.prCount : restCounts.prCount;
    if (restCount !== count) {
      restCountsCache.invalidate(cacheKey);
      droppedBaseline = true;
    }
  }
  // Defend the invalidation against in-flight conditional fetches: a
  // `fetchRestCounts` that read its baseline before the drop would otherwise
  // 304-recommit the stale counts. The version bump makes its pre-commit
  // check discard the result, so the next poll re-reads unconditionally.
  if (droppedBaseline) {
    bumpETagCacheVersion();
  }
}

export function parsePRNode(node: Record<string, unknown>): GitHubPR {
  const author = node.author as { login?: string; avatarUrl?: string } | null;
  const commentsData = node.comments as { totalCount?: number };
  const merged = node.merged as boolean;
  const rawState = node.state as string;
  const headRepo = node.headRepository as { nameWithOwner?: string } | null;
  const baseRepo = node.baseRepository as { nameWithOwner?: string } | null;

  let state: "OPEN" | "CLOSED" | "MERGED" = rawState as "OPEN" | "CLOSED" | "MERGED";
  if (merged) {
    state = "MERGED";
  }

  const headName = headRepo?.nameWithOwner;
  const baseName = baseRepo?.nameWithOwner;
  const isFork = headName && baseName ? headName !== baseName : undefined;

  const commitsData = node.commits as
    | {
        nodes?: Array<{
          commit?: {
            statusCheckRollup?: { state?: string; contexts?: Record<string, unknown> } | null;
          } | null;
        }>;
      }
    | undefined;
  const ciStatus = normalizeRawState(commitsData?.nodes?.[0]?.commit?.statusCheckRollup?.state);

  const reviewDecisionRaw = node.reviewDecision as string | null | undefined;
  const reviewDecision =
    reviewDecisionRaw === "APPROVED" ||
    reviewDecisionRaw === "CHANGES_REQUESTED" ||
    reviewDecisionRaw === "REVIEW_REQUIRED"
      ? reviewDecisionRaw
      : undefined;

  const mergeStateStatusRaw = node.mergeStateStatus as string | null | undefined;
  const validMergeStates = new Set([
    "BEHIND",
    "BLOCKED",
    "CLEAN",
    "DIRTY",
    "HAS_HOOKS",
    "UNKNOWN",
    "UNSTABLE",
  ]);
  const mergeStateStatus =
    mergeStateStatusRaw && validMergeStates.has(mergeStateStatusRaw.toUpperCase())
      ? (mergeStateStatusRaw.toUpperCase() as GitHubPR["mergeStateStatus"])
      : undefined;

  const rollupContexts = commitsData?.nodes?.[0]?.commit?.statusCheckRollup?.contexts as
    GlobalCIDeriveInput | undefined;
  const globalDerived = deriveGlobalCIStatus({
    checkRunCountsByState: rollupContexts?.checkRunCountsByState,
    statusContextCountsByState: rollupContexts?.statusContextCountsByState,
    checkRunCount: rollupContexts?.checkRunCount,
    statusContextCount: rollupContexts?.statusContextCount,
    mergeStateStatus,
  });

  return {
    number: node.number as number,
    title: node.title as string,
    url: node.url as string,
    state,
    isDraft: (node.isDraft as boolean) ?? false,
    updatedAt: node.updatedAt as string,
    author: {
      login: author?.login ?? "unknown",
      avatarUrl: author?.avatarUrl ?? "",
    },
    commentCount: commentsData?.totalCount,
    headRefName: (node.headRefName as string) || undefined,
    isFork: isFork ?? undefined,
    ciStatus,
    reviewDecision,
    mergeStateStatus,
    globalCIStatus: globalDerived.ciStatus,
    globalCISummary: globalDerived.ciSummary,
    bodyText: (node.bodyText as string) || undefined,
  };
}

export function mapPRStates(state?: string): string[] {
  if (!state || state === "open") return ["OPEN"];
  if (state === "closed") return ["CLOSED"];
  if (state === "merged") return ["MERGED"];
  if (state === "all") return ["OPEN", "CLOSED", "MERGED"];
  return ["OPEN"];
}

const inFlightPRTooltips = new Map<string, Promise<PRTooltipData | null>>();

/** GraphQL `{ login, avatarUrl }` actor node → forge {@link ForgeUser} tooltip projection. */
function toTooltipUser(node: { login?: string; avatarUrl?: string } | null | undefined): ForgeUser {
  return { login: node?.login ?? "unknown", avatarUrl: node?.avatarUrl ?? "", rawData: null };
}

function toTooltipLabels(
  nodes: Array<{ name?: string; color?: string }> | undefined
): ForgeLabel[] {
  return (nodes ?? []).filter(Boolean).map((l) => ({ name: l.name ?? "", color: l.color ?? "" }));
}

function normalizeTooltipPRState(rawState: string, merged: boolean): NormalizedPRState {
  if (merged) return "merged";
  const upper = rawState.toUpperCase();
  if (upper === "CLOSED") return "closed";
  if (upper === "MERGED") return "merged";
  return "open";
}

/**
 * Context-variant core of {@link getPRTooltip}. Network errors propagate so
 * the cwd wrapper's repo-context retry can classify them; capability callers
 * (forge `tooltips`) catch and return `null` themselves.
 */
export async function getPRTooltipForContext(
  context: RepoContext,
  prNumber: number
): Promise<PRTooltipData | null> {
  const client = GitHubAuth.createClient();
  if (!client) {
    return null;
  }

  const cacheKey = `${context.owner}/${context.repo}:${prNumber}`;
  const cached = prTooltipCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const inFlight = inFlightPRTooltips.get(cacheKey);
  if (inFlight) return inFlight;

  const requestedAt = Date.now();
  const promise = (async () => {
    const response = (await client(GET_PR_QUERY, {
      owner: context.owner,
      repo: context.repo,
      number: prNumber,
      request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
    })) as GraphQlQueryResponseData;

    gitHubRateLimitService.updateFromGraphQL(response, "GET_PR_QUERY");

    const pr = response?.repository?.pullRequest;
    if (!pr) {
      return null;
    }

    const author = pr.author as { login?: string; avatarUrl?: string } | null;
    const assigneesData = pr.assignees as {
      nodes?: Array<{ login?: string; avatarUrl?: string }>;
    };
    const labelsData = pr.labels as { nodes?: Array<{ name?: string; color?: string }> };
    const merged = (pr.merged as boolean) ?? false;
    const rawState = (pr.state as string) ?? "OPEN";

    const tooltipData: PRTooltipData = {
      number: pr.number as number,
      title: pr.title as string,
      bodyExcerpt: truncateBody(pr.bodyText as string | null),
      state: normalizeTooltipPRState(rawState, merged),
      rawState,
      isDraft: (pr.isDraft as boolean) ?? false,
      createdAt: isoToEpochMs(pr.createdAt),
      author: toTooltipUser(author),
      assignees: (assigneesData?.nodes ?? []).filter(Boolean).map(toTooltipUser),
      labels: toTooltipLabels(labelsData?.nodes),
    };

    const existing = prTooltipWrittenAt.get(cacheKey);
    if (existing === undefined || requestedAt >= existing) {
      prTooltipCache.set(cacheKey, tooltipData);
      prTooltipWrittenAt.set(cacheKey, requestedAt);
    }
    return tooltipData;
  })();

  inFlightPRTooltips.set(cacheKey, promise);
  promise.then(
    () => {
      inFlightPRTooltips.delete(cacheKey);
    },
    () => {
      inFlightPRTooltips.delete(cacheKey);
    }
  );

  return promise;
}

export async function getPRTooltip(cwd: string, prNumber: number): Promise<PRTooltipData | null> {
  try {
    return await withRepoContextRetry(cwd, (context) => getPRTooltipForContext(context, prNumber));
  } catch {
    return null;
  }
}

async function enrichPRsWithRequiredStatus(
  context: RepoContext,
  prs: GitHubPR[],
  client: NonNullable<ReturnType<typeof GitHubAuth.createClient>>,
  bypassCache = false
): Promise<GitHubPR[]> {
  const candidates = prs.filter(
    (pr) => pr.state === "OPEN" && pr.ciStatus !== undefined && pr.ciSummary === undefined
  );
  if (candidates.length === 0) return prs;

  const cacheKeyFor = (n: number) => `${context.owner}/${context.repo}:${n}`;
  const numbersToFetch: number[] = [];
  const cached = new Map<number, PRRequiredStatusEntry>();

  for (const pr of candidates) {
    const hit = bypassCache ? undefined : prRequiredStatusCache.get(cacheKeyFor(pr.number));
    if (hit) {
      cached.set(pr.number, hit);
    } else {
      numbersToFetch.push(pr.number);
    }
  }

  let fetched = new Map<number, PRRequiredStatusEntry>();
  if (numbersToFetch.length > 0) {
    try {
      const query = buildBatchRequiredChecksQuery(context.owner, context.repo, numbersToFetch);
      if (query) {
        const response = (await client(query, {
          request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
        })) as Record<string, unknown>;
        gitHubRateLimitService.updateFromGraphQL(response, "BATCH_REQUIRED_CHECKS_QUERY");
        fetched = parseBatchRequiredChecksResponse(response, numbersToFetch);
        for (const [num, entry] of fetched) {
          prRequiredStatusCache.set(cacheKeyFor(num), entry);
        }
      }
    } catch {
      // Best-effort — fall through; PRs keep their raw ciStatus and no ciSummary.
    }
  }

  return prs.map((pr) => {
    const entry = cached.get(pr.number) ?? fetched.get(pr.number);
    if (!entry) return pr;
    return {
      ...pr,
      ciStatus: entry.ciStatus ?? pr.ciStatus,
      ciSummary: entry.ciSummary,
    };
  });
}

export function parseBatchRequiredChecksResponse(
  data: Record<string, unknown>,
  prNumbers: number[]
): Map<number, PRRequiredStatusEntry> {
  const out = new Map<number, PRRequiredStatusEntry>();
  for (const num of prNumbers) {
    const alias = `pr_${num}`;
    const repo = data?.[alias] as
      | {
          pullRequest?: {
            commits?: {
              nodes?: Array<{
                commit?: {
                  statusCheckRollup?: {
                    state?: string | null;
                    contexts?: {
                      pageInfo?: { hasNextPage?: boolean };
                      nodes?: RollupContextNode[];
                    };
                  } | null;
                } | null;
              }>;
            };
          };
        }
      | undefined;
    const rollup = repo?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    if (!rollup) continue;
    const derived = deriveRequiredCIStatus(
      rollup.contexts?.nodes,
      rollup.contexts?.pageInfo?.hasNextPage ?? false,
      rollup.state
    );
    out.set(num, { ciStatus: derived.ciStatus, ciSummary: derived.ciSummary });
  }
  return out;
}

function prewarmPRTooltips(
  owner: string,
  repo: string,
  nodes: Array<Record<string, unknown>>
): void {
  const requestedAt = Date.now();
  for (const node of nodes) {
    const num = node.number as number;
    if (!num) continue;
    const cacheKey = `${owner}/${repo}:${num}`;
    const existing = prTooltipWrittenAt.get(cacheKey);
    if (existing !== undefined && requestedAt < existing) continue;
    const author = node.author as { login?: string; avatarUrl?: string } | null;
    const assigneesData = node.assignees as {
      nodes?: Array<{ login?: string; avatarUrl?: string }>;
    };
    const labelsData = node.labels as { nodes?: Array<{ name?: string; color?: string }> };
    const merged = (node.merged as boolean) ?? false;
    const rawState = (node.state as string) ?? "OPEN";
    prTooltipCache.set(cacheKey, {
      number: num,
      title: node.title as string,
      bodyExcerpt: truncateBody(node.bodyText as string | null),
      state: normalizeTooltipPRState(rawState, merged),
      rawState,
      isDraft: (node.isDraft as boolean) ?? false,
      createdAt: isoToEpochMs(node.createdAt),
      author: toTooltipUser(author),
      assignees: (assigneesData?.nodes ?? []).filter(Boolean).map(toTooltipUser),
      labels: toTooltipLabels(labelsData?.nodes),
    });
    prTooltipWrittenAt.set(cacheKey, requestedAt);
  }
}

export async function listPullRequests(
  options: GitHubListOptions
): Promise<GitHubListResponse<GitHubPR>> {
  const client = GitHubAuth.createClient();
  if (!client) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }

  const resolvedSortOrder = options.sortOrder ?? "created";
  const orderBy = {
    field: resolvedSortOrder === "updated" ? "UPDATED_AT" : "CREATED_AT",
    direction: "DESC",
  };

  return withRepoContextRetry(options.cwd, async (context) => {
    const cacheKey = buildListCacheKey({
      type: "pr",
      owner: context.owner,
      repo: context.repo,
      state: options.state ?? "open",
      search: options.search ?? "",
      sortOrder: resolvedSortOrder,
      // This legacy path pins both: `orderBy.direction` is hardcoded DESC above
      // and every query below requests `limit: 20`.
      direction: "desc",
      perPage: DEFAULT_LIST_PER_PAGE,
      cursor: options.cursor ?? "",
    });

    if (!options.search && !options.bypassCache) {
      const cached = prListCache.get(cacheKey);
      if (cached) return cached;
    }

    // Captured before the network call: if the count-as-cache-buster bumps
    // the epoch mid-flight, this page predates the observed change and must
    // not repopulate the just-busted cache.
    const epochAtStart = getRepoListEpoch("pr", context.owner, context.repo);

    try {
      let result: GitHubListResponse<GitHubPR>;

      if (options.search) {
        let stateFilter = "";
        if (options.state === "open") stateFilter = "is:open";
        else if (options.state === "closed") stateFilter = "is:closed is:unmerged";
        else if (options.state === "merged") stateFilter = "is:merged";

        const sortQualifier =
          resolvedSortOrder === "updated" ? "sort:updated-desc" : "sort:created-desc";
        const searchQuery =
          `repo:${context.owner}/${context.repo} is:pr ${stateFilter} ${sortQualifier} ${options.search}`.trim();

        const response = (await client(SEARCH_QUERY, {
          searchQuery,
          type: "ISSUE",
          cursor: options.cursor,
          limit: 20,
          request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
        })) as GraphQlQueryResponseData;

        gitHubRateLimitService.updateFromGraphQL(response, "SEARCH_PRS_QUERY");

        const search = response?.search;
        const nodes = (search?.nodes ?? []) as Array<Record<string, unknown>>;
        const filteredNodes = nodes.filter(Boolean);

        prewarmPRTooltips(context.owner, context.repo, filteredNodes);

        const parsedItems = filteredNodes.map(parsePRNode);
        const enrichedItems = await enrichPRsWithRequiredStatus(
          context,
          parsedItems,
          client,
          options.bypassCache ?? false
        );
        result = {
          items: enrichedItems,
          pageInfo: {
            hasNextPage: search?.pageInfo?.hasNextPage ?? false,
            endCursor: search?.pageInfo?.endCursor ?? null,
          },
        };
      } else {
        const states = mapPRStates(options.state);

        const response = (await client(LIST_PRS_QUERY, {
          owner: context.owner,
          repo: context.repo,
          states,
          cursor: options.cursor,
          limit: 20,
          orderBy,
          request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
        })) as GraphQlQueryResponseData;

        gitHubRateLimitService.updateFromGraphQL(response, "LIST_PRS_QUERY");

        if (!response?.repository) {
          throw new Error("Repository not found or token lacks access.");
        }

        const pullRequests = response?.repository?.pullRequests;
        const nodes = (pullRequests?.nodes ?? []) as Array<Record<string, unknown>>;
        const totalCount = (pullRequests?.totalCount as number) ?? undefined;
        const filteredNodes = nodes.filter(Boolean);

        prewarmPRTooltips(context.owner, context.repo, filteredNodes);

        const parsedItems = filteredNodes.map(parsePRNode);
        const enrichedItems = await enrichPRsWithRequiredStatus(
          context,
          parsedItems,
          client,
          options.bypassCache ?? false
        );
        result = {
          items: enrichedItems,
          pageInfo: {
            hasNextPage: pullRequests?.pageInfo?.hasNextPage ?? false,
            endCursor: pullRequests?.pageInfo?.endCursor ?? null,
          },
          totalCount,
        };

        // Mid-flight count-buster guard — see `getRepoListEpoch`. The stats
        // updates sit behind the same guard: a response too old to repopulate
        // the list cache is also too old to roll `repoStatsCache` (or the
        // disk stats) back to its pre-change total under a fresh
        // `lastUpdated`.
        if (getRepoListEpoch("pr", context.owner, context.repo) === epochAtStart) {
          prListCache.set(cacheKey, result);

          if (
            (!options.state || options.state === "open") &&
            !options.cursor &&
            totalCount !== undefined
          ) {
            const statsCacheKey = `${context.owner}/${context.repo}`;
            updateRepoStatsCount(statsCacheKey, "pr", totalCount);

            const memoryStats = repoStatsCache.get(statsCacheKey);
            if (memoryStats && memoryStats.issueCount > 0 && memoryStats.prCount > 0) {
              const persistentCache = GitHubStatsCache.getInstance();
              persistentCache.set(
                statsCacheKey,
                {
                  issueCount: memoryStats.issueCount,
                  prCount: memoryStats.prCount,
                },
                options.cwd
              );
            }
          }
        }
      }

      return result;
    } catch (error) {
      throw new Error(parseGitHubError(error));
    }
  });
}

export async function getPRByNumber(cwd: string, prNumber: number): Promise<GitHubPR | null> {
  const client = GitHubAuth.createClient();
  if (!client) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }

  try {
    return await withRepoContextRetry(cwd, async (context) => {
      const response = (await client(GET_PR_QUERY, {
        owner: context.owner,
        repo: context.repo,
        number: prNumber,
        request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
      })) as GraphQlQueryResponseData;

      gitHubRateLimitService.updateFromGraphQL(response, "GET_PR_QUERY");

      const pr = response?.repository?.pullRequest;
      if (!pr) {
        return null;
      }

      return parsePRNode(pr as Record<string, unknown>);
    });
  } catch (error) {
    const message = (error as Error).message || "";
    if (message === "Not a GitHub repository") {
      throw error;
    }
    if (message.includes("Could not resolve to") || message.includes("Could not resolve")) {
      return null;
    }
    throw new Error(parseGitHubError(error));
  }
}

/**
 * Context-variant core of {@link getPRsByNumbers}. Results align with the
 * positive-integer-filtered input order; errors propagate so the cwd wrapper's
 * repo-context retry and error classification stay in charge.
 */
export async function getPRsByNumbersForContext(
  context: RepoContext,
  numbers: number[]
): Promise<Array<GitHubPR | null>> {
  const client = GitHubAuth.createClient();
  if (!client) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }

  const valid = numbers.filter((n) => typeof n === "number" && Number.isInteger(n) && n > 0);
  if (valid.length === 0) return [];

  const results: Array<GitHubPR | null> = [];

  for (let i = 0; i < valid.length; i += GRAPHQL_BATCH_CHUNK_SIZE) {
    const chunk = valid.slice(i, i + GRAPHQL_BATCH_CHUNK_SIZE);
    const query = buildBatchPRsQuery(context.owner, context.repo, chunk);
    if (!query) continue;

    const response = (await client(query, {
      request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
    })) as GraphQlQueryResponseData;

    gitHubRateLimitService.updateFromGraphQL(response);

    const repo = response?.repository as Record<string, unknown> | undefined;
    for (const num of chunk) {
      const alias = `p${num}`;
      const node = repo?.[alias] as Record<string, unknown> | null;
      results.push(node ? parsePRNode(node) : null);
    }
  }

  return results;
}

export async function getPRsByNumbers(
  cwd: string,
  numbers: number[]
): Promise<Array<GitHubPR | null>> {
  const client = GitHubAuth.createClient();
  if (!client) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }

  const valid = numbers.filter((n) => typeof n === "number" && Number.isInteger(n) && n > 0);
  if (valid.length === 0) return [];

  try {
    return await withRepoContextRetry(cwd, (context) =>
      getPRsByNumbersForContext(context, numbers)
    );
  } catch (error) {
    const message = (error as Error).message || "";
    if (message === "Not a GitHub repository") {
      throw error;
    }
    if (message.includes("Could not resolve to") || message.includes("Could not resolve")) {
      return [];
    }
    throw new Error(parseGitHubError(error));
  }
}

export async function getPRReviewThreads(
  cwd: string,
  prNumber: number
): Promise<Record<string, number>> {
  const client = GitHubAuth.createClient();
  if (!client) {
    return {};
  }

  try {
    return await withRepoContextRetry(cwd, async (context) => {
      const cacheKey = `${context.owner}/${context.repo}:${prNumber}`;
      const cached = reviewThreadsCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      const allThreads: Array<{ path: string; isResolved: boolean; isOutdated: boolean }> = [];
      let cursor: string | null = null;
      let hasNextPage = true;
      let pageCount = 0;

      while (hasNextPage) {
        const response = (await client(GET_PR_REVIEW_THREADS_QUERY, {
          owner: context.owner,
          repo: context.repo,
          number: prNumber,
          cursor,
          request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
        })) as GraphQlQueryResponseData;

        gitHubRateLimitService.updateFromGraphQL(response, "GET_PR_REVIEW_THREADS_QUERY");

        const threads = response?.repository?.pullRequest?.reviewThreads;
        const nodes = (threads?.nodes ?? []) as Array<{
          path?: string;
          isResolved?: boolean;
          isOutdated?: boolean;
        }>;

        for (const node of nodes) {
          if (typeof node.path === "string") {
            allThreads.push({
              path: node.path,
              isResolved: node.isResolved ?? false,
              isOutdated: node.isOutdated ?? false,
            });
          }
        }

        pageCount++;
        hasNextPage = !!(threads?.pageInfo?.hasNextPage && threads?.pageInfo?.endCursor);
        cursor = threads?.pageInfo?.endCursor ?? null;

        if (pageCount >= MAX_REVIEW_THREAD_PAGES) {
          break;
        }
      }

      const counts: Record<string, number> = Object.create(null);
      for (const thread of allThreads) {
        if (!thread.isResolved && !thread.isOutdated) {
          counts[thread.path] = (counts[thread.path] ?? 0) + 1;
        }
      }

      if (pageCount >= MAX_REVIEW_THREAD_PAGES && hasNextPage) {
        counts.__clampedAt = MAX_REVIEW_THREAD_PAGES * REVIEW_THREADS_PER_PAGE;
      }

      reviewThreadsCache.set(cacheKey, counts);
      return counts;
    });
  } catch (err) {
    console.warn("Failed to fetch PR review threads", err);
    return {};
  }
}
