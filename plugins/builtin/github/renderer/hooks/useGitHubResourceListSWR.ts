import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useLayoutEffect,
  useContext,
} from "react";
import { useDebounce } from "@/hooks/useDebounce";
import {
  buildCacheKey,
  getCache,
  setCache,
  nextGeneration,
  getGeneration,
  type ForgeResourceCacheEntry,
} from "@/lib/forgeResourceCache";
import { isRateLimitError, isTokenRelatedError, isTransientNetworkError } from "@/lib/forgeErrors";
import { forgeClient } from "@/clients/forgeClient";
import {
  useForgeProviderHealthStore,
  DEFAULT_PROVIDER_HEALTH,
} from "@/store/forgeProviderHealthStore";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";
import { useSystemWakeStore } from "@/store/systemWakeStore";
import { FixedDropdownVisibleContext } from "@/components/ui/fixed-dropdown";
import type { Issue, ListOptions, PR } from "@shared/types/forge";
import type { GitHubSortOrder } from "../../shared/types.js";
import { MULTI_FETCH_CAP, parseNumberQuery } from "@/lib/parseNumberQuery";
import { formatErrorMessage } from "@shared/utils/errorMessage";

type StateFilter = string;

const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_DELAYS_MS = [500, 1500];

// Open-time fetch policy windows (quota guards, #10122 family).
//
// FRESH_REVALIDATE_SKIP_MS: an entry whose `freshBypassAt` is this recent was
// just fetched from GitHub with `bypassCache: true` (hover prefetch landing
// right before the click is the canonical case) — firing the usual mount-time
// bypass revalidate would be a second GraphQL query for the same data within
// seconds. Mirrors the toolbar's PREFETCH_FRESHNESS_MS so hover→click costs
// one query, not two. Only `freshBypassAt` qualifies; `timestamp` alone can
// describe broadcast-seeded snapshot content.
const FRESH_REVALIDATE_SKIP_MS = 10_000;

/**
 * Open-time fetch policy for warm-cache hydrations in the mount effect. Never
 * consulted by manual refresh, focus, or wake revalidation — those keep their
 * unconditional `bypassCache: true`.
 *
 * - `"skip"`: the entry was written by a real bypass fetch (hover prefetch /
 *   bypass revalidate) under FRESH_REVALIDATE_SKIP_MS ago — refetching now
 *   would double-spend GraphQL on data that just left GitHub.
 * - `"cached"`: issues-only downgrade. The cheap REST count poll fingerprints
 *   open-issue counts; while the entry's `countAtWrite` matches every fresh
 *   poll (no `stale` mark), the revalidate may honor the backend's 60s list
 *   cache. Issues only: PR rows render CI rollup state, and check-run flips
 *   never surface in the `/events` feed or the counts, so the PR list keeps
 *   its unconditional bypass. Count equality can also miss same-count row
 *   churn (close one, open one) — the 45s renderer TTL and the backend's 60s
 *   TTL bound that staleness, and manual/focus/wake bypass stays the escape
 *   hatch.
 * - `"bypass"`: today's behavior (fresh GraphQL).
 */
function planWarmRevalidate(
  cached: ForgeResourceCacheEntry,
  type: "issue" | "pr",
  filterState: string,
  hasSearch: boolean
): "skip" | "cached" | "bypass" {
  if (hasSearch) return "bypass";
  // Stale wins over everything: a count delta can land between a hover
  // prefetch and the click, marking the just-prefetched entry stale — the
  // fresh `freshBypassAt` must not let a provably-diverged page skip its
  // revalidate.
  if (cached.stale) return "bypass";
  if (
    cached.freshBypassAt != null &&
    Date.now() - cached.freshBypassAt < FRESH_REVALIDATE_SKIP_MS
  ) {
    return "skip";
  }
  if (type === "issue" && filterState === "open" && cached.countAtWrite != null) {
    return "cached";
  }
  return "bypass";
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface UseGitHubResourceListSWRParams {
  type: "issue" | "pr";
  projectPath: string;
  searchQuery: string;
  filterState: StateFilter;
  sortOrder: GitHubSortOrder;
  githubConfig: { hasToken: boolean } | null;
  onFreshFetch?: () => void;
  onCountUpdate?: (count: number, hasMore: boolean) => void;
}

export interface UseGitHubResourceListSWRReturn {
  data: (Issue | PR)[];
  debouncedSearch: string;
  numberQuery: ReturnType<typeof parseNumberQuery>;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  error: string | null;
  loadMoreError: string | null;
  lastUpdatedAt: number | null;
  exactNumberNotFound: number | null;
  isTokenError: boolean;
  isRateLimited: boolean;
  rateLimitResetAt: number | null;
  handleLoadMore: () => void;
  handleRetry: () => void;
  handleManualRefresh: () => void;
}

export function useGitHubResourceListSWR({
  type,
  projectPath,
  searchQuery,
  filterState,
  sortOrder,
  githubConfig,
  onFreshFetch,
  onCountUpdate,
}: UseGitHubResourceListSWRParams): UseGitHubResourceListSWRReturn {
  const debouncedSearch = useDebounce(searchQuery, 300);

  const cacheKey = useMemo(
    () => buildCacheKey(projectPath, type, filterState as string, sortOrder),
    [projectPath, type, filterState, sortOrder]
  );
  const cachedEntry = useMemo(() => getCache(cacheKey), [cacheKey]);

  const [data, setData] = useState<(Issue | PR)[]>(() => cachedEntry?.items ?? []);
  const [cursor, setCursor] = useState<string | null>(() => cachedEntry?.nextCursor ?? null);
  const [hasMore, setHasMore] = useState(() => cachedEntry?.hasMore ?? false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Tracks any in-flight background revalidate (manual refresh button,
  // mount-time SWR revalidate, focus-revalidate). Distinct from `loading`
  // because revalidates do NOT clear data or show the row skeleton — they
  // surface only via the spinning refresh icon in the dropdown header so
  // the user has visual feedback that a background refresh is in progress.
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(
    () => cachedEntry?.timestamp ?? null
  );

  const [exactNumberNotFound, setExactNumberNotFound] = useState<number | null>(null);
  const mountedRef = useRef(false);
  // Tracks the last set of inputs the load effect handled. When the body is
  // hidden via React 19.2 `<Activity>` and re-revealed, effects unmount +
  // remount but state (and `mountedRef`) is preserved. Without this we'd
  // treat the reveal as a "filter/sort change while mounted" and clear the
  // data + show a skeleton — defeating the entire reason we keepMounted in
  // the first place. The key includes `debouncedSearch` because search isn't
  // part of `cacheKey`, so otherwise a search-query change would be
  // indistinguishable from an Activity reveal.
  const lastLoadedEffectKeyRef = useRef<string | null>(null);

  const numberQuery = useMemo(() => parseNumberQuery(searchQuery), [searchQuery]);
  const exactNumberAbortRef = useRef<AbortController | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  // Note: currentCursor is passed as a parameter (not read from state) to avoid
  // dependency cycle where updating cursor would recreate this callback
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  // Tracks the last time fetchData started a non-append fetch — used by the
  // visibility/focus revalidation effect to throttle repeat refreshes.
  const lastFetchAttemptRef = useRef<number>(0);

  // `githubConfig` flips from `null` → object when the config store finishes
  // its async `initialize()` call shortly after mount. Reading it directly in
  // `fetchData`'s `useCallback` deps would re-create the callback on that
  // flip, re-firing the cache-key-driven mount effect with `isFirstMount =
  // false` and triggering the cache-miss skeleton flash on every dropdown
  // open. Routing the read through a ref keeps `fetchData` stable while
  // still observing the latest config at call time.
  const githubConfigRef = useRef(githubConfig);
  useEffect(() => {
    githubConfigRef.current = githubConfig;
  }, [githubConfig]);

  // Rate-limit state: a single store push fans out to every consuming hook,
  // so we read directly here and mirror into a ref for `fetchData` (same
  // rationale as `githubConfigRef` — adding `rateLimitBlocked` to fetchData's
  // deps would recreate the callback on every rate-limit flip and reflash
  // the skeleton). The plugin reads its own provider slice from the keyed
  // health store. `recentlyHitRateLimit` covers the brief race window where
  // a fetch fires just before the store-push lands: the catch path sets it,
  // a successful fetch clears it. `isRateLimited` is the OR.
  const rateLimitBlocked = useForgeProviderHealthStore(
    (s) => (s.providers[BUILTIN_GITHUB_PROVIDER_ID] ?? DEFAULT_PROVIDER_HEALTH).rateLimitBlocked
  );
  const rateLimitResetAt = useForgeProviderHealthStore(
    (s) => (s.providers[BUILTIN_GITHUB_PROVIDER_ID] ?? DEFAULT_PROVIDER_HEALTH).rateLimitResetAt
  );
  const rateLimitBlockedRef = useRef(rateLimitBlocked);
  useEffect(() => {
    rateLimitBlockedRef.current = rateLimitBlocked;
  }, [rateLimitBlocked]);
  const [recentlyHitRateLimit, setRecentlyHitRateLimit] = useState(false);
  // Clear the catch-path sticky flag the moment the store reports unblocked.
  // Without this, a fetch that races the block-push leaves `isRateLimited`
  // true until some unrelated successful fetch arrives — contradicting the
  // empty-state copy promising the dropdown will resume automatically.
  useEffect(() => {
    if (!rateLimitBlocked) {
      setRecentlyHitRateLimit(false);
    }
  }, [rateLimitBlocked]);
  const isRateLimited = rateLimitBlocked || recentlyHitRateLimit;

  const fetchData = useCallback(
    async (
      currentCursor: string | null | undefined,
      append: boolean = false,
      abortSignal?: AbortSignal,
      options?: {
        revalidating?: boolean;
        generation?: number;
        cacheKey?: string;
        /**
         * Override the revalidate default of `bypassCache: true`. Set to
         * `false` by the mount effect's downgraded path when the count signal
         * says the cached page is still consistent — the request then honors
         * the backend's 60s list cache instead of forcing fresh GraphQL.
         * Manual refresh, focus, and wake revalidation never pass this, so
         * they keep their unconditional bypass.
         */
        bypass?: boolean;
      }
    ) => {
      if (!projectPath) return;
      // Skip the fetch entirely when no token is configured. The render path
      // shows a dedicated empty state; firing fetches here would just produce
      // a token-error toast for users who haven't set up GitHub yet.
      const cfg = githubConfigRef.current;
      if (cfg && !cfg.hasToken) return;

      // Skip fetches while GitHub-wide rate-limit pause is active — the main
      // process would block the request and surface a rate-limit error, but
      // the render path already shows the paused state from store push.
      if (rateLimitBlockedRef.current) return;

      const isRevalidate = options?.revalidating ?? false;

      if (append) {
        loadMoreAbortRef.current?.abort();
        const abortController = new AbortController();
        loadMoreAbortRef.current = abortController;
        abortSignal = abortController.signal;

        setLoadingMore(true);
        setLoadMoreError(null);
      } else if (!isRevalidate) {
        setLoading(true);
        setError(null);
        setLoadMoreError(null);
      } else {
        // Background revalidate — don't clear rows or show the skeleton,
        // but DO surface activity via the header refresh icon spin.
        setRefreshing(true);
      }

      if (!append) {
        lastFetchAttemptRef.current = Date.now();
      }

      // Retry only the primary fetch path. Load-more has its own Retry button,
      // and background revalidation already shows stale data.
      const canRetry = !append && !isRevalidate;
      const maxAttempts = canRetry ? FETCH_MAX_ATTEMPTS : 1;
      let lastError: unknown = null;

      try {
        const searchOverride =
          numberQuery?.kind === "open-ended" ? `number:>=${numberQuery.from}` : undefined;
        // Append (load-more) always wants the next page from network.
        // SWR revalidates default to bypassing the backend cache — that's
        // the point of a revalidate — unless the mount effect downgraded
        // this one via `options.bypass: false` (count signal says the
        // cached page is still consistent). Cold-mount fetches (no cache,
        // no revalidating flag) honor the backend's 60s in-memory cache
        // instead of bypassing — same data either way, but the cached path
        // returns synchronously and avoids the click-time round-trip the
        // user sees as "reload".
        const usedBypass = append ? false : (options?.bypass ?? isRevalidate);
        // `merged` is a GitHub-supported PR state the provider accepts beyond
        // the contract's documented set — pass it through with a cast.
        const fetchOptions: ListOptions = {
          search: searchOverride || debouncedSearch || undefined,
          state: filterState as ListOptions["state"],
          cursor: currentCursor || undefined,
          bypassCache: usedBypass,
          sort: sortOrder,
        };

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            const result =
              type === "issue"
                ? await forgeClient.listIssues(projectPath, fetchOptions)
                : await forgeClient.listPRs(projectPath, fetchOptions);

            // Check if aborted before updating state
            if (abortSignal?.aborted) return;

            // Generation guard: discard stale responses
            if (options?.generation != null && options.cacheKey != null) {
              if (getGeneration(options.cacheKey) !== options.generation) return;
            }

            if (append) {
              setData((prev) => [...prev, ...result.items]);
              setLoadMoreError(null);
            } else {
              setData(result.items);
              setError(null);
            }
            setCursor(result.nextCursor);
            setHasMore(result.hasMore);
            // Successful response clears the sticky catch-path flag. The
            // store-driven `rateLimitBlocked` continues to gate the UI.
            setRecentlyHitRateLimit(false);

            // Write first-page results to cache (skip search-filtered results)
            if (!append && options?.cacheKey && !debouncedSearch) {
              const now = Date.now();
              setCache(options.cacheKey, {
                items: result.items,
                nextCursor: result.nextCursor,
                hasMore: result.hasMore,
                timestamp: now,
                // `freshBypassAt` only when this request actually skipped the
                // backend cache — a downgraded/cold fetch may have been served
                // a cached page, which must not arm the skip-revalidate gate.
                ...(usedBypass ? { freshBypassAt: now } : {}),
                // Open-count fingerprint for the count-as-cache-buster: only
                // the open filter tracks a polled count, so other states stay
                // un-fingerprinted (and therefore never downgrade).
                ...(filterState === "open" && result.totalCount != null
                  ? { countAtWrite: result.totalCount }
                  : {}),
              });
              setLastUpdatedAt(now);
              // Bind the toolbar count badge to the authoritative server total
              // (`totalCount`) when the list query provides it, so the badge
              // shows the real open count (e.g. "47") instead of the loaded
              // first-page length with a "+" suffix ("20+", issue #9717). The
              // `totalCount` comes from the same GraphQL response as the items,
              // so it never claims more than is actually open (issue #9693).
              // The second arg to `onCountUpdate` is the "count is approximate"
              // flag that drives the badge's "+" suffix — when `totalCount` is
              // known the count is exact, so it is `false`. Search results and
              // cache hits carry no `totalCount`, so they fall back to the
              // loaded length plus the real `hasNextPage`.
              //
              // Fires on cold-mount AND revalidation (NOT gated on
              // `isRevalidate`) so the badge reconciles the moment the dropdown
              // first loads, not just on a later background refresh.
              //
              // Gated to the `open` filter: the badge represents the OPEN
              // issue/PR count (its aria-label and tooltip say "open"). The
              // hook is kept mounted across filter tabs, so without this gate
              // switching the dropdown to Closed/Merged would fire
              // `onCountUpdate` with the closed/merged count and poison the
              // open badge. The last known open count stays correct while the
              // user browses other states.
              if (filterState === "open") {
                onCountUpdate?.(
                  result.totalCount ?? result.items.length,
                  result.totalCount == null ? result.hasMore : false
                );
              }
              // Notify parent (toolbar count badge) that fresh first-page data
              // landed. Gated on the request actually having sent
              // `bypassCache: true` — the main process's
              // `updateRepoStatsCount` runs on the GraphQL path that follows a
              // bypass, so the toolbar's `refresh()` call is guaranteed to see
              // an updated `repoStatsCache` entry. Cold-mount and downgraded
              // revalidate fetches (`bypassCache: false`) may hit the
              // main-process cache and skip the count update entirely; firing
              // onFreshFetch there would be a wasted IPC round-trip.
              if (usedBypass) {
                onFreshFetch?.();
              }
            }
            lastError = null;
            return;
          } catch (err) {
            if (abortSignal?.aborted) return;
            lastError = err;
            const message = formatErrorMessage(err, "Failed to fetch data");
            const retryable =
              canRetry &&
              attempt < maxAttempts - 1 &&
              isTransientNetworkError(message) &&
              !isTokenRelatedError(message) &&
              !isRateLimitError(message);
            if (!retryable) break;
            try {
              await abortableDelay(FETCH_RETRY_DELAYS_MS[attempt]!, abortSignal);
            } catch {
              return;
            }
            if (abortSignal?.aborted) return;
          }
        }

        if (lastError != null) {
          // Same generation guard as the success path: a stale background
          // fetch finishing after the user switched filter/sort must not
          // surface its error or wipe the freshly-loaded view.
          if (options?.generation != null && options.cacheKey != null) {
            if (getGeneration(options.cacheKey) !== options.generation) return;
          }
          const message = formatErrorMessage(lastError, "Failed to fetch data");
          if (isRateLimitError(message)) {
            // Sticky-flag the rate-limited surface for the brief window
            // before the rate-limit store push lands. The render path
            // (`isRateLimited`) ORs this with the store flag.
            setRecentlyHitRateLimit(true);
            if (append) {
              setLoadMoreError(null);
            } else {
              setError(null);
            }
          } else if (append) {
            setLoadMoreError(message);
          } else {
            setError(message);
          }
        }
      } finally {
        if (!abortSignal?.aborted) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [
      projectPath,
      debouncedSearch,
      filterState,
      type,
      sortOrder,
      numberQuery,
      onFreshFetch,
      onCountUpdate,
    ]
  );

  // ── Mount / filter-change effect ──────────────────────────────────────
  // Three distinct hydration paths on the same cache key:
  //
  // 1. First mount with warm cache slot — hydrate state from cache, then
  //    fire a silent background SWR revalidate so the view sees the cached
  //    data instantly but converges to network-fresh data.
  //
  // 2. Activity reveal of the same key (React 19.2 `<Activity keepMounted>`
  //    unmounts + remounts effects but preserves state). Detect via
  //    lastLoadedEffectKeyRef: if the effect re-fires for the same inputs,
  //    re-run the cache-read + SWR path instead of the cold clear+skeleton
  //    path. This is load-bearing — without it, every reveal would flash
  //    the skeleton over rows that were already on screen.
  //
  // 3. Filter/sort change while mounted (or projectPath change via the
  //    keepMounted body). Warm target slot → hydrate synchronously and
  //    run the silent SWR revalidate (no skeleton flash). Cold target
  //    slot → clear data + show skeleton + cold fetch.
  useEffect(() => {
    if (numberQuery !== null) {
      return;
    }

    // The clear further down lives inside `if (!isFirstMount)`, and a numeric
    // query on mount never reaches it: this effect returns above before
    // setting `mountedRef`, so when the query later becomes text the effect
    // still counts as a first mount and skips that block on a cold cache. A
    // missed `#999` then leaves the empty state claiming "No issue #999 in
    // this view" over the text-search results that replaced it. Clear on entry
    // instead — it is idempotent, and every other path already agrees.
    setExactNumberNotFound(null);

    const abortController = new AbortController();
    loadMoreAbortRef.current?.abort();
    const gen = nextGeneration(cacheKey);
    const isFirstMount = !mountedRef.current;
    // The cacheKey doesn't include `debouncedSearch` (search results aren't
    // cached). Combine them so a search-query change isn't mistaken for an
    // Activity reveal of the same key.
    const effectKey = `${cacheKey}|${debouncedSearch}`;
    // Activity reveal of identical inputs: effects re-fired but state (and
    // mountedRef) survived. Treat as a fresh-mount revalidate path so we
    // don't clear the rows that are already on screen.
    const isActivityRevealOfSameInputs =
      !isFirstMount && lastLoadedEffectKeyRef.current === effectKey;

    if (isFirstMount || isActivityRevealOfSameInputs) {
      mountedRef.current = true;
      // Re-check cache on the effect tick — the useState initializer at
      // mount-render time may have missed a write that lands between render
      // and the first passive effect (poll push, hover prefetch, etc.).
      // When that happens, hydrate state from cache here so the SWR path
      // runs silently instead of the cache-miss path showing a skeleton
      // flash for data that's already available.
      const cached = getCache(cacheKey);
      if (cached) {
        // Apply unconditionally — when the broadcast writes a legitimate
        // empty page (the repo currently has zero matches for this filter),
        // the previously-shown rows must clear on Activity reveal instead
        // of lingering until the revalidate resolves.
        setData(cached.items);
        setCursor(cached.nextCursor);
        setHasMore(cached.hasMore);
        setLastUpdatedAt(cached.timestamp);
        setError(null);
        setExactNumberNotFound(null);
        const plan = planWarmRevalidate(cached, type, filterState, debouncedSearch !== "");
        if (plan === "skip") {
          // No fetch will run its `finally` cleanup — clear the activity
          // flags here. An Activity hide aborts an in-flight revalidate,
          // whose aborted `finally` deliberately skips `setRefreshing(false)`;
          // without this, a skip on reveal would leave the header spinner
          // stuck forever.
          setLoading(false);
          setRefreshing(false);
        } else {
          fetchData(null, false, abortController.signal, {
            revalidating: true,
            generation: gen,
            cacheKey,
            ...(plan === "cached" ? { bypass: false } : {}),
          });
        }
        lastLoadedEffectKeyRef.current = effectKey;
        return () => abortController.abort();
      }
      // Cache miss on Activity reveal: rows are stale but visible — keep them
      // up while the network fetch lands, no skeleton flash.
      if (isActivityRevealOfSameInputs) {
        setError(null);
        setExactNumberNotFound(null);
        fetchData(null, false, abortController.signal, {
          revalidating: true,
          generation: gen,
          cacheKey,
        });
        lastLoadedEffectKeyRef.current = effectKey;
        return () => abortController.abort();
      }
    }

    // Filter/sort changed while mounted (or projectPath changed via the
    // keepMounted body). If the target slot is warm in cache, hydrate
    // synchronously and run the silent SWR revalidate path — no skeleton
    // flash on Open → Closed → Open round-trips. Cold target slot keeps the
    // existing clear-and-skeleton behavior so genuine first views still
    // signal "loading".
    if (!isFirstMount) {
      // Search isn't part of `cacheKey`, so the warm slot only describes
      // the unsearched view. Falling through to the cold path while a
      // search is active flashes unfiltered cached rows before the
      // searched fetch lands; gate hydration to non-search transitions.
      const targetCached = !debouncedSearch ? getCache(cacheKey) : undefined;
      if (targetCached) {
        // A previous cold fetch may have set `loading=true` and then been
        // aborted by this effect's cleanup, which skips its `setLoading(false)`
        // because the abort signal fired. Clear it explicitly so an empty
        // warm slot doesn't render the skeleton via `loading && !data.length`.
        setLoading(false);
        setData(targetCached.items);
        setCursor(targetCached.nextCursor);
        setHasMore(targetCached.hasMore);
        setLastUpdatedAt(targetCached.timestamp);
        setExactNumberNotFound(null);
        setError(null);
        const plan = planWarmRevalidate(targetCached, type, filterState, false);
        if (plan === "skip") {
          // Same activity-flag cleanup as the mount/reveal skip above.
          setRefreshing(false);
        } else {
          fetchData(null, false, abortController.signal, {
            revalidating: true,
            generation: gen,
            cacheKey,
            ...(plan === "cached" ? { bypass: false } : {}),
          });
        }
        lastLoadedEffectKeyRef.current = effectKey;
        return () => abortController.abort();
      }
      setCursor(null);
      setHasMore(false);
      setExactNumberNotFound(null);
      setData([]);
      setLastUpdatedAt(null);
    }
    fetchData(null, false, abortController.signal, {
      generation: gen,
      cacheKey,
    });
    lastLoadedEffectKeyRef.current = effectKey;

    return () => abortController.abort();
  }, [debouncedSearch, filterState, projectPath, type, fetchData, numberQuery, cacheKey]);

  // Default `true` keeps non-dropdown callers and external mounts unaffected;
  // gate the focus + wake revalidation paths on the dropdown's real visibility (#10125).
  const dropdownVisible = useContext(FixedDropdownVisibleContext);

  // Background revalidation when the window regains focus. CI status flips
  // on every push, so a user returning from another app expects the list to
  // refresh — without this, stale green ticks can linger for the full backend
  // cache window. The `visibilitychange` path was removed in #8066: system
  // sleep-wake is consolidated onto `useSystemWakeStore.wakeEpoch` (effect
  // below), and in-tab visibility flips no longer trigger a redundant fetch.
  useEffect(() => {
    if (numberQuery !== null) {
      return;
    }

    const REVALIDATE_THROTTLE_MS = 30_000;
    const abortController = new AbortController();

    const maybeRevalidate = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      if (Date.now() - lastFetchAttemptRef.current < REVALIDATE_THROTTLE_MS) {
        return;
      }
      if (!dropdownVisible) return;
      const gen = nextGeneration(cacheKey);
      void fetchData(null, false, abortController.signal, {
        revalidating: true,
        generation: gen,
        cacheKey,
      });
    };

    window.addEventListener("focus", maybeRevalidate);

    return () => {
      window.removeEventListener("focus", maybeRevalidate);
      abortController.abort();
    };
  }, [fetchData, cacheKey, numberQuery, dropdownVisible]);

  // Wake-coordinator subscription (#8066). Bypasses the 30-second throttle
  // gate that applies to focus events: a system wake is rare enough that we
  // always want a fresh fetch, and the wake-coordinator's threshold (>30s
  // sleep) already filters out short OS naps. `lastSeenWakeEpochRef` is
  // seeded with the current epoch so this consumer never refetches for a
  // wake that landed before it mounted.
  const wakeEpoch = useSystemWakeStore((s) => s.wakeEpoch);
  const lastSeenWakeEpochRef = useRef(useSystemWakeStore.getState().wakeEpoch);
  useLayoutEffect(() => {
    if (numberQuery !== null && wakeEpoch > lastSeenWakeEpochRef.current) {
      lastSeenWakeEpochRef.current = wakeEpoch;
    }
  }, [wakeEpoch, numberQuery]);
  useEffect(() => {
    if (wakeEpoch <= lastSeenWakeEpochRef.current) return;
    // Always consume the epoch — even when a numeric search is active and we
    // skip the list refetch — so the next time the user clears the search,
    // the now-stale wake doesn't replay as a spurious revalidation.
    lastSeenWakeEpochRef.current = wakeEpoch;
    if (numberQuery !== null) return;
    // Same consume-while-gated pattern as the numeric-search skip above: a
    // wake that lands while the dropdown body is hidden must not replay as a
    // redundant fetch on next open (#10125).
    if (!dropdownVisible) return;
    const abortController = new AbortController();
    const gen = nextGeneration(cacheKey);
    void fetchData(null, false, abortController.signal, {
      revalidating: true,
      generation: gen,
      cacheKey,
    });
    return () => abortController.abort();
  }, [wakeEpoch, numberQuery, fetchData, cacheKey, dropdownVisible]);

  // Numeric query effect — handles single number (#42), multi-number
  // (#1, #2, #3), range (#10-20), and open-ended (#>=100) searches.
  // Each fires targeted `getByNumber` calls instead of the list endpoint.
  useEffect(() => {
    if (numberQuery === null) {
      return;
    }
    // Skip numeric fetches when no token is configured — the empty state
    // takes over the UI and any leftover store search would otherwise
    // produce a token error.
    if (githubConfig && !githubConfig.hasToken) {
      return;
    }
    // Skip numeric fetches while rate-limit pause is active. The render
    // path shows the paused state instead of firing a doomed lookup.
    if (rateLimitBlocked) {
      return;
    }

    exactNumberAbortRef.current?.abort();
    loadMoreAbortRef.current?.abort();
    const abortController = new AbortController();
    exactNumberAbortRef.current = abortController;

    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    setLoadingMore(false);
    // Clear any in-flight background refresh indicator. A wake-coordinated
    // revalidate that was running when the user typed `#<n>` will be aborted
    // and skip its own `setRefreshing(false)` in fetchData's finally block;
    // without this, the dropdown header keeps spinning until unmount.
    setRefreshing(false);
    setExactNumberNotFound(null);
    setData([]);
    setCursor(null);
    setHasMore(false);

    const getByNumber = (num: number) =>
      type === "issue"
        ? forgeClient.getIssue(projectPath, num)
        : forgeClient.getPR(projectPath, num);

    const getByNumbers = (numbers: number[]) =>
      type === "issue"
        ? forgeClient.getIssuesByNumbers(projectPath, numbers)
        : forgeClient.getPRsByNumbers(projectPath, numbers);

    const matchesFilter = (item: Issue | PR) => filterState === "all" || item.state === filterState;

    const runNumericAttempt = async () => {
      switch (numberQuery.kind) {
        case "single": {
          const result = await getByNumber(numberQuery.number);
          if (abortController.signal.aborted) return;
          if (result && matchesFilter(result)) {
            setData([result]);
          } else {
            setData([]);
            setExactNumberNotFound(numberQuery.number);
          }
          break;
        }

        case "multi": {
          // Capped the same way a range is: the parser keeps every number the
          // user asked for so the chip can say how many were dropped, but the
          // batch lookup pages through them 20 at a time and an uncapped paste
          // would fan out into a run of sequential GraphQL calls.
          const results = await getByNumbers(numberQuery.numbers.slice(0, MULTI_FETCH_CAP));
          if (abortController.signal.aborted) return;
          const filtered = results.filter(
            (r): r is NonNullable<typeof r> => r !== null && matchesFilter(r)
          );
          setData(filtered);
          break;
        }

        case "range": {
          const numbers: number[] = [];
          for (let n = numberQuery.from; n <= numberQuery.to; n++) {
            numbers.push(n);
          }
          const results = await getByNumbers(numbers);
          if (abortController.signal.aborted) return;
          const filtered = results.filter(
            (r): r is NonNullable<typeof r> => r !== null && matchesFilter(r)
          );
          setData(filtered);
          break;
        }

        case "open-ended": {
          const options: ListOptions = {
            search: `number:>=${numberQuery.from}`,
            state: filterState as ListOptions["state"],
            bypassCache: true,
            sort: "created",
          };
          const result =
            type === "issue"
              ? await forgeClient.listIssues(projectPath, options)
              : await forgeClient.listPRs(projectPath, options);
          if (abortController.signal.aborted) return;
          setData(result.items);
          setCursor(result.nextCursor);
          setHasMore(result.hasMore);
          break;
        }
      }
    };

    const fetchNumeric = async () => {
      let lastError: unknown = null;
      try {
        for (let attempt = 0; attempt < FETCH_MAX_ATTEMPTS; attempt++) {
          try {
            await runNumericAttempt();
            if (abortController.signal.aborted) return;
            setRecentlyHitRateLimit(false);
            lastError = null;
            return;
          } catch (err) {
            if (abortController.signal.aborted) return;
            lastError = err;
            const message = formatErrorMessage(err, "Failed to fetch data");
            const retryable =
              attempt < FETCH_MAX_ATTEMPTS - 1 &&
              isTransientNetworkError(message) &&
              !isTokenRelatedError(message) &&
              !isRateLimitError(message);
            if (!retryable) break;
            try {
              await abortableDelay(FETCH_RETRY_DELAYS_MS[attempt]!, abortController.signal);
            } catch {
              return;
            }
            if (abortController.signal.aborted) return;
          }
        }
        if (lastError != null) {
          const message = formatErrorMessage(lastError, "Failed to fetch data");
          if (isRateLimitError(message)) {
            setRecentlyHitRateLimit(true);
            setError(null);
          } else {
            setError(message);
          }
        }
      } finally {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      }
    };

    void fetchNumeric();

    return () => {
      abortController.abort();
    };
  }, [numberQuery, projectPath, type, filterState, retryKey, githubConfig, rateLimitBlocked]);

  const handleLoadMore = useCallback(() => {
    if (!loadingMore && hasMore) {
      fetchData(cursor, true, undefined);
    }
  }, [loadingMore, hasMore, fetchData, cursor]);

  const handleRetry = () => {
    if (numberQuery !== null) {
      setRetryKey((k) => k + 1);
    } else {
      setCursor(null);
      const gen = nextGeneration(cacheKey);
      fetchData(null, false, undefined, { generation: gen, cacheKey });
    }
  };

  // Manual refresh — fires a force-bypass fetch and shows the loading
  // indicator in the refresh button. Doesn't clear current rows; the SWR
  // revalidate path keeps them visible while fresh data arrives.
  const handleManualRefresh = useCallback(() => {
    if (numberQuery !== null) {
      setRetryKey((k) => k + 1);
      return;
    }
    setError(null);
    const gen = nextGeneration(cacheKey);
    void fetchData(null, false, undefined, {
      revalidating: true,
      generation: gen,
      cacheKey,
    });
  }, [numberQuery, cacheKey, fetchData]);

  const isTokenError = isTokenRelatedError(error);

  return {
    data,
    debouncedSearch,
    numberQuery,
    hasMore,
    loading,
    loadingMore,
    refreshing,
    error,
    loadMoreError,
    lastUpdatedAt,
    exactNumberNotFound,
    isTokenError,
    isRateLimited,
    rateLimitResetAt,
    handleLoadMore,
    handleRetry,
    handleManualRefresh,
  };
}
