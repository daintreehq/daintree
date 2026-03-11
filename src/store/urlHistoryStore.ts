import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import type { UrlHistoryEntry } from "@shared/types/domain";

const MAX_ENTRIES_PER_PROJECT = 500;

const RECENCY_BUCKETS = [
  { maxAgeMs: 4 * 24 * 3600 * 1000, weight: 100 },
  { maxAgeMs: 14 * 24 * 3600 * 1000, weight: 70 },
  { maxAgeMs: 31 * 24 * 3600 * 1000, weight: 50 },
  { maxAgeMs: 90 * 24 * 3600 * 1000, weight: 30 },
  { maxAgeMs: Infinity, weight: 10 },
];

const memoryStorage: StateStorage = (() => {
  const storage = new Map<string, string>();
  return {
    getItem: (name) => storage.get(name) ?? null,
    setItem: (name, value) => {
      storage.set(name, value);
    },
    removeItem: (name) => {
      storage.delete(name);
    },
  };
})();

function getSafeStorage(): StateStorage {
  if (typeof localStorage !== "undefined") {
    return localStorage;
  }
  return memoryStorage;
}

export function frecencyScore(entry: UrlHistoryEntry, now: number): number {
  const ageMs = now - entry.lastVisitAt;
  const bucket = RECENCY_BUCKETS.find((b) => ageMs <= b.maxAgeMs)!;
  return entry.visitCount * bucket.weight;
}

export function getFrecencySuggestions(
  entries: UrlHistoryEntry[],
  query: string,
  limit = 5
): UrlHistoryEntry[] {
  if (!query.trim()) return [];
  const lowerQuery = query.toLowerCase();
  const now = Date.now();
  return entries
    .filter(
      (e) => e.url.toLowerCase().includes(lowerQuery) || e.title.toLowerCase().includes(lowerQuery)
    )
    .sort((a, b) => frecencyScore(b, now) - frecencyScore(a, now))
    .slice(0, limit);
}

interface UrlHistoryState {
  entries: Record<string, UrlHistoryEntry[]>;
  recordVisit: (projectId: string, url: string, title?: string) => void;
  updateTitle: (projectId: string, url: string, title: string) => void;
  removeProjectHistory: (projectId: string) => void;
}

export const useUrlHistoryStore = create<UrlHistoryState>()(
  persist(
    (set) => ({
      entries: {},

      recordVisit: (projectId, url, title) =>
        set((state) => {
          const projectEntries = [...(state.entries[projectId] ?? [])];
          const existingIndex = projectEntries.findIndex((e) => e.url === url);
          const now = Date.now();

          if (existingIndex >= 0) {
            const existing = projectEntries[existingIndex];
            projectEntries[existingIndex] = {
              ...existing,
              visitCount: existing.visitCount + 1,
              lastVisitAt: now,
              title: title || existing.title,
            };
          } else {
            projectEntries.push({
              url,
              title: title || "",
              visitCount: 1,
              lastVisitAt: now,
            });
          }

          if (projectEntries.length > MAX_ENTRIES_PER_PROJECT) {
            projectEntries.sort((a, b) => frecencyScore(b, now) - frecencyScore(a, now));
            projectEntries.length = MAX_ENTRIES_PER_PROJECT;
          }

          return { entries: { ...state.entries, [projectId]: projectEntries } };
        }),

      updateTitle: (projectId, url, title) =>
        set((state) => {
          const projectEntries = state.entries[projectId];
          if (!projectEntries) return state;
          const index = projectEntries.findIndex((e) => e.url === url);
          if (index < 0) return state;
          const updated = [...projectEntries];
          updated[index] = { ...updated[index], title };
          return { entries: { ...state.entries, [projectId]: updated } };
        }),

      removeProjectHistory: (projectId) =>
        set((state) => {
          const { [projectId]: _, ...rest } = state.entries;
          return { entries: rest };
        }),
    }),
    {
      name: "canopy-url-history",
      storage: createJSONStorage(() => getSafeStorage()),
      partialize: (state) => ({ entries: state.entries }),
    }
  )
);
