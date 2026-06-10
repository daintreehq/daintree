import type { FreshnessLevel } from "@/hooks/useRepositoryStats";
import type { BadgeFreshnessCause } from "@/components/Layout/FreshnessUtils";
import { useProjectStore } from "@/store/projectStore";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import {
  useForgeProviderHealthStore,
  DEFAULT_PROVIDER_HEALTH,
} from "@/store/forgeProviderHealthStore";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";

export interface UseForgeBadgeFreshnessResult {
  freshnessLevel: FreshnessLevel;
  freshnessCause?: BadgeFreshnessCause;
  rateLimitResetAt: number | null;
  now: number;
}

export function useForgeBadgeFreshness(type: "pr" | "issue"): UseForgeBadgeFreshnessResult {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const { providerId } = useResolvedForgeProvider(projectId);
  const rateLimitBlocked = useForgeProviderHealthStore((s) =>
    providerId ? (s.providers[providerId] ?? DEFAULT_PROVIDER_HEALTH).rateLimitBlocked : false
  );
  const rateLimitResetAt = useForgeProviderHealthStore((s) =>
    providerId ? (s.providers[providerId] ?? DEFAULT_PROVIDER_HEALTH).rateLimitResetAt : null
  );
  const prCircuitBreakerTripped = usePRCircuitBreakerStore((s) => s.tripped);

  // Only surface freshness when the user can act on it: the forge cut us off
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
