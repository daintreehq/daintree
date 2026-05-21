import { ActivityLight } from "../ActivityLight";
import { LiveTimeAgo } from "../LiveTimeAgo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CommitInfoTooltip } from "./CommitInfoTooltip";
import type { CommitAuthor } from "./CommitAuthorAvatar";

export type { CommitAuthor };

export interface CommitChipProps {
  /** Timestamp of the last commit. The chip's relative time always shows this. */
  lastCommitTimestampMs: number;
  /** Commit author. Surfaced in the hover tooltip, never in the row itself. */
  author?: CommitAuthor | null;
  /** Commit subject, shown in the hover tooltip. */
  commitMessage?: string;
  /** Forge profile picture, tried before Gravatar inside the tooltip. */
  forgeAvatarUrl?: string;
  /**
   * Drives the activity dot — a tiny light that fades from accent to idle
   * over the decay window. When absent no dot renders, just the time.
   */
  lastActivityTimestamp?: number | null;
}

/**
 * Trailing chip for a worktree row: a tiny activity dot plus the last-commit
 * relative time. The committer's face is intentionally absent here — a wall
 * of repeated avatars across many rows is noise. The full detail (avatar,
 * author, commit message, last-active time) lives in the hover tooltip.
 */
export function CommitChip({
  lastCommitTimestampMs,
  author,
  commitMessage,
  forgeAvatarUrl,
  lastActivityTimestamp,
}: CommitChipProps) {
  const accessibleName = author ? `Last commit by ${author.name}` : "Last commit";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="relative z-10 ml-3 flex shrink-0 items-center gap-1.5 text-xs text-text-muted"
          aria-label={accessibleName}
        >
          <ActivityLight lastActivityTimestamp={lastActivityTimestamp} className="h-1.5 w-1.5" />
          <LiveTimeAgo timestamp={lastCommitTimestampMs} noTooltip />
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="p-3">
        <CommitInfoTooltip
          lastCommitTimestampMs={lastCommitTimestampMs}
          author={author}
          commitMessage={commitMessage}
          forgeAvatarUrl={forgeAvatarUrl}
          lastActivityTimestamp={lastActivityTimestamp}
        />
      </TooltipContent>
    </Tooltip>
  );
}
