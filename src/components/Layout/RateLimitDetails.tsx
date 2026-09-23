import { cn } from "@/lib/utils";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD, UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import type { RateLimitBucket, RateLimitDetails } from "@shared/types/forge";

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Second-resolution countdown for surfaces that re-render every second (the
 * toolbar panel and its trigger). Two units above a minute, and the smaller one
 * always two digits, so a ticking label keeps one shape: `42s`, `14m 05s`, `2h 05m`.
 */
export function formatRateLimitCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${pad2(totalSeconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad2(minutes % 60)}m`;
}

/**
 * Minute-resolution countdown for surfaces on the shared 30-second ticker,
 * which would otherwise show seconds that sit still for half a minute. Rounds
 * up so the label never promises an earlier resume than the provider reported.
 */
export function formatRateLimitCountdownCoarse(remainingMs: number): string {
  if (remainingMs < 60_000) return "less than a minute";
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const rem = minutes % 60;
  return rem > 0 ? `${Math.floor(minutes / 60)}h ${rem}m` : `${Math.floor(minutes / 60)}h`;
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

function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * The time phrase that completes "Resumes …" in passive banners: `in 14m`,
 * `in less than a minute`, or `on the next check` once the reported time has
 * passed — polling picks back up then, and nothing more than that is known.
 * It owns the preposition and the elapsed case, so callers render it whenever
 * a reset time exists and the sentence never depends on which one re-rendered.
 *
 * Re-evaluates on the shared minute ticker, so it counts in minutes; the
 * per-second readout lives in {@link RateLimitDetailsPanel}. The ticking text
 * is hidden from assistive tech — its callers sit in `role="status"` regions,
 * which would otherwise re-announce every minute — and a fixed clock time is
 * read instead.
 */
export function LiveRateLimitCountdown({ resetAt }: { resetAt: number }) {
  useGlobalMinuteTicker();
  const remaining = resetAt - Date.now();
  if (remaining <= 0) return <>on the next check</>;
  return (
    <>
      <span aria-hidden="true">in {formatRateLimitCountdownCoarse(remaining)}</span>
      <span className="sr-only">at {formatClockTime(resetAt)}</span>
    </>
  );
}

// Display names for bucket identifiers common across providers. Unknown
// names render capitalized as reported — the host never interprets them.
const BUCKET_LABELS: Record<string, string> = {
  graphql: "GraphQL",
  core: "REST core",
  rest: "REST",
  search: "Search",
};

export function bucketLabel(name: string): string {
  return BUCKET_LABELS[name] ?? (name ? name[0]!.toUpperCase() + name.slice(1) : name);
}

const CAUSE_COPY: Record<"primary" | "secondary" | "unknown", { title: string; body: string }> = {
  primary: {
    title: "rate limit reached",
    body: "A request quota ran out. Updates resume on their own.",
  },
  secondary: {
    title: "secondary rate limit",
    body: "Paused for abuse protection, not quota. Updates resume on their own.",
  },
  unknown: {
    title: "requests paused",
    body: "No reason was reported. Updates resume on their own.",
  },
};

interface RateLimitDetailsPanelProps {
  providerName: string;
  kind: "primary" | "secondary" | null;
  /** `undefined` while the read is in flight; `null` once it answered with nothing. */
  details: RateLimitDetails | null | undefined;
  now: number;
  /** When the stats push says requests resume — the time that governs the pause. */
  fallbackResetAt: number | null;
}

export function RateLimitDetailsPanel({
  providerName,
  kind,
  details,
  now,
  fallbackResetAt,
}: RateLimitDetailsPanelProps) {
  const copy = CAUSE_COPY[kind ?? "unknown"];
  const provider = providerName ? providerName[0]!.toUpperCase() + providerName.slice(1) : "";
  const showPending = useDeferredLoading(details === undefined, UI_DOHERTY_THRESHOLD);
  const showStillWorking = useDeferredLoading(details === undefined, UI_STILL_WORKING_MS);
  const buckets = details?.buckets ?? [];

  return (
    <div className="flex w-[260px] flex-col gap-3 p-3.5">
      <div>
        <div className="text-text-primary text-sm font-semibold leading-tight">
          {provider} {copy.title}
        </div>
        <div className="text-text-secondary mt-1 text-xs leading-snug">{copy.body}</div>
      </div>
      <ResumeSummary resumeAt={fallbackResetAt} now={now} />
      {buckets.length > 0 ? (
        <div className="flex flex-col gap-3">
          {buckets.map((bucket) => (
            <RateLimitBucketRow key={bucket.name} bucket={bucket} now={now} />
          ))}
        </div>
      ) : details !== undefined ? (
        <div className="text-text-secondary text-2xs">Quota details unavailable</div>
      ) : showPending ? (
        <BucketRowSkeleton stillWorking={showStillWorking} />
      ) : null}
    </div>
  );
}

/** Holds the shape of one bucket row while the details read is in flight. */
function BucketRowSkeleton({ stillWorking }: { stillWorking: boolean }) {
  return (
    <div className="flex flex-col gap-1.5" aria-busy="true">
      <div className="flex items-baseline justify-between gap-3">
        <span className="bg-overlay-emphasis animate-pulse-delayed h-3 w-16 rounded-[var(--radius-xs)]" />
        <span className="bg-overlay-emphasis animate-pulse-delayed h-2.5 w-20 rounded-[var(--radius-xs)]" />
      </div>
      <div className="bg-overlay-emphasis animate-pulse-delayed h-1.5 rounded-full" />
      <span className="text-text-secondary text-2xs">
        {stillWorking ? "Still checking quotas…" : "Checking quotas…"}
      </span>
    </div>
  );
}

function ResumeSummary({ resumeAt, now }: { resumeAt: number | null; now: number }) {
  const remainingMs = resumeAt === null ? null : resumeAt - now;
  return (
    <div className="bg-overlay-soft flex items-baseline justify-between gap-3 rounded-[var(--radius-md)] px-2.5 py-2">
      {remainingMs === null ? (
        <span className="text-text-secondary text-xs">Resume time not reported</span>
      ) : remainingMs <= 0 ? (
        <span className="text-text-secondary text-xs">Resume time passed</span>
      ) : (
        <>
          <span className="text-text-secondary text-xs">Resumes in</span>
          <span className="text-text-primary text-sm font-semibold leading-none tabular-nums">
            {formatRateLimitCountdown(remainingMs)}
          </span>
        </>
      )}
    </div>
  );
}

function RateLimitBucketRow({ bucket, now }: { bucket: RateLimitBucket; now: number }) {
  const label = bucketLabel(bucket.name);
  const remaining = Math.max(0, bucket.remaining);
  const exhausted = remaining <= 0;
  const used = Math.min(bucket.limit, Math.max(0, bucket.used));
  const ratio = bucket.limit > 0 ? used / bucket.limit : 0;
  const remainingMs = bucket.resetAt - now;
  const counts = `${remaining.toLocaleString()} / ${bucket.limit.toLocaleString()} left`;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-text-primary text-xs font-medium">{label}</span>
        <span className="text-text-secondary text-2xs tabular-nums">{counts}</span>
      </div>
      <div
        role="meter"
        aria-label={`${label} quota used`}
        aria-valuemin={0}
        aria-valuemax={bucket.limit}
        aria-valuenow={used}
        aria-valuetext={`${remaining.toLocaleString()} of ${bucket.limit.toLocaleString()} left`}
        className="bg-overlay-emphasis h-1.5 overflow-hidden rounded-full"
      >
        <div
          className={cn(
            "h-full rounded-full",
            exhausted ? "bg-status-danger" : "bg-text-secondary"
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <div className="text-text-secondary flex items-baseline justify-between gap-3 text-2xs tabular-nums">
        <span className={cn(exhausted && "text-text-primary font-medium")}>
          {exhausted ? "Limit reached" : null}
        </span>
        <span>
          {remainingMs > 0
            ? `Resets in ${formatRateLimitCountdown(remainingMs)}`
            : "Reset time passed"}
        </span>
      </div>
    </div>
  );
}
