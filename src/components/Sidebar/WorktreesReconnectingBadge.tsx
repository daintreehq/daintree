import { Spinner } from "@/components/ui/Spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { cn } from "@/lib/utils";

/**
 * The worktree list's "Reconnecting…" mark. Its words stay at every width: a
 * lone spinner beside "Worktrees" reads as loading, not as a lost link. Past
 * the escalation threshold the words step up to primary text and say, on
 * hover, how stale the list is; status-coloured text has no contrast floor
 * across the themes, and the spinner stays neutral, as every busy glyph does.
 */
function ReconnectingMark({ escalatedSince }: { escalatedSince: number | null }) {
  const mark = (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap shrink-0 text-xs",
        escalatedSince !== null ? "text-text-primary" : "text-text-secondary"
      )}
    >
      <Spinner size="xs" className="text-text-secondary" />
      <span>Reconnecting…</span>
    </span>
  );
  if (escalatedSince === null) return mark;
  return (
    <Tooltip autoDismiss={false}>
      <TooltipTrigger asChild>{mark}</TooltipTrigger>
      <TooltipContent side="bottom">
        Last updated {formatRelativeTime(escalatedSince)}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Beside the header's title, where the sidebar is wide enough for both.
 * Hidden from AT here and below: the sidebar announces the edges itself.
 */
export function WorktreesReconnectingBadge({ escalatedSince }: { escalatedSince: number | null }) {
  return (
    <span
      aria-hidden="true"
      className="hidden shrink-0 @[16rem]/sidebar:inline-flex"
      data-reconnect-escalated={escalatedSince !== null ? "true" : undefined}
    >
      <ReconnectingMark escalatedSince={escalatedSince} />
    </span>
  );
}

/** Under the header, where the sidebar is too narrow to hold it beside the title. */
export function WorktreesReconnectingRow({ escalatedSince }: { escalatedSince: number | null }) {
  return (
    <div aria-hidden="true" className="flex shrink-0 px-3 pb-2 @[16rem]/sidebar:hidden">
      <ReconnectingMark escalatedSince={escalatedSince} />
    </div>
  );
}
