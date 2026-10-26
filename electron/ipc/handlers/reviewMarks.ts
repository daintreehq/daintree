import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import { broadcastToProjectRenderers } from "../utils.js";
import { REVIEW_MARKS_METHOD_CHANNELS } from "./reviewMarks.preload.js";
import { confirmGoneWorktrees, GONE_RECHECK_DELAY_MS, readLiveWorktrees } from "./liveWorktrees.js";
import { AppError } from "../../utils/errorTypes.js";
import { mayWriteProjectState } from "../../services/DriveLeaseService.js";
import { getReviewMarkStore, isReviewMarkWorktreeId } from "../../services/reviewMarks.js";
import { reviewPointCaptures } from "../../services/reviewPointCaptures.js";
import {
  readWorktreeIdentity,
  reviewPointMismatch,
} from "../../services/git/reviewPoint/readWorktreeIdentity.js";
import { captureReviewPoint } from "../../services/git/reviewPoint/captureReviewPoint.js";
import { reviewComparisons } from "../../services/git/reviewPoint/reviewComparisons.js";
import {
  ReviewPointSchema,
  type ReviewPoint,
  type ReviewPointBaseRequest,
} from "../../../shared/types/reviewPoint.js";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
import type {
  ReviewMarkCaptureOutcome,
  ReviewMarkClearOutcome,
  ReviewMarkCompareOutcome,
  ReviewMarkSaveOutcome,
  ReviewMarksSnapshot,
} from "../../../shared/types/ipc/reviewMarks.js";

/**
 * The SENDER project's review marks (#14584). No op takes a project id: main
 * resolves it from the sender's own view registration, so a view can only ever
 * read or change the marks of the project it shows. Not an action, so not on
 * the MCP surface.
 */

const IDENTITY_TIMEOUT_MS = 10_000;
/** Under what a Remote Host's link carries in one frame, with room for the envelope. */
const MAX_COMPARISON_REPLY_BYTES = 12 * 1024 * 1024;

function requireProjectId(ctx: IpcContext): string {
  if (!ctx.projectId) throw new Error("review marks: sender has no project");
  return ctx.projectId;
}

function requireWorktreeId(worktreeId: unknown): string {
  if (!isReviewMarkWorktreeId(worktreeId)) {
    throw new AppError({
      code: "VALIDATION",
      message: "review marks: worktreeId must be a worktree id",
    });
  }
  return worktreeId;
}

function requireCaptureId(captureId: unknown): string {
  if (typeof captureId !== "string" || captureId.length === 0 || captureId.length > 64) {
    throw new AppError({
      code: "VALIDATION",
      message: "review marks: captureId must name a capture",
    });
  }
  return captureId;
}

function requireRevision(basedOn: unknown): number {
  if (typeof basedOn !== "number" || !Number.isSafeInteger(basedOn) || basedOn < 0) {
    throw new AppError({
      code: "VALIDATION",
      message: "review marks: basedOn must be the marks revision the caller holds",
    });
  }
  return basedOn;
}

/**
 * Refuses a write once the caller no longer drives the project. The dispatcher
 * checked at the start of the call; a save can wait on git and the workspace
 * host long enough for the lease to move, so the write checks again.
 */
function driverGuard(ctx: IpcContext, projectId: string): () => void {
  return () => {
    if (mayWriteProjectState(projectId, () => ctx.endpoint)) return;
    throw new AppError({
      code: "DRIVEN_ELSEWHERE",
      message: `project ${projectId} is driven elsewhere; only its driver may change its review marks`,
      userMessage: "This project is being driven from another screen. The mark wasn't saved.",
      context: { projectId },
    });
  };
}

/** Every view of the project hears of a write; the writer also gets it as its reply. */
function announce(projectId: string, snapshot: ReviewMarksSnapshot): void {
  broadcastToProjectRenderers(projectId, CHANNELS.REVIEW_MARKS_CHANGED, snapshot);
}

/**
 * Drops the marks of worktrees the host confirms are gone: every marked one,
 * plus any a removal named. Coalesced per project, and run again when asked
 * while one is running, so a removal is never missed. Owned by the handlers'
 * registration: disposing it stops every prune before its next write.
 */
class ReviewMarkPruner {
  private readonly running = new Map<string, Promise<void>>();
  private readonly asked = new Map<string, Set<string>>();
  private readonly settling = new Set<Promise<void>>();
  private readonly abort = new AbortController();

  /**
   * A removal the host just reported. The prune waits out the workspace
   * client's reuse of a finished read first: one taken just before the
   * removal would still list the worktree and settle nothing.
   */
  removed(projectId: string, worktreeId: string): void {
    const { signal } = this.abort;
    if (signal.aborted) return;
    const waited = new Promise<void>((resolve) => {
      const timer = setTimeout(done, GONE_RECHECK_DELAY_MS);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    }).then(() => {
      this.settling.delete(waited);
      if (!signal.aborted) void this.schedule(projectId, [worktreeId]);
    });
    this.settling.add(waited);
  }

  schedule(projectId: string, removed: readonly string[] = []): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    const asked = this.asked.get(projectId) ?? new Set<string>();
    this.asked.set(projectId, asked);
    for (const id of removed) asked.add(id);
    const running = this.running.get(projectId);
    if (running) return running;
    const run = this.drain(projectId)
      .catch((error: unknown) => {
        if (this.abort.signal.aborted) return;
        console.error(`[reviewMarks] Failed to prune marks for project ${projectId}:`, error);
      })
      .finally(() => {
        this.running.delete(projectId);
        // Asked again after the last pass read what it was asked.
        if (this.asked.has(projectId)) void this.schedule(projectId);
      });
    this.running.set(projectId, run);
    return run;
  }

  private async drain(projectId: string): Promise<void> {
    const { signal } = this.abort;
    while (!signal.aborted) {
      const named = this.asked.get(projectId);
      if (!named) return;
      this.asked.delete(projectId);
      const store = getReviewMarkStore();
      // Read before asking the host, so a mark made meanwhile isn't the one removed.
      const expected = await store.entryRevisions(projectId, [...named]);
      const gone = await confirmGoneWorktrees(
        projectId,
        [...expected.keys()],
        "reviewMarks",
        signal
      );
      if (signal.aborted || gone.length === 0) continue;
      const result = await store.remove(
        projectId,
        new Map(gone.map((id) => [id, expected.get(id) ?? null])),
        () => signal.throwIfAborted()
      );
      if (result.changed) announce(projectId, result.snapshot);
      if (result.changedSince.length > 0) {
        // Changed while the host was asked: checked again on fresh reads.
        const again = this.asked.get(projectId) ?? new Set<string>();
        for (const id of result.changedSince) again.add(id);
        this.asked.set(projectId, again);
      }
    }
  }

  async settle(): Promise<void> {
    while (this.running.size > 0 || this.settling.size > 0) {
      await Promise.all([...this.settling, ...this.running.values()]);
    }
  }

  dispose(): void {
    this.abort.abort();
    this.asked.clear();
  }
}

let pruner: ReviewMarkPruner | null = null;

/**
 * The marks, then a prune in the background of any whose worktree went while
 * the project wasn't watched. `null` for a sender with no project binding yet:
 * a relaunch restores the last project before its view is registered, so the
 * view reads again rather than adopting an empty set.
 */
async function handleHydrate(ctx: IpcContext): Promise<ReviewMarksSnapshot | null> {
  if (!ctx.projectId) return null;
  const snapshot = await getReviewMarkStore().read(ctx.projectId);
  if (Object.keys(snapshot.marks).length > 0) void pruner?.schedule(ctx.projectId);
  return snapshot;
}

/**
 * Store the review point the caller acknowledged as the worktree's mark. The
 * point is checked, never captured again: it must be this worktree's, in this
 * repository, on the branch the worktree is on now. `basedOn` is the marks
 * revision the caller held when it started, so a mark or clear made since by
 * any view wins over this one.
 */
async function handleMark(
  ctx: IpcContext,
  worktreeId: string,
  point: ReviewPoint,
  basedOn: number
): Promise<ReviewMarkSaveOutcome> {
  const projectId = requireProjectId(ctx);
  const id = requireWorktreeId(worktreeId);
  const revision = requireRevision(basedOn);
  const parsed = ReviewPointSchema.safeParse(point);
  if (!parsed.success) {
    throw new AppError({ code: "VALIDATION", message: "review marks: not a review point" });
  }
  return saveMark(ctx, projectId, id, parsed.data, revision);
}

/**
 * Store a capture Review Hub took while reading the worktree as its mark
 * (#14585): the point behind the read the hub displayed, checked like any
 * other. `basedOn` is the revision the hub held before that capture started.
 */
async function handleMarkCaptured(
  ctx: IpcContext,
  worktreeId: string,
  captureId: string,
  basedOn: number
): Promise<ReviewMarkSaveOutcome> {
  const projectId = requireProjectId(ctx);
  const id = requireWorktreeId(worktreeId);
  const capture = requireCaptureId(captureId);
  const revision = requireRevision(basedOn);
  const point = reviewPointCaptures.get(projectId, id, capture);
  if (!point) return { status: "expired", snapshot: await getReviewMarkStore().read(projectId) };
  return saveMark(ctx, projectId, id, point, revision);
}

async function saveMark(
  ctx: IpcContext,
  projectId: string,
  id: string,
  point: ReviewPoint,
  revision: number
): Promise<ReviewMarkSaveOutcome> {
  const store = getReviewMarkStore();
  const release = store.beginSave(projectId, id);
  try {
    const live = await readLiveWorktrees(projectId, "reviewMarks");
    const worktree = live?.find((state) => state.id === id);
    if (!worktree) return { status: "unavailable", snapshot: await store.read(projectId) };
    let identity;
    try {
      identity = await readWorktreeIdentity(worktree.path, { timeoutMs: IDENTITY_TIMEOUT_MS });
    } catch (error) {
      console.warn(`[reviewMarks] Couldn't read worktree identity for ${projectId}:`, error);
      return { status: "unavailable", snapshot: await store.read(projectId) };
    }
    const mismatch = reviewPointMismatch(point, identity);
    if (mismatch) {
      return { status: "mismatch", reason: mismatch, snapshot: await store.read(projectId) };
    }
    const result = await store.save(projectId, id, point, revision, driverGuard(ctx, projectId));
    if (result.changed) announce(projectId, result.snapshot);
    return { status: result.status, snapshot: result.snapshot };
  } finally {
    release();
  }
}

async function handleClear(
  ctx: IpcContext,
  worktreeId: string,
  basedOn: number
): Promise<ReviewMarkClearOutcome> {
  const projectId = requireProjectId(ctx);
  const id = requireWorktreeId(worktreeId);
  const revision = requireRevision(basedOn);
  const result = await getReviewMarkStore().clear(
    projectId,
    id,
    revision,
    driverGuard(ctx, projectId)
  );
  if (result.changed) announce(projectId, result.snapshot);
  return { status: result.status, snapshot: result.snapshot };
}

/**
 * The branch a worktree's change set is read against: a linked PR's base or the
 * repository's main branch, as the host's divergence pass has it, else the main
 * worktree's branch (the main worktree has no base of its own).
 */
function baseRequestFor(
  worktree: WorktreeSnapshot,
  live: readonly WorktreeSnapshot[]
): ReviewPointBaseRequest | null {
  const branch =
    worktree.baseBranchName?.trim() ||
    live.find((state) => state.isMainWorktree)?.branch?.trim() ||
    worktree.branch?.trim();
  return branch ? { kind: "branch", branch } : null;
}

/**
 * Capture what the worktree holds now, for Review Hub's read of it (#14585).
 * The point stays on the host; the caller gets its id and summary.
 */
async function handleCapture(
  ctx: IpcContext,
  worktreeId: string
): Promise<ReviewMarkCaptureOutcome> {
  const projectId = requireProjectId(ctx);
  const id = requireWorktreeId(worktreeId);
  const live = await readLiveWorktrees(projectId, "reviewMarks");
  const worktree = live?.find((state) => state.id === id);
  const base = worktree && live ? baseRequestFor(worktree, live) : null;
  if (!worktree || !base) return { status: "unavailable" };
  const result = await captureReviewPoint(worktree.path, { base });
  if (result.kind === "changed-during-capture") return { status: "changed-during-capture" };
  if (result.kind === "failed") {
    return { status: "failed", reason: result.reason, message: result.message };
  }
  const { point } = result;
  return {
    status: "captured",
    capture: {
      captureId: reviewPointCaptures.hold(projectId, id, point),
      capturedAt: point.capturedAt,
      head: point.head,
      complete: point.incomplete === null,
      pathCount: point.entries.length,
    },
  };
}

/**
 * Compare the worktree as it is now against its stored mark. The point is read
 * here, beside the repository, and never sent to the caller.
 */
async function handleCompare(
  ctx: IpcContext,
  worktreeId: string
): Promise<ReviewMarkCompareOutcome> {
  const projectId = requireProjectId(ctx);
  const id = requireWorktreeId(worktreeId);
  const store = getReviewMarkStore();
  const summary = (await store.read(projectId)).marks[id];
  if (!summary) return { status: "none" };
  const stored = await store.get(projectId, id);
  if (!stored) {
    // Cleared since the read above, or its point file is missing or edited.
    if (!(await store.read(projectId)).marks[id]) return { status: "none" };
    return { status: "unavailable", markRevision: summary.revision };
  }
  const markRevision = stored.summary.revision;
  const live = await readLiveWorktrees(projectId, "reviewMarks");
  const worktree = live?.find((state) => state.id === id);
  if (!worktree) return { status: "unavailable", markRevision };
  const result = await reviewComparisons.compare(worktree.path, stored.point);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_COMPARISON_REPLY_BYTES) {
    return { status: "too-large", markRevision };
  }
  return { status: "compared", markRevision, result };
}

export const reviewMarksNamespace = defineIpcNamespace({
  name: "reviewMarks",
  ops: {
    hydrate: op(REVIEW_MARKS_METHOD_CHANNELS.hydrate, handleHydrate, { withContext: true }),
    mark: op(REVIEW_MARKS_METHOD_CHANNELS.mark, handleMark, { withContext: true }),
    markCaptured: op(REVIEW_MARKS_METHOD_CHANNELS.markCaptured, handleMarkCaptured, {
      withContext: true,
    }),
    clear: op(REVIEW_MARKS_METHOD_CHANNELS.clear, handleClear, { withContext: true }),
    capture: op(REVIEW_MARKS_METHOD_CHANNELS.capture, handleCapture, { withContext: true }),
    compare: op(REVIEW_MARKS_METHOD_CHANNELS.compare, handleCompare, { withContext: true }),
  },
});

interface WorktreeRemovedPayload {
  worktreeId?: unknown;
  projectId?: unknown;
}

/**
 * Every removal the workspace host sees, Daintree's own deletes and ones made
 * outside it, reaches main as `worktree-removed`. It isn't taken on trust: the
 * mark goes once the host confirms the worktree is gone.
 */
export function registerReviewMarksHandlers(
  deps: Pick<HandlerDependencies, "worktreeService">
): () => void {
  const dispose = reviewMarksNamespace.register();
  const own = new ReviewMarkPruner();
  pruner?.dispose();
  pruner = own;
  const client = deps.worktreeService;
  const onRemoved = (payload: WorktreeRemovedPayload): void => {
    const { worktreeId, projectId } = payload ?? {};
    if (typeof projectId !== "string" || !isReviewMarkWorktreeId(worktreeId)) return;
    own.removed(projectId, worktreeId);
  };
  const listens = typeof client?.on === "function" && typeof client.off === "function";
  if (listens) client.on("worktree-removed", onRemoved);
  return () => {
    if (listens) client.off("worktree-removed", onRemoved);
    own.dispose();
    if (pruner === own) pruner = null;
    dispose();
  };
}

/** @internal Tests only: settles once every scheduled prune has. */
export async function _settleReviewMarkPrunesForTesting(): Promise<void> {
  await pruner?.settle();
}
