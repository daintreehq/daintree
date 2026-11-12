import { Cache } from "../../../../electron/utils/cache.js";
import type { RepoStats } from "./types.js";

/**
 * The open issue and PR counts this host stands behind for each repository,
 * one held count per kind (#16866).
 *
 * GraphQL reads the same connections the dropdown lists (a list query's
 * `totalCount`, the explicit-refresh stats query, the poll's scalar confirm),
 * so a count it reports replaces the held one. The background poll's REST pair
 * is only the cheap change detector: both of its endpoints can trail a close,
 * and the issue count is the difference of the two, so a pull request closing
 * can read as an issue opening. A REST reading that disagrees with a held count
 * never moves it on its own; the poll asks GraphQL to settle it. Every count
 * the poll serves (a fresh read, an unchanged-probe replay, a snapshot) is
 * drawn from here once one is held.
 */

export type CountKind = "issue" | "pr";

export interface HeldCount {
  count: number;
  /** When the read behind it was issued, so a slower, older read can't replace it. */
  readAt: number;
  /** When it was last read or confirmed: the refreshed-at stamp the toolbar ranks it by. */
  refreshedAt: number;
}

type RepoHeldCounts = Partial<Record<CountKind, HeldCount>>;

// Outlives every cache that feeds it; a repository that ages out starts again
// from its next reading.
const HELD_COUNT_TTL_MS = 24 * 60 * 60 * 1000;

const heldCounts = new Cache<string, RepoHeldCounts>({
  maxSize: 50,
  defaultTTL: HELD_COUNT_TTL_MS,
});

const KINDS: readonly CountKind[] = ["issue", "pr"];

type CountPair = Pick<RepoStats, "issueCount" | "prCount">;

function countOf(pair: CountPair, kind: CountKind): number {
  return kind === "issue" ? pair.issueCount : pair.prCount;
}

let lastReadStamp = 0;

/**
 * When a read is being issued, as epoch ms strictly later than every stamp
 * handed out before it: two reads issued in the same millisecond still order
 * the way they were issued, so the later one's count is the one held.
 */
export function issueReadStamp(): number {
  const now = Date.now();
  lastReadStamp = now > lastReadStamp ? now : lastReadStamp + 0.001;
  return lastReadStamp;
}

export function getHeldCount(repoKey: string, kind: CountKind): HeldCount | undefined {
  return heldCounts.get(repoKey)?.[kind];
}

/**
 * Hold a count GraphQL just read, unless a read issued after it already
 * landed. Returns whether it is now the held count.
 */
export function holdObservedCount(
  repoKey: string,
  kind: CountKind,
  count: number,
  readAt: number,
  now: number = Date.now()
): boolean {
  const entry = heldCounts.get(repoKey) ?? {};
  const held = entry[kind];
  if (held && held.readAt > readAt) return false;
  heldCounts.set(repoKey, { ...entry, [kind]: { count, readAt, refreshedAt: now } });
  return true;
}

/** The kinds on which a REST reading disagrees with the held count. */
export function restDisagreements(repoKey: string, reading: CountPair): CountKind[] {
  const entry = heldCounts.get(repoKey);
  return KINDS.filter((kind) => {
    const held = entry?.[kind];
    return held !== undefined && held.count !== countOf(reading, kind);
  });
}

/**
 * Take what a REST reading can say on its own: a count where none is held, and
 * a fresh stamp where it agrees with the held count. A disagreeing count is
 * GraphQL's to settle.
 */
export function holdRestCounts(
  repoKey: string,
  reading: CountPair,
  readAt: number,
  refreshedAt: number
): void {
  const entry: RepoHeldCounts = { ...heldCounts.get(repoKey) };
  for (const kind of KINDS) {
    const count = countOf(reading, kind);
    const held = entry[kind];
    if (held === undefined) {
      entry[kind] = { count, readAt, refreshedAt };
    } else if (held.count === count && readAt >= held.readAt) {
      entry[kind] = { count, readAt, refreshedAt: Math.max(held.refreshedAt, refreshedAt) };
    }
  }
  heldCounts.set(repoKey, entry);
}

/**
 * `stats` with the held counts in place of its own. Where they agree, the
 * later of the two stamps stands, since either read confirmed the count.
 */
export function withHeldCounts(repoKey: string, stats: RepoStats): RepoStats {
  const entry = heldCounts.get(repoKey);
  if (!entry) return stats;
  const result: RepoStats = { ...stats };
  const issue = entry.issue;
  if (issue) {
    result.issueCountRefreshedAt =
      issue.count === stats.issueCount
        ? Math.max(issue.refreshedAt, stats.issueCountRefreshedAt ?? 0)
        : issue.refreshedAt;
    result.issueCount = issue.count;
  }
  const pr = entry.pr;
  if (pr) {
    result.prCountRefreshedAt =
      pr.count === stats.prCount
        ? Math.max(pr.refreshedAt, stats.prCountRefreshedAt ?? 0)
        : pr.refreshedAt;
    result.prCount = pr.count;
  }
  return result;
}

/** Whether a held count says `pair` is out of date. */
export function heldCountsDisagree(repoKey: string, pair: CountPair): boolean {
  return restDisagreements(repoKey, pair).length > 0;
}

// The read stamp survives a clear: a read issued before it may still land, and
// must not outrank one issued after.
export function clearHeldCounts(): void {
  heldCounts.clear();
}

/** Test-only: start the read stamps again from the clock. */
export function _resetReadStampForTests(): void {
  lastReadStamp = 0;
}
