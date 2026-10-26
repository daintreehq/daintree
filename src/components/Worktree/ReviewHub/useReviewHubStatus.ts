import { useCallback, useEffect, useRef, useState } from "react";
import type { StagingStatus } from "@shared/types";
import type { ReviewMarkCapture } from "@shared/types/ipc/reviewMarks";
import { debounce } from "@/utils/debounce";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  captureForReviewMark,
  getReviewMarksRevision,
  reviewMarkCapturesAvailable,
} from "@/store/reviewMarksStore";
import {
  beginStagingStatusRead,
  getCachedStagingStatus,
  rememberStagingStatus,
} from "./stagingStatusCache";

interface UseReviewHubStatusArgs {
  isOpen: boolean;
  worktreePath: string;
  /** Captures for a review mark need it; without one the hub reads status alone. */
  worktreeId?: string;
}

/** A capture behind a status read the hub displayed: what "Mark reviewed" stores (#14585). */
export interface ReviewHubCapture {
  capture: ReviewMarkCapture;
  /** The marks revision held before the capture started, which the mark names as `basedOn`. */
  basedOn: number;
}

/**
 * How long a background read waits for the capture it was asked alongside
 * before reading status anyway, so a slow capture never holds the list back.
 */
const CAPTURE_WAIT_MS = 1_500;

interface CaptureLane {
  session: number;
  running: Promise<void> | null;
  again: boolean;
  /** A status read went out while this run was capturing, so it got an older capture. */
  statusDuringRun: boolean;
}

/**
 * The open hub's working-tree staging status: the foreground read, the silent
 * background re-read that worktree events debounce into, and the request
 * generations that keep a superseded read from landing. A background read
 * never raises `loading`, so it never swaps the foreground surface out.
 *
 * Beside it runs the capture lane (#14585): the host captures what the
 * worktree holds, on open, on the same events and when asked, and each status
 * read takes the newest capture that had landed when the read was sent. A
 * capture that landed before a read went out holds nothing that arrived after
 * that read, so the capture shown with a status never covers content the hub
 * hadn't read. The cached snapshot seeded at open has none.
 */
export function useReviewHubStatus({ isOpen, worktreePath, worktreeId }: UseReviewHubStatusArgs) {
  const [status, setStatus] = useState<StagingStatus | null>(null);
  const [statusCapture, setStatusCapture] = useState<ReviewHubCapture | null>(null);
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
  // Bumped as the event subscription below starts and stops, i.e. on open,
  // close and a worktree switch: a capture from another opening or worktree is
  // never attached to this one's reads.
  const sessionRef = useRef(0);
  const latestCaptureRef = useRef<ReviewHubCapture | null>(null);
  const laneRef = useRef<CaptureLane>({
    session: 0,
    running: null,
    again: false,
    statusDuringRun: false,
  });

  /** The capture a read sent now may show, noting a read sent while one is capturing. */
  const captureForRead = useCallback((): ReviewHubCapture | null => {
    const lane = laneRef.current;
    if (lane.running && lane.session === sessionRef.current) lane.statusDuringRun = true;
    return latestCaptureRef.current;
  }, []);

  const refresh = useCallback(async () => {
    if (!worktreePath) return;
    const requestId = ++refreshIdRef.current;
    const readSeq = beginStagingStatusRead();
    const capture = captureForRead();
    setLoading(true);
    setLoadError(null);
    try {
      const result = await window.electron.git.getStagingStatus(worktreePath);
      rememberStagingStatus(worktreePath, result, readSeq);
      if (refreshIdRef.current === requestId) {
        setStatusIsFresh(true);
        setStatus(result);
        setStatusCapture(capture);
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
  }, [worktreePath, captureForRead]);

  const backgroundRefresh = useCallback(async () => {
    if (!worktreePath) return;
    const requestId = ++bgRefreshIdRef.current;
    const readSeq = beginStagingStatusRead();
    const capture = captureForRead();
    setIsBackgroundRefreshing(true);
    try {
      const result = await window.electron.git.getStagingStatus(worktreePath);
      rememberStagingStatus(worktreePath, result, readSeq);
      if (bgRefreshIdRef.current === requestId) {
        setStatusIsFresh(true);
        setStatus(result);
        setStatusCapture(capture);
        setLoadError(null);
      }
    } catch {
      // Keep existing data visible; silently drop background errors
    } finally {
      if (bgRefreshIdRef.current === requestId) {
        setIsBackgroundRefreshing(false);
      }
    }
  }, [worktreePath, captureForRead]);

  /**
   * Capture once, or once more after the capture in flight. Resolves when the
   * lane is idle; null when this view can't capture. A status read sent while
   * it ran showed an older capture, so one more read follows to show the new one.
   */
  const runCapture = useCallback((): Promise<void> | null => {
    const session = sessionRef.current;
    if (!worktreeId || !reviewMarkCapturesAvailable()) return null;
    const lane = laneRef.current;
    if (lane.session === session && lane.running) {
      lane.again = true;
      return lane.running;
    }
    const next: CaptureLane = { session, running: null, again: false, statusDuringRun: false };
    laneRef.current = next;
    const run = (async () => {
      do {
        next.again = false;
        const basedOn = getReviewMarksRevision();
        const pending = captureForReviewMark(worktreeId);
        if (!pending) return;
        const outcome = await pending.catch(() => null);
        if (sessionRef.current !== session) return;
        if (outcome?.status === "captured") {
          latestCaptureRef.current = { capture: outcome.capture, basedOn };
        }
      } while (next.again);
    })().finally(() => {
      next.running = null;
      if (next.statusDuringRun && sessionRef.current === session) {
        next.statusDuringRun = false;
        void backgroundRefresh();
      }
    });
    next.running = run;
    return run;
  }, [worktreeId, backgroundRefresh]);

  /**
   * Capture, then read status once the capture lands or once it's taken too
   * long. Where this view can't capture, the read goes straight out, unless
   * `captureOnly` says it was only wanted for the capture.
   */
  const readWithCapture = useCallback(
    (captureOnly = false) => {
      const session = sessionRef.current;
      const capturing = runCapture();
      if (!capturing) {
        if (!captureOnly) void backgroundRefresh();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([
        capturing,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CAPTURE_WAIT_MS);
        }),
      ]).then(() => {
        clearTimeout(timer);
        if (sessionRef.current === session) void backgroundRefresh();
      });
    },
    [runCapture, backgroundRefresh]
  );

  useEffect(() => {
    if (!isOpen) return;
    sessionRef.current++;
    latestCaptureRef.current = null;

    const debouncedBgRefresh = debounce(() => readWithCapture(), 800);
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
    // The opening's first capture, so a mark is possible without waiting for an
    // event. The opening's own foreground read covers status where there's none.
    readWithCapture(true);

    return () => {
      sessionRef.current++;
      latestCaptureRef.current = null;
      unsubscribeUpdate();
      unsubscribeTick();
      debouncedBgRefresh.cancel();
      debouncedBgRefreshRef.current = null;
    };
  }, [isOpen, worktreePath, readWithCapture]);

  const beginOpen = useCallback(() => {
    setStatusIsFresh(false);
    // A background read still in flight belongs to the previous worktree (or
    // the previous opening); landing it would mark this one fresh.
    bgRefreshIdRef.current++;
    // The capture lane's session is the subscription's, which has already
    // started this opening's first capture by the time this runs.
    setStatusCapture(null);
    setStatus(worktreePath ? getCachedStagingStatus(worktreePath) : null);
  }, [worktreePath]);

  // Abandons both reads by bumping their generations, so their `finally`
  // blocks no longer reset the flags; the flags are cleared here instead.
  const reset = useCallback(() => {
    refreshIdRef.current++;
    bgRefreshIdRef.current++;
    setLoading(false);
    setStatus(null);
    setStatusCapture(null);
    setLoadError(null);
    setIsBackgroundRefreshing(false);
  }, []);

  return {
    status,
    statusCapture,
    statusIsFresh,
    loading,
    isBackgroundRefreshing,
    loadError,
    refresh,
    readWithCapture,
    debouncedBgRefreshRef,
    beginOpen,
    reset,
  };
}
