import { useState, useEffect, useMemo, useCallback, useRef, type KeyboardEvent } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useDebounce } from "@/hooks/useDebounce";
import {
  Search,
  ExternalLink,
  RefreshCw,
  WifiOff,
  Plus,
  Settings,
  X,
  Filter,
  Github,
} from "lucide-react";
import {
  buildCacheKey,
  getCache,
  setCache,
  nextGeneration,
  getGeneration,
} from "@/lib/githubResourceCache";
import { isTokenRelatedError, isTransientNetworkError } from "@/lib/githubErrors";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { githubClient } from "@/clients/githubClient";
import { actionService } from "@/services/ActionService";
import { GitHubListItem } from "./GitHubListItem";
import { BulkActionBar } from "./BulkActionBar";
import { useIssueSelection } from "@/hooks/useIssueSelection";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import {
  useGitHubFilterStore,
  type IssueStateFilter,
  type PRStateFilter,
} from "@/store/githubFilterStore";
import { useGitHubConfigStore } from "@/store/githubConfigStore";
import type { GitHubIssue, GitHubPR, GitHubSortOrder } from "@shared/types/github";
import { parseNumberQuery, MULTI_FETCH_CAP } from "@/lib/parseNumberQuery";
import {
  GitHubResourceRowsSkeleton,
  MAX_SKELETON_ITEMS,
  RESOURCE_ITEM_HEIGHT_PX,
} from "./GitHubDropdownSkeletons";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { formatTimeAgo } from "@/utils/timeAgo";

type StateFilter = IssueStateFilter | PRStateFilter;

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

function sanitizeIpcError(message: string): string {
  const cleaned = message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "").trim();
  return cleaned.length > 120 ? cleaned.slice(0, 117) + "…" : cleaned;
}

interface LoadMoreFooterContext {
  hasMore: boolean;
  loadingMore: boolean;
  isLoadMoreActive: boolean;
  loadMoreError: string | null;
  type: "issue" | "pr";
  onLoadMore: () => void;
  onOpenSettings: () => void;
}

function LoadMoreFooter({ context }: { context?: LoadMoreFooterContext }) {
  if (!context || !context.hasMore) return null;
  const { loadingMore, isLoadMoreActive, loadMoreError, type, onLoadMore, onOpenSettings } =
    context;
  return (
    <div className="p-3 space-y-2">
      {loadMoreError && (
        <div className="p-2 rounded-[var(--radius-md)] bg-overlay-soft border border-[var(--border-divider)]">
          <p className="text-xs text-muted-foreground">{sanitizeIpcError(loadMoreError)}</p>
          {isTokenRelatedError(loadMoreError) ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenSettings}
              className="mt-1 text-muted-foreground hover:text-daintree-text h-6 text-xs"
            >
              <Settings className="h-3 w-3" />
              Open GitHub Settings
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={onLoadMore}
              className="mt-1 text-muted-foreground hover:text-daintree-text h-6 text-xs"
            >
              Retry
            </Button>
          )}
        </div>
      )}
      <Button
        id={`github-${type}-load-more`}
        variant="ghost"
        onClick={onLoadMore}
        disabled={loadingMore}
        className={cn(
          "w-full text-muted-foreground hover:text-daintree-text",
          isLoadMoreActive && "ring-1 ring-daintree-accent text-daintree-text"
        )}
      >
        {loadingMore ? (
          <>
            <RefreshCw className="animate-spin" />
            Loading...
          </>
        ) : (
          "Load More"
        )}
      </Button>
    </div>
  );
}

interface GitHubResourceListProps {
  type: "issue" | "pr";
  projectPath: string;
  onClose?: () => void;
  initialCount?: number | null;
}

export function GitHubResourceList({
  type,
  projectPath,
  onClose,
  initialCount,
}: GitHubResourceListProps) {
  const searchQuery = useGitHubFilterStore((s) =>
    type === "issue" ? s.issueSearchQuery : s.prSearchQuery
  );
  const setSearchQuery = useGitHubFilterStore((s) =>
    type === "issue" ? s.setIssueSearchQuery : s.setPrSearchQuery
  ) as (q: string) => void;
  const filterState = useGitHubFilterStore((s) => (type === "issue" ? s.issueFilter : s.prFilter));
  const setFilterState = useGitHubFilterStore((s) =>
    type === "issue" ? s.setIssueFilter : s.setPrFilter
  ) as (f: StateFilter) => void;
  const sortOrder = useGitHubFilterStore((s) =>
    type === "issue" ? s.issueSortOrder : s.prSortOrder
  );
  const setSortOrder = useGitHubFilterStore((s) =>
    type === "issue" ? s.setIssueSortOrder : s.setPrSortOrder
  ) as (o: GitHubSortOrder) => void;
  const githubConfigInitialized = useGitHubConfigStore((s) => s.isInitialized);
  const githubConfig = useGitHubConfigStore((s) => s.config);
  const showNoTokenEmptyState =
    githubConfigInitialized && githubConfig !== null && !githubConfig.hasToken;

  // Self-init the GitHub config store so the no-token empty state can render
  // before any other code path has triggered initialization. This mirrors the
  // pattern used in BulkCreateWorktreeDialog.
  useEffect(() => {
    void useGitHubConfigStore.getState().initialize();
  }, []);
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
  const [, setTick] = useState(0);
  const [exactNumberNotFound, setExactNumberNotFound] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [sortPopoverOpen, setSortPopoverOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
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

  const selection = useIssueSelection();
  const issueCacheRef = useRef<Map<number, GitHubIssue>>(new Map());
  const prCacheRef = useRef<Map<number, GitHubPR>>(new Map());

  // Accumulate item objects into the session cache whenever data changes
  useEffect(() => {
    for (const item of data) {
      if ("isDraft" in item) {
        prCacheRef.current.set(item.number, item as GitHubPR);
      } else {
        issueCacheRef.current.set(item.number, item as GitHubIssue);
      }
    }
  }, [data]);

  const debouncedSearch = useDebounce(searchQuery, 300);

  const numberQuery = useMemo(() => parseNumberQuery(searchQuery), [searchQuery]);
  const exactNumberAbortRef = useRef<AbortController | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  const stateTabs = useMemo(() => {
    if (type === "pr") {
      return [
        { id: "open", label: "Open" },
        { id: "merged", label: "Merged" },
        { id: "closed", label: "Closed" },
      ];
    }
    return [
      { id: "open", label: "Open" },
      { id: "closed", label: "Closed" },
    ];
  }, [type]);

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
    [projectPath, debouncedSearch, filterState, type, sortOrder, numberQuery]
  );

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
    // keepMounted body): clear and refetch with skeleton. First-mount cache
    // miss skips the explicit clear (data is already [] from the useState
    // initializer) so no spurious setState/render churn.
    if (!isFirstMount) {
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

  const handleClose = useCallback(() => {
    selection.clear();
    issueCacheRef.current.clear();
    prCacheRef.current.clear();
    onClose?.();
  }, [onClose, selection]);

  const handleOpenInGitHub = () => {
    const query = searchQuery.trim() || undefined;
    const state = filterState as string;
    if (type === "issue") {
      void actionService.dispatch(
        "github.openIssues",
        { projectPath, query, state },
        { source: "user" }
      );
    } else {
      void actionService.dispatch(
        "github.openPRs",
        { projectPath, query, state },
        { source: "user" }
      );
    }
    handleClose();
  };

  const handleCreateNew = () => {
    // Use openIssues/openPRs with /new path would require a new IPC
    // For now, just open the GitHub page
    handleOpenInGitHub();
  };

  const openCreateDialog = useWorktreeSelectionStore((s) => s.openCreateDialog);
  const openCreateDialogForPR = useWorktreeSelectionStore((s) => s.openCreateDialogForPR);
  const selectWorktree = useWorktreeSelectionStore((s) => s.selectWorktree);

  const handleCreateWorktree = useCallback(
    (item: GitHubIssue | GitHubPR) => {
      if ("isDraft" in item) {
        openCreateDialogForPR(item);
      } else {
        openCreateDialog(item);
      }
      handleClose();
    },
    [openCreateDialog, openCreateDialogForPR, handleClose]
  );

  const handleSwitchToWorktree = useCallback(
    (worktreeId: string) => {
      selectWorktree(worktreeId);
      handleClose();
    },
    [selectWorktree, handleClose]
  );

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    inputRef.current?.focus();
  }, [setSearchQuery]);

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

  const listId = `github-${type}-list`;
  const maxIndex = data.length - 1 + (hasMore ? 1 : 0);
  const activeItem = activeIndex >= 0 && activeIndex < data.length ? data[activeIndex] : null;
  const activeItemId = activeItem ? `github-${type}-option-${activeItem.number}` : undefined;
  const isLoadMoreActive = hasMore && activeIndex === data.length;

  useEffect(() => {
    setActiveIndex(-1);
  }, [data]);

  // Re-render the "Updated Xm ago" label every 60s while a stale-data banner is visible.
  useEffect(() => {
    if (lastUpdatedAt == null || error == null) return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [lastUpdatedAt, error]);

  useEffect(() => {
    if (activeIndex < 0) return;
    if (isLoadMoreActive) {
      document.getElementById(`github-${type}-load-more`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (activeIndex < data.length) {
      virtuosoRef.current?.scrollIntoView({ index: activeIndex, behavior: "auto" });
    }
  }, [activeIndex, data.length, isLoadMoreActive, type]);

  const handleInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setActiveIndex((prev) => Math.min(prev + 1, maxIndex));
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setActiveIndex((prev) => Math.max(prev - 1, -1));
          break;
        case "Enter": {
          e.preventDefault();
          e.stopPropagation();
          if (isLoadMoreActive) {
            handleLoadMore();
          } else if (activeItem) {
            if (e.metaKey || e.ctrlKey) {
              void actionService.dispatch(
                "system.openExternal",
                { url: activeItem.url },
                { source: "user" }
              );
            } else {
              const worktrees = getCurrentViewStore().getState().worktrees;
              let matchedWt: { id: string } | undefined;
              for (const wt of worktrees.values()) {
                if (
                  type === "issue"
                    ? wt.issueNumber === activeItem.number
                    : wt.prNumber === activeItem.number
                ) {
                  matchedWt = wt;
                  break;
                }
              }
              if (matchedWt) {
                handleSwitchToWorktree(matchedWt.id);
              } else if (activeItem.state === "OPEN") {
                handleCreateWorktree(activeItem);
              }
            }
          }
          break;
        }
        case "Escape":
          e.preventDefault();
          if (selection.isSelectionActive) {
            selection.clear();
            e.nativeEvent.stopImmediatePropagation();
          } else if (searchQuery !== "") {
            setSearchQuery("");
            e.nativeEvent.stopImmediatePropagation();
          } else {
            e.stopPropagation();
            handleClose();
          }
          break;
      }
    },
    [
      maxIndex,
      isLoadMoreActive,
      activeItem,
      handleLoadMore,
      handleSwitchToWorktree,
      handleCreateWorktree,
      handleClose,
      type,
      searchQuery,
      setSearchQuery,
      selection,
    ]
  );

  const isTokenError = isTokenRelatedError(error);

  const handleOpenGitHubSettings = useCallback(() => {
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "github", sectionId: "github-token" },
      { source: "user" }
    );
    onClose?.();
  }, [onClose]);

  const footerContext = useMemo<LoadMoreFooterContext>(
    () => ({
      hasMore,
      loadingMore,
      isLoadMoreActive,
      loadMoreError,
      type,
      onLoadMore: handleLoadMore,
      onOpenSettings: handleOpenGitHubSettings,
    }),
    [
      hasMore,
      loadingMore,
      isLoadMoreActive,
      loadMoreError,
      type,
      handleLoadMore,
      handleOpenGitHubSettings,
    ]
  );

  const renderEmpty = () => {
    if (exactNumberNotFound !== null) {
      return (
        <div className="p-8 text-center text-muted-foreground">
          <p className="text-sm">
            {type === "issue" ? "Issue" : "PR"} #{exactNumberNotFound} not found
          </p>
        </div>
      );
    }

    return (
      <div className="p-8 text-center text-muted-foreground">
        <p className="text-sm">
          No {type === "issue" ? "issues" : "pull requests"} found
          {debouncedSearch && ` for "${debouncedSearch}"`}
        </p>
      </div>
    );
  };

  if (showNoTokenEmptyState) {
    return (
      <div className="relative w-[450px] flex flex-col h-[500px]">
        <EmptyState
          variant="zero-data"
          icon={<Github />}
          title="GitHub not connected"
          description="Add a personal access token to browse issues and pull requests for this project."
          action={
            <Button variant="outline" size="sm" onClick={handleOpenGitHubSettings}>
              <Settings className="h-3.5 w-3.5" />
              Add GitHub token
            </Button>
          }
          className="flex-1 justify-center"
        />
      </div>
    );
  }

  return (
    <div className="relative w-[450px] flex flex-col h-[500px]">
      <div className="p-3 border-b border-[var(--border-divider)] space-y-3 shrink-0">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "flex items-center gap-1.5 px-2 py-1.5 rounded-[var(--radius-md)] flex-1 min-w-0",
              "bg-overlay-soft border border-[var(--border-overlay)]",
              "focus-within:border-daintree-accent focus-within:ring-1 focus-within:ring-daintree-accent/20"
            )}
          >
            <Search
              className="w-3.5 h-3.5 shrink-0 text-daintree-text/40 pointer-events-none"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="text"
              placeholder={`Search ${type === "issue" ? "issues" : "pull requests"}...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleInputKeyDown}
              autoFocus
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={true}
              aria-haspopup="listbox"
              aria-controls={listId}
              aria-activedescendant={activeItemId}
              aria-label={`Search ${type === "issue" ? "issues" : "pull requests"}`}
              className="flex-1 min-w-0 text-sm bg-transparent text-daintree-text placeholder:text-muted-foreground focus:outline-hidden"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={handleClearSearch}
                aria-label="Clear search"
                className="flex items-center justify-center w-5 h-5 rounded shrink-0 text-daintree-text/40 hover:text-daintree-text"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={handleManualRefresh}
            disabled={loading || refreshing}
            aria-label={`Refresh ${type === "issue" ? "issues" : "pull requests"}`}
            aria-busy={loading || refreshing}
            title={
              refreshing || loading
                ? "Refreshing…"
                : `Refresh ${type === "issue" ? "issues" : "pull requests"}`
            }
            className={cn(
              "flex items-center justify-center w-7 h-7 rounded shrink-0",
              "text-daintree-text/60 hover:text-daintree-text hover:bg-tint/[0.06]",
              "transition-colors disabled:cursor-default",
              (loading || refreshing) && "text-status-info"
            )}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", (loading || refreshing) && "animate-spin")} />
          </button>
          <Popover open={sortPopoverOpen} onOpenChange={setSortPopoverOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`Sort ${type === "issue" ? "issues" : "pull requests"}`}
                aria-haspopup="dialog"
                className={cn(
                  "relative flex items-center justify-center w-7 h-7 rounded shrink-0",
                  "text-daintree-text/60 hover:text-daintree-text hover:bg-tint/[0.06]",
                  "transition-colors",
                  sortOrder !== "created" && "text-status-info"
                )}
              >
                <Filter className="w-3.5 h-3.5" />
                {sortOrder !== "created" && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-status-info" />
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={8}
              className="w-48 p-3"
              onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
              onTouchStart={(e: React.TouchEvent) => e.stopPropagation()}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setSortPopoverOpen(false);
                }
              }}
            >
              <div className="text-[10px] font-medium text-daintree-text/50 uppercase tracking-wide mb-2">
                Sort by
              </div>
              <div className="flex flex-col gap-1" role="radiogroup" aria-label="Sort order">
                {(
                  [
                    { value: "created", label: "Newest" },
                    { value: "updated", label: "Recently updated" },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setSortOrder(option.value)}
                    role="radio"
                    aria-checked={sortOrder === option.value}
                    className={cn(
                      "flex items-center gap-2 px-2 py-1 text-xs rounded",
                      sortOrder === option.value
                        ? "bg-overlay-soft text-daintree-text"
                        : "text-daintree-text/70 hover:bg-overlay-medium"
                    )}
                  >
                    <div
                      className={cn(
                        "w-3 h-3 rounded-full border",
                        sortOrder === option.value
                          ? "border-daintree-text bg-daintree-text"
                          : "border-daintree-border"
                      )}
                    >
                      {sortOrder === option.value && (
                        <div className="w-full h-full flex items-center justify-center">
                          <div className="w-1.5 h-1.5 bg-text-inverse rounded-full" />
                        </div>
                      )}
                    </div>
                    {option.label}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>

        {searchQuery.trim() !== "" &&
          data.length > 0 &&
          !loading &&
          (() => {
            const allSelected = data.every((item) => selection.selectedIds.has(item.number));
            const unassigned =
              type === "issue"
                ? data.filter((item) => (item as GitHubIssue).assignees.length === 0)
                : [];
            return (
              <div
                className="flex items-center gap-1.5"
                role="group"
                aria-label="Selection actions"
              >
                <button
                  type="button"
                  onClick={() => {
                    if (allSelected) {
                      selection.clear();
                    } else {
                      selection.selectAll(data.map((item) => item.number));
                    }
                  }}
                  className="text-xs text-daintree-text/50 hover:text-daintree-text focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent transition-colors px-1 py-0.5 rounded"
                >
                  {allSelected ? "Deselect all" : `Select all (${data.length})`}
                </button>
                {unassigned.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      selection.selectAll(unassigned.map((item) => item.number));
                    }}
                    className="text-xs text-daintree-text/50 hover:text-daintree-text focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent transition-colors px-1 py-0.5 rounded"
                  >
                    {`Select unassigned (${unassigned.length})`}
                  </button>
                )}
              </div>
            );
          })()}

        <div
          className="flex p-0.5 bg-overlay-soft border border-[var(--border-divider)] rounded-[var(--radius-md)]"
          role="group"
          aria-label="Filter by state"
        >
          {stateTabs.map((tab) => {
            const isActive = filterState === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilterState(tab.id as StateFilter)}
                aria-pressed={isActive}
                className={cn(
                  "flex-1 px-3 py-1 text-xs font-medium rounded transition-colors",
                  isActive
                    ? "bg-overlay-medium text-daintree-text"
                    : "text-muted-foreground hover:text-daintree-text"
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {numberQuery?.kind === "range" && numberQuery.truncated && (
          <p className="text-xs text-muted-foreground">
            Showing first {MULTI_FETCH_CAP} of range (capped)
          </p>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {loading && !data.length ? (
          <div className="overflow-y-auto flex-1 min-h-0">
            <GitHubResourceRowsSkeleton
              count={initialCount && initialCount > 0 ? initialCount : MAX_SKELETON_ITEMS}
            />
          </div>
        ) : data.length > 0 ? (
          <>
            {error && (
              <div className="px-3 py-2 border-b border-[var(--border-divider)] flex items-center gap-2 text-muted-foreground bg-overlay-soft shrink-0">
                <WifiOff className="h-3.5 w-3.5 shrink-0" />
                <span className="text-xs truncate">{sanitizeIpcError(error)}</span>
                {lastUpdatedAt != null && !debouncedSearch && (
                  <span className="text-xs text-muted-foreground/70 shrink-0 whitespace-nowrap">
                    · Updated {formatTimeAgo(lastUpdatedAt)}
                  </span>
                )}
                {isTokenError ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleOpenGitHubSettings}
                    className="ml-auto h-6 text-xs text-muted-foreground hover:text-daintree-text shrink-0"
                  >
                    <Settings className="h-3 w-3" />
                    Settings
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleRetry}
                    className="ml-auto h-6 text-xs text-muted-foreground hover:text-daintree-text shrink-0"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Retry
                  </Button>
                )}
              </div>
            )}
            <div id={listId} role="listbox" aria-multiselectable={true} className="flex-1 min-h-0">
              <Virtuoso
                ref={virtuosoRef}
                data={data}
                context={footerContext}
                style={{ height: "100%" }}
                fixedItemHeight={RESOURCE_ITEM_HEIGHT_PX}
                computeItemKey={(_, item) => item.number}
                increaseViewportBy={{ top: 0, bottom: 200 }}
                endReached={() => {
                  if (!loadingMore && !loading && hasMore) handleLoadMore();
                }}
                components={{ Footer: LoadMoreFooter }}
                itemContent={(index, item) => (
                  <GitHubListItem
                    item={item}
                    type={type}
                    onCreateWorktree={handleCreateWorktree}
                    onSwitchToWorktree={handleSwitchToWorktree}
                    optionId={`github-${type}-option-${item.number}`}
                    isActive={activeIndex === index}
                    isSelected={selection.selectedIds.has(item.number)}
                    isSelectionActive={selection.isSelectionActive}
                    onToggleSelect={(e: React.MouseEvent) => {
                      if (e.shiftKey) {
                        selection.toggleRange(index, (i) => data[i]!.number);
                      } else {
                        selection.toggle(item.number, index);
                      }
                    }}
                  />
                )}
              />
            </div>
          </>
        ) : error ? (
          <div className="p-8 text-center text-muted-foreground">
            <WifiOff className="h-5 w-5 mx-auto mb-2 opacity-50" />
            <p className="text-sm">{sanitizeIpcError(error)}</p>
            {isTokenError ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleOpenGitHubSettings}
                className="mt-2 text-muted-foreground hover:text-daintree-text"
              >
                <Settings className="h-3.5 w-3.5" />
                Open GitHub Settings
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRetry}
                className="mt-2 text-muted-foreground hover:text-daintree-text"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </Button>
            )}
          </div>
        ) : (
          renderEmpty()
        )}
      </div>

      <div className="p-3 border-t border-[var(--border-divider)] flex items-center justify-between shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleOpenInGitHub}
          className="text-muted-foreground hover:text-daintree-text gap-1.5"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          View on GitHub
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCreateNew}
          className="text-muted-foreground hover:text-daintree-text gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      </div>

      <BulkActionBar
        mode={type === "issue" ? "issue" : "pr"}
        selectedIssues={
          type === "issue"
            ? Array.from(selection.selectedIds)
                .map((id) => issueCacheRef.current.get(id))
                .filter((issue): issue is GitHubIssue => issue !== undefined)
            : []
        }
        selectedPRs={
          type === "pr"
            ? Array.from(selection.selectedIds)
                .map((id) => prCacheRef.current.get(id))
                .filter((pr): pr is GitHubPR => pr !== undefined)
            : []
        }
        onClear={selection.clear}
        onCloseDropdown={onClose}
      />
    </div>
  );
}
