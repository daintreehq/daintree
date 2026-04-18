import { useState, useCallback, useMemo, useEffect, useRef, useDeferredValue } from "react";
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
      while (!canNavigate(results[index]!) && !visited.has(index)) {
        visited.add(index);
        index = (index + direction + results.length) % results.length;
      }

      // If we visited all items and none are navigable, return -1
      if (visited.size === results.length && !canNavigate(results[index]!)) {
        return -1;
      }

      return index;
    },
    [results, canNavigate]
  );

  // Track the previous results to avoid resetting selectedIndex when the
  // useMemo produces a new array reference with identical content.  Without
  // this guard, unstable memo dependencies (e.g. an inline filterFn) cause
  // the reset to fire on every render, clobbering ArrowDown navigation.
  const prevResultsRef = useRef<{ ids: string; length: number }>({ ids: "", length: 0 });
  useEffect(() => {
    if (!resetOnResultsChange) return;

    // Build a lightweight fingerprint of the results to detect real changes
    // without doing a full deep comparison.
    const length = results.length;
    const ids =
      length === 0
        ? ""
        : length <= 3
          ? results.map(getItemId).join(",")
          : `${getItemId(results[0]!)},${getItemId(results[Math.floor(length / 2)]!)},${getItemId(results[length - 1]!)}`;
    const prev = prevResultsRef.current;
    if (ids === prev.ids && length === prev.length) return;
    prevResultsRef.current = { ids, length };

    if (canNavigate && length > 0) {
      const firstNavigable = findNavigable(0, 1);
      setSelectedIndex(firstNavigable);
    } else {
      setSelectedIndex(0);
    }
  }, [results, resetOnResultsChange, canNavigate, findNavigable, getItemId]);

  const open = useCallback(() => {
    if (paletteId != null) {
      usePaletteStore.getState().openPalette(paletteId);
    } else {
      setLocalIsOpen(true);
    }
    setQuery("");
    // Reset to the first navigable item (not blindly 0) so that
    // palettes with disabled leading items start on the correct row.
    const firstNav = canNavigate && results.length > 0 ? findNavigable(0, 1) : 0;
    setSelectedIndex(firstNav);
  }, [paletteId, canNavigate, results.length, findNavigable]);

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
