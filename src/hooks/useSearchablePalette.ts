import { useState, useCallback, useMemo, useEffect, useDeferredValue } from "react";
import Fuse, { type IFuseOptions, type FuseResultMatch } from "fuse.js";
import { usePaletteStore, type PaletteId } from "@/store/paletteStore";

export type { FuseResultMatch };

export interface UseSearchablePaletteOptions<T> {
  items: T[];
  fuseOptions?: IFuseOptions<T>;
  filterFn?: (items: T[], query: string) => T[];
  maxResults?: number;
  /** Return false to skip item during keyboard navigation (e.g. disabled items) */
  canNavigate?: (item: T) => boolean;
  /** Reset selected index when results change. Default: true */
  resetOnResultsChange?: boolean;
  /** Palette ID for mutual exclusion. When set, isOpen is derived from the palette store. */
  paletteId?: PaletteId;
  /** When true, populates matchesById with Fuse match ranges (requires fuseOptions). */
  includeMatches?: boolean;
  /** Extract a unique ID from an item for the matchesById map. Defaults to `(item as any).id`. */
  getItemId?: (item: T) => string;
}

export interface UseSearchablePaletteReturn<T> {
  isOpen: boolean;
  query: string;
  results: T[];
  totalResults: number;
  selectedIndex: number;
  isStale: boolean;
  matchesById: Map<string, readonly FuseResultMatch[]>;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setQuery: (query: string) => void;
  setSelectedIndex: (index: number) => void;
  selectPrevious: () => void;
  selectNext: () => void;
}

const DEFAULT_MAX_RESULTS = 20;

const defaultGetItemId = <T>(item: T): string => (item as Record<string, unknown>).id as string;

export function useSearchablePalette<T>(
  options: UseSearchablePaletteOptions<T>
): UseSearchablePaletteReturn<T> {
  const {
    items,
    fuseOptions,
    filterFn,
    maxResults = DEFAULT_MAX_RESULTS,
    canNavigate,
    resetOnResultsChange = true,
    paletteId,
    includeMatches = false,
    getItemId = defaultGetItemId,
  } = options;

  const storeIsOpen = usePaletteStore(
    (state) => paletteId != null && state.activePaletteId === paletteId
  );
  const [localIsOpen, setLocalIsOpen] = useState(false);
  const isOpen = paletteId != null ? storeIsOpen : localIsOpen;

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const deferredQuery = useDeferredValue(query);

  const effectiveFuseOptions = useMemo(() => {
    if (!fuseOptions) return null;
    if (includeMatches) return { ...fuseOptions, includeMatches: true };
    return fuseOptions;
  }, [fuseOptions, includeMatches]);

  const fuse = useMemo(() => {
    if (!effectiveFuseOptions) return null;
    return new Fuse(items, effectiveFuseOptions);
  }, [items, effectiveFuseOptions]);

  const { results, totalResults, matchesById } = useMemo(() => {
    let filtered: T[];
    const matches = new Map<string, readonly FuseResultMatch[]>();

    if (filterFn) {
      filtered = filterFn(items, deferredQuery);
    } else if (!deferredQuery.trim()) {
      filtered = items;
    } else if (fuse) {
      const fuseResults = fuse.search(deferredQuery);
      filtered = fuseResults.map((r) => r.item);
      if (includeMatches) {
        for (const r of fuseResults) {
          if (r.matches?.length) {
            matches.set(getItemId(r.item), r.matches);
          }
        }
      }
    } else {
      filtered = items;
    }

    return {
      results: filtered.slice(0, maxResults),
      totalResults: filtered.length,
      matchesById: matches,
    };
  }, [deferredQuery, items, fuse, filterFn, maxResults, includeMatches, getItemId]);

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
    if (paletteId != null) {
      usePaletteStore.getState().openPalette(paletteId);
    } else {
      setLocalIsOpen(true);
    }
    setQuery("");
    setSelectedIndex(0);
  }, [paletteId]);

  const close = useCallback(() => {
    if (paletteId != null) {
      usePaletteStore.getState().closePalette(paletteId);
    } else {
      setLocalIsOpen(false);
    }
    setQuery("");
    setSelectedIndex(0);
  }, [paletteId]);

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

  const isStale = query !== deferredQuery;

  return {
    isOpen,
    query,
    results,
    totalResults,
    selectedIndex,
    isStale,
    matchesById,
    open,
    close,
    toggle,
    setQuery,
    setSelectedIndex,
    selectPrevious,
    selectNext,
  };
}
