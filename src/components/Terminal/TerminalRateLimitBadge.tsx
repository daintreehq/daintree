import { TriangleAlert } from "@/components/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import {
  isRateLimitObservationLive,
  useRateLimitObservationStore,
} from "@/store/rateLimitObservationStore";
import { formatTimeAgo } from "@/utils/timeAgo";

/**
 * Ambient header chip on a pane whose agent printed a rate-limit banner
 * (#12797). What was seen in this pane's output and when — not the account's
 * quota, which lives in Settings and is never inferred from this.
 */
export function TerminalRateLimitBadge({ terminalId }: { terminalId: string }) {
  const observedAt = useRateLimitObservationStore((s) => s.observedAtByTerminalId[terminalId]);
  if (observedAt === undefined) return null;
  return <RateLimitChip observedAt={observedAt} />;
}

// Split out so only a pane that has an observation subscribes to the clock.
function RateLimitChip({ observedAt }: { observedAt: number }) {
  const now = useGlobalMinuteClock();
  if (!isRateLimitObservationLive(observedAt, now)) return null;
  const time = new Date(observedAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="inline-flex items-center gap-1 text-xs font-sans bg-overlay-soft text-text-secondary px-1.5 py-0.5 rounded-full border border-divider"
          role="status"
          aria-live="off"
          data-testid="terminal-rate-limit-badge"
        >
          <TriangleAlert className="w-3 h-3 shrink-0" aria-hidden="true" />
          Rate limit seen
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">
            Rate limit message at {time} ({formatTimeAgo(observedAt, now)})
          </span>
          <span>Seen in this pane&apos;s output, not read from the account.</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
