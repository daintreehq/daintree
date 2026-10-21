import { TriangleAlert } from "@/components/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import {
  RATE_LIMIT_OBSERVATION_TTL_MS,
  isRateLimitObservationLive,
  useRateLimitObservationStore,
} from "@/store/rateLimitObservationStore";
import { formatRateLimitCountdownCoarse } from "@/components/Layout/RateLimitDetails";
import { formatTimeAgo } from "@/utils/timeAgo";
import { cn } from "@/lib/utils";
import {
  HEADER_CHIP_CLASS,
  HEADER_CHIP_FOCUS_CLASS,
  HEADER_CHIP_SURFACE,
} from "./terminalHeaderChip";

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
  // The body is guidance to read, not a hint, so it stays while hovered.
  return (
    <Tooltip autoDismiss={false} disableHoverableContent={false}>
      <TooltipTrigger asChild>
        <div
          className={cn(
            HEADER_CHIP_CLASS,
            HEADER_CHIP_SURFACE,
            HEADER_CHIP_FOCUS_CLASS,
            "text-status-warning"
          )}
          role="status"
          aria-live="off"
          tabIndex={0}
          data-testid="terminal-rate-limit-badge"
        >
          <TriangleAlert className="w-3 h-3 shrink-0" aria-hidden="true" />
          {/* Warning ink stays on the glyph; the label needs the primary ramp to
              hold 4.5:1 on the light themes. Yields first on a narrow header. */}
          <span className="text-text-primary @max-[420px]/header:sr-only">Rate limit reported</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">
            Agent printed a rate-limit message {formatTimeAgo(observedAt, now)}
          </span>
          {/* The chip's own retention, never the provider's reset: nothing here
              reads when the limit lifts, so the user is pointed at the message. */}
          <span>Check that message for when the limit resets</span>
          <span>
            This chip clears in{" "}
            {formatRateLimitCountdownCoarse(observedAt + RATE_LIMIT_OBSERVATION_TTL_MS - now)}
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
