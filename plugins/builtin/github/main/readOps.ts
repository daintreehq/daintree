import type { GraphQlQueryResponseData } from "@octokit/graphql";
import type {
  CheckRun,
  CIStatus,
  Issue,
  IssueComment,
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
  LIST_ISSUE_COMMENTS_QUERY,
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
  getIssueCommentsEpoch,
  getRepoListEpoch,
  issueTooltipCache,
  prRequiredStatusCache,
  truncateBody,
  writePRTooltip,
  MAX_REVIEW_THREAD_PAGES,
  type PRRequiredStatusEntry,
} from "./GitHubCaches.js";
import { probeOpenPRList } from "./GitHubPRDiscovery.js";
import { deriveRequiredCIStatus, mapRollupContextToCheckRun } from "./prRequiredCIStatus.js";
import type { RollupContextNode } from "./prRequiredCIStatus.js";
import { getIssuesByNumbersForContext } from "./GitHubIssues.js";
import {
  buildListCacheKey,
  normalizeListDirection,
  normalizeListPerPage,
  normalizeListSortOrder,
  parseBatchRequiredChecksResponse,
  updateRepoStatsCount,
} from "./GitHubPRs.js";
import {
  mapIssueGraphQLStates,
  mapPRGraphQLStates,
  toForgeIssue,
  toForgeIssueComment,
  toForgePR,
  gitHubIssueToForgeIssue,
} from "./mappers.js";
import {
  dedupe,
  runQuery,
  listIssuesInflight,
  listIssueCommentsInflight,
  listPRsInflight,
  getIssueInflight,
  getPRInflight,
  getCIStatusInflight,
  getChecksInflight,
  findPRsByBranchesInflight,
  findPRsByNumbersInflight,
  getCIStatusesInflight,
} from "./queryInfra.js";

/**
 * Takes the ALREADY-normalized order rather than raw `ListOptions`, so the
 * ordering sent to GitHub and the ordering baked into the cache key can only
 * ever come from one decision. Re-deriving it here is how the query and the
 * key drift apart — the failure this module's cache key was just widened to
 * prevent (#11527).
 */
function buildOrderBy(
  sortOrder: "created" | "updated",
  direction: "asc" | "desc"
): { field: string; direction: string } {
  return {
    field: sortOrder === "updated" ? "UPDATED_AT" : "CREATED_AT",
    direction: direction === "asc" ? "ASC" : "DESC",
  };
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
  // Read once, before `dedupe()` defers the fetch — see `listIssuesImpl`.
  const state = listCacheState(opts);
  const bypass = opts.bypassCache === true;
  const limit = normalizeListPerPage(opts.perPage);
  const cursor = opts.cursor ?? null;
  // Free text is appended unquoted — GitHub search tokenizes it as keywords,
  // matching what its own search box does (see findPRByBranchImpl, which only
  // quotes because branch refs must not parse as separate operators). GitHub
  // caps search queries at 256 chars, so the term is truncated to the budget
  // left after the qualifiers rather than letting the whole query be rejected.
  const stateQualifier = state === "all" ? "" : ` state:${state}`;
  // Both halves of the order come from the caller. This path used to pin
  // `-desc` and silently drop an `asc` request (#11527) — harmless while
  // `direction` was unreachable, wrong the moment the action exposed it.
  const sortQualifier = `sort:${normalizeListSortOrder(opts.sort)}-${normalizeListDirection(opts.direction)}`;
  const prefix = `repo:${repo.owner}/${repo.repo} is:issue${stateQualifier} ${sortQualifier} `;
  const available = 256 - prefix.length;
  const searchQuery = `${prefix}${available > 0 ? search.slice(0, available) : ""}`.trim();
  const dedupeKey = `search:${searchQuery}:${cursor ?? ""}:${limit}`;

  return dedupe(listIssuesInflight, dedupeKey, bypass, async () => {
    const response = await runQuery(
      SEARCH_QUERY,
      {
        searchQuery,
        type: "ISSUE",
        cursor,
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

  // Every option that reaches either the key or the query is read ONCE, here,
  // before `dedupe()` defers the fetch to a microtask. Re-reading `opts` inside
  // that callback would let a caller who reuses and mutates one options object
  // between calls cache a descending page under an ascending key.
  const state = listCacheState(opts);
  const sortOrder = normalizeListSortOrder(opts.sort);
  const direction = normalizeListDirection(opts.direction);
  const limit = normalizeListPerPage(opts.perPage);
  const states = mapIssueGraphQLStates(opts.state);
  const cursor = opts.cursor ?? null;
  const bypass = opts.bypassCache === true;
  // The unfiltered list path keeps `search` out of the cache key — search
  // routes through `searchIssuesImpl` above and never touches this cache.
  const cacheKey = buildListCacheKey({
    type: "issue",
    owner: repo.owner,
    repo: repo.repo,
    state,
    search: "",
    sortOrder,
    direction,
    perPage: limit,
    cursor: cursor ?? "",
  });

  if (!bypass) {
    const cached = forgeIssueListCache.get(cacheKey);
    if (cached) return cached;
  }

  return dedupe(listIssuesInflight, cacheKey, bypass, async (isCurrent) => {
    const orderBy = buildOrderBy(sortOrder, direction);
    // Captured before the network call: if the count-as-cache-buster bumps
    // the epoch mid-flight, this page predates the observed change and must
    // not repopulate the just-busted cache.
    const epochAtStart = getRepoListEpoch("issue", repo.owner, repo.repo);

    const response = await runQuery(
      LIST_ISSUES_QUERY,
      {
        owner: repo.owner,
        repo: repo.repo,
        states,
        cursor,
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
      if (state === "open" && !cursor && typeof issues?.totalCount === "number") {
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
  // Read once, before `dedupe()` defers the fetch — see `listIssuesImpl`.
  const state = listCacheState(opts);
  const sortOrder = normalizeListSortOrder(opts.sort);
  const direction = normalizeListDirection(opts.direction);
  const limit = normalizeListPerPage(opts.perPage);
  const states = mapPRGraphQLStates(opts.state);
  const cursor = opts.cursor ?? null;
  const bypass = opts.bypassCache === true;
  // The PR list query ignores `opts.search` (advisory — see ListOptions), so
  // it's kept out of the cache key. Wiring it would mean routing to
  // SEARCH_QUERY like `searchIssuesImpl` does for issues.
  const cacheKey = buildListCacheKey({
    type: "pr",
    owner: repo.owner,
    repo: repo.repo,
    state,
    search: "",
    sortOrder,
    direction,
    perPage: limit,
    cursor: cursor ?? "",
  });

  if (!bypass) {
    const cached = forgePRListCache.get(cacheKey);
    if (cached) return cached;
  }

  return dedupe(listPRsInflight, cacheKey, bypass, async (isCurrent) => {
    const orderBy = buildOrderBy(sortOrder, direction);
    // Same mid-flight count-buster guard as the issues list above.
    const epochAtStart = getRepoListEpoch("pr", repo.owner, repo.repo);

    const response = await runQuery(
      LIST_PRS_QUERY,
      {
        owner: repo.owner,
        repo: repo.repo,
        states,
        cursor,
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
      if (state === "open" && !cursor && typeof prs?.totalCount === "number") {
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
    const page = await fetchCIRollupPage(repo, prNumber, null);
    if (!page) return null;

    const { rollup } = page;
    const derived = deriveRequiredCIStatus(page.nodes, page.hasNextPage, rollup?.state ?? null);

    const entry: PRRequiredStatusEntry = {
      ciStatus: derived.ciStatus,
      ciSummary: derived.ciSummary,
    };
    prRequiredStatusCache.set(cacheKey, entry);
    return buildCIStatus(entry, rollup ?? null);
  });
}

interface CIRollupPage {
  rollup: { state?: string } | undefined;
  /** Head commit the page was read from; `null` when the response omitted it. */
  headOid: string | null;
  nodes: RollupContextNode[] | null;
  hasNextPage: boolean;
  endCursor: string | null;
  /** `false` when the rollup exists but reported no `pageInfo` to prove completeness. */
  hasPageInfo: boolean;
}

/**
 * One page of the head commit's status-check rollup, or `null` when the PR
 * doesn't exist. Shared by the roll-up and per-check reads so both see the same
 * response shape from the same query.
 *
 * `bypassCache` is what separates the two callers. `getCIStatus` wants the 60s
 * response cache — it is the hottest forge path and a minute-stale verdict is
 * documented. `getChecks` must not: a cached first page reporting
 * `hasNextPage: false` would let a since-added 101st check vanish from a list
 * that promises to be complete.
 */
async function fetchCIRollupPage(
  repo: RepoRef,
  prNumber: number,
  cursor: string | null,
  bypassCache = false
): Promise<CIRollupPage | null> {
  const response = await runQuery(
    PR_CI_STATUS_QUERY,
    { owner: repo.owner, repo: repo.repo, number: prNumber, cursor },
    "PR_CI_STATUS_QUERY",
    bypassCache
  );

  const pr = (response?.repository as Record<string, unknown> | undefined)?.pullRequest as
    Record<string, unknown> | null | undefined;
  if (!pr) return null;

  const commits = pr.commits as
    { nodes?: Array<{ commit?: { oid?: string; statusCheckRollup?: unknown } }> } | undefined;
  const commit = commits?.nodes?.[0]?.commit;
  const rollup = commit?.statusCheckRollup as
    | {
        state?: string;
        contexts?: {
          nodes?: RollupContextNode[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      }
    | undefined;

  const pageInfo = rollup?.contexts?.pageInfo;
  const nodes = rollup?.contexts?.nodes;
  return {
    rollup,
    headOid: typeof commit?.oid === "string" && commit.oid ? commit.oid : null,
    nodes: Array.isArray(nodes) ? nodes : null,
    hasNextPage: pageInfo?.hasNextPage === true,
    endCursor: pageInfo?.endCursor ?? null,
    // Only a real boolean proves anything. A `pageInfo` that omits the flag says
    // nothing about whether more pages exist, and reading its absence as "no"
    // is how a list silently stops at 100.
    hasPageInfo: typeof pageInfo?.hasNextPage === "boolean",
  };
}

/**
 * Ceiling on rollup pages walked by one {@link getChecksImpl} call. At 100
 * contexts per page this is 1000 checks — far past any real PR, so it never
 * truncates legitimate data. It exists so a provider bug or a cursor that keeps
 * reporting `hasNextPage` cannot spin an unbounded request loop against a
 * rate-limited API.
 */
const MAX_CHECK_PAGES = 10;

/**
 * Per-check CI detail for one PR (#11786). Pages the rollup to the end and
 * returns every check, so a caller diagnosing a red PR sees which check failed
 * and where to read its log.
 *
 * Rejects rather than returning a short list whenever the traversal can't be
 * completed — a truncated answer to "which check failed?" is wrong, not partial.
 * `null` is reserved for a PR that doesn't exist; a PR with no checks yields an
 * empty array.
 */
export async function getChecksImpl(
  repo: RepoRef,
  prNumber: number
): Promise<{ checks: CheckRun[] } | null> {
  const inflightKey = `${repo.owner}/${repo.repo}:${prNumber}`;
  return dedupe(getChecksInflight, inflightKey, false, async () => {
    const incomplete = (why: string): Error =>
      new Error(`Could not read all checks for PR #${prNumber}: ${why}`);

    const checks: CheckRun[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let headOid: string | null = null;

    for (let page = 0; page < MAX_CHECK_PAGES; page++) {
      const result: CIRollupPage | null = await fetchCIRollupPage(repo, prNumber, cursor, true);
      // Only the first page distinguishes "no such PR"; a later page losing the
      // PR means it moved under us, which is a failed traversal, not absence.
      if (!result) {
        if (page === 0) return null;
        throw incomplete("the pull request disappeared mid-read");
      }

      // Every page re-resolves `commits(last: 1)`, so a push between pages would
      // otherwise splice two commits' checks into one list — dropping the new
      // head's failures while presenting the result as complete.
      if (page === 0) {
        headOid = result.headOid;
      } else if (result.headOid === null || result.headOid !== headOid) {
        throw incomplete("the pull request was updated mid-read");
      }

      if (!result.rollup) {
        // No rollup at all: on the first page that is a PR with no checks; later
        // it means the data moved under us, which is not an empty result.
        if (page === 0) return { checks: [] };
        throw incomplete("its checks went away mid-read");
      }

      // A rollup that reports no node list at all isn't an empty page — it is a
      // page we can't read, and treating it as empty drops whatever it held.
      if (!result.nodes) throw incomplete("the provider returned no check list");

      for (const node of result.nodes) {
        const check = mapRollupContextToCheckRun(node);
        // A node we cannot even name is a check we would be omitting silently —
        // "no such check" instead of "a check I can't describe". Fail loudly.
        if (!check) throw incomplete("the provider returned an unreadable check");
        checks.push(check);
      }

      // Without pageInfo there is no evidence this page is the last one, and
      // assuming it is truncates at 100 without saying so.
      if (!result.hasPageInfo) throw incomplete("the provider reported no pagination info");
      if (!result.hasNextPage) return { checks };

      // Another page is coming, so from here on the head has to be verifiable.
      if (headOid === null) throw incomplete("the provider reported no head commit to pin");

      // A next page we can't address, or a cursor that repeats, would loop or
      // silently drop the remainder. Fail instead of returning a partial list.
      const next = result.endCursor?.trim();
      if (!next || seenCursors.has(next)) throw incomplete("pagination stalled");
      seenCursors.add(next);
      cursor = next;
    }

    throw incomplete(`more than ${MAX_CHECK_PAGES * 100} checks`);
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

/** GitHub caps a GraphQL connection's `first:` at 100. */
const MAX_ISSUE_COMMENTS_PER_PAGE = 100;
const DEFAULT_ISSUE_COMMENTS_PER_PAGE = 20;

/**
 * Clamp a caller-supplied page size into GitHub's `first:` window. The IPC
 * boundary types `opts` loosely and only the MCP action validates it, so a
 * direct renderer call can land here with `NaN`/`Infinity` — which would sail
 * through a bare `Math.trunc` clamp and reach GraphQL as an invalid `Int!`.
 */
function clampCommentsPerPage(perPage: number | undefined): number {
  if (typeof perPage !== "number" || !Number.isFinite(perPage)) {
    return DEFAULT_ISSUE_COMMENTS_PER_PAGE;
  }
  return Math.min(Math.max(Math.trunc(perPage), 1), MAX_ISSUE_COMMENTS_PER_PAGE);
}

/**
 * Paged read of an issue's comment thread (#11545) — the read half of
 * `addIssueComment`.
 *
 * Deliberately bypasses `runQuery`'s 60-second raw-response cache: the calling
 * agent has often just posted into this very thread, or is polling for a human
 * reply, so a minute of staleness reads as "nobody answered" and defeats the
 * point. The call-site `dedupe` below still collapses concurrent identical
 * reads, so bypassing costs nothing under fan-out.
 *
 * The dedupe key carries the auth token version and the issue's comment epoch
 * so coalescing can't span a credential switch (joining a request made with
 * someone else's token) or a write (a read issued after `addIssueComment`
 * joining one issued before it, and so missing the comment just posted).
 *
 * Order is GitHub's own: oldest-first. `opts.sort`/`opts.direction` are
 * advisory and ignored — neither GitHub API honors them on a comment thread
 * (see {@link IssueCommentCapability}), so accepting them would be a lie.
 */
export async function listIssueCommentsImpl(
  repo: RepoRef,
  issueNumber: number,
  opts: ListOptions
): Promise<Page<IssueComment>> {
  const bypass = opts.bypassCache === true;
  const limit = clampCommentsPerPage(opts.perPage);
  // A blank cursor is not the first page under a different name — treating it
  // as `null` keeps it from colliding with the real first page's dedupe slot.
  const cursor = opts.cursor?.trim() ? opts.cursor : null;
  const dedupeKey = JSON.stringify([
    GitHubAuth.getTokenVersion(),
    repo.owner,
    repo.repo,
    issueNumber,
    getIssueCommentsEpoch(repo.owner, repo.repo),
    cursor,
    limit,
  ]);

  return dedupe(listIssueCommentsInflight, dedupeKey, bypass, async () => {
    const response = await runQuery(
      LIST_ISSUE_COMMENTS_QUERY,
      { owner: repo.owner, repo: repo.repo, number: issueNumber, cursor, limit },
      "LIST_ISSUE_COMMENTS_QUERY",
      true
    );

    const issue = (response?.repository as Record<string, unknown> | undefined)?.issue as
      | {
          comments?: {
            nodes?: unknown[];
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            totalCount?: number;
          };
        }
      | null
      | undefined;

    // An empty page must mean "nobody has commented", never "no such issue" —
    // an agent checking for a reply would read the latter as the former.
    if (!issue) {
      throw new Error(`Issue #${issueNumber} not found in ${repo.owner}/${repo.repo}`);
    }

    const comments = issue.comments;
    const nodes = (comments?.nodes ?? []) as Array<Record<string, unknown>>;
    const endCursor = comments?.pageInfo?.endCursor ?? null;
    // Relay connections keep returning the last edge's cursor after the final
    // page, but `Page.nextCursor` is contractually null once nothing follows —
    // and a cursor with no page behind it makes a caller fetch one more time.
    // A `hasNextPage` with no cursor to follow is likewise not "more".
    const hasMore = (comments?.pageInfo?.hasNextPage ?? false) && endCursor !== null;
    return {
      items: nodes.filter(Boolean).map(toForgeIssueComment),
      nextCursor: hasMore ? endCursor : null,
      hasMore,
      ...(typeof comments?.totalCount === "number" ? { totalCount: comments.totalCount } : {}),
    };
  });
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
