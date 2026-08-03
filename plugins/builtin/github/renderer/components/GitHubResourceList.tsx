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
  Clock,
} from "lucide-react";
import { GitHubIcon } from "@/components/icons/brands";
import { isTokenRelatedError, isTransientNetworkError } from "@/lib/forgeErrors";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { safeStringify } from "@/lib/safeStringify";
import { GitHubListItem } from "./GitHubListItem";
import { BulkActionBar } from "./BulkActionBar";
import { useIssueSelection } from "@/hooks/useIssueSelection";
import { useIssueSelectionStore } from "@/store/issueSelectionStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import {
  useGitHubFilterStore,
  type IssueStateFilter,
  type PRStateFilter,
} from "../stores/githubFilterStore";
import { useGitHubConfigStore } from "../stores/githubConfigStore";
import type { Issue, PR } from "@shared/types/forge";
import type { GitHubSortOrder } from "../../shared/types.js";
import { MULTI_FETCH_CAP } from "@/lib/parseNumberQuery";
import {
  GitHubResourceRowsSkeleton,
  MAX_SKELETON_ITEMS,
  RESOURCE_ITEM_HEIGHT_PX,
} from "./GitHubDropdownSkeletons";
import { LiveTimeAgo } from "@/components/Worktree/LiveTimeAgo";
import { LiveRateLimitCountdown } from "@/components/Layout/RateLimitDetails";
import { useGitHubResourceListSWR } from "../hooks/useGitHubResourceListSWR";

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
  /**
   * Called whenever fresh first-page data lands (cold-mount and revalidation)
   * with the number of loaded items and whether more pages exist. The toolbar
   * count badge uses this to display what the dropdown actually lists (e.g.
   * `20+` when paginated) instead of the stats query's full `totalCount`,
   * which can be higher than the loaded page (issue #9693).
   */
  onCountUpdate?: (count: number, hasMore: boolean) => void;
}

export function GitHubResourceList({
  type,
  projectPath,
  onClose,
  initialCount,
  onFreshFetch,
  onCountUpdate,
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
    isRateLimited,
    rateLimitResetAt,
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
    onCountUpdate,
  });

  const [activeIndex, setActiveIndex] = useState(-1);
  const [sortPopoverOpen, setSortPopoverOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Doherty Threshold gate for the refresh spinner. Sub-400ms background
  // revalidations stay invisible (250ms for explicit clicks); once visible the
  // spinner dwells ≥500ms so it never flashes on fast networks.
  const [showSpinner, setShowSpinner] = useState(false);
  const showSpinnerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spinnerDwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spinnerVisibleSinceRef = useRef<number | null>(null);
  const isManualRefreshRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (showSpinnerTimerRef.current) clearTimeout(showSpinnerTimerRef.current);
      if (spinnerDwellTimerRef.current) clearTimeout(spinnerDwellTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const isActive = loading || refreshing;
    if (isActive) {
      if (spinnerDwellTimerRef.current) {
        clearTimeout(spinnerDwellTimerRef.current);
        spinnerDwellTimerRef.current = null;
      }
      if (spinnerVisibleSinceRef.current !== null) return;
      if (showSpinnerTimerRef.current !== null) return;
      const delay = isManualRefreshRef.current ? 250 : 400;
      isManualRefreshRef.current = false;
      showSpinnerTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        spinnerVisibleSinceRef.current = Date.now();
        setShowSpinner(true);
        showSpinnerTimerRef.current = null;
      }, delay);
      return;
    }
    if (showSpinnerTimerRef.current) {
      clearTimeout(showSpinnerTimerRef.current);
      showSpinnerTimerRef.current = null;
    }
    if (spinnerVisibleSinceRef.current !== null) {
      const elapsed = Date.now() - spinnerVisibleSinceRef.current;
      const remaining = Math.max(0, 500 - elapsed);
      if (remaining === 0) {
        setShowSpinner(false);
        spinnerVisibleSinceRef.current = null;
      } else {
        spinnerDwellTimerRef.current = setTimeout(() => {
          if (!mountedRef.current) return;
          setShowSpinner(false);
          spinnerVisibleSinceRef.current = null;
          spinnerDwellTimerRef.current = null;
        }, remaining);
      }
    }
  }, [loading, refreshing]);

  const handleManualRefreshClick = useCallback(() => {
    isManualRefreshRef.current = true;
    handleManualRefresh();
  }, [handleManualRefresh]);

  const selection = useIssueSelection(type, projectPath);
  const [issueCache, setIssueCache] = useState<Map<number, Issue>>(() => new Map());
  const [prCache, setPrCache] = useState<Map<number, PR>>(() => new Map());

  // The toolbar reuses one keepMounted GitHubResourceList per type across
  // every project — switching projects only updates `projectPath`, it doesn't
  // remount. Bulk selection is keyed by `${type}:${projectPath}` in its own
  // store (so it survives the toolbar's lazy/direct remount), but on a real
  // project switch we still clear the outgoing project's selection: it would
  // otherwise outlive the issue/PR cache reset below and leave the bulk bar
  // showing a count with no backing objects to act on.
  const prevProjectPathRef = useRef(projectPath);
  useEffect(() => {
    const prevProjectPath = prevProjectPathRef.current;
    if (prevProjectPath === projectPath) return;
    prevProjectPathRef.current = projectPath;
    useIssueSelectionStore.getState().clear(`${type}:${prevProjectPath}`);
    setIssueCache(new Map());
    setPrCache(new Map());
  }, [projectPath, type]);

  // Accumulate item objects into the session cache whenever data changes
  useEffect(() => {
    const newIssues: Issue[] = [];
    const newPRs: PR[] = [];
    for (const item of data) {
      if ("isDraft" in item) {
        newPRs.push(item);
      } else {
        newIssues.push(item);
      }
    }
    if (newIssues.length > 0) {
      setIssueCache((prev) => {
        const next = new Map(prev);
        for (const issue of newIssues) next.set(issue.number, issue);
        return next;
      });
    }
    if (newPRs.length > 0) {
      setPrCache((prev) => {
        const next = new Map(prev);
        for (const pr of newPRs) next.set(pr.number, pr);
        return next;
      });
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
    onClose?.();
  }, [onClose]);

  const handleOpenInGitHub = () => {
    const query = searchQuery.trim() || undefined;
    const state = filterState as string;
    // dispatch() never throws — failures come back as { ok: false }, so they
    // must be surfaced here or the click silently does nothing.
    const actionId = type === "issue" ? ("forge.openIssues" as const) : ("forge.openPRs" as const);
    const open = () => {
      const dispatched = actionService.dispatch(
        actionId,
        { projectPath, query, state },
        { source: "user" }
      );
      void dispatched.then((result) => {
        if (!result.ok) {
          const message =
            "The page couldn't be opened in your browser. Check that this project has a GitHub remote and the GitHub plugin is enabled, then try again.";
          notify({
            type: "error",
            title: "Couldn't open GitHub",
            message,
            coalesce: {
              key: `forge-open-failed:${projectPath}:${actionId}`,
              buildMessage: () => message,
            },
            action: { label: "Try again", variant: "primary", onClick: open },
            actions: [
              {
                label: "Copy details",
                successLabel: "Copied",
                variant: "secondary",
                onClick: () => {
                  void navigator.clipboard
                    ?.writeText(safeStringify({ action: actionId, error: result.error }, 2))
                    .catch(() => {
                      // Clipboard writes can reject in unfocused contexts; the
                      // toast already carries the friendly summary.
                    });
                },
              },
            ],
          });
        }
      });
    };
    open();
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
    (item: Issue | PR) => {
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
              } else if (activeItem.state === "open") {
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
      { tab: "code-forge", subtab: "github", sectionId: "github-token" },
      { source: "user" }
    );
    handleClose();
  }, [handleClose]);

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
          ? `No ${type === "issue" ? "issue" : "PR"} #${exactNumberNotFound} in this view`
          : trimmedSearch.length > 0
            ? `No ${resourceLabel} match "${trimmedSearch}"`
            : `No ${resourceLabel} in this view`;

      return (
        <EmptyState
          variant="filtered-empty"
          scale="canvas"
          title={title}
          action={
            <Button
              variant="ghost"
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
        scale="canvas"
        title={`No ${resourceLabel} found`}
        className="flex-1 justify-center"
      />
    );
  };

  if (showNoTokenEmptyState) {
    return (
      <div className="relative w-[450px] flex flex-col h-[500px]">
        {/* Canvas scale: this is the canonical "connection-gated panel" example
            in CLAUDE.md — a 450×500 dropdown that warrants panel semantics so the
            token-explanation description and "Add GitHub token" CTA stay legal. */}
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<GitHubIcon />}
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
              "focus-within:border-daintree-accent/40 focus-within:ring-1 focus-within:ring-daintree-accent/20"
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
            onClick={handleManualRefreshClick}
            disabled={loading || refreshing}
            aria-label={
              showSpinner
                ? "Refreshing…"
                : `Refresh ${type === "issue" ? "issues" : "pull requests"}`
            }
            title={
              showSpinner
                ? "Refreshing…"
                : `Refresh ${type === "issue" ? "issues" : "pull requests"}`
            }
            className={cn(
              "flex items-center justify-center w-7 h-7 rounded shrink-0",
              "text-daintree-text/60 hover:text-daintree-text hover:bg-tint/[0.06]",
              "transition-colors disabled:cursor-default",
              showSpinner && "text-status-info"
            )}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", showSpinner && "animate-spin")} />
          </button>
          <Popover open={sortPopoverOpen} onOpenChange={setSortPopoverOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={
                  sortOrder === "created"
                    ? `Sort ${type === "issue" ? "issues" : "pull requests"}`
                    : `Sort ${type === "issue" ? "issues" : "pull requests"}, sorted by recently updated`
                }
                aria-haspopup="dialog"
                aria-expanded={sortPopoverOpen}
                className={cn(
                  "relative flex items-center justify-center w-7 h-7 rounded shrink-0",
                  "text-daintree-text/60 hover:text-daintree-text hover:bg-tint/[0.06]",
                  "transition-colors"
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
                {(() => {
                  const sortOptions = [
                    { value: "created", label: "Newest" },
                    { value: "updated", label: "Recently updated" },
                  ] as const;
                  return sortOptions.map((option, idx) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setSortOrder(option.value)}
                      role="radio"
                      aria-checked={sortOrder === option.value}
                      tabIndex={sortOrder === option.value ? 0 : -1}
                      onKeyDown={(e) => {
                        const isNext = e.key === "ArrowDown" || e.key === "ArrowRight";
                        const isPrev = e.key === "ArrowUp" || e.key === "ArrowLeft";
                        if (!isNext && !isPrev) return;
                        e.preventDefault();
                        e.stopPropagation();
                        const delta = isNext ? 1 : -1;
                        const nextIdx = (idx + delta + sortOptions.length) % sortOptions.length;
                        const nextValue = sortOptions[nextIdx]!.value;
                        setSortOrder(nextValue);
                        const group = e.currentTarget.parentElement;
                        requestAnimationFrame(() => {
                          const radios =
                            group?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
                          radios?.[nextIdx]?.focus();
                        });
                      }}
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
                  ));
                })()}
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
              type === "issue" ? data.filter((item) => (item as Issue).assignees.length === 0) : [];
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
          role="radiogroup"
          aria-label="Filter by state"
        >
          {stateTabs.map((tab, idx) => {
            const isActive = filterState === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilterState(tab.id as StateFilter)}
                role="radio"
                aria-checked={isActive}
                tabIndex={isActive ? 0 : -1}
                onKeyDown={(e) => {
                  const isNext = e.key === "ArrowRight" || e.key === "ArrowDown";
                  const isPrev = e.key === "ArrowLeft" || e.key === "ArrowUp";
                  if (!isNext && !isPrev) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const delta = isNext ? 1 : -1;
                  const nextIdx = (idx + delta + stateTabs.length) % stateTabs.length;
                  const nextTab = stateTabs[nextIdx]!;
                  setFilterState(nextTab.id as StateFilter);
                  const group = e.currentTarget.parentElement;
                  requestAnimationFrame(() => {
                    const radios = group?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
                    radios?.[nextIdx]?.focus();
                  });
                }}
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

        {numberQuery !== null &&
          !loading &&
          exactNumberNotFound === null &&
          (() => {
            const resourceLabel = type === "issue" ? "issue" : "PR";
            let label: string;
            if (numberQuery.kind === "single") {
              label = `Showing ${resourceLabel} #${numberQuery.number}`;
            } else if (numberQuery.kind === "multi") {
              const nums = numberQuery.numbers;
              const shown = nums
                .slice(0, 3)
                .map((n) => `#${n}`)
                .join(", ");
              label =
                nums.length > 3 ? `Showing ${shown} + ${nums.length - 3} more` : `Showing ${shown}`;
            } else if (numberQuery.kind === "range") {
              label = numberQuery.truncated
                ? `Showing first ${MULTI_FETCH_CAP} of range #${numberQuery.from}..#${numberQuery.to} (capped)`
                : `Showing range #${numberQuery.from}..#${numberQuery.to}`;
            } else {
              label = `Showing #${numberQuery.from} and above`;
            }
            return (
              <p className="bg-overlay-soft border border-[var(--border-divider)] rounded px-2 py-1 text-xs text-muted-foreground">
                {label}
              </p>
            );
          })()}
      </div>

      <div className="flex-1 min-h-0 flex flex-col relative">
        {/* Plain conditional render — AnimatePresence is unsafe here because
            this subtree lives inside a `keepMounted` dropdown wrapped in
            <Activity mode="hidden">. Exit lifecycles get stuck under Activity,
            leaving stale DOM trees with stale closures. See BulkActionBar. */}
        {loading && !data.length ? (
          <div key="github-skeleton" className="overflow-y-auto flex-1 min-h-0">
            <GitHubResourceRowsSkeleton
              count={initialCount && initialCount > 0 ? initialCount : MAX_SKELETON_ITEMS}
            />
          </div>
        ) : data.length > 0 ? (
          <div key="github-content" className="flex-1 min-h-0 flex flex-col">
            {isRateLimited && !error && (
              <div className="px-3 py-2 border-b border-[var(--border-divider)] flex items-center gap-2 text-muted-foreground bg-overlay-soft shrink-0">
                <Clock className="h-3.5 w-3.5 shrink-0" />
                <span className="text-xs truncate">
                  GitHub requests are paused. Showing last known results.
                </span>
                {rateLimitResetAt != null && rateLimitResetAt > Date.now() && (
                  <span className="text-xs text-muted-foreground/70 shrink-0 whitespace-nowrap tabular-nums">
                    · Resumes in <LiveRateLimitCountdown resetAt={rateLimitResetAt} />
                  </span>
                )}
                {lastUpdatedAt != null && !debouncedSearch && (
                  <span className="text-xs text-muted-foreground/70 shrink-0 whitespace-nowrap">
                    · Updated <LiveTimeAgo timestamp={lastUpdatedAt} />
                  </span>
                )}
              </div>
            )}
            {error && (
              <div className="px-3 py-2 border-b border-[var(--border-divider)] flex items-center gap-2 text-muted-foreground bg-overlay-soft shrink-0">
                <WifiOff className="h-3.5 w-3.5 shrink-0" />
                <span className="text-xs truncate">
                  {isTransientNetworkError(error)
                    ? "Couldn't reach GitHub. Showing last known results."
                    : sanitizeIpcError(error)}
                </span>
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
            <div
              id={listId}
              role="listbox"
              aria-multiselectable={selection.isSelectionActive}
              aria-busy={loading || refreshing}
              className="flex-1 min-h-0"
            >
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
          </div>
        ) : null}
        {!loading && !data.length && error && !isTokenError && !isRateLimited && (
          <div className="p-8 text-center text-muted-foreground">
            <WifiOff className="h-5 w-5 mx-auto mb-2 opacity-50" />
            <p className="text-sm">{sanitizeIpcError(error)}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRetry}
              className="mt-2 text-muted-foreground hover:text-daintree-text"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        )}
        {!loading && !data.length && error && isTokenError && (
          <div className="p-8 text-center text-muted-foreground">
            <WifiOff className="h-5 w-5 mx-auto mb-2 opacity-50" />
            <p className="text-sm">{sanitizeIpcError(error)}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleOpenGitHubSettings}
              className="mt-2 text-muted-foreground hover:text-daintree-text"
            >
              <Settings className="h-3.5 w-3.5" />
              Open GitHub Settings
            </Button>
          </div>
        )}
        {!loading && !data.length && isRateLimited && !isTokenError && (
          <EmptyState
            variant="zero-data"
            scale="canvas"
            icon={<Clock />}
            title="GitHub requests are paused"
            description="The current rate-limit window has been exhausted. The dropdown will resume automatically once GitHub clears the quota."
            className="flex-1 justify-center"
          />
        )}
        {!loading && !error && !isRateLimited && !data.length && renderEmpty()}
      </div>

      <div className="p-3 border-t border-[var(--border-divider)] grid grid-cols-[1fr_auto_1fr] items-center shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleOpenInGitHub}
          className="text-muted-foreground hover:text-daintree-text gap-1.5 justify-self-start"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          GitHub
        </Button>
        {!error && !loading && lastUpdatedAt != null && !debouncedSearch ? (
          <p className="text-[10px] text-muted-foreground/60 whitespace-nowrap text-center">
            Updated <LiveTimeAgo timestamp={lastUpdatedAt} />
          </p>
        ) : (
          <span aria-hidden="true" />
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCreateNew}
          className="text-muted-foreground hover:text-daintree-text gap-1.5 justify-self-end"
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
                .map((id) => issueCache.get(id))
                .filter((issue): issue is Issue => issue !== undefined)
            : []
        }
        selectedPRs={
          type === "pr"
            ? Array.from(selection.selectedIds)
                .map((id) => prCache.get(id))
                .filter((pr): pr is PR => pr !== undefined)
            : []
        }
        selectedCount={selection.selectedIds.size}
        onClear={selection.clear}
        onCloseDropdown={onClose}
      />
    </div>
  );
}
