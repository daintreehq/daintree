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
 * judged again, alone, once the project's workspace host is ready to remove
 * it, so a host started for the removal can't carry a stale verdict. The host
 * then re-reads the checkout right before git runs and refuses on any
 * difference. The removal never forces and never deletes the branch, so
 * `git worktree add` on the surviving branch brings the checkout back.
 *
 * One sweep at a time, one removal at a time. Turning the switch off takes
 * effect before the next removal, including one a running sweep was about to
 * make. Each removal is recorded as pending before git is asked and kept
 * until a window on screen puts it in the notification inbox; a removal whose
 * answer was lost stays pending and each later sweep settles it from the
 * disk. Removals stop, rather than drop a record, while the receipts nobody
 * has taken are full.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ProjectSettings } from "../../../shared/types/project.js";
import type {
  MergedWorktreeCandidate,
  MergedWorktreeCleanupPreview,
  MergedWorktreeRemovalReceipt,
} from "../../../shared/types/mergedWorktreeCleanup.js";
import type {
  UnattendedRemovalGuard,
  UnattendedRemovalOutcome,
} from "../../../shared/types/workspace-host.js";
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
/** Receipts no window has taken; at this many, removals wait until some are taken. */
export const MERGED_WORKTREE_RECEIPT_CAP = 200;
/**
 * How long a view holds the receipts it took before another view may take
 * them: a view files them and answers within moments.
 */
export const MERGED_WORKTREE_RECEIPT_LEASE_MS = 60_000;
/** The host refuses to start git for a request older than this. */
export const MERGED_WORKTREE_REMOVAL_DEADLINE_MS = 10 * 60 * 1000;
/**
 * A pending receipt whose checkout is still there this long after it was
 * written didn't go through: well past the deadline for git to start, so a
 * removal still under way would have finished.
 */
export const MERGED_WORKTREE_PENDING_SETTLE_MS = 60 * 60 * 1000;
const DISPOSE_WAIT_MS = 5_000;

export interface MergedWorktreeProject {
  id: string;
  path: string;
  name: string;
}

type Removable = Extract<MergedWorktreeCandidate, { status: "removable" }>;

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
  /**
   * Remove through the project's own workspace host, starting it if no window
   * has. `confirm` runs once the host is ready, right before the request goes:
   * false sends nothing.
   */
  removeWorktree(
    project: MergedWorktreeProject,
    worktreeId: string,
    guard: UnattendedRemovalGuard,
    confirm: () => Promise<boolean>
  ): Promise<UnattendedRemovalOutcome>;
  pathExists(target: string): Promise<boolean>;
  loadReceipts(): MergedWorktreeRemovalReceipt[];
  saveReceipts(receipts: MergedWorktreeRemovalReceipt[]): void;
  /** Tell the windows there are receipts to take. */
  announceReceipts(): void;
  /** Whether the view behind this web contents id can still answer. */
  isLiveView(webContentsId: number): boolean;
  now?: () => number;
  logInfo?: (message: string, context?: Record<string, unknown>) => void;
  logWarn?: (message: string, context?: Record<string, unknown>) => void;
}

export class MergedWorktreeCleanupService {
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private soonTimer: ReturnType<typeof setTimeout> | null = null;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private sweeping: Promise<void> | null = null;
  private disposed = false;
  private readonly abort = new AbortController();
  /** Bumped when a project's switch goes off, so a sweep under way stops for it. */
  private readonly generations = new Map<string, number>();
  private readonly leases = new Map<string, { holder: number; at: number }>();
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
   * finish and record its receipt; quitting doesn't wait out a large checkout,
   * and a pending receipt left behind is settled on the next start.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    for (const timer of [this.startupTimer, this.soonTimer, this.leaseTimer]) {
      if (timer) clearTimeout(timer);
    }
    if (this.interval) clearInterval(this.interval);
    this.startupTimer = this.soonTimer = this.leaseTimer = this.interval = null;
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
    const judged = await evaluateMergedWorktrees(
      listed,
      this.deps.readsFor(project, this.abort.signal, "preview")
    );
    // What the sweep does with them: wait for the last attempt to settle.
    const worktrees = judged.map((candidate): MergedWorktreeCandidate => {
      if (candidate.status !== "removable" || !this.hasUnresolvedRemoval(project, candidate)) {
        return candidate;
      }
      return {
        worktreePath: candidate.worktreePath,
        branch: candidate.branch,
        status: "skipped",
        reason: "removal-pending",
        pr: candidate.pr,
      };
    });
    return { enabled, checkedAt, worktrees };
  }

  /**
   * The settled receipts no other live view holds, oldest first, for a view
   * on screen. They are held for `holder` until it acks or the lease lapses,
   * so two windows don't both file one the person has since cleared. One held
   * by a view that then never files it (parked, say) is announced again when
   * its hold lapses, so the view on screen asks for it.
   */
  takeReceipts(holder: number): MergedWorktreeRemovalReceipt[] {
    const at = this.now();
    const settled = this.deps.loadReceipts().filter((receipt) => !receipt.pending);
    const ids = new Set(settled.map((receipt) => receipt.id));
    for (const id of this.leases.keys()) if (!ids.has(id)) this.leases.delete(id);
    let heldElsewhereFor: number | null = null;
    const taken = settled.filter((receipt) => {
      const lease = this.leases.get(receipt.id);
      if (!lease || lease.holder === holder || !this.deps.isLiveView(lease.holder)) return true;
      const left = lease.at + MERGED_WORKTREE_RECEIPT_LEASE_MS - at;
      if (left <= 0) return true;
      heldElsewhereFor = heldElsewhereFor === null ? left : Math.min(heldElsewhereFor, left);
      return false;
    });
    for (const receipt of taken) this.leases.set(receipt.id, { holder, at });
    if (heldElsewhereFor !== null) this.announceAfter(heldElsewhereFor);
    return taken;
  }

  ackReceipts(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const filed = new Set(ids);
    for (const id of ids) this.leases.delete(id);
    const receipts = this.deps.loadReceipts();
    const left = receipts.filter((receipt) => receipt.pending || !filed.has(receipt.id));
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

  private hasUnresolvedRemoval(
    project: MergedWorktreeProject,
    candidate: MergedWorktreeCandidate
  ): boolean {
    return this.deps
      .loadReceipts()
      .some(
        (entry) =>
          entry.pending &&
          entry.projectId === project.id &&
          entry.worktreePath === candidate.worktreePath
      );
  }

  private announceAfter(delayMs: number): void {
    if (this.disposed || this.leaseTimer) return;
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = null;
      this.deps.announceReceipts();
    }, delayMs);
    this.leaseTimer.unref?.();
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
    await this.reconcilePending();
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

  /**
   * Pending receipts whose removal never answered (a lost reply, a quit, a
   * settle that failed to save): the removal went through once the checkout
   * is gone, and didn't if it is still there well past the host's removal
   * timeout. One still in that window, or whose folder can't be read, waits
   * for the next sweep.
   */
  private async reconcilePending(): Promise<void> {
    const pending = this.deps.loadReceipts().filter((receipt) => receipt.pending);
    if (pending.length === 0) return;
    const decided = new Map<string, "settle" | "drop">();
    for (const receipt of pending) {
      const expired = this.now() - receipt.removedAt >= MERGED_WORKTREE_PENDING_SETTLE_MS;
      let exists: boolean;
      try {
        exists = await this.deps.pathExists(receipt.worktreePath);
      } catch {
        // Unreadable: wait, but not past the point any attempt could still run.
        if (expired) decided.set(receipt.id, "drop");
        continue;
      }
      if (!exists) decided.set(receipt.id, "settle");
      else if (expired) decided.set(receipt.id, "drop");
    }
    if (decided.size === 0) return;
    let settled = 0;
    const next: MergedWorktreeRemovalReceipt[] = [];
    for (const receipt of this.deps.loadReceipts()) {
      const decision = receipt.pending ? decided.get(receipt.id) : undefined;
      if (decision === undefined) next.push(receipt);
      else if (decision === "settle") {
        next.push(settle(receipt));
        settled++;
      }
    }
    this.deps.saveReceipts(next);
    if (settled > 0) this.deps.announceReceipts();
  }

  private async sweepProject(project: MergedWorktreeProject, generation: number): Promise<void> {
    const listed = await this.deps.listWorktrees(project.path);
    const found = await evaluateMergedWorktrees(
      listed,
      this.deps.readsFor(project, this.abort.signal, "sweep")
    );
    for (const candidate of found) {
      if (candidate.status !== "removable") continue;
      // One whose last removal never answered waits until that one is settled,
      // or a retry would file a second receipt for one removal.
      if (this.hasUnresolvedRemoval(project, candidate)) continue;
      const worktree = listed.find((entry) => path.resolve(entry.path) === candidate.worktreePath);
      if (!worktree) continue;
      if (this.deps.loadReceipts().length >= MERGED_WORKTREE_RECEIPT_CAP) {
        this.logWarn(
          "[MergedWorktreeCleanup] Receipts are full; removals wait until a window takes them"
        );
        return;
      }
      if (!(await this.isStillEnabled(project.id, generation))) return;
      await this.remove(project, candidate, worktree, generation);
    }
  }

  private async remove(
    project: MergedWorktreeProject,
    candidate: Removable,
    worktree: ListedWorktree,
    generation: number
  ): Promise<void> {
    const receipt: MergedWorktreeRemovalReceipt = {
      id: randomUUID(),
      pending: true,
      projectId: project.id,
      projectName: project.name,
      worktreePath: candidate.worktreePath,
      branch: candidate.branch,
      prNumber: candidate.pr.number,
      prUrl: candidate.pr.url,
      removedAt: this.now(),
    };
    try {
      this.deps.saveReceipts([...this.deps.loadReceipts(), receipt]);
    } catch (error) {
      this.logWarn("[MergedWorktreeCleanup] Couldn't record a removal before making it", {
        projectId: project.id,
        error: formatErrorMessage(error, "unknown"),
      });
      return;
    }

    // Judged again, alone and fresh, once the host is ready: a host started
    // for this removal may have taken a while, and the first pass is minutes
    // old by the last worktree.
    const confirm = async () => {
      if (!(await this.isStillEnabled(project.id, generation))) return false;
      const [current] = await evaluateMergedWorktrees(
        [worktree],
        this.deps.readsFor(project, this.abort.signal, "sweep")
      );
      return (
        current?.status === "removable" &&
        current.head === candidate.head &&
        (await this.isStillEnabled(project.id, generation))
      );
    };

    const result = await this.deps
      .removeWorktree(
        project,
        candidate.worktreePath,
        {
          expectedBranch: candidate.branch,
          expectedHead: candidate.head,
          notAfter: this.now() + MERGED_WORKTREE_REMOVAL_DEADLINE_MS,
        },
        confirm
      )
      .catch((error: unknown): UnattendedRemovalOutcome => ({
        outcome: "lost",
        error: formatErrorMessage(error, "unknown"),
      }));
    if ("error" in result) {
      this.logWarn(`[MergedWorktreeCleanup] Worktree removal ${result.outcome}`, {
        projectId: project.id,
        error: result.error,
      });
    }
    // A lost answer may still be a removal in progress: its receipt stays
    // pending, and later sweeps settle it from the disk.
    if (result.outcome === "lost") return;
    const removed = result.outcome === "removed";

    try {
      const others = this.deps.loadReceipts().filter((entry) => entry.id !== receipt.id);
      this.deps.saveReceipts(
        removed ? [...others, settle({ ...receipt, removedAt: this.now() })] : others
      );
    } catch (error) {
      this.logWarn("[MergedWorktreeCleanup] Couldn't settle a removal receipt", {
        projectId: project.id,
        error: formatErrorMessage(error, "unknown"),
      });
    }
    if (!removed) return;
    this.logInfo("[MergedWorktreeCleanup] Removed a merged worktree", {
      projectId: project.id,
      prNumber: candidate.pr.number,
    });
    this.deps.announceReceipts();
  }
}

function settle(receipt: MergedWorktreeRemovalReceipt): MergedWorktreeRemovalReceipt {
  const { pending: _pending, ...settled } = receipt;
  return settled;
}
