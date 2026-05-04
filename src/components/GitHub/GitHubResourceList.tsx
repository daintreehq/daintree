import { useState, useEffect, useMemo, useCallback, useRef, type KeyboardEvent } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
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
import { isTokenRelatedError } from "@/lib/githubErrors";
import { Button } from "@/components/ui/button";
import { ContentFadeIn } from "@/components/ui/ContentFadeIn";
import { EmptyState } from "@/components/ui/EmptyState";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
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
import { MULTI_FETCH_CAP } from "@/lib/parseNumberQuery";
import {
  GitHubResourceRowsSkeleton,
  MAX_SKELETON_ITEMS,
  RESOURCE_ITEM_HEIGHT_PX,
} from "./GitHubDropdownSkeletons";
import { LiveTimeAgo } from "@/components/Worktree/LiveTimeAgo";
import { useGitHubResourceListSWR } from "./useGitHubResourceListSWR";

type StateFilter = IssueStateFilter | PRStateFilter;

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
  /**
   * Called after a successful background revalidation lands fresh first-page
   * data. The toolbar count badge wires this to a stats refresh so the
   * dropdown's just-updated count converges into the badge without waiting
   * for the next 30s stats poll.
   */
  onFreshFetch?: () => void;
}

export function GitHubResourceList({
  type,
  projectPath,
  onClose,
  initialCount,
  onFreshFetch,
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

  const {
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
  } = useGitHubResourceListSWR({
    type,
    projectPath,
    searchQuery,
    filterState,
    sortOrder,
    githubConfig,
    onFreshFetch,
  });

  const [activeIndex, setActiveIndex] = useState(-1);
  const [sortPopoverOpen, setSortPopoverOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

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

  const listId = `github-${type}-list`;
  const maxIndex = data.length - 1 + (hasMore ? 1 : 0);
  const activeItem = activeIndex >= 0 && activeIndex < data.length ? data[activeIndex] : null;
  const activeItemId = activeItem ? `github-${type}-option-${activeItem.number}` : undefined;
  const isLoadMoreActive = hasMore && activeIndex === data.length;

  useEffect(() => {
    setActiveIndex(-1);
  }, [data]);

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
    const trimmedSearch = debouncedSearch.trim();
    const isFilterActive =
      exactNumberNotFound !== null ||
      numberQuery !== null ||
      trimmedSearch.length > 0 ||
      filterState !== "open";
    const resourceLabel = type === "issue" ? "issues" : "pull requests";

    if (isFilterActive) {
      const title =
        exactNumberNotFound !== null
          ? `${type === "issue" ? "Issue" : "PR"} #${exactNumberNotFound} not found`
          : trimmedSearch.length > 0
            ? `No ${resourceLabel} match "${trimmedSearch}"`
            : `No ${resourceLabel} in this view`;

      return (
        <EmptyState
          variant="filtered-empty"
          title={title}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSearchQuery("");
                setFilterState("open" as StateFilter);
              }}
            >
              Clear filters
            </Button>
          }
          className="flex-1 justify-center"
        />
      );
    }

    return (
      <EmptyState
        variant="zero-data"
        title={`No ${resourceLabel} found`}
        className="flex-1 justify-center"
      />
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
          <ContentFadeIn className="flex-1 min-h-0 flex flex-col">
            {error && (
              <div className="px-3 py-2 border-b border-[var(--border-divider)] flex items-center gap-2 text-muted-foreground bg-overlay-soft shrink-0">
                <WifiOff className="h-3.5 w-3.5 shrink-0" />
                <span className="text-xs truncate">{sanitizeIpcError(error)}</span>
                {lastUpdatedAt != null && !debouncedSearch && (
                  <span className="text-xs text-muted-foreground/70 shrink-0 whitespace-nowrap">
                    · Updated <LiveTimeAgo timestamp={lastUpdatedAt} />
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
          </ContentFadeIn>
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
