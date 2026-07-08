import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { createHash } from "node:crypto";
import { configure } from "safe-stable-stringify";
import type { CIStatus, Issue, Page, PR } from "../../../../shared/types/forge.js";
import { GitHubAuth, GITHUB_API_TIMEOUT_MS } from "./GitHubAuth.js";
import { gitHubRateLimitService } from "./GitHubRateLimitService.js";
import { forgeQueryCache, forgeQueryInflight } from "./GitHubCaches.js";
import { parseGitHubError } from "./GitHubErrors.js";

function requireClient(): NonNullable<ReturnType<typeof GitHubAuth.createClient>> {
  const client = GitHubAuth.createClient();
  if (!client) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }
  return client;
}

// Deterministic stringify so equivalent variables produce one cache key
// regardless of property insertion order across call sites.
const stringifyVariables = configure({ bigint: false });

// Hash the cache inputs to a fixed-size digest rather than storing the full
// multi-KB query document as the key. `queryLabel` and `variables` distinguish
// the named queries; the document is still folded in because batch queries
// (BATCH_BRANCH_PR / BATCH_PRS / BATCH_REQUIRED_CHECKS) carry their distinct
// branch/PR set in the document itself with `variables === {}` — without it
// they'd all collide on one key. `\0` can't appear in a GraphQL document or
// queryLabel, so neither field can be forged by the serialized variables.
function buildCacheKey(
  query: string,
  variables: Record<string, unknown>,
  queryLabel: string
): string {
  return createHash("sha256")
    .update(`${queryLabel}\0${stringifyVariables(variables) ?? ""}\0${query}`)
    .digest("hex");
}

export async function dispatchQuery(
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
export async function runQuery(
  query: string,
  variables: Record<string, unknown>,
  queryLabel: string,
  bypass = false
): Promise<GraphQlQueryResponseData> {
  const key = buildCacheKey(query, variables, queryLabel);

  if (!bypass) {
    const cached = forgeQueryCache.get(key);
    if (cached !== undefined) return cached;

    const inflight = forgeQueryInflight.get(key);
    if (inflight !== undefined) return inflight;
  }

  const request = dispatchQuery(query, variables, queryLabel)
    .then((response) => {
      // `bypass` skips the raw-response cache write too: the list paths
      // (LIST_ISSUES/LIST_PRS) hold the strictly-larger raw response only to
      // build a normalized `Page<T>` they cache separately, so caching the raw
      // form here is redundant. Reads/inflight-joins are already bypassed above.
      if (!bypass) forgeQueryCache.set(key, response);
      return response;
    })
    .finally(() => {
      if (forgeQueryInflight.get(key) === request) forgeQueryInflight.delete(key);
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
export const listIssuesInflight = new Map<string, Promise<Page<Issue>>>();
export const listPRsInflight = new Map<string, Promise<Page<PR>>>();
export const getIssueInflight = new Map<string, Promise<Issue | null>>();
export const getPRInflight = new Map<string, Promise<PR | null>>();
export const getCIStatusInflight = new Map<string, Promise<CIStatus | null>>();
export const findPRsByBranchesInflight = new Map<string, Promise<Map<string, PR | null>>>();
export const findPRsByNumbersInflight = new Map<string, Promise<Map<number, PR | null>>>();
export const getCIStatusesInflight = new Map<string, Promise<Map<number, CIStatus | null>>>();

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
export function dedupe<T>(
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
