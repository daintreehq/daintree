import {
  isBulkWorktreeRunLive,
  type BulkWorktreeRunCommand,
  type BulkWorktreeRunCommandResult,
  type BulkWorktreeRunItem,
  type BulkWorktreeRunSnapshot,
} from "../../shared/types/ipc/bulkWorktreeRuns.js";

/**
 * Main's record of bulk worktree creation runs (#17085). Each run executes in
 * the project view that started it, which publishes every change here; this
 * keeps the latest snapshot, pushes the set to every view, and routes cancel
 * and retry from any view back to the one running it.
 *
 * While a run is live its view is held: freezing would stall it mid-batch and
 * eviction would end it, so both leave a held view alone, the way they leave a
 * dictation's alone. The hold lifts when the run ends, when its view goes, or
 * after {@link BULK_RUN_HOLD_TTL_MS} without a publish, so a view that stops
 * reporting can't stay pinned.
 *
 * Dependency-free apart from shared types, so the eviction controller can read
 * the hold synchronously.
 */

/**
 * How long a live run's hold lasts without a publish. A live run republishes
 * at least every `BULK_RUN_HEARTBEAT_MS`, however long a step takes.
 */
export const BULK_RUN_HOLD_TTL_MS = 10 * 60_000;

/** Ended runs kept until dismissed. Past this the oldest go first; live runs are never dropped. */
export const MAX_ENDED_BULK_RUNS = 20;

const holds = new Map<number, Set<string>>();
const releaseListeners = new Set<(webContentsId: number) => void>();

function hold(webContentsId: number, runId: string): void {
  let runs = holds.get(webContentsId);
  if (!runs) {
    runs = new Set();
    holds.set(webContentsId, runs);
  }
  runs.add(runId);
}

function release(webContentsId: number, runId: string): void {
  const runs = holds.get(webContentsId);
  if (!runs?.delete(runId) || runs.size > 0) return;
  holds.delete(webContentsId);
  for (const listener of [...releaseListeners]) {
    try {
      listener(webContentsId);
    } catch {
      // One listener failing must not keep the others from reclaiming.
    }
  }
}

/** Whether a live bulk run executes in this view. A destroyed one runs nothing. */
export function isBulkWorktreeRunViewHeld(wc: Electron.WebContents): boolean {
  if (wc.isDestroyed()) return false;
  return holds.has(wc.id);
}

/**
 * Called with a view's `webContents.id` once its last live run releases it, so
 * a freeze or eviction the hold put off can go ahead. Returns the unsubscribe.
 */
export function onBulkWorktreeRunViewReleased(
  listener: (webContentsId: number) => void
): () => void {
  releaseListeners.add(listener);
  return () => {
    releaseListeners.delete(listener);
  };
}

interface RunRecord {
  snapshot: BulkWorktreeRunSnapshot;
  ownerId: number;
  holdTimer: ReturnType<typeof setTimeout> | null;
}

export interface BulkWorktreeRunRegistryDeps {
  /** Push every run to every view. */
  broadcast: (runs: BulkWorktreeRunSnapshot[]) => void;
  /** Deliver a command to the view running the run; false when that view is gone. */
  sendCommand: (ownerId: number, command: BulkWorktreeRunCommand) => boolean;
  holdTtlMs?: number;
}

function settleInterrupted(item: BulkWorktreeRunItem): BulkWorktreeRunItem {
  switch (item.stage) {
    case "succeeded":
    case "failed":
    case "cancelled":
    case "interrupted":
      return item;
    default:
      return {
        ...item,
        stage: "interrupted",
        error: item.worktreeId
          ? "Its worktree was created, but the project view closed before setup finished"
          : item.stage === "worktree-creating"
            ? "The project view closed while its worktree was being created"
            : "The project view closed before it started",
      };
  }
}

export class BulkWorktreeRunRegistry {
  private readonly runs = new Map<string, RunRecord>();
  private readonly holdTtlMs: number;

  constructor(private readonly deps: BulkWorktreeRunRegistryDeps) {
    this.holdTtlMs = deps.holdTtlMs ?? BULK_RUN_HOLD_TTL_MS;
  }

  list(): BulkWorktreeRunSnapshot[] {
    return [...this.runs.values()].map((record) => record.snapshot);
  }

  /**
   * Take a snapshot from the view running the run. A run belongs to the view
   * that first published it: another view's publish for it is ignored, and so
   * is one for a run whose view has already gone.
   */
  publish(ownerId: number, projectId: string, snapshot: BulkWorktreeRunSnapshot): boolean {
    const existing = this.runs.get(snapshot.runId);
    if (existing && (existing.ownerId !== ownerId || !existing.snapshot.controllable)) {
      return false;
    }
    const record: RunRecord = existing ?? { snapshot, ownerId, holdTimer: null };
    record.snapshot = { ...snapshot, projectId, controllable: true };
    if (!existing) this.runs.set(snapshot.runId, record);
    if (isBulkWorktreeRunLive(record.snapshot.phase)) {
      hold(ownerId, snapshot.runId);
      this.armHoldTimer(record);
    } else {
      this.releaseHold(record);
      this.pruneEnded();
    }
    this.broadcast();
    return true;
  }

  command(command: BulkWorktreeRunCommand): BulkWorktreeRunCommandResult {
    const record = this.runs.get(command.runId);
    if (!record) return { accepted: false, reason: "not-found" };
    const { snapshot } = record;
    if (!snapshot.controllable) return { accepted: false, reason: "uncontrollable" };
    if (command.kind === "cancel") {
      if (!isBulkWorktreeRunLive(snapshot.phase)) return { accepted: false, reason: "not-live" };
    } else {
      if (isBulkWorktreeRunLive(snapshot.phase)) return { accepted: false, reason: "busy" };
      if (!snapshot.items.some((item) => item.stage === "failed")) {
        return { accepted: false, reason: "nothing-to-retry" };
      }
    }
    // A retry wakes a view that may be frozen or next in line for eviction, so
    // it is held before the command goes, not once the run reports back. A view
    // that turns the retry down republishes the run as it was, which releases
    // the hold; one that never answers lets it lapse.
    if (command.kind === "retry-failed") {
      hold(record.ownerId, record.snapshot.runId);
      this.armHoldTimer(record);
    }
    if (!this.deps.sendCommand(record.ownerId, command)) {
      this.ownerGone(record.ownerId);
      return { accepted: false, reason: "uncontrollable" };
    }
    return { accepted: true };
  }

  /** Forget an ended run. A live one stays: dismissing must not hide work still happening. */
  dismiss(runId: string): boolean {
    const record = this.runs.get(runId);
    if (!record) return false;
    if (record.snapshot.controllable && isBulkWorktreeRunLive(record.snapshot.phase)) return false;
    // A retry on its way: the run is about to be live again.
    if (record.holdTimer !== null) return false;
    this.releaseHold(record);
    this.runs.delete(runId);
    this.broadcast();
    return true;
  }

  /**
   * The view with this id is gone, reloaded or crashed, and every run it held
   * with it. What each item reached stays: a worktree already created is still
   * reported as created. Anything unfinished is marked interrupted, and none of
   * its runs can be cancelled or retried any more.
   */
  ownerGone(ownerId: number): void {
    let changed = false;
    for (const record of this.runs.values()) {
      if (record.ownerId !== ownerId || !record.snapshot.controllable) continue;
      const { snapshot } = record;
      const live = isBulkWorktreeRunLive(snapshot.phase);
      record.snapshot = {
        ...snapshot,
        phase: live ? (snapshot.phase === "cancelling" ? "cancelled" : "done") : snapshot.phase,
        items: live ? snapshot.items.map(settleInterrupted) : snapshot.items,
        updatedAt: Date.now(),
        controllable: false,
      };
      this.releaseHold(record);
      changed = true;
    }
    if (changed) {
      this.pruneEnded();
      this.broadcast();
    }
  }

  dispose(): void {
    for (const record of this.runs.values()) this.releaseHold(record);
    this.runs.clear();
  }

  private armHoldTimer(record: RunRecord): void {
    if (record.holdTimer) clearTimeout(record.holdTimer);
    record.holdTimer = setTimeout(() => {
      record.holdTimer = null;
      release(record.ownerId, record.snapshot.runId);
    }, this.holdTtlMs);
    record.holdTimer.unref?.();
  }

  private releaseHold(record: RunRecord): void {
    if (record.holdTimer) clearTimeout(record.holdTimer);
    record.holdTimer = null;
    release(record.ownerId, record.snapshot.runId);
  }

  private pruneEnded(): void {
    // A record still holding its view is live or has a retry on its way.
    const ended = [...this.runs.values()].filter(
      (record) =>
        record.holdTimer === null &&
        (!record.snapshot.controllable || !isBulkWorktreeRunLive(record.snapshot.phase))
    );
    for (const record of ended.slice(0, Math.max(0, ended.length - MAX_ENDED_BULK_RUNS))) {
      this.releaseHold(record);
      this.runs.delete(record.snapshot.runId);
    }
  }

  private broadcast(): void {
    this.deps.broadcast(this.list());
  }
}

/** Test-only: forget every hold. A release from before the reset then drops nothing. */
export function _resetBulkWorktreeRunHoldsForTests(): void {
  holds.clear();
}
