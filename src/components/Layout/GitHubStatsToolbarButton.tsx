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
import { Button } from "@/components/ui/button";
import { FixedDropdown } from "@/components/ui/fixed-dropdown";
import { CircleDot, Clock, GitPullRequest, GitCommit, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { actionService } from "@/services/ActionService";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useGitHubFilterStore } from "@/store/githubFilterStore";
import { useRepositoryStats, type FreshnessLevel } from "@/hooks/useRepositoryStats";
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
import { useGitHubSeenAnchorsStore, deriveBadgeLabel } from "@/store/githubSeenAnchorsStore";
import type { Project } from "@shared/types";
import type { GitHubRateLimitDetails, RepositoryStats } from "@shared/types";

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

// Per-tier opacity so the badge no longer conflates fresh, in-session aging,
// disk-cached, and errored data into a single `opacity-60` tint. `aging` stays
// closest to full opacity since the data is in-session and probably fine; the
// remaining tiers step down so a glance distinguishes them. WCAG 1.4.11 means
// opacity alone isn't sufficient, so the count icon below pairs an explicit
// glyph with each non-fresh tier.
function freshnessOpacityClass(level: FreshnessLevel): string {
  switch (level) {
    case "aging":
      return "opacity-75";
    case "stale-disk":
      return "opacity-60";
    case "errored":
      return "opacity-50";
    case "fresh":
    default:
      return "";
  }
}

// Returns a small lucide glyph rendered after the count to give a non-color
// signal for non-fresh tiers. `aging` returns null because the data is still
// in-session — the opacity step is enough and the row should not be cluttered
// with an icon for a state the user encounters most often. `aria-hidden`
// because the freshness state is already announced via the per-button
// `aria-label`.
function FreshnessGlyph({ level }: { level: FreshnessLevel }) {
  if (level === "stale-disk") {
    return <Clock className="h-3 w-3 text-muted-foreground" aria-hidden="true" />;
  }
  if (level === "errored") {
    return <WifiOff className="h-3 w-3 text-muted-foreground" aria-hidden="true" />;
  }
  return null;
}

function formatTimeSince(timestamp: number | null, now: number): string {
  if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0) {
    return "unknown";
  }
  const seconds = Math.floor((now - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function freshnessSuffix(level: FreshnessLevel, lastUpdated: number | null, now: number): string {
  switch (level) {
    case "aging":
      return ` · updated ${formatTimeSince(lastUpdated, now)}`;
    case "stale-disk":
      return " · cached from previous session";
    case "errored":
      return " · couldn't reach GitHub";
    case "fresh":
    default:
      return "";
  }
}

function formatRateLimitCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const pad2 = (n: number) => String(n).padStart(2, "0");
  if (totalSeconds < 60) return `${pad2(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${pad2(seconds)}s` : `${minutes}m`;
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

interface RateLimitDetailsPanelProps {
  kind: "primary" | "secondary" | null;
  details: GitHubRateLimitDetails | null;
  now: number;
  fallbackResetAt: number | null;
}

function RateLimitDetailsPanel({
  kind,
  details,
  now,
  fallbackResetAt,
}: RateLimitDetailsPanelProps) {
  const heading =
    kind === "secondary"
      ? "Secondary rate limit"
      : kind === "primary"
        ? "Rate limit reached"
        : "GitHub API quota";
  const subheading =
    kind === "secondary"
      ? "GitHub paused requests for abuse protection. Polling resumes automatically."
      : "Polling resumes when the bucket resets.";

  const buckets: Array<{ label: string; bucket: GitHubRateLimitDetails["core"] | null }> = details
    ? [
        { label: "GraphQL", bucket: details.graphql },
        { label: "REST core", bucket: details.core },
        { label: "Search", bucket: details.search },
      ]
    : [];

  return (
    <div className="w-[260px] px-3.5 py-3.5">
      <div className="pb-5">
        <div className="text-text-primary text-sm font-semibold leading-tight">{heading}</div>
        <div className="text-muted-foreground mt-1 text-[11px] leading-snug">{subheading}</div>
      </div>
      {details ? (
        <div className="flex flex-col gap-4">
          {buckets.map(({ label, bucket }) =>
            bucket ? (
              <RateLimitBucketRow key={label} label={label} bucket={bucket} now={now} />
            ) : null
          )}
        </div>
      ) : (
        <div className="text-muted-foreground text-[11px] tabular-nums">
          {fallbackResetAt && fallbackResetAt > now
            ? formatRateLimitCountdown(fallbackResetAt - now)
            : "Loading…"}
        </div>
      )}
    </div>
  );
}

interface RateLimitBucketRowProps {
  label: string;
  bucket: GitHubRateLimitDetails["core"];
  now: number;
}

function RateLimitBucketRow({ label, bucket, now }: RateLimitBucketRowProps) {
  const remainingMs = Math.max(0, bucket.resetAt - now);
  const exhausted = bucket.remaining <= 0;
  const ratio = bucket.limit > 0 ? Math.min(1, bucket.used / bucket.limit) : 0;
  const timeLabel = remainingMs > 0 ? formatRateLimitCountdown(remainingMs) : "Reset due";
  const aria = `${label}: ${bucket.remaining.toLocaleString()} of ${bucket.limit.toLocaleString()} remaining. ${
    remainingMs > 0 ? `Resets in ${timeLabel}` : "Reset available"
  }.`;

  return (
    <div className="flex flex-col gap-2" aria-label={aria}>
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={cn(
            "text-[13px] font-medium leading-none",
            exhausted ? "text-text-primary" : "text-daintree-text"
          )}
        >
          {label}
        </span>
        <span className="text-muted-foreground text-[11px] leading-none tabular-nums">
          {timeLabel}
        </span>
      </div>
      <div className="bg-overlay-subtle h-1.5 overflow-hidden rounded-full">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300 ease-out",
            exhausted ? "bg-github-closed" : "bg-daintree-text/60"
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const now = useMemo(() => Date.now(), [tick]);

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

    // Per-project, per-category "+N since opened" anchors. Read-only selectors
    // here; writes go through `useGitHubSeenAnchorsStore.getState().recordOpen`
    // synchronously inside each click/imperative handler so the anchor is
    // captured at the precise moment of intent — not after an async refresh
    // races in with a newer count.
    const projectPath = currentProject?.path;
    const issuesAnchor = useGitHubSeenAnchorsStore((s) =>
      projectPath ? s.anchors[projectPath]?.issues : undefined
    );
    const prsAnchor = useGitHubSeenAnchorsStore((s) =>
      projectPath ? s.anchors[projectPath]?.prs : undefined
    );
    const commitsAnchor = useGitHubSeenAnchorsStore((s) =>
      projectPath ? s.anchors[projectPath]?.commits : undefined
    );
    const issuesDeltaLabel = deriveBadgeLabel(issuesAnchor, issueCount, issuesOpen, now);
    const prsDeltaLabel = deriveBadgeLabel(prsAnchor, prCount, prsOpen, now);
    const commitsDeltaLabel = deriveBadgeLabel(commitsAnchor, commitCount, commitsOpen, now);

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
        issueCountRef.current = undefined;
        prCountRef.current = undefined;
        commitCountRef.current = undefined;
        prevLastUpdatedRef.current = null;
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
          // Only anchor on the open transition — toggling closed should not
          // re-record. `issuesOpenRef` is mirrored from state via useEffect
          // and is current at imperative-call time. A null count clears any
          // stale anchor so the next known-count open starts fresh.
          if (!issuesOpenRef.current && currentProject) {
            useGitHubSeenAnchorsStore
              .getState()
              .recordOpen(currentProject.path, "issues", issueCount);
          }
          setIssuesOpen((p) => !p);
        },
        openPrs: () => {
          if (isTokenError) {
            openSettingsForToken();
            return;
          }
          if (!prsOpenRef.current && currentProject) {
            useGitHubSeenAnchorsStore.getState().recordOpen(currentProject.path, "prs", prCount);
          }
          setPrsOpen((p) => !p);
        },
        openCommits: () => {
          if (!commitsOpenRef.current && currentProject) {
            useGitHubSeenAnchorsStore
              .getState()
              .recordOpen(currentProject.path, "commits", commitCount);
          }
          setCommitsOpen((p) => !p);
        },
        stats,
      }),
      [stats, isTokenError, openSettingsForToken, currentProject, issueCount, prCount, commitCount]
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
                // Capture the "+N since opened" anchor synchronously here so a
                // poll that lands during dropdown-opening can't race a newer
                // count past the seen marker. Anchored at click intent, not
                // poll completion. `currentProject` is guaranteed non-null by
                // the early-return above. A null `issueCount` means stats
                // haven't loaded yet — `recordOpen` clears any stale anchor in
                // that case so the next open with a known count starts fresh.
                if (willOpen) {
                  useGitHubSeenAnchorsStore
                    .getState()
                    .recordOpen(currentProject.path, "issues", issueCount);
                }
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
                "h-full gap-2 rounded-none px-3 text-daintree-text transition-opacity hover:bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] hover:text-text-primary",
                isTokenError && "opacity-40",
                !isTokenError && stats?.issueCount === 0 && "opacity-50",
                !isTokenError && freshnessOpacityClass(freshnessLevel),
                issuesOpen &&
                  "bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] text-text-primary ring-1 ring-github-open/20"
              )}
              aria-label={
                isTokenError
                  ? "Configure GitHub token to see issues"
                  : `${issueCount ?? "\u2014"} open issues${
                      issuesDeltaLabel ? ` (${issuesDeltaLabel} since last opened)` : ""
                    }${freshnessSuffix(freshnessLevel, lastUpdated, now)}`
              }
            >
              <CircleDot
                className={cn(
                  "h-4 w-4",
                  isTokenError ? "text-muted-foreground" : "text-github-open"
                )}
              />
              <span
                key={issueAnimKey}
                className={cn(
                  "text-xs font-medium tabular-nums",
                  issueAnimKey > 0 && "animate-badge-bump"
                )}
              >
                {issueCount ?? "\u2014"}
              </span>
              {!isTokenError && issuesDeltaLabel ? (
                <span
                  className="text-[10px] font-medium leading-none text-muted-foreground"
                  aria-hidden="true"
                >
                  {issuesDeltaLabel}
                </span>
              ) : null}
              {!isTokenError ? <FreshnessGlyph level={freshnessLevel} /> : null}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isTokenError
              ? "Configure GitHub token to see issues"
              : freshnessLevel === "fresh"
                ? "Browse GitHub Issues"
                : `${issueCount ?? "\u2014"} open issues${freshnessSuffix(freshnessLevel, lastUpdated, now)}`}
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
                if (willOpen) {
                  useGitHubSeenAnchorsStore
                    .getState()
                    .recordOpen(currentProject.path, "prs", prCount);
                }
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
                "h-full gap-2 rounded-none px-3 text-daintree-text transition-opacity hover:bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] hover:text-text-primary",
                isTokenError && "opacity-40",
                !isTokenError && stats?.prCount === 0 && "opacity-50",
                !isTokenError && freshnessOpacityClass(freshnessLevel),
                prsOpen &&
                  "bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] text-text-primary ring-1 ring-github-merged/20"
              )}
              aria-label={
                isTokenError
                  ? "Configure GitHub token to see pull requests"
                  : `${prCount ?? "\u2014"} open pull requests${
                      prsDeltaLabel ? ` (${prsDeltaLabel} since last opened)` : ""
                    }${freshnessSuffix(freshnessLevel, lastUpdated, now)}`
              }
            >
              <GitPullRequest
                className={cn(
                  "h-4 w-4",
                  isTokenError ? "text-muted-foreground" : "text-github-merged"
                )}
              />
              <span
                key={prAnimKey}
                className={cn(
                  "text-xs font-medium tabular-nums",
                  prAnimKey > 0 && "animate-badge-bump"
                )}
              >
                {prCount ?? "\u2014"}
              </span>
              {!isTokenError && prsDeltaLabel ? (
                <span
                  className="text-[10px] font-medium leading-none text-muted-foreground"
                  aria-hidden="true"
                >
                  {prsDeltaLabel}
                </span>
              ) : null}
              {!isTokenError ? <FreshnessGlyph level={freshnessLevel} /> : null}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isTokenError
              ? "Configure GitHub token to see pull requests"
              : freshnessLevel === "fresh"
                ? "Browse GitHub Pull Requests"
                : `${prCount ?? "\u2014"} open PRs${freshnessSuffix(freshnessLevel, lastUpdated, now)}`}
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
                const willOpen = !commitsOpen;
                setCommitsOpen(willOpen);
                if (willOpen) {
                  useGitHubSeenAnchorsStore
                    .getState()
                    .recordOpen(currentProject.path, "commits", commitCount);
                }
              }}
              className={cn(
                "h-full gap-2 rounded-none px-3 text-daintree-text transition-opacity hover:bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] hover:text-text-primary",
                stats?.commitCount === 0 && "opacity-50",
                freshnessOpacityClass(freshnessLevel),
                commitsOpen &&
                  "bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] text-text-primary ring-1 ring-border-strong"
              )}
              aria-label={`${commitCount ?? "\u2014"} commits${
                commitsDeltaLabel ? ` (${commitsDeltaLabel} since last opened)` : ""
              }${freshnessSuffix(freshnessLevel, lastUpdated, now)}`}
            >
              <GitCommit className="h-4 w-4" />
              <span
                key={commitAnimKey}
                className={cn(
                  "text-xs font-medium tabular-nums",
                  commitAnimKey > 0 && "animate-badge-bump"
                )}
              >
                {commitCount ?? "\u2014"}
              </span>
              {commitsDeltaLabel ? (
                <span
                  className="text-[10px] font-medium leading-none text-muted-foreground"
                  aria-hidden="true"
                >
                  {commitsDeltaLabel}
                </span>
              ) : null}
              <FreshnessGlyph level={freshnessLevel} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {freshnessLevel === "fresh"
              ? "Browse Git Commits"
              : `${commitCount ?? "\u2014"} commits${freshnessSuffix(freshnessLevel, lastUpdated, now)}`}
          </TooltipContent>
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
