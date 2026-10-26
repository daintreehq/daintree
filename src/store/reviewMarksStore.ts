import { create } from "zustand";
import type { ReviewPoint } from "@shared/types/reviewPoint";
import type {
  ReviewMarkCaptureOutcome,
  ReviewMarkClearOutcome,
  ReviewMarkCompareOutcome,
  ReviewMarkSaveOutcome,
  ReviewMarkSummary,
  ReviewMarksSnapshot,
} from "@shared/types/ipc/reviewMarks";
import {
  reviewMarkApplicability,
  type ReviewMarkApplicability,
  type ReviewMarkWorktreeHead,
} from "@shared/utils/reviewMarkApplicability";
import { logWarn } from "@/utils/logger";
import { onHostResync } from "./hostResyncSignal";

/**
 * This view's copy of its project's review marks (#14584). Main holds them on
 * the host, beside the repository, and sends every view of the project each
 * change; no call carries a project id. Renderer state is per project view, so
 * this module-level store is already scoped to one project.
 */
export interface ReviewMarksState {
  /** Worktree id → its mark, as main last said. */
  marks: Record<string, ReviewMarkSummary>;
  /** Main's write count for the marks held here; an older snapshot is dropped. */
  revision: number;
  /** True once main has answered for this view's project. */
  loaded: boolean;
}

const NO_MARKS: Record<string, ReviewMarkSummary> = {};

export const useReviewMarksStore = create<ReviewMarksState>(() => ({
  marks: NO_MARKS,
  revision: 0,
  loaded: false,
}));

let pull: Promise<void> | null = null;
// Snapshots adopted so far. A pull that saw none land while it was in flight is
// the newest word there is, so it may move the revision down: the way back for
// a view whose host store was reset under it.
let adoptions = 0;
// A relaunch restores the last project before main has registered its view,
// and a slow start can register it well after the renderer loaded.
const PULL_RETRY_MS = [250, 1000, 3000, 10_000, 30_000] as const;

/** Main has no project for this view yet, or never will (a view with no project open). */
class ReviewMarksUnboundError extends Error {
  constructor() {
    super("Review marks aren't available until the project finishes opening");
  }
}

function reviewMarksBridge() {
  return typeof window === "undefined" ? undefined : window.electron?.reviewMarks;
}

function adopt(snapshot: ReviewMarksSnapshot, authoritative = false): void {
  const held = useReviewMarksStore.getState();
  if (!authoritative && held.loaded && snapshot.revision <= held.revision) return;
  ++adoptions;
  useReviewMarksStore.setState({
    marks: snapshot.marks,
    revision: snapshot.revision,
    loaded: true,
  });
}

/**
 * A write's reply. One naming a revision below the one the write started from
 * means main's store started over since, and with nothing adopted while the
 * write was out, the reply is the newest word there is.
 */
function adoptReply(
  snapshot: ReviewMarksSnapshot,
  basedOn: number,
  adoptionsAtStart: number
): void {
  if (basedOn <= snapshot.revision) {
    adopt(snapshot);
  } else if (adoptions === adoptionsAtStart) {
    adopt(snapshot, true);
  } else {
    // Something landed while the write was out, so this reply can't say which
    // is newer. A read taken from here can, once any read in flight is done.
    void (pull ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => pullReviewMarks())
      .catch((error: unknown) => {
        logWarn("[reviewMarksStore] Failed to read review marks again", { error });
      });
  }
}

/** Read main's marks and adopt them. Shared while in flight; rejects on an unbound or failed read. */
function pullReviewMarks(): Promise<void> {
  if (pull) return pull;
  const api = reviewMarksBridge();
  if (typeof api?.hydrate !== "function") return Promise.resolve();
  const adoptionsAtStart = adoptions;
  const attempt = api.hydrate().then(
    (snapshot) => {
      if (pull === attempt) pull = null;
      // `== null`: a stubbed bridge answers `undefined`.
      if (snapshot == null) throw new ReviewMarksUnboundError();
      adopt(snapshot, adoptions === adoptionsAtStart);
    },
    (error: unknown) => {
      if (pull === attempt) pull = null;
      throw error;
    }
  );
  pull = attempt;
  return attempt;
}

/**
 * Follow main's marks for this view: pull once (retrying an unbound read),
 * adopt every push, and pull again when a remote view's link comes back, since
 * pushes sent while it was down are gone. Returns the disposer.
 */
export function startReviewMarksSync(): () => void {
  const api = reviewMarksBridge();
  if (typeof api?.onChanged !== "function") return () => {};
  let disposed = false;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Main sends to every view of the project and only to them.
  const unsubscribe = api.onChanged((snapshot) => adopt(snapshot));
  const pullWithRetry = (): void => {
    pullReviewMarks().catch((error: unknown) => {
      if (disposed || useReviewMarksStore.getState().loaded) return;
      const delay = PULL_RETRY_MS[retries++];
      if (delay === undefined) {
        // Still unbound after the retries is a view with no project, not a fault.
        if (!(error instanceof ReviewMarksUnboundError)) {
          logWarn("[reviewMarksStore] Failed to read review marks", { error });
        }
        return;
      }
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!disposed) pullWithRetry();
      }, delay);
    });
  };
  // Reconnects come in bursts; only the latest one's re-read keeps retrying.
  let resyncs = 0;
  let resyncTimer: ReturnType<typeof setTimeout> | null = null;
  const pullAfterResync = (resync: number, attempt: number): void => {
    // A pull already in flight may have been answered before the lost pushes,
    // so read once more after it settles rather than joining it.
    const inFlight = pull;
    const pullAfter = inFlight
      ? inFlight
          .catch(() => undefined)
          .then(() => (disposed || resync !== resyncs ? undefined : pullReviewMarks()))
      : pullReviewMarks();
    pullAfter.catch((error: unknown) => {
      if (disposed || resync !== resyncs) return;
      const delay = PULL_RETRY_MS[attempt];
      if (delay === undefined) {
        logWarn("[reviewMarksStore] Failed to read review marks after reconnecting", { error });
        return;
      }
      resyncTimer = setTimeout(() => {
        resyncTimer = null;
        if (!disposed && resync === resyncs) pullAfterResync(resync, attempt + 1);
      }, delay);
    });
  };
  const offResync = onHostResync(() => {
    if (disposed) return;
    if (resyncTimer !== null) clearTimeout(resyncTimer);
    resyncTimer = null;
    pullAfterResync(++resyncs, 0);
  });
  pullWithRetry();
  return () => {
    disposed = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (resyncTimer !== null) clearTimeout(resyncTimer);
    unsubscribe();
    offResync();
  };
}

/**
 * The revision to name when writing. Take it when the write starts, before the
 * review point it will store is captured: a mark or clear any view makes after
 * that then wins over this write instead of being undone by it.
 */
export function getReviewMarksRevision(): number {
  return useReviewMarksStore.getState().revision;
}

/** Store `point` as the worktree's mark. `basedOn` comes from {@link getReviewMarksRevision}. */
export async function markWorktreeReviewed(
  worktreeId: string,
  point: ReviewPoint,
  basedOn: number
): Promise<ReviewMarkSaveOutcome> {
  const api = reviewMarksBridge();
  if (typeof api?.mark !== "function") throw new Error("Review marks aren't available here");
  const adoptionsAtStart = adoptions;
  const outcome = await api.mark(worktreeId, point, basedOn);
  adoptReply(outcome.snapshot, basedOn, adoptionsAtStart);
  return outcome;
}

/**
 * Store a capture Review Hub took as the worktree's mark (#14585). `basedOn` is
 * the revision taken before that capture started.
 */
export async function markCapturedWorktreeReviewed(
  worktreeId: string,
  captureId: string,
  basedOn: number
): Promise<ReviewMarkSaveOutcome> {
  const api = reviewMarksBridge();
  if (typeof api?.markCaptured !== "function") {
    throw new Error("Review marks aren't available here");
  }
  const adoptionsAtStart = adoptions;
  const outcome = await api.markCaptured(worktreeId, captureId, basedOn);
  adoptReply(outcome.snapshot, basedOn, adoptionsAtStart);
  return outcome;
}

/** Whether this view can ask the host for captures at all. */
export function reviewMarkCapturesAvailable(): boolean {
  return typeof reviewMarksBridge()?.capture === "function";
}

/** Capture what the worktree holds now, held on the host. Null where the bridge isn't. */
export function captureForReviewMark(worktreeId: string): Promise<ReviewMarkCaptureOutcome> | null {
  const api = reviewMarksBridge();
  return typeof api?.capture === "function" ? api.capture(worktreeId) : null;
}

/** Compare the worktree with its stored mark on the host. */
export async function compareWithReviewMark(worktreeId: string): Promise<ReviewMarkCompareOutcome> {
  const api = reviewMarksBridge();
  if (typeof api?.compare !== "function") throw new Error("Review marks aren't available here");
  return api.compare(worktreeId);
}

/** Remove the worktree's mark. `basedOn` comes from {@link getReviewMarksRevision}. */
export async function clearWorktreeReviewMark(
  worktreeId: string,
  basedOn: number
): Promise<ReviewMarkClearOutcome> {
  const api = reviewMarksBridge();
  if (typeof api?.clear !== "function") throw new Error("Review marks aren't available here");
  const adoptionsAtStart = adoptions;
  const outcome = await api.clear(worktreeId, basedOn);
  adoptReply(outcome.snapshot, basedOn, adoptionsAtStart);
  return outcome;
}

export interface WorktreeReviewMark {
  mark: ReviewMarkSummary;
  /** Only `applicable` lets the mark stand for the worktree as it is now. */
  applicability: ReviewMarkApplicability;
}

/** A worktree's mark, said to apply only while the worktree is on the branch it was made on. */
export function worktreeReviewMark(
  marks: Record<string, ReviewMarkSummary>,
  worktree: ReviewMarkWorktreeHead & { id: string }
): WorktreeReviewMark | null {
  const mark = Object.hasOwn(marks, worktree.id) ? marks[worktree.id] : undefined;
  if (!mark) return null;
  return { mark, applicability: reviewMarkApplicability(mark.head, worktree) };
}

/**
 * Worktrees whose mark is new in `next`: saved since `prev`, by any view. The
 * first snapshot a view adopts names none, since it shows marks made before.
 */
export function newlyMarkedWorktreeIds(prev: ReviewMarksState, next: ReviewMarksState): string[] {
  if (!prev.loaded || prev.marks === next.marks) return [];
  return Object.entries(next.marks)
    .filter(
      ([id, mark]) => !Object.hasOwn(prev.marks, id) || prev.marks[id]?.revision !== mark.revision
    )
    .map(([id]) => id);
}

/** @internal Tests only. */
export function _resetReviewMarksStoreForTesting(): void {
  pull = null;
  adoptions = 0;
  useReviewMarksStore.setState({ marks: NO_MARKS, revision: 0, loaded: false });
}
