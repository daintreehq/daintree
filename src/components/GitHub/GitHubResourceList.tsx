import { useState, useEffect, useMemo, useCallback } from "react";
import { Search, ExternalLink, RefreshCw, AlertCircle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { githubClient } from "@/clients/githubClient";
import { GitHubListItem } from "./GitHubListItem";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";

interface GitHubResourceListProps {
  type: "issue" | "pr";
  projectPath: string;
  onClose?: () => void;
  initialCount?: number | null;
}

type IssueStateFilter = "open" | "closed" | "all";
type PRStateFilter = "open" | "closed" | "merged" | "all";
type StateFilter = IssueStateFilter | PRStateFilter;

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

const ITEM_HEIGHT_PX = 64;
const MAX_SKELETON_ITEMS = 6;

export function GitHubResourceList({
  type,
  projectPath,
  onClose,
  initialCount,
}: GitHubResourceListProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterState, setFilterState] = useState<StateFilter>("open");
  const [data, setData] = useState<(GitHubIssue | GitHubPR)[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const debouncedSearch = useDebounce(searchQuery, 300);

  const stateTabs = useMemo(() => {
    if (type === "pr") {
      return [
        { id: "open", label: "Open" },
        { id: "closed", label: "Closed" },
        { id: "merged", label: "Merged" },
      ];
    }
    return [
      { id: "open", label: "Open" },
      { id: "closed", label: "Closed" },
    ];
  }, [type]);

  // Note: currentCursor is passed as a parameter (not read from state) to avoid
  // dependency cycle where updating cursor would recreate this callback
  const fetchData = useCallback(
    async (
      currentCursor: string | null | undefined,
      append: boolean = false,
      abortSignal?: AbortSignal
    ) => {
      if (!projectPath) return;

      if (append) {
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
    const abortController = new AbortController();

    setCursor(null);
    setHasMore(false);
    fetchData(null, false, abortController.signal);

    return () => abortController.abort();
  }, [debouncedSearch, filterState, projectPath, type, fetchData]);

  const handleLoadMore = () => {
    if (!loadingMore && hasMore) {
      fetchData(cursor, true, undefined);
    }
  };

  const handleOpenInGitHub = () => {
    if (type === "issue") {
      githubClient.openIssues(projectPath);
    } else {
      githubClient.openPRs(projectPath);
    }
    onClose?.();
  };

  const handleCreateNew = () => {
    // Use openIssues/openPRs with /new path would require a new IPC
    // For now, just open the GitHub page
    handleOpenInGitHub();
  };

  const openCreateDialog = useWorktreeSelectionStore((s) => s.openCreateDialog);

  const handleCreateWorktree = useCallback(
    (issue: GitHubIssue) => {
      openCreateDialog(issue);
      onClose?.();
    },
    [openCreateDialog, onClose]
  );

  const handleRetry = () => {
    setCursor(null);
    fetchData(null, false, undefined);
  };

  const renderSkeleton = (count: number) => {
    const safeCount = Number.isFinite(count) ? Math.floor(count) : MAX_SKELETON_ITEMS;
    const renderCount = Math.min(Math.max(1, safeCount), MAX_SKELETON_ITEMS);

    return (
      <div role="status" aria-live="polite" aria-busy="true" aria-label="Loading GitHub results">
        <span className="sr-only">Loading GitHub results</span>
        <div aria-hidden="true" className="divide-y divide-canopy-border">
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

  const renderError = () => (
    <div className="p-4 m-3 rounded-[var(--radius-md)] bg-[color-mix(in_oklab,var(--color-status-error)_10%,transparent)] border border-[color-mix(in_oklab,var(--color-status-error)_20%,transparent)]">
      <div className="flex items-center gap-2 text-[var(--color-status-error)]">
        <AlertCircle className="h-4 w-4" />
        <span className="text-sm font-medium">Error</span>
      </div>
      <p className="text-sm text-[var(--color-status-error)] mt-1">{error}</p>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleRetry}
        className="mt-2 text-[var(--color-status-error)] hover:brightness-110"
      >
        <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
        Retry
      </Button>
    </div>
  );

  const renderEmpty = () => (
    <div className="p-8 text-center text-muted-foreground">
      <p className="text-sm">
        No {type === "issue" ? "issues" : "pull requests"} found
        {debouncedSearch && ` for "${debouncedSearch}"`}
      </p>
    </div>
  );

  return (
    <div className="w-[450px] flex flex-col max-h-[500px]">
      <div className="p-3 border-b border-canopy-border space-y-3 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder={`Search ${type === "issue" ? "issues" : "pull requests"}...`}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label={`Search ${type === "issue" ? "issues" : "pull requests"}`}
            className={cn(
              "w-full h-8 pl-8 pr-3 rounded-[var(--radius-md)] text-sm",
              "bg-canopy-bg border border-canopy-border",
              "text-canopy-text placeholder:text-muted-foreground",
              "focus:outline-none focus:ring-1 focus:ring-canopy-accent focus:border-canopy-accent",
              "transition-colors"
            )}
          />
        </div>

        <div
          className="flex p-0.5 bg-black/20 rounded-[var(--radius-md)]"
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
          initialCount === 0 ? (
            renderEmpty()
          ) : (
            renderSkeleton(initialCount ?? MAX_SKELETON_ITEMS)
          )
        ) : error ? (
          renderError()
        ) : data.length === 0 ? (
          renderEmpty()
        ) : (
          <>
            <div className="divide-y divide-canopy-border">
              {data.map((item) => (
                <GitHubListItem
                  key={item.number}
                  item={item}
                  type={type}
                  onCreateWorktree={type === "issue" ? handleCreateWorktree : undefined}
                />
              ))}
            </div>

            {hasMore && (
              <div className="p-3 space-y-2">
                {loadMoreError && (
                  <div className="p-2 rounded-[var(--radius-md)] bg-red-500/10 border border-red-500/20">
                    <p className="text-xs text-red-400">{loadMoreError}</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleLoadMore}
                      className="mt-1 text-red-400 hover:text-red-300 h-6 text-xs"
                    >
                      Retry
                    </Button>
                  </div>
                )}
                <Button
                  variant="ghost"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="w-full text-muted-foreground hover:text-canopy-text"
                >
                  {loadingMore ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    "Load More"
                  )}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="p-3 border-t border-canopy-border flex items-center justify-between shrink-0">
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
