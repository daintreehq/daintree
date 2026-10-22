import { useEffect, useMemo, useRef, useState } from "react";
import type { ContextProviderItem } from "@shared/types/pluginContextProvider";
import { useDebounce } from "@/hooks/useDebounce";
import { rememberContextReferenceLabel } from "@/lib/contextReferenceLabels";

interface UseContextProviderSearchParams {
  /** The prefix the `@` query names, or null when it names none. */
  prefix: string | null;
  /** The plugin holding that prefix here: its rows are its own, never another's. */
  pluginId: string | null;
  /** What the user typed after `@{prefix}:` — all the provider is shown. */
  query: string;
  enabled: boolean;
}

/** Whose answer a set of rows is, and to what. */
export interface ContextProviderSearchKey {
  prefix: string;
  pluginId: string;
  query: string;
}

export interface ContextProviderSearchState {
  items: ContextProviderItem[];
  isLoading: boolean;
  /** The provider and query `items` answer; null until the first answer lands. */
  resultsFor: ContextProviderSearchKey | null;
}

const EMPTY_ITEMS: ContextProviderItem[] = [];

/**
 * Debounced search of a plugin context provider (#13795), in the shape of
 * `useFileAutocomplete`: a request id drops every answer but the newest, and
 * `resultsFor` lets the composer tell rows that answer an older query, or
 * another provider, from current ones, so Enter on a stale row never inserts
 * the wrong item.
 *
 * The provider and the query are debounced as one: a query typed for one
 * provider is never sent to another while the debounce catches up.
 */
export function useContextProviderSearch({
  prefix,
  pluginId,
  query,
  enabled,
}: UseContextProviderSearchParams): ContextProviderSearchState {
  const [items, setItems] = useState<ContextProviderItem[]>(EMPTY_ITEMS);
  const [resultsFor, setResultsFor] = useState<ContextProviderSearchKey | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const requestIdRef = useRef(0);
  const current = useMemo(
    (): ContextProviderSearchKey | null =>
      prefix !== null && pluginId !== null ? { prefix, pluginId, query } : null,
    [prefix, pluginId, query]
  );
  const debounced = useDebounce(current, 75);
  // The debounce has caught up with the provider the query now names.
  const settled =
    current !== null &&
    debounced !== null &&
    debounced.prefix === current.prefix &&
    debounced.pluginId === current.pluginId;

  useEffect(() => {
    const bridge = window.electron?.plugin;
    if (
      !enabled ||
      !settled ||
      debounced === null ||
      typeof bridge?.searchContextProvider !== "function"
    ) {
      // A late answer can't repopulate a menu that closed or moved to another provider.
      requestIdRef.current++;
      setItems(EMPTY_ITEMS);
      setResultsFor(null);
      setIsLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    const searched = debounced;
    setIsLoading(true);
    void bridge
      .searchContextProvider(searched.prefix, searched.query)
      .catch(() => EMPTY_ITEMS)
      .then((next) => {
        if (requestIdRef.current !== requestId) return;
        // A picked row's chip reads its name from here.
        for (const item of next) {
          rememberContextReferenceLabel(
            searched.pluginId,
            { prefix: searched.prefix, id: item.id },
            item.label
          );
        }
        setItems(next);
        setResultsFor(searched);
        setIsLoading(false);
      });
  }, [enabled, settled, debounced]);

  return { items, isLoading, resultsFor };
}
