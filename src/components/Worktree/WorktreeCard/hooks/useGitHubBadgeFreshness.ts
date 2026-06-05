import type { FreshnessLevel } from "@/hooks/useRepositoryStats";
import type { BadgeFreshnessCause } from "@/components/Layout/FreshnessUtils";
import { useGitHubRateLimitStore } from "@/store/githubRateLimitStore";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";

export interface UseGitHubBadgeFreshnessResult {
  freshnessLevel: FreshnessLevel;
  freshnessCause?: BadgeFreshnessCause;
  rateLimitResetAt: number | null;
  now: number;
}

export function useGitHubBadgeFreshness(type: "pr" | "issue"): UseGitHubBadgeFreshnessResult {
  const rateLimitBlocked = useGitHubRateLimitStore((s) => s.blocked);
  const rateLimitResetAt = useGitHubRateLimitStore((s) => s.resetAt);
  const prCircuitBreakerTripped = usePRCircuitBreakerStore((s) => s.tripped);

  // Only surface freshness when the user can act on it: GitHub cut us off
  // (rate-limit) or PR detection is paused (circuit-breaker). Plain age isn't a
  // signal — the badges self-refresh on a tight poll, so an "N minutes old"
  // glyph was noise. Circuit-breaker only applies to PR badges; issue badges get
  // circuit-breaker visibility through the `prDetectionPaused` prop instead.
  let freshnessCause: BadgeFreshnessCause | undefined;
  if (rateLimitBlocked) {
    freshnessCause = "rate-limit";
  } else if (type === "pr" && prCircuitBreakerTripped) {
    freshnessCause = "circuit-breaker";
  }

  const freshnessLevel: FreshnessLevel = freshnessCause ? "aging" : "fresh";

  return { freshnessLevel, freshnessCause, rateLimitResetAt, now: Date.now() };
}
