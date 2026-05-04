import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useDebounce } from "@/hooks/useDebounce";
import {
  buildCacheKey,
  getCache,
  setCache,
  nextGeneration,
  getGeneration,
} from "@/lib/githubResourceCache";
import { isTokenRelatedError, isTransientNetworkError } from "@/lib/githubErrors";
import { githubClient } from "@/clients/githubClient";
import type { GitHubIssue, GitHubPR, GitHubSortOrder } from "@shared/types/github";
import { parseNumberQuery } from "@/lib/parseNumberQuery";
import { formatErrorMessage } from "@shared/utils/errorMessage";

type StateFilter = string;

const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_DELAYS_MS = [500, 1500];

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
}

export interface UseGitHubResourceListSWRReturn {
  data: (GitHubIssue | GitHubPR)[];
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
}: UseGitHubResourceListSWRParams): UseGitHubResourceListSWRReturn {
  const debouncedSearch = useDebounce(searchQuery, 300);

  const cacheKey = useMemo(
    () => buildCacheKey(projectPath, type, filterState as string, sortOrder),
    [projectPath, type, filterState, sortOrder]
  );
  const cachedEntry = useMemo(() => getCache(cacheKey), [cacheKey]);

  const [data, setData] = useState<(GitHubIssue | GitHubPR)[]>(() => cachedEntry?.items ?? []);
  const [cursor, setCursor] = useState<string | null>(() => cachedEntry?.endCursor ?? null);
  const [hasMore, setHasMore] = useState(() => cachedEntry?.hasNextPage ?? false);
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

  const fetchData = useCallback(
    async (
      currentCursor: string | null | undefined,
      append: boolean = false,
      abortSignal?: AbortSignal,
      options?: { revalidating?: boolean; generation?: number; cacheKey?: string }
    ) => {
      if (!projectPath) return;
      // Skip the fetch entirely when no token is configured. The render path
      // shows a dedicated empty state; firing fetches here would just produce
      // a token-error toast for users who haven't set up GitHub yet.
      const cfg = githubConfigRef.current;
      if (cfg && !cfg.hasToken) return;

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
        const fetchOptions = {
          cwd: projectPath,
          search: searchOverride || debouncedSearch || undefined,
          state: filterState as "open" | "closed" | "merged" | "all",
          cursor: currentCursor || undefined,
          // Append (load-more) always wants the next page from network.
          // SWR revalidates also bypass cache — that's the whole point of
          // a revalidate. Cold-mount fetches (no cache, no revalidating
          // flag) honor the backend's 60s in-memory cache instead of
          // bypassing — same data either way, but the cached path returns
          // synchronously and avoids the click-time round-trip the user
          // sees as "reload".
          bypassCache: append ? false : isRevalidate ? true : false,
          sortOrder,
        };

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            const result =
              type === "issue"
                ? await githubClient.listIssues(
                    fetchOptions as Parameters<typeof githubClient.listIssues>[0]
                  )
                : await githubClient.listPullRequests(
                    fetchOptions as Parameters<typeof githubClient.listPullRequests>[0]
                  );

            // Check if aborted before updating state
            if (abortSignal?.aborted) return;

            // Generation guard: discard stale responses
            if (options?.generation != null && options.cacheKey != null) {
              if (getGeneration(options.cacheKey) !== options.generation) return;
            }

            if (append) {
              setData((prev) => [...prev, ...result.items]);
            } else {
              setData(result.items);
            }
            setCursor(result.pageInfo.endCursor);
            setHasMore(result.pageInfo.hasNextPage);

            // Write first-page results to cache (skip search-filtered results)
            if (!append && options?.cacheKey && !debouncedSearch) {
              const now = Date.now();
              setCache(options.cacheKey, {
                items: result.items,
                endCursor: result.pageInfo.endCursor,
                hasNextPage: result.pageInfo.hasNextPage,
                timestamp: now,
              });
              setLastUpdatedAt(now);
              // Notify parent (toolbar count badge) that fresh first-page data
              // landed. Gated on `isRevalidate` so it fires only when
              // `bypassCache: true` was sent — the main process's
              // `updateRepoStatsCount` runs on the GraphQL path that follows a
              // bypass, so the toolbar's `refresh()` call is guaranteed to see
              // an updated `repoStatsCache` entry. Cold-mount fetches
              // (`bypassCache: false`) may hit the main-process cache and
              // skip the count update entirely; firing onFreshFetch there
              // would be a wasted IPC round-trip.
              if (isRevalidate) {
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
              !isTokenRelatedError(message);
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
          if (append) {
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
    [projectPath, debouncedSearch, filterState, type, sortOrder, numberQuery, onFreshFetch]
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
        setCursor(cached.endCursor);
        setHasMore(cached.hasNextPage);
        setLastUpdatedAt(cached.timestamp);
        setError(null);
        fetchData(null, false, abortController.signal, {
          revalidating: true,
          generation: gen,
          cacheKey,
        });
        lastLoadedEffectKeyRef.current = effectKey;
        return () => abortController.abort();
      }
      // Cache miss on Activity reveal: rows are stale but visible — keep them
      // up while the network fetch lands, no skeleton flash.
      if (isActivityRevealOfSameInputs) {
        setError(null);
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
        setCursor(targetCached.endCursor);
        setHasMore(targetCached.hasNextPage);
        setLastUpdatedAt(targetCached.timestamp);
        setExactNumberNotFound(null);
        setError(null);
        fetchData(null, false, abortController.signal, {
          revalidating: true,
          generation: gen,
          cacheKey,
        });
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

  // Background revalidation when the window regains focus or the tab becomes
  // visible. CI status flips on every push, so a user returning from another
  // app expects the list to refresh — without this, stale green ticks can
  // linger for the full backend cache window.
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
      const gen = nextGeneration(cacheKey);
      void fetchData(null, false, abortController.signal, {
        revalidating: true,
        generation: gen,
        cacheKey,
      });
    };

    document.addEventListener("visibilitychange", maybeRevalidate);
    window.addEventListener("focus", maybeRevalidate);

    return () => {
      document.removeEventListener("visibilitychange", maybeRevalidate);
      window.removeEventListener("focus", maybeRevalidate);
      abortController.abort();
    };
  }, [fetchData, cacheKey, numberQuery]);

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

    exactNumberAbortRef.current?.abort();
    loadMoreAbortRef.current?.abort();
    const abortController = new AbortController();
    exactNumberAbortRef.current = abortController;

    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    setLoadingMore(false);
    setExactNumberNotFound(null);
    setData([]);
    setCursor(null);
    setHasMore(false);

    const getByNumber = (num: number) =>
      type === "issue"
        ? githubClient.getIssueByNumber(projectPath, num)
        : githubClient.getPRByNumber(projectPath, num);

    const matchesFilter = (item: GitHubIssue | GitHubPR) =>
      filterState === "all" || item.state.toLowerCase() === filterState;

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
          const results = await Promise.all(numberQuery.numbers.map(getByNumber));
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
          const results = await Promise.all(numbers.map(getByNumber));
          if (abortController.signal.aborted) return;
          const filtered = results.filter(
            (r): r is NonNullable<typeof r> => r !== null && matchesFilter(r)
          );
          setData(filtered);
          break;
        }

        case "open-ended": {
          const options = {
            cwd: projectPath,
            search: `number:>=${numberQuery.from}`,
            state: filterState as "open" | "closed" | "merged" | "all",
            bypassCache: true,
            sortOrder: "created" as const,
          };
          const result =
            type === "issue"
              ? await githubClient.listIssues(
                  options as Parameters<typeof githubClient.listIssues>[0]
                )
              : await githubClient.listPullRequests(
                  options as Parameters<typeof githubClient.listPullRequests>[0]
                );
          if (abortController.signal.aborted) return;
          setData(result.items);
          setCursor(result.pageInfo.endCursor);
          setHasMore(result.pageInfo.hasNextPage);
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
            lastError = null;
            return;
          } catch (err) {
            if (abortController.signal.aborted) return;
            lastError = err;
            const message = formatErrorMessage(err, "Failed to fetch data");
            const retryable =
              attempt < FETCH_MAX_ATTEMPTS - 1 &&
              isTransientNetworkError(message) &&
              !isTokenRelatedError(message);
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
          setError(message);
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
  }, [numberQuery, projectPath, type, filterState, retryKey, githubConfig]);

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
    handleLoadMore,
    handleRetry,
    handleManualRefresh,
  };
}
