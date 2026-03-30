import { useState, useEffect, useMemo, useCallback, useRef, type KeyboardEvent } from "react";
import { useDebounce } from "@/hooks/useDebounce";
import { Search, ExternalLink, RefreshCw, WifiOff, Plus, Settings, X, Filter } from "lucide-react";
import {
  buildCacheKey,
  getCache,
  setCache,
  nextGeneration,
  getGeneration,
} from "@/lib/githubResourceCache";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { githubClient } from "@/clients/githubClient";
import { actionService } from "@/services/ActionService";
import { GitHubListItem } from "./GitHubListItem";
import { BulkActionBar } from "./BulkActionBar";
import { useIssueSelection } from "@/hooks/useIssueSelection";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import {
  useGitHubFilterStore,
  type IssueStateFilter,
  type PRStateFilter,
} from "@/store/githubFilterStore";
import type { GitHubIssue, GitHubPR, GitHubSortOrder } from "@shared/types/github";
import { parseNumberQuery, MULTI_FETCH_CAP } from "@/lib/parseNumberQuery";
import { GitHubResourceRowsSkeleton, MAX_SKELETON_ITEMS } from "./GitHubDropdownSkeletons";

type StateFilter = IssueStateFilter | PRStateFilter;

function sanitizeIpcError(message: string): string {
  const cleaned = message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "").trim();
  return cleaned.length > 120 ? cleaned.slice(0, 117) + "…" : cleaned;
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
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [exactNumberNotFound, setExactNumberNotFound] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [sortPopoverOpen, setSortPopoverOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);

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

  const fetchData = useCallback(
    async (
      currentCursor: string | null | undefined,
      append: boolean = false,
      abortSignal?: AbortSignal,
      options?: { revalidating?: boolean; generation?: number; cacheKey?: string }
    ) => {
      if (!projectPath) return;

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
      }

      try {
        const searchOverride =
          numberQuery?.kind === "open-ended" ? `number:>=${numberQuery.from}` : undefined;
        const fetchOptions = {
          cwd: projectPath,
          search: searchOverride || debouncedSearch || undefined,
          state: filterState as "open" | "closed" | "merged" | "all",
          cursor: currentCursor || undefined,
          bypassCache: !append,
          sortOrder,
        };

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
          setCache(options.cacheKey, {
            items: result.items,
            endCursor: result.pageInfo.endCursor,
            hasNextPage: result.pageInfo.hasNextPage,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        if (abortSignal?.aborted) return;
        const message = err instanceof Error ? err.message : "Failed to fetch data";
        if (append) {
          setLoadMoreError(message);
        } else {
          setError(message);
        }
      } finally {
        if (!abortSignal?.aborted) {
          setLoading(false);
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

    if (!mountedRef.current) {
      // First mount: check if we have cached data (SWR path)
      mountedRef.current = true;
      const cached = getCache(cacheKey);
      if (cached) {
        // Data already hydrated via useState initializer — background revalidate
        setError(null);
        fetchData(null, false, abortController.signal, {
          revalidating: true,
          generation: gen,
          cacheKey,
        });
        return () => abortController.abort();
      }
    }

    // Cache miss or filter/sort changed while mounted: fresh fetch with skeleton
    setCursor(null);
    setHasMore(false);
    setExactNumberNotFound(null);
    setData([]);
    fetchData(null, false, abortController.signal, {
      generation: gen,
      cacheKey,
    });

    return () => abortController.abort();
  }, [debouncedSearch, filterState, projectPath, type, fetchData, numberQuery, cacheKey]);

  useEffect(() => {
    if (numberQuery === null) {
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

    const fetchNumeric = async () => {
      try {
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
      } catch (err) {
        if (abortController.signal.aborted) return;
        const message = err instanceof Error ? err.message : "Failed to fetch data";
        setError(message);
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
  }, [numberQuery, projectPath, type, filterState, retryKey]);

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

  const listId = `github-${type}-list`;
  const maxIndex = data.length - 1 + (hasMore ? 1 : 0);
  const activeItem = activeIndex >= 0 && activeIndex < data.length ? data[activeIndex] : null;
  const activeItemId = activeItem ? `github-${type}-option-${activeItem.number}` : undefined;
  const isLoadMoreActive = hasMore && activeIndex === data.length;

  useEffect(() => {
    setActiveIndex(-1);
  }, [data]);

  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const activeEl = activeItemId
        ? document.getElementById(activeItemId)
        : isLoadMoreActive
          ? document.getElementById(`github-${type}-load-more`)
          : null;
      activeEl?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, activeItemId, isLoadMoreActive, type]);

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
              const worktrees = useWorktreeDataStore.getState().worktrees;
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
              } else if (
                activeItem.state === "OPEN" &&
                !(type === "pr" && "isFork" in activeItem && activeItem.isFork)
              ) {
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

  const isTokenRelatedError = (msg: string | null | undefined): boolean => {
    if (!msg) return false;
    return (
      msg.includes("GitHub token not configured") ||
      msg.includes("Invalid GitHub token") ||
      msg.includes("Token lacks required permissions") ||
      msg.includes("SSO authorization required")
    );
  };

  const isTokenError = isTokenRelatedError(error);

  const handleOpenGitHubSettings = () => {
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "github", sectionId: "github-token" },
      { source: "user" }
    );
    onClose?.();
  };

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

  return (
    <div className="relative w-[450px] flex flex-col max-h-[500px]">
      <div className="p-3 border-b border-[var(--border-divider)] space-y-3 shrink-0">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "flex items-center gap-1.5 px-2 py-1.5 rounded-[var(--radius-md)] flex-1 min-w-0",
              "bg-overlay-soft border border-[var(--border-overlay)]",
              "focus-within:border-canopy-accent focus-within:ring-1 focus-within:ring-canopy-accent/20"
            )}
          >
            <Search
              className="w-3.5 h-3.5 shrink-0 text-canopy-text/40 pointer-events-none"
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
              className="flex-1 min-w-0 text-sm bg-transparent text-canopy-text placeholder:text-muted-foreground focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={handleClearSearch}
                aria-label="Clear search"
                className="flex items-center justify-center w-5 h-5 rounded shrink-0 text-canopy-text/40 hover:text-canopy-text"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <Popover open={sortPopoverOpen} onOpenChange={setSortPopoverOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`Sort ${type === "issue" ? "issues" : "pull requests"}`}
                aria-haspopup="dialog"
                className={cn(
                  "relative flex items-center justify-center w-7 h-7 rounded shrink-0",
                  "text-canopy-text/60 hover:text-canopy-text hover:bg-tint/[0.06]",
                  "transition-colors",
                  sortOrder !== "updated" && "text-canopy-accent"
                )}
              >
                <Filter className="w-3.5 h-3.5" />
                {sortOrder !== "updated" && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-canopy-accent" />
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
              <div className="text-[10px] font-medium text-canopy-text/50 uppercase tracking-wide mb-2">
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
                        ? "bg-canopy-accent/10 text-canopy-accent"
                        : "text-canopy-text/70 hover:bg-overlay-medium"
                    )}
                  >
                    <div
                      className={cn(
                        "w-3 h-3 rounded-full border",
                        sortOrder === option.value
                          ? "border-canopy-accent bg-canopy-accent"
                          : "border-canopy-border"
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
                  className="text-xs text-canopy-text/50 hover:text-canopy-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent transition-colors px-1 py-0.5 rounded"
                >
                  {allSelected ? "Deselect all" : `Select all (${data.length})`}
                </button>
                {unassigned.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      selection.selectAll(unassigned.map((item) => item.number));
                    }}
                    className="text-xs text-canopy-text/50 hover:text-canopy-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent transition-colors px-1 py-0.5 rounded"
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
                    ? "bg-canopy-accent/10 text-canopy-accent"
                    : "text-muted-foreground hover:text-canopy-text"
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

      <div className="overflow-y-auto flex-1 min-h-0">
        {loading && !data.length ? (
          <GitHubResourceRowsSkeleton
            count={initialCount && initialCount > 0 ? initialCount : MAX_SKELETON_ITEMS}
          />
        ) : data.length > 0 ? (
          <>
            {error && (
              <div className="px-3 py-2 border-b border-[var(--border-divider)] flex items-center gap-2 text-muted-foreground bg-overlay-soft">
                <WifiOff className="h-3.5 w-3.5 shrink-0" />
                <span className="text-xs truncate">{sanitizeIpcError(error)}</span>
                {isTokenError ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleOpenGitHubSettings}
                    className="ml-auto h-6 text-xs text-muted-foreground hover:text-canopy-text shrink-0"
                  >
                    <Settings className="h-3 w-3" />
                    Settings
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleRetry}
                    className="ml-auto h-6 text-xs text-muted-foreground hover:text-canopy-text shrink-0"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Retry
                  </Button>
                )}
              </div>
            )}
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-multiselectable={true}
              className="divide-y divide-[var(--border-divider)]"
            >
              {data.map((item, index) => (
                <GitHubListItem
                  key={item.number}
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
                      selection.toggleRange(index, (i) => data[i].number);
                    } else {
                      selection.toggle(item.number, index);
                    }
                  }}
                />
              ))}
            </div>

            {hasMore && (
              <div className="p-3 space-y-2">
                {loadMoreError && (
                  <div className="p-2 rounded-[var(--radius-md)] bg-overlay-soft border border-[var(--border-divider)]">
                    <p className="text-xs text-muted-foreground">
                      {sanitizeIpcError(loadMoreError)}
                    </p>
                    {isTokenRelatedError(loadMoreError) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleOpenGitHubSettings}
                        className="mt-1 text-muted-foreground hover:text-canopy-text h-6 text-xs"
                      >
                        <Settings className="h-3 w-3" />
                        Open GitHub Settings
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleLoadMore}
                        className="mt-1 text-muted-foreground hover:text-canopy-text h-6 text-xs"
                      >
                        Retry
                      </Button>
                    )}
                  </div>
                )}
                <Button
                  id={`github-${type}-load-more`}
                  variant="ghost"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className={cn(
                    "w-full text-muted-foreground hover:text-canopy-text",
                    isLoadMoreActive && "ring-1 ring-canopy-accent text-canopy-text"
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
            )}
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
                className="mt-2 text-muted-foreground hover:text-canopy-text"
              >
                <Settings className="h-3.5 w-3.5" />
                Open GitHub Settings
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRetry}
                className="mt-2 text-muted-foreground hover:text-canopy-text"
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
          className="text-muted-foreground hover:text-canopy-text gap-1.5"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          View on GitHub
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCreateNew}
          className="text-muted-foreground hover:text-canopy-text gap-1.5"
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
