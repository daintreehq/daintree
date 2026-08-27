import { cn } from "@/lib/utils";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import type { RateLimitBucket, RateLimitDetails } from "@shared/types/forge";

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

/**
 * Live rate-limit reset countdown for in-panel banners (e.g. the issues/PRs
 * dropdown). Re-evaluates on the shared minute ticker — minute granularity is
 * intentional for a passive banner; the per-second readout lives in the
 * toolbar {@link RateLimitDetailsPanel} tooltip.
 */
export function LiveRateLimitCountdown({ resetAt }: { resetAt: number }) {
  useGlobalMinuteTicker();
  const remaining = resetAt - Date.now();
  return <>{remaining <= 0 ? "any moment now" : formatRateLimitCountdown(remaining)}</>;
}

// Display names for bucket identifiers common across providers. Unknown
// names render capitalized as reported — the host never interprets them.
const BUCKET_LABELS: Record<string, string> = {
  graphql: "GraphQL",
  core: "REST core",
  search: "Search",
};

function bucketLabel(name: string): string {
  return BUCKET_LABELS[name] ?? (name ? name[0]!.toUpperCase() + name.slice(1) : name);
}

interface RateLimitDetailsPanelProps {
  kind: "primary" | "secondary" | null;
  details: RateLimitDetails | null;
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
        : "API quota";
  const subheading =
    kind === "secondary"
      ? "Requests are paused for abuse protection. Polling resumes automatically."
      : "Polling resumes when the bucket resets.";

  return (
    <div className="w-[260px] px-3.5 py-3.5">
      <div className="pb-5">
        <div className="text-text-primary text-sm font-semibold leading-tight">{heading}</div>
        <div className="text-muted-foreground mt-1 text-2xs leading-snug">{subheading}</div>
      </div>
      {details ? (
        <div className="flex flex-col gap-4">
          {details.buckets.map((bucket) => (
            <RateLimitBucketRow
              key={bucket.name}
              label={bucketLabel(bucket.name)}
              bucket={bucket}
              now={now}
            />
          ))}
        </div>
      ) : (
        <div className="text-muted-foreground text-2xs tabular-nums">
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
  bucket: RateLimitBucket;
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
            "text-sm font-medium leading-none",
            exhausted ? "text-text-primary" : "text-text-secondary"
          )}
        >
          {label}
        </span>
        <span className="text-muted-foreground text-2xs leading-none tabular-nums">
          {timeLabel}
        </span>
      </div>
      <div className="bg-overlay-subtle h-1.5 overflow-hidden rounded-full">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300 ease-out",
            exhausted ? "bg-pr-closed" : "bg-daintree-text/60"
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}
