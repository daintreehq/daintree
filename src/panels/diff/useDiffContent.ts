import { use, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePreferencesStore } from "@/store/preferencesStore";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import {
  diffCacheKey,
  purgeOtherWhitespaceEntries,
  requestDiff,
  selectDiffFreshnessKey,
  type DiffSubject,
} from "./diffContentCache";

const PREFETCH_DWELL_MS = 500;

export interface UseDiffContentResult {
  /** Diff text, `"NO_CHANGES"`, `"ERROR"`, or undefined while loading. */
  content: string | undefined;
  /** The store saw the file change after the shown diff was fetched. */
  stale: boolean;
  retry: () => void;
}

/**
 * Owns one diff panel's content: fetch, request sequencing, freshness tracking
 * and the next-file prefetch. The bounded LRU behind it is module-scoped and
 * shared by every panel (see `diffContentCache`).
 */
export function useDiffContent(
  subject: DiffSubject | null,
  nextSubject?: DiffSubject | null
): UseDiffContentResult {
  const [content, setContent] = useState<string | undefined>(undefined);
  // Freshness key the shown diff was fetched under, tagged with its cache key
  // so a navigation in progress never compares one file's baseline against
  // another file's live key.
  const [freshnessBaseline, setFreshnessBaseline] = useState<{
    subject: string;
    key: string | undefined;
  } | null>(null);
  const requestRef = useRef(0);
  const ignoreWhitespace = usePreferencesStore((s) => s.diffIgnoreWhitespace);

  // Tolerate hosts mounted without a worktree-store provider (mirrors
  // useFleetPicker): staleness detection simply never fires there.
  const worktreeStore = use(WorktreeStoreContext);

  const worktreePath = subject?.worktreePath;
  const filePath = subject?.filePath;

  const liveFreshnessKey = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) =>
        worktreeStore ? worktreeStore.subscribe(onStoreChange) : () => {},
      [worktreeStore]
    ),
    useCallback(
      () =>
        worktreeStore && worktreePath !== undefined && filePath !== undefined
          ? selectDiffFreshnessKey(worktreeStore.getState(), worktreePath, filePath)
          : undefined,
      [worktreeStore, worktreePath, filePath]
    )
  );

  // Toggling ignore-whitespace strands every entry built under the other flag
  // (their keys can no longer be requested this session unless the user
  // toggles back, and a long review can hold 20 stale diffs). Purge them.
  useEffect(() => {
    purgeOtherWhitespaceEntries(ignoreWhitespace);
  }, [ignoreWhitespace]);

  const subjectKey = subject === null ? null : diffCacheKey(subject, ignoreWhitespace);

  const fetchDiff = useCallback(
    async (bypassCache: boolean) => {
      if (!subject) return;
      const cacheKey = diffCacheKey(subject, ignoreWhitespace);
      const requestId = ++requestRef.current;
      // Captured at initiation — a change landing mid-fetch then reads as
      // stale (a spurious banner costs one cheap refresh; a miss defeats the
      // feature).
      const freshnessKey = worktreeStore
        ? selectDiffFreshnessKey(worktreeStore.getState(), subject.worktreePath, subject.filePath)
        : undefined;
      setContent(undefined);
      try {
        const entry = await requestDiff(subject, ignoreWhitespace, bypassCache, freshnessKey);
        if (requestRef.current !== requestId) return;
        // Baseline from the entry, not the local key: a joined in-flight
        // request's content corresponds to its initiator's capture time.
        if (entry) setFreshnessBaseline({ subject: cacheKey, key: entry.freshnessKey });
        setContent(entry?.content ?? "ERROR");
      } catch {
        if (requestRef.current !== requestId) return;
        setContent("ERROR");
      }
    },
    // `subjectKey` stands in for `subject`: the object identity changes every
    // render, the key only when what we're diffing actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subjectKey, ignoreWhitespace, worktreeStore]
  );

  const retry = useCallback(() => {
    void fetchDiff(true);
  }, [fetchDiff]);

  // Keyed on `subjectKey`, not `subject`: the object is rebuilt every render,
  // so depending on it would refetch on every render.
  useEffect(() => {
    if (subjectKey === null) {
      setContent(undefined);
      setFreshnessBaseline(null);
      // Invalidate any in-flight response so it can't land on the next subject.
      requestRef.current++;
      return;
    }
    void fetchDiff(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectKey, fetchDiff]);

  // Once the current diff has landed and the user has dwelled on it, warm the
  // next file's diff so forward stepping renders from cache instead of a
  // skeleton. The dwell timer keeps rapid scrubbing from bursting requests
  // against the shared gitOps rate limit; failures are silently dropped — the
  // foreground fetch will retry and surface its own error.
  const nextKey = nextSubject ? diffCacheKey(nextSubject, ignoreWhitespace) : null;
  useEffect(() => {
    if (!nextSubject || content === undefined || content === "ERROR") return;
    const timer = window.setTimeout(() => {
      const nextFreshnessKey = worktreeStore
        ? selectDiffFreshnessKey(
            worktreeStore.getState(),
            nextSubject.worktreePath,
            nextSubject.filePath
          )
        : undefined;
      void requestDiff(nextSubject, ignoreWhitespace, false, nextFreshnessKey).catch(
        () => undefined
      );
    }, PREFETCH_DWELL_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextKey, content, worktreeStore, ignoreWhitespace]);

  // Stale = the store saw the file change after the shown diff was fetched.
  // Undefined keys (unprovided host, untracked worktree, store not yet
  // hydrated at fetch time) never flag — no signal, not "fresh".
  const stale =
    content !== undefined &&
    content !== "ERROR" &&
    freshnessBaseline !== null &&
    subjectKey !== null &&
    freshnessBaseline.subject === subjectKey &&
    freshnessBaseline.key !== undefined &&
    liveFreshnessKey !== undefined &&
    liveFreshnessKey !== freshnessBaseline.key;

  return { content, stale, retry };
}
