import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";

export interface UseSearchablePaletteOptions<T> {
  items: T[];
  fuseOptions?: IFuseOptions<T>;
  filterFn?: (items: T[], query: string) => T[];
  maxResults?: number;
  debounceMs?: number;
  /** Return false to skip item during keyboard navigation (e.g. disabled items) */
  canNavigate?: (item: T) => boolean;
  /** Reset selected index when results change. Default: true */
  resetOnResultsChange?: boolean;
}

export interface UseSearchablePaletteReturn<T> {
  isOpen: boolean;
  query: string;
  results: T[];
  selectedIndex: number;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setQuery: (query: string) => void;
  setSelectedIndex: (index: number) => void;
  selectPrevious: () => void;
  selectNext: () => void;
}

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_DEBOUNCE_MS = 200;

export function useSearchablePalette<T>(
  options: UseSearchablePaletteOptions<T>
): UseSearchablePaletteReturn<T> {
  const {
    items,
    fuseOptions,
    filterFn,
    maxResults = DEFAULT_MAX_RESULTS,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    canNavigate,
    resetOnResultsChange = true,
  } = options;

  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
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
    let filtered: T[];

    if (filterFn) {
      filtered = filterFn(items, debouncedQuery);
    } else if (!debouncedQuery.trim()) {
      filtered = items;
    } else if (fuse) {
      const fuseResults = fuse.search(debouncedQuery);
      filtered = fuseResults.map((r) => r.item);
    } else {
      filtered = items;
    }

    return filtered.slice(0, maxResults);
  }, [debouncedQuery, items, fuse, filterFn, maxResults]);

  const findNavigable = useCallback(
    (startIndex: number, direction: 1 | -1): number => {
      if (results.length === 0) return 0;
      if (!canNavigate) return startIndex;

      let index = startIndex;
      const visited = new Set<number>();
      while (!canNavigate(results[index]) && !visited.has(index)) {
        visited.add(index);
        index = (index + direction + results.length) % results.length;
      }

      // If we visited all items and none are navigable, return -1
      if (visited.size === results.length && !canNavigate(results[index])) {
        return -1;
      }

      return index;
    },
    [results, canNavigate]
  );

  useEffect(() => {
    if (resetOnResultsChange) {
      if (canNavigate && results.length > 0) {
        const firstNavigable = findNavigable(0, 1);
        setSelectedIndex(firstNavigable);
      } else {
        setSelectedIndex(0);
      }
    }
  }, [results, resetOnResultsChange, canNavigate, findNavigable]);

  const open = useCallback(() => {
    setIsOpen(true);
    setQuery("");
    setDebouncedQuery("");
    setSelectedIndex(0);
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
    if (results.length === 0) return;
    setSelectedIndex((prev) => {
      const next = prev <= 0 ? results.length - 1 : prev - 1;
      return canNavigate ? findNavigable(next, -1) : next;
    });
  }, [results.length, canNavigate, findNavigable]);

  const selectNext = useCallback(() => {
    if (results.length === 0) return;
    setSelectedIndex((prev) => {
      const next = prev >= results.length - 1 ? 0 : prev + 1;
      return canNavigate ? findNavigable(next, 1) : next;
    });
  }, [results.length, canNavigate, findNavigable]);

  return {
    isOpen,
    query,
    results,
    selectedIndex,
    open,
    close,
    toggle,
    setQuery,
    setSelectedIndex,
    selectPrevious,
    selectNext,
  };
}
