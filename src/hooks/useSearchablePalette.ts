import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";

interface BaseOptions<T> {
  items: T[];
  maxResults?: number;
  onSelect: (item: T) => void;
}

interface FuseSearchOptions<T> extends BaseOptions<T> {
  fuseOptions: IFuseOptions<T>;
  debounceMs?: number;
  filterFn?: never;
}

interface CustomFilterOptions<T> extends BaseOptions<T> {
  filterFn: (items: T[], query: string) => T[];
  fuseOptions?: never;
  debounceMs?: never;
}

export type UseSearchablePaletteOptions<T> = FuseSearchOptions<T> | CustomFilterOptions<T>;

export interface UseSearchablePaletteReturn<T> {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  query: string;
  setQuery: (q: string) => void;
  results: T[];
  selectedIndex: number;
  selectPrevious: () => void;
  selectNext: () => void;
  confirmSelection: () => void;
}

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_MAX_RESULTS = 10;

export function useSearchablePalette<T>(
  options: UseSearchablePaletteOptions<T>
): UseSearchablePaletteReturn<T> {
  const { items, maxResults = DEFAULT_MAX_RESULTS, onSelect } = options;

  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const useFuseSearch = "fuseOptions" in options && options.fuseOptions != null;
  const fuseOptions = useFuseSearch ? (options as FuseSearchOptions<T>).fuseOptions : null;
  const filterFn = !useFuseSearch ? (options as CustomFilterOptions<T>).filterFn : null;
  const debounceMs = useFuseSearch
    ? ((options as FuseSearchOptions<T>).debounceMs ?? DEFAULT_DEBOUNCE_MS)
    : 0;

  const [debouncedQuery, setDebouncedQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceMs <= 0) {
      setDebouncedQuery(query);
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query);
    }, debounceMs);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query, debounceMs]);

  const fuse = useMemo(() => {
    if (!fuseOptions) return null;
    return new Fuse(items, fuseOptions);
  }, [items, fuseOptions]);

  const results = useMemo<T[]>(() => {
    if (fuse) {
      if (!debouncedQuery.trim()) {
        return items.slice(0, maxResults);
      }
      const fuseResults = fuse.search(debouncedQuery);
      return fuseResults.slice(0, maxResults).map((r) => r.item);
    }

    if (filterFn) {
      return filterFn(items, debouncedQuery).slice(0, maxResults);
    }

    return items.slice(0, maxResults);
  }, [debouncedQuery, items, fuse, filterFn, maxResults]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  const open = useCallback(() => {
    setIsOpen(true);
    setQuery("");
    setSelectedIndex(0);
    setDebouncedQuery("");
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setSelectedIndex(0);
    setDebouncedQuery("");
  }, []);

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
    } else {
      open();
    }
  }, [isOpen, open, close]);

  const selectPrevious = useCallback(() => {
    setSelectedIndex((prev) => (prev <= 0 ? results.length - 1 : prev - 1));
  }, [results.length]);

  const selectNext = useCallback(() => {
    setSelectedIndex((prev) => (prev >= results.length - 1 ? 0 : prev + 1));
  }, [results.length]);

  const confirmSelection = useCallback(() => {
    if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
      onSelect(results[selectedIndex]);
    }
  }, [results, selectedIndex, onSelect]);

  return {
    isOpen,
    open,
    close,
    toggle,
    query,
    setQuery,
    results,
    selectedIndex,
    selectPrevious,
    selectNext,
    confirmSelection,
  };
}
