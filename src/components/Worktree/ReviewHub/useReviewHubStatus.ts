import { useCallback, useEffect, useRef, useState } from "react";
import type { StagingStatus } from "@shared/types";
import { debounce } from "@/utils/debounce";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  beginStagingStatusRead,
  getCachedStagingStatus,
  rememberStagingStatus,
} from "./stagingStatusCache";

interface UseReviewHubStatusArgs {
  isOpen: boolean;
  worktreePath: string;
}

/**
 * The open hub's working-tree staging status: the foreground read, the silent
 * background re-read that worktree events debounce into, and the request
 * generations that keep a superseded read from landing. A background read
 * never raises `loading`, so it never swaps the foreground surface out.
 */
export function useReviewHubStatus({ isOpen, worktreePath }: UseReviewHubStatusArgs) {
  const [status, setStatus] = useState<StagingStatus | null>(null);
  // True once this open's own `getStagingStatus` has landed — false while the
  // status on screen is the cached snapshot seeded at open. Auto-stage, commit
  // and push wait for it; they act on the real index and branch, which the
  // snapshot may no longer describe. Staging a clicked row does not: it is an
  // explicit, reversible action on the path the user chose.
  const [statusIsFresh, setStatusIsFresh] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refreshIdRef = useRef(0);
  const bgRefreshIdRef = useRef(0);
  const debouncedBgRefreshRef = useRef<ReturnType<typeof debounce> | null>(null);

  const refresh = useCallback(async () => {
    if (!worktreePath) return;
    const requestId = ++refreshIdRef.current;
    const readSeq = beginStagingStatusRead();
    setLoading(true);
    setLoadError(null);
    try {
      const result = await window.electron.git.getStagingStatus(worktreePath);
      rememberStagingStatus(worktreePath, result, readSeq);
      if (refreshIdRef.current === requestId) {
        setStatusIsFresh(true);
        setStatus(result);
      }
    } catch (err) {
      if (refreshIdRef.current === requestId) {
        setLoadError(formatErrorMessage(err, "Failed to load staging status"));
      }
    } finally {
      if (refreshIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [worktreePath]);

  const backgroundRefresh = useCallback(async () => {
    if (!worktreePath) return;
    const requestId = ++bgRefreshIdRef.current;
    const readSeq = beginStagingStatusRead();
    setIsBackgroundRefreshing(true);
    try {
      const result = await window.electron.git.getStagingStatus(worktreePath);
      rememberStagingStatus(worktreePath, result, readSeq);
      if (bgRefreshIdRef.current === requestId) {
        setStatusIsFresh(true);
        setStatus(result);
        setLoadError(null);
      }
    } catch {
      // Keep existing data visible; silently drop background errors
    } finally {
      if (bgRefreshIdRef.current === requestId) {
        setIsBackgroundRefreshing(false);
      }
    }
  }, [worktreePath]);

  useEffect(() => {
    if (!isOpen) return;

    const debouncedBgRefresh = debounce(() => void backgroundRefresh(), 800);
    debouncedBgRefreshRef.current = debouncedBgRefresh;

    // Per-view worktree MessagePort — the same delivery the worktree store
    // consumes. The main-relayed events:push copy of worktree-update was
    // removed (this component was its only subscriber).
    const unsubscribeUpdate = window.electron.worktreePort.onEvent("worktree-update", (data) => {
      const event = data as { worktree?: { path?: string } };
      if (event?.worktree?.path === worktreePath) {
        debouncedBgRefresh();
      }
    });
    // A stamp-only update (a watcher flush, a forced status pass) arrives as a
    // tick; it still means the files on disk may have moved.
    const unsubscribeTick = window.electron.worktreePort.onEvent("worktree-tick", (data) => {
      const event = data as { tick?: { path?: string } };
      if (event?.tick?.path === worktreePath) {
        debouncedBgRefresh();
      }
    });

    return () => {
      unsubscribeUpdate();
      unsubscribeTick();
      debouncedBgRefresh.cancel();
      debouncedBgRefreshRef.current = null;
    };
  }, [isOpen, worktreePath, backgroundRefresh]);

  const beginOpen = useCallback(() => {
    setStatusIsFresh(false);
    // A background read still in flight belongs to the previous worktree (or
    // the previous opening); landing it would mark this one fresh.
    bgRefreshIdRef.current++;
    setStatus(worktreePath ? getCachedStagingStatus(worktreePath) : null);
  }, [worktreePath]);

  // Abandons both reads by bumping their generations, so their `finally`
  // blocks no longer reset the flags; the flags are cleared here instead.
  const reset = useCallback(() => {
    refreshIdRef.current++;
    bgRefreshIdRef.current++;
    setLoading(false);
    setStatus(null);
    setLoadError(null);
    setIsBackgroundRefreshing(false);
  }, []);

  return {
    status,
    statusIsFresh,
    loading,
    isBackgroundRefreshing,
    loadError,
    refresh,
    debouncedBgRefreshRef,
    beginOpen,
    reset,
  };
}
