import { useState, useEffect, useCallback } from "react";
import { Search, RefreshCw, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CommitListItem } from "./CommitListItem";
import type { GitCommit, GitCommitListResponse } from "@shared/types/github";
import { actionService } from "@/services/ActionService";

interface CommitListProps {
  projectPath: string;
  onClose?: () => void;
  initialCount?: number;
}

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
const PAGE_SIZE = 30;

export function CommitList({ projectPath, onClose, initialCount }: CommitListProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [data, setData] = useState<GitCommit[]>([]);
  const [skip, setSkip] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const debouncedSearch = useDebounce(searchQuery, 300);

  const fetchData = useCallback(
    async (currentSkip: number, append: boolean = false, abortSignal?: AbortSignal) => {
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
        const actionResult = await actionService.dispatch(
          "git.listCommits",
          {
            cwd: projectPath,
            search: debouncedSearch || undefined,
            skip: currentSkip,
            limit: PAGE_SIZE,
          },
          { source: "user" }
        );
        if (!actionResult.ok) {
          throw new Error(actionResult.error.message);
        }
        const result = actionResult.result as GitCommitListResponse;

        if (abortSignal?.aborted) return;

        if (append) {
          setData((prev) => [...prev, ...result.items]);
        } else {
          setData(result.items);
        }
        setSkip(currentSkip + result.items.length);
        setHasMore(result.hasMore);
      } catch (err) {
        if (abortSignal?.aborted) return;
        const message = err instanceof Error ? err.message : "Failed to fetch commits";
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
    [projectPath, debouncedSearch]
  );

  useEffect(() => {
    const abortController = new AbortController();

    setSkip(0);
    setHasMore(false);
    fetchData(0, false, abortController.signal);

    return () => abortController.abort();
  }, [debouncedSearch, projectPath, fetchData]);

  const handleLoadMore = () => {
    if (!loadingMore && hasMore) {
      fetchData(skip, true, undefined);
    }
  };

  const handleRetry = () => {
    setSkip(0);
    fetchData(0, false, undefined);
  };

  const renderSkeleton = (count: number) => {
    const safeCount = Number.isFinite(count) ? Math.floor(count) : MAX_SKELETON_ITEMS;
    const renderCount = Math.min(Math.max(1, safeCount), MAX_SKELETON_ITEMS);

    return (
      <div role="status" aria-live="polite" aria-busy="true" aria-label="Loading commits">
        <span className="sr-only">Loading commits</span>
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
                  <div className="h-5 bg-muted rounded w-3/4" />
                  <div className="mt-1 flex items-center gap-1.5">
                    <div className="h-4 bg-muted rounded w-16" />
                    <div className="h-4 bg-muted rounded w-20" />
                    <div className="h-4 bg-muted rounded w-12" />
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
        <RefreshCw />
        Retry
      </Button>
    </div>
  );

  const renderEmpty = () => (
    <div className="p-8 text-center text-muted-foreground">
      <p className="text-sm">
        No commits found
        {debouncedSearch && ` for "${debouncedSearch}"`}
      </p>
    </div>
  );

  return (
    <div className="w-[450px] flex flex-col max-h-[500px]">
      <div className="p-3 border-b border-[var(--border-divider)] shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search commits..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search commits"
            className={cn(
              "w-full h-8 pl-8 pr-3 rounded-[var(--radius-md)] text-sm",
              "bg-white/[0.03] border border-[var(--border-overlay)]",
              "text-canopy-text placeholder:text-muted-foreground",
              "focus:outline-none focus:ring-1 focus:ring-canopy-accent focus:border-canopy-accent",
              "transition-colors"
            )}
          />
        </div>
      </div>

      <div className="overflow-y-auto flex-1 min-h-0">
        {loading && !data.length ? (
          initialCount === 0 ? (
            renderEmpty()
          ) : (
            renderSkeleton(Math.min(initialCount ?? MAX_SKELETON_ITEMS, MAX_SKELETON_ITEMS))
          )
        ) : error ? (
          renderError()
        ) : data.length === 0 ? (
          renderEmpty()
        ) : (
          <>
            <div className="divide-y divide-[var(--border-divider)]">
              {data.map((commit) => (
                <CommitListItem key={commit.hash} commit={commit} />
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
        )}
      </div>

      <div className="p-3 border-t border-[var(--border-divider)] flex items-center justify-end shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="text-muted-foreground hover:text-canopy-text"
        >
          Close
        </Button>
      </div>
    </div>
  );
}
