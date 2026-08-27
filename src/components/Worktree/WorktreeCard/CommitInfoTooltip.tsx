import { ActivityLight } from "../ActivityLight";
import { isValidPastTimestamp } from "@/utils/timestamps";
import { CommitAuthorAvatar, type CommitAuthor } from "./CommitAuthorAvatar";

export interface CommitInfoTooltipProps {
  /** Timestamp of the last commit. */
  lastCommitTimestampMs?: number | null;
  /** Commit author. When absent the header shows the time only. */
  author?: CommitAuthor | null;
  /** Commit subject/body, shown beneath the header. */
  commitMessage?: string;
  /** Forge profile picture, tried before Gravatar. */
  forgeAvatarUrl?: string;
  /** Drives the "Last active" footer line and its decay dot. */
  lastActivityTimestamp?: number | null;
}

/** Long-form relative phrase — "just now", "2 minutes ago", "3 days ago". */
export function relativeTimePhrase(diffMs: number): string {
  const s = Math.floor(Math.max(0, diffMs) / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (s < 60) return "just now";
  if (m < 60) return `${m} minute${m !== 1 ? "s" : ""} ago`;
  if (h < 24) return `${h} hour${h !== 1 ? "s" : ""} ago`;
  if (d < 7) return `${d} day${d !== 1 ? "s" : ""} ago`;
  const w = Math.floor(d / 7);
  return `${w} week${w !== 1 ? "s" : ""} ago`;
}

/**
 * Detailed commit card shown on hover of a worktree row's activity chip and
 * inside the expanded details. Replaces the per-row avatar — the row itself
 * stays a quiet dot, and the face only appears here where there is room to
 * review it.
 */
export function CommitInfoTooltip({
  lastCommitTimestampMs,
  author,
  commitMessage,
  forgeAvatarUrl,
  lastActivityTimestamp,
}: CommitInfoTooltipProps) {
  const now = Date.now();
  const hasCommit = isValidPastTimestamp(lastCommitTimestampMs, now);
  const hasActivity = isValidPastTimestamp(lastActivityTimestamp, now);
  if (!hasCommit && !hasActivity) return null;

  const committed = hasCommit ? relativeTimePhrase(now - lastCommitTimestampMs) : null;
  const committedAbsolute = hasCommit ? new Date(lastCommitTimestampMs).toLocaleString() : null;
  const activityPhrase = hasActivity ? relativeTimePhrase(now - lastActivityTimestamp) : null;
  const activityAbsolute = hasActivity ? new Date(lastActivityTimestamp).toLocaleString() : null;
  const activityMatchesCommit =
    hasCommit && hasActivity && lastActivityTimestamp === lastCommitTimestampMs;

  return (
    <div className="flex w-[252px] flex-col">
      {hasCommit && (
        <div className="flex items-center gap-2.5">
          {author && (
            <CommitAuthorAvatar author={author} forgeAvatarUrl={forgeAvatarUrl} size={32} />
          )}
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-xs font-semibold text-text-primary">
              {author ? author.name : "Last commit"}
            </span>
            <span className="text-2xs text-text-muted" title={committedAbsolute!}>
              Committed {committed}
            </span>
          </div>
        </div>
      )}

      {hasCommit && commitMessage && (
        <p className="mt-2.5 line-clamp-4 whitespace-pre-line border-t border-border-divider pt-2.5 text-xs leading-relaxed text-text-secondary">
          {commitMessage}
        </p>
      )}

      {hasActivity && !activityMatchesCommit && (
        <div className={hasCommit ? "mt-2.5 border-t border-border-divider pt-2.5" : undefined}>
          <div className="flex items-center gap-1.5 text-2xs text-text-muted">
            <ActivityLight lastActivityTimestamp={lastActivityTimestamp} className="h-1.5 w-1.5" />
            <span title={activityAbsolute!}>Last active {activityPhrase}</span>
          </div>
        </div>
      )}
    </div>
  );
}
