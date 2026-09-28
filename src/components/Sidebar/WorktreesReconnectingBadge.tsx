import { Spinner } from "@/components/ui/Spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelativeTime } from "@/lib/formatRelativeTime";

/**
 * The worktree list's "Reconnecting…" mark beside the header. Past the
 * escalation threshold its words turn warning-toned and say, on hover, how
 * stale the list is; the spinner stays neutral, as every busy glyph does. Hidden from AT: the sidebar announces the edges itself.
 */
export function WorktreesReconnectingBadge({ escalatedSince }: { escalatedSince: number | null }) {
  return (
    <span
      aria-hidden="true"
      className="shrink-0"
      data-reconnect-escalated={escalatedSince !== null ? "true" : undefined}
    >
      {escalatedSince !== null ? (
        <Tooltip autoDismiss={false}>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1 whitespace-nowrap shrink-0 text-status-warning text-xs">
              <Spinner size="xs" className="text-text-secondary" />
              <span className="hidden @[16rem]/header:inline">Reconnecting…</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Last updated {formatRelativeTime(escalatedSince)}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="inline-flex items-center gap-1 whitespace-nowrap shrink-0 text-text-secondary text-xs">
          <Spinner size="xs" />
          <span className="hidden @[16rem]/header:inline">Reconnecting…</span>
        </span>
      )}
    </span>
  );
}
