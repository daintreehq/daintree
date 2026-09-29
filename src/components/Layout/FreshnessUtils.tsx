import type { FreshnessLevel } from "@/hooks/useRepositoryStats";
import { formatTimeAgo } from "@/utils/timeAgo";

export type BadgeFreshnessCause = "rate-limit" | "circuit-breaker";

export function freshnessClass(level: FreshnessLevel): string {
  switch (level) {
    case "aging":
      return "opacity-75";
    case "stale-disk":
      return "border-l-2 border-border-default italic";
    case "errored":
      return "border-l-2 border-border-default italic";
    case "fresh":
    default:
      return "";
  }
}

/** `formatTimeAgo` with "unknown" for a missing, invalid or future timestamp. */
export function formatTimeSince(timestamp: number | null, now: number): string {
  if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now) {
    return "unknown";
  }
  return formatTimeAgo(timestamp, now);
}

export function freshnessSuffix(
  level: FreshnessLevel,
  lastUpdated: number | null,
  now: number
): string {
  switch (level) {
    case "aging":
      return ` · updated ${formatTimeSince(lastUpdated, now)}`;
    case "stale-disk":
      return " · cached from previous session";
    case "errored":
      return " · couldn't refresh";
    case "fresh":
    default:
      return "";
  }
}

export function badgeFreshnessSuffix(
  cause: BadgeFreshnessCause | undefined,
  now: number,
  resetAt?: number | null
): string {
  switch (cause) {
    case "rate-limit": {
      let suffix = " · rate limited";
      if (resetAt != null && resetAt > now) {
        const retryTime = new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(resetAt));
        suffix += `, retry at ${retryTime}`;
      }
      return suffix;
    }
    case "circuit-breaker":
      return " · data may be stale — PR detection paused";
    default:
      return "";
  }
}
