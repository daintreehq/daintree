import type { SimpleGit } from "simple-git";
import { logDebug } from "./logger.js";

/** Tab, so it can't collide with anything git allows inside a refname. */
const FIELD_SEPARATOR = "\t";

/**
 * Keyed by FULL refname (`refs/heads/foo`, `refs/remotes/origin/foo`), never the
 * short name: a local branch literally called `origin/foo` and the remote-tracking
 * `refs/remotes/origin/foo` share the short name `origin/foo`, so short keys would
 * hand one branch the other's date.
 */
export type BranchCommitterDates = ReadonlyMap<string, string>;

export function parseBranchCommitterDates(raw: string | undefined | null): Map<string, string> {
  const dates = new Map<string, string>();
  if (!raw) return dates;

  for (const line of raw.split("\n")) {
    const separator = line.indexOf(FIELD_SEPARATOR);
    if (separator <= 0) continue;
    const ref = line.slice(0, separator).trim();
    const date = line.slice(separator + 1).trim();
    if (!ref || !date) continue;
    dates.set(ref, date);
  }

  return dates;
}

/**
 * One `for-each-ref` spawn for every branch tip's committer date. Best-effort by
 * design: the branch list itself must still render when this fails, so every
 * failure resolves to an empty map instead of rejecting. Deliberately does NOT
 * compute ahead/behind — that needs a merge-base walk per branch, i.e. one
 * subprocess per row.
 */
export async function readBranchCommitterDates(
  git: Pick<SimpleGit, "raw">
): Promise<Map<string, string>> {
  try {
    const raw = await git.raw([
      "for-each-ref",
      `--format=%(refname)${FIELD_SEPARATOR}%(committerdate:iso-strict)`,
      "refs/heads",
      "refs/remotes",
    ]);
    return parseBranchCommitterDates(raw);
  } catch (error) {
    logDebug("Failed to read branch committer dates", { error: (error as Error).message });
    return new Map();
  }
}

/** `refs/heads/foo` for a local branch, `refs/remotes/origin/foo` for a remote one. */
export function branchRefName(displayName: string, isRemote: boolean): string {
  return isRemote ? `refs/remotes/${displayName}` : `refs/heads/${displayName}`;
}
