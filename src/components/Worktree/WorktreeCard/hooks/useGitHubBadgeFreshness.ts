import { useSyncExternalStore } from "react";
import type { FreshnessLevel } from "@/hooks/useRepositoryStats";
import type { BadgeFreshnessCause } from "@/components/Layout/FreshnessUtils";
import { getCache, buildCacheKey } from "@/lib/githubResourceCache";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import { useProjectStore } from "@/store/projectStore";
import { useGitHubRateLimitStore } from "@/store/githubRateLimitStore";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";

const DEFAULT_FILTER_STATE = "open";
const DEFAULT_SORT_ORDER = "created";

const STALE_THRESHOLD_MS = 3 * 60 * 1000;

const noopSubscribe = () => () => {};

export interface UseGitHubBadgeFreshnessResult {
  freshnessLevel: FreshnessLevel;
  freshnessCause?: BadgeFreshnessCause;
  cacheLastUpdatedAt: number | null;
  rateLimitResetAt: number | null;
  now: number;
}

export function useGitHubBadgeFreshness(
  type: "pr" | "issue",
  rowLastUpdatedAt?: number
): UseGitHubBadgeFreshnessResult {
  const projectPath = useProjectStore((s) => s.currentProject?.path);
  const tick = useGlobalMinuteTicker();
  const rateLimitBlocked = useGitHubRateLimitStore((s) => s.blocked);
  const rateLimitResetAt = useGitHubRateLimitStore((s) => s.resetAt);
  const prCircuitBreakerTripped = usePRCircuitBreakerStore((s) => s.tripped);

  const cacheKey = projectPath
    ? buildCacheKey(projectPath, type, DEFAULT_FILTER_STATE, DEFAULT_SORT_ORDER)
    : null;

  const cacheEntry = useSyncExternalStore(noopSubscribe, () =>
    cacheKey ? getCache(cacheKey) : undefined
  );

  const cacheLastUpdatedAt = cacheEntry?.timestamp ?? null;
  const now = tick > 0 ? Date.now() : Date.now();

  // Precedence: rate-limit > circuit-breaker > age threshold.
  // Circuit-breaker only applies to PR badges; issue badges get circuit-breaker
  // visibility through the `prDetectionPaused` prop instead.
  let freshnessCause: BadgeFreshnessCause | undefined;
  if (rateLimitBlocked) {
    freshnessCause = "rate-limit";
  } else if (type === "pr" && prCircuitBreakerTripped) {
    freshnessCause = "circuit-breaker";
  } else if (rowLastUpdatedAt != null && now - rowLastUpdatedAt > STALE_THRESHOLD_MS) {
    freshnessCause = "stale";
  }

  const freshnessLevel: FreshnessLevel = freshnessCause ? "aging" : "fresh";

  return { freshnessLevel, freshnessCause, cacheLastUpdatedAt, rateLimitResetAt, now };
}
