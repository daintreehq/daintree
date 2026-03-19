import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { notesClient, type NoteListItem } from "@/clients/notesClient";

export type SortOrder = "modified-desc" | "created-desc" | "created-asc" | "title-asc";

interface SearchCacheEntry {
  notes: NoteListItem[];
  timestamp: number;
}

const searchCache = new Map<string, SearchCacheEntry>();
const MAX_CACHE_ENTRIES = 20;

export function resetNoteSearchCache(): void {
  searchCache.clear();
}

export const resetNoteSearchCacheForTests = resetNoteSearchCache;

export const SORT_LABELS: Record<SortOrder, string> = {
  "modified-desc": "Modified (newest)",
  "created-desc": "Created (newest)",
  "created-asc": "Created (oldest)",
  "title-asc": "Title (A–Z)",
};

interface UseNoteSearchOptions {
  isOpen: boolean;
  notes: NoteListItem[];
  refresh: () => void;
}

export interface UseNoteSearchReturn {
  query: string;
  setQuery: (q: string) => void;
  searchResults: NoteListItem[];
  isSearching: boolean;
  visibleNotes: NoteListItem[];
  availableTags: string[];
  sortOrder: SortOrder;
  setSortOrder: (order: SortOrder) => void;
  selectedTag: string | null;
  setSelectedTag: (tag: string | null) => void;
}

export function useNoteSearch({
  isOpen,
  notes,
  refresh,
}: UseNoteSearchOptions): UseNoteSearchReturn {
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<NoteListItem[]>(
    () => searchCache.get("")?.notes ?? []
  );
  const [isSearching, setIsSearching] = useState(() => !searchCache.has(""));
  const [sortOrder, setSortOrder] = useState<SortOrder>(
    () => (sessionStorage.getItem("notes-sort-order") as SortOrder) || "modified-desc"
  );
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const searchSeqRef = useRef(0);

  const availableTags = useMemo(
    () => [...new Set(searchResults.flatMap((n) => n.tags ?? []))].sort(),
    [searchResults]
  );

  const visibleNotes = useMemo(() => {
    const list = selectedTag
      ? searchResults.filter((n) => n.tags?.includes(selectedTag))
      : searchResults;
    return [...list].sort((a, b) => {
      switch (sortOrder) {
        case "modified-desc":
          return b.modifiedAt - a.modifiedAt;
        case "created-desc":
          return b.createdAt - a.createdAt;
        case "created-asc":
          return a.createdAt - b.createdAt;
        case "title-asc":
          return a.title.localeCompare(b.title);
      }
    });
  }, [searchResults, selectedTag, sortOrder]);

  // Clear selected tag when it disappears from available tags
  useEffect(() => {
    if (selectedTag && !availableTags.includes(selectedTag)) {
      setSelectedTag(null);
    }
  }, [availableTags, selectedTag]);

  // Persist sort order to sessionStorage
  useEffect(() => {
    sessionStorage.setItem("notes-sort-order", sortOrder);
  }, [sortOrder]);

  // Listen for note updates from other components
  useEffect(() => {
    if (!isOpen) return;
    const unsubscribe = notesClient.onUpdated(() => {
      searchCache.clear();
      refresh();
    });
    return unsubscribe;
  }, [isOpen, refresh]);

  // Update search results when notes change or query changes
  useEffect(() => {
    if (!isOpen) return;

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    const cached = searchCache.get(query);

    // Show cached results immediately without loading flash
    if (cached) {
      setSearchResults(cached.notes);
      setIsSearching(false);
    } else {
      setIsSearching(true);
    }

    // Always revalidate in the background
    const seq = ++searchSeqRef.current;
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const result = await notesClient.search(query);
        if (searchSeqRef.current !== seq) return;
        // Enforce cache size cap
        if (searchCache.size >= MAX_CACHE_ENTRIES) {
          let oldestKey: string | undefined;
          let oldestTime = Infinity;
          for (const [key, entry] of searchCache) {
            if (entry.timestamp < oldestTime) {
              oldestTime = entry.timestamp;
              oldestKey = key;
            }
          }
          if (oldestKey !== undefined) searchCache.delete(oldestKey);
        }
        searchCache.set(query, { notes: result.notes, timestamp: Date.now() });
        setSearchResults(result.notes);
      } catch (e) {
        if (searchSeqRef.current !== seq) return;
        console.error("Search failed:", e);
        if (!cached) setSearchResults(notes);
      } finally {
        if (searchSeqRef.current === seq) setIsSearching(false);
      }
    }, 150);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [isOpen, query, notes]);

  return {
    query,
    setQuery: useCallback((q: string) => setQuery(q), []),
    searchResults,
    isSearching,
    visibleNotes,
    availableTags,
    sortOrder,
    setSortOrder: useCallback((order: SortOrder) => setSortOrder(order), []),
    selectedTag,
    setSelectedTag: useCallback((tag: string | null) => setSelectedTag(tag), []),
  };
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => searchCache.clear());
}
