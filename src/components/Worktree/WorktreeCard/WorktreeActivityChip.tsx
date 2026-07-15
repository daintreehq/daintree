import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  /** Forge profile picture, tried before Gravatar inside the tooltip. */
  forgeAvatarUrl?: string;
  /** Drives both the activity light and the adjacent relative time. */
  lastActivityTimestamp?: number | null;
}

export function WorktreeActivityChip({
  lastCommitTimestampMs,
  author,
  commitMessage,
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
          className="relative z-10 ml-3 flex shrink-0 items-center gap-1.5 text-xs text-text-muted"
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
          forgeAvatarUrl={forgeAvatarUrl}
          lastActivityTimestamp={activityTimestamp}
        />
      </TooltipContent>
    </Tooltip>
  );
}
