import type { Issue } from "../../shared/types/forge.js";

/**
 * A number the forge says doesn't exist is asked about again after 5, 10 and
 * 20 minutes, then every 30. Some of those answers are wrong (a private issue,
 * a token without access yet, an issue created after the branch), so the
 * number keeps being retried, just not on every 30–90s poll: for Beads a miss
 * means paging through the whole bead list.
 */
const MISSING_RETRY_BASE_MS = 5 * 60_000;
const MISSING_RETRY_CAP_MS = 30 * 60_000;
/** A failed lookup says nothing about the issue, so it backs off more gently. */
const ERROR_RETRY_BASE_MS = 60_000;
const ERROR_RETRY_CAP_MS = 5 * 60_000;
/** Distinct issue identities remembered at once; the oldest goes first. */
const MAX_ENTRIES = 256;

export type IssueLookupResult =
  | { kind: "found"; issue: Issue }
  /** `cached`: answered from an earlier lookup's verdict, without a request. */
  | { kind: "missing"; cached: boolean }
  | { kind: "error" }
  /** Backing off after a failed lookup; there is nothing to report. */
  | { kind: "deferred" };

interface Entry {
  inflight: Promise<IssueLookupResult> | null;
  last: "missing" | "error" | null;
  missingAttempts: number;
  errorAttempts: number;
  retryAt: number;
}

function backoff(attempts: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempts - 1));
}

/**
 * Shares one issue lookup between every worktree asking about the same issue,
 * and holds back a number the forge didn't find (or couldn't look up) until its
 * retry time instead of asking again on every poll. The caller owns delivery:
 * each worktree checks that its own binding still matches before acting on a
 * shared answer.
 */
export class IssueLookupCoalescer {
  private readonly entries = new Map<string, Entry>();
  private epoch = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Bumped by {@link clear}. A lookup that started before it is never joined
   * afterwards and its verdict is not remembered.
   */
  get generation(): number {
    return this.epoch;
  }

  lookup(key: string, request: () => Promise<Issue | null>): Promise<IssueLookupResult> {
    const existing = this.entries.get(key);
    if (existing?.inflight) return existing.inflight;
    if (existing && this.now() < existing.retryAt) {
      return Promise.resolve(
        existing.last === "missing" ? { kind: "missing", cached: true } : { kind: "deferred" }
      );
    }

    const entry: Entry = existing ?? {
      inflight: null,
      last: null,
      missingAttempts: 0,
      errorAttempts: 0,
      retryAt: 0,
    };
    const epoch = this.epoch;
    const inflight = Promise.resolve()
      .then(request)
      .then(
        (issue): IssueLookupResult =>
          issue ? { kind: "found", issue } : { kind: "missing", cached: false },
        (): IssueLookupResult => ({ kind: "error" })
      )
      .then((result) => {
        if (epoch === this.epoch && this.entries.get(key) === entry)
          this.record(key, entry, result);
        return result;
      })
      .finally(() => {
        if (entry.inflight === inflight) entry.inflight = null;
        // Entries in flight can't be evicted, so a burst can leave the map over
        // its bound until they settle.
        this.trim();
      });
    entry.inflight = inflight;
    this.remember(key, entry);
    return inflight;
  }

  /**
   * Make every remembered verdict due now, keeping lookups already in flight.
   * For an explicit refresh: nothing about the provider changed, so a pending
   * answer is still worth delivering.
   */
  forgetVerdicts(): void {
    for (const [key, entry] of this.entries) {
      if (!entry.inflight) this.entries.delete(key);
    }
  }

  /** Forget every verdict and detach every pending lookup from later callers. */
  clear(): void {
    this.epoch += 1;
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private record(key: string, entry: Entry, result: IssueLookupResult): void {
    const now = this.now();
    switch (result.kind) {
      case "found":
        this.entries.delete(key);
        return;
      case "missing":
        entry.missingAttempts += 1;
        entry.errorAttempts = 0;
        entry.last = "missing";
        entry.retryAt =
          now + backoff(entry.missingAttempts, MISSING_RETRY_BASE_MS, MISSING_RETRY_CAP_MS);
        return;
      case "error":
        entry.errorAttempts += 1;
        entry.last = "error";
        entry.retryAt = now + backoff(entry.errorAttempts, ERROR_RETRY_BASE_MS, ERROR_RETRY_CAP_MS);
        return;
      case "deferred":
        return;
    }
  }

  private remember(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.trim();
  }

  private trim(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    for (const [oldestKey, oldest] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES) break;
      if (oldest.inflight) continue;
      this.entries.delete(oldestKey);
    }
  }
}
