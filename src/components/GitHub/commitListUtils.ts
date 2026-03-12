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

const COMMIT_TYPE_COLORS: Record<string, string> = {
  feat: "text-category-green",
  fix: "text-category-rose",
  docs: "text-category-teal",
  style: "text-category-purple",
  refactor: "text-category-purple",
  perf: "text-category-amber",
  test: "text-category-cyan",
  chore: "text-muted-foreground",
  build: "text-muted-foreground",
  ci: "text-muted-foreground",
  revert: "text-category-orange",
};

export function getCommitTypeColor(type: string): string {
  return COMMIT_TYPE_COLORS[type.toLowerCase()] ?? "text-muted-foreground";
}

function dayMidnightMs(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export type DateGroupLabel = "Today" | "Yesterday" | "This Week" | string;

export function getCommitDateGroupLabel(dateString: string, now?: Date): DateGroupLabel {
  const commitDate = new Date(dateString);
  const ref = now ?? new Date();
  const commitMidnight = dayMidnightMs(commitDate);
  const todayMidnight = dayMidnightMs(ref);
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (commitMidnight === todayMidnight) return "Today";
  if (commitMidnight === todayMidnight - oneDayMs) return "Yesterday";
  if (commitMidnight >= todayMidnight - 6 * oneDayMs) return "This Week";

  const sameYear = commitDate.getFullYear() === ref.getFullYear();
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
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
