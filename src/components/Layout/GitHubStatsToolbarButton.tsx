import {
  Suspense,
  lazy,
  useRef,
  useState,
  useEffect,
  useCallback,
  useImperativeHandle,
  memo,
  forwardRef,
} from "react";
import { Button } from "@/components/ui/button";
import { FixedDropdown } from "@/components/ui/fixed-dropdown";
import { CircleDot, GitPullRequest, GitCommit } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { actionService } from "@/services/ActionService";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useGitHubFilterStore } from "@/store/githubFilterStore";
import { useRepositoryStats } from "@/hooks/useRepositoryStats";
import { useGitHubTokenExpiryNotification } from "@/hooks/useGitHubTokenExpiryNotification";
import {
  GitHubResourceListSkeleton,
  CommitListSkeleton,
} from "@/components/GitHub/GitHubDropdownSkeletons";
import { GitHubStatusIndicator, type GitHubStatusIndicatorStatus } from "./GitHubStatusIndicator";
import { githubClient } from "@/clients/githubClient";
import { buildCacheKey, getCache, setCache } from "@/lib/githubResourceCache";
import { useGitHubConfigStore } from "@/store/githubConfigStore";
import type { Project } from "@shared/types";
import type { RepositoryStats } from "@shared/types";

// Hover-to-prefetch tuning. 150ms matches the codebase's Tier 1 state-change
// timing and is long enough to filter mouse traversal across the toolbar pill
// while remaining imperceptible to a deliberate hover. The 10s freshness skip
// dedups against a recent click-time fetch without stacking on the 45s SWR
// cache TTL — well under either, leaving plenty of headroom for click-time
// `bypassCache: true` to still see fresh data.
const HOVER_PREFETCH_DELAY_MS = 150;
const PREFETCH_FRESHNESS_MS = 10_000;

// When the user opens the dropdown and the polled stats are older than this,
// fire a click-time forced refresh — cache may still be valid in the strict
// TTL sense, but the user opening the dropdown is a strong signal that they
// want fresh-enough data, and 2 minutes is the threshold beyond which CI
// status / PR state could be visibly out of date. Within this window, trust
// the cache and let the existing 30s poll keep things fresh in background.
const OPEN_FORCE_REFRESH_STALENESS_MS = 2 * 60 * 1000;

function formatRateLimitCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

// Returns the milliseconds until `formatRateLimitCountdown` next produces a
// different string. Used to schedule the countdown's next tick exactly at the
// label-change boundary instead of polling every second.
//
// In the hours range the label only includes minutes (e.g. "1h 5m"), so the
// next change happens when `Math.ceil(remainingMs / 1000)` drops below the
// current minute boundary. In the seconds and minutes ranges the seconds
// component is part of the label, so cadence stays at 1Hz.
export function msUntilNextLabelChange(remainingMs: number): number {
  if (remainingMs <= 0) return 0;
  const totalSeconds = Math.ceil(remainingMs / 1000);
  if (totalSeconds < 3600) {
    return remainingMs % 1000 || 1000;
  }
  const minutes = Math.floor(totalSeconds / 60);
  return remainingMs - (60_000 * minutes - 1000);
}

// Two-tier loading: the toolbar uses lazy()/Suspense for the cold-click case
// (user clicks before the eager preload finishes), AND eagerly resolves the
// concrete component reference on toolbar mount so any subsequent click
// renders the real component without going through a Suspense boundary.
// Without this, even a fully-cached chunk still flashes the skeleton fallback
// for one render — React.lazy suspends on the first render of its boundary
// regardless of whether the import promise has already resolved.
const importGitHubResourceList = () => import("@/components/GitHub/GitHubResourceList");
const importCommitList = () => import("@/components/GitHub/CommitList");

const LazyGitHubResourceList = lazy(() =>
  importGitHubResourceList().then((m) => ({ default: m.GitHubResourceList }))
);
const LazyCommitList = lazy(() => importCommitList().then((m) => ({ default: m.CommitList })));

type GitHubResourceListType =
  typeof import("@/components/GitHub/GitHubResourceList").GitHubResourceList;
type CommitListType = typeof import("@/components/GitHub/CommitList").CommitList;

export interface GitHubStatsHandle {
  closeAll: () => void;
  openIssues: () => void;
  openPrs: () => void;
  openCommits: () => void;
  stats: RepositoryStats | null;
}

interface GitHubStatsToolbarButtonProps {
  currentProject: Project | null;
  "data-toolbar-item"?: string;
}

export const GitHubStatsToolbarButton = memo(
  forwardRef<GitHubStatsHandle, GitHubStatsToolbarButtonProps>(function GitHubStatsToolbarButton(
    { currentProject },
    ref
  ) {
    const {
      stats,
      loading: statsLoading,
      error: statsError,
      isTokenError,
      refresh: refreshStats,
      isStale,
      lastUpdated,
      rateLimitResetAt,
      rateLimitKind,
    } = useRepositoryStats();

    useGitHubTokenExpiryNotification(isTokenError);

    const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
    const activeWorktree = useWorktreeStore((state) =>
      activeWorktreeId ? state.worktrees.get(activeWorktreeId) : null
    );

    const setIssueSearchQuery = useGitHubFilterStore((s) => s.setIssueSearchQuery);
    const setPrSearchQuery = useGitHubFilterStore((s) => s.setPrSearchQuery);

    const [issuesOpen, setIssuesOpen] = useState(false);
    const [prsOpen, setPrsOpen] = useState(false);
    const [commitsOpen, setCommitsOpen] = useState(false);
    const [statsJustUpdated, setStatsJustUpdated] = useState(false);
    const [rateLimitCountdown, setRateLimitCountdown] = useState<string | null>(null);
    const prevLastUpdatedRef = useRef<number | null>(null);

    // Eagerly resolve the dropdown body components so the click path renders
    // them concretely without going through Suspense. The toolbar is a
    // long-lived global UI surface and these dropdowns are commonly used,
    // so paying the chunk cost shortly after mount is a clear win over the
    // alternative of flashing a skeleton on every cold click.
    const [ResourceListComponent, setResourceListComponent] =
      useState<GitHubResourceListType | null>(null);
    const [CommitListComponent, setCommitListComponent] = useState<CommitListType | null>(null);
    useEffect(() => {
      let cancelled = false;
      void importGitHubResourceList().then((m) => {
        if (!cancelled) setResourceListComponent(() => m.GitHubResourceList);
      });
      void importCommitList().then((m) => {
        if (!cancelled) setCommitListComponent(() => m.CommitList);
      });
      return () => {
        cancelled = true;
      };
    }, []);

    useEffect(() => {
      if (
        rateLimitResetAt === null ||
        !Number.isFinite(rateLimitResetAt) ||
        rateLimitResetAt <= Date.now()
      ) {
        setRateLimitCountdown(null);
        return;
      }
      let timeoutId: number | null = null;

      const tick = () => {
        timeoutId = null;
        const remainingMs = rateLimitResetAt - Date.now();
        if (remainingMs <= 0) {
          setRateLimitCountdown(null);
          return;
        }
        setRateLimitCountdown(formatRateLimitCountdown(remainingMs));
        if (!document.hidden) {
          timeoutId = window.setTimeout(tick, msUntilNextLabelChange(remainingMs));
        }
      };

      const onVisibility = () => {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (!document.hidden) {
          tick();
        }
      };

      tick();
      document.addEventListener("visibilitychange", onVisibility);

      return () => {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }
        document.removeEventListener("visibilitychange", onVisibility);
      };
    }, [rateLimitResetAt]);

    const rateLimitActive = rateLimitCountdown !== null;
    const rateLimitLabel = rateLimitActive
      ? rateLimitKind === "secondary"
        ? `Paused · resumes in ${rateLimitCountdown}`
        : `Resets in ${rateLimitCountdown}`
      : null;

    const issuesButtonRef = useRef<HTMLButtonElement>(null);
    const prsButtonRef = useRef<HTMLButtonElement>(null);
    const commitsButtonRef = useRef<HTMLButtonElement>(null);

    const issuesHoverTimerRef = useRef<number | null>(null);
    const prsHoverTimerRef = useRef<number | null>(null);
    const issuesPrefetchInFlightRef = useRef(false);
    const prsPrefetchInFlightRef = useRef(false);

    // Mirror open state into refs so the trailing-edge timer can re-check at
    // fire time. The guard inside `handlePrefetchPointerEnter` is evaluated at
    // schedule time; if the user clicks during the 150ms debounce window the
    // dropdown opens and the mounted GitHubResourceList starts its own fetch
    // — without this ref the timer would still fire and race a duplicate
    // request that could overwrite fresh mount-fetch data in the cache.
    const issuesOpenRef = useRef(issuesOpen);
    const prsOpenRef = useRef(prsOpen);
    useEffect(() => {
      issuesOpenRef.current = issuesOpen;
    }, [issuesOpen]);
    useEffect(() => {
      prsOpenRef.current = prsOpen;
    }, [prsOpen]);

    useEffect(() => {
      return () => {
        if (issuesHoverTimerRef.current !== null) {
          window.clearTimeout(issuesHoverTimerRef.current);
          issuesHoverTimerRef.current = null;
        }
        if (prsHoverTimerRef.current !== null) {
          window.clearTimeout(prsHoverTimerRef.current);
          prsHoverTimerRef.current = null;
        }
      };
    }, []);

    const prefetchResourceList = useCallback(
      (type: "issue" | "pr") => {
        if (!currentProject || isTokenError || rateLimitActive) return;
        // Mount-time race guard: a click during the debounce window flips the
        // open state. Re-check here so a queued timer doesn't fire a duplicate
        // request alongside the dropdown's own mount fetch.
        const isOpenRef = type === "issue" ? issuesOpenRef : prsOpenRef;
        if (isOpenRef.current) return;
        // No-token short-circuit — mirrors GitHubResourceList's own skip path
        // so we don't fire a list IPC that the dropdown would refuse to make.
        const config = useGitHubConfigStore.getState().config;
        if (config && !config.hasToken) return;

        const inFlightRef = type === "issue" ? issuesPrefetchInFlightRef : prsPrefetchInFlightRef;
        if (inFlightRef.current) return;

        const filterStore = useGitHubFilterStore.getState();
        const filterState = type === "issue" ? filterStore.issueFilter : filterStore.prFilter;
        const sortOrder = type === "issue" ? filterStore.issueSortOrder : filterStore.prSortOrder;
        const cacheKey = buildCacheKey(currentProject.path, type, filterState, sortOrder);

        const cached = getCache(cacheKey);
        if (cached && Date.now() - cached.timestamp < PREFETCH_FRESHNESS_MS) return;

        // Hover prefetch primes the list cache silently. The count badge stays
        // fresh via the 30s background poll and the click-time forced refresh
        // — refreshing stats here would flicker the toolbar status indicator.
        inFlightRef.current = true;
        const fetchOptions = {
          cwd: currentProject.path,
          state: filterState,
          bypassCache: true,
          sortOrder,
        };
        const request =
          type === "issue"
            ? githubClient.listIssues(fetchOptions as Parameters<typeof githubClient.listIssues>[0])
            : githubClient.listPullRequests(
                fetchOptions as Parameters<typeof githubClient.listPullRequests>[0]
              );
        void request
          .then((result) => {
            setCache(cacheKey, {
              items: result.items,
              endCursor: result.pageInfo.endCursor,
              hasNextPage: result.pageInfo.hasNextPage,
              timestamp: Date.now(),
            });
          })
          .catch(() => {
            // Swallow prefetch errors — the click path will retry, surface
            // errors, and run its own retry policy. A failed prefetch must
            // not produce visible UI noise.
          })
          .finally(() => {
            inFlightRef.current = false;
          });
      },
      [currentProject, isTokenError, rateLimitActive]
    );

    const handlePrefetchPointerEnter = useCallback(
      (type: "issue" | "pr", e: React.PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        const isOpen = type === "issue" ? issuesOpen : prsOpen;
        if (isOpen) return;
        const timerRef = type === "issue" ? issuesHoverTimerRef : prsHoverTimerRef;
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          prefetchResourceList(type);
        }, HOVER_PREFETCH_DELAY_MS);
      },
      [issuesOpen, prsOpen, prefetchResourceList]
    );

    const handlePrefetchPointerLeave = useCallback(
      (type: "issue" | "pr", e: React.PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        const timerRef = type === "issue" ? issuesHoverTimerRef : prsHoverTimerRef;
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      },
      []
    );

    useEffect(() => {
      if (statsLoading || statsError) {
        setStatsJustUpdated(false);
      } else if (
        lastUpdated != null &&
        prevLastUpdatedRef.current != null &&
        lastUpdated > prevLastUpdatedRef.current
      ) {
        setStatsJustUpdated(true);
      }
      prevLastUpdatedRef.current = lastUpdated;
    }, [lastUpdated, statsLoading, statsError]);

    const getGitHubIndicatorStatus = useCallback((): GitHubStatusIndicatorStatus => {
      if (statsLoading) return "loading";
      if (statsError && !isTokenError) return "error";
      if (statsJustUpdated) return "success";
      return "idle";
    }, [statsLoading, statsError, isTokenError, statsJustUpdated]);

    const handleGitHubStatusTransitionEnd = useCallback(() => {
      setStatsJustUpdated(false);
    }, []);

    const getTimeSinceUpdate = useCallback((timestamp: number | null): string => {
      if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0) {
        return "unknown";
      }
      const seconds = Math.floor((Date.now() - timestamp) / 1000);
      if (seconds < 0) return "just now";
      if (seconds < 60) return "just now";
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    }, []);

    const openSettingsForToken = useCallback(() => {
      void actionService.dispatch(
        "app.settings.openTab",
        { tab: "github", sectionId: "github-token" },
        { source: "user" }
      );
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        closeAll: () => {
          setIssuesOpen(false);
          setPrsOpen(false);
          setCommitsOpen(false);
        },
        openIssues: () => {
          if (isTokenError) {
            openSettingsForToken();
            return;
          }
          setIssuesOpen((p) => !p);
        },
        openPrs: () => {
          if (isTokenError) {
            openSettingsForToken();
            return;
          }
          setPrsOpen((p) => !p);
        },
        openCommits: () => setCommitsOpen((p) => !p),
        stats,
      }),
      [stats, isTokenError, openSettingsForToken]
    );

    if (!currentProject) return null;

    return (
      <div
        className="toolbar-stats relative mr-2 flex h-8 items-center overflow-hidden rounded-[var(--toolbar-pill-radius,0.5rem)] border divide-x divide-[var(--toolbar-stats-divider,var(--theme-border-subtle))]"
        style={{
          ["--toolbar-stats-divider" as string]:
            "var(--toolbar-stats-divider,var(--theme-border-subtle))",
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={issuesButtonRef}
              variant="ghost"
              data-toolbar-item=""
              onPointerEnter={(e) => handlePrefetchPointerEnter("issue", e)}
              onPointerLeave={(e) => handlePrefetchPointerLeave("issue", e)}
              onClick={() => {
                setPrsOpen(false);
                setPrSearchQuery("");
                setCommitsOpen(false);
                if (isTokenError) {
                  setIssuesOpen(false);
                  setIssueSearchQuery("");
                  void actionService.dispatch(
                    "app.settings.openTab",
                    { tab: "github", sectionId: "github-token" },
                    { source: "user" }
                  );
                  return;
                }
                const willOpen = !issuesOpen;
                setIssuesOpen(willOpen);
                if (!willOpen) setIssueSearchQuery("");
                // Only force-refresh on open if the polled stats are stale
                // enough to be visibly out of date. Within the freshness
                // window, the 30s poll has the cache hot and the dropdown
                // reads from it instantly with no spinner.
                if (
                  willOpen &&
                  (lastUpdated == null ||
                    Date.now() - lastUpdated > OPEN_FORCE_REFRESH_STALENESS_MS)
                ) {
                  refreshStats({ force: true });
                }
              }}
              className={cn(
                "h-full gap-2 rounded-none px-3 text-daintree-text hover:bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] hover:text-text-primary",
                isTokenError && "opacity-40",
                !isTokenError && stats?.issueCount === 0 && "opacity-50",
                !isTokenError && isStale && "opacity-60",
                issuesOpen &&
                  "bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] text-text-primary ring-1 ring-github-open/20"
              )}
              aria-label={
                isTokenError
                  ? "Configure GitHub token to see issues"
                  : `${stats?.issueCount ?? "\u2014"} open issues${isStale ? " (cached)" : ""}`
              }
            >
              <CircleDot
                className={cn(
                  "h-4 w-4",
                  isTokenError ? "text-muted-foreground" : "text-github-open"
                )}
              />
              <span className="text-xs font-medium tabular-nums">
                {stats?.issueCount ?? "\u2014"}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isTokenError
              ? "Configure GitHub token to see issues"
              : isStale
                ? `${stats?.issueCount ?? "\u2014"} open issues (last updated ${getTimeSinceUpdate(lastUpdated)} - offline)`
                : "Browse GitHub Issues"}
          </TooltipContent>
        </Tooltip>
        <FixedDropdown
          open={issuesOpen}
          onOpenChange={(open) => {
            setIssuesOpen(open);
            if (!open) {
              setIssueSearchQuery("");
              issuesButtonRef.current?.focus();
            }
          }}
          anchorRef={issuesButtonRef}
          className="p-0 w-[450px]"
          persistThroughChildOverlays
          keepMounted
        >
          {ResourceListComponent ? (
            <ResourceListComponent
              type="issue"
              projectPath={currentProject.path}
              onClose={() => {
                setIssuesOpen(false);
                setIssueSearchQuery("");
                issuesButtonRef.current?.focus();
              }}
              initialCount={stats?.issueCount}
            />
          ) : (
            <Suspense
              fallback={
                <GitHubResourceListSkeleton count={stats?.issueCount} immediate type="issue" />
              }
            >
              <LazyGitHubResourceList
                type="issue"
                projectPath={currentProject.path}
                onClose={() => {
                  setIssuesOpen(false);
                  setIssueSearchQuery("");
                  issuesButtonRef.current?.focus();
                }}
                initialCount={stats?.issueCount}
              />
            </Suspense>
          )}
        </FixedDropdown>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={prsButtonRef}
              variant="ghost"
              data-toolbar-item=""
              onPointerEnter={(e) => handlePrefetchPointerEnter("pr", e)}
              onPointerLeave={(e) => handlePrefetchPointerLeave("pr", e)}
              onClick={() => {
                setIssuesOpen(false);
                setIssueSearchQuery("");
                setCommitsOpen(false);
                if (isTokenError) {
                  setPrsOpen(false);
                  setPrSearchQuery("");
                  void actionService.dispatch(
                    "app.settings.openTab",
                    { tab: "github", sectionId: "github-token" },
                    { source: "user" }
                  );
                  return;
                }
                const willOpen = !prsOpen;
                setPrsOpen(willOpen);
                if (!willOpen) setPrSearchQuery("");
                // Only force-refresh on open if the polled stats are stale
                // enough to be visibly out of date. Within the freshness
                // window, the 30s poll has the cache hot and the dropdown
                // reads from it instantly with no spinner.
                if (
                  willOpen &&
                  (lastUpdated == null ||
                    Date.now() - lastUpdated > OPEN_FORCE_REFRESH_STALENESS_MS)
                ) {
                  refreshStats({ force: true });
                }
              }}
              className={cn(
                "h-full gap-2 rounded-none px-3 text-daintree-text hover:bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] hover:text-text-primary",
                isTokenError && "opacity-40",
                !isTokenError && stats?.prCount === 0 && "opacity-50",
                !isTokenError && isStale && "opacity-60",
                prsOpen &&
                  "bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] text-text-primary ring-1 ring-github-merged/20"
              )}
              aria-label={
                isTokenError
                  ? "Configure GitHub token to see pull requests"
                  : `${stats?.prCount ?? "\u2014"} open pull requests${isStale ? " (cached)" : ""}`
              }
            >
              <GitPullRequest
                className={cn(
                  "h-4 w-4",
                  isTokenError ? "text-muted-foreground" : "text-github-merged"
                )}
              />
              <span className="text-xs font-medium tabular-nums">{stats?.prCount ?? "\u2014"}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isTokenError
              ? "Configure GitHub token to see pull requests"
              : isStale
                ? `${stats?.prCount ?? "\u2014"} open PRs (last updated ${getTimeSinceUpdate(lastUpdated)} - offline)`
                : "Browse GitHub Pull Requests"}
          </TooltipContent>
        </Tooltip>
        <FixedDropdown
          open={prsOpen}
          onOpenChange={(open) => {
            setPrsOpen(open);
            if (!open) {
              setPrSearchQuery("");
              prsButtonRef.current?.focus();
            }
          }}
          anchorRef={prsButtonRef}
          className="p-0 w-[450px]"
          keepMounted
        >
          {ResourceListComponent ? (
            <ResourceListComponent
              type="pr"
              projectPath={currentProject.path}
              onClose={() => {
                setPrsOpen(false);
                setPrSearchQuery("");
                prsButtonRef.current?.focus();
              }}
              initialCount={stats?.prCount}
            />
          ) : (
            <Suspense
              fallback={<GitHubResourceListSkeleton count={stats?.prCount} immediate type="pr" />}
            >
              <LazyGitHubResourceList
                type="pr"
                projectPath={currentProject.path}
                onClose={() => {
                  setPrsOpen(false);
                  setPrSearchQuery("");
                  prsButtonRef.current?.focus();
                }}
                initialCount={stats?.prCount}
              />
            </Suspense>
          )}
        </FixedDropdown>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={commitsButtonRef}
              variant="ghost"
              data-toolbar-item=""
              onClick={() => {
                setIssuesOpen(false);
                setIssueSearchQuery("");
                setPrsOpen(false);
                setPrSearchQuery("");
                setCommitsOpen(!commitsOpen);
              }}
              className={cn(
                "h-full gap-2 rounded-none px-3 text-daintree-text hover:bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] hover:text-text-primary",
                stats?.commitCount === 0 && "opacity-50",
                commitsOpen &&
                  "bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] text-text-primary ring-1 ring-border-strong"
              )}
              aria-label={`${stats?.commitCount ?? "\u2014"} commits`}
            >
              <GitCommit className="h-4 w-4" />
              <span className="text-xs font-medium tabular-nums">
                {stats?.commitCount ?? "\u2014"}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Browse Git Commits</TooltipContent>
        </Tooltip>
        <FixedDropdown
          open={commitsOpen}
          onOpenChange={(open) => {
            setCommitsOpen(open);
            if (!open) commitsButtonRef.current?.focus();
          }}
          anchorRef={commitsButtonRef}
          className="p-0 w-[450px]"
        >
          {CommitListComponent ? (
            <CommitListComponent
              projectPath={activeWorktree?.path ?? currentProject.path}
              branch={activeWorktree?.branch}
              onClose={() => {
                setCommitsOpen(false);
                commitsButtonRef.current?.focus();
              }}
              initialCount={stats?.commitCount}
            />
          ) : (
            <Suspense fallback={<CommitListSkeleton count={stats?.commitCount} immediate />}>
              <LazyCommitList
                projectPath={activeWorktree?.path ?? currentProject.path}
                branch={activeWorktree?.branch}
                onClose={() => {
                  setCommitsOpen(false);
                  commitsButtonRef.current?.focus();
                }}
                initialCount={stats?.commitCount}
              />
            </Suspense>
          )}
        </FixedDropdown>
        <GitHubStatusIndicator
          status={getGitHubIndicatorStatus()}
          error={statsError ?? undefined}
          onTransitionEnd={handleGitHubStatusTransitionEnd}
        />
        {rateLimitActive && rateLimitLabel ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                role="status"
                aria-live="polite"
                aria-label={
                  rateLimitKind === "secondary"
                    ? `GitHub secondary rate limit — resuming in ${rateLimitCountdown}`
                    : `GitHub rate limit — resets in ${rateLimitCountdown}`
                }
                className="flex h-full items-center px-2 text-[10px] font-medium text-muted-foreground opacity-60"
              >
                {rateLimitLabel}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {rateLimitKind === "secondary"
                ? "GitHub triggered a secondary (abuse) rate limit — polling paused until it clears."
                : "GitHub API quota exhausted — polling paused until the quota resets."}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    );
  })
);
