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
import { worktreeEventPath } from "./worktreeEventPath";

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
 * How long a capture can keep the status read it was asked alongside waiting
 * before that read goes out anyway, so a slow capture never holds the list back.
 */
const CAPTURE_WAIT_MS = 1_500;

/** One opening of one worktree; ended by the subscription's cleanup. */
interface Session {
  live: boolean;
}

interface CaptureLane {
  session: Session;
  running: boolean;
  again: boolean;
  /** Sends a status read if the capture is still running when it fires; once per run. */
  timer: ReturnType<typeof setTimeout> | null;
  earlyReadSent: boolean;
}

/**
 * The open hub's working-tree staging status: the foreground read, the silent
 * background re-read that worktree events debounce into, and the publication
 * order that keeps an older read from landing over a newer one. A background
 * read never raises `loading`, so it never swaps the foreground surface out.
 *
 * Beside it runs the capture lane (#14585): the host captures what the
 * worktree holds, on open, on the same events and when asked, and each status
 * read takes the newest capture of its worktree that had landed when the read
 * was sent. A capture that landed before a read went out holds nothing that
 * arrived after that read, so the capture shown with a status never covers
 * content the hub hadn't read. The cached snapshot seeded at open has none.
 * Each capture run is followed by one status read (two when the capture is
 * slow), never one per request: staging status is rate limited on the host.
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
  // Every read, foreground or background, takes the next number when sent; a
  // reply older than the one on screen is dropped.
  const publishSeqRef = useRef(0);
  const publishedSeqRef = useRef(0);
  const debouncedBgRefreshRef = useRef<ReturnType<typeof debounce> | null>(null);
  // Started and ended by the event subscription below, i.e. on open, close and
  // a worktree switch: a capture from another opening is never shown with this
  // one's reads.
  const sessionRef = useRef<Session>({ live: false });
  // The worktree the subscription is open on. A callback a staging action held
  // across a worktree switch still reads its own worktree, and that read must
  // never land in this one's list.
  const openPathRef = useRef<string | null>(null);
  const latestCaptureRef = useRef<{ path: string; capture: ReviewHubCapture } | null>(null);
  const laneRef = useRef<CaptureLane | null>(null);

  /** Whether a read of `path` belongs to the worktree open now; true before any opening. */
  const isOpenPath = useCallback((path: string): boolean => {
    const open = openPathRef.current;
    return open === null || open === path;
  }, []);

  /** The capture a read of `path` sent now may show. */
  const captureForRead = useCallback((path: string): ReviewHubCapture | null => {
    const latest = latestCaptureRef.current;
    return latest && latest.path === path ? latest.capture : null;
  }, []);

  const refresh = useCallback(async () => {
    if (!worktreePath) return;
    const requestId = ++refreshIdRef.current;
    const publishSeq = ++publishSeqRef.current;
    const readSeq = beginStagingStatusRead();
    const capture = captureForRead(worktreePath);
    setLoading(true);
    setLoadError(null);
    try {
      const result = await window.electron.git.getStagingStatus(worktreePath);
      rememberStagingStatus(worktreePath, result, readSeq);
      if (
        refreshIdRef.current === requestId &&
        publishSeq > publishedSeqRef.current &&
        isOpenPath(worktreePath)
      ) {
        publishedSeqRef.current = publishSeq;
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
  }, [worktreePath, captureForRead, isOpenPath]);

  const backgroundRefresh = useCallback(async () => {
    if (!worktreePath) return;
    const requestId = ++bgRefreshIdRef.current;
    const publishSeq = ++publishSeqRef.current;
    const readSeq = beginStagingStatusRead();
    const capture = captureForRead(worktreePath);
    setIsBackgroundRefreshing(true);
    try {
      const result = await window.electron.git.getStagingStatus(worktreePath);
      rememberStagingStatus(worktreePath, result, readSeq);
      if (
        bgRefreshIdRef.current === requestId &&
        publishSeq > publishedSeqRef.current &&
        isOpenPath(worktreePath)
      ) {
        publishedSeqRef.current = publishSeq;
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
  }, [worktreePath, captureForRead, isOpenPath]);

  /**
   * Capture, then read status once the capture lands, or once it's taken too
   * long. A request while one is capturing asks for one more capture after it,
   * and the lane still reads status once, at its end. Where this view can't
   * capture, the read goes straight out, unless `captureOnly` says it was only
   * wanted for the capture.
   */
  const readWithCapture = useCallback(
    (captureOnly = false) => {
      const session = sessionRef.current;
      if (!session.live) return;
      if (!worktreeId || !reviewMarkCapturesAvailable()) {
        if (!captureOnly) void backgroundRefresh();
        return;
      }
      const path = worktreePath;
      const current = laneRef.current;
      const lane: CaptureLane =
        current && current.session === session && current.running
          ? current
          : { session, running: false, again: false, timer: null, earlyReadSent: false };
      if (lane.timer === null && !lane.earlyReadSent) {
        lane.timer = setTimeout(() => {
          lane.timer = null;
          if (!lane.running || !session.live) return;
          lane.earlyReadSent = true;
          void backgroundRefresh();
        }, CAPTURE_WAIT_MS);
      }
      if (lane.running) {
        lane.again = true;
        return;
      }
      lane.running = true;
      laneRef.current = lane;
      void (async () => {
        do {
          lane.again = false;
          const basedOn = getReviewMarksRevision();
          const outcome = await captureForReviewMark(worktreeId)?.catch(() => null);
          if (!session.live) break;
          if (outcome?.status === "captured") {
            latestCaptureRef.current = { path, capture: { capture: outcome.capture, basedOn } };
          }
        } while (lane.again);
        lane.running = false;
        if (lane.timer !== null) clearTimeout(lane.timer);
        lane.timer = null;
        if (session.live) void backgroundRefresh();
      })();
    },
    [worktreeId, worktreePath, backgroundRefresh]
  );

  useEffect(() => {
    if (!isOpen) return;
    const session: Session = { live: true };
    sessionRef.current = session;
    openPathRef.current = worktreePath;
    latestCaptureRef.current = null;

    const debouncedBgRefresh = debounce(() => readWithCapture(), 800);
    debouncedBgRefreshRef.current = debouncedBgRefresh;

    // Per-view worktree MessagePort — the same delivery the worktree store
    // consumes. The main-relayed events:push copy of worktree-update was
    // removed (this component was its only subscriber).
    const unsubscribeUpdate = window.electron.worktreePort.onEvent("worktree-update", (data) => {
      if (worktreeEventPath(data, "worktree") === worktreePath) {
        debouncedBgRefresh();
      }
    });
    // A stamp-only update (a watcher flush, a forced status pass) arrives as a
    // tick; it still means the files on disk may have moved.
    const unsubscribeTick = window.electron.worktreePort.onEvent("worktree-tick", (data) => {
      if (worktreeEventPath(data, "tick") === worktreePath) {
        debouncedBgRefresh();
      }
    });
    // The opening's first capture, so a mark is possible without waiting for an
    // event. The opening's own foreground read covers status where there's none.
    readWithCapture(true);

    return () => {
      session.live = false;
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
