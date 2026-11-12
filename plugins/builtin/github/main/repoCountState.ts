import { repoCountStateCache } from "./GitHubCaches.js";
import type { RepoCountState, RepoStats } from "./types.js";

/**
 * Which open counts the stats path serves (#16866).
 *
 * The toolbar badge and the dropdown list used to come from reads that could
 * disagree: the list is a GraphQL page carrying the authoritative open
 * `totalCount`, while the background poll derives counts from REST
 * (`open_issues_count` minus the `/pulls` total), which can lag a close by
 * minutes. Whichever stamp was newer won, so a REST read straight after a
 * close put the old count back over the list the user was looking at.
 *
 * The state here is the one record the stats path serves from. GraphQL totals
 * enter it in the order their requests were sent; a REST pair only seeds a
 * kind the state doesn't hold yet or re-confirms the value it already holds,
 * and a disagreeing pair has to be confirmed by a GraphQL count read before it
 * can move it.
 */

export type CountKind = "issue" | "pr";

export function isValidOpenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function getRepoCountState(key: string): RepoCountState | undefined {
  return repoCountStateCache.get(key);
}

/**
 * Record a count read sent at `observedAt`. Refused, leaving the state as it
 * was, when the value isn't a count or the state already holds a read of that
 * kind sent later: a slow response must not roll a newer count back.
 */
export function observeRepoCount(
  key: string,
  kind: CountKind,
  value: number,
  observedAt: number
): boolean {
  if (!isValidOpenCount(value) || !Number.isFinite(observedAt)) return false;
  const state = repoCountStateCache.get(key);
  const existing = state?.[kind];
  if (existing && existing.observedAt > observedAt) return false;
  repoCountStateCache.set(key, { ...state, [kind]: { value, observedAt } });
  return true;
}

/** Restart the state's TTL without redating any count: a REST read agreed with it. */
export function touchRepoCountState(key: string): void {
  const state = repoCountStateCache.get(key);
  if (state) repoCountStateCache.set(key, state);
}

/**
 * The state's counts as a stats result, or `undefined` until it holds both:
 * a lone kind can't stand in for a whole poll answer.
 */
export function statsFromCountState(key: string, lastUpdated: number): RepoStats | undefined {
  const state = repoCountStateCache.get(key);
  if (!state?.issue || !state.pr) return undefined;
  return {
    issueCount: state.issue.value,
    prCount: state.pr.value,
    lastUpdated,
    issueCountRefreshedAt: state.issue.observedAt,
    prCountRefreshedAt: state.pr.observedAt,
  };
}

/**
 * `stats` with every count the state holds put in its place. A stale result
 * (a disk fallback) keeps its lack of per-count stamps: it is still not a
 * read, only a better guess at what the last one said.
 */
export function withRepoCountState(key: string, stats: RepoStats): RepoStats {
  const state = repoCountStateCache.get(key);
  if (!state) return stats;
  const next: RepoStats = { ...stats };
  if (state.issue) {
    next.issueCount = state.issue.value;
    if (!stats.stale) next.issueCountRefreshedAt = state.issue.observedAt;
  }
  if (state.pr) {
    next.prCount = state.pr.value;
    if (!stats.stale) next.prCountRefreshedAt = state.pr.observedAt;
  }
  return next;
}
