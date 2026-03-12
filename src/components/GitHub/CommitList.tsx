import { useState, useEffect, useCallback, useMemo, useRef, type KeyboardEvent } from "react";
import { useDebounce } from "@/hooks/useDebounce";
import { Search, RefreshCw, AlertCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CommitListItem } from "./CommitListItem";
import type { GitCommit, GitCommitListResponse } from "@shared/types/github";
import { actionService } from "@/services/ActionService";
import { buildGroupedRows } from "./commitListUtils";

interface CommitListProps {
  projectPath: string;
  onClose?: () => void;
  initialCount?: number;
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
  const [cursorIndex, setCursorIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const debouncedSearch = useDebounce(searchQuery, 300);

  const groupedRows = useMemo(() => buildGroupedRows(data), [data]);

  const interactiveIndices = useMemo(
    () =>
      groupedRows.reduce<number[]>((acc, row, i) => {
        if (row.kind === "commit") acc.push(i);
        return acc;
      }, []),
    [groupedRows]
  );

  const maxCursor = interactiveIndices.length - 1 + (hasMore ? 1 : 0);
  const activeRawIndex =
    cursorIndex >= 0 && cursorIndex < interactiveIndices.length
      ? interactiveIndices[cursorIndex]
      : -1;
  const activeCommitRow = activeRawIndex >= 0 ? groupedRows[activeRawIndex] : null;
  const activeCommit = activeCommitRow?.kind === "commit" ? activeCommitRow.commit : null;
  const activeCommitId = activeCommit ? `commit-option-${activeCommit.hash}` : undefined;
  const isLoadMoreActive = hasMore && cursorIndex === interactiveIndices.length;
  const listId = "commit-list";

  useEffect(() => {
    setCursorIndex(-1);
  }, [groupedRows]);

  useEffect(() => {
    if (cursorIndex >= 0) {
      const activeEl = activeCommitId
        ? document.getElementById(activeCommitId)
        : isLoadMoreActive
          ? listRef.current?.nextElementSibling?.querySelector("button")
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
      <div className="flex items-center gap-2 text-status-error">
        <AlertCircle className="h-4 w-4" />
        <span className="text-sm font-medium">Error</span>
      </div>
      <p className="text-sm text-status-error mt-1">{error}</p>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleRetry}
        className="mt-2 text-status-error hover:brightness-110"
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
            className={cn(
              "w-full h-8 pl-8 pr-3 rounded-[var(--radius-md)] text-sm",
              "bg-overlay-soft border border-[var(--border-overlay)]",
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
            <div ref={listRef} id={listId} role="listbox">
              {groupedRows.map((row, rawIndex) =>
                row.kind === "separator" ? (
                  <div
                    key={`sep-${row.label}`}
                    role="none"
                    className="px-3 py-1.5 flex items-center gap-2"
                  >
                    <div className="h-px flex-1 bg-[var(--border-divider)]" />
                    <span className="text-xs text-muted-foreground shrink-0">{row.label}</span>
                    <div className="h-px flex-1 bg-[var(--border-divider)]" />
                  </div>
                ) : (
                  <CommitListItem
                    key={row.commit.hash}
                    commit={row.commit}
                    optionId={`commit-option-${row.commit.hash}`}
                    isActive={activeRawIndex === rawIndex}
                  />
                )
              )}
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
