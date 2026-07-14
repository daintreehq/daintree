import {
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
import { PRDetectionPausedIndicator } from "./PRDetectionPausedIndicator";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { actionService } from "@/services/ActionService";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useRepositoryStats } from "@/hooks/useRepositoryStats";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import { useBuiltinView } from "@/registry/builtinRendererRegistry";
import { ForgeStatusIndicator, type ForgeStatusIndicatorStatus } from "./ForgeStatusIndicator";
import { forgeClient } from "@/clients/forgeClient";
import { buildCacheKey, getCache, setCache } from "@/lib/forgeResourceCache";
import type { Project } from "@shared/types";
import type { RateLimitDetails } from "@shared/types/forge";
import type { ForgeRepositoryStats } from "@shared/types/ipc/forge";
import type { ForgeStatsDropdownProps } from "./forgeStatsDropdownContract";
import { freshnessSuffix } from "./FreshnessUtils";
import { resolveForgeDisplayCount } from "./forgeStatsCountDisplay";
import {
  formatRateLimitCountdown,
  msUntilNextLabelChange,
  RateLimitDetailsPanel,
} from "./RateLimitDetails";
import { ForgeStatPill } from "./ForgeStatPill";
import { LocalCommitsDropdown } from "./LocalCommitsDropdown";

// Hover-to-prefetch tuning. The prefetch fires immediately on pointerenter
// (mouse only) — no debounce: hovering a toolbar pill is strong click intent,
// so warming the list the moment the cursor lands maximizes the head-start
// before the click. The fly-by cost of firing on every hover is bounded by
// two things: the prefetch is cache-first (`bypassCache: false`, served from
// the main-process 60s list cache with zero GraphQL on a warm slot), and the
// in-flight + freshness guards below collapse repeat hovers. The 10s freshness
// skip dedups against a recent fetch without stacking on the 45s SWR cache TTL.
const PREFETCH_FRESHNESS_MS = 10_000;

// When the user opens a dropdown and its count hasn't been read from the forge
// within this window, fire a click-time count refresh — cache may still be
// valid in the strict TTL sense, but the user opening the dropdown is a strong
// signal that they want fresh-enough data, and 2 minutes is the threshold
// beyond which counts could be visibly out of date. The gate keys off the
// per-count refreshed-at stamp (when the forge was actually asked about that
// count), NOT the probe-re-stamped `lastUpdated` — re-stamped staleness let a
// stale poll count permanently suppress this open-time refresh. Deliberately
// NOT a forced refresh: `force` maps to `bypassCache: true` in main, which
// runs the ~6-point welded `REPO_STATS_AND_PAGE_QUERY` on top of the list
// query the open itself fires — a hidden double-spend on every stale-open
// (#10122 family). The non-forced path is the probe-gated REST count pair
// (often free via 304), and the dropdown's own list revalidate reconciles the
// badge through `onCountUpdate`/`onFreshFetch`, so the heavy query buys
// nothing here.
const OPEN_REFRESH_STALENESS_MS = 2 * 60 * 1000;

// Lifetime of the corner activity chip after the most recent count increase,
// measured in visible time. The chip is a glanceable "something new arrived"
// cue, not a persistent unread-state badge — three minutes is long enough for
// a user to notice it during normal task flow without lingering past the
// moment of relevance. The chip's auto-clear pauses while the page is hidden
// (see the useEffect below) so a chip earned just before a tab/window switch
// doesn't burn its TTL unseen.
const ACTIVITY_CHIP_TTL_MS = 3 * 60 * 1000;

// Each flex-1 pill's share of the 13rem budget (~4.33rem) leaves room for
// about 4 characters of text-xs tabular numerals after the icon + gap + px-2
// chrome (~2.5rem). Counts wider than that (5+ digit commit totals) were
// silently clipped by the container's overflow-hidden; widths past the budget
// grow at 0.55rem per character — a text-xs tabular digit (~0.45rem) plus
// slack.
const PILL_CHAR_BUDGET = 4;
const PILL_EXTRA_CHAR_REM = 0.55;

const pillOverflowChars = (display: number | string | null) =>
  Math.max(0, String(display ?? "—").length - PILL_CHAR_BUDGET);

// Re-exported for external consumers (tests, rate-limit math)
export { msUntilNextLabelChange } from "./RateLimitDetails";

export interface ForgeStatsHandle {
  closeAll: () => void;
  openIssues: () => void;
  openPrs: () => void;
  openCommits: () => void;
  stats: ForgeRepositoryStats | null;
}

interface ForgeStatsToolbarButtonProps {
  currentProject: Project | null;
  "data-toolbar-item"?: string;
}

export const ForgeStatsToolbarButton = memo(
  forwardRef<ForgeStatsHandle, ForgeStatsToolbarButtonProps>(function ForgeStatsToolbarButton(
    { currentProject },
    ref
  ) {
    const {
      stats,
      loading: statsLoading,
      error: statsError,
      errorSeverity,
      isTokenError,
      refresh: refreshStats,
      lastUpdated,
      rateLimitResetAt,
      rateLimitKind,
      freshnessLevel,
    } = useRepositoryStats();

    // Active forge provider for this project — drives the dropdown content
    // slot, display copy, and which segments render. `entry` drops to null
    // live when the owning plugin is disabled, collapsing the issue/PR
    // segments down to the commits-only pill (commit count is local git, not
    // forge data, so it stays useful without any provider).
    const {
      entry: providerEntry,
      providerId,
      loading: providerLoading,
    } = useResolvedForgeProvider(currentProject?.id ?? null);
    const forgeMode = providerEntry !== null && providerId !== null;
    const providerName = providerEntry?.contribution.name ?? "forge";
    const DropdownView = useBuiltinView<ForgeStatsDropdownProps>(
      providerEntry?.contribution.slots?.statsDropdown ?? ""
    );

    // Drives the tooltip aging copy ("updated 3m ago") without per-component
    // intervals — the ticker is shared, paused on hidden tabs, and tears down
    // when no consumers remain. The memo re-captures `Date.now()` on every
    // tick so the freshness suffix advances even between background polls.
    const tick = useGlobalMinuteTicker();
    const now = useMemo(() => {
      void tick;
      return Date.now();
    }, [tick]);

    const commitFreshnessLevel = freshnessLevel === "errored" ? "fresh" : freshnessLevel;

    const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
    const activeWorktree = useWorktreeStore((state) =>
      activeWorktreeId ? state.worktrees.get(activeWorktreeId) : null
    );

    const prCircuitTripped = usePRCircuitBreakerStore((s) => s.tripped);

    const [issuesOpen, setIssuesOpen] = useState(false);
    const [prsOpen, setPrsOpen] = useState(false);
    const [commitsOpen, setCommitsOpen] = useState(false);
    const [statsJustUpdated, setStatsJustUpdated] = useState(false);
    const [rateLimitCountdown, setRateLimitCountdown] = useState<string | null>(null);
    const [rateLimitTooltipOpen, setRateLimitTooltipOpen] = useState(false);
    const [rateLimitDetails, setRateLimitDetails] = useState<RateLimitDetails | null>(null);
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

    // True per-count recency. `lastUpdated` is re-stamped by the main process
    // when the activity probe confirms "nothing changed" and re-serves cached
    // counts; the refreshed-at stamps only advance when the forge was actually
    // asked about that count. The badge arbitration and the dropdown-open
    // force refresh below must use the honest signal — re-stamped staleness
    // was how a stale poll count kept outranking the dropdown's real total
    // and rolled the badge back on every poll. Per-count because a PR list
    // write-back says nothing about the issue count (and vice versa). Stale
    // disk fallbacks carry a re-stamped `lastUpdated` with no honest stamp —
    // treat those as unknown recency (null) rather than fresh, so a direct
    // list observation always outranks them and an open retries the fetch.
    const statsRecencyFallback = stats?.stale ? null : lastUpdated;
    const issueCountRefreshedAt = stats?.issueCountRefreshedAt ?? statsRecencyFallback;
    const prCountRefreshedAt = stats?.prCountRefreshedAt ?? statsRecencyFallback;

    // List-loaded counts reported by each dropdown's `onCountUpdate`. These
    // track what the dropdown actually lists (loaded first-page length +
    // whether more pages exist) so the badge can bind to the visible count
    // rather than the stats query's `totalCount`, which can be higher than
    // the loaded page (issue #9693). `null` until the dropdown first loads,
    // at which point the badge falls back to the stats count.
    const [issueListCount, setIssueListCount] = useState<number | null>(null);
    const [issueListHasMore, setIssueListHasMore] = useState(false);
    const [prListCount, setPrListCount] = useState<number | null>(null);
    const [prListHasMore, setPrListHasMore] = useState(false);

    // Epoch-ms timestamp of the most recent `onCountUpdate` for each kind, used
    // to arbitrate recency against the stats poll's `lastUpdated` (issue #9741).
    // A ref, not state — the timestamp only feeds the display derivation below,
    // which already re-renders whenever the count state or `lastUpdated` change,
    // so it needs no re-render of its own. Cleared on project switch alongside
    // the count state so the previous project's timestamp can't suppress the
    // new project's first list load.
    const issueListTimestampRef = useRef<number | null>(null);
    const prListTimestampRef = useRef<number | null>(null);

    const handleIssueListCountUpdate = useCallback((count: number, hasMore: boolean) => {
      issueListTimestampRef.current = Date.now();
      setIssueListCount(count);
      setIssueListHasMore(hasMore);
    }, []);
    const handlePrListCountUpdate = useCallback((count: number, hasMore: boolean) => {
      prListTimestampRef.current = Date.now();
      setPrListCount(count);
      setPrListHasMore(hasMore);
    }, []);

    // Clear the list-loaded counts and their recency timestamps whenever the
    // project changes (issue #9741). Keyed directly on the project path rather
    // than riding on the `lastUpdated == null` reset effect below: on a fast
    // project switch the stats poll flips `statsLoading` true in the same batch
    // that nulls `lastUpdated`, and that effect early-returns behind its
    // `statsLoading` guard — leaving the previous project's counts to win the
    // recency arbitration until the new project's first poll lands. A
    // project-scoped effect clears them deterministically on every switch. Runs
    // once on mount as a no-op (state already null).
    useEffect(() => {
      setIssueListCount(null);
      setIssueListHasMore(false);
      setPrListCount(null);
      setPrListHasMore(false);
      issueListTimestampRef.current = null;
      prListTimestampRef.current = null;
    }, [currentProject?.path]);

    // Badge display value: whichever of the list-loaded count (suffixed with
    // `+` when approximate, e.g. `20+`) and the stats `totalCount` was updated
    // most recently (issue #9741). Before #9741 the list count won
    // unconditionally once set, freezing the badge until the dropdown reopened
    // even when a fresher poll had landed. Stays separate from the numeric
    // `issueCount` / `prCount` so the digit-pulse delta detection keeps
    // comparing raw totals. Reads the timestamp refs during render (a ref read
    // in render is fine — they're only written from event callbacks).
    const issueDisplayCount: number | string | null = resolveForgeDisplayCount(
      issueCount,
      issueCountRefreshedAt,
      issueListCount,
      issueListHasMore,
      issueListTimestampRef.current
    );
    const prDisplayCount: number | string | null = resolveForgeDisplayCount(
      prCount,
      prCountRefreshedAt,
      prListCount,
      prListHasMore,
      prListTimestampRef.current
    );

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

    // The pill row holds three equal flex-1 stat pills budgeted to a constant
    // 13rem. Each active trailing indicator (rate-limit clock, PR-detection-
    // paused glyph) adds a fixed 1.75rem (w-7) slot plus its 1px divider, so
    // the container grows by exactly that much and the pills keep their
    // original width. The previous fixed w-[13rem] + overflow-hidden silently
    // clipped any indicator off the right edge — and a clipped element can't
    // receive pointer events, which is why the rate-limit details tooltip
    // stopped opening on hover.
    const trailingIndicatorCount = (rateLimitActive ? 1 : 0) + (prCircuitTripped ? 1 : 0);
    // Commits-only mode keeps a single pill at its usual one-third share so
    // the segment doesn't stretch to the full three-pill budget. When the
    // widest displayed count exceeds the per-pill character budget, every
    // pill share grows by the same overflow so the pills stay equal-width
    // and nothing clips.
    const pillCount = forgeMode ? 3 : 1;
    const maxOverflowChars = Math.max(
      forgeMode ? pillOverflowChars(issueDisplayCount ?? issueCount) : 0,
      forgeMode ? pillOverflowChars(prDisplayCount ?? prCount) : 0,
      pillOverflowChars(commitCount)
    );
    const statsBaseWidthRem =
      (forgeMode ? 13 : 13 / 3) + pillCount * maxOverflowChars * PILL_EXTRA_CHAR_REM;
    const statsContainerWidth = `calc(${statsBaseWidthRem}rem + ${trailingIndicatorCount * 1.75}rem + ${trailingIndicatorCount}px)`;

    // Fetch the per-bucket breakdown when the tooltip opens, and tick a 1Hz
    // clock so the per-bucket countdowns animate locally without re-fetching.
    // Provider rate-limit endpoints are quota-free by convention, so opening
    // the tooltip doesn't compete with the very limit it's reporting on.
    const projectPath = currentProject?.path ?? null;
    useEffect(() => {
      if (!rateLimitActive || !rateLimitTooltipOpen || !projectPath) return;
      let cancelled = false;
      void forgeClient.getRateLimitDetails(projectPath).then((details) => {
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
    }, [rateLimitActive, rateLimitTooltipOpen, projectPath]);

    // Drop stale per-bucket data once the limit clears so the next time the
    // tooltip opens we don't flash old numbers before the fresh fetch lands.
    useEffect(() => {
      if (!rateLimitActive) setRateLimitDetails(null);
    }, [rateLimitActive]);

    const issuesButtonRef = useRef<HTMLButtonElement>(null);
    const prsButtonRef = useRef<HTMLButtonElement>(null);
    const commitsButtonRef = useRef<HTMLButtonElement>(null);

    const issuesPrefetchInFlightRef = useRef(false);
    const prsPrefetchInFlightRef = useRef(false);

    // Wall-clock anchor for the moment the document went hidden, per chip.
    // Used by the auto-clear effects below to shift the chip's `pulseAt`
    // forward by the hidden duration on restore, so the TTL measures
    // *visible* time rather than wall-clock time.
    const issuesHiddenAtRef = useRef<number | null>(null);
    const prsHiddenAtRef = useRef<number | null>(null);

    // Mirror open state into refs so `prefetchResourceList` can re-check the
    // live open state at fire time without widening its dependency array. If a
    // click opens the dropdown in the same tick as the hover, the mounted list
    // view starts its own fetch — this guard stops the hover prefetch from
    // racing a duplicate request that could overwrite fresh mount-fetch data.
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
    // increase, measured in *visible* time — a chip earned just before the
    // user switches away shouldn't burn its TTL unseen. On hide, we record
    // the wall-clock anchor; on restore, we shift `pulseAt` forward by the
    // hidden duration so the next `remaining` math reflects elapsed visible
    // time only. The listener is subscribed before sampling `document.hidden`
    // so a hide that lands between effect-run and first tick is caught, and
    // the effect pauses synchronously when it commits during a hidden window
    // (e.g. a `setIssuesPulseAt` shift's re-render landing while hidden).
    useEffect(() => {
      if (issuesPulseAt === null) {
        // Clear the ref defensively so a future pulse that arrives while
        // hidden starts from a clean anchor, not a leftover from a prior
        // chip's hide cycle.
        issuesHiddenAtRef.current = null;
        return;
      }
      let timeoutId: number | null = null;

      const pauseForHidden = () => {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }
        issuesHiddenAtRef.current = Date.now();
      };

      const tick = () => {
        timeoutId = null;
        if (document.hidden) {
          // Race guard: a timer that fires while the document is in the
          // middle of going hidden shouldn't make a state decision — the
          // visibilitychange handler owns that path.
          return;
        }
        const remaining = ACTIVITY_CHIP_TTL_MS - (Date.now() - issuesPulseAt);
        if (remaining <= 0) {
          setIssuesPulseAt(null);
          return;
        }
        timeoutId = window.setTimeout(tick, remaining);
      };

      const onVisibility = () => {
        if (document.hidden) {
          pauseForHidden();
          return;
        }
        // Document went visible. If we have a hidden anchor, shift pulseAt
        // forward by the hidden duration; the resulting state change will
        // re-run this effect with a fresh tick. Otherwise just re-arm.
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (issuesHiddenAtRef.current !== null) {
          const hiddenMs = Date.now() - issuesHiddenAtRef.current;
          issuesHiddenAtRef.current = null;
          if (hiddenMs > 0) {
            setIssuesPulseAt((prev) => (prev === null ? null : prev + hiddenMs));
            return;
          }
        }
        tick();
      };

      // Subscribe first, then sample. A hide that lands between
      // addEventListener and the first tick() will be caught by the
      // listener; if the document is already hidden when the effect runs,
      // pause immediately so the restore handler has an anchor to shift.
      // The cleanup at the bottom runs unconditionally so the listener
      // is always paired with a removeEventListener on unmount/dep change.
      document.addEventListener("visibilitychange", onVisibility);
      if (document.hidden) {
        pauseForHidden();
      } else {
        tick();
      }

      return () => {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }
        document.removeEventListener("visibilitychange", onVisibility);
      };
    }, [issuesPulseAt]);

    useEffect(() => {
      if (prsPulseAt === null) {
        prsHiddenAtRef.current = null;
        return;
      }
      let timeoutId: number | null = null;

      const pauseForHidden = () => {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }
        prsHiddenAtRef.current = Date.now();
      };

      const tick = () => {
        timeoutId = null;
        if (document.hidden) {
          return;
        }
        const remaining = ACTIVITY_CHIP_TTL_MS - (Date.now() - prsPulseAt);
        if (remaining <= 0) {
          setPrsPulseAt(null);
          return;
        }
        timeoutId = window.setTimeout(tick, remaining);
      };

      const onVisibility = () => {
        if (document.hidden) {
          pauseForHidden();
          return;
        }
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (prsHiddenAtRef.current !== null) {
          const hiddenMs = Date.now() - prsHiddenAtRef.current;
          prsHiddenAtRef.current = null;
          if (hiddenMs > 0) {
            setPrsPulseAt((prev) => (prev === null ? null : prev + hiddenMs));
            return;
          }
        }
        tick();
      };

      document.addEventListener("visibilitychange", onVisibility);
      if (document.hidden) {
        pauseForHidden();
      } else {
        tick();
      }

      return () => {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }
        document.removeEventListener("visibilitychange", onVisibility);
      };
    }, [prsPulseAt]);

    // Wired to the dropdown view's `onFreshFetch` callback. When the
    // dropdown's SWR revalidation lands fresh first-page data, the provider
    // has already written the new total count to its stats cache. Calling
    // `refreshStats()` (no force) reads that hot cache in a single IPC
    // round-trip — no provider network call — and updates the toolbar count
    // badge so the dropdown's count and the badge converge in the same user
    // interaction.
    const handleListFreshFetch = useCallback(() => {
      void refreshStats();
    }, [refreshStats]);

    const prefetchResourceList = useCallback(
      (type: "issue" | "pr") => {
        if (!currentProject || isTokenError || rateLimitActive) return;
        // Open-state race guard: if a click opened the dropdown in the same
        // tick as this hover, re-check here so the prefetch doesn't fire a
        // duplicate request alongside the dropdown's own mount fetch.
        const isOpenRef = type === "issue" ? issuesOpenRef : prsOpenRef;
        if (isOpenRef.current) return;

        const inFlightRef = type === "issue" ? issuesPrefetchInFlightRef : prsPrefetchInFlightRef;
        if (inFlightRef.current) return;

        // The host doesn't know the plugin's active filter — prime the
        // default open/created slot, which is the slot the background poll
        // pushes prime and the one the dropdown opens on by default.
        const cacheKey = buildCacheKey(currentProject.path, type, "open", "created");

        const cached = getCache(cacheKey);
        // A `stale` entry is the one case a recent timestamp doesn't vouch for:
        // an optimistic assignee patch restamps it (#11087) and the count poll
        // marks diverged rows — both need the warm-up the freshness shortcut
        // would skip, leaving the fetch on the click path.
        if (cached && !cached.stale && Date.now() - cached.timestamp < PREFETCH_FRESHNESS_MS)
          return;

        // Hover prefetch primes the list cache silently. The count badge stays
        // fresh via the 30s background poll and the click-time refresh —
        // refreshing stats here would flicker the toolbar status indicator.
        inFlightRef.current = true;
        const startedAt = Date.now();
        // Cache-first: a warm main-process list cache (60s TTL) serves this
        // hover with zero GraphQL; only a cold slot spends a query — the same
        // query the click would have made anyway. This is what makes firing on
        // every hover quota-safe. `bypassCache: true` stays reserved for
        // explicit intent (dropdown open / manual refresh) — and for a `stale`
        // entry, which needs it for correctness, not freshness: a cache-first
        // read joins any list query already in flight (the main-process
        // singleflight only skips the join when bypassing), so a hover landing
        // right after an assign could be handed the page that request fetched
        // BEFORE the assign — and the write below, being newer than the
        // optimistic patch, would commit those rows and clear `stale`. The
        // extra query is not extra spend: an assign invalidates the backend's
        // issue pages, so a cache-first read would have missed and queried too.
        const bypassCache = cached?.stale === true;
        const fetchOptions = {
          state: "open" as const,
          sort: "created",
          bypassCache,
        };
        const request =
          type === "issue"
            ? forgeClient.listIssues(currentProject.path, fetchOptions)
            : forgeClient.listPRs(currentProject.path, fetchOptions);
        void request
          .then((result) => {
            // Ownership guard: the dropdown may have opened mid-flight and
            // committed a fresher page (its own bypass revalidate). A slower
            // hover response must not clobber it — `timestamp` is the write
            // time of the competing entry, so anything written after this
            // request started wins.
            const existing = getCache(cacheKey);
            if (existing && existing.timestamp > startedAt) return;
            const now = Date.now();
            setCache(cacheKey, {
              items: result.items,
              nextCursor: result.nextCursor,
              hasMore: result.hasMore,
              timestamp: now,
              // Deliberately NO `freshBypassAt`: a cache-first prefetch may have
              // been served from the main-process list cache, so it must not arm
              // the SWR hook's skip-revalidate window (reserved for real
              // `bypassCache: true` fetches). The dropdown still opens instantly
              // on these warmed rows, then runs its normal cheap, cache-honoring
              // open-time revalidate.
              // The prefetch always targets the `open` slot (see `cacheKey`),
              // so the count fingerprint arms the count-as-cache-buster.
              ...(result.totalCount != null ? { countAtWrite: result.totalCount } : {}),
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
        // No dropdown view (provider contributes no statsDropdown slot) means
        // no consumer for the warmed list — a click opens the forge website
        // instead, so prefetching would be pure wasted quota.
        if (!DropdownView) return;
        const isOpen = type === "issue" ? issuesOpen : prsOpen;
        if (isOpen) return;
        // Fire immediately — no debounce. The in-flight + freshness guards in
        // `prefetchResourceList` collapse repeat and fly-by hovers, and the
        // cache-first fetch keeps a stray hover cheap, so warming the moment the
        // cursor lands buys the maximum head-start before the click.
        prefetchResourceList(type);
      },
      [DropdownView, issuesOpen, prsOpen, prefetchResourceList]
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
        // List-loaded counts and their recency timestamps are reset by the
        // dedicated project-path effect below — not here — because a fast
        // project switch can leave `statsLoading` true while `lastUpdated` is
        // null, and this branch sits behind the `statsLoading` guard above
        // (issue #9741).
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

    const getForgeIndicatorStatus = useCallback((): ForgeStatusIndicatorStatus => {
      if (statsLoading) return "loading";
      // The error stripe is reserved for failure runs the quick retries didn't
      // heal (`persistent`). A transient blip keeps the preserved counts and
      // stays quiet — the freshness suffix in the segment tooltips already
      // reports degraded data. An active rate-limit block has its own clock
      // indicator + countdown tooltip, so the stripe stays off until the block
      // lifts and the resume refresh also keeps failing.
      if (errorSeverity === "persistent" && !isTokenError && !rateLimitActive) return "error";
      if (statsJustUpdated) return "success";
      return "idle";
    }, [statsLoading, errorSeverity, isTokenError, rateLimitActive, statsJustUpdated]);

    const handleForgeStatusTransitionEnd = useCallback(() => {
      setStatsJustUpdated(false);
    }, []);

    const openSettingsForToken = useCallback(() => {
      if (!providerId) return;
      void actionService.dispatch(
        "app.settings.openTab",
        { tab: "code-forge", subtab: providerId },
        { source: "user" }
      );
    }, [providerId]);

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
          // No dropdown view for this provider — route to the forge website,
          // mirroring the pill's own click handling.
          if (!DropdownView) {
            void actionService.dispatch(
              "forge.openIssues",
              { projectPath: currentProject?.path },
              { source: "user" }
            );
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
          if (!DropdownView) {
            void actionService.dispatch(
              "forge.openPRs",
              { projectPath: currentProject?.path },
              { source: "user" }
            );
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
      [stats, isTokenError, openSettingsForToken, DropdownView, currentProject?.path]
    );

    // No project: nothing to count. While provider resolution is in flight,
    // render nothing rather than flashing the commits-only shape for a repo
    // that is about to resolve a forge provider. Once settled, a repo with no
    // provider keeps the commits-only pill — issue/PR segments are forge data
    // and render only in forgeMode.
    if (!currentProject || providerLoading) return null;

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="toolbar-stats app-no-drag relative mr-2 flex h-8 shrink-0 items-center overflow-hidden rounded-[var(--toolbar-pill-radius,0.5rem)] border divide-x divide-[var(--toolbar-stats-divider,var(--theme-border-subtle))] transition-[width] duration-150 ease-out"
            style={{
              width: statsContainerWidth,
              ["--toolbar-stats-divider" as string]:
                "var(--toolbar-stats-divider,var(--theme-border-subtle))",
            }}
          >
            {forgeMode ? (
              <ForgeStatPill
                buttonRef={issuesButtonRef}
                open={issuesOpen}
                count={issueCount}
                displayCount={issueDisplayCount}
                animKey={issueAnimKey}
                testId="forge-stat-pill-issues"
                ariaLabel={
                  isTokenError
                    ? `Configure ${providerName} token to see issues`
                    : `${issueDisplayCount ?? "—"} open issues${
                        showIssuesChip ? " (new since last view)" : ""
                      }${freshnessSuffix(freshnessLevel, lastUpdated, now)}`
                }
                tooltipContent={
                  isTokenError
                    ? `Configure ${providerName} token to see issues`
                    : freshnessLevel === "fresh"
                      ? `Browse ${providerName} issues`
                      : `${issueDisplayCount ?? "—"} open issues${freshnessSuffix(freshnessLevel, lastUpdated, now)}`
                }
                icon={CircleDot}
                iconClassName={isTokenError ? "text-muted-foreground" : "text-pr-open"}
                openRingClassName="ring-1 ring-pr-open/20"
                className={cn(
                  isTokenError && "opacity-40",
                  !isTokenError && stats?.issueCount === 0 && "opacity-50"
                )}
                dropdownContent={
                  DropdownView && providerId ? (
                    <DropdownView
                      kind="issues"
                      projectPath={currentProject.path}
                      providerId={providerId}
                      open={issuesOpen}
                      initialCount={stats?.issueCount}
                      onClose={() => {
                        setIssuesOpen(false);
                        issuesButtonRef.current?.focus();
                      }}
                      onFreshFetch={handleListFreshFetch}
                      onCountUpdate={handleIssueListCountUpdate}
                    />
                  ) : null
                }
                persistThroughChildOverlays
                keepMounted
                onClick={() => {
                  setPrsOpen(false);
                  setCommitsOpen(false);
                  if (isTokenError) {
                    setIssuesOpen(false);
                    openSettingsForToken();
                    return;
                  }
                  // Provider contributes no dropdown view — route the click to
                  // the forge's own issues page instead of toggling an empty
                  // popover shell.
                  if (!DropdownView) {
                    setIssuesOpen(false);
                    void actionService.dispatch(
                      "forge.openIssues",
                      { projectPath: currentProject.path },
                      { source: "user" }
                    );
                    return;
                  }
                  const willOpen = !issuesOpen;
                  setIssuesOpen(willOpen);
                  if (willOpen) setIssuesPulseAt(null);
                  if (
                    willOpen &&
                    (issueCountRefreshedAt == null ||
                      Date.now() - issueCountRefreshedAt > OPEN_REFRESH_STALENESS_MS)
                  ) {
                    refreshStats();
                  }
                }}
                onOpenChange={(open) => {
                  setIssuesOpen(open);
                  if (!open) {
                    issuesButtonRef.current?.focus();
                  }
                }}
                onPointerEnter={(e) => handlePrefetchPointerEnter("issue", e)}
                activityChip={
                  <span
                    aria-hidden="true"
                    data-visible={showIssuesChip}
                    className="toolbar-badge-chip bg-pr-open pointer-events-none absolute right-0 top-0 h-2 w-2"
                    style={{ clipPath: "polygon(0 0, 100% 0, 100% 100%)" }}
                  />
                }
              />
            ) : null}
            {forgeMode ? (
              <ForgeStatPill
                buttonRef={prsButtonRef}
                open={prsOpen}
                count={prCount}
                displayCount={prDisplayCount}
                animKey={prAnimKey}
                testId="forge-stat-pill-prs"
                ariaLabel={
                  isTokenError
                    ? `Configure ${providerName} token to see pull requests`
                    : `${prDisplayCount ?? "—"} open pull requests${
                        showPrsChip ? " (new since last view)" : ""
                      }${freshnessSuffix(freshnessLevel, lastUpdated, now)}`
                }
                tooltipContent={
                  isTokenError
                    ? `Configure ${providerName} token to see pull requests`
                    : freshnessLevel === "fresh"
                      ? `Browse ${providerName} pull requests`
                      : `${prDisplayCount ?? "—"} open PRs${freshnessSuffix(freshnessLevel, lastUpdated, now)}`
                }
                icon={GitPullRequest}
                iconClassName={isTokenError ? "text-muted-foreground" : "text-pr-merged"}
                openRingClassName="ring-1 ring-pr-merged/20"
                className={cn(
                  isTokenError && "opacity-40",
                  !isTokenError && stats?.prCount === 0 && "opacity-50"
                )}
                dropdownContent={
                  DropdownView && providerId ? (
                    <DropdownView
                      kind="prs"
                      projectPath={currentProject.path}
                      providerId={providerId}
                      open={prsOpen}
                      initialCount={stats?.prCount}
                      onClose={() => {
                        setPrsOpen(false);
                        prsButtonRef.current?.focus();
                      }}
                      onFreshFetch={handleListFreshFetch}
                      onCountUpdate={handlePrListCountUpdate}
                    />
                  ) : null
                }
                keepMounted
                onClick={() => {
                  setIssuesOpen(false);
                  setCommitsOpen(false);
                  if (isTokenError) {
                    setPrsOpen(false);
                    openSettingsForToken();
                    return;
                  }
                  // Same no-dropdown routing as the issues pill.
                  if (!DropdownView) {
                    setPrsOpen(false);
                    void actionService.dispatch(
                      "forge.openPRs",
                      { projectPath: currentProject.path },
                      { source: "user" }
                    );
                    return;
                  }
                  const willOpen = !prsOpen;
                  setPrsOpen(willOpen);
                  if (willOpen) setPrsPulseAt(null);
                  if (
                    willOpen &&
                    (prCountRefreshedAt == null ||
                      Date.now() - prCountRefreshedAt > OPEN_REFRESH_STALENESS_MS)
                  ) {
                    refreshStats();
                  }
                }}
                onOpenChange={(open) => {
                  setPrsOpen(open);
                  if (!open) {
                    prsButtonRef.current?.focus();
                  }
                }}
                onPointerEnter={(e) => handlePrefetchPointerEnter("pr", e)}
                activityChip={
                  <span
                    aria-hidden="true"
                    data-visible={showPrsChip}
                    className="toolbar-badge-chip bg-pr-merged pointer-events-none absolute right-0 top-0 h-2 w-2"
                    style={{ clipPath: "polygon(0 0, 100% 0, 100% 100%)" }}
                  />
                }
              />
            ) : null}
            <ForgeStatPill
              buttonRef={commitsButtonRef}
              open={commitsOpen}
              count={commitCount}
              animKey={commitAnimKey}
              testId="forge-stat-pill-commits"
              ariaLabel={`${commitCount ?? "—"} commits${freshnessSuffix(commitFreshnessLevel, lastUpdated, now)}`}
              tooltipContent={
                commitFreshnessLevel === "fresh"
                  ? "Browse git commits"
                  : `${commitCount ?? "—"} commits${freshnessSuffix(commitFreshnessLevel, lastUpdated, now)}`
              }
              icon={GitCommit}
              openRingClassName="ring-1 ring-border-strong"
              className={cn(stats?.commitCount === 0 && "opacity-50")}
              dropdownContent={
                DropdownView && providerId ? (
                  <DropdownView
                    kind="commits"
                    projectPath={currentProject.path}
                    providerId={providerId}
                    open={commitsOpen}
                    worktreePath={activeWorktree?.path}
                    branch={activeWorktree?.branch}
                    initialCount={stats?.commitCount}
                    onClose={() => {
                      setCommitsOpen(false);
                      commitsButtonRef.current?.focus();
                    }}
                  />
                ) : (
                  // Commit history is local git data, so commits-only mode
                  // (no forge provider) still gets a browsable dropdown
                  // (issue #10414).
                  <LocalCommitsDropdown
                    cwd={activeWorktree?.path ?? currentProject.path}
                    branch={activeWorktree?.branch}
                    open={commitsOpen}
                    initialCount={stats?.commitCount}
                    onClose={() => {
                      setCommitsOpen(false);
                      commitsButtonRef.current?.focus();
                    }}
                  />
                )
              }
              onClick={() => {
                setIssuesOpen(false);
                setPrsOpen(false);
                setCommitsOpen((p) => !p);
              }}
              onOpenChange={(open) => {
                setCommitsOpen(open);
                if (!open) commitsButtonRef.current?.focus();
              }}
            />
            <ForgeStatusIndicator
              status={getForgeIndicatorStatus()}
              error={statsError ?? undefined}
              onTransitionEnd={handleForgeStatusTransitionEnd}
            />
            {rateLimitActive ? (
              <Tooltip
                open={rateLimitTooltipOpen}
                onOpenChange={setRateLimitTooltipOpen}
                autoDismiss={false}
              >
                <TooltipTrigger asChild>
                  <div
                    role="status"
                    aria-live="polite"
                    aria-label={
                      rateLimitKind === "secondary"
                        ? `${providerName} secondary rate limit — resuming in ${rateLimitCountdown}`
                        : `${providerName} rate limit — resets in ${rateLimitCountdown}`
                    }
                    className="flex h-full w-7 shrink-0 items-center justify-center text-muted-foreground"
                  >
                    <Clock className="h-3.5 w-3.5 text-text-muted" aria-hidden />
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
            <PRDetectionPausedIndicator />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
          <ToolbarContextMenuItems buttonId="forge-stats" side="right" />
        </ContextMenuContent>
      </ContextMenu>
    );
  })
);
