import type { StagingStatus } from "@shared/types";

// Last staging status per worktree. The hub resets on close, so without this
// every open showed the skeleton until `getStagingStatus` answered; with it a
// reopen — or an open the Review button's hover already warmed — paints the
// last known file list at once and the open-time refresh replaces it. Kept out
// of the hub's lazy chunk so the worktree card can warm it.
//
// Reads can finish out of order (a hover prefetch outliving the hub's own
// read, an abandoned read landing late), so each one takes a sequence number
// when it starts and only a read newer than the stored one may replace it.
const cache = new Map<string, { status: StagingStatus; seq: number }>();
const inFlight = new Map<string, Promise<StagingStatus | null>>();
const CACHE_LIMIT = 16;
let readSeq = 0;
let generation = 0;

/** Take a sequence number for a read that is about to start. */
export function beginStagingStatusRead(): number {
  readSeq += 1;
  return readSeq;
}

export function getCachedStagingStatus(worktreePath: string): StagingStatus | null {
  return cache.get(worktreePath)?.status ?? null;
}

/** Store a read's result unless a read that started later already has. */
export function rememberStagingStatus(
  worktreePath: string,
  status: StagingStatus,
  seq: number
): void {
  const existing = cache.get(worktreePath);
  if (existing && existing.seq > seq) return;
  cache.delete(worktreePath);
  cache.set(worktreePath, { status, seq });
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * Read the staging status ahead of a likely open (pointer landing on the
 * Review button). Local git only, and deduped while a read is in flight, so a
 * fly-by hover costs one status pass at most.
 */
export function prefetchStagingStatus(worktreePath: string): Promise<StagingStatus | null> {
  const pending = inFlight.get(worktreePath);
  if (pending) return pending;
  const seq = beginStagingStatusRead();
  const startedIn = generation;
  const request: Promise<StagingStatus | null> = window.electron.git
    .getStagingStatus(worktreePath)
    .then(
      (status) => {
        if (startedIn === generation) rememberStagingStatus(worktreePath, status, seq);
        return status;
      },
      () => null
    )
    .finally(() => {
      if (inFlight.get(worktreePath) === request) inFlight.delete(worktreePath);
    });
  inFlight.set(worktreePath, request);
  return request;
}

/** Test seam: the cache is module state and would otherwise leak across cases. */
export function resetStagingStatusCacheForTests(): void {
  cache.clear();
  inFlight.clear();
  generation += 1;
}
