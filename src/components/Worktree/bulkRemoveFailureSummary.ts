import { pluralize } from "@/lib/pluralize";

export interface BulkRemoveFailure {
  id: string;
  name: string;
  reason: string;
}

/** Entries named in the toast; the rest collapse into an "and N more" tail. */
export const MAX_LISTED_FAILURES = 3;
const MAX_REASON_LENGTH = 200;

function oneLine(reason: string): string {
  const flat = reason.replace(/\s+/g, " ").trim();
  return flat.length > MAX_REASON_LENGTH ? `${flat.slice(0, MAX_REASON_LENGTH - 1)}…` : flat;
}

/**
 * One string for the completion notification, because the toast and the inbox
 * row both render `message` as a single flowing line — entries are separated
 * with "; " rather than newlines. Callers order a kept ancestor after the
 * nested failure that caused it, so a capped list drops the echo before the cause.
 */
export function summarizeBulkRemoveFailures(failures: readonly BulkRemoveFailure[]): string {
  const listed = failures
    .slice(0, MAX_LISTED_FAILURES)
    .map((failure) => `${failure.name}: ${oneLine(failure.reason)}`);
  const hidden = failures.length - listed.length;
  if (hidden > 0) listed.push(`and ${hidden} more`);
  return listed.join("; ");
}

/** The failure count the screen reader hears next to the outcome title. */
export function describeBulkRemoveFailureCount(count: number): string {
  return `${pluralize(count, "worktree")} failed`;
}
