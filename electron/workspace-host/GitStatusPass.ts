import { readFile, access } from "fs/promises";
import { join as pathJoin } from "path";
import { createHardenedGit, createWslHardenedGit } from "../utils/hardenedGit.js";
import type { WslGitInvocation } from "../utils/hardenedGit.js";
import { invalidateGitStatusCache, getWorktreeChangesWithStats } from "../utils/git.js";
import { getGitDir } from "../utils/gitUtils.js";
import { getRepoOperationStateSync } from "../utils/gitRepoOperationState.js";
import { WorktreeRemovedError } from "../utils/errorTypes.js";
import { categorizeWorktree } from "../services/worktree/mood.js";
import type { AdaptivePollingStrategy, NoteFileReader } from "../services/worktree/index.js";
import {
  extractIssueNumberSync,
  extractIssueNumber,
  deriveIssueTitleFromBranch,
} from "../services/issueExtractor.js";
import { timeoutSignal, withTimeout } from "../utils/withTimeout.js";
import type { WorktreeChanges, RepoState } from "../../shared/types/git.js";
import type { WorktreeMood } from "../../shared/types/worktree.js";
import type { WatcherController } from "./WatcherController.js";
import type { StatPrecheck } from "./StatPrecheck.js";
import type { BaseDivergence } from "./BaseDivergence.js";

const PLAN_FILE_CANDIDATES = ["TODO.md", "PLAN.md", "plan.md", "TASKS.md"] as const;

// Hard ceiling for individual filesystem syscalls on the poll path. On a
// healthy disk these return in well under a millisecond; on a stalled mount
// (disconnected NFS/SMB, sleeping external drive) they would otherwise block
// forever with no abort, pinning a libuv threadpool slot. Passed as an
// AbortSignal so the syscall is actually cancelled, not merely abandoned.
const FS_OP_TIMEOUT_MS = 5_000;

// FNV-1a 32-bit offset basis. Also the digest of an empty change list, which
// makes it the natural initial value for `previousStateHash` (see below).
const FNV_OFFSET_BASIS = 0x811c9dc5;

export interface GitStatusPassHost {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly mainBranch: string;
  readonly isCurrent: boolean;
  readonly isRunning: boolean;
  readonly basePollingInterval: number;
  readonly wslInvocation: WslGitInvocation | undefined;
  readonly abortSignal: AbortSignal;
  readonly prevEmittedIsDetached: boolean;
  readonly prevEmittedHead: string | undefined;
  readonly prevEmittedRepoState: RepoState | undefined;

  hasInitialStatus: boolean;
  repoState: RepoState | undefined;
  lastGitStatusCompletedAt: number;
  isUpdating: boolean;
  branch: string | undefined;
  issueNumber: number | undefined;
  branchDerivedTitle: string | undefined;
  issueTitle: string | undefined;
  isDetached: boolean;
  head: string | undefined;
  mood: WorktreeMood;
  summary: string | undefined;
  worktreeChanges: WorktreeChanges | null;

  clearPRInfo(): void;
  onBranchChanged(branch: string): void;
  onRemoved(): void;
  stop(): void;
  emitUpdate(): void;
}

/**
 * Runs the git-status poll pass: single-flight guarded, stat-precheck gated,
 * detects branch/note/plan-file/upstream/base-divergence changes and emits an
 * update when anything moved.
 */
export class GitStatusPass {
  // Output state from the last successful pass. Owned here rather than the
  // host because nothing outside this class and `SnapshotBuilder` (via its
  // own host getters) reads it.
  private previousStateHash: number = FNV_OFFSET_BASIS;
  private worktreeModifiedCount: number = 0;
  private noteContent: string | undefined;
  private noteTimestamp: number | undefined;
  private planFileDetected: boolean = false;
  private planFilePathValue: string | undefined;
  private upstreamAheadCount: number | undefined;
  private upstreamBehindCount: number | undefined;
  private baseBranchNameValue: string | null | undefined;
  private baseAheadCountValue: number | null | undefined;
  private baseBehindCountValue: number | null | undefined;
  private baseMatchesUpstreamValue: boolean | undefined;
  private activityTimestamp: number | null = null;

  constructor(
    private readonly host: GitStatusPassHost,
    private readonly statPrecheck: StatPrecheck,
    private readonly baseDivergence: BaseDivergence,
    private readonly watcherController: WatcherController,
    private readonly pollingStrategy: AdaptivePollingStrategy,
    private readonly noteReader: NoteFileReader
  ) {}

  get modifiedCount(): number {
    return this.worktreeModifiedCount;
  }

  get aiNote(): string | undefined {
    return this.noteContent;
  }

  get aiNoteTimestamp(): number | undefined {
    return this.noteTimestamp;
  }

  get hasPlanFile(): boolean {
    return this.planFileDetected;
  }

  get planFilePath(): string | undefined {
    return this.planFilePathValue;
  }

  get aheadCount(): number | undefined {
    return this.upstreamAheadCount;
  }

  get behindCount(): number | undefined {
    return this.upstreamBehindCount;
  }

  get baseBranchName(): string | null | undefined {
    return this.baseBranchNameValue;
  }

  get baseAheadCount(): number | null | undefined {
    return this.baseAheadCountValue;
  }

  get baseBehindCount(): number | null | undefined {
    return this.baseBehindCountValue;
  }

  get baseMatchesUpstream(): boolean | undefined {
    return this.baseMatchesUpstreamValue;
  }

  get lastActivityTimestamp(): number | null {
    return this.activityTimestamp;
  }

  async run(forceRefresh: boolean = false): Promise<void> {
    if (this.host.isUpdating) {
      return;
    }
    // Claim the single-flight slot before the first await. Everything below
    // suspends (git-dir resolution, the stat pre-check), and forced refreshes
    // bypass both the worktree-changes in-flight cache and the pre-check — so
    // without the early claim two rapid forced refreshes could pass the guard
    // together and run duplicate status passes with out-of-order commits.
    this.host.isUpdating = true;

    // Definite-assignment: assigned as the first statement of the try below;
    // the status pass (the only later reader) is unreachable unless that try
    // completed normally, so every read is dominated by the assignment.
    let gitDir!: string | null;
    let reachedStatusPass = false;
    try {
      // Skip the git status invocation while a rebase/merge/cherry-pick/revert
      // is in progress — running it would compete with the user's git client
      // for .git/index.lock. The watcher tracks the same sentinel files, so
      // it fires when the operation finishes and triggers a fresh refresh.
      // Polling continues uninterrupted, so the next scheduled poll after
      // sentinels clear also picks up the change.
      gitDir = await getGitDir(this.host.path, { cache: true, logErrors: false });

      // Detect blocking git operation state from sentinel files so the renderer
      // can surface it even when git status is skipped.
      let opState: RepoState | undefined;
      if (gitDir) {
        opState = getRepoOperationStateSync(gitDir);
        if (opState !== this.host.repoState) {
          this.host.repoState = opState;
          if (this.host.hasInitialStatus) {
            this.host.emitUpdate();
          }
        }
      } else {
        this.host.repoState = undefined;
      }

      if (gitDir && opState !== undefined) {
        // Stamp the completion timestamp before any emit so every snapshot below
        // carries the advanced value. Git status was skipped, but the sentinel
        // state was freshly observed above, so the freshness signal is accurate
        // and the heartbeat-gap detector (which reads this field) won't
        // false-positive on a long blocking operation. Without this, a
        // user-triggered refresh during a stuck blocking operation never advances
        // lastGitStatusCompletedAt, leaving the freshness pill permanently stale
        // and its Refresh button a no-op (#10715).
        this.host.lastGitStatusCompletedAt = Date.now();
        if (!this.host.hasInitialStatus) {
          // First poll started mid-operation (e.g. app started mid-rebase) — emit
          // a default snapshot so the renderer can still display the worktree.
          // Mirrors startWithoutGitStatus()'s contract.
          this.host.hasInitialStatus = true;
          this.host.emitUpdate();
        } else if (forceRefresh) {
          // The user clicked Refresh on a stale card. Emit so the renderer
          // receives the advanced timestamp and the freshness pill resets —
          // otherwise the click is silently dropped. Background polls stamp
          // silently; the watcher emits a real status once sentinels clear.
          this.host.emitUpdate();
        }
        return;
      }

      // Cheap stat pre-check: when the four git files we care about haven't
      // changed since the last baseline and no watcher event has fired since,
      // the simple-git fork-exec would be redundant. Skip it. This is the
      // common case on a quiet repo — the per-poll cost drops from ~15-50ms
      // (fork + git status) to ~1ms (four stat() calls).
      //
      // The baseline only exists after the first real check, so this branch
      // is a no-op on the very first poll. Forced refreshes (watcher events,
      // user actions) always run the full check.
      if (
        !forceRefresh &&
        gitDir &&
        this.host.hasInitialStatus &&
        (await this.statPrecheck.shouldSkip(
          gitDir,
          this.watcherController.currentMode === "recursive"
        ))
      ) {
        // Treat the skip as a no-change observation so the idle backoff
        // ramps up the next interval. lastGitStatusCompletedAt bumps too,
        // otherwise the heartbeat-gap check would false-positive on a
        // long quiet streak that only ran stat-skips.
        this.pollingStrategy.recordNoChange();
        this.host.lastGitStatusCompletedAt = Date.now();
        return;
      }

      reachedStatusPass = true;
    } finally {
      // Early exits (sentinel skip, stat skip, a throw above) release the
      // claim here and drain any pending watcher flush that queued while it
      // was held. The status pass below keeps the claim; its own finally is
      // the release point — and stays the LAST code to touch the flag, so a
      // flush-triggered synchronous re-entry can't have its claim clobbered.
      if (!reachedStatusPass) {
        this.host.isUpdating = false;
        this.watcherController.flushPendingIfReady(true);
      }
    }

    // Tracks whether the try block reached a clean exit point — either the
    // no-change early return or the post-emit fall-through. The catch block
    // doesn't flip it (so the finally clears the stale baseline) which means
    // a flaky git that throws here can't get its old baseline re-stamped and
    // silently suppress the next retry.
    let checkSucceeded = false;

    try {
      if (forceRefresh) {
        invalidateGitStatusCache(this.host.path);
      }

      const pollingInterval = this.host.basePollingInterval;
      const cacheTTL =
        Number.isFinite(pollingInterval) && pollingInterval > 0
          ? Math.max(500, pollingInterval - 500)
          : undefined;
      const newChanges = await getWorktreeChangesWithStats(this.host.path, {
        forceRefresh,
        cacheTTL,
        wsl: this.host.wslInvocation,
      });

      if (!this.host.isRunning) {
        return;
      }

      // Detect branch changes by reading HEAD directly
      const currentBranch = await this.readCurrentBranch();
      const branchChanged = currentBranch !== undefined && currentBranch !== this.host.branch;
      if (branchChanged) {
        this.host.branch = currentBranch;
        const hadPendingRefresh = this.watcherController.takePending();
        this.watcherController.update();
        if (hadPendingRefresh) {
          this.watcherController.markPending();
        }
        const syncIssueNumber = extractIssueNumberSync(currentBranch, this.host.name);
        if (syncIssueNumber) {
          this.host.issueNumber = syncIssueNumber;
        } else {
          this.host.issueNumber = undefined;
          void this.extractIssueNumberAsync(currentBranch, this.host.name);
        }
        this.host.branchDerivedTitle = deriveIssueTitleFromBranch(currentBranch);
        this.host.issueTitle = undefined;
        // Clear PR info synchronously in the same emit as the branch change
        // so the renderer never sees a frame with the new branch but the old
        // PR (#8079). PullRequestService still emits its own clear downstream;
        // by then this snapshot already has null PR fields, so that second
        // emit collapses to a no-op via snapshotsEqual.
        this.host.clearPRInfo();
        this.host.onBranchChanged(currentBranch);
      }

      // Bound the AI-note read: a slow/stalled note file must degrade to "no
      // note" for this pass, not hang the whole git-status update.
      const noteData = await withTimeout(
        this.noteReader.read(),
        FS_OP_TIMEOUT_MS,
        `note read: ${this.host.path}`
      ).catch(() => undefined);

      const hasUpstream = !!newChanges.tracking;
      const nextAheadCount = hasUpstream ? (newChanges.ahead ?? 0) : undefined;
      const nextBehindCount = hasUpstream ? (newChanges.behind ?? 0) : undefined;

      // Base-branch divergence — runs in parallel with plan file detection.
      const baseDivergencePromise = this.baseDivergence.compute(hasUpstream);

      const planResults = await Promise.allSettled(
        PLAN_FILE_CANDIDATES.map((candidate) =>
          withTimeout(
            access(pathJoin(this.host.path, candidate)),
            FS_OP_TIMEOUT_MS,
            `plan-file probe: ${candidate}`
          )
        )
      );
      const detectedPlanFile = PLAN_FILE_CANDIDATES.find(
        (_, i) => planResults[i].status === "fulfilled"
      );
      const nextHasPlanFile = detectedPlanFile !== undefined;
      const nextPlanFilePath = detectedPlanFile;

      const baseDivergenceResult = await baseDivergencePromise;
      const nextBaseBranchName = baseDivergenceResult?.baseBranchName ?? undefined;
      const nextBaseAheadCount = baseDivergenceResult?.aheadCount ?? undefined;
      const nextBaseBehindCount = baseDivergenceResult?.behindCount ?? undefined;
      const nextBaseMatchesUpstream = baseDivergenceResult?.matchesUpstream ?? undefined;

      const currentHash = this.calculateStateHash(newChanges);
      const stateChanged = currentHash !== this.previousStateHash;
      const noteChanged =
        noteData?.content !== this.noteContent || noteData?.timestamp !== this.noteTimestamp;
      const planChanged =
        nextHasPlanFile !== this.planFileDetected || nextPlanFilePath !== this.planFilePathValue;
      const upstreamChanged =
        nextAheadCount !== this.upstreamAheadCount || nextBehindCount !== this.upstreamBehindCount;
      const baseDivergenceChanged =
        nextBaseBranchName !== this.baseBranchNameValue ||
        nextBaseAheadCount !== this.baseAheadCountValue ||
        nextBaseBehindCount !== this.baseBehindCountValue ||
        nextBaseMatchesUpstream !== this.baseMatchesUpstreamValue;

      const gitStateChanged =
        this.host.isDetached !== this.host.prevEmittedIsDetached ||
        this.host.head !== this.host.prevEmittedHead ||
        this.host.repoState !== this.host.prevEmittedRepoState;

      const anythingChanged =
        stateChanged ||
        noteChanged ||
        branchChanged ||
        planChanged ||
        upstreamChanged ||
        baseDivergenceChanged ||
        gitStateChanged;

      // Drive the idle backoff from what the git check actually observed —
      // a real state change resets, otherwise we count one quiet tick. The
      // skip path above runs its own recordNoChange so this branch only
      // sees ticks that paid the full fork-exec cost.
      if (anythingChanged) {
        this.pollingStrategy.recordStateChange();
      } else {
        this.pollingStrategy.recordNoChange();
      }

      if (!anythingChanged && !forceRefresh) {
        checkSucceeded = true;
        return;
      }

      // True on initial load OR while the tree has stayed clean — the two are
      // deliberately indistinguishable (legacy ""-hash semantics).
      const isInitialLoad = this.previousStateHash === FNV_OFFSET_BASIS;
      const isNowClean = newChanges.changedFileCount === 0;
      const hasPendingChanges = newChanges.changedFileCount > 0;
      const shouldUpdateTimestamp =
        (stateChanged && !isInitialLoad) || (isInitialLoad && hasPendingChanges);

      if (shouldUpdateTimestamp) {
        this.activityTimestamp = Date.now();
      }

      if (isInitialLoad && isNowClean && this.activityTimestamp === null) {
        this.activityTimestamp = newChanges.lastCommitTimestampMs ?? null;
      }

      if (
        isNowClean ||
        isInitialLoad ||
        (this.host.worktreeChanges && this.host.worktreeChanges.changedFileCount === 0)
      ) {
        this.host.summary = await this.fetchLastCommitMessage(newChanges);
      }

      let nextMood = this.host.mood;
      try {
        nextMood = await categorizeWorktree(
          {
            id: this.host.id,
            path: this.host.path,
            name: this.host.name,
            branch: this.host.branch,
            isCurrent: this.host.isCurrent,
          },
          newChanges || undefined,
          this.host.mainBranch
        );
      } catch {
        nextMood = "error";
      }

      this.previousStateHash = currentHash;
      this.host.worktreeChanges = newChanges;
      this.worktreeModifiedCount = newChanges.changedFileCount;
      this.host.mood = nextMood;
      this.noteContent = noteData?.content;
      this.noteTimestamp = noteData?.timestamp;
      this.planFileDetected = nextHasPlanFile;
      this.planFilePathValue = nextPlanFilePath;
      this.upstreamAheadCount = nextAheadCount;
      this.upstreamBehindCount = nextBehindCount;
      this.baseBranchNameValue = nextBaseBranchName;
      this.baseAheadCountValue = nextBaseAheadCount;
      this.baseBehindCountValue = nextBaseBehindCount;
      this.baseMatchesUpstreamValue = nextBaseMatchesUpstream;
      this.host.hasInitialStatus = true;

      this.host.emitUpdate();
      checkSucceeded = true;
    } catch (error) {
      if (error instanceof WorktreeRemovedError) {
        this.host.stop();
        this.host.onRemoved();
        return;
      }

      const errorMessage = (error as Error).message || "";
      if (errorMessage.includes("index.lock")) {
        this.watcherController.markPending();
        this.watcherController.scheduleDelayedFlush();
        return;
      }

      this.host.mood = "error";
      this.host.emitUpdate();
      throw error;
    } finally {
      this.host.isUpdating = false;
      this.host.lastGitStatusCompletedAt = Date.now();
      // Rebuild the stat baseline only when a real git check finished
      // cleanly. On failure (anything that didn't set checkSucceeded — git
      // throw, WorktreeRemovedError, index.lock retry path) we drop the
      // baseline so the next non-forced poll falls through to a full check
      // rather than skipping against a snapshot that predates the failure.
      if (checkSucceeded && gitDir) {
        await this.statPrecheck.recordFullPass(gitDir);
      } else {
        this.statPrecheck.dropBaseline();
      }
      this.watcherController.flushPendingIfReady(true);
    }
  }

  private async readCurrentBranch(): Promise<string | undefined> {
    const gitDir = await getGitDir(this.host.path, { cache: true, logErrors: false });
    if (!gitDir) {
      this.host.isDetached = false;
      this.host.head = undefined;
      return undefined;
    }

    const { signal, dispose } = timeoutSignal(FS_OP_TIMEOUT_MS, this.host.abortSignal);
    try {
      const headContent = await readFile(pathJoin(gitDir, "HEAD"), { encoding: "utf-8", signal });
      const trimmed = headContent.trim();
      const prefix = "ref: refs/heads/";
      if (trimmed.startsWith(prefix)) {
        this.host.isDetached = false;
        this.host.head = undefined;
        return trimmed.slice(prefix.length);
      }
      // Detached HEAD — the file contains a commit SHA
      if (/^[0-9a-f]{40}$/.test(trimmed)) {
        this.host.isDetached = true;
        this.host.head = trimmed;
      } else {
        this.host.isDetached = false;
        this.host.head = undefined;
      }
      return undefined;
    } catch {
      // Includes a timeout/abort (AbortError) on a stalled filesystem — treat
      // as "branch unchanged" rather than letting the read hang the poll.
      this.host.isDetached = false;
      this.host.head = undefined;
      return undefined;
    } finally {
      dispose();
    }
  }

  private async extractIssueNumberAsync(branchName: string, folderName?: string): Promise<void> {
    try {
      const issueNum = await extractIssueNumber(branchName, folderName);
      if (issueNum && this.host.isRunning && this.host.branch === branchName) {
        this.host.issueNumber = issueNum;
        if (this.host.hasInitialStatus) {
          this.host.emitUpdate();
        }
      }
    } catch {
      // Silently ignore extraction errors
    }
  }

  // 32-bit FNV-1a digest instead of the raw joined string: the previous
  // implementation retained a path+stats concatenation proportional to the
  // worktree's change count for the monitor's lifetime. A hash collision
  // (~1 in 2^32 per state pair) suppresses the change event until the next
  // non-colliding state or a forced refresh.
  private calculateStateHash(changes: WorktreeChanges): number {
    const hashInput = changes.changes
      .map((c) => `${c.path}:${c.status}:${c.insertions ?? 0}:${c.deletions ?? 0}`)
      .sort()
      .join("|");
    let hash = FNV_OFFSET_BASIS;
    for (let i = 0; i < hashInput.length; i++) {
      hash = Math.imul(hash ^ hashInput.charCodeAt(i), 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  private async fetchLastCommitMessage(changes: WorktreeChanges): Promise<string> {
    if (changes.lastCommitMessage) {
      const firstLine = changes.lastCommitMessage.split("\n")[0].trim();
      return `✅ ${firstLine}`;
    }

    try {
      const wsl = this.host.wslInvocation;
      const git = wsl
        ? await createWslHardenedGit(wsl, this.host.abortSignal)
        : await createHardenedGit(this.host.path, this.host.abortSignal);
      const log = await git.log({ maxCount: 1 });
      const lastCommitMsg = log.latest?.message;

      if (lastCommitMsg) {
        const firstLine = lastCommitMsg.split("\n")[0].trim();
        return `✅ ${firstLine}`;
      }
      return "🌱 Ready to get started";
    } catch {
      return "🌱 Ready to get started";
    }
  }
}
