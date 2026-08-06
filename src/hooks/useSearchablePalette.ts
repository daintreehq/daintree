import { useState, useCallback, useMemo, useEffect, useRef, useDeferredValue } from "react";
import Fuse, { type IFuseOptions, type FuseResultMatch } from "fuse.js";
import { usePaletteStore, type PaletteId } from "@/store/paletteStore";

export type { FuseResultMatch };

export interface UseSearchablePaletteOptions<T> {
  items: T[];
  fuseOptions?: IFuseOptions<T>;
  filterFn?: (items: T[], query: string) => T[];
  /**
   * Cap on rendered results. Pass a function to vary the cap by query — the
   * action palette uncaps its empty-query browse inventory while keeping the
   * search path at 20. Resolved against the *deferred* query, the same one
   * `filterFn` sees, so the cap never disagrees with the results it slices.
   * Use a stable (module-level or memoized) function; an inline arrow
   * re-runs the filter memo on every render.
   */
  maxResults?: number | ((query: string) => number);
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
  /**
   * Lag filtering behind the input via `useDeferredValue`. Default true, which
   * keeps keystrokes responsive on large lists at the cost of `results` briefly
   * trailing `query`. Small embedded launchers whose confirm key can be pressed
   * in the same tick as the last keystroke pass false: with deferral on, that
   * Enter reads the *previous* query's ranking and launches the wrong item.
   */
  deferFiltering?: boolean;
}

export interface UseSearchablePaletteReturn<T> {
  isOpen: boolean;
  query: string;
  results: T[];
  totalResults: number;
  selectedIndex: number;
  matchesById: Map<string, readonly FuseResultMatch[]>;
  /**
   * True while the deferred filter pass is catching up to the latest input.
   * Consumers can pass this to `SearchablePalette.isFiltering` to dim the
   * listbox after the 200ms palette stale-delay (`UI_PALETTE_STALE_DELAY`) —
   * a typed-input gate that's deliberately shorter than the 400ms Doherty
   * floor so it actually fires between keystrokes.
   */
  isStale: boolean;
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
    deferFiltering = true,
  } = options;

  const storeIsOpen = usePaletteStore(
    (state) => paletteId != null && state.activePaletteId === paletteId
  );
  const [localIsOpen, setLocalIsOpen] = useState(false);
  const isOpen = paletteId != null ? storeIsOpen : localIsOpen;

  const [query, setQuery] = useState("");
  // Lag the filtering work behind the input so keystrokes stay responsive.
  // The expensive Fuse/filterFn pass runs in a deferred render that yields to
  // input events; the input itself binds to the urgent `query` state.
  // Called unconditionally (hook order) even when deferral is opted out of.
  const deferredValue = useDeferredValue(query);
  const deferredQuery = deferFiltering ? deferredValue : query;
  const isStale = query !== deferredQuery;
  const [selectedIndex, setSelectedIndex] = useState(0);

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

    const limit = typeof maxResults === "function" ? maxResults(deferredQuery) : maxResults;

    return {
      // Return `filtered` itself when nothing is cut. Beyond skipping a copy of
      // a several-hundred-entry list on every render, this preserves the array
      // identity `filterFn` returned, which lets a caller recognise its own
      // memoized result set — the action palette pairs its section descriptors
      // with the exact array that produced them that way.
      results: filtered.length <= limit ? filtered : filtered.slice(0, limit),
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

  // Track the ID of the currently selected item so that when results change
  // (e.g. typing to narrow) the next render can follow the same item to its
  // new index instead of snapping selection back to the first navigable row.
  //
  // The ID is captured IMPERATIVELY inside updateSelectedIndex below — never
  // from an effect that observes `results[selectedIndex]`. An effect-based
  // observer would write the wrong ID when results change underneath a stale
  // (still-in-bounds) selectedIndex: e.g. items [alpha, beta, bravo], user
  // selects beta at index 1, query removes alpha → new results [beta, bravo]
  // with selectedIndex still = 1. An effect would read results[1] = bravo and
  // overwrite the ref before the follow lookup could use the prior ID.
  const selectedItemIdRef = useRef<string | null>(null);

  // Mirrors `selectedIndex` so the reconcile effect can consult the current
  // selection without taking it as a dependency and re-running on every move.
  const selectedIndexRef = useRef(0);

  const updateSelectedIndex = useCallback(
    (next: number | ((prev: number) => number)): void => {
      // Resolved against the ref rather than inside a setState updater. An
      // updater runs during render and React may re-run or discard one while
      // re-basing work, which would leave these refs describing a selection
      // that never committed — and the reconcile effect below trusts them to
      // agree with each other. Every write lands here, so the ref is as current
      // as the state it mirrors.
      const value = typeof next === "function" ? next(selectedIndexRef.current) : next;
      const item = results[value];
      if (item != null) {
        selectedItemIdRef.current = getItemId(item);
      }
      selectedIndexRef.current = value;
      setSelectedIndex(value);
    },
    [results, getItemId]
  );

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
    if (ids === prev.ids && length === prev.length) {
      // Sampling first/middle/last can't see an interior reorder that keeps all
      // three in place — pinning a row lifts it above its neighbours and does
      // exactly that. Trust the fast path only while the anchored row is still
      // where the selection points; otherwise fall through and follow it, or
      // the highlight silently slides onto the row that took its index and
      // Enter runs the wrong action.
      const anchorId = selectedItemIdRef.current;
      if (anchorId == null) return;
      const atSelected = results[selectedIndexRef.current];
      if (atSelected != null && getItemId(atSelected) === anchorId) return;
    } else {
      prevResultsRef.current = { ids, length };
    }

    // Follow the previously selected item to its new index when it's still
    // present and still navigable. This preserves the "type to narrow, glance,
    // Enter" flow that otherwise confirms the wrong row.
    if (selectedItemIdRef.current != null && length > 0) {
      const followIndex = results.findIndex(
        (item) => getItemId(item) === selectedItemIdRef.current
      );
      if (followIndex >= 0 && (!canNavigate || canNavigate(results[followIndex]!))) {
        updateSelectedIndex(followIndex);
        return;
      }
    }

    if (canNavigate && length > 0) {
      updateSelectedIndex(findNavigable(0, 1));
    } else {
      updateSelectedIndex(0);
    }
  }, [results, resetOnResultsChange, canNavigate, findNavigable, getItemId, updateSelectedIndex]);

  const open = useCallback(() => {
    if (paletteId != null) {
      usePaletteStore.getState().openPalette(paletteId);
    } else {
      setLocalIsOpen(true);
    }
    setQuery("");
    // Drop the follow anchor: an explicit open/close is a fresh start, not a
    // result-set change to be tracked through. Leaving it set lets the
    // reconcile effect chase the previously selected id into the next result
    // set — harmless when that set was a short recents rail, but the action
    // palette's empty-query inventory contains nearly every action, so the
    // last search hit is almost always in there and reopening would land
    // selection deep in the list instead of at the top.
    selectedItemIdRef.current = null;
    // Reset to the first navigable item (not blindly 0) so that
    // palettes with disabled leading items start on the correct row.
    const firstNav = canNavigate && results.length > 0 ? findNavigable(0, 1) : 0;
    selectedIndexRef.current = firstNav;
    setSelectedIndex(firstNav);
  }, [paletteId, canNavigate, results.length, findNavigable]);

  const close = useCallback(() => {
    if (paletteId != null) {
      usePaletteStore.getState().closePalette(paletteId);
    } else {
      setLocalIsOpen(false);
    }
    setQuery("");
    selectedItemIdRef.current = null;
    selectedIndexRef.current = 0;
    setSelectedIndex(0);
  }, [paletteId]);

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
    } else {
      open();
    }
  }, [isOpen, open, close]);

  // Stored state can briefly point past a list that just shrank — results are
  // computed during render, the index is reconciled an effect later. Step from
  // where the user actually sees the highlight, not from the stale value, or
  // the first arrow press after a narrowing goes somewhere they didn't ask for.
  const currentIndex = useCallback(
    (prev: number) => (prev >= 0 && prev < results.length ? prev : 0),
    [results.length]
  );

  const selectPrevious = useCallback(() => {
    if (results.length === 0) return;
    updateSelectedIndex((prev) => {
      const from = currentIndex(prev);
      const next = from <= 0 ? results.length - 1 : from - 1;
      return canNavigate ? findNavigable(next, -1) : next;
    });
  }, [results.length, canNavigate, findNavigable, updateSelectedIndex, currentIndex]);

  const selectNext = useCallback(() => {
    if (results.length === 0) return;
    updateSelectedIndex((prev) => {
      const from = currentIndex(prev);
      const next = from >= results.length - 1 ? 0 : from + 1;
      return canNavigate ? findNavigable(next, 1) : next;
    });
  }, [results.length, canNavigate, findNavigable, updateSelectedIndex, currentIndex]);

  return {
    isOpen,
    query,
    results,
    totalResults,
    selectedIndex,
    matchesById,
    isStale,
    open,
    close,
    toggle,
    setQuery,
    setSelectedIndex: updateSelectedIndex,
    selectPrevious,
    selectNext,
  };
}
