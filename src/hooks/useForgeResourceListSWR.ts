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
 * `forge:list-issues` / `forge:list-prs` IPC path via {@link forgeClient} — it
 * never touches `window.electron.github`, so any forge provider can drive an
 * issue/PR list with it.
 *
 * The GitHub plugin's `useGitHubResourceListSWR` stays as-is: it carries
 * GitHub-shaped types and GitHub-specific retry/rate-limit/wake machinery that
 * does not generalize. This hook is the lean, normalized counterpart — cache
 * read, revalidate, generation-guarded stale-response discard.
 */
export interface UseForgeResourceListParams {
  cwd: string;
  /** Forge identity for the provider-scoped cache key. */
  providerId: string;
  owner: string;
  repo: string;
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
  providerId,
  owner,
  repo,
  type,
  filterState,
  sortOrder,
  opts,
}: UseForgeResourceListParams): UseForgeResourceListReturn {
  const cacheKey = useMemo(
    () => buildCacheKey(providerId, owner, repo, type, filterState, sortOrder),
    [providerId, owner, repo, type, filterState, sortOrder]
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

    const fetchPage =
      type === "issue" ? forgeClient.listIssues(cwd, opts) : forgeClient.listPRs(cwd, opts);

    fetchPage
      .then((page) => {
        // Discard if a newer fetch/mutation superseded this one.
        if (cancelled || getGeneration(cacheKey) !== generation) return;
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
        if (cancelled || getGeneration(cacheKey) !== generation) return;
        setError(
          formatErrorMessage(
            err,
            type === "issue" ? "Couldn't load issues" : "Couldn't load pull requests"
          )
        );
      })
      .finally(() => {
        if (cancelled || getGeneration(cacheKey) !== generation) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, cwd, type, optsKey, reloadToken]);

  return { data, hasMore, loading, refreshing, error, lastUpdatedAt, refresh };
}
