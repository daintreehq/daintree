import { RefreshCw } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelativeTime } from "@/lib/formatRelativeTime";

/**
 * The worktree list's "Reconnecting…" mark beside the header. Past the
 * escalation threshold it turns warning-toned and says, on hover, how stale
 * the list is. Hidden from AT: the sidebar announces the edges itself.
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
              <span className="inline-flex shrink-0 animate-spin motion-reduce:animate-none">
                <RefreshCw className="w-3 h-3" aria-hidden="true" />
              </span>
              <span className="hidden @[16rem]/header:inline">Reconnecting…</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Last updated {formatRelativeTime(escalatedSince)}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="inline-flex items-center gap-1 whitespace-nowrap shrink-0 text-text-secondary text-xs">
          <span className="inline-flex shrink-0 animate-spin motion-reduce:animate-none">
            <RefreshCw className="w-3 h-3" aria-hidden="true" />
          </span>
          <span className="hidden @[16rem]/header:inline">Reconnecting…</span>
        </span>
      )}
    </span>
  );
}
