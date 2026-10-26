import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type {
  ReviewMarkCompareOutcome,
  ReviewMarkSaveOutcome,
} from "@shared/types/ipc/reviewMarks";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { debounce } from "@/utils/debounce";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useDiffViewedStore } from "@/store/diffViewedStore";
import {
  clearWorktreeReviewMark,
  compareWithReviewMark,
  getReviewMarksRevision,
  markCapturedWorktreeReviewed,
  useReviewMarksStore,
  worktreeReviewMark,
  type WorktreeReviewMark,
} from "@/store/reviewMarksStore";
import type { ReviewHubCapture } from "./useReviewHubStatus";
import {
  isTransientComparisonFailure,
  reviewMarkNoticeFor,
  type ReviewMarkNotice,
} from "./reviewMarkComparison";
import { worktreeEventPath } from "./worktreeEventPath";

export interface ReviewHubMarkFailure {
  title: string;
  detail: string;
}

interface UseReviewHubMarkArgs {
  isOpen: boolean;
  worktreeId: string | undefined;
  worktreePath: string;
  /** The capture behind the status on screen; marking stores it. */
  statusCapture: ReviewHubCapture | null;
  /** Read the worktree again with a fresh capture. */
  readWithCapture: () => void;
  onFailure: (failure: ReviewHubMarkFailure) => void;
}

interface HeldComparison {
  markRevision: number;
  outcome: ReviewMarkCompareOutcome;
}

/** One opening of one worktree; ended by the subscription's cleanup. */
interface Session {
  live: boolean;
  transientRetries: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

interface CompareLane {
  session: Session;
  running: boolean;
  again: boolean;
}

/** Quiet time after the worktree moves before comparing again. */
const COMPARE_DEBOUNCE_MS = 1_500;
/**
 * Another view's comparison of the same worktree replaces this one's on the
 * host. It's asked again this many times, spaced out, before it's reported.
 */
const MAX_TRANSIENT_RETRIES = 3;
const TRANSIENT_RETRY_MS = 750;

/**
 * Review Hub's side of review marks (#14585): marking the displayed state,
 * clearing the mark, and keeping the comparison against the mark current.
 *
 * A comparison counts for the line only while nothing has been seen to change
 * since it started: a worktree event drops it to "comparing" until the next one
 * lands. The first comparison against a mark this hub just saved also says
 * what the mark doesn't cover; one the worktree moved under settles that only
 * when it already found something.
 */
export function useReviewHubMark({
  isOpen,
  worktreeId,
  worktreePath,
  statusCapture,
  readWithCapture,
  onFailure,
}: UseReviewHubMarkArgs) {
  const marks = useReviewMarksStore((state) => state.marks);
  const head = useWorktreeStore(
    useShallow((state) => {
      const worktree = worktreeId ? state.worktrees.get(worktreeId) : undefined;
      return { branch: worktree?.branch, isDetached: worktree?.isDetached };
    })
  );
  const reviewMark: WorktreeReviewMark | null = worktreeId
    ? worktreeReviewMark(marks, { id: worktreeId, ...head })
    : null;
  const markRevision = reviewMark?.mark.revision ?? null;

  const [comparison, setComparison] = useState<HeldComparison | null>(null);
  // True from a worktree event until a comparison started after it lands.
  const [comparisonStale, setComparisonStale] = useState(true);
  const [noticeFor, setNoticeFor] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ markRevision: number; notice: ReviewMarkNotice } | null>(
    null
  );
  const [isMarking, setIsMarking] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const sessionRef = useRef<Session>({ live: false, transientRetries: 0, retryTimer: null });
  const eventSeqRef = useRef(0);
  const compareLaneRef = useRef<CompareLane | null>(null);
  const noticeForRef = useRef<number | null>(null);
  // The newest comparison that settled, for a notice armed after it landed.
  const lastComparisonRef = useRef<(HeldComparison & { fresh: boolean; session: Session }) | null>(
    null
  );

  const settleNotice = useCallback(
    (revision: number, outcome: ReviewMarkCompareOutcome, fresh: boolean) => {
      if (noticeForRef.current !== revision) return;
      const derived = reviewMarkNoticeFor(outcome);
      // The worktree moved while this one ran, so it may have missed a change;
      // a later comparison settles the notice unless this one found something.
      if (!fresh && derived === null) return;
      noticeForRef.current = null;
      setNoticeFor(null);
      setNotice(derived ? { markRevision: revision, notice: derived } : null);
    },
    []
  );

  const runCompare = useCallback(() => {
    const session = sessionRef.current;
    if (!session.live || !worktreeId) return;
    const current = compareLaneRef.current;
    if (current && current.session === session && current.running) {
      current.again = true;
      return;
    }
    const lane: CompareLane = { session, running: true, again: false };
    compareLaneRef.current = lane;
    void (async () => {
      do {
        lane.again = false;
        const eventSeq = eventSeqRef.current;
        let outcome = await compareWithReviewMark(worktreeId).catch(
          (error: unknown): ReviewMarkCompareOutcome =>
            failedComparison(worktreeId, formatErrorMessage(error, "The comparison failed."))
        );
        if (!session.live) break;
        if (isTransientComparisonFailure(outcome)) {
          // A newer one of this hub's is coming anyway.
          if (lane.again) continue;
          if (session.transientRetries < MAX_TRANSIENT_RETRIES) {
            session.transientRetries++;
            // Spread out, so two windows' hubs stop replacing each other's.
            const delay = TRANSIENT_RETRY_MS * (1 + Math.random());
            if (session.retryTimer !== null) clearTimeout(session.retryTimer);
            session.retryTimer = setTimeout(() => {
              session.retryTimer = null;
              if (session.live) runCompare();
            }, delay);
            continue;
          }
          outcome = failedComparison(
            worktreeId,
            "Other comparisons of this worktree kept replacing this one."
          );
        }
        session.transientRetries = 0;
        const fresh = eventSeq === eventSeqRef.current;
        if (outcome.status !== "none") {
          const revision = outcome.markRevision;
          lastComparisonRef.current = { markRevision: revision, outcome, fresh, session };
          settleNotice(revision, outcome, fresh);
          setComparison({ markRevision: revision, outcome });
        }
        if (fresh) setComparisonStale(false);
      } while (lane.again && session.live);
      lane.running = false;
    })();
  }, [worktreeId, settleNotice]);

  useEffect(() => {
    if (!isOpen || !worktreeId) return;
    const session: Session = { live: true, transientRetries: 0, retryTimer: null };
    sessionRef.current = session;
    const onEvent = debounce(() => runCompare(), COMPARE_DEBOUNCE_MS);
    const moved = () => {
      eventSeqRef.current++;
      setComparisonStale(true);
      if (heldMarkRevision(worktreeId) !== null) onEvent();
    };
    const offUpdate = window.electron.worktreePort.onEvent("worktree-update", (data) => {
      if (worktreeEventPath(data, "worktree") === worktreePath) moved();
    });
    const offTick = window.electron.worktreePort.onEvent("worktree-tick", (data) => {
      if (worktreeEventPath(data, "tick") === worktreePath) moved();
    });
    return () => {
      session.live = false;
      if (session.retryTimer !== null) clearTimeout(session.retryTimer);
      session.retryTimer = null;
      offUpdate();
      offTick();
      onEvent.cancel();
      noticeForRef.current = null;
      lastComparisonRef.current = null;
      // A mark or clear still out belongs to this session; its reply is dropped.
      setIsMarking(false);
      setIsClearing(false);
      setComparison(null);
      setComparisonStale(true);
      setNotice(null);
      setNoticeFor(null);
    };
  }, [isOpen, worktreeId, worktreePath, runCompare]);

  // A new or changed mark is compared straight away, as is the one there at open.
  useEffect(() => {
    if (!isOpen || markRevision === null) return;
    eventSeqRef.current++;
    setComparisonStale(true);
    runCompare();
  }, [isOpen, markRevision, runCompare]);

  const markReviewed = useCallback(async () => {
    const session = sessionRef.current;
    if (!session.live || !worktreeId || !statusCapture || isMarking) return;
    setIsMarking(true);
    setNotice(null);
    let outcome: ReviewMarkSaveOutcome;
    try {
      outcome = await markCapturedWorktreeReviewed(
        worktreeId,
        statusCapture.capture.captureId,
        statusCapture.basedOn
      );
    } catch (error) {
      if (session.live) {
        setIsMarking(false);
        onFailure({
          title: "Couldn't mark reviewed",
          detail: formatErrorMessage(error, "The review mark wasn't saved."),
        });
      }
      return;
    }
    if (!session.live) return;
    setIsMarking(false);
    // Every capture held now names a revision from before this write, so the
    // next mark needs a fresh one whatever happened.
    readWithCapture();
    const failure = saveFailure(outcome);
    if (failure) {
      onFailure(failure);
      return;
    }
    // Every view clears its own as the new mark reaches it; this one may not
    // count the reply as new when it's the first snapshot the view adopts.
    useDiffViewedStore.getState().clearWorktree(worktreePath);
    const saved = outcome.snapshot.marks[worktreeId]?.revision ?? null;
    noticeForRef.current = saved;
    setNoticeFor(saved);
    // The push can beat the reply, and so can the comparison it started.
    const last = lastComparisonRef.current;
    if (saved !== null && last && last.session === session && last.markRevision === saved) {
      settleNotice(saved, last.outcome, last.fresh);
    }
  }, [
    worktreeId,
    worktreePath,
    statusCapture,
    isMarking,
    readWithCapture,
    onFailure,
    settleNotice,
  ]);

  const clearReviewMark = useCallback(async () => {
    const session = sessionRef.current;
    if (!session.live || !worktreeId || isClearing) return;
    setIsClearing(true);
    setNotice(null);
    try {
      const outcome = await clearWorktreeReviewMark(worktreeId, getReviewMarksRevision());
      if (!session.live) return;
      readWithCapture();
      if (outcome.status === "stale") {
        onFailure({
          title: "Couldn't clear review mark",
          detail: "The mark changed in another window, so it was left as it is.",
        });
      }
    } catch (error) {
      if (session.live) {
        onFailure({
          title: "Couldn't clear review mark",
          detail: formatErrorMessage(error, "The review mark wasn't cleared."),
        });
      }
    } finally {
      if (session.live) setIsClearing(false);
    }
  }, [worktreeId, isClearing, readWithCapture, onFailure]);

  const retryCompare = useCallback(() => {
    sessionRef.current.transientRetries = 0;
    setComparisonStale(true);
    runCompare();
  }, [runCompare]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const currentComparison =
    !comparisonStale && comparison && comparison.markRevision === markRevision
      ? comparison.outcome
      : null;

  return {
    reviewMark,
    comparison: currentComparison,
    notice: notice && notice.markRevision === markRevision ? notice.notice : null,
    isRecording: noticeFor !== null && noticeFor === markRevision,
    isMarking,
    isClearing,
    markBlockedReason: markBlockedReason(worktreeId, statusCapture, isMarking),
    markReviewed,
    clearReviewMark,
    retryCompare,
    dismissNotice,
  };
}

function heldMarkRevision(worktreeId: string): number | null {
  const marks = useReviewMarksStore.getState().marks;
  return Object.hasOwn(marks, worktreeId) ? (marks[worktreeId]?.revision ?? null) : null;
}

function failedComparison(worktreeId: string, message: string): ReviewMarkCompareOutcome {
  return {
    status: "compared",
    markRevision: heldMarkRevision(worktreeId) ?? -1,
    result: { state: "failed", reason: "git-failed", message },
  };
}

function markBlockedReason(
  worktreeId: string | undefined,
  statusCapture: ReviewHubCapture | null,
  isMarking: boolean
): string | null {
  if (!worktreeId) return "This worktree isn't known yet";
  if (isMarking) return "Already marking";
  if (!statusCapture) return "Review Hub is still reading this worktree";
  return null;
}

function saveFailure(outcome: ReviewMarkSaveOutcome): ReviewHubMarkFailure | null {
  const title = "Couldn't mark reviewed";
  switch (outcome.status) {
    case "saved":
      return null;
    case "stale":
      return {
        title,
        detail:
          "This worktree's review mark changed in another window. Review Hub is reading the worktree again; mark it once that's done.",
      };
    case "expired":
      return {
        title,
        detail:
          "Review Hub's read of this worktree is no longer held. It's reading the worktree again; mark it once that's done.",
      };
    case "mismatch":
      return {
        title,
        detail:
          outcome.reason === "branch"
            ? "The worktree is on another branch than when Review Hub read it."
            : "The worktree changed under Review Hub. It's reading the worktree again.",
      };
    case "unavailable":
      return { title, detail: "The host couldn't confirm the worktree, so nothing was marked." };
  }
}
