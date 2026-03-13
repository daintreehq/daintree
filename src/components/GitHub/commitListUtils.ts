import type { GitCommit } from "@shared/types/github";

export interface ParsedCommit {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
}

const CONVENTIONAL_COMMIT_RE = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/;

export function parseConventionalCommit(message: string): ParsedCommit | null {
  const header = message.split("\n")[0];
  const match = header.match(CONVENTIONAL_COMMIT_RE);
  if (!match) return null;
  const [, type, scope, breakingMark, description] = match;
  const trimmedScope = scope?.trim() || null;
  return { type, scope: trimmedScope, breaking: !!breakingMark, description };
}

function dayMidnightMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export type DateGroupLabel = "Today" | "Yesterday" | "This Week" | string;

export function getCommitDateGroupLabel(dateString: string, now?: Date): DateGroupLabel {
  const commitDate = new Date(dateString);
  if (isNaN(commitDate.getTime())) return "Unknown";
  const ref = now ?? new Date();
  const commitMidnight = dayMidnightMs(commitDate);
  const todayMidnight = dayMidnightMs(ref);
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (commitMidnight >= todayMidnight) return "Today";
  if (commitMidnight === todayMidnight - oneDayMs) return "Yesterday";
  if (commitMidnight >= todayMidnight - 6 * oneDayMs) return "This Week";

  const sameYear = commitDate.getUTCFullYear() === ref.getUTCFullYear();
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(commitDate);
}

export type CommitRow =
  | { kind: "separator"; label: string }
  | { kind: "commit"; commit: GitCommit };

export function buildGroupedRows(commits: GitCommit[], now?: Date): CommitRow[] {
  const rows: CommitRow[] = [];
  let currentLabel: string | null = null;

  for (const commit of commits) {
    const label = getCommitDateGroupLabel(commit.date, now);
    if (label !== currentLabel) {
      rows.push({ kind: "separator", label });
      currentLabel = label;
    }
    rows.push({ kind: "commit", commit });
  }

  return rows;
}
