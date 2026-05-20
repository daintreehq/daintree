import { ActivityLight } from "../ActivityLight";
import { CommitAuthorAvatar, type CommitAuthor } from "./CommitAuthorAvatar";

export interface CommitInfoTooltipProps {
  /** Timestamp of the last commit. */
  lastCommitTimestampMs: number;
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
  const committed = relativeTimePhrase(now - lastCommitTimestampMs);
  const committedAbsolute = new Date(lastCommitTimestampMs).toLocaleString();
  const hasActivity = lastActivityTimestamp != null && Number.isFinite(lastActivityTimestamp);

  return (
    <div className="flex w-[252px] flex-col">
      <div className="flex items-center gap-2.5">
        {author && <CommitAuthorAvatar author={author} forgeAvatarUrl={forgeAvatarUrl} size={32} />}
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-semibold text-daintree-text">
            {author ? author.name : "Last commit"}
          </span>
          <span className="text-[11px] text-text-muted" title={committedAbsolute}>
            Committed {committed}
          </span>
        </div>
      </div>

      {commitMessage && (
        <p className="mt-2.5 line-clamp-4 whitespace-pre-line border-t border-border-divider pt-2.5 text-xs leading-relaxed text-text-secondary">
          {commitMessage}
        </p>
      )}

      {hasActivity && (
        <div className="mt-2.5 flex items-center gap-1.5 border-t border-border-divider pt-2.5 text-[11px] text-text-muted">
          <ActivityLight lastActivityTimestamp={lastActivityTimestamp} className="h-1.5 w-1.5" />
          <span>Last active {relativeTimePhrase(now - lastActivityTimestamp!)}</span>
        </div>
      )}
    </div>
  );
}
