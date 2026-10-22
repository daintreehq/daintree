import { useEffect, useRef, useState } from "react";
import type { ContextProviderItem } from "@shared/types/pluginContextProvider";
import { useDebounce } from "@/hooks/useDebounce";
import { rememberContextReferenceLabel } from "@/lib/contextReferenceLabels";

interface UseContextProviderSearchParams {
  /** The prefix of the provider the `@` query names, or null when it names none. */
  prefix: string | null;
  /** What the user typed after `@{prefix}:` — all the provider is shown. */
  query: string;
  enabled: boolean;
}

export interface ContextProviderSearchState {
  items: ContextProviderItem[];
  isLoading: boolean;
  /** The prefix and query `items` answer; null until the first answer lands. */
  resultsFor: { prefix: string; query: string } | null;
}

const EMPTY_ITEMS: ContextProviderItem[] = [];

/**
 * Debounced search of a plugin context provider (#13795), in the shape of
 * `useFileAutocomplete`: a request id drops every answer but the newest, and
 * `resultsFor` lets the composer tell rows that answer an older query from
 * current ones, so Enter on a stale row never inserts the wrong item.
 */
export function useContextProviderSearch({
  prefix,
  query,
  enabled,
}: UseContextProviderSearchParams): ContextProviderSearchState {
  const [items, setItems] = useState<ContextProviderItem[]>(EMPTY_ITEMS);
  const [resultsFor, setResultsFor] = useState<{ prefix: string; query: string } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const requestIdRef = useRef(0);
  const debouncedQuery = useDebounce(query, 75);

  useEffect(() => {
    const bridge = window.electron?.plugin;
    if (!enabled || prefix === null || typeof bridge?.searchContextProvider !== "function") {
      // A late answer can't repopulate a menu that closed or moved to another provider.
      requestIdRef.current++;
      setItems(EMPTY_ITEMS);
      setResultsFor(null);
      setIsLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    const searched = { prefix, query: debouncedQuery };
    setIsLoading(true);
    void bridge
      .searchContextProvider(prefix, debouncedQuery)
      .catch(() => EMPTY_ITEMS)
      .then((next) => {
        if (requestIdRef.current !== requestId) return;
        // A picked row's chip reads its name from here.
        for (const item of next) rememberContextReferenceLabel({ prefix, id: item.id }, item.label);
        setItems(next);
        setResultsFor(searched);
        setIsLoading(false);
      });
  }, [enabled, prefix, debouncedQuery]);

  return { items, isLoading, resultsFor };
}
