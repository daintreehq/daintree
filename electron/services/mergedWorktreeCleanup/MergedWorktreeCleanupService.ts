/**
 * The merged-worktree rule (#17321): for each project that opted in, remove
 * the worktrees Daintree created once their PR has merged and they hold
 * nothing to lose.
 *
 * Runs in main, on the machine that owns the project, whether or not any
 * window shows it: a project no window holds has no workspace host polling
 * its PRs, so the rule never reads the poller's state. Each worktree is judged
 * by {@link evaluateMergedWorktrees} from fresh reads (git, the PTY census, the
 * saved layout, the forge with its caches bypassed), and one that passes is
 * removed at once through the project's own workspace host, which re-reads
 * the checkout right before git runs and refuses on any difference. The
 * removal never forces and never deletes the branch, so `git worktree add` on
 * the surviving branch brings the checkout back.
 *
 * One sweep at a time, one removal at a time. Turning the switch off takes
 * effect before the next removal, including one a running sweep was about to
 * make. Each removal leaves a receipt that waits here until a window puts it
 * in the notification inbox.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ProjectSettings } from "../../../shared/types/project.js";
import type {
  MergedWorktreeCandidate,
  MergedWorktreeCleanupPreview,
  MergedWorktreeRemovalReceipt,
} from "../../../shared/types/mergedWorktreeCleanup.js";
import type { UnattendedRemovalGuard } from "../../../shared/types/workspace-host.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  evaluateMergedWorktrees,
  type ListedWorktree,
  type MergedWorktreeReads,
} from "./evaluateMergedWorktrees.js";

export const MERGED_WORKTREE_SWEEP_STARTUP_DELAY_MS = 2 * 60 * 1000;
export const MERGED_WORKTREE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** After the switch goes on, so the first removals don't wait for the hourly tick. */
export const MERGED_WORKTREE_SWEEP_AFTER_ENABLE_MS = 60 * 1000;
const DISPOSE_WAIT_MS = 5_000;
/** Receipts no window has taken are kept up to this many, oldest dropped first. */
export const MERGED_WORKTREE_RECEIPT_CAP = 200;

export interface MergedWorktreeProject {
  id: string;
  path: string;
  name: string;
}

export interface MergedWorktreeCleanupDeps {
  listProjects(): MergedWorktreeProject[];
  readSettings(projectId: string): Promise<ProjectSettings>;
  writeEnabled(projectId: string, enabled: boolean): Promise<void>;
  listWorktrees(projectPath: string): Promise<ListedWorktree[]>;
  /**
   * The reads for one project, bound to it. A `sweep` read goes past the
   * forge's caches; a `preview` may use them. Each call starts fresh.
   */
  readsFor(
    project: MergedWorktreeProject,
    signal: AbortSignal,
    purpose: "sweep" | "preview"
  ): MergedWorktreeReads;
  removeWorktree(
    project: MergedWorktreeProject,
    worktreeId: string,
    guard: UnattendedRemovalGuard
  ): Promise<void>;
  loadReceipts(): MergedWorktreeRemovalReceipt[];
  saveReceipts(receipts: MergedWorktreeRemovalReceipt[]): void;
  /** Tell the windows there are receipts to take. */
  announceReceipts(): void;
  now?: () => number;
  logInfo?: (message: string, context?: Record<string, unknown>) => void;
  logWarn?: (message: string, context?: Record<string, unknown>) => void;
}

export class MergedWorktreeCleanupService {
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private soonTimer: ReturnType<typeof setTimeout> | null = null;
  private sweeping: Promise<void> | null = null;
  private disposed = false;
  private readonly abort = new AbortController();
  /** Bumped when a project's switch goes off, so a sweep under way stops for it. */
  private readonly generations = new Map<string, number>();
  private readonly now: () => number;
  private readonly logInfo: NonNullable<MergedWorktreeCleanupDeps["logInfo"]>;
  private readonly logWarn: NonNullable<MergedWorktreeCleanupDeps["logWarn"]>;

  constructor(private readonly deps: MergedWorktreeCleanupDeps) {
    this.now = deps.now ?? Date.now;
    this.logInfo = deps.logInfo ?? ((message, context) => console.log(message, context ?? ""));
    this.logWarn = deps.logWarn ?? ((message, context) => console.warn(message, context ?? ""));
  }

  /** Idempotent. The first sweep waits out startup; then one an hour. */
  start(): void {
    if (this.disposed || this.startupTimer || this.interval) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.sweep();
    }, MERGED_WORKTREE_SWEEP_STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
    this.interval = setInterval(() => void this.sweep(), MERGED_WORKTREE_SWEEP_INTERVAL_MS);
    this.interval.unref?.();
  }

  /**
   * Stops every timer and the reads under way, and no removal starts after it.
   * A removal git is already running gets up to {@link DISPOSE_WAIT_MS} to
   * finish and record its receipt; quitting doesn't wait out a large checkout.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    for (const timer of [this.startupTimer, this.soonTimer]) if (timer) clearTimeout(timer);
    if (this.interval) clearInterval(this.interval);
    this.startupTimer = this.soonTimer = this.interval = null;
    const sweeping = this.sweeping;
    if (!sweeping) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      sweeping.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DISPOSE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  async setEnabled(projectId: string, enabled: boolean): Promise<void> {
    // Before the write: a sweep reading the old value mid-write still stops.
    if (!enabled) this.bumpGeneration(projectId);
    await this.deps.writeEnabled(projectId, enabled);
    if (enabled) this.sweepSoon();
  }

  /** What a sweep would do in the project now, whether or not the switch is on. */
  async preview(projectId: string): Promise<MergedWorktreeCleanupPreview> {
    const project = this.deps.listProjects().find((entry) => entry.id === projectId);
    if (!project) throw new Error("Project not found");
    const settings = await this.deps.readSettings(projectId);
    const enabled = settings.removeMergedWorktrees === true;
    const checkedAt = this.now();
    let listed: ListedWorktree[];
    try {
      listed = await this.deps.listWorktrees(project.path);
    } catch (error) {
      return {
        enabled,
        checkedAt,
        worktrees: [],
        error: formatErrorMessage(error, "Couldn't list the project's worktrees"),
      };
    }
    const worktrees = await evaluateMergedWorktrees(
      listed,
      this.deps.readsFor(project, this.abort.signal, "preview")
    );
    return { enabled, checkedAt, worktrees };
  }

  /** Receipts no window has put in its inbox yet, oldest first. */
  takeReceipts(): MergedWorktreeRemovalReceipt[] {
    return this.deps.loadReceipts();
  }

  ackReceipts(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const filed = new Set(ids);
    const receipts = this.deps.loadReceipts();
    const left = receipts.filter((receipt) => !filed.has(receipt.id));
    if (left.length !== receipts.length) this.deps.saveReceipts(left);
  }

  /** One pass over every opted-in project. A pass already running is joined, not repeated. */
  sweep(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.sweeping ??= this.runSweep().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private sweepSoon(): void {
    if (this.disposed || this.soonTimer) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.sweep();
    }, MERGED_WORKTREE_SWEEP_AFTER_ENABLE_MS);
    this.soonTimer.unref?.();
  }

  private bumpGeneration(projectId: string): void {
    this.generations.set(projectId, (this.generations.get(projectId) ?? 0) + 1);
  }

  private async isStillEnabled(projectId: string, generation: number): Promise<boolean> {
    if (this.disposed || (this.generations.get(projectId) ?? 0) !== generation) return false;
    const settings = await this.deps.readSettings(projectId);
    return (
      settings.removeMergedWorktrees === true &&
      !this.disposed &&
      (this.generations.get(projectId) ?? 0) === generation
    );
  }

  private async runSweep(): Promise<void> {
    for (const project of this.deps.listProjects()) {
      if (this.disposed) return;
      const generation = this.generations.get(project.id) ?? 0;
      try {
        if (!(await this.isStillEnabled(project.id, generation))) continue;
        await this.sweepProject(project, generation);
      } catch (error) {
        this.logWarn("[MergedWorktreeCleanup] Sweep of a project failed", {
          projectId: project.id,
          error: formatErrorMessage(error, "unknown"),
        });
      }
    }
  }

  private async sweepProject(project: MergedWorktreeProject, generation: number): Promise<void> {
    const listed = await this.deps.listWorktrees(project.path);
    const found = await evaluateMergedWorktrees(
      listed,
      this.deps.readsFor(project, this.abort.signal, "sweep")
    );
    for (const candidate of found) {
      if (candidate.status !== "removable") continue;
      // Judged again, alone and fresh, right before it goes: the first pass
      // read every worktree, and the forge read may now be minutes old.
      const worktree = listed.find((entry) => path.resolve(entry.path) === candidate.worktreePath);
      if (!worktree) continue;
      const [current] = await evaluateMergedWorktrees(
        [worktree],
        this.deps.readsFor(project, this.abort.signal, "sweep")
      );
      if (current?.status !== "removable") continue;
      if (!(await this.isStillEnabled(project.id, generation))) return;
      await this.remove(project, current);
    }
  }

  private async remove(
    project: MergedWorktreeProject,
    candidate: Extract<MergedWorktreeCandidate, { status: "removable" }>
  ): Promise<void> {
    try {
      await this.deps.removeWorktree(project, candidate.worktreePath, {
        expectedBranch: candidate.branch,
        expectedHead: candidate.head,
      });
    } catch (error) {
      this.logWarn("[MergedWorktreeCleanup] Worktree removal refused", {
        projectId: project.id,
        error: formatErrorMessage(error, "unknown"),
      });
      return;
    }
    this.logInfo("[MergedWorktreeCleanup] Removed a merged worktree", {
      projectId: project.id,
      prNumber: candidate.pr.number,
    });
    const receipt: MergedWorktreeRemovalReceipt = {
      id: randomUUID(),
      projectId: project.id,
      projectName: project.name,
      worktreePath: candidate.worktreePath,
      branch: candidate.branch,
      prNumber: candidate.pr.number,
      prUrl: candidate.pr.url,
      removedAt: this.now(),
    };
    try {
      const receipts = [...this.deps.loadReceipts(), receipt].slice(-MERGED_WORKTREE_RECEIPT_CAP);
      this.deps.saveReceipts(receipts);
    } catch (error) {
      this.logWarn("[MergedWorktreeCleanup] Couldn't record a removal receipt", {
        projectId: project.id,
        error: formatErrorMessage(error, "unknown"),
      });
    }
    this.deps.announceReceipts();
  }
}
