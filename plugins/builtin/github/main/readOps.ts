import type { GraphQlQueryResponseData } from "@octokit/graphql";
import type {
  CIStatus,
  Issue,
  IssueTooltipData,
  ListOptions,
  Page,
  PR,
  PRListProbeResult,
  PRSnapshot,
  PRTooltipData,
  PushErrorClassification,
  RateLimitInfo,
  RepoMetadata,
  RepoRef,
  ReviewThread,
} from "../../../../shared/types/forge.js";
import { GitHubAuth } from "./GitHubAuth.js";
import {
  LIST_ISSUES_QUERY,
  LIST_PRS_QUERY,
  SEARCH_QUERY,
  GET_ISSUE_QUERY,
  GET_PR_QUERY,
  GET_PR_REVIEW_THREADS_QUERY,
  REPO_METADATA_QUERY,
  PR_CI_STATUS_QUERY,
  BATCH_BRANCH_CHUNK_SIZE,
  GRAPHQL_BATCH_CHUNK_SIZE,
  buildBatchBranchPRQuery,
  buildBatchPRsQuery,
  buildBatchRequiredChecksQuery,
} from "./GitHubQueries.js";
import { gitHubRateLimitService } from "./GitHubRateLimitService.js";
import {
  forgeIssueListCache,
  forgePRListCache,
  getRepoListEpoch,
  issueTooltipCache,
  prRequiredStatusCache,
  truncateBody,
  writePRTooltip,
  MAX_REVIEW_THREAD_PAGES,
  type PRRequiredStatusEntry,
} from "./GitHubCaches.js";
import { probeOpenPRList } from "./GitHubPRDiscovery.js";
import { deriveRequiredCIStatus } from "./prRequiredCIStatus.js";
import type { RollupContextNode } from "./prRequiredCIStatus.js";
import { getIssuesByNumbersForContext } from "./GitHubIssues.js";
import {
  buildListCacheKey,
  parseBatchRequiredChecksResponse,
  updateRepoStatsCount,
} from "./GitHubPRs.js";
import {
  mapIssueGraphQLStates,
  mapPRGraphQLStates,
  toForgeIssue,
  toForgePR,
  gitHubIssueToForgeIssue,
} from "./mappers.js";
import {
  dedupe,
  runQuery,
  listIssuesInflight,
  listPRsInflight,
  getIssueInflight,
  getPRInflight,
  getCIStatusInflight,
  findPRsByBranchesInflight,
  findPRsByNumbersInflight,
  getCIStatusesInflight,
} from "./queryInfra.js";

function buildOrderBy(opts: ListOptions): { field: string; direction: string } {
  const direction = opts.direction === "asc" ? "ASC" : "DESC";
  const field = opts.sort === "updated" ? "UPDATED_AT" : "CREATED_AT";
  return { field, direction };
}

function listCacheState(opts: ListOptions): "open" | "closed" | "merged" | "all" {
  return opts.state ?? "open";
}

function issueToTooltipData(issue: Issue): IssueTooltipData {
  return {
    number: issue.number,
    title: issue.title,
    bodyExcerpt: truncateBody(issue.body),
    state: issue.state,
    rawState: issue.rawState,
    createdAt: issue.createdAt,
    author: {
      login: issue.author?.login ?? "unknown",
      avatarUrl: issue.author?.avatarUrl ?? "",
      rawData: null,
    },
    assignees: issue.assignees.map((a) => ({
      login: a.login,
      avatarUrl: a.avatarUrl ?? "",
      rawData: null,
    })),
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
  return {
    number: pr.number,
    title: pr.title,
    bodyExcerpt: truncateBody(pr.body),
    state: pr.merged ? "merged" : pr.state,
    rawState: pr.rawState,
    isDraft: pr.isDraft,
    createdAt: pr.createdAt,
    author: {
      login: pr.author?.login ?? "unknown",
      avatarUrl: pr.author?.avatarUrl ?? "",
      rawData: null,
    },
    assignees: assigneeNodes
      .filter(Boolean)
      .map((a) => ({ login: a.login ?? "unknown", avatarUrl: a.avatarUrl ?? "", rawData: null })),
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

function uniquePositiveIntegers(values: number[]): number[] {
  const unique: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0 || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function buildNumberBatchInflightKey(repo: RepoRef, numbers: number[]): string {
  return `${repo.owner}/${repo.repo}:${[...numbers].sort((a, b) => a - b).join(",")}`;
}

/**
 * Text-search path for `listIssues` — routes through GitHub's search API
 * instead of the repository issues connection. Results are typed-input
 * ephemera: they use a `search:`-prefixed in-flight dedupe key and are never
 * written to `forgeIssueListCache`, so a search response can't be served
 * later as the unfiltered background-poll list. `runQuery`'s short-TTL
 * response cache still coalesces identical search terms.
 */
async function searchIssuesImpl(
  repo: RepoRef,
  search: string,
  opts: ListOptions
): Promise<Page<Issue>> {
  const state = listCacheState(opts);
  const bypass = opts.bypassCache === true;
  const limit = opts.perPage ?? 20;
  // Free text is appended unquoted — GitHub search tokenizes it as keywords,
  // matching what its own search box does (see findPRByBranchImpl, which only
  // quotes because branch refs must not parse as separate operators). GitHub
  // caps search queries at 256 chars, so the term is truncated to the budget
  // left after the qualifiers rather than letting the whole query be rejected.
  const stateQualifier = state === "all" ? "" : ` state:${state}`;
  const sortQualifier = opts.sort === "updated" ? "sort:updated-desc" : "sort:created-desc";
  const prefix = `repo:${repo.owner}/${repo.repo} is:issue${stateQualifier} ${sortQualifier} `;
  const available = 256 - prefix.length;
  const searchQuery = `${prefix}${available > 0 ? search.slice(0, available) : ""}`.trim();
  const dedupeKey = `search:${searchQuery}:${opts.cursor ?? ""}:${limit}`;

  return dedupe(listIssuesInflight, dedupeKey, bypass, async () => {
    const response = await runQuery(
      SEARCH_QUERY,
      {
        searchQuery,
        type: "ISSUE",
        cursor: opts.cursor ?? null,
        limit,
      },
      "SEARCH_QUERY",
      bypass
    );

    const result = response?.search as
      | {
          nodes?: unknown[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          issueCount?: number;
        }
      | undefined;
    const nodes = (result?.nodes ?? []) as Array<Record<string, unknown>>;
    return {
      items: nodes.filter(Boolean).map(toForgeIssue),
      nextCursor: result?.pageInfo?.endCursor ?? null,
      hasMore: result?.pageInfo?.hasNextPage ?? false,
      ...(typeof result?.issueCount === "number" ? { totalCount: result.issueCount } : {}),
    };
  });
}

export async function listIssuesImpl(repo: RepoRef, opts: ListOptions): Promise<Page<Issue>> {
  const searchTerm = opts.search?.trim();
  if (searchTerm) return searchIssuesImpl(repo, searchTerm, opts);

  const state = listCacheState(opts);
  const sortOrder = opts.sort === "updated" ? "updated" : "created";
  const bypass = opts.bypassCache === true;
  // The unfiltered list path keeps `search` out of the cache key — search
  // routes through `searchIssuesImpl` above and never touches this cache.
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
    // Captured before the network call: if the count-as-cache-buster bumps
    // the epoch mid-flight, this page predates the observed change and must
    // not repopulate the just-busted cache.
    const epochAtStart = getRepoListEpoch("issue", repo.owner, repo.repo);

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
      "LIST_ISSUES_QUERY",
      // Always bypass the raw-response cache: the normalized `Page<Issue>` is
      // cached in `forgeIssueListCache` and the raw form would be redundant
      // (and strictly larger). This path has its own `dedupe` above, so the
      // runQuery-level singleflight isn't needed either.
      true
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

    // Skip the shared-cache write when a newer bypass call has superseded us
    // or the count buster invalidated this repo's issue pages mid-flight, so
    // a slow stale fetch can't clobber the fresher committed result. The
    // stats-count update sits behind the same epoch guard: a response too old
    // to repopulate the list cache is also too old to roll `repoStatsCache`
    // back to its pre-change total under a fresh `lastUpdated`.
    if (isCurrent() && getRepoListEpoch("issue", repo.owner, repo.repo) === epochAtStart) {
      forgeIssueListCache.set(cacheKey, page);
      if (state === "open" && !opts.cursor && typeof issues?.totalCount === "number") {
        updateRepoStatsCount(`${repo.owner}/${repo.repo}`, "issue", issues.totalCount);
      }
    }
    return page;
  });
}

/**
 * How long a PR page will wait on required-check enrichment before returning
 * its coarse rows. Enrichment sits on the list's critical path, so an unbounded
 * await would let a stalled CI query hold the dropdown for the full 15s API
 * timeout — five sequential chunks on a 100-row page could stall it far longer.
 * Past the budget the request keeps running and still populates
 * `prRequiredStatusCache`, so the next read (or the sidebar) picks the derived
 * status up without a refetch; only this page degrades to coarse.
 */
const REQUIRED_STATUS_ENRICHMENT_BUDGET_MS = 4_000;

/**
 * Replace each open row's coarse `statusCheckRollup` status with the
 * required-check-aware value the worktree sidebar already renders.
 *
 * `LIST_PRS_QUERY` can only carry the repo-wide rollup (GraphQL can't bind
 * `isRequired(pullRequestNumber:)` to a sibling node's own number inside a
 * list connection), so the list path used to disagree with the sidebar on any
 * PR whose non-required checks and required checks differ — a green rollup
 * with a failing required check read as passing in the dropdown (#11251). The
 * enrichment the legacy `GitHubPRs.listPullRequests` path performed was
 * dropped when the forge provider migration re-homed listing here (#9061).
 *
 * Routes through {@link getCIStatusesImpl} rather than re-deriving, so both
 * surfaces share one derivation *and* one `prRequiredStatusCache` entry per
 * PR. That call is already cache-first, chunked, rate-gated and single-flighted
 * — deliberately no "skip PRs that already look green" guard on top of it,
 * which is what froze a stale green permanently in #6149.
 *
 * Best-effort by construction: a rate-limit block, a rejected batch, a PR
 * missing from the response, or enrichment overrunning its time budget leaves
 * that row's coarse value untouched, and the page still resolves. CI detail
 * degrading must never blank or stall the dropdown.
 */
async function enrichPRPageWithRequiredStatus(repo: RepoRef, items: PR[]): Promise<PR[]> {
  // Closed and merged rows are skipped: required-check state is meaningless
  // once a PR is no longer open, the row badge only renders for open PRs, and
  // enriching them would burn rate-limit budget on every `state: "all"` page.
  const openNumbers = items.filter((pr) => pr.state === "open").map((pr) => pr.number);
  if (openNumbers.length === 0) return items;

  // Rejections are handled before the race, not after: past the budget the
  // request keeps running to warm `prRequiredStatusCache` for the next read,
  // and an unattached rejection would surface as an unhandled rejection.
  const pending = getCIStatusesImpl(repo, openNumbers).catch(() => null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), REQUIRED_STATUS_ENRICHMENT_BUDGET_MS);
  });

  const statuses = await Promise.race([pending, budget]);
  clearTimeout(timer);
  if (!statuses) return items;

  return items.map((pr) => {
    if (pr.state !== "open") return pr;
    const derived = statuses.get(pr.number);
    // A miss (unfetched chunk, blocked request, absent PR node) means "no
    // required-check answer", not "no CI" — keep whatever the rollup mapped.
    if (!derived) return pr;
    // `neutral`/`unknown` overwrite a coarse value on purpose: the sidebar
    // renders that same derived state, so preserving the rollup here would
    // recreate exactly the disagreement this fix removes. Both collapse to
    // "no badge" in the row renderer (see getPRCIStatusVisual), never to
    // "passing" — "no required checks" is not "all checks passed" (#6240).
    return { ...pr, ciStatus: derived.state };
  });
}

export async function listPRsImpl(repo: RepoRef, opts: ListOptions): Promise<Page<PR>> {
  const state = listCacheState(opts);
  const sortOrder = opts.sort === "updated" ? "updated" : "created";
  const bypass = opts.bypassCache === true;
  // The PR list query ignores `opts.search` (advisory — see ListOptions), so
  // it's kept out of the cache key. Wiring it would mean routing to
  // SEARCH_QUERY like `searchIssuesImpl` does for issues.
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
    // Same mid-flight count-buster guard as the issues list above.
    const epochAtStart = getRepoListEpoch("pr", repo.owner, repo.repo);

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
      "LIST_PRS_QUERY",
      // Always bypass the raw-response cache: the normalized `Page<PR>` is
      // cached in `forgePRListCache` and the raw form would be redundant (and
      // strictly larger). This path has its own `dedupe` above, so the
      // runQuery-level singleflight isn't needed either.
      true
    );

    const prs = (response?.repository as Record<string, unknown> | undefined)?.pullRequests as
      | {
          nodes?: unknown[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          totalCount?: number;
        }
      | undefined;
    const nodes = (prs?.nodes ?? []) as Array<Record<string, unknown>>;
    // Enrich before the guard below so the value written to `forgePRListCache`
    // is the required-check-aware one — a warm cache hit returns early and
    // never reaches this enrichment pass.
    const page: Page<PR> = {
      items: await enrichPRPageWithRequiredStatus(repo, nodes.filter(Boolean).map(toForgePR)),
      nextCursor: prs?.pageInfo?.endCursor ?? null,
      hasMore: prs?.pageInfo?.hasNextPage ?? false,
      ...(typeof prs?.totalCount === "number" ? { totalCount: prs.totalCount } : {}),
    };

    if (isCurrent() && getRepoListEpoch("pr", repo.owner, repo.repo) === epochAtStart) {
      forgePRListCache.set(cacheKey, page);
      if (state === "open" && !opts.cursor && typeof prs?.totalCount === "number") {
        updateRepoStatsCount(`${repo.owner}/${repo.repo}`, "pr", prs.totalCount);
      }
    }
    return page;
  });
}

export async function getIssueImpl(repo: RepoRef, number: number): Promise<Issue | null> {
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
      Record<string, unknown> | null | undefined;
    if (!issue) return null;
    const forgeIssue = toForgeIssue(issue);
    // Warm the hover-tooltip cache as a side effect so a subsequent hover skips
    // a redundant fetch. The detail fetch can't *read* this cache — it holds
    // the narrower tooltip shape, not a full Issue.
    issueTooltipCache.set(key, issueToTooltipData(forgeIssue));
    return forgeIssue;
  });
}

export async function getPRImpl(repo: RepoRef, number: number): Promise<PR | null> {
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
      Record<string, unknown> | null | undefined;
    if (!pr) return null;
    const forgePR = toForgePR(pr);
    // Side-effect tooltip pre-warm (write-through only); guarded by the
    // ownership-token timestamp so a slow response can't clobber a fresher one.
    const tooltip = prToTooltipData(forgePR);
    if (tooltip) writePRTooltip(repo.owner, repo.repo, number, tooltip, requestedAt);
    return forgePR;
  });
}

export async function findPRsByBranchesImpl(
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
          { pullRequests?: { nodes?: unknown[] } } | null | undefined;
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

export async function findPRByBranchImpl(repo: RepoRef, branchName: string): Promise<PR | null> {
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

export async function findPRsByNumbersImpl(
  repo: RepoRef,
  prNumbers: number[]
): Promise<Map<number, PR | null>> {
  const unique = uniquePositiveIntegers(prNumbers);
  if (unique.length === 0) return new Map<number, PR | null>();

  const inflightKey = buildNumberBatchInflightKey(repo, unique);
  return dedupe(findPRsByNumbersInflight, inflightKey, false, async () => {
    const result = new Map<number, PR | null>();

    const block = gitHubRateLimitService.shouldBlockRequest("graphql");
    if (block.blocked) return result;

    const requestedAt = Date.now();
    for (let start = 0; start < unique.length; start += GRAPHQL_BATCH_CHUNK_SIZE) {
      const chunk = unique.slice(start, start + GRAPHQL_BATCH_CHUNK_SIZE);
      const query = buildBatchPRsQuery(repo.owner, repo.repo, chunk);
      if (!query) continue;

      let response: GraphQlQueryResponseData;
      try {
        response = await runQuery(query, {}, "BATCH_PRS_QUERY");
      } catch {
        // Omit this chunk so callers treat it as transient and keep stale data.
        continue;
      }

      const repository = response?.repository as Record<string, unknown> | undefined;
      if (!repository) continue;

      for (const prNumber of chunk) {
        const alias = `p${prNumber}`;
        if (!(alias in repository)) continue;
        const node = repository[alias] as Record<string, unknown> | null | undefined;
        const forgePR = node ? toForgePR(node) : null;
        result.set(prNumber, forgePR);

        if (forgePR) {
          const tooltip = prToTooltipData(forgePR);
          if (tooltip) writePRTooltip(repo.owner, repo.repo, forgePR.number, tooltip, requestedAt);
        }
      }
    }

    return result;
  });
}

export async function getCIStatusesImpl(
  repo: RepoRef,
  prNumbers: number[]
): Promise<Map<number, CIStatus | null>> {
  const unique = uniquePositiveIntegers(prNumbers);
  if (unique.length === 0) return new Map<number, CIStatus | null>();

  const inflightKey = buildNumberBatchInflightKey(repo, unique);
  return dedupe(getCIStatusesInflight, inflightKey, false, async () => {
    const result = new Map<number, CIStatus | null>();
    const missing: number[] = [];

    for (const prNumber of unique) {
      const cacheKey = `${repo.owner}/${repo.repo}:${prNumber}`;
      const cached = prRequiredStatusCache.get(cacheKey);
      if (cached) {
        result.set(prNumber, buildCIStatus(cached, null));
      } else {
        missing.push(prNumber);
      }
    }

    if (missing.length === 0) return result;

    const block = gitHubRateLimitService.shouldBlockRequest("graphql");
    if (block.blocked) return result;

    for (let start = 0; start < missing.length; start += GRAPHQL_BATCH_CHUNK_SIZE) {
      const chunk = missing.slice(start, start + GRAPHQL_BATCH_CHUNK_SIZE);
      const query = buildBatchRequiredChecksQuery(repo.owner, repo.repo, chunk);
      if (!query) continue;

      let response: GraphQlQueryResponseData;
      try {
        response = await runQuery(query, {}, "BATCH_REQUIRED_CHECKS_QUERY");
      } catch {
        // Omit this chunk so callers treat it as transient and retry later.
        continue;
      }

      const responseRecord = response as Record<string, unknown>;
      const fetched = parseBatchRequiredChecksResponse(responseRecord, chunk);
      for (const prNumber of chunk) {
        const alias = `pr_${prNumber}`;
        if (!(alias in responseRecord)) continue;
        const repoNode = responseRecord[alias] as { pullRequest?: unknown } | null | undefined;
        if (repoNode == null || repoNode.pullRequest == null) {
          result.set(prNumber, null);
          continue;
        }
        const entry = fetched.get(prNumber) ?? {
          ciStatus: undefined,
          ciSummary: undefined,
        };
        prRequiredStatusCache.set(`${repo.owner}/${repo.repo}:${prNumber}`, entry);
        result.set(prNumber, buildCIStatus(entry, null));
      }
    }

    return result;
  });
}

export async function getCIStatusImpl(repo: RepoRef, prNumber: number): Promise<CIStatus | null> {
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
      Record<string, unknown> | null | undefined;
    if (!pr) return null;

    const commits = pr.commits as
      { nodes?: Array<{ commit?: { statusCheckRollup?: unknown } }> } | undefined;
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

export async function probeOpenPRListImpl(
  repo: RepoRef,
  tracked: PRSnapshot[]
): Promise<PRListProbeResult> {
  const token = GitHubAuth.getToken();
  // No token → the conditional GET can't be made; let the caller revalidate
  // through its normal (also token-gated) path rather than claim "unchanged".
  if (!token) return { kind: "fallback" };
  return probeOpenPRList(repo.owner, repo.repo, token, tracked);
}

export async function getRepoMetadataImpl(repo: RepoRef): Promise<RepoMetadata> {
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
      string | undefined) ?? "main";
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

export async function getReviewThreadsImpl(
  repo: RepoRef,
  prNumber: number
): Promise<ReviewThread[]> {
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

export function getRateLimitImpl(): Promise<RateLimitInfo> {
  const state = gitHubRateLimitService.getState();
  if (!state.blocked) {
    return Promise.resolve({
      limit: null,
      remaining: null,
      resetAt: null,
      throttleMultiplier: state.throttleMultiplier ?? 1,
    });
  }
  return Promise.resolve({
    limit: null,
    remaining: 0,
    resetAt: state.resetAt ?? null,
    ...(state.kind === "secondary" ? { secondaryThrottled: true } : {}),
    throttleMultiplier: state.throttleMultiplier ?? 1,
  });
}

/**
 * Extracts a `GH###` code (e.g. `GH006`, `GH013`) from raw push stderr — these
 * are GitHub's stable, googleable identifiers for protected-branch and ruleset
 * rejections. Returns `null` when no recognized code is present so the banner
 * falls back to its generic state.
 */
export function classifyPushErrorImpl(stderr: string): PushErrorClassification | null {
  const match = /\bGH\d{3,}\b/.exec(stderr);
  return match ? { code: match[0] } : null;
}

export async function findIssuesByNumbersImpl(
  repo: RepoRef,
  issueNumbers: number[]
): Promise<Map<number, Issue | null>> {
  const items = await getIssuesByNumbersForContext(
    { owner: repo.owner, repo: repo.repo },
    issueNumbers
  );
  const result = new Map<number, Issue | null>();
  for (const num of issueNumbers) {
    result.set(num, null);
  }
  // The core's results align with its positive-integer-filtered input order;
  // replay the same filter to pair numbers with items.
  const valid = issueNumbers.filter((n) => typeof n === "number" && Number.isInteger(n) && n > 0);
  valid.forEach((num, i) => {
    const item = items[i];
    result.set(num, item ? gitHubIssueToForgeIssue(item) : null);
  });
  return result;
}
