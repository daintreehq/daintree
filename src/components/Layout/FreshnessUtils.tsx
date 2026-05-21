import { Clock } from "lucide-react";
import type { FreshnessLevel } from "@/hooks/useRepositoryStats";

export type BadgeFreshnessCause = "stale" | "rate-limit" | "circuit-breaker";

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

export function FreshnessGlyph({ level }: { level: FreshnessLevel }) {
  if (level === "stale-disk" || level === "aging") {
    return <Clock className="h-3 w-3 text-muted-foreground" aria-hidden="true" />;
  }
  return null;
}

export function formatTimeSince(timestamp: number | null, now: number): string {
  if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now) {
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
      return " · couldn't reach GitHub";
    case "fresh":
    default:
      return "";
  }
}

export function badgeFreshnessSuffix(
  cause: BadgeFreshnessCause | undefined,
  lastUpdated: number | null,
  now: number,
  resetAt?: number | null
): string {
  switch (cause) {
    case "stale":
      return ` · updated ${formatTimeSince(lastUpdated, now)}`;
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
