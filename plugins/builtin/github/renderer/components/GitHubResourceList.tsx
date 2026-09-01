import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useContext,
  useRef,
  type KeyboardEvent,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  Search,
  ExternalLink,
  RefreshCw,
  WifiOff,
  Plus,
  Settings,
  X,
  ArrowUpDown,
  Clock,
} from "lucide-react";
import { ListChecks } from "@/components/icons";
import { GitHubIcon } from "@/components/icons/brands";
import { isTokenRelatedError, isTransientNetworkError } from "@/lib/forgeErrors";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { safeStringify } from "@/lib/safeStringify";
import { GitHubListItem } from "./GitHubListItem";
import { buildWorktreeIndex, deriveRowModel } from "./forgeRowModel";
import { BulkActionBar } from "./BulkActionBar";
import { useIssueSelection } from "@/hooks/useIssueSelection";
import { useIssueSelectionStore } from "@/store/issueSelectionStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import {
  useGitHubFilterStore,
  type IssueStateFilter,
  type PRStateFilter,
} from "../stores/githubFilterStore";
import { useGitHubConfigStore } from "../stores/githubConfigStore";
import type { Issue, PR } from "@shared/types/forge";
import type { Worktree } from "@shared/types/worktree";
import type { GitHubSortOrder } from "../../shared/types.js";
import { looksLikeNumberList, MULTI_FETCH_CAP } from "@/lib/parseNumberQuery";
import {
  GitHubResourceRowsSkeleton,
  MAX_SKELETON_ITEMS,
  RESOURCE_ITEM_HEIGHT_PX,
} from "./GitHubDropdownSkeletons";
import { LiveTimeAgo } from "@/components/Worktree/LiveTimeAgo";
import { LiveRateLimitCountdown } from "@/components/Layout/RateLimitDetails";
import { useGitHubResourceListSWR } from "../hooks/useGitHubResourceListSWR";
import { forgeClient } from "@/clients/forgeClient";
import { useScrollShadowOverlays } from "@/components/ui/ScrollShadow";
import { FixedDropdownVisibleContext } from "@/components/ui/fixed-dropdown";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import { UI_DOHERTY_THRESHOLD, UI_SKELETON_FLOOR_MS } from "@/lib/animationUtils";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";

type StateFilter = IssueStateFilter | PRStateFilter;

/** Stable empty snapshot for the views that have no worktree store to read. */
const EMPTY_WORKTREES: ReadonlyMap<string, Worktree> = new Map();

/**
 * How old the loaded page has to be before the footer says so out loud.
 *
 * Freshness used to occupy a permanent centre slot that read "Updated now" on
 * essentially every open — a whole column spent restating that nothing was
 * wrong. It lives in the refresh control's tooltip now, where it answers the
 * question that control raises, and only comes back onto the surface once the
 * answer is worth interrupting for. Five minutes is the point at which the
 * 30s stats poll and the on-open revalidation have both plainly not landed.
 */
const FRESHNESS_VISIBLE_AFTER_MS = 5 * 60_000;

/**
 * Spinner onset for a background revalidation — the standard Doherty gate.
 * Work that finishes inside it is invisible, which is the whole point.
 */
const REVALIDATE_SPINNER_GATE_MS = UI_DOHERTY_THRESHOLD;

/** Past this, a wait stops being a wait and starts needing acknowledgement. */
const STILL_WORKING_AFTER_MS = 5_000;

/**
 * Spinner onset for an explicit click on Refresh. Also the Doherty gate — a
 * press does not buy an exemption from it. The acknowledgement a press needs
 * is already there without any spinner: the button takes its own press state
 * and the results container flips `aria-busy` immediately. A sub-400ms refresh
 * should resolve with no chrome having appeared at all.
 */
const MANUAL_REFRESH_SPINNER_GATE_MS = UI_DOHERTY_THRESHOLD;

/** Minimum on-screen dwell once the spinner has crossed either gate. */
const SPINNER_DWELL_MS = UI_SKELETON_FLOOR_MS * 2;

function sanitizeIpcError(message: string): string {
  const cleaned = message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "").trim();
  return cleaned.length > 120 ? cleaned.slice(0, 117) + "…" : cleaned;
}

interface LoadMoreFooterContext {
  hasMore: boolean;
  loadingMore: boolean;
  /** `loadingMore` past the Doherty gate — before it, the button says nothing. */
  showLoadingMoreSpinner: boolean;
  /** Past five seconds, where the wait needs acknowledging in words. */
  isSlowLoadingMore: boolean;
  isLoadMoreActive: boolean;
  loadMoreError: string | null;
  type: "issue" | "pr";
  /** One-based grid position — always the row after the last item. */
  rowIndex: number;
  onLoadMore: () => void;
  onOpenSettings: () => void;
}

/**
 * The list's last row, semantically as well as visually.
 *
 * It lives in Virtuoso's `Footer` slot, which puts it outside the virtualized
 * row set — but it is still the thing the down-arrow reaches after the last
 * item, so it has to BE a row: a bare `<div>` there left
 * `aria-activedescendant` dangling the moment the cursor arrived on it.
 */
function LoadMoreFooter({ context }: { context?: LoadMoreFooterContext }) {
  if (!context || !context.hasMore) return null;
  const {
    loadingMore,
    showLoadingMoreSpinner,
    isSlowLoadingMore,
    isLoadMoreActive,
    loadMoreError,
    type,
    rowIndex,
    onLoadMore,
    onOpenSettings,
  } = context;
  const isTokenError = loadMoreError !== null && isTokenRelatedError(loadMoreError);
  return (
    <div role="row" aria-rowindex={rowIndex} className="p-3">
      <div role="gridcell">
        {loadMoreError ? (
          // ONE way out, not two. This used to render Retry-or-Settings AND
          // the ordinary Load more button underneath, so a token failure
          // offered a button guaranteed to fail again right below the one
          // that could actually fix it.
          <div className="p-2 rounded-[var(--radius-md)] bg-overlay-soft border border-[var(--border-divider)]">
            <p className="text-xs text-text-secondary">{sanitizeIpcError(loadMoreError)}</p>
            <Button
              id={`github-${type}-load-more`}
              variant="ghost"
              size="sm"
              onClick={isTokenError ? onOpenSettings : onLoadMore}
              className={cn("mt-1 h-6 text-xs", isLoadMoreActive && "bg-overlay-soft")}
            >
              {isTokenError ? (
                <>
                  <Settings className="h-3 w-3" />
                  Open GitHub settings
                </>
              ) : (
                "Retry"
              )}
            </Button>
          </div>
        ) : (
          <Button
            id={`github-${type}-load-more`}
            variant="ghost"
            onClick={onLoadMore}
            disabled={loadingMore}
            className={cn(
              "w-full",
              // Neutral, not accent: the keyboard cursor uses the same neutral
              // lift here that it uses on a row, so the two can never both claim
              // the accent at once.
              isLoadMoreActive && "bg-overlay-soft text-text-primary"
            )}
          >
            {showLoadingMoreSpinner ? (
              <>
                <RefreshCw className="animate-spin" />
                {isSlowLoadingMore ? "Still working…" : "Loading…"}
              </>
            ) : (
              "Load more"
            )}
          </Button>
        )}
      </div>
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
  const [selectionMenuOpen, setSelectionMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Doherty Threshold gate for the refresh spinner: both an explicit click and
  // a background revalidation stay invisible below 400ms, and once visible the
  // spinner dwells so it never flashes on fast networks. A press does not buy
  // an exemption — the button's own press state and the results grid's
  // immediate `aria-busy` flip are the acknowledgement.
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
      const delay = isManualRefreshRef.current
        ? MANUAL_REFRESH_SPINNER_GATE_MS
        : REVALIDATE_SPINNER_GATE_MS;
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
      const remaining = Math.max(0, SPINNER_DWELL_MS - elapsed);
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
    // Clearing the outgoing key drops its snapshots with it.
    useIssueSelectionStore.getState().clear(`${type}:${prevProjectPath}`);
  }, [projectPath, type]);

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

  const handleOpenInGitHub = useCallback(() => {
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
  }, [searchQuery, filterState, type, projectPath, handleClose]);

  /**
   * Open the forge's compose page. This used to call `handleOpenInGitHub()`,
   * so "New" and "GitHub" were the same button wearing two labels — the
   * control promised a compose form and delivered the list you were already
   * looking at.
   *
   * The repo's web root is derived from an item URL rather than assumed: every
   * `Issue`/`PR` carries an absolute `url` (`…/owner/repo/issues/123`), and
   * `getIssueUrl` produces one on demand when the list is empty. That keeps the
   * derivation inside the GitHub plugin, where GitHub's URL shapes are legal,
   * without teaching the host about them.
   */
  const handleCreateNew = useCallback(() => {
    const repoRootFrom = (url: string): string | null => {
      const match = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/(?:issues|pull)\//.exec(url);
      return match ? match[1]! : null;
    };
    void (async () => {
      let root = data.length > 0 ? repoRootFrom(data[0]!.url) : null;
      if (!root) {
        try {
          root = repoRootFrom(await forgeClient.getIssueUrl(projectPath, 1));
        } catch {
          root = null;
        }
      }
      if (!root) {
        // No web root to compose against — fall back to the list rather than
        // leaving the click silently dead.
        handleOpenInGitHub();
        return;
      }
      const target = type === "issue" ? `${root}/issues/new` : `${root}/compare`;
      // dispatch() resolves `{ ok: false }` rather than throwing, so an ignored
      // result is a button that silently does nothing.
      void actionService
        .dispatch("system.openExternal", { url: target }, { source: "user" })
        .then((result) => {
          if (!result.ok) {
            notify({
              type: "error",
              title:
                type === "issue" ? "Couldn't open new issue" : "Couldn't open new pull request",
              message: `Daintree couldn't hand off to the browser. Open ${target} manually, or try again.`,
              action: { label: "Try again", onClick: () => handleCreateNew() },
            });
          }
        });
      handleClose();
    })();
  }, [data, projectPath, type, handleOpenInGitHub, handleClose]);

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

  /**
   * Which resources already have a worktree, resolved once for the whole list.
   *
   * Every mounted row used to linearly scan the worktree map for itself, and
   * the Enter handler scanned it again through a third access path with its own
   * copy of the match rule. One index, one rule, both paths.
   */
  // The optional read, not the throwing one: this panel is an overlay that
  // only ENRICHES itself with the view's worktrees. Taking the whole forge
  // surface down because it rendered without a worktree store would be a
  // crash over a detail it can do without. The selector returns the map's own
  // reference, which is the stability `useSyncExternalStore` requires.
  const worktreeMap = useWorktreeStoreOptional((s) => s.worktrees, EMPTY_WORKTREES);
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const worktreeIndex = useMemo(
    () => buildWorktreeIndex(worktreeMap.values(), type, activeWorktreeId),
    [worktreeMap, type, activeWorktreeId]
  );

  /**
   * Opening an item hands off to the browser, so the dropdown has nothing left
   * to show — closing it matches every other hand-off in the app and stops the
   * panel hanging over the window the user just switched away to.
   */
  const handleOpenUrlExternal = useCallback(
    (url: string) => {
      // dispatch() resolves `{ ok: false }` instead of throwing, so an
      // unchecked result is a row that silently does nothing. Same recovery
      // shape the footer's "View on GitHub" uses.
      void actionService
        .dispatch("system.openExternal", { url }, { source: "user" })
        .then((result) => {
          if (!result.ok) {
            notify({
              type: "error",
              title: "Couldn't open GitHub",
              message: `Daintree couldn't hand off to the browser. Open ${url} manually, or try again.`,
              coalesce: {
                key: `forge-open-item-failed:${projectPath}`,
                buildMessage: () => "Daintree couldn't hand off to the browser.",
              },
              action: { label: "Try again", onClick: () => handleOpenUrlExternal(url) },
            });
          }
        });
      handleClose();
    },
    [handleClose, projectPath]
  );

  /**
   * The grid keeps DOM focus in the search input at all times — that is what
   * makes `aria-activedescendant` legal. Anything that takes focus away
   * (the row actions menu, the sort popover) has to hand it back here.
   */
  const focusSearchInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // `autoFocus` only fires on the first mount, and this panel is `keepMounted`
  // — every reopen after the first is an `<Activity>` reveal of a subtree that
  // never unmounted, so without this the second open landed with focus
  // wherever the click left it and none of the grid's keys worked.
  // `open`, not "still painted" — see the provider in `fixed-dropdown.tsx`.
  // The distinction matters here: this panel's overlays have to be torn down
  // on the way out, not after the exit animation has already hidden the
  // subtree that owns their effects.
  const isDropdownOpen = useContext(FixedDropdownVisibleContext);
  const rootRef = useRef<HTMLDivElement>(null);
  const wasDropdownOpenRef = useRef(isDropdownOpen);
  useEffect(() => {
    if (isDropdownOpen) return;
    // Closing — nothing of ours may stay portaled on `document.body`.
    setSortPopoverOpen(false);
    setSelectionMenuOpen(false);
    setOpenRowMenuNumber(null);
  }, [isDropdownOpen]);

  // The selection menu only ever describes the rows on screen right now, for
  // the project open right now. It has to close when either goes away. A
  // background revalidation keeps the list visible and the trigger live, so a
  // page that comes back empty can otherwise leave the menu standing over
  // nothing — and a preset there would replace the selection with an empty
  // one. The panel also survives a project switch without remounting, which
  // would rebind the presets to the new project while still listing the old
  // one's rows.
  useEffect(() => {
    if (data.length > 0) return;
    setSelectionMenuOpen(false);
  }, [data.length]);

  useEffect(() => {
    setSelectionMenuOpen(false);
  }, [type, projectPath]);

  useEffect(() => {
    const wasOpen = wasDropdownOpenRef.current;
    wasDropdownOpenRef.current = isDropdownOpen;
    // Only on the hidden → visible edge. `autoFocus` already covers the first
    // mount; this covers every reopen after it, which under `keepMounted` is
    // an `<Activity>` reveal of a subtree that never unmounted. Running it on
    // the initial pass too would let a late frame yank focus back off whatever
    // the user had already reached inside the panel.
    if (!isDropdownOpen || wasOpen) return;
    // A frame late on purpose: the reveal un-hides the subtree in the same
    // commit, and focusing a still-`display:none` input is a no-op.
    const raf = requestAnimationFrame(() => {
      // Never take focus off a child overlay that has since earned it — the
      // sort popover and the row menus portal to `document.body`, outside
      // `rootRef`, so they need naming explicitly.
      const active = document.activeElement;
      if (
        active &&
        active !== document.body &&
        (rootRef.current?.contains(active) ||
          active.closest('[role="menu"],[data-radix-popper-content-wrapper]'))
      ) {
        return;
      }
      focusSearchInput();
    });
    return () => cancelAnimationFrame(raf);
  }, [isDropdownOpen, focusSearchInput]);

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    focusSearchInput();
  }, [setSearchQuery, focusSearchInput]);

  const { ref: scrollShadowRef, topShadow, bottomShadow } = useScrollShadowOverlays();
  // Virtuoso hands back `HTMLElement | Window | null`; the shadow hook only
  // ever wants the element.
  const handleScrollerRef = useCallback(
    (el: HTMLElement | Window | null) => {
      scrollShadowRef(el instanceof HTMLElement ? el : null);
    },
    [scrollShadowRef]
  );

  /**
   * True when the list is empty for the plainest possible reason: nothing is
   * open and nothing is narrowing the view. That state owns the create CTA —
   * the footer's copy of it stands down so the panel never shows the same
   * action twice, 100px apart, in two different weights.
   */
  const isZeroData =
    !loading &&
    !error &&
    !isRateLimited &&
    data.length === 0 &&
    exactNumberNotFound === null &&
    numberQuery === null &&
    debouncedSearch.trim().length === 0 &&
    filterState === "open";

  /**
   * Which row's actions menu is open, if any.
   *
   * Controlled rather than left to Radix so the panel can take its child
   * overlays down with it. `FixedDropdown`'s documented invariant is that
   * portaled content escapes the `<Activity>` subtree entirely: a menu still
   * open when the panel hides stays mounted on `document.body`, with stale
   * state and, once Floating UI loses its anchor, at (0,0).
   */
  const [openRowMenuNumber, setOpenRowMenuNumber] = useState<number | null>(null);

  // A background revalidation can rename an issue or move a PR's head ref
  // under a selection made minutes ago. This refreshes the stored copies —
  // membership and the range anchor are deliberately untouched.
  const reconcileSelection = selection.reconcile;
  useEffect(() => {
    reconcileSelection(data);
  }, [data, reconcileSelection]);

  /** The selection as an array — the objects the bulk action will act on. */
  const selectedItems = useMemo(
    () => Array.from(selection.selectedItems.values()),
    [selection.selectedItems]
  );

  /**
   * Selected items the current search or state tab is not showing. Selection
   * deliberately survives both, so the bulk bar has to say when it is about to
   * act on rows that are not on screen.
   */
  const hiddenSelectedCount = useMemo(() => {
    if (selection.selectedItems.size === 0) return 0;
    const visible = new Set(data.map((item) => item.number));
    let hidden = 0;
    for (const id of selection.selectedItems.keys()) {
      if (!visible.has(id)) hidden += 1;
    }
    return hidden;
  }, [selection.selectedItems, data]);

  // Silent while the list is fresh; speaks up once it plainly is not. The
  // shared minute clock drives the flip. It has to be the CLOCK, not the bare
  // ticker: React Compiler memoizes this body, so a `Date.now()` read here can
  // be cached and freeze, and the note would only ever appear if something
  // unrelated happened to re-render the panel.
  const nowMs = useGlobalMinuteClock();
  const showStaleFreshness =
    !error &&
    !loading &&
    !debouncedSearch &&
    lastUpdatedAt != null &&
    nowMs - lastUpdatedAt >= FRESHNESS_VISIBLE_AFTER_MS;

  const listId = `github-${type}-list`;
  // Rate-limited means `handleLoadMore` returns without fetching, so an
  // enabled Load more button and a cursor stop on it were both promising
  // something the hook would not do.
  const canLoadMore = hasMore && !isRateLimited;
  const maxIndex = data.length - 1 + (canLoadMore ? 1 : 0);
  const activeItem = activeIndex >= 0 && activeIndex < data.length ? data[activeIndex] : null;
  const isLoadMoreActive = canLoadMore && activeIndex === data.length;
  // The cursor can sit on Load more, and when it does `aria-activedescendant`
  // has to name it — leaving the attribute undefined told assistive tech the
  // cursor had left the grid entirely.
  const activeItemId = activeItem
    ? `github-${type}-option-${activeItem.number}`
    : isLoadMoreActive
      ? `github-${type}-load-more`
      : undefined;

  /**
   * Keep the cursor on the same resource across a refresh.
   *
   * Resetting to -1 whenever `data` changed identity meant a background
   * revalidation landing mid-navigation silently threw away your place. The
   * cursor tracks a resource number now, and only drops when that resource is
   * genuinely no longer in the list.
   */
  const activeIndexRef = useRef(activeIndex);
  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  // A resource number only identifies a row within one project and one
  // resource kind. Issue #42 in the project you just switched to is a
  // different issue #42, and a warm cache can swap the rows straight in.
  const cursorScope = `${projectPath}:${type}`;
  const previousScopeRef = useRef(cursorScope);
  const previousDataRef = useRef(data);
  useEffect(() => {
    const previousData = previousDataRef.current;
    const previousScope = previousScopeRef.current;
    previousDataRef.current = data;
    previousScopeRef.current = cursorScope;
    if (previousScope !== cursorScope) {
      setActiveIndex(-1);
      return;
    }
    if (previousData === data) return;
    const previousNumber =
      activeIndexRef.current >= 0 ? previousData[activeIndexRef.current]?.number : undefined;
    if (previousNumber === undefined) {
      setActiveIndex(-1);
      return;
    }
    setActiveIndex(data.findIndex((item) => item.number === previousNumber));
  }, [data, cursorScope]);

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
      // During IME composition the browser owns the event lifecycle — an
      // Enter that commits a candidate must not also activate a row. The
      // keyCode check covers Safari/WebKit, where `isComposing` is not yet set
      // on the first keydown. Mirrors `useGlobalKeybindings`.
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
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
              handleOpenUrlExternal(activeItem.url);
            } else {
              // The same derivation the row runs for a click, so the two can
              // never drift apart.
              const { primaryAction } = deriveRowModel(
                activeItem,
                worktreeIndex.get(activeItem.number),
                activeWorktreeId
              );
              switch (primaryAction.kind) {
                case "switch":
                  handleSwitchToWorktree(primaryAction.worktreeId);
                  break;
                case "create":
                  handleCreateWorktree(activeItem);
                  break;
                case "open":
                  handleOpenUrlExternal(activeItem.url);
                  break;
              }
            }
          }
          break;
        }
        case " ": {
          // DOM focus never leaves the search input, so a bare Space belongs to
          // the query — "fix crash" must stay typeable with a row under the
          // cursor. Membership takes the modifier instead.
          if (!e.shiftKey || activeIndex < 0 || !activeItem) break;
          e.preventDefault();
          e.stopPropagation();
          selection.toggle(activeItem);
          break;
        }
        case "F10":
        case "ContextMenu": {
          // The row's actions menu, opened without a pointer. The menu is
          // controlled, so this is a state change rather than a synthesized
          // click on a `tabIndex={-1}` trigger.
          if (e.key === "F10" && !e.shiftKey) break;
          if (!activeItem) break;
          e.preventDefault();
          e.stopPropagation();
          setOpenRowMenuNumber(activeItem.number);
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
      activeIndex,
      activeItem,
      handleLoadMore,
      worktreeIndex,
      activeWorktreeId,
      handleSwitchToWorktree,
      handleCreateWorktree,
      handleOpenUrlExternal,
      handleClose,
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

  // Pagination gets the same Doherty gate as everything else: a page that
  // arrives inside 400ms should not have flashed a spinner on the way, and one
  // that takes longer than five seconds should say so rather than spin
  // silently. `useDeferredLoading` owns the gate.
  const showLoadingMoreSpinner = useDeferredLoading(loadingMore, UI_DOHERTY_THRESHOLD);
  const isSlowLoadingMore = useDeferredLoading(loadingMore, STILL_WORKING_AFTER_MS);

  const footerContext = useMemo<LoadMoreFooterContext>(
    () => ({
      hasMore: canLoadMore,
      loadingMore,
      showLoadingMoreSpinner,
      isSlowLoadingMore,
      isLoadMoreActive,
      loadMoreError,
      type,
      rowIndex: data.length + 1,
      onLoadMore: handleLoadMore,
      onOpenSettings: handleOpenGitHubSettings,
    }),
    [
      canLoadMore,
      loadingMore,
      showLoadingMoreSpinner,
      isSlowLoadingMore,
      isLoadMoreActive,
      loadMoreError,
      type,
      data.length,
      handleLoadMore,
      handleOpenGitHubSettings,
    ]
  );

  /**
   * Empty states name the way out, not the absence. Each of the three ways a
   * list can come back empty has a different next action, so each gets its own
   * — a single "No issues found" made the search miss, the state filter and a
   * genuinely empty tracker look like one indistinguishable dead end.
   */
  const renderEmpty = () => {
    const trimmedSearch = debouncedSearch.trim();
    const resourceLabel = type === "issue" ? "issues" : "pull requests";
    const singular = type === "issue" ? "issue" : "pull request";

    // 1. A query that matched nothing — the way out is clearing the query, and
    //    the state tab too when that is also narrowing the view. The label says
    //    which, so the button never undoes more than it claims to.
    if (exactNumberNotFound !== null || numberQuery !== null || trimmedSearch.length > 0) {
      const stateAlsoNarrows = filterState !== "open";
      const title =
        exactNumberNotFound !== null
          ? `No ${singular} #${exactNumberNotFound} in this view`
          : trimmedSearch.length > 0
            ? `No matches for "${trimmedSearch}"`
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
                if (stateAlsoNarrows) setFilterState("open" as StateFilter);
                handleClearSearch();
              }}
            >
              {stateAlsoNarrows ? "Clear search and filters" : "Clear search"}
            </Button>
          }
          className="flex-1 justify-center"
        />
      );
    }

    // 2. A state tab with nothing in it — the way out is the tab that has data.
    if (filterState !== "open") {
      return (
        <EmptyState
          variant="filtered-empty"
          scale="canvas"
          title={`No ${filterState} ${resourceLabel}`}
          action={
            <Button variant="ghost" size="sm" onClick={() => setFilterState("open" as StateFilter)}>
              {`Show open ${resourceLabel}`}
            </Button>
          }
          className="flex-1 justify-center"
        />
      );
    }

    // 3. Genuinely nothing open — the way out is creating the first one.
    return (
      <EmptyState
        variant="zero-data"
        scale="canvas"
        title={`No open ${resourceLabel}`}
        description={
          type === "issue"
            ? "Open an issue to track the next piece of work."
            : "Open a pull request when a branch is ready to review."
        }
        action={
          <Button variant="outline" size="sm" onClick={handleCreateNew}>
            <Plus className="h-3.5 w-3.5" />
            {type === "issue" ? "New issue" : "New pull request"}
          </Button>
        }
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
    <div ref={rootRef} className="relative w-[450px] flex flex-col h-[500px]">
      <div className="p-3 border-b border-[var(--border-divider)] space-y-2 shrink-0">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "flex items-center gap-1.5 px-2.5 h-8 rounded-[var(--radius-md)] flex-1 min-w-0",
              "bg-overlay-soft border border-[var(--border-overlay)]",
              // Full-strength accent, and only here: the search input is the
              // single focus anchor for this region, so it gets the whole
              // accent budget rather than two washed-out fractions of it.
              "transition-[border-color] duration-150 ease-out",
              "focus-within:border-accent-primary"
            )}
          >
            <Search
              className="w-3.5 h-3.5 shrink-0 text-text-secondary pointer-events-none"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="text"
              placeholder={`Search ${type === "issue" ? "issues" : "pull requests"}…`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleInputKeyDown}
              autoFocus
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={true}
              aria-haspopup="grid"
              aria-controls={listId}
              aria-activedescendant={activeItemId}
              aria-label={`Search ${type === "issue" ? "issues" : "pull requests"}`}
              aria-keyshortcuts="ArrowDown ArrowUp Enter Meta+Enter Control+Enter Shift+Space Shift+F10"
              /* Claims Shift+F10 / ContextMenu for the row under the cursor.
                 Without this the app's capture-phase global handler consumes
                 them first and the row menu stays pointer-only. */
              data-row-menu=""
              className="flex-1 min-w-0 text-sm bg-transparent text-text-primary placeholder:text-text-secondary focus:outline-hidden"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={handleClearSearch}
                aria-label="Clear search"
                className={cn(
                  "flex items-center justify-center w-5 h-5 rounded shrink-0",
                  "text-text-secondary hover:text-text-primary",
                  "transition-colors duration-150 ease-out"
                )}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleManualRefreshClick}
                disabled={loading || refreshing}
                aria-label={
                  showSpinner
                    ? "Refreshing…"
                    : `Refresh ${type === "issue" ? "issues" : "pull requests"}`
                }
                className={cn(
                  "flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] shrink-0",
                  "text-text-secondary hover:text-text-primary hover:bg-overlay-medium",
                  "transition-[background-color,color] duration-150 ease-out disabled:cursor-default",
                  showSpinner && "text-status-info"
                )}
              >
                <RefreshCw className={cn("w-3.5 h-3.5", showSpinner && "animate-spin")} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {showSpinner ? (
                "Refreshing…"
              ) : /* When a banner or the footer is already stating freshness,
                     the tooltip stays out of it — one occurrence, not three. */
              lastUpdatedAt != null && !error && !isRateLimited && !showStaleFreshness ? (
                <>
                  Refresh &middot; updated <LiveTimeAgo timestamp={lastUpdatedAt} />
                </>
              ) : (
                "Refresh"
              )}
            </TooltipContent>
          </Tooltip>
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
                title={sortOrder === "created" ? "Sort" : "Sort: recently updated"}
                className={cn(
                  "flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] shrink-0",
                  "text-text-secondary hover:text-text-primary hover:bg-overlay-medium",
                  "transition-[background-color,color] duration-150 ease-out",
                  // A non-default sort is a neutral lifted state, not a badge.
                  // The old blue dot read as unread activity and said nothing
                  // about which order was in force.
                  sortOrder !== "created" && "bg-overlay-soft text-text-primary"
                )}
              >
                <ArrowUpDown className="w-3.5 h-3.5" />
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
              <div className="text-xs font-medium text-text-secondary mb-2">Sort by</div>
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
                        "transition-[background-color,color] duration-150 ease-out",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2",
                        "focus-visible:outline-accent-primary",
                        sortOrder === option.value
                          ? "bg-overlay-soft text-text-primary"
                          : "text-text-secondary hover:bg-overlay-medium hover:text-text-primary"
                      )}
                    >
                      <div
                        className={cn(
                          "w-3 h-3 rounded-full border",
                          sortOrder === option.value
                            ? "border-text-primary bg-text-primary"
                            : "border-border-default"
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
          {/* The bulk-select entry point lives here, in the fixed icon row,
              rather than in a row of its own. A helper row keyed to selection
              mode could only be reached by ticking a row first, and one keyed
              to the search query grew the stacked header on the first
              keystroke and shoved the list down. A trigger that is always
              present at a fixed size is neither. */}
          <Popover open={selectionMenuOpen} onOpenChange={setSelectionMenuOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={loading || data.length === 0}
                aria-label={`Select ${type === "issue" ? "issues" : "pull requests"}`}
                aria-haspopup="dialog"
                aria-expanded={selectionMenuOpen}
                title="Select"
                className={cn(
                  "flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] shrink-0",
                  "text-text-secondary hover:text-text-primary hover:bg-overlay-medium",
                  "transition-[background-color,color] duration-150 ease-out",
                  // No lift while a selection is live: the bulk bar already
                  // states the count, and a second membership signal here
                  // would say the same thing twice.
                  "disabled:cursor-default disabled:opacity-50",
                  "disabled:hover:bg-transparent disabled:hover:text-text-secondary"
                )}
              >
                <ListChecks className="w-3.5 h-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={8}
              className="w-56 p-3"
              onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
              onTouchStart={(e: React.TouchEvent) => e.stopPropagation()}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setSelectionMenuOpen(false);
                }
              }}
              // Radix gives the content `role="dialog"`, and a dialog that
              // announces itself as nothing is a dialog a screen-reader user
              // has to explore to identify.
              aria-label="Selection actions"
            >
              <div className="text-xs font-medium text-text-secondary mb-2">Select</div>
              <div className="flex flex-col gap-1">
                {(() => {
                  const allSelected =
                    data.length > 0 && data.every((item) => selection.selectedIds.has(item.number));
                  // Assignment, not worktree readiness — the two measure
                  // different things, so this one does NOT inherit the open
                  // filter below. `data` is already scoped by the state tab,
                  // and a closed issue with nobody on it is still unassigned.
                  // PRs carry no assignment model at all, so the choice is
                  // absent for them rather than permanently empty.
                  const unassigned =
                    type === "issue"
                      ? data.filter((item) => (item as Issue).assignees.length === 0)
                      : null;
                  // Open as well as worktree-less: the bulk planner skips
                  // closed issues and merged PRs outright, so selecting them
                  // would walk you into a dialog with nothing left to create.
                  const withoutWorktree = data.filter(
                    (item) => item.state === "open" && !worktreeIndex.has(item.number)
                  );

                  const options: {
                    key: string;
                    label: string;
                    disabled: boolean;
                    onSelect: () => void;
                  }[] = [
                    allSelected
                      ? {
                          key: "deselect-all",
                          label: "Deselect all",
                          disabled: false,
                          onSelect: () => selection.clear(),
                        }
                      : {
                          key: "select-all",
                          label: `Select all (${data.length})`,
                          disabled: data.length === 0,
                          onSelect: () => selection.selectAll(data),
                        },
                  ];
                  if (unassigned !== null) {
                    options.push({
                      key: "select-unassigned",
                      label: `Select unassigned (${unassigned.length})`,
                      disabled: unassigned.length === 0,
                      onSelect: () => selection.selectAll(unassigned),
                    });
                  }
                  options.push({
                    key: "select-without-worktrees",
                    label: `Select without worktrees (${withoutWorktree.length})`,
                    disabled: withoutWorktree.length === 0,
                    onSelect: () => selection.selectAll(withoutWorktree),
                  });

                  // Disabled rather than dropped at zero: a menu whose entries
                  // come and go between openings has to be re-read every time,
                  // and an empty preset would replace the selection with
                  // nothing.
                  return options.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      disabled={option.disabled}
                      onClick={() => {
                        option.onSelect();
                        setSelectionMenuOpen(false);
                      }}
                      className={cn(
                        "flex items-center px-2 py-1 text-xs text-start rounded-[var(--radius-sm)]",
                        "transition-[background-color,color] duration-150 ease-out",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2",
                        "focus-visible:outline-accent-primary",
                        "text-text-secondary hover:bg-overlay-medium hover:text-text-primary",
                        "disabled:cursor-default disabled:opacity-50",
                        "disabled:hover:bg-transparent disabled:hover:text-text-secondary"
                      )}
                    >
                      {option.label}
                    </button>
                  ));
                })()}
              </div>
            </PopoverContent>
          </Popover>
        </div>

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
                  "flex-1 px-3 py-1 text-xs font-medium rounded",
                  "transition-[background-color,color] duration-150 ease-out",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2",
                  "focus-visible:outline-accent-primary",
                  isActive
                    ? "bg-overlay-medium text-text-primary"
                    : "text-text-secondary hover:text-text-primary"
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
              if (nums.length > MULTI_FETCH_CAP) {
                label = `Showing first ${MULTI_FETCH_CAP} of ${nums.length} numbers (capped)`;
              } else {
                const shown = nums
                  .slice(0, 3)
                  .map((n) => `#${n}`)
                  .join(", ");
                label =
                  nums.length > 3
                    ? `Showing ${shown} + ${nums.length - 3} more`
                    : `Showing ${shown}`;
              }
            } else if (numberQuery.kind === "range") {
              label = numberQuery.truncated
                ? `Showing first ${MULTI_FETCH_CAP} of range #${numberQuery.from}..#${numberQuery.to} (capped)`
                : `Showing range #${numberQuery.from}..#${numberQuery.to}`;
            } else {
              label = `Showing #${numberQuery.from} and above`;
            }
            return (
              <p className="bg-overlay-soft border border-[var(--border-divider)] rounded-[var(--radius-sm)] px-2 py-1 text-xs text-text-secondary">
                {label}
              </p>
            );
          })()}

        {/* The other half of the same chip slot: when a query that was plainly
            meant as a number lookup fails to parse, the results below are
            GitHub's full-text matches, which include anything that merely
            mentions those numbers. Say so rather than letting the list quietly
            fill with rows nobody asked for. Gated hard (see
            `looksLikeNumberList`) so ordinary text searches stay silent. */}
        {numberQuery === null &&
          !loading &&
          !error &&
          !isRateLimited &&
          looksLikeNumberList(debouncedSearch) && (
            <p className="bg-overlay-soft border border-[var(--border-divider)] rounded-[var(--radius-sm)] px-2 py-1 text-xs text-text-secondary">
              Showing text matches — separate numbers with commas or spaces
            </p>
          )}
      </div>

      {/* The combobox points `aria-controls` here, so this element exists in
          every state — loading, empty, errored, rate-limited. It used to be
          rendered only alongside data, which left an expanded combobox
          controlling nothing at exactly the moments a screen-reader user most
          needs to be told what happened. The per-state announcements live
          inside it. */}
      <div
        id={listId}
        role="grid"
        aria-label={type === "issue" ? "Issues" : "Pull requests"}
        /* Capability, not current state: these rows can always be
           multi-selected, whether or not any are right now. */
        aria-multiselectable
        aria-busy={loading || refreshing || loadingMore}
        /* -1 while more pages exist — the true total is unknown, and claiming
           the loaded count is a lie a screen reader reads out as "row 20 of
           20" on a list that keeps growing. */
        aria-rowcount={hasMore ? -1 : data.length}
        className="flex-1 min-h-0 flex flex-col relative"
      >
        {/* Covers only the states with no visible announcement of their own.
            Errors are NOT in here: the banner below carries the message and is
            an `alert`, so repeating it would announce it twice and put the
            same string in the accessibility tree in two places. */}
        <span role="status" aria-live="polite" className="sr-only">
          {loading
            ? `Loading ${type === "issue" ? "issues" : "pull requests"}…`
            : isRateLimited
              ? // Nothing here, but deliberately ahead of the zero-results
                // branch: a paused list is empty for a reason, and "No issues"
                // is the wrong thing to be told. The paused surface below is
                // its own `status`, so it does the announcing.
                ""
              : !error && data.length === 0
                ? `No ${type === "issue" ? "issues" : "pull requests"}`
                : ""}
        </span>
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
              <div
                role="status"
                className="px-3 py-2 border-b border-[var(--border-divider)] flex items-center gap-2 text-text-secondary bg-overlay-soft shrink-0"
              >
                <Clock className="h-3.5 w-3.5 shrink-0" />
                <span className="text-xs truncate">
                  GitHub requests are paused. Showing last known results.
                </span>
                {rateLimitResetAt != null && rateLimitResetAt > Date.now() && (
                  <span className="text-xs text-text-secondary shrink-0 whitespace-nowrap tabular-nums">
                    · Resumes in <LiveRateLimitCountdown resetAt={rateLimitResetAt} />
                  </span>
                )}
                {lastUpdatedAt != null && !debouncedSearch && (
                  <span className="text-xs text-text-secondary shrink-0 whitespace-nowrap">
                    · Updated <LiveTimeAgo timestamp={lastUpdatedAt} />
                  </span>
                )}
              </div>
            )}
            {error && (
              <div
                role="alert"
                className="px-3 py-2 border-b border-[var(--border-divider)] flex items-center gap-2 text-text-secondary bg-overlay-soft shrink-0"
              >
                <WifiOff className="h-3.5 w-3.5 shrink-0" />
                <span className="text-xs truncate">
                  {isTransientNetworkError(error)
                    ? "Couldn't reach GitHub. Showing last known results."
                    : sanitizeIpcError(error)}
                </span>
                {lastUpdatedAt != null && !debouncedSearch && (
                  <span className="text-xs text-text-secondary shrink-0 whitespace-nowrap">
                    · Updated <LiveTimeAgo timestamp={lastUpdatedAt} />
                  </span>
                )}
                {isTokenError ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleOpenGitHubSettings}
                    className="ml-auto h-6 text-xs shrink-0"
                  >
                    <Settings className="h-3 w-3" />
                    Settings
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleRetry}
                    className="ml-auto h-6 text-xs shrink-0"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Retry
                  </Button>
                )}
              </div>
            )}
            <div role="rowgroup" className="relative flex-1 min-h-0">
              {/* The panel is a fixed 500px and rows are a fixed 64px, so the
                  list almost never divides evenly — the bottom row was being
                  guillotined through its own metadata line. The shared scroll
                  shadow turns that cut into a fade, and doubles as the "more
                  below" cue the fixed height otherwise hides. */}
              {topShadow}
              {bottomShadow}
              <Virtuoso
                ref={virtuosoRef}
                scrollerRef={handleScrollerRef}
                data={data}
                context={footerContext}
                style={{ height: "100%" }}
                fixedItemHeight={RESOURCE_ITEM_HEIGHT_PX}
                computeItemKey={(_, item) => item.number}
                increaseViewportBy={{ top: 0, bottom: 200 }}
                endReached={() => {
                  if (!loadingMore && !loading && canLoadMore) handleLoadMore();
                }}
                components={{ Footer: LoadMoreFooter }}
                itemContent={(index, item) => (
                  <GitHubListItem
                    item={item}
                    type={type}
                    worktree={worktreeIndex.get(item.number)}
                    activeWorktreeId={activeWorktreeId}
                    timeField={sortOrder === "created" ? "created" : "updated"}
                    onCreateWorktree={handleCreateWorktree}
                    onSwitchToWorktree={handleSwitchToWorktree}
                    optionId={`github-${type}-option-${item.number}`}
                    menuTriggerId={`github-${type}-row-menu-${item.number}`}
                    rowIndex={index + 1}
                    menuOpen={openRowMenuNumber === item.number}
                    onMenuOpenChange={(next: boolean) =>
                      setOpenRowMenuNumber(next ? item.number : null)
                    }
                    onMenuClose={focusSearchInput}
                    onOpenExternalUrl={handleOpenUrlExternal}
                    isActive={activeIndex === index}
                    isSelected={selection.selectedIds.has(item.number)}
                    isSelectionActive={selection.isSelectionActive}
                    onToggleSelect={(e: { shiftKey: boolean }) => {
                      if (e.shiftKey) {
                        selection.toggleRange(item, data);
                      } else {
                        selection.toggle(item);
                      }
                    }}
                  />
                )}
              />
            </div>
          </div>
        ) : null}
        {!loading && !data.length && error && !isTokenError && !isRateLimited && (
          /* An alert, like the stale-data banner: the shared status node stays
             quiet whenever an error is showing, so without this a cold-start
             failure was announced by nothing at all. */
          <div role="alert" className="p-8 text-center text-text-secondary">
            <WifiOff className="h-5 w-5 mx-auto mb-2 opacity-50" />
            <p className="text-sm">{sanitizeIpcError(error)}</p>
            <Button variant="ghost" size="sm" onClick={handleRetry} className="mt-2">
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        )}
        {!loading && !data.length && error && isTokenError && (
          <div role="alert" className="p-8 text-center text-text-secondary">
            <WifiOff className="h-5 w-5 mx-auto mb-2 opacity-50" />
            <p className="text-sm">{sanitizeIpcError(error)}</p>
            <Button variant="ghost" size="sm" onClick={handleOpenGitHubSettings} className="mt-2">
              <Settings className="h-3.5 w-3.5" />
              Open GitHub settings
            </Button>
          </div>
        )}
        {!loading && !data.length && isRateLimited && !isTokenError && (
          /* Its own status, like the error surfaces are their own alerts —
             the shared announcer stays quiet here rather than reading the
             same sentence out a second time. */
          <div role="status" className="contents">
            <EmptyState
              variant="zero-data"
              scale="canvas"
              icon={<Clock />}
              title="GitHub requests are paused"
              /* One node shape either way: EmptyState keys its fade-through on
               the description, so switching between a string and JSX made the
               copy re-animate the moment a reset time arrived. */
              description={
                <>
                  GitHub is holding new requests. This list resumes{" "}
                  {rateLimitResetAt != null && rateLimitResetAt > Date.now() ? (
                    <>
                      in <LiveRateLimitCountdown resetAt={rateLimitResetAt} />
                    </>
                  ) : (
                    "on its own once they're allowed again"
                  )}
                  .
                </>
              }
              className="flex-1 justify-center"
            />
          </div>
        )}
        {!loading && !error && !isRateLimited && !data.length && renderEmpty()}
      </div>

      {/* Freshness is no longer a permanent third column here — it moved into
          the refresh control's tooltip, where it answers the question the
          control itself raises. A footer that reads "Updated now" on every
          open spends a whole slot restating that nothing is wrong.

          Hidden entirely while a selection is live: `BulkActionBar` takes over
          this band at the same height, so the panel never grows a second
          bottom bar or loses a row of list to one. */}
      <div
        className={cn(
          "px-2 py-1.5 border-t border-[var(--border-divider)] grid grid-cols-[1fr_auto_1fr] items-center shrink-0",
          selection.selectedItems.size > 0 && "hidden"
        )}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={handleOpenInGitHub}
          className="gap-1.5 justify-self-start"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          View on GitHub
        </Button>
        {showStaleFreshness ? (
          <p className="text-xs text-text-secondary whitespace-nowrap text-center">
            Updated <LiveTimeAgo timestamp={lastUpdatedAt!} />
          </p>
        ) : (
          <span aria-hidden="true" />
        )}
        {isZeroData ? (
          <span aria-hidden="true" />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCreateNew}
            className="gap-1.5 justify-self-end"
          >
            <Plus className="h-3.5 w-3.5" />
            {type === "issue" ? "New issue" : "New pull request"}
          </Button>
        )}
      </div>

      <BulkActionBar
        mode={type === "issue" ? "issue" : "pr"}
        hiddenCount={hiddenSelectedCount}
        selectedIssues={type === "issue" ? (selectedItems as Issue[]) : []}
        selectedPRs={type === "pr" ? (selectedItems as PR[]) : []}
        selectedCount={selectedItems.length}
        onClear={selection.clear}
        onCloseDropdown={onClose}
      />
    </div>
  );
}
