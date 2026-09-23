import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isValidPastTimestamp } from "@/utils/timestamps";
import { ActivityLight } from "../ActivityLight";
import { LiveTimeAgo } from "../LiveTimeAgo";
import type { CommitAuthor } from "./CommitAuthorAvatar";
import { CommitInfoTooltip } from "./CommitInfoTooltip";

export type { CommitAuthor };

export interface WorktreeActivityChipProps {
  /** Timestamp of the last commit, shown as supporting detail in the tooltip. */
  lastCommitTimestampMs?: number | null;
  /** Commit author. Surfaced in the hover tooltip, never in the row itself. */
  author?: CommitAuthor | null;
  /** Commit subject, shown in the hover tooltip. */
  commitMessage?: string;
  /** Commit body, shown clamped under the subject in the hover tooltip. */
  commitBody?: string;
  /** Full HEAD object id, shown abbreviated in the hover tooltip. */
  commitSha?: string;
  /** Forge profile picture, tried before Gravatar inside the tooltip. */
  forgeAvatarUrl?: string;
  /** Drives both the activity light and the adjacent relative time. */
  lastActivityTimestamp?: number | null;
}

export function WorktreeActivityChip({
  lastCommitTimestampMs,
  author,
  commitMessage,
  commitBody,
  commitSha,
  forgeAvatarUrl,
  lastActivityTimestamp,
}: WorktreeActivityChipProps) {
  const now = Date.now();
  const hasCommit = isValidPastTimestamp(lastCommitTimestampMs, now);
  const activityTimestamp = isValidPastTimestamp(lastActivityTimestamp, now)
    ? lastActivityTimestamp
    : hasCommit
      ? lastCommitTimestampMs
      : null;
  if (activityTimestamp === null) return null;

  return (
    <Tooltip autoDismiss={false}>
      <TooltipTrigger asChild>
        <div
          // The ring gets 2px of air so it frames the dot and the label
          // instead of cutting through them.
          className={cn(
            "relative z-10 ml-3 flex shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] text-xs text-text-secondary",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
          )}
          role="group"
          aria-label="Last activity"
          tabIndex={0}
        >
          <ActivityLight lastActivityTimestamp={activityTimestamp} className="h-1.5 w-1.5" />
          <LiveTimeAgo timestamp={activityTimestamp} noTooltip />
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="p-3">
        <CommitInfoTooltip
          lastCommitTimestampMs={lastCommitTimestampMs}
          author={author}
          commitMessage={commitMessage}
          commitBody={commitBody}
          commitSha={commitSha}
          forgeAvatarUrl={forgeAvatarUrl}
          lastActivityTimestamp={activityTimestamp}
        />
      </TooltipContent>
    </Tooltip>
  );
}
