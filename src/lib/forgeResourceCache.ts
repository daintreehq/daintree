import type { Issue, PR } from "@shared/types/forge";
import { TtlCache } from "@/utils/ttlCache";

/**
 * Provider-scoped renderer cache for normalized forge issue/PR lists. The
 * GitHub-specific `githubResourceCache.ts` keys on `projectPath` and stores
 * GitHub-shaped rows, so a second provider at the same path would collide and
 * the rows wouldn't be provider-agnostic. This cache keys on
 * `${providerId}:${owner}:${repo}` so each forge identity gets its own slots,
 * and stores normalized {@link Issue}/{@link PR} rows.
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
}

const CACHE_MAX_SIZE = 20;
const CACHE_TTL_MS = 45 * 1000;

const cache = new TtlCache<string, ForgeResourceCacheEntry>(CACHE_MAX_SIZE, CACHE_TTL_MS);
const generationMap = new Map<string, number>();

export function buildCacheKey(
  providerId: string,
  owner: string,
  repo: string,
  type: string,
  filterState: string,
  sortOrder: string
): string {
  return `${providerId}:${owner}:${repo}:${type}:${filterState}:${sortOrder}`;
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
 * Apply a transform across every cached slot for a given
 * (providerId, owner, repo, type) tuple, regardless of filter or sort. Use
 * after a mutation (close, merge, reopen) so sibling filter slots don't serve
 * stale rows on the next switch.
 *
 * The transform receives each entry plus the key remainder after the
 * `${providerId}:${owner}:${repo}:${type}:` prefix (i.e.
 * `${filterState}:${sortOrder}`). It returns either a new entry (write back +
 * bump generation to discard any concurrent in-flight fetch for that slot) or
 * null (leave untouched, no generation bump).
 */
export function mutateCacheEntries(
  providerId: string,
  owner: string,
  repo: string,
  type: string,
  transform: (
    entry: ForgeResourceCacheEntry,
    keyRemainder: string
  ) => ForgeResourceCacheEntry | null
): void {
  const prefix = `${providerId}:${owner}:${repo}:${type}:`;
  for (const [key, entry] of cache.entries()) {
    if (!key.startsWith(prefix)) continue;
    const next = transform(entry, key.slice(prefix.length));
    if (next === null) continue;
    setCache(key, next);
    nextGeneration(key);
  }
}

export function _resetForTests(): void {
  cache.clear();
  generationMap.clear();
}
