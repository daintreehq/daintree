import { useCallback, useEffect, useRef } from "react";
import { projectClient } from "@/clients";
import type { SearchableProject } from "./types";

/**
 * Trailing-edge debounce window for the project hover prefetch. Matches the
 * GitHub-stats toolbar pattern (#6282) — long enough to filter cursor
 * traversal across the list, short enough to feel "instant" on intentional
 * dwell.
 */
const PROJECT_HOVER_PREFETCH_DELAY_MS = 150;

/**
 * Renderer-side freshness gate. If the cache was primed for this project less
 * than this many milliseconds ago, the hover handler skips re-prefetching.
 * Shorter than the main-process TTL (30s) so re-hover after a back-and-forth
 * sweep doesn't keep firing the same IPC, but generous enough to span the
 * realistic time between hover and click.
 */
const PROJECT_PREFETCH_FRESHNESS_MS = 15_000;

export interface ProjectHoverPrefetch {
  onHoverProject: (projectId: string, pointerType: string) => void;
  onHoverProjectEnd: (pointerType: string) => void;
}

/**
 * Hover prefetch for the switcher's rows: a trailing-edge debounce that primes
 * main's hydrate cache for the project under the mouse. Cancelled whenever the
 * palette closes, and on unmount.
 */
export function useProjectHoverPrefetch(
  isOpen: boolean,
  searchableProjects: SearchableProject[]
): ProjectHoverPrefetch {
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchInFlightRef = useRef<Set<string>>(new Set());
  const prefetchLastAtRef = useRef<Map<string, number>>(new Map());

  const clearPendingPrefetchTimer = useCallback(() => {
    if (prefetchTimerRef.current !== null) {
      clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
  }, []);

  const runPrefetch = useCallback((projectId: string) => {
    if (prefetchInFlightRef.current.has(projectId)) return;
    const lastAt = prefetchLastAtRef.current.get(projectId) ?? 0;
    if (lastAt > 0 && Date.now() - lastAt < PROJECT_PREFETCH_FRESHNESS_MS) return;

    prefetchInFlightRef.current.add(projectId);
    // projectClient.prefetchHydrate swallows errors (fire-and-forget), so this
    // .then() runs whether the main-process build succeeded or failed. We mark
    // the freshness ref either way: a hover-induced retry-storm against a
    // genuinely failing build is worse than a 15s window where the user gets
    // the normal (uncached) hydrate. The click-time hydrate falls through to
    // the full read path on a cache miss with no user-visible difference.
    void projectClient
      .prefetchHydrate(projectId)
      .then(() => {
        prefetchLastAtRef.current.set(projectId, Date.now());
      })
      .finally(() => {
        prefetchInFlightRef.current.delete(projectId);
      });
  }, []);

  const onHoverProject = useCallback(
    (projectId: string, pointerType: string) => {
      if (pointerType !== "mouse") return;
      const project = searchableProjects.find((p) => p.id === projectId);
      if (!project || project.isActive || project.isMissing) return;
      clearPendingPrefetchTimer();
      prefetchTimerRef.current = setTimeout(() => {
        prefetchTimerRef.current = null;
        runPrefetch(projectId);
      }, PROJECT_HOVER_PREFETCH_DELAY_MS);
    },
    [searchableProjects, clearPendingPrefetchTimer, runPrefetch]
  );

  const onHoverProjectEnd = useCallback(
    (pointerType: string) => {
      if (pointerType !== "mouse") return;
      clearPendingPrefetchTimer();
    },
    [clearPendingPrefetchTimer]
  );

  // Cancel any pending prefetch when the palette closes — the user has either
  // committed to a project (whose hydrate will run via the click path) or
  // bailed out (no need to keep filling the cache).
  useEffect(() => {
    if (isOpen) return;
    clearPendingPrefetchTimer();
  }, [isOpen, clearPendingPrefetchTimer]);

  useEffect(() => () => clearPendingPrefetchTimer(), [clearPendingPrefetchTimer]);

  return { onHoverProject, onHoverProjectEnd };
}
