import type { GitHubIssue, GitHubPR } from "@shared/types/github";
import { TtlCache } from "@/utils/ttlCache";

export interface GitHubResourceCacheEntry {
  items: (GitHubIssue | GitHubPR)[];
  endCursor: string | null;
  hasNextPage: boolean;
  timestamp: number;
}

const CACHE_MAX_SIZE = 20;
// Held strictly below the backend list-cache TTL (60s) so the renderer
// cache cannot stack on top of the backend cache and serve doubly-stale data.
const CACHE_TTL_MS = 45 * 1000;

const cache = new TtlCache<string, GitHubResourceCacheEntry>(CACHE_MAX_SIZE, CACHE_TTL_MS);
const generationMap = new Map<string, number>();

export function buildCacheKey(
  projectPath: string,
  type: string,
  filterState: string,
  sortOrder: string
): string {
  return `${projectPath}:${type}:${filterState}:${sortOrder}`;
}

export function getCache(key: string): GitHubResourceCacheEntry | undefined {
  return cache.get(key);
}

export function setCache(key: string, entry: GitHubResourceCacheEntry): void {
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
 * The transform receives each entry and returns either a new entry (write
 * back + bump generation to discard any concurrent in-flight SWR for that
 * slot) or null (leave untouched, no generation bump).
 *
 * Prefix-matches on `${projectPath}:${type}:` rather than splitting on `:`
 * because `projectPath` can contain colons on Windows (e.g., `C:\projects`).
 */
export function mutateCacheEntries(
  projectPath: string,
  type: string,
  transform: (entry: GitHubResourceCacheEntry) => GitHubResourceCacheEntry | null
): void {
  const prefix = `${projectPath}:${type}:`;
  for (const [key, entry] of cache.entries()) {
    if (!key.startsWith(prefix)) continue;
    const next = transform(entry);
    if (next === null) continue;
    setCache(key, next);
    nextGeneration(key);
  }
}

export function _resetForTests(): void {
  cache.clear();
  generationMap.clear();
}
