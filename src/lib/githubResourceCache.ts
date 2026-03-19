import type { GitHubIssue, GitHubPR } from "@shared/types/github";

export interface GitHubResourceCacheEntry {
  items: (GitHubIssue | GitHubPR)[];
  endCursor: string | null;
  hasNextPage: boolean;
  timestamp: number;
}

const cache = new Map<string, GitHubResourceCacheEntry>();
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
