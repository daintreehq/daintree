import {
  Suspense,
  lazy,
  useRef,
  useState,
  useEffect,
  useEffectEvent,
  useCallback,
  useImperativeHandle,
  useMemo,
  memo,
  forwardRef,
} from "react";
import { CircleDot, GitPullRequest, GitCommit, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { actionService } from "@/services/ActionService";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useGitHubFilterStore } from "@/store/githubFilterStore";
import { useRepositoryStats } from "@/hooks/useRepositoryStats";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
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
import type { GitHubRateLimitDetails, RepositoryStats } from "@shared/types";
import { freshnessOpacityClass, FreshnessGlyph, freshnessSuffix } from "./FreshnessUtils";
import {
  formatRateLimitCountdown,
  msUntilNextLabelChange,
  RateLimitDetailsPanel,
} from "./RateLimitDetails";
import { GitHubStatPill } from "./GitHubStatPill";

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

// Lifetime of the corner activity chip after the most recent count increase.
// The chip is a glanceable "something new arrived" cue, not a persistent
// unread-state badge — three minutes is long enough for a user to notice it
// during normal task flow without lingering past the moment of relevance.
const ACTIVITY_CHIP_TTL_MS = 3 * 60 * 1000;

// Re-exported for external consumers (tests, rate-limit math)
export { msUntilNextLabelChange } from "./RateLimitDetails";

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
      lastUpdated,
      rateLimitResetAt,
      rateLimitKind,
      freshnessLevel,
    } = useRepositoryStats();

    useGitHubTokenExpiryNotification(isTokenError);

    // Drives the tooltip aging copy ("updated 3m ago") without per-component
    // intervals — the ticker is shared, paused on hidden tabs, and tears down
    // when no consumers remain. The memo re-captures `Date.now()` on every
    // tick so the freshness suffix advances even between background polls.
    const tick = useGlobalMinuteTicker();
    const now = useMemo(() => {
      void tick;
      return Date.now();
    }, [tick]);

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
    const [rateLimitTooltipOpen, setRateLimitTooltipOpen] = useState(false);
    const [rateLimitDetails, setRateLimitDetails] = useState<GitHubRateLimitDetails | null>(null);
    const [rateLimitNow, setRateLimitNow] = useState(() => Date.now());
    const prevLastUpdatedRef = useRef<number | null>(null);

    // Per-digit pulse counters. Incrementing forces a key-driven remount of
    // the digit span, restarting the badge-bump keyframe cleanly without the
    // el.offsetWidth reflow hack. Key starts at 0 and the class is only
    // applied once it's > 0, so the very first mount paints neutral. The
    // matching `xCountRef` defaults to `undefined` so the no-op poll guard
    // (`xCountRef.current !== xCount`) can't fire on first mount — only an
    // explicit seed flips the ref to a real value.
    const [issueAnimKey, setIssueAnimKey] = useState(0);
    const [prAnimKey, setPrAnimKey] = useState(0);
    const [commitAnimKey, setCommitAnimKey] = useState(0);
    const issueCountRef = useRef<number | null | undefined>(undefined);
    const prCountRef = useRef<number | null | undefined>(undefined);
    const commitCountRef = useRef<number | null | undefined>(undefined);

    // Local count derivations — read once per render so aria-labels, tooltip
    // copy, and the rendered numeral all reference the same value without
    // repeating `stats?.x ?? null` at each call site.
    const issueCount = stats?.issueCount ?? null;
    const prCount = stats?.prCount ?? null;
    const commitCount = stats?.commitCount ?? null;

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

    // Fetch the per-bucket breakdown when the tooltip opens, and tick a 1Hz
    // clock so the per-bucket countdowns animate locally without re-fetching.
    // GitHub's `/rate_limit` endpoint is itself quota-free, so opening the
    // tooltip doesn't compete with the very limit it's reporting on.
    useEffect(() => {
      if (!rateLimitActive || !rateLimitTooltipOpen) return;
      let cancelled = false;
      void githubClient.getRateLimitDetails().then((details) => {
        if (!cancelled) setRateLimitDetails(details);
      });
      setRateLimitNow(Date.now());
      const intervalId = window.setInterval(() => {
        setRateLimitNow(Date.now());
      }, 1000);
      return () => {
        cancelled = true;
        window.clearInterval(intervalId);
      };
    }, [rateLimitActive, rateLimitTooltipOpen]);

    // Drop stale per-bucket data once the limit clears so the next time the
    // tooltip opens we don't flash old numbers before the fresh fetch lands.
    useEffect(() => {
      if (!rateLimitActive) setRateLimitDetails(null);
    }, [rateLimitActive]);

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
    const commitsOpenRef = useRef(commitsOpen);
    useEffect(() => {
      issuesOpenRef.current = issuesOpen;
    }, [issuesOpen]);
    useEffect(() => {
      prsOpenRef.current = prsOpen;
    }, [prsOpen]);
    useEffect(() => {
      commitsOpenRef.current = commitsOpen;
    }, [commitsOpen]);

    // Per-category corner-chip pulse timestamps. Set when the digit-pulse
    // detector sees a strict count increase (poll-driven, dropdown closed,
    // tab visible — same trigger as the digit bump). The chip auto-hides
    // ACTIVITY_CHIP_TTL_MS after the most recent increase, or immediately
    // when the user opens the matching dropdown. State is intentionally not
    // persisted: the chip is a fresh-activity cue, not an unread-state
    // indicator that should survive app restarts.
    const [issuesPulseAt, setIssuesPulseAt] = useState<number | null>(null);
    const [prsPulseAt, setPrsPulseAt] = useState<number | null>(null);

    const showIssuesChip =
      !isTokenError && issuesPulseAt !== null && !issuesOpen && (issueCount ?? 0) > 0;
    const showPrsChip = !isTokenError && prsPulseAt !== null && !prsOpen && (prCount ?? 0) > 0;

    // Auto-clear each chip ACTIVITY_CHIP_TTL_MS after the most recent count
    // increase. The dependency on `*PulseAt` re-arms the timer whenever a
    // newer increase resets the timestamp; the cleanup cancels any pending
    // timer if the user opens the dropdown (which sets pulseAt → null) or
    // a fresher pulse takes its place.
    useEffect(() => {
      if (issuesPulseAt === null) return;
      const remaining = ACTIVITY_CHIP_TTL_MS - (Date.now() - issuesPulseAt);
      if (remaining <= 0) {
        setIssuesPulseAt(null);
        return;
      }
      const id = window.setTimeout(() => setIssuesPulseAt(null), remaining);
      return () => window.clearTimeout(id);
    }, [issuesPulseAt]);

    useEffect(() => {
      if (prsPulseAt === null) return;
      const remaining = ACTIVITY_CHIP_TTL_MS - (Date.now() - prsPulseAt);
      if (remaining <= 0) {
        setPrsPulseAt(null);
        return;
      }
      const id = window.setTimeout(() => setPrsPulseAt(null), remaining);
      return () => window.clearTimeout(id);
    }, [prsPulseAt]);

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

    // Wired to `GitHubResourceList`'s `onFreshFetch` callback. When the
    // dropdown's SWR revalidation lands fresh first-page data, the main
    // process has already written the new total count to `repoStatsCache`
    // via `updateRepoStatsCount`. Calling `refreshStats()` (no force) reads
    // that hot cache in a single IPC round-trip — no GitHub network call —
    // and updates the toolbar count badge so the dropdown's count and the
    // badge converge in the same user interaction.
    const handleListFreshFetch = useCallback(() => {
      void refreshStats();
    }, [refreshStats]);

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

    // Delta check for the digit-pulse animation. Wrapped in useEffectEvent so
    // it reads the latest stats, dropdown-open state, and document.hidden at
    // fire time without widening the effect's dep array. Each ref is updated
    // on every fresh stats arrival regardless of suppression — that way a
    // backgrounded tab returning to focus doesn't replay every poll's worth
    // of accumulated deltas at once. The `=== undefined` branch handles the
    // initial seed (no pulse on cold launch); the `!== xCount` branch is
    // the no-op-poll guard so unchanged counts never re-bump.
    const checkForCountIncrease = useEffectEvent(() => {
      const next = stats;
      if (!next) return;
      const suppressed = document.hidden;

      if (issueCountRef.current === undefined) {
        issueCountRef.current = issueCount;
      } else if (issueCountRef.current !== issueCount) {
        if (
          !suppressed &&
          !issuesOpen &&
          issueCountRef.current != null &&
          issueCount != null &&
          issueCount > issueCountRef.current
        ) {
          setIssueAnimKey((k) => k + 1);
          setIssuesPulseAt(Date.now());
        }
        issueCountRef.current = issueCount;
      }

      if (prCountRef.current === undefined) {
        prCountRef.current = prCount;
      } else if (prCountRef.current !== prCount) {
        if (
          !suppressed &&
          !prsOpen &&
          prCountRef.current != null &&
          prCount != null &&
          prCount > prCountRef.current
        ) {
          setPrAnimKey((k) => k + 1);
          setPrsPulseAt(Date.now());
        }
        prCountRef.current = prCount;
      }

      if (commitCountRef.current === undefined) {
        commitCountRef.current = commitCount;
      } else if (commitCountRef.current !== commitCount) {
        if (
          !suppressed &&
          !commitsOpen &&
          commitCountRef.current != null &&
          commitCount != null &&
          commitCount > commitCountRef.current
        ) {
          setCommitAnimKey((k) => k + 1);
        }
        commitCountRef.current = commitCount;
      }
    });

    useEffect(() => {
      if (statsLoading || statsError) {
        setStatsJustUpdated(false);
        return;
      }
      if (lastUpdated == null) {
        // Project switch / reset path: useRepositoryStats clears lastUpdated
        // to null when the user switches projects. Re-seed the per-count
        // refs to `undefined` so the next first successful poll re-enters
        // the seed branch instead of comparing new-project counts against
        // the previous project's stale counts (which would produce a
        // spurious pulse whenever the new project's count is higher).
        // Also clear the activity chips — a chip earned on project A must
        // not linger after switching to project B.
        issueCountRef.current = undefined;
        prCountRef.current = undefined;
        commitCountRef.current = undefined;
        prevLastUpdatedRef.current = null;
        setIssuesPulseAt(null);
        setPrsPulseAt(null);
        return;
      }
      if (prevLastUpdatedRef.current != null && lastUpdated > prevLastUpdatedRef.current) {
        setStatsJustUpdated(true);
        checkForCountIncrease();
      } else if (prevLastUpdatedRef.current == null) {
        // First successful poll — seed the count refs without pulsing.
        checkForCountIncrease();
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
          // Clear the chip on the open transition only — toggling closed
          // should not dismiss it, and the digit-pulse detector won't fire
          // again until a fresh count increase.
          if (!issuesOpenRef.current) setIssuesPulseAt(null);
          setIssuesOpen((p) => !p);
        },
        openPrs: () => {
          if (isTokenError) {
            openSettingsForToken();
            return;
          }
          if (!prsOpenRef.current) setPrsPulseAt(null);
          setPrsOpen((p) => !p);
        },
        openCommits: () => {
          setCommitsOpen((p) => !p);
        },
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
        <GitHubStatPill
          buttonRef={issuesButtonRef}
          open={issuesOpen}
          count={issueCount}
          animKey={issueAnimKey}
          ariaLabel={
            isTokenError
              ? "Configure GitHub token to see issues"
              : `${issueCount ?? "—"} open issues${
                  showIssuesChip ? " (new since last view)" : ""
                }${freshnessSuffix(freshnessLevel, lastUpdated, now)}`
          }
          tooltipContent={
            isTokenError
              ? "Configure GitHub token to see issues"
              : freshnessLevel === "fresh"
                ? "Browse GitHub Issues"
                : `${issueCount ?? "—"} open issues${freshnessSuffix(freshnessLevel, lastUpdated, now)}`
          }
          icon={CircleDot}
          iconClassName={isTokenError ? "text-muted-foreground" : "text-github-open"}
          openRingClassName="ring-1 ring-github-open/20"
          className={cn(
            isTokenError && "opacity-40",
            !isTokenError && stats?.issueCount === 0 && "opacity-50",
            !isTokenError && freshnessOpacityClass(freshnessLevel)
          )}
          dropdownContent={
            ResourceListComponent ? (
              <ResourceListComponent
                type="issue"
                projectPath={currentProject.path}
                onClose={() => {
                  setIssuesOpen(false);
                  setIssueSearchQuery("");
                  issuesButtonRef.current?.focus();
                }}
                initialCount={stats?.issueCount}
                onFreshFetch={handleListFreshFetch}
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
                  onFreshFetch={handleListFreshFetch}
                />
              </Suspense>
            )
          }
          persistThroughChildOverlays
          keepMounted
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
            if (willOpen) setIssuesPulseAt(null);
            if (
              willOpen &&
              (lastUpdated == null || Date.now() - lastUpdated > OPEN_FORCE_REFRESH_STALENESS_MS)
            ) {
              refreshStats({ force: true });
            }
          }}
          onOpenChange={(open) => {
            setIssuesOpen(open);
            if (!open) {
              setIssueSearchQuery("");
              issuesButtonRef.current?.focus();
            }
          }}
          onPointerEnter={(e) => handlePrefetchPointerEnter("issue", e)}
          onPointerLeave={(e) => handlePrefetchPointerLeave("issue", e)}
          activityChip={
            showIssuesChip ? (
              <span
                aria-hidden="true"
                className="bg-github-open pointer-events-none absolute right-0 top-0 h-2 w-2"
                style={{ clipPath: "polygon(0 0, 100% 0, 100% 100%)" }}
              />
            ) : null
          }
          freshnessGlyph={!isTokenError ? <FreshnessGlyph level={freshnessLevel} /> : null}
        />
        <GitHubStatPill
          buttonRef={prsButtonRef}
          open={prsOpen}
          count={prCount}
          animKey={prAnimKey}
          ariaLabel={
            isTokenError
              ? "Configure GitHub token to see pull requests"
              : `${prCount ?? "—"} open pull requests${
                  showPrsChip ? " (new since last view)" : ""
                }${freshnessSuffix(freshnessLevel, lastUpdated, now)}`
          }
          tooltipContent={
            isTokenError
              ? "Configure GitHub token to see pull requests"
              : freshnessLevel === "fresh"
                ? "Browse GitHub Pull Requests"
                : `${prCount ?? "—"} open PRs${freshnessSuffix(freshnessLevel, lastUpdated, now)}`
          }
          icon={GitPullRequest}
          iconClassName={isTokenError ? "text-muted-foreground" : "text-github-merged"}
          openRingClassName="ring-1 ring-github-merged/20"
          className={cn(
            isTokenError && "opacity-40",
            !isTokenError && stats?.prCount === 0 && "opacity-50",
            !isTokenError && freshnessOpacityClass(freshnessLevel)
          )}
          dropdownContent={
            ResourceListComponent ? (
              <ResourceListComponent
                type="pr"
                projectPath={currentProject.path}
                onClose={() => {
                  setPrsOpen(false);
                  setPrSearchQuery("");
                  prsButtonRef.current?.focus();
                }}
                initialCount={stats?.prCount}
                onFreshFetch={handleListFreshFetch}
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
                  onFreshFetch={handleListFreshFetch}
                />
              </Suspense>
            )
          }
          keepMounted
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
            if (willOpen) setPrsPulseAt(null);
            if (
              willOpen &&
              (lastUpdated == null || Date.now() - lastUpdated > OPEN_FORCE_REFRESH_STALENESS_MS)
            ) {
              refreshStats({ force: true });
            }
          }}
          onOpenChange={(open) => {
            setPrsOpen(open);
            if (!open) {
              setPrSearchQuery("");
              prsButtonRef.current?.focus();
            }
          }}
          onPointerEnter={(e) => handlePrefetchPointerEnter("pr", e)}
          onPointerLeave={(e) => handlePrefetchPointerLeave("pr", e)}
          activityChip={
            showPrsChip ? (
              <span
                aria-hidden="true"
                className="bg-github-merged pointer-events-none absolute right-0 top-0 h-2 w-2"
                style={{ clipPath: "polygon(0 0, 100% 0, 100% 100%)" }}
              />
            ) : null
          }
          freshnessGlyph={!isTokenError ? <FreshnessGlyph level={freshnessLevel} /> : null}
        />
        <GitHubStatPill
          buttonRef={commitsButtonRef}
          open={commitsOpen}
          count={commitCount}
          animKey={commitAnimKey}
          ariaLabel={`${commitCount ?? "—"} commits${freshnessSuffix(freshnessLevel, lastUpdated, now)}`}
          tooltipContent={
            freshnessLevel === "fresh"
              ? "Browse Git Commits"
              : `${commitCount ?? "—"} commits${freshnessSuffix(freshnessLevel, lastUpdated, now)}`
          }
          icon={GitCommit}
          openRingClassName="ring-1 ring-border-strong"
          className={cn(
            stats?.commitCount === 0 && "opacity-50",
            freshnessOpacityClass(freshnessLevel)
          )}
          dropdownContent={
            CommitListComponent ? (
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
            )
          }
          onClick={() => {
            setIssuesOpen(false);
            setIssueSearchQuery("");
            setPrsOpen(false);
            setPrSearchQuery("");
            setCommitsOpen((p) => !p);
          }}
          onOpenChange={(open) => {
            setCommitsOpen(open);
            if (!open) commitsButtonRef.current?.focus();
          }}
          freshnessGlyph={<FreshnessGlyph level={freshnessLevel} />}
        />
        <GitHubStatusIndicator
          status={getGitHubIndicatorStatus()}
          error={statsError ?? undefined}
          onTransitionEnd={handleGitHubStatusTransitionEnd}
        />
        {rateLimitActive && rateLimitLabel ? (
          <Tooltip open={rateLimitTooltipOpen} onOpenChange={setRateLimitTooltipOpen}>
            <TooltipTrigger asChild>
              <div
                role="status"
                aria-live="polite"
                aria-label={
                  rateLimitKind === "secondary"
                    ? `GitHub secondary rate limit — resuming in ${rateLimitCountdown}`
                    : `GitHub rate limit — resets in ${rateLimitCountdown}`
                }
                className="flex h-full items-center gap-1.5 px-2.5 text-[10px] font-medium text-muted-foreground"
              >
                <Clock className="h-3 w-3 opacity-70" aria-hidden />
                <span className="tabular-nums">{rateLimitLabel}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="px-0 py-0">
              <RateLimitDetailsPanel
                kind={rateLimitKind}
                details={rateLimitDetails}
                now={rateLimitNow}
                fallbackResetAt={rateLimitResetAt}
              />
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    );
  })
);
