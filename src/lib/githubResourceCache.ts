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

export function _resetForTests(): void {
  cache.clear();
  generationMap.clear();
}
