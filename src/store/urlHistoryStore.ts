import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StorageValue } from "zustand/middleware";
import type { UrlHistoryEntry } from "@shared/types/browser";
import { sanitizeUrlForHistory } from "@shared/utils/urlHistory";
import { createDebouncedSafeJSONStorage } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";

const MAX_ENTRIES_PER_PROJECT = 500;
const MAX_VISIT_COUNT = 200;
const HISTORY_RETENTION_MS = 90 * 24 * 3600 * 1000;

export { sanitizeUrlForHistory } from "@shared/utils/urlHistory";

const RECENCY_BUCKETS = [
  { maxAgeMs: 4 * 24 * 3600 * 1000, weight: 100 },
  { maxAgeMs: 14 * 24 * 3600 * 1000, weight: 70 },
  { maxAgeMs: 31 * 24 * 3600 * 1000, weight: 50 },
  { maxAgeMs: 90 * 24 * 3600 * 1000, weight: 30 },
  { maxAgeMs: Infinity, weight: 10 },
];
export function frecencyScore(entry: UrlHistoryEntry, now: number): number {
  const ageMs = now - entry.lastVisitAt;
  const bucket = RECENCY_BUCKETS.find((b) => ageMs <= b.maxAgeMs)!;
  return entry.visitCount * bucket.weight;
}

// Sort descending by frecency, computing each entry's score once instead of
// per comparison (frecencyScore does a linear bucket lookup per call).
function sortByFrecencyDesc(entries: UrlHistoryEntry[], now: number): UrlHistoryEntry[] {
  return entries
    .map((entry) => ({ entry, score: frecencyScore(entry, now) }))
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry);
}

export function getFrecencySuggestions(
  entries: UrlHistoryEntry[],
  query: string,
  limit = 5
): UrlHistoryEntry[] {
  const now = Date.now();
  if (!query.trim()) {
    return sortByFrecencyDesc(entries, now).slice(0, limit);
  }
  const lowerQuery = query.toLowerCase();
  const filtered = entries.filter(
    (e) => e.url.toLowerCase().includes(lowerQuery) || e.title.toLowerCase().includes(lowerQuery)
  );
  return sortByFrecencyDesc(filtered, now).slice(0, limit);
}

interface UrlHistoryState {
  entries: Record<string, UrlHistoryEntry[]>;
  recordVisit: (projectId: string, url: string, title?: string) => void;
  updateTitle: (projectId: string, url: string, title: string) => void;
  updateFavicon: (projectId: string, url: string, favicon: string) => void;
  removeUrl: (projectId: string, url: string) => void;
  removeProjectHistory: (projectId: string) => void;
}

type UrlHistoryPersistedState = Pick<UrlHistoryState, "entries">;

function entriesOf(
  value: StorageValue<UrlHistoryPersistedState> | null
): Record<string, UrlHistoryEntry[]> {
  const entries = value?.state?.entries;
  return entries !== null && typeof entries === "object" ? entries : {};
}

/**
 * Baseline-aware three-way merge for URL-history writes across project views
 * (issue #11351). Each project's entry list is one record value keyed by project
 * id, so a stale view writing its own project no longer wipes another project's
 * history a sibling view recorded, and a `removeProjectHistory` isn't
 * resurrected. Concurrent writes to the *same* project bucket stay
 * last-writer-wins (the separate same-project multi-window case).
 */
function mergeUrlHistoryPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<UrlHistoryPersistedState>): StorageValue<UrlHistoryPersistedState> {
  // No shared value on disk yet → nothing to reconcile against.
  if (!onDisk) return incoming;
  return {
    version: incoming.version,
    state: {
      entries: mergeRecordByWriterDelta(entriesOf(baseline), entriesOf(incoming), entriesOf(onDisk)),
    },
  };
}

function pruneStaleEntries(entries: UrlHistoryEntry[], now: number): UrlHistoryEntry[] {
  return entries.filter((e) => now - e.lastVisitAt <= HISTORY_RETENTION_MS);
}

function migrateEntries(
  rawEntries: Record<string, UrlHistoryEntry[]>
): Record<string, UrlHistoryEntry[]> {
  const now = Date.now();
  const result: Record<string, UrlHistoryEntry[]> = {};
  for (const [projectId, projectEntries] of Object.entries(rawEntries)) {
    if (!Array.isArray(projectEntries)) continue;
    const merged = new Map<string, UrlHistoryEntry>();
    for (const entry of projectEntries) {
      if (!entry || typeof entry.url !== "string") continue;
      const canonical = sanitizeUrlForHistory(entry.url);
      if (canonical === null) continue;
      const cappedVisits = Math.min(entry.visitCount ?? 0, MAX_VISIT_COUNT);
      const existing = merged.get(canonical);
      if (existing) {
        existing.visitCount = Math.min(existing.visitCount + cappedVisits, MAX_VISIT_COUNT);
        existing.lastVisitAt = Math.max(existing.lastVisitAt, entry.lastVisitAt ?? 0);
        if (!existing.title && entry.title) existing.title = entry.title;
        if (!existing.favicon && entry.favicon) existing.favicon = entry.favicon;
      } else {
        merged.set(canonical, {
          url: canonical,
          title: entry.title ?? "",
          visitCount: cappedVisits,
          lastVisitAt: entry.lastVisitAt ?? 0,
          ...(entry.favicon ? { favicon: entry.favicon } : {}),
        });
      }
    }
    let pruned = pruneStaleEntries([...merged.values()], now);
    if (pruned.length > MAX_ENTRIES_PER_PROJECT) {
      pruned = sortByFrecencyDesc(pruned, now).slice(0, MAX_ENTRIES_PER_PROJECT);
    }
    if (pruned.length > 0) result[projectId] = pruned;
  }
  return result;
}

export const useUrlHistoryStore = create<UrlHistoryState>()(
  persist(
    (set) => ({
      entries: {},

      recordVisit: (projectId, url, title) =>
        set((state) => {
          const canonical = sanitizeUrlForHistory(url);
          if (canonical === null) return state;
          const now = Date.now();
          let projectEntries = pruneStaleEntries(state.entries[projectId] ?? [], now).slice();
          const existingIndex = projectEntries.findIndex((e) => e.url === canonical);

          if (existingIndex >= 0) {
            const existing = projectEntries[existingIndex]!;
            projectEntries[existingIndex] = {
              ...existing,
              visitCount: Math.min(existing.visitCount + 1, MAX_VISIT_COUNT),
              lastVisitAt: now,
              title: title || existing.title,
            };
          } else {
            projectEntries.push({
              url: canonical,
              title: title || "",
              visitCount: 1,
              lastVisitAt: now,
            });
          }

          if (projectEntries.length > MAX_ENTRIES_PER_PROJECT) {
            projectEntries = sortByFrecencyDesc(projectEntries, now).slice(
              0,
              MAX_ENTRIES_PER_PROJECT
            );
          }

          return { entries: { ...state.entries, [projectId]: projectEntries } };
        }),

      updateTitle: (projectId, url, title) =>
        set((state) => {
          const canonical = sanitizeUrlForHistory(url);
          if (canonical === null) return state;
          const projectEntries = state.entries[projectId];
          if (!projectEntries) return state;
          const index = projectEntries.findIndex((e) => e.url === canonical);
          if (index < 0) return state;
          const updated = [...projectEntries];
          updated[index] = { ...updated[index]!, title };
          return { entries: { ...state.entries, [projectId]: updated } };
        }),

      updateFavicon: (projectId, url, favicon) =>
        set((state) => {
          const canonical = sanitizeUrlForHistory(url);
          if (canonical === null) return state;
          const projectEntries = state.entries[projectId];
          if (!projectEntries) return state;
          const index = projectEntries.findIndex((e) => e.url === canonical);
          if (index < 0) return state;
          const updated = [...projectEntries];
          updated[index] = { ...updated[index]!, favicon };
          return { entries: { ...state.entries, [projectId]: updated } };
        }),

      removeUrl: (projectId, url) =>
        set((state) => {
          const projectEntries = state.entries[projectId];
          if (!projectEntries) return state;
          const filtered = projectEntries.filter((e) => e.url !== url);
          if (filtered.length === projectEntries.length) return state;
          return { entries: { ...state.entries, [projectId]: filtered } };
        }),

      removeProjectHistory: (projectId) =>
        set((state) => {
          const { [projectId]: _, ...rest } = state.entries;
          return { entries: rest };
        }),
    }),
    {
      name: "daintree-url-history",
      storage: createDebouncedSafeJSONStorage<UrlHistoryPersistedState>(300, {
        mergeOnWrite: mergeUrlHistoryPersistedWrite,
      }),
      version: 1,
      migrate: (persistedState) => persistedState as UrlHistoryState,
      merge: (persistedState, currentState) => {
        if (typeof persistedState !== "object" || persistedState === null) {
          return currentState;
        }
        const candidate = persistedState as { entries?: unknown };
        const rawEntries =
          candidate.entries && typeof candidate.entries === "object"
            ? (candidate.entries as Record<string, UrlHistoryEntry[]>)
            : {};
        return { ...currentState, entries: migrateEntries(rawEntries) };
      },
      partialize: (state) => ({ entries: state.entries }),
    }
  )
);

registerPersistedStore({
  storeId: "urlHistoryStore",
  store: useUrlHistoryStore,
  persistedStateType: "{ entries: Record<string, UrlHistoryEntry[]> }",
});
