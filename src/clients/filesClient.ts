import type {
  FileSearchPayload,
  FileSearchResult,
  FileReadPayload,
  FileReadResult,
} from "@shared/types";

const CACHE_MAX_SIZE = 50;
const CACHE_TTL_MS = 5_000;

interface SearchCacheEntry {
  value: FileSearchResult;
  expiresAt: number;
}

const searchCache = new Map<string, SearchCacheEntry>();

function makeSearchCacheKey(payload: FileSearchPayload): string {
  return `${payload.cwd}\0${payload.query}\0${payload.limit ?? ""}`;
}

export const filesClient = {
  search: (payload: FileSearchPayload): Promise<FileSearchResult> => {
    const key = makeSearchCacheKey(payload);
    const cached = searchCache.get(key);

    if (cached) {
      if (Date.now() < cached.expiresAt) {
        // Promote to most-recently-used
        searchCache.delete(key);
        searchCache.set(key, cached);
        return Promise.resolve(cached.value);
      }
      searchCache.delete(key);
    }

    return window.electron.files.search(payload).then((result) => {
      if (searchCache.size >= CACHE_MAX_SIZE) {
        const oldest = searchCache.keys().next().value;
        if (oldest !== undefined) searchCache.delete(oldest);
      }
      searchCache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    });
  },
  read: (payload: FileReadPayload): Promise<FileReadResult> => {
    return window.electron.files.read(payload);
  },
};

export function resetSearchCacheForTests(): void {
  searchCache.clear();
}
