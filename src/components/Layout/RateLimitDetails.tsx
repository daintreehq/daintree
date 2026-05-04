import { cn } from "@/lib/utils";
import type { GitHubRateLimitDetails } from "@shared/types";

export function formatRateLimitCountdown(remainingMs: number): string {
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

export function RateLimitDetailsPanel({
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
  const aria = `${label}: ${Math.max(0, bucket.remaining).toLocaleString()} of ${bucket.limit.toLocaleString()} remaining. ${
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
