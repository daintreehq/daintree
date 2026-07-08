import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { ForgeRateLimitKind, ForgeRepositoryStats } from "@shared/types/ipc/forge";
import { projectClient } from "@/clients";
import { forgeClient } from "@/clients/forgeClient";
import { isTokenRelatedError } from "@/lib/forgeErrors";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { buildCacheKey, getCache, markCountStale, setCache } from "@/lib/forgeResourceCache";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import { usePollingLifecycle } from "@/hooks/usePollingLifecycle";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import { useProjectStore } from "@/store/projectStore";
import { useSystemWakeStore } from "@/store/systemWakeStore";
import {
  useForgeProviderHealthStore,
  DEFAULT_PROVIDER_HEALTH,
} from "@/store/forgeProviderHealthStore";

function isValidPagePayload(page: unknown): page is {
  items: unknown[];
  endCursor: string | null;
  hasNextPage: boolean;
} {
  if (!page || typeof page !== "object") return false;
  const p = page as Record<string, unknown>;
  return Array.isArray(p.items) && (typeof p.endCursor === "string" || p.endCursor === null);
}

const ACTIVE_POLL_INTERVAL = 30 * 1000;
const IDLE_POLL_INTERVAL = 5 * 60 * 1000;

// Graduated error retry replacing the old flat 2-minute backoff: the first
// failure retries quickly so a one-off blip (transient 5xx, momentary
// offline) heals before the persistent-error threshold below is reached,
// doubling toward the old ceiling for a failure that keeps failing.
const ERROR_BACKOFF_BASE_INTERVAL = 30 * 1000;
const ERROR_BACKOFF_MAX_INTERVAL = 2 * 60 * 1000;

// Add a small buffer to the reset timestamp to avoid scheduling a poll at the
// exact instant the provider releases the quota — paired with the provider's
// own buffer, this keeps the next attempt safely past reset even under clock
// skew.
const RATE_LIMIT_RESUME_BUFFER_MS = 2_000;

// Freshness tier thresholds keyed off the active poll cadence
// (`ACTIVE_POLL_INTERVAL` = 30s). 90s is 3× the active poll — long enough that
// a single missed poll does not flip the badge, short enough that a paused or
// failing poll surfaces visibly. 300s sits inside the idle-poll window so a
// backgrounded app reaches `aging` before its next scheduled poll.
export const FRESH_THRESHOLD_MS = 90_000;
export const AGING_THRESHOLD_MS = 300_000;

// Error-severity thresholds. A single failed poll is not a signal — the
// toolbar keeps showing the preserved counts and the quick retry above gets a
// chance to heal it silently. A failure run escalates to `persistent` once
// this many consecutive polls have failed (the quick retries also failed) or
// once the run has gone unbroken this long (covers schedules where retries
// are sparse, e.g. a rate-limit block that parks the next poll at its reset
// time — if the resume attempt after the wait also fails, the run's age
// escalates it rather than waiting out three more retries).
export const PERSISTENT_ERROR_FAILURES = 3;
export const PERSISTENT_ERROR_MS = AGING_THRESHOLD_MS;

/**
 * Severity of the current error state, driving how loudly the UI reports it.
 *
 * - `transient`: a recent failure that quick retries may still heal; callers
 *   should stay quiet (the preserved counts remain visible and the freshness
 *   tier already communicates degraded data).
 * - `persistent`: the failure survived retries (see the thresholds above) or
 *   there is no baseline data to show at all — the alarm affordance is
 *   warranted.
 */
export type RepositoryStatsErrorSeverity = "transient" | "persistent";

// Switch-back reuse cache (issue #10761). Keyed by project path, this holds the
// last genuinely-fresh stats result per project so a rapid switch back to a
// recently-loaded project restores its counts immediately instead of clearing
// to a skeleton and forcing a full refetch. Module-level so it survives the
// hook's per-switch state resets while staying scoped to this `WebContentsView`'s
// isolated V8 context. Entries are evicted once they age past
// `AGING_THRESHOLD_MS` (no longer reusable) and capped to bound growth across a
// session that opens many projects. Only fresh successful results are stored —
// stale/errored polls and disk bootstrap snapshots are never cached here, so a
// switch-back never resurrects a previous error.
interface SwitchBackCacheEntry {
  stats: ForgeRepositoryStats;
  lastUpdated: number;
  providerId: string | null;
}

const MAX_SWITCHBACK_CACHE_SIZE = 20;
const switchBackStatsCache = new Map<string, SwitchBackCacheEntry>();

/** Test-only: clear the module-level switch-back cache between cases. */
export function _resetSwitchBackCacheForTests(): void {
  switchBackStatsCache.clear();
}

/**
 * Per-pill freshness tier driving the toolbar's visual encoding. Replaces the
 * old binary `isStale` so a 30-second-old poll, a disk-cache cold start, and a
 * full network failure no longer share one tint.
 *
 * - `fresh`: poll completed within {@link FRESH_THRESHOLD_MS}
 * - `aging`: poll older than {@link FRESH_THRESHOLD_MS} but still in-session;
 *   typically means the active poll is overdue or the app was backgrounded
 * - `stale-disk`: backend served disk-cached data (token absent / rate-limited
 *   / offline) but no upstream API error string was attached
 * - `errored`: backend served disk data with an error string, or the renderer
 *   fetch threw and no stats are available
 */
export type FreshnessLevel = "fresh" | "aging" | "stale-disk" | "errored";

export interface UseRepositoryStatsReturn {
  stats: ForgeRepositoryStats | null;
  loading: boolean;
  // True while a refetch is in flight regardless of whether stats are already
  // available. Distinct from `loading`, which narrows to the first-fetch
  // (no-data-yet) case so background revalidations don't flip skeletons or
  // loading indicators back on top of stale-but-visible data.
  isValidating: boolean;
  error: string | null;
  // Null when there is no error. Distinguishes a blip mid-heal (`transient`)
  // from a failure run that retries didn't fix (`persistent`) so alarm UI can
  // gate on the latter only.
  errorSeverity: RepositoryStatsErrorSeverity | null;
  isTokenError: boolean;
  isStale: boolean;
  lastUpdated: number | null;
  rateLimitResetAt: number | null;
  rateLimitKind: ForgeRateLimitKind | null;
  freshnessLevel: FreshnessLevel;
  refresh: (options?: { force?: boolean }) => Promise<void>;
}

/**
 * @example
 * ```tsx
 * function Toolbar() {
 *   const { stats, loading, error, refresh } = useRepositoryStats();
 *
 *   if (loading && !stats) return <LoadingSpinner />;
 *   if (error && !stats) return <ErrorMessage error={error} onRetry={refresh} />;
 *
 *   return (
 *     <div>
 *       <StatsBadge label="Commits" count={stats?.commitCount ?? 0} />
 *       <StatsBadge label="Issues" count={stats?.issueCount ?? 0} />
 *       <StatsBadge label="PRs" count={stats?.prCount ?? 0} />
 *     </div>
 *   );
 * }
 * ```
 */
export function useRepositoryStats(): UseRepositoryStatsReturn {
  const [stats, setStats] = useState<ForgeRepositoryStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [rateLimitResetAt, setRateLimitResetAt] = useState<number | null>(null);
  const [rateLimitKind, setRateLimitKind] = useState<ForgeRateLimitKind | null>(null);
  const rateLimitResetAtRef = useRef<number | null>(null);
  // Mirrors the `lastUpdated` state for synchronous reads from event-handler
  // closures (push subscribers). Used to skip stale stat pushes whose
  // `fetchedAt` is older than what we've already applied.
  const lastUpdatedRef = useRef<number | null>(null);
  // Adaptive visible-poll cadence (ms) suggested by the provider's activity
  // probe (issue #9741): ~60s while changes are landing, growing toward ~5min
  // on an idle repo. Read synchronously by `calculateNextInterval` when the
  // document is visible; `null` falls back to the fixed active poll.
  const nextPollIntervalRef = useRef<number | null>(null);

  // Tracks whether any result (success, error, or stale) has already been
  // applied to state. Set to true by applyStatsResult on first write, reset
  // to false on project switch. Prevents the cold-start hydration from
  // overwriting a network fetch result (including errors) that landed first.
  const hasAppliedResultRef = useRef(false);

  // Preserve last known non-zero counts to prevent empty state flash during refresh
  const lastKnownCountsRef = useRef<{
    issueCount: number | null;
    prCount: number | null;
  }>({ issueCount: null, prCount: null });

  const mountedRef = useRef(true);
  const lastErrorRef = useRef<string | null>(null);

  // Unbroken failure-run tracking behind `errorSeverity`. `consecutiveFailures`
  // counts applied failures since the last success; `errorSince` anchors the
  // run's start so severity can escalate on age alone when retries are sparse.
  // The ref mirrors the counter for synchronous reads in
  // `calculateNextInterval` (graduated backoff).
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [errorSince, setErrorSince] = useState<number | null>(null);
  const consecutiveFailuresRef = useRef(0);

  const recordPollFailure = useCallback(() => {
    consecutiveFailuresRef.current += 1;
    setConsecutiveFailures(consecutiveFailuresRef.current);
    setErrorSince((prev) => prev ?? Date.now());
  }, []);

  const resetPollFailures = useCallback(() => {
    consecutiveFailuresRef.current = 0;
    setConsecutiveFailures(0);
    setErrorSince(null);
  }, []);

  // Monotonic fetch epoch (issue #10761). Incremented on every project switch
  // so an in-flight fetch started before the switch can be detected and
  // discarded after it resolves — including the A→B→A cyclic case where the
  // project path alone repeats and a path-based guard would wrongly let the
  // earlier epoch's result through. Captured locally before the first `await`
  // in `fetchFn` and re-checked after each await.
  const fetchGenerationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Apply a `ForgeRepositoryStats` result to local state — shared by the
  // network fetch path (`fetchStats`) and the broadcast push path
  // (`onRepoStatsAndPageUpdated`). Both paths must run identical preservation
  // logic so a list-fetch-triggered update can't flash a `0` count when stale.
  const applyStatsResult = useCallback(
    (repoStats: ForgeRepositoryStats, opts: { projectPath: string }) => {
      if (!mountedRef.current) return;

      hasAppliedResultRef.current = true;

      // Only preserve counts when data is stale or errored (not on successful fresh fetch)
      const shouldPreserve = repoStats.stale === true || repoStats.error !== undefined;

      if (!shouldPreserve) {
        // Fresh successful data — record the confirmed counts so a later
        // stale/errored poll can fall back to them. `null` in the ref means
        // "no count ever confirmed"; a confirmed `0` is stored as `0` (not
        // `null`) so a repo with genuinely zero open issues/PRs still preserves
        // that `0` on a failed poll instead of flashing a `—` dash.
        if (repoStats.issueCount !== null) {
          lastKnownCountsRef.current.issueCount = repoStats.issueCount;
        }

        if (repoStats.prCount !== null) {
          lastKnownCountsRef.current.prCount = repoStats.prCount;
        }

        // Count-as-cache-buster: a fresh count that diverges from what a
        // cached dropdown page recorded at write time means the page is
        // provably stale — flag it (metadata only, rows stay) so the next
        // open revalidates with `bypassCache: true` instead of the
        // downgraded cached read. Stale/errored polls are excluded: their
        // counts are fallbacks, not observations.
        if (repoStats.issueCount !== null) {
          markCountStale(opts.projectPath, "issue", repoStats.issueCount);
        }
        if (repoStats.prCount !== null) {
          markCountStale(opts.projectPath, "pr", repoStats.prCount);
        }
      }

      // Apply preservation: use preserved counts only when data is stale/errored
      // and the incoming count is either a failed-fetch null or a stale 0. A
      // failed poll surfaces `issueCount: null`, which would otherwise erase a
      // valid prior count and flash a `—` dash in the toolbar badge; a stale
      // broadcast can surface `0`, which would flash a `0`. Both are preserved
      // while a genuine fresh `0` (shouldPreserve === false) still shows `0`.
      const preservedStats: ForgeRepositoryStats = {
        ...repoStats,
        issueCount:
          shouldPreserve &&
          (repoStats.issueCount === null || repoStats.issueCount === 0) &&
          lastKnownCountsRef.current.issueCount !== null
            ? lastKnownCountsRef.current.issueCount
            : repoStats.issueCount,
        prCount:
          shouldPreserve &&
          (repoStats.prCount === null || repoStats.prCount === 0) &&
          lastKnownCountsRef.current.prCount !== null
            ? lastKnownCountsRef.current.prCount
            : repoStats.prCount,
      };

      setStats(preservedStats);
      setIsStale(repoStats.stale ?? false);
      const nextLastUpdated = repoStats.lastUpdated ?? null;
      lastUpdatedRef.current = nextLastUpdated;
      setLastUpdated(nextLastUpdated);

      // Seed the switch-back reuse cache on genuine fresh success only
      // (issue #10761). `shouldPreserve` covers stale/errored results, and a
      // missing `lastUpdated` means there's no fetch time to age against — both
      // are excluded so a switch-back never restores an error or an undatable
      // snapshot. Evict aged-out entries on write and cap the map size to keep
      // it bounded across a session that visits many projects.
      if (!shouldPreserve && nextLastUpdated !== null) {
        const now = Date.now();
        for (const [key, entry] of switchBackStatsCache) {
          if (now - entry.lastUpdated >= AGING_THRESHOLD_MS) {
            switchBackStatsCache.delete(key);
          }
        }
        if (
          switchBackStatsCache.size >= MAX_SWITCHBACK_CACHE_SIZE &&
          !switchBackStatsCache.has(opts.projectPath)
        ) {
          let oldestKey: string | null = null;
          let oldestTs = Infinity;
          for (const [key, entry] of switchBackStatsCache) {
            if (entry.lastUpdated < oldestTs) {
              oldestTs = entry.lastUpdated;
              oldestKey = key;
            }
          }
          if (oldestKey !== null) switchBackStatsCache.delete(oldestKey);
        }
        switchBackStatsCache.set(opts.projectPath, {
          stats: preservedStats,
          lastUpdated: nextLastUpdated,
          providerId: providerIdRef.current,
        });
      }

      // Carry the probe-derived cadence forward only on successful reads — a
      // stale/errored result has no fresh cadence to offer, so the existing
      // value keeps driving the schedule. On a success that reports no cadence
      // (e.g. a future provider that omits it), fall back to null so
      // `calculateNextInterval` reverts to the fixed active interval rather than
      // sticking on a now-meaningless previous value.
      if (!shouldPreserve) {
        nextPollIntervalRef.current = repoStats.nextPollIntervalMs ?? null;
      }

      const nextResetAt = repoStats.rateLimitResetAt ?? null;
      const nextKind = repoStats.rateLimitKind ?? null;
      rateLimitResetAtRef.current = nextResetAt;
      setRateLimitResetAt(nextResetAt);
      setRateLimitKind(nextKind);

      if (repoStats.error) {
        setError(repoStats.error);
        lastErrorRef.current = repoStats.error;
        recordPollFailure();
      } else {
        setError(null);
        lastErrorRef.current = null;
        resetPollFailures();
      }
    },
    [recordPollFailure, resetPollFailures]
  );

  // Worker instances suppress automatic background polling to conserve the
  // provider's API quota (#10123) — on-demand `refresh()` stays functional.
  const isWorkerInstance = window.__DAINTREE_INSTANCE_ROLE__?.role === "worker";
  // Stats poll for any open project. With no resolved forge provider (no
  // matching remote, or the owning plugin is disabled) the stats IPC returns
  // a commit-only snapshot (issue/PR counts null) and the toolbar renders the
  // commits-only pill — polling only waits out the resolution round-trip so
  // the first fetch doesn't race a provider that is about to resolve.
  const currentProjectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const { providerId, loading: providerLoading } = useResolvedForgeProvider(currentProjectId);
  // Ref mirror for the push subscriptions: payloads are providerId-keyed, and
  // the subscriber closures must compare against the live resolution without
  // re-subscribing on every resolve.
  const providerIdRef = useRef<string | null>(providerId);
  useEffect(() => {
    providerIdRef.current = providerId;
  }, [providerId]);

  // Whether the one corrective refetch for the current provider resolution
  // has fired — see the effect below `usePollingLifecycle`. Declared here
  // because `onProjectSwitch` re-arms it.
  const correctiveRefetchDoneRef = useRef(false);

  const polling = usePollingLifecycle({
    enabled: !isWorkerInstance && currentProjectId !== null && !providerLoading,
    fetchFn: async ({ force, isInvalidated, reason }) => {
      // Capture the fetch epoch before the first await so a project switch that
      // fires mid-flight can be detected after each await (issue #10761).
      const myGeneration = fetchGenerationRef.current;
      try {
        const project = await projectClient.getCurrent();
        if (fetchGenerationRef.current !== myGeneration) return;
        // Lifecycle contract: re-check invalidation after every await. A
        // same-project refresh queued while `getCurrent()` was pending
        // supersedes this fetch — bail before spending a `getRepoStats` call.
        if (isInvalidated()) return;
        if (!project) {
          if (mountedRef.current) {
            setStats(null);
            setError(null);
            setIsStale(false);
            lastUpdatedRef.current = null;
            setLastUpdated(null);
            lastErrorRef.current = null;
            resetPollFailures();
          }
          return;
        }

        // Switch-back reuse (issue #10761): if this project's stats were loaded
        // recently, restore them synchronously before the skeleton would show.
        // `applyStatsResult` sets `hasAppliedResultRef`, so the `setLoading`
        // gate below stays off and the poll below revalidates in the
        // background. Gated on the resolved provider matching the cached one so
        // a project that now resolves to a different provider doesn't reuse
        // stale counts. Errors are never cached, so this can't resurrect one.
        if (mountedRef.current && !hasAppliedResultRef.current) {
          const cached = switchBackStatsCache.get(project.path);
          if (
            cached &&
            cached.providerId === providerIdRef.current &&
            Date.now() - cached.lastUpdated < FRESH_THRESHOLD_MS
          ) {
            applyStatsResult(cached.stats, { projectPath: project.path });
          }
        }

        // Skip the network revalidation on a cheap reactivation (tab focus /
        // project switch back) when fresh data is already in hand (issue
        // #10765). Each project runs in its own WebContentsView, so a single
        // reactivation fires both `onVisibilityVisible` and `onProjectSwitch`
        // — two `getRepoStats` calls per switch. Rapid switching bursts past
        // the IPC rate limiter (10 calls / 10s), which throws `RATE_LIMITED`
        // and paints the toolbar's red error line until a manual refresh. A
        // reactivation never needs to revalidate when the switch-back cache (or
        // a prior poll) left `lastUpdatedRef` within the freshness window;
        // scheduled polls, manual refresh, and cold starts (`lastUpdatedRef`
        // still null) all fall through to the network. Placed after the
        // switch-back restore (which repopulates `lastUpdatedRef`) and before
        // `setIsValidating(true)` so a skipped reactivation never flashes a
        // validating affordance.
        if (
          reason === "reactivate" &&
          !force &&
          lastUpdatedRef.current !== null &&
          Date.now() - lastUpdatedRef.current < FRESH_THRESHOLD_MS
        ) {
          return;
        }

        if (mountedRef.current) {
          // Always signal that a refetch is in flight so callers can show a
          // subtle in-progress affordance without hiding visible data. Only
          // flip the full `loading` skeleton when no result has been applied
          // yet — once `applyStatsResult` has run (network or disk hydration),
          // background revalidations (wake, focus, interval, manual refresh)
          // must not flash the skeleton over existing rows.
          setIsValidating(true);
          if (!hasAppliedResultRef.current) setLoading(true);
        }

        const repoStats = await forgeClient.getRepoStats(project.path, force);

        if (!mountedRef.current) return;
        if (isInvalidated()) return;

        // Ignore results from a previous project (issue #10761). The fetch
        // epoch advances on every switch, so a mismatch means this result was
        // requested before a switch fired — discard it rather than applying the
        // old project's stats/error to the new one. This supersedes the old
        // path-based guard, which let A→B→A cyclic switches leak through.
        if (fetchGenerationRef.current !== myGeneration) return;

        applyStatsResult(repoStats, { projectPath: project.path });
      } catch (err) {
        // Bail when the fetch was superseded — applying the old project's
        // error to the new project's state would surface a stale error and
        // push `calculateNextInterval` into the error backoff.
        if (isInvalidated()) return;
        if (fetchGenerationRef.current !== myGeneration) return;
        if (mountedRef.current) {
          const errorMessage = formatErrorMessage(err, "Failed to fetch repository stats");
          // A thrown fetch is an applied result too — without this, the
          // cold-start bootstrap hydration (gated on !hasAppliedResultRef)
          // could land after the failure, clear the error, and reset the
          // failure run. The resolved-error path gets the same protection
          // inside applyStatsResult.
          hasAppliedResultRef.current = true;
          setError(errorMessage);
          lastErrorRef.current = errorMessage;
          recordPollFailure();
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          setIsValidating(false);
        }
      }
    },
    calculateNextInterval: ({ isVisible }) => {
      const resetAt = rateLimitResetAtRef.current;
      if (resetAt !== null && resetAt > Date.now()) {
        return resetAt - Date.now() + RATE_LIMIT_RESUME_BUFFER_MS;
      }
      if (lastErrorRef.current) {
        // First failure retries fast; each further failure doubles the wait up
        // to the old flat ceiling. Pairs with `errorSeverity`: a run that
        // escalates to `persistent` has already burned through the quick
        // retries.
        const failures = Math.max(1, consecutiveFailuresRef.current);
        return Math.min(
          ERROR_BACKOFF_BASE_INTERVAL * 2 ** (failures - 1),
          ERROR_BACKOFF_MAX_INTERVAL
        );
      }
      if (isVisible) {
        // Honor the provider probe's adaptive cadence (issue #9741): poll
        // ~every minute while changes are landing, backing off toward the idle
        // ceiling on a quiet repo. Clamp to [ACTIVE_POLL_INTERVAL,
        // IDLE_POLL_INTERVAL] so a malformed hint can't poll faster than 30s or
        // stall longer than the idle cadence. Falls back to the fixed active
        // interval until the first successful poll reports a cadence.
        const adaptive = nextPollIntervalRef.current;
        if (adaptive != null && Number.isFinite(adaptive) && adaptive > 0) {
          return Math.min(Math.max(adaptive, ACTIVE_POLL_INTERVAL), IDLE_POLL_INTERVAL);
        }
        return ACTIVE_POLL_INTERVAL;
      }
      const resolvedId = providerIdRef.current;
      const multiplier = resolvedId
        ? (useForgeProviderHealthStore.getState().providers[resolvedId] ?? DEFAULT_PROVIDER_HEALTH)
            .rateLimitMultiplier
        : 1;
      return IDLE_POLL_INTERVAL * multiplier;
    },
    onProjectSwitch: () => {
      // Advance the fetch epoch unconditionally (even while unmounted) so any
      // in-flight fetch from the previous project is discarded when it resolves
      // instead of applying its stats/error to the newly-switched project
      // (issue #10761). This must precede the mounted-guard early return.
      fetchGenerationRef.current += 1;
      if (!mountedRef.current) return;
      // Clear preserved counts on project switch to prevent cross-contamination
      lastKnownCountsRef.current = { issueCount: null, prCount: null };
      hasAppliedResultRef.current = false;

      setStats(null);
      setIsStale(false);
      lastUpdatedRef.current = null;
      setLastUpdated(null);
      // Drop the previous project's probe cadence so the new project starts at
      // the fixed active interval until its first poll reports one (issue #9741).
      nextPollIntervalRef.current = null;
      rateLimitResetAtRef.current = null;
      setRateLimitResetAt(null);
      setRateLimitKind(null);
      // Reset error state too — without this the previous project's failure
      // (e.g. "token not configured") would carry into the new project's
      // freshness tier as `errored` until its first poll completes. The
      // failure run resets with it — severity is per-project.
      setError(null);
      lastErrorRef.current = null;
      resetPollFailures();
      // Re-arm the corrective refetch for the new project — the cap is
      // per-project like the rest of the per-switch resets.
      correctiveRefetchDoneRef.current = false;
    },
  });

  // Corrective refetch: a resolved provider whose applied result is
  // provider-less (null forge counts, no fetch time — the shape main returns
  // while the lazy forge plugin was not yet activated) means the toolbar sits
  // on em-dashes until the next scheduled poll, up to 30s out. Fire one
  // immediate refresh instead. Re-evaluated on every applied result (`stats`
  // identity changes on each apply) as well as on resolution changes, so it
  // catches both orders: the provider resolving after the provider-less
  // snapshot applied (plugin enabled/installed mid-session), AND a
  // provider-less fetch already in flight when the provider resolved, whose
  // result applies after the transition. Gated on `lastUpdated` still being
  // null: provider-less snapshots never carry a fetch time, so any dated
  // result (real counts, switch-back restore) means the regular schedule is
  // already serving data. Errored results are excluded — the poll's error
  // backoff already retries those. The done-ref caps it at one extra fetch
  // per resolution (re-armed on resolution change and project switch) so a
  // repo whose provider-less snapshots are structural (e.g. an override set
  // but no git remote) cannot refetch-loop.
  const prevProviderIdRef = useRef(providerId);
  useEffect(() => {
    if (prevProviderIdRef.current !== providerId) {
      prevProviderIdRef.current = providerId;
      correctiveRefetchDoneRef.current = false;
    }
    if (!providerId || isWorkerInstance) return;
    if (correctiveRefetchDoneRef.current) return;
    if (!hasAppliedResultRef.current || lastUpdatedRef.current !== null) return;
    if (lastErrorRef.current !== null) return;
    correctiveRefetchDoneRef.current = true;
    void polling.refresh();
  }, [providerId, stats, polling, isWorkerInstance]);

  // Cold-start hydration: before the first poll completes, ask main for the
  // disk-persisted first page so the very first dropdown click after launch
  // resolves against real rows. Entries older than the disk cache's freshness
  // budget are dropped on read by the main-side cache and surface as `null`.
  // Within-session project switches don't re-hydrate from disk — the broadcast
  // subscription below seeds the renderer cache once the next poll completes.
  // Gated on the provider resolution so a payload written by provider A can't
  // hydrate a project that now resolves to provider B.
  const hasHydratedRef = useRef(false);
  useEffect(() => {
    if (!providerId || hasHydratedRef.current) return;
    hasHydratedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const project = await projectClient.getCurrent();
        if (!project || cancelled || !mountedRef.current) return;
        const cached = await forgeClient.getFirstPageCache(project.path);
        if (!cached || cancelled || !mountedRef.current) return;
        if (cached.providerId !== providerIdRef.current) return;

        // Re-verify project identity after the async cache read. A project
        // switch may have fired while we were waiting for the IPC response.
        const currentProject = await projectClient.getCurrent();
        if (cancelled || !mountedRef.current) return;
        if (!currentProject || currentProject.path !== project.path) return;
        if (cached.projectPath !== currentProject.path) return;

        // Seed toolbar counts from bootstrap stats so the pill renders cached
        // counts immediately instead of an em-dash. Only apply when no other
        // result (network fetch success, error, or stale push) has landed
        // yet — the network poll will replace these with fresh data.
        if (cached.stats && !hasAppliedResultRef.current) {
          const bootstrapStats: ForgeRepositoryStats = {
            commitCount: 0,
            issueCount: cached.stats.issueCount,
            prCount: cached.stats.prCount,
            loading: false,
            stale: true,
            lastUpdated: cached.stats.lastUpdated,
          };
          applyStatsResult(bootstrapStats, { projectPath: currentProject.path });
        }

        const issuesKey = buildCacheKey(currentProject.path, "issue", "open", "created");
        const prsKey = buildCacheKey(currentProject.path, "pr", "open", "created");
        // Don't downgrade a fresher entry — the broadcast push from the first
        // poll can land before this hydration resolves, and disk data is up
        // to 10 minutes old.
        // Only seed items when the payload has actual items — a stats-only
        // payload (first-page cache expired but stats within bootstrap TTL)
        // has empty arrays that must not overwrite the renderer items cache.
        if (cached.issues.items.length > 0) {
          const existingIssues = getCache(issuesKey);
          if (!existingIssues || existingIssues.timestamp < cached.lastUpdated) {
            setCache(issuesKey, {
              items: cached.issues.items,
              nextCursor: cached.issues.endCursor,
              hasMore: cached.issues.hasNextPage,
              timestamp: cached.lastUpdated,
            });
          }
        }
        if (cached.prs.items.length > 0) {
          const existingPRs = getCache(prsKey);
          if (!existingPRs || existingPRs.timestamp < cached.lastUpdated) {
            setCache(prsKey, {
              items: cached.prs.items,
              nextCursor: cached.prs.endCursor,
              hasMore: cached.prs.hasNextPage,
              timestamp: cached.lastUpdated,
            });
          }
        }
      } catch {
        // Disk hydration is best-effort; the network poll fallback covers
        // any failure here.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [providerId, applyStatsResult]);

  // Subscribe to the combined repo-stats-and-first-page push from the main
  // process. Whenever a poll completes successfully, main broadcasts the
  // counts AND the first 20 open issues + open PRs (sorted by created-desc).
  // Seed the renderer's `forgeResourceCache` for the matching default-filter
  // cache key so the next dropdown click reads from hot cache instantly, and
  // apply the pushed stats to the toolbar count immediately so the badge
  // converges with the dropdown without waiting for the next 30s poll.
  useEffect(() => {
    const cleanup = forgeClient.onRepoStatsAndPageUpdated((payload) => {
      if (!mountedRef.current) return;
      // Payloads are providerId-keyed; only the project's resolved provider
      // may write this view's cache and counts.
      if (payload.providerId !== providerIdRef.current) return;
      // Filter by current project. Each `WebContentsView` runs its own
      // renderer with isolated module state, so the cache writes below are
      // scoped to this view's project.
      projectClient
        .getCurrent()
        .then((project) => {
          if (!project || project.path !== payload.projectPath) return;
          if (!mountedRef.current) return;
          // Defensive shape guard against future IPC drift — bad payloads
          // are skipped rather than written to cache where they would crash
          // consumers using "isDraft" in item or item.number.
          if (!isValidPagePayload(payload.issues) || !isValidPagePayload(payload.prs)) return;

          // Stats freshness guard: compare the broadcast's `stats.lastUpdated`
          // (the actual provider fetch time) to whatever we last applied.
          // Same units on both sides since the helper writes
          // `lastUpdatedRef.current = repoStats.lastUpdated`. Using `fetchedAt`
          // here would be over-permissive — `fetchedAt` is set later in the
          // broadcast call chain than `stats.lastUpdated` and would let an
          // older fetch's payload through if a long commit-count lookup
          // delayed the broadcast.
          const pushedLastUpdated = payload.stats.lastUpdated ?? null;
          const skipStats =
            pushedLastUpdated !== null &&
            lastUpdatedRef.current !== null &&
            pushedLastUpdated <= lastUpdatedRef.current;

          // Cache freshness guard: the renderer cache may have been written by
          // a more-recent SWR revalidation in the dropdown list whose
          // timestamp is independent of `lastUpdatedRef`. Don't downgrade a
          // fresher entry — same pattern as the disk-hydration block above.
          const issuesKey = buildCacheKey(payload.projectPath, "issue", "open", "created");
          const prsKey = buildCacheKey(payload.projectPath, "pr", "open", "created");
          const existingIssues = getCache(issuesKey);
          const existingPRs = getCache(prsKey);
          // `countAtWrite` is stamped so the count-as-cache-buster can compare
          // later REST polls against it; `freshBypassAt` is deliberately NOT
          // stamped — this payload can carry a re-stamped main-process
          // snapshot (probe-unchanged path), so it must never satisfy the
          // "just fetched from GitHub, skip the open revalidate" gate.
          if (!existingIssues || existingIssues.timestamp < payload.fetchedAt) {
            setCache(issuesKey, {
              items: payload.issues.items,
              nextCursor: payload.issues.endCursor,
              hasMore: payload.issues.hasNextPage,
              timestamp: payload.fetchedAt,
              countAtWrite: payload.issues.totalCount,
            });
          }
          if (!existingPRs || existingPRs.timestamp < payload.fetchedAt) {
            setCache(prsKey, {
              items: payload.prs.items,
              nextCursor: payload.prs.endCursor,
              hasMore: payload.prs.hasNextPage,
              timestamp: payload.fetchedAt,
              countAtWrite: payload.prs.totalCount,
            });
          }

          if (!skipStats) {
            applyStatsResult(payload.stats, { projectPath: payload.projectPath });
          }
        })
        .catch(() => {
          // Project lookup races during teardown / project switch are
          // expected and benign — swallow rather than producing an
          // unhandled rejection.
        });
    });
    return cleanup;
  }, [applyStatsResult]);

  // Subscribe to the count-only push from the cheap background poll
  // (issue #10122). Carries no page items — only the toolbar counts — so it
  // skips the cache seeding above and just applies the stats, behind the same
  // provider + project filters and freshness guard as the combined push.
  useEffect(() => {
    const cleanup = forgeClient.onRepoCountsUpdated((payload) => {
      if (!mountedRef.current) return;
      if (payload.providerId !== providerIdRef.current) return;
      projectClient
        .getCurrent()
        .then((project) => {
          if (!project || project.path !== payload.projectPath) return;
          if (!mountedRef.current) return;

          const pushedLastUpdated = payload.stats.lastUpdated ?? null;
          if (
            pushedLastUpdated !== null &&
            lastUpdatedRef.current !== null &&
            pushedLastUpdated <= lastUpdatedRef.current
          ) {
            return;
          }

          applyStatsResult(payload.stats, { projectPath: payload.projectPath });
        })
        .catch(() => {
          // Project lookup races during teardown / project switch are
          // expected and benign — swallow rather than producing an
          // unhandled rejection.
        });
    });
    return cleanup;
  }, [applyStatsResult]);

  // Coalesce sleep-wake fetches onto the shared wake-coordinator slice
  // (#8066). The store bumps `wakeEpoch` once per qualifying wake; every
  // consumer reacts to the same epoch instead of independently registering
  // `system.onWake` listeners or duplicating short-sleep heuristics. The
  // `lastSeenWakeEpochRef` is seeded with the current value at mount so a
  // component that arrives after a previous wake doesn't fire a spurious
  // refetch.
  const wakeEpoch = useSystemWakeStore((s) => s.wakeEpoch);
  const lastSeenWakeEpochRef = useRef(useSystemWakeStore.getState().wakeEpoch);
  useEffect(() => {
    if (wakeEpoch <= lastSeenWakeEpochRef.current) return;
    lastSeenWakeEpochRef.current = wakeEpoch;
    // Wake refetches are automatic background fetches — suppressed on worker
    // instances like the polling loop itself (#10123).
    if (isWorkerInstance) return;
    void polling.refresh();
  }, [wakeEpoch, polling, isWorkerInstance]);

  useEffect(() => {
    const cleanup = forgeClient.onRateLimitChanged((payload) => {
      if (!mountedRef.current) return;
      if (payload.providerId !== providerIdRef.current) return;
      // Project the neutral RateLimitInfo onto the poll-scheduling state.
      // `remaining === 0` is the canonical "blocked" signal (the host forces
      // it to 0 inside a hard-stop band); `secondaryThrottled` marks an abuse
      // pause that may not exhaust the quota counter.
      const blocked = payload.state.remaining === 0 || payload.state.secondaryThrottled === true;
      const nextResetAt = blocked ? (payload.state.resetAt ?? null) : null;
      const nextKind: ForgeRateLimitKind | null = blocked
        ? payload.state.secondaryThrottled
          ? "secondary"
          : "primary"
        : null;
      rateLimitResetAtRef.current = nextResetAt;
      setRateLimitResetAt(nextResetAt);
      setRateLimitKind(nextKind);

      // When the limit clears, run an immediate refresh so the UI updates
      // without waiting a full poll interval; `refresh` clears the timer,
      // fetches, and reschedules against the new rate-limit-aware interval.
      // When blocked, just reschedule against the new resume time. The clear
      // is an automatic system event, not a user action — suppressed on
      // worker instances like the polling loop itself (#10123).
      if (!blocked) {
        if (isWorkerInstance) return;
        void polling.refresh();
      } else {
        polling.scheduleNextPoll();
      }
    });
    return cleanup;
  }, [polling, isWorkerInstance]);

  const isTokenError = isTokenRelatedError(error);

  // Subscribe to the shared 30-second tick so the level re-evaluates against
  // wall-clock without each consumer registering its own interval. Stays
  // paused while the document is hidden — fine because the visibility handler
  // refetches on resume and the next render will reset the tier.
  const tick = useGlobalMinuteTicker();
  const statsError = stats?.error;
  const freshnessLevel = useMemo<FreshnessLevel>(() => {
    // Disk-fallback path: the provider only sets `stale: true` when it
    // returned persistent-cache data after a token / rate-limit / network
    // failure. The presence of an upstream error string upgrades that to
    // "errored" so the user sees something distinct from a quiet cold start.
    if (isStale) {
      return statsError ? "errored" : "stale-disk";
    }
    // Errored without a successful baseline: covers two paths the `isStale`
    // branch above misses — the IPC handler returning `error` with `stale=
    // false` (no-token / first-launch failure) and `fetchStats`'s catch block
    // setting `error` after a throw before any `lastUpdated` was applied.
    // Once a fresh poll lands (`lastUpdated` set) a transient subsequent
    // error stays in age-driven freshness so the user keeps seeing valid
    // recent data instead of a sudden alarm.
    if (error && lastUpdated == null) {
      return "errored";
    }
    if (lastUpdated == null) {
      // No data yet (cold mount before first poll resolves) — treat as fresh
      // so the loading/empty state isn't decorated with a staleness icon.
      return "fresh";
    }
    // `tick` is intentionally read so re-renders against the global ticker
    // re-evaluate `Date.now() - lastUpdated` and let `aging` activate when
    // the active poll falls behind without a backend-side stale flag.
    void tick;
    const age = Date.now() - lastUpdated;
    if (age < FRESH_THRESHOLD_MS) return "fresh";
    if (age < AGING_THRESHOLD_MS) return "aging";
    // Past the aging ceiling the in-session counts haven't been refreshed but
    // no backend has flagged stale either — keep `aging` rather than minting
    // a fifth tier. The threshold is exported as documentation of the
    // "expected" freshness ceiling and is consumed by tests.
    return "aging";
  }, [isStale, statsError, error, lastUpdated, tick]);

  // Same ticker subscription as `freshnessLevel` so the age clause can flip a
  // long-lived `transient` to `persistent` without waiting for the next
  // failure event.
  const errorSeverity = useMemo<RepositoryStatsErrorSeverity | null>(() => {
    if (!error) return null;
    // No baseline at all — the pills are showing em-dashes, so the failure is
    // the only signal available. Surface it immediately rather than waiting
    // out a threshold. Mirrors the `errored` freshness tier above.
    if (lastUpdated == null) return "persistent";
    void tick;
    if (consecutiveFailures >= PERSISTENT_ERROR_FAILURES) return "persistent";
    if (errorSince !== null && Date.now() - errorSince >= PERSISTENT_ERROR_MS) {
      return "persistent";
    }
    return "transient";
  }, [error, lastUpdated, consecutiveFailures, errorSince, tick]);

  return {
    stats,
    loading,
    isValidating,
    error,
    errorSeverity,
    isTokenError,
    isStale,
    lastUpdated,
    rateLimitResetAt,
    rateLimitKind,
    freshnessLevel,
    refresh: polling.refresh,
  };
}
