import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type {
  ReviewMarkCompareOutcome,
  ReviewMarkSaveOutcome,
} from "@shared/types/ipc/reviewMarks";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { debounce } from "@/utils/debounce";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
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

/** Quiet time after the worktree moves before comparing again. */
const COMPARE_DEBOUNCE_MS = 1_500;
/** A comparison another view's took over is asked again, this many times in a row. */
const MAX_TRANSIENT_RETRIES = 3;
const TRANSIENT_RETRY_MS = 750;

/**
 * Review Hub's side of review marks (#14585): marking the displayed state,
 * clearing the mark, and keeping the comparison against the mark current.
 *
 * A comparison counts for the line only while nothing has been seen to change
 * since it started: a worktree event drops it to "comparing" until the next one
 * lands. The first comparison against a mark this hub just saved also says
 * what the mark doesn't cover, whatever moved meanwhile.
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

  const sessionRef = useRef(0);
  const eventSeqRef = useRef(0);
  const compareRef = useRef<{ session: number; running: boolean; again: boolean }>({
    session: 0,
    running: false,
    again: false,
  });
  const transientRetriesRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeForRef = useRef<number | null>(null);

  const runCompare = useCallback(() => {
    const session = sessionRef.current;
    if (!worktreeId) return;
    const lane = compareRef.current;
    if (lane.session === session && lane.running) {
      lane.again = true;
      return;
    }
    const next = { session, running: true, again: false };
    compareRef.current = next;
    void (async () => {
      do {
        next.again = false;
        const eventSeq = eventSeqRef.current;
        let outcome: ReviewMarkCompareOutcome;
        try {
          outcome = await compareWithReviewMark(worktreeId);
        } catch (error) {
          outcome = {
            status: "compared",
            markRevision: getHeldMarkRevision(worktreeId) ?? -1,
            result: {
              state: "failed",
              reason: "git-failed",
              message: formatErrorMessage(error, "The comparison failed."),
            },
          };
        }
        if (sessionRef.current !== session) return;
        if (isTransientComparisonFailure(outcome)) {
          if (transientRetriesRef.current < MAX_TRANSIENT_RETRIES && !next.again) {
            transientRetriesRef.current++;
            if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
            retryTimerRef.current = setTimeout(() => {
              retryTimerRef.current = null;
              if (sessionRef.current === session) runCompare();
            }, TRANSIENT_RETRY_MS);
          }
          continue;
        }
        transientRetriesRef.current = 0;
        const revision = outcome.status === "none" ? null : outcome.markRevision;
        if (revision !== null && revision === noticeForRef.current) {
          noticeForRef.current = null;
          setNoticeFor(null);
          const derived = reviewMarkNoticeFor(outcome);
          setNotice(derived ? { markRevision: revision, notice: derived } : null);
        }
        if (revision !== null) setComparison({ markRevision: revision, outcome });
        if (eventSeq === eventSeqRef.current) setComparisonStale(false);
      } while (next.again && sessionRef.current === session);
      next.running = false;
    })();
  }, [worktreeId]);

  // One session per opening of this worktree: replies from another are dropped.
  useEffect(() => {
    if (!isOpen || !worktreeId) return;
    sessionRef.current++;
    const onEvent = debounce(() => runCompare(), COMPARE_DEBOUNCE_MS);
    const moved = () => {
      eventSeqRef.current++;
      setComparisonStale(true);
      if (getHeldMarkRevision(worktreeId) !== null) onEvent();
    };
    const offUpdate = window.electron.worktreePort.onEvent("worktree-update", (data) => {
      const event = data as { worktree?: { path?: string } };
      if (event?.worktree?.path === worktreePath) moved();
    });
    const offTick = window.electron.worktreePort.onEvent("worktree-tick", (data) => {
      const event = data as { tick?: { path?: string } };
      if (event?.tick?.path === worktreePath) moved();
    });
    return () => {
      sessionRef.current++;
      offUpdate();
      offTick();
      onEvent.cancel();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      transientRetriesRef.current = 0;
      noticeForRef.current = null;
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
    if (!worktreeId || !statusCapture || isMarking) return;
    const session = sessionRef.current;
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
      if (sessionRef.current === session) {
        setIsMarking(false);
        onFailure({
          title: "Couldn't mark reviewed",
          detail: formatErrorMessage(error, "The review mark wasn't saved."),
        });
      }
      return;
    }
    if (sessionRef.current !== session) return;
    setIsMarking(false);
    // Every capture held now names a revision from before this write, so the
    // next mark needs a fresh one whatever happened.
    readWithCapture();
    const failure = saveFailure(outcome);
    if (failure) {
      onFailure(failure);
      return;
    }
    const saved = outcome.snapshot.marks[worktreeId]?.revision ?? null;
    noticeForRef.current = saved;
    setNoticeFor(saved);
  }, [worktreeId, statusCapture, isMarking, readWithCapture, onFailure]);

  const clearReviewMark = useCallback(async () => {
    if (!worktreeId || isClearing) return;
    const session = sessionRef.current;
    setIsClearing(true);
    setNotice(null);
    try {
      const outcome = await clearWorktreeReviewMark(worktreeId, getReviewMarksRevision());
      if (sessionRef.current !== session) return;
      readWithCapture();
      if (outcome.status === "stale") {
        onFailure({
          title: "Couldn't clear review mark",
          detail: "The mark changed in another window, so it was left as it is.",
        });
      }
    } catch (error) {
      if (sessionRef.current === session) {
        onFailure({
          title: "Couldn't clear review mark",
          detail: formatErrorMessage(error, "The review mark wasn't cleared."),
        });
      }
    } finally {
      if (sessionRef.current === session) setIsClearing(false);
    }
  }, [worktreeId, isClearing, readWithCapture, onFailure]);

  const retryCompare = useCallback(() => {
    transientRetriesRef.current = 0;
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

function getHeldMarkRevision(worktreeId: string): number | null {
  const marks = useReviewMarksStore.getState().marks;
  return Object.hasOwn(marks, worktreeId) ? (marks[worktreeId]?.revision ?? null) : null;
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

function saveFailure(outcome: ReviewMarkSaveOutcome): { title: string; detail: string } | null {
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
