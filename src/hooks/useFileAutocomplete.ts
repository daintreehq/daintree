import { useEffect, useMemo, useRef, useState } from "react";
import { filesClient } from "@/clients/filesClient";

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }

    timerRef.current = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);

    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [delayMs, value]);

  return debounced;
}

export interface UseFileAutocompleteOptions {
  cwd: string;
  query: string;
  enabled: boolean;
  limit?: number;
}

export interface UseFileAutocompleteResult {
  files: string[];
  isLoading: boolean;
  /** Query the current `files` were produced for; null until the first search
   *  resolves or when the results belong to a different cwd. Lets callers
   *  detect stale results while a newer query is debouncing or in flight. */
  resultsQuery: string | null;
}

export function useFileAutocomplete({
  cwd,
  query,
  enabled,
  limit = 50,
}: UseFileAutocompleteOptions): UseFileAutocompleteResult {
  const [files, setFiles] = useState<string[]>([]);
  const [resultsFor, setResultsFor] = useState<{ cwd: string; query: string } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const requestIdRef = useRef(0);

  const debouncedQuery = useDebouncedValue(query, 75);
  const effectiveQuery = useMemo(() => debouncedQuery, [debouncedQuery]);

  useEffect(() => {
    if (!enabled || !cwd) {
      // Invalidate any in-flight search so a late resolve can't repopulate
      // results after the menu closed or the pane lost its cwd.
      requestIdRef.current++;
      setFiles([]);
      setResultsFor(null);
      setIsLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    setIsLoading(true);

    filesClient
      .search({ cwd, query: effectiveQuery, limit })
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        setFiles(result.files);
        setResultsFor({ cwd, query: effectiveQuery });
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) return;
        setFiles([]);
        setResultsFor({ cwd, query: effectiveQuery });
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) return;
        setIsLoading(false);
      });
  }, [cwd, enabled, effectiveQuery, limit]);

  // Results produced for another cwd never count as current — a same-text
  // query in a different worktree must not pass the caller's staleness check.
  const resultsQuery = resultsFor && resultsFor.cwd === cwd ? resultsFor.query : null;

  return { files, isLoading, resultsQuery };
}
