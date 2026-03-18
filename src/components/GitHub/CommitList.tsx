import { useState, useEffect, useCallback, useRef, type KeyboardEvent } from "react";
import { useDebounce } from "@/hooks/useDebounce";
import { Search, RefreshCw, AlertCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CommitListItem } from "./CommitListItem";
import type { GitCommit, GitCommitListResponse } from "@shared/types/github";
import { actionService } from "@/services/ActionService";
import { CommitListSkeleton } from "./GitHubDropdownSkeletons";

interface CommitListProps {
  projectPath: string;
  onClose?: () => void;
  initialCount?: number;
}

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
  const [cursorIndex, setCursorIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const debouncedSearch = useDebounce(searchQuery, 300);

  const maxCursor = data.length - 1 + (hasMore ? 1 : 0);
  const activeCommit = cursorIndex >= 0 && cursorIndex < data.length ? data[cursorIndex] : null;
  const activeCommitId = activeCommit ? `commit-option-${activeCommit.hash}` : undefined;
  const isLoadMoreActive = hasMore && cursorIndex === data.length;
  const listId = "commit-list";

  useEffect(() => {
    setCursorIndex(-1);
  }, [data]);

  useEffect(() => {
    if (cursorIndex >= 0) {
      const activeEl = activeCommitId
        ? document.getElementById(activeCommitId)
        : isLoadMoreActive
          ? document.getElementById("commit-load-more")
          : null;
      activeEl?.scrollIntoView({ block: "nearest" });
    }
  }, [cursorIndex, activeCommitId, isLoadMoreActive]);

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

  const handleLoadMore = useCallback(() => {
    if (!loadingMore && hasMore) {
      fetchData(skip, true, undefined);
    }
  }, [loadingMore, hasMore, fetchData, skip]);

  const handleRetry = () => {
    setSkip(0);
    fetchData(0, false, undefined);
  };

  const handleViewOnGitHub = () => {
    actionService.dispatch("github.openCommits", { projectPath }, { source: "user" });
    onClose?.();
  };

  const handleInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setCursorIndex((prev) => Math.min(prev + 1, maxCursor));
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setCursorIndex((prev) => Math.max(prev - 1, -1));
          break;
        case "Enter": {
          e.preventDefault();
          e.stopPropagation();
          if (isLoadMoreActive) {
            handleLoadMore();
          } else if (activeCommit) {
            void navigator.clipboard.writeText(activeCommit.hash);
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
    [maxCursor, isLoadMoreActive, activeCommit, handleLoadMore, onClose]
  );

  const renderError = () => (
    <div className="px-3 py-2 border-b border-[var(--border-divider)] flex items-center gap-2 text-muted-foreground bg-overlay-soft">
      <AlertCircle className="h-3.5 w-3.5 shrink-0 text-status-error" />
      <span className="text-xs truncate">{error}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleRetry}
        className="ml-auto h-6 text-xs text-muted-foreground hover:text-canopy-text shrink-0"
      >
        <RefreshCw className="h-3 w-3" />
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
        <div
          className={cn(
            "flex items-center gap-1.5 px-2 py-1.5 rounded-[var(--radius-md)]",
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
            placeholder="Search commits..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
            autoFocus
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={true}
            aria-haspopup="listbox"
            aria-controls={listId}
            aria-activedescendant={activeCommitId}
            aria-label="Search commits"
            className="flex-1 min-w-0 text-sm bg-transparent text-canopy-text placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
      </div>

      <div className="overflow-y-auto flex-1 min-h-0">
        {loading && !data.length ? (
          initialCount === 0 ? (
            renderEmpty()
          ) : (
            <CommitListSkeleton count={initialCount} />
          )
        ) : data.length > 0 ? (
          <>
            {error && renderError()}
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              className="divide-y divide-[var(--border-divider)]"
            >
              {data.map((commit, index) => (
                <CommitListItem
                  key={commit.hash}
                  commit={commit}
                  optionId={`commit-option-${commit.hash}`}
                  isActive={cursorIndex === index}
                />
              ))}
            </div>

            {hasMore && (
              <div className="p-3 space-y-2">
                {loadMoreError && (
                  <div className="p-2 rounded-[var(--radius-md)] bg-status-error/10 border border-status-error/20">
                    <p className="text-xs text-status-error">{loadMoreError}</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleLoadMore}
                      className="mt-1 text-status-error hover:text-status-error/70 h-6 text-xs"
                    >
                      Retry
                    </Button>
                  </div>
                )}
                <Button
                  id="commit-load-more"
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
            <AlertCircle className="h-5 w-5 mx-auto mb-2 opacity-50" />
            <p className="text-sm">{error}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRetry}
              className="mt-2 text-muted-foreground hover:text-canopy-text"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        ) : (
          renderEmpty()
        )}
      </div>

      <div className="p-3 border-t border-[var(--border-divider)] flex items-center justify-between shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleViewOnGitHub}
          className="text-muted-foreground hover:text-canopy-text"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          View on GitHub
        </Button>
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
