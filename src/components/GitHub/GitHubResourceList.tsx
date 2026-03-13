import { useState, useEffect, useMemo, useCallback, useRef, type KeyboardEvent } from "react";
import { useDebounce } from "@/hooks/useDebounce";
import { Search, ExternalLink, RefreshCw, WifiOff, Plus, Settings, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { githubClient } from "@/clients/githubClient";
import { actionService } from "@/services/ActionService";
import { GitHubListItem } from "./GitHubListItem";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import {
  useGitHubFilterStore,
  type IssueStateFilter,
  type PRStateFilter,
} from "@/store/githubFilterStore";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";
import { parseExactNumber } from "@/lib/parseExactNumber";

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

const ITEM_HEIGHT_PX = 64;
const MAX_SKELETON_ITEMS = 6;

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
  const [data, setData] = useState<(GitHubIssue | GitHubPR)[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [exactNumberNotFound, setExactNumberNotFound] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const debouncedSearch = useDebounce(searchQuery, 300);

  const exactNumber = useMemo(() => parseExactNumber(searchQuery), [searchQuery]);
  const exactNumberAbortRef = useRef<AbortController | null>(null);

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
      abortSignal?: AbortSignal
    ) => {
      if (!projectPath) return;

      if (append) {
        loadMoreAbortRef.current?.abort();
        const abortController = new AbortController();
        loadMoreAbortRef.current = abortController;
        abortSignal = abortController.signal;

        setLoadingMore(true);
        setLoadMoreError(null);
      } else {
        setLoading(true);
        setError(null);
        setLoadMoreError(null);
      }

      try {
        const options = {
          cwd: projectPath,
          search: debouncedSearch || undefined,
          state: filterState as "open" | "closed" | "merged" | "all",
          cursor: currentCursor || undefined,
        };

        const result =
          type === "issue"
            ? await githubClient.listIssues(
                options as Parameters<typeof githubClient.listIssues>[0]
              )
            : await githubClient.listPullRequests(
                options as Parameters<typeof githubClient.listPullRequests>[0]
              );

        // Check if aborted before updating state
        if (abortSignal?.aborted) return;

        if (append) {
          setData((prev) => [...prev, ...result.items]);
        } else {
          setData(result.items);
        }
        setCursor(result.pageInfo.endCursor);
        setHasMore(result.pageInfo.hasNextPage);
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
    [projectPath, debouncedSearch, filterState, type]
  );

  useEffect(() => {
    if (exactNumber !== null) {
      return;
    }

    const abortController = new AbortController();

    setCursor(null);
    setHasMore(false);
    setExactNumberNotFound(null);
    fetchData(null, false, abortController.signal);

    return () => abortController.abort();
  }, [debouncedSearch, filterState, projectPath, type, fetchData, exactNumber]);

  useEffect(() => {
    if (exactNumber === null) {
      return;
    }

    exactNumberAbortRef.current?.abort();
    loadMoreAbortRef.current?.abort();
    const abortController = new AbortController();
    exactNumberAbortRef.current = abortController;

    setLoading(true);
    setError(null);
    setExactNumberNotFound(null);
    setData([]);
    setCursor(null);
    setHasMore(false);

    const fetchExact = async () => {
      try {
        const result =
          type === "issue"
            ? await githubClient.getIssueByNumber(projectPath, exactNumber)
            : await githubClient.getPRByNumber(projectPath, exactNumber);

        if (abortController.signal.aborted) return;

        if (result) {
          const matchesFilter =
            filterState === "all" ||
            (type === "issue" && result.state.toLowerCase() === filterState) ||
            (type === "pr" && result.state.toLowerCase() === filterState);

          if (matchesFilter) {
            setData([result]);
            setExactNumberNotFound(null);
          } else {
            setData([]);
            setExactNumberNotFound(exactNumber);
          }
        } else {
          setData([]);
          setExactNumberNotFound(exactNumber);
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

    void fetchExact();

    return () => {
      abortController.abort();
    };
  }, [exactNumber, projectPath, type, filterState]);

  const handleLoadMore = useCallback(() => {
    if (!loadingMore && hasMore) {
      fetchData(cursor, true, undefined);
    }
  }, [loadingMore, hasMore, fetchData, cursor]);

  const handleOpenInGitHub = () => {
    if (type === "issue") {
      void actionService.dispatch("github.openIssues", { projectPath }, { source: "user" });
    } else {
      void actionService.dispatch("github.openPRs", { projectPath }, { source: "user" });
    }
    onClose?.();
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
      onClose?.();
    },
    [openCreateDialog, openCreateDialogForPR, onClose]
  );

  const handleSwitchToWorktree = useCallback(
    (worktreeId: string) => {
      selectWorktree(worktreeId);
      onClose?.();
    },
    [selectWorktree, onClose]
  );

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    inputRef.current?.focus();
  }, [setSearchQuery]);

  const handleRetry = () => {
    setCursor(null);
    fetchData(null, false, undefined);
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
          e.stopPropagation();
          onClose?.();
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
      onClose,
      type,
    ]
  );

  const renderSkeleton = (count: number) => {
    const safeCount = Number.isFinite(count) ? Math.floor(count) : MAX_SKELETON_ITEMS;
    const renderCount = Math.min(Math.max(1, safeCount), MAX_SKELETON_ITEMS);

    return (
      <div role="status" aria-live="polite" aria-busy="true" aria-label="Loading GitHub results">
        <span className="sr-only">Loading GitHub results</span>
        <div aria-hidden="true" className="divide-y divide-[var(--border-divider)]">
          {Array.from({ length: renderCount }).map((_, i) => (
            <div
              key={i}
              className="p-3 animate-pulse-delayed box-border"
              style={{ height: `${ITEM_HEIGHT_PX}px` }}
            >
              <div className="flex items-start gap-3 h-full">
                <div className="w-4 h-4 rounded-full bg-muted mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="h-5 bg-muted rounded w-3/4" />
                    <div className="h-4 bg-muted rounded w-10 shrink-0" />
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <div className="h-4 bg-muted rounded w-10" />
                    <div className="h-4 bg-muted rounded w-12" />
                    <div className="h-4 bg-muted rounded w-14" />
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="flex -space-x-1.5">
                    <div className="w-5 h-5 rounded-full bg-muted border-2 border-canopy-sidebar" />
                    <div className="w-5 h-5 rounded-full bg-muted border-2 border-canopy-sidebar" />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const isTokenError = error?.includes("GitHub token not configured") ?? false;

  const handleOpenGitHubSettings = () => {
    void actionService.dispatch("app.settings.openTab", { tab: "github" }, { source: "user" });
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
    <div className="w-[450px] flex flex-col max-h-[500px]">
      <div className="p-3 border-b border-[var(--border-divider)] space-y-3 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
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
            className={cn(
              "w-full h-8 pl-8 pr-8 rounded-[var(--radius-md)] text-sm",
              "bg-overlay-soft border border-[var(--border-overlay)]",
              "text-canopy-text placeholder:text-muted-foreground",
              "focus:outline-none focus:ring-1 focus:ring-canopy-accent focus:border-canopy-accent",
              "transition-colors"
            )}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={handleClearSearch}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-4 h-4 rounded text-muted-foreground hover:text-canopy-text"
              aria-label="Clear search"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

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
      </div>

      <div className="overflow-y-auto flex-1 min-h-0">
        {loading && !data.length ? (
          renderSkeleton(initialCount && initialCount > 0 ? initialCount : MAX_SKELETON_ITEMS)
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
                    {loadMoreError.includes("GitHub token not configured") ? (
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
    </div>
  );
}
