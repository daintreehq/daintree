import type { WorktreeDiskUsageResult } from "../../shared/types/ipc/worktreeDiskUsage.js";
import { measureDirectorySize } from "./DirectoryDiskUsage.js";

/** Measurements running at once, across every view: each is a whole-tree scan. */
export const DISK_USAGE_CONCURRENCY = 2;

/** A measurement still running after this is abandoned and reported unknown. */
export const DISK_USAGE_TIMEOUT_MS = 120_000;

const UNKNOWN: WorktreeDiskUsageResult = { status: "unknown" };

export type DirectoryMeasurer = (
  root: string,
  options: { exclude: readonly string[]; signal: AbortSignal }
) => Promise<number | null>;

interface Job {
  root: string;
  exclude: readonly string[];
  signal: AbortSignal;
  resolve: (result: WorktreeDiskUsageResult) => void;
  detach: () => void;
}

interface Session {
  id: string;
  controller: AbortController;
}

/**
 * Sizes for the Worktrees overview, measured only while one asks: nothing here
 * runs on a timer or rides the status poll.
 *
 * Each requesting view (`owner`) has at most one session — the overview's
 * current opening. Starting another, or cancelling, aborts the old one: its
 * measurements answer unknown at once and a running `du` is killed. A
 * measurement keeps its slot until its scan has actually stopped, so repeated
 * open/close can't pile up abandoned scans.
 */
export class WorktreeDiskUsageService {
  private readonly sessions = new Map<string, Session>();
  private readonly queue: Job[] = [];
  private running = 0;
  private disposed = false;

  constructor(
    private readonly options: {
      measure?: DirectoryMeasurer;
      concurrency?: number;
      timeoutMs?: number;
    } = {}
  ) {}

  /**
   * The signal for `owner`'s session `sessionId`, opening it (and aborting
   * the owner's previous session) when it's new. Synchronous, so a cancel that
   * arrives while the caller is still resolving the worktree reaches it.
   */
  begin(owner: string, sessionId: string): AbortSignal {
    const current = this.sessions.get(owner);
    if (current?.id === sessionId) return current.controller.signal;
    current?.controller.abort();
    const controller = new AbortController();
    if (this.disposed) controller.abort();
    else this.sessions.set(owner, { id: sessionId, controller });
    return controller.signal;
  }

  /** Stops `owner`'s session — only `sessionId` when given, else whichever is open. */
  cancel(owner: string, sessionId?: string): void {
    const current = this.sessions.get(owner);
    if (!current || (sessionId !== undefined && current.id !== sessionId)) return;
    this.sessions.delete(owner);
    current.controller.abort();
  }

  measure(
    signal: AbortSignal,
    root: string,
    exclude: readonly string[]
  ): Promise<WorktreeDiskUsageResult> {
    if (this.disposed || signal.aborted) return Promise.resolve(UNKNOWN);
    return new Promise((resolve) => {
      const onAbort = () => {
        const index = this.queue.indexOf(job);
        if (index !== -1) this.queue.splice(index, 1);
        resolve(UNKNOWN);
      };
      const job: Job = {
        root,
        exclude,
        signal,
        resolve,
        detach: () => signal.removeEventListener("abort", onAbort),
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) session.controller.abort();
    this.sessions.clear();
  }

  private pump(): void {
    const limit = this.options.concurrency ?? DISK_USAGE_CONCURRENCY;
    while (this.running < limit && this.queue.length > 0) {
      const job = this.queue.shift()!;
      job.detach();
      this.start(job);
    }
  }

  /**
   * The request is answered unknown the moment its session stops or its
   * deadline passes — a walk stuck on a dead mount can't be interrupted, and
   * the overview mustn't wait on it — but the slot is freed only when the scan
   * itself settles.
   */
  private start(job: Job): void {
    this.running += 1;
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(),
      this.options.timeoutMs ?? DISK_USAGE_TIMEOUT_MS
    );
    const signal = AbortSignal.any([job.signal, deadline.signal]);
    let answered = false;
    const answer = (result: WorktreeDiskUsageResult) => {
      if (answered) return;
      answered = true;
      job.resolve(result);
    };
    const onStop = () => answer(UNKNOWN);
    signal.addEventListener("abort", onStop, { once: true });
    const measure = this.options.measure ?? measureDirectorySize;
    Promise.resolve()
      .then(() => measure(job.root, { exclude: job.exclude, signal }))
      .then(
        (bytes): WorktreeDiskUsageResult =>
          bytes === null || signal.aborted ? UNKNOWN : { status: "measured", bytes },
        () => UNKNOWN
      )
      .then((result) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onStop);
        this.running -= 1;
        answer(result);
        this.pump();
      });
  }
}

let instance: WorktreeDiskUsageService | null = null;

export function getWorktreeDiskUsageService(): WorktreeDiskUsageService {
  instance ??= new WorktreeDiskUsageService();
  return instance;
}

export function disposeWorktreeDiskUsageService(): void {
  instance?.dispose();
  instance = null;
}
