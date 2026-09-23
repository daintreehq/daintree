import { ActivityLight } from "../ActivityLight";
import { isValidPastTimestamp } from "@/utils/timestamps";
import { parseCommitBody } from "@/utils/commitMessage";
import { CommitAuthorAvatar, type CommitAuthor } from "./CommitAuthorAvatar";

export interface CommitInfoTooltipProps {
  /** Timestamp of the last commit. */
  lastCommitTimestampMs?: number | null;
  /** Commit author. When absent the byline shows the time only. */
  author?: CommitAuthor | null;
  /** Commit subject, the card's headline. */
  commitMessage?: string;
  /** Commit body, trailers included; the trailers are lifted into the byline. */
  commitBody?: string;
  /** Full HEAD object id; shown abbreviated. */
  commitSha?: string;
  /** Forge profile picture, tried before Gravatar. */
  forgeAvatarUrl?: string;
  /** Drives the "Last active" footer line and its decay dot. */
  lastActivityTimestamp?: number | null;
}

const DAY_MS = 86_400_000;
// Same cut-over as `LiveTimeAgo`, so the card never says "156 weeks ago"
// beside a chip that already reads "24 Sept 2023".
const ABSOLUTE_AFTER_MS = 30 * DAY_MS;

let absoluteDateFormatter: Intl.DateTimeFormat | undefined;

/**
 * When something happened, as a phrase that reads after a verb: "just now",
 * "2 minutes ago", "3 weeks ago", then "on 24 Sept 2023" past 30 days.
 */
export function relativeTimePhrase(diffMs: number, timestampMs?: number): string {
  const s = Math.floor(Math.max(0, diffMs) / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (s < 60) return "just now";
  if (m < 60) return `${m} minute${m !== 1 ? "s" : ""} ago`;
  if (h < 24) return `${h} hour${h !== 1 ? "s" : ""} ago`;
  if (d < 7) return `${d} day${d !== 1 ? "s" : ""} ago`;
  if (diffMs < ABSOLUTE_AFTER_MS || timestampMs === undefined) {
    const w = Math.floor(d / 7);
    return `${w} week${w !== 1 ? "s" : ""} ago`;
  }
  absoluteDateFormatter ??= new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  return `on ${absoluteDateFormatter.format(new Date(timestampMs))}`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

/**
 * Detailed commit card shown on hover of a worktree row's activity chip and
 * the Details footer. Leads with what the commit did; who and when follow in
 * a byline. The row itself stays a quiet dot, and faces only appear here.
 *
 * Read-only by construction: it renders inside a `role="tooltip"`, which may
 * not hold anything focusable, so the SHA is text rather than a copy button.
 */
export function CommitInfoTooltip({
  lastCommitTimestampMs,
  author,
  commitMessage,
  commitBody,
  commitSha,
  forgeAvatarUrl,
  lastActivityTimestamp,
}: CommitInfoTooltipProps) {
  const now = Date.now();
  const hasCommit = isValidPastTimestamp(lastCommitTimestampMs, now);
  const hasActivity = isValidPastTimestamp(lastActivityTimestamp, now);
  if (!hasCommit && !hasActivity) return null;

  const committed = hasCommit
    ? relativeTimePhrase(now - lastCommitTimestampMs, lastCommitTimestampMs)
    : null;
  const activityPhrase = hasActivity
    ? relativeTimePhrase(now - lastActivityTimestamp, lastActivityTimestamp)
    : null;
  // Only activity *after* the commit is news; an older activity stamp would
  // read as the branch going quiet before its own latest commit.
  const showActivity = hasActivity && (!hasCommit || lastActivityTimestamp > lastCommitTimestampMs);

  const subject = commitMessage?.trim();
  const { text: body, coAuthors } = parseCommitBody(commitBody);
  const shortSha = commitSha?.slice(0, 7);
  const coAuthorLine =
    coAuthors.length > 0 ? `with ${joinNames(coAuthors.map((p) => p.name))}` : null;

  return (
    <div className="flex w-72 flex-col">
      {hasCommit && (subject || body) && (
        <div className="mb-2.5 flex flex-col gap-1.5 border-b border-border-divider pb-2.5">
          {subject && (
            <p className="line-clamp-3 break-words text-xs font-semibold leading-snug text-text-primary">
              {subject}
            </p>
          )}
          {body && (
            <p className="line-clamp-4 whitespace-pre-line break-words text-xs leading-relaxed text-text-secondary">
              {body}
            </p>
          )}
        </div>
      )}

      {hasCommit && (
        <div className="flex items-center gap-2.5">
          {author && (
            <CommitAuthorAvatar author={author} forgeAvatarUrl={forgeAvatarUrl} size={24} />
          )}
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-xs font-medium text-text-primary">
              {author ? author.name : "Last commit"}
            </span>
            {coAuthorLine && (
              <span
                className="truncate text-2xs text-text-secondary"
                title={coAuthors.map((p) => p.name).join(", ")}
              >
                {coAuthorLine}
              </span>
            )}
            <span className="flex min-w-0 items-center gap-1.5 text-2xs text-text-secondary">
              <time
                dateTime={new Date(lastCommitTimestampMs).toISOString()}
                title={new Date(lastCommitTimestampMs).toLocaleString()}
                className="shrink-0"
              >
                Committed {committed}
              </time>
              {shortSha && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums" title={commitSha}>
                    {shortSha}
                  </span>
                </>
              )}
            </span>
          </div>
        </div>
      )}

      {showActivity && (
        <div className={hasCommit ? "mt-2.5 border-t border-border-divider pt-2.5" : undefined}>
          <div className="flex items-center gap-1.5 text-2xs text-text-secondary">
            <ActivityLight lastActivityTimestamp={lastActivityTimestamp} className="h-1.5 w-1.5" />
            <time
              dateTime={new Date(lastActivityTimestamp).toISOString()}
              title={new Date(lastActivityTimestamp).toLocaleString()}
            >
              Last active {activityPhrase}
            </time>
          </div>
        </div>
      )}
    </div>
  );
}
