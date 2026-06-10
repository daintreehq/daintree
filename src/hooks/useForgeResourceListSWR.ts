import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildCacheKey,
  getCache,
  setCache,
  nextGeneration,
  getGeneration,
} from "@/lib/forgeResourceCache";
import { forgeClient } from "@/clients/forgeClient";
import type { Issue, PR, ListOptions } from "@shared/types/forge";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/**
 * Provider-agnostic stale-while-revalidate list hook. Consumes the normalized
 * `forge:list-issues` / `forge:list-prs` IPC path via {@link forgeClient}, so
 * any forge provider can drive an issue/PR list with it.
 *
 * The plugin-side dropdown list hook carries the dropdown-specific
 * retry/rate-limit/wake machinery that does not generalize. This hook is the
 * lean counterpart — cache read, revalidate, generation-guarded
 * stale-response discard. Both share {@link buildCacheKey} slots.
 */
export interface UseForgeResourceListParams {
  cwd: string;
  type: "issue" | "pr";
  filterState: string;
  sortOrder: string;
  opts?: ListOptions;
}

export interface UseForgeResourceListReturn {
  data: (Issue | PR)[];
  hasMore: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  lastUpdatedAt: number | null;
  refresh: () => void;
}

export function useForgeResourceListSWR({
  cwd,
  type,
  filterState,
  sortOrder,
  opts,
}: UseForgeResourceListParams): UseForgeResourceListReturn {
  const cacheKey = useMemo(
    () => buildCacheKey(cwd, type, filterState, sortOrder),
    [cwd, type, filterState, sortOrder]
  );

  const cachedEntry = useMemo(() => getCache(cacheKey), [cacheKey]);

  const [data, setData] = useState<(Issue | PR)[]>(() => cachedEntry?.items ?? []);
  const [hasMore, setHasMore] = useState(() => cachedEntry?.hasMore ?? false);
  const [loading, setLoading] = useState(() => !cachedEntry);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(
    () => cachedEntry?.timestamp ?? null
  );
  const [reloadToken, setReloadToken] = useState(0);

  // Serialized listing opts so an inline object literal doesn't retrigger the
  // fetch effect every render.
  const optsKey = useMemo(() => JSON.stringify(opts ?? {}), [opts]);

  const refresh = useCallback(() => {
    setReloadToken((t) => t + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const generation = nextGeneration(cacheKey);

    const cached = getCache(cacheKey);
    if (cached) {
      setData(cached.items);
      setHasMore(cached.hasMore);
      setLastUpdatedAt(cached.timestamp);
      setLoading(false);
      setRefreshing(true);
    } else {
      // Cache miss after a key change (repo/provider/filter switch): drop the
      // previous slot's rows so a consumer rendering `data` while `loading` is
      // true never shows the wrong repo's issues, even if the new fetch fails.
      setData([]);
      setHasMore(false);
      setLastUpdatedAt(null);
      setLoading(true);
      setRefreshing(false);
    }
    setError(null);

    let opts: ListOptions;
    try {
      const parsed = JSON.parse(optsKey);
      if (typeof parsed !== "object" || parsed === null) {
        opts = {};
      } else {
        opts = parsed;
      }
    } catch {
      opts = {};
    }

    // Superseded only by a *strictly newer* generation (a later fetch or a
    // `mutateCacheEntries` bump). A plain `!==` would also discard this
    // response when the bounded generation map evicts our key back to 0,
    // stranding the hook in a permanent loading state (#8455 review).
    const isSuperseded = () => getGeneration(cacheKey) > generation;

    const fetchPage =
      type === "issue" ? forgeClient.listIssues(cwd, opts) : forgeClient.listPRs(cwd, opts);

    fetchPage
      .then((page) => {
        if (cancelled || isSuperseded()) return;
        const entry = {
          items: page.items,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          timestamp: Date.now(),
        };
        setCache(cacheKey, entry);
        setData(entry.items);
        setHasMore(entry.hasMore);
        setLastUpdatedAt(entry.timestamp);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled || isSuperseded()) return;
        setError(
          formatErrorMessage(
            err,
            type === "issue" ? "Couldn't load issues" : "Couldn't load pull requests"
          )
        );
      })
      .finally(() => {
        if (cancelled || isSuperseded()) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, cwd, type, optsKey, reloadToken]);

  return { data, hasMore, loading, refreshing, error, lastUpdatedAt, refresh };
}
