import type { Issue, PR } from "@shared/types/forge";
import { TtlCache } from "@/utils/ttlCache";

/**
 * Renderer cache for normalized forge issue/PR list pages, shared by the
 * toolbar stats pipeline (push-priming, cold-start hydration, hover prefetch)
 * and the plugin-contributed dropdown lists. Keys on
 * `${projectPath}:${type}:${filterState}:${sortOrder}` — each WebContentsView
 * is its own renderer process, so per-view isolation is structural and the
 * project path uniquely identifies the repo within a view.
 *
 * The 45s TTL is held strictly below the backend list-cache TTL (60s) so the
 * renderer cache cannot stack on top of the backend cache and serve
 * doubly-stale data (#4174). The generation map discards stale in-flight
 * responses when a slot is refetched or mutated.
 */
export interface ForgeResourceCacheEntry {
  items: (Issue | PR)[];
  nextCursor: string | null;
  hasMore: boolean;
  timestamp: number;
  /**
   * Wall-clock ms of the last write that came from a request which actually
   * sent `bypassCache: true` (hover prefetch, SWR bypass revalidate). Distinct
   * from `timestamp`: broadcast-seeded entries carry a fresh `timestamp` over
   * content that may be a re-stamped main-process snapshot, so only this field
   * may gate "skip the open-time revalidate, the data just came from the forge".
   */
  freshBypassAt?: number;
  /**
   * The server-reported open total for this entry's resource type at write
   * time. The cheap REST count poll compares its fresh counts against this to
   * mark the entry stale (`markCountStale`) — the count-as-cache-buster signal.
   * Only meaningful on `open`-filter slots; undefined when the write had no
   * authoritative total.
   */
  countAtWrite?: number;
  /**
   * Set when a fresh count poll observed a different open count than
   * `countAtWrite` — rows are still shown (SWR), but the open-time revalidate
   * must not be downgraded to a cached read. Cleared implicitly by the next
   * full entry write.
   */
  stale?: boolean;
}

const CACHE_MAX_SIZE = 20;
const CACHE_TTL_MS = 45 * 1000;

const cache = new TtlCache<string, ForgeResourceCacheEntry>(CACHE_MAX_SIZE, CACHE_TTL_MS);
const generationMap = new Map<string, number>();

export function buildCacheKey(
  projectPath: string,
  type: string,
  filterState: string,
  sortOrder: string
): string {
  return `${projectPath}:${type}:${filterState}:${sortOrder}`;
}

export function getCache(key: string): ForgeResourceCacheEntry | undefined {
  return cache.get(key);
}

export function setCache(key: string, entry: ForgeResourceCacheEntry): void {
  cache.set(key, entry);
}

export function nextGeneration(key: string): number {
  const gen = (generationMap.get(key) ?? 0) + 1;
  if (!generationMap.has(key) && generationMap.size >= CACHE_MAX_SIZE) {
    const oldest = generationMap.keys().next().value;
    if (oldest !== undefined) generationMap.delete(oldest);
  }
  generationMap.set(key, gen);
  return gen;
}

export function getGeneration(key: string): number {
  return generationMap.get(key) ?? 0;
}

/**
 * Apply a transform across every cached slot for a given (projectPath, type)
 * pair, regardless of filter or sort. Use after a mutation (close, merge,
 * reopen) so sibling filter slots don't serve stale rows on the next switch.
 *
 * The transform receives each entry plus the key remainder after the
 * `${projectPath}:${type}:` prefix (i.e. `${filterState}:${sortOrder}`), so it
 * can tell which filter slot it is mutating. It returns either a new entry
 * (write back + bump generation to discard any concurrent in-flight fetch for
 * that slot) or null (leave untouched, no generation bump).
 *
 * Prefix-matches on `${projectPath}:${type}:` rather than splitting on `:`
 * because `projectPath` can contain colons on Windows (e.g., `C:\projects`).
 */
export function mutateCacheEntries(
  projectPath: string,
  type: string,
  transform: (
    entry: ForgeResourceCacheEntry,
    keyRemainder: string
  ) => ForgeResourceCacheEntry | null
): void {
  const prefix = `${projectPath}:${type}:`;
  for (const [key, entry] of cache.entries()) {
    if (!key.startsWith(prefix)) continue;
    const next = transform(entry, key.slice(prefix.length));
    if (next === null) continue;
    setCache(key, next);
    nextGeneration(key);
  }
}

/**
 * Count-as-cache-buster: called whenever a fresh (non-stale, non-errored)
 * count for `type` lands from the cheap REST poll or a stats push. Marks every
 * `open`-filter slot whose `countAtWrite` no longer matches as stale and bumps
 * its generation so an in-flight downgraded (non-bypass) revalidate can't
 * commit a page the count delta just disproved. Rows are never removed — the
 * dropdown keeps showing them and the next open revalidates with
 * `bypassCache: true`.
 *
 * Zero network: this only flips metadata. Equal counts do NOT prove freshness
 * (close-one-open-one, edits), which is why only `open`-slot reads get
 * downgraded — and only behind the SWR open-time revalidate that remains the
 * correctness backstop for closed/merged/search views.
 */
export function markCountStale(projectPath: string, type: "issue" | "pr", openCount: number): void {
  mutateCacheEntries(projectPath, type, (entry, keyRemainder) => {
    if (!keyRemainder.startsWith("open:")) return null;
    if (entry.stale || entry.countAtWrite == null || entry.countAtWrite === openCount) return null;
    return { ...entry, stale: true };
  });
}

export function _resetForTests(): void {
  cache.clear();
  generationMap.clear();
}
