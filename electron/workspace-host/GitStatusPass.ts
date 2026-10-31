import { readFile, access } from "fs/promises";
import { join as pathJoin } from "path";
import { createHardenedGit, createWslHardenedGit } from "../utils/hardenedGit.js";
import type { WslGitInvocation } from "../utils/hardenedGit.js";
import { invalidateGitStatusCache, getWorktreeChangesWithStats } from "../utils/git.js";
import { getGitDir } from "../utils/gitUtils.js";
import { getRepoOperationState } from "../utils/gitRepoOperationState.js";
import { WorktreeRemovedError } from "../utils/errorTypes.js";
import { categorizeWorktree } from "../services/worktree/mood.js";
import type { AdaptivePollingStrategy, NoteFileReader } from "../services/worktree/index.js";
import {
  extractIssueNumberSync,
  extractIssueNumber,
  deriveIssueTitleFromBranch,
} from "../services/issueExtractor.js";
import { claimIssueFromBranch, type ClaimedIssue } from "../services/issueBranchClaim.js";
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

// FNV-1a 32-bit offset basis and initial state for the status digest.
const FNV_OFFSET_BASIS = 0x811c9dc5;

interface PassClaim {
  readonly lifecycleSignal: AbortSignal;
}

interface HeadState {
  branch: string | undefined;
  isDetached: boolean;
  head: string | undefined;
}

const NO_GIT_DIR_HEAD: HeadState = { branch: undefined, isDetached: false, head: undefined };

function isValidActivityTimestamp(value: unknown, now: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= now;
}

function deriveActivityTimestamp(changes: WorktreeChanges, now: number): number | null {
  const candidates: number[] = [];

  if (isValidActivityTimestamp(changes.lastCommitTimestampMs, now)) {
    candidates.push(changes.lastCommitTimestampMs);
  }

  if (changes.changedFileCount > 0) {
    if (isValidActivityTimestamp(changes.latestFileMtime, now)) {
      candidates.push(changes.latestFileMtime);
    }
    for (const change of changes.changes) {
      if (isValidActivityTimestamp(change.mtimeMs, now)) {
        candidates.push(change.mtimeMs);
      } else if (isValidActivityTimestamp(change.mtime, now)) {
        candidates.push(change.mtime);
      }
    }
  }

  return candidates.length > 0 ? Math.max(...candidates) : null;
}

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
  /** Setting a number here drops any branch claim the old number had. */
  issueNumber: number | undefined;
  /** Record an issues provider's branch-claimed issue (#13744). */
  setClaimedIssue?(claim: ClaimedIssue): void;
  branchDerivedTitle: string | undefined;
  issueTitle: string | undefined;
  isDetached: boolean;
  head: string | undefined;
  mood: WorktreeMood;
  summary: string | undefined;
  worktreeChanges: WorktreeChanges | null;

  clearPRInfo(): void;
  clearLinked(): void;
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
  private upstreamRefValue: string | null | undefined;
  private upstreamHeadShaValue: string | null | undefined;
  private baseBranchNameValue: string | null | undefined;
  private baseAheadCountValue: number | null | undefined;
  private baseBehindCountValue: number | null | undefined;
  private baseMatchesUpstreamValue: boolean | undefined;
  private baseCompareRefValue: string | null | undefined;
  private activityTimestamp: number | null = null;
  // The pass holding the single-flight slot. Losing it (stop, watchdog) ends
  // that pass's right to write, whenever it settles.
  private claim: PassClaim | null = null;

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

  get upstreamRef(): string | null | undefined {
    return this.upstreamRefValue;
  }

  get upstreamHeadSha(): string | null | undefined {
    return this.upstreamHeadShaValue;
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

  get baseCompareRef(): string | null | undefined {
    return this.baseCompareRefValue;
  }

  get lastActivityTimestamp(): number | null {
    return this.activityTimestamp;
  }

  /**
   * Give up on the in-flight pass: nothing it finds from here on lands, and
   * the slot is free for the next one. The stat baseline goes too, since the
   * pass that would have refreshed it never finished.
   */
  abandon(): void {
    if (this.claim) this.invalidate(this.claim);
  }

  /**
   * `abandonSignal` lets a caller that stops waiting (the poll watchdog) give
   * up on exactly the pass this call started, never a newer one.
   */
  async run(forceRefresh: boolean = false, abandonSignal?: AbortSignal): Promise<void> {
    if (this.host.isUpdating || !this.host.isRunning || this.host.abortSignal.aborted) {
      return;
    }
    // Claim the single-flight slot before the first await. Everything below
    // suspends (git-dir resolution, the stat pre-check), and forced refreshes
    // bypass both the worktree-changes in-flight cache and the pre-check — so
    // without the early claim two rapid forced refreshes could pass the guard
    // together and run duplicate status passes with out-of-order commits.
    // The lifecycle signal is pinned with it: a stop-then-start swaps the
    // monitor's controller mid-pass, and the old lifecycle must not publish.
    const claim: PassClaim = { lifecycleSignal: this.host.abortSignal };
    this.claim = claim;
    this.host.isUpdating = true;
    abandonSignal?.addEventListener("abort", () => this.invalidate(claim), { once: true });

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
      if (!this.isLive(claim)) {
        return;
      }

      // Detect blocking git operation state from sentinel files so the renderer
      // can surface it even when git status is skipped.
      let opState: RepoState | undefined;
      if (gitDir) {
        // Async and bounded: a sync readdir here blocked the whole host on a
        // stalled mount. A timeout fails open, like any other read error.
        opState = await withTimeout(
          getRepoOperationState(gitDir),
          FS_OP_TIMEOUT_MS,
          `repo operation state: ${gitDir}`
        ).catch(() => undefined);
        if (!this.isLive(claim)) {
          return;
        }
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
        this.host.worktreeChanges !== null
      ) {
        const skip = await this.statPrecheck.shouldSkip(
          gitDir,
          this.watcherController.currentMode === "recursive"
        );
        if (!this.isLive(claim)) {
          return;
        }
        if (skip) {
          // Treat the skip as a no-change observation so the idle backoff
          // ramps up the next interval. lastGitStatusCompletedAt bumps too,
          // otherwise the heartbeat-gap check would false-positive on a
          // long quiet streak that only ran stat-skips.
          this.pollingStrategy.recordNoChange();
          this.host.lastGitStatusCompletedAt = Date.now();
          return;
        }
      }

      reachedStatusPass = true;
    } finally {
      // Early exits (sentinel skip, stat skip, a throw above) release the
      // claim here and drain any pending watcher flush that queued while it
      // was held. The status pass below keeps the claim; its own finally is
      // the release point — and stays the LAST code to touch the flag, so a
      // flush-triggered synchronous re-entry can't have its claim clobbered.
      // A pass that lost its claim leaves both to whoever holds it now.
      if (!reachedStatusPass) {
        const live = this.isLive(claim);
        this.release(claim);
        if (live) this.watcherController.flushPendingIfReady(true);
      }
    }

    // Tracks whether the try block reached a clean exit point — either the
    // no-change early return or the post-emit fall-through. The catch block
    // doesn't flip it (so the finally clears the stale baseline) which means
    // a flaky git that throws here can't get its old baseline re-stamped and
    // silently suppress the next retry.
    let checkSucceeded = false;
    const signal = claim.lifecycleSignal;

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
        signal,
      });

      if (!this.isLive(claim)) {
        return;
      }

      // Detect branch changes by reading HEAD directly
      const headState = await this.readHead(signal);
      if (!this.isLive(claim)) {
        return;
      }
      // An unreadable or malformed HEAD keeps the last observed state.
      if (headState) {
        this.host.isDetached = headState.isDetached;
        this.host.head = headState.head;
      }
      const currentBranch = headState?.branch;
      const branchChanged = currentBranch !== undefined && currentBranch !== this.host.branch;
      if (branchChanged) {
        this.host.branch = currentBranch;
        const hadPendingRefresh = this.watcherController.takePending();
        this.watcherController.update();
        if (hadPendingRefresh) {
          this.watcherController.markPending();
        }
        const claimed = claimIssueFromBranch(currentBranch, this.host.name);
        const syncIssueNumber = claimed
          ? null
          : extractIssueNumberSync(currentBranch, this.host.name);
        if (claimed) {
          this.host.setClaimedIssue?.(claimed);
        } else if (syncIssueNumber) {
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
        // emit collapses to a no-op via snapshotsEqual. `linked` goes too: it
        // is the canonical PR, and that downstream clear names the old branch,
        // so the branch guard drops it and the old PR would otherwise stick.
        this.host.clearPRInfo();
        this.host.clearLinked();
        this.host.onBranchChanged(currentBranch);
      }

      // Bound the AI-note read: a slow/stalled note file must degrade to "no
      // note" for this pass, not hang the whole git-status update.
      const noteData = await withTimeout(
        this.noteReader.read(),
        FS_OP_TIMEOUT_MS,
        `note read: ${this.host.path}`
      ).catch(() => undefined);
      if (!this.isLive(claim)) {
        return;
      }

      const hasUpstream = !!newChanges.tracking;
      const nextAheadCount = hasUpstream ? (newChanges.ahead ?? 0) : undefined;
      const nextBehindCount = hasUpstream ? (newChanges.behind ?? 0) : undefined;

      // Base-branch divergence — runs in parallel with plan file detection.
      // Caught where it starts: it is awaited only after the plan-file probes,
      // so a rejection in between (createGit on a worktree deleted outside
      // Daintree) went unhandled and took the workspace host down.
      const baseDivergencePromise = this.baseDivergence.compute(hasUpstream).catch(() => null);

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
      if (!this.isLive(claim)) {
        return;
      }
      const nextBaseBranchName = baseDivergenceResult?.baseBranchName ?? undefined;
      const nextBaseAheadCount = baseDivergenceResult?.aheadCount ?? undefined;
      const nextBaseBehindCount = baseDivergenceResult?.behindCount ?? undefined;
      const nextBaseMatchesUpstream = baseDivergenceResult?.matchesUpstream ?? undefined;
      const nextBaseCompareRef = baseDivergenceResult?.baseCompareRef ?? undefined;
      // A divergence pass that failed says nothing about the upstream, so the
      // last observation stands while it is still configured; dropping it
      // would leave the PR service no "before" to see the next push against.
      const keepUpstream = baseDivergenceResult === null && hasUpstream && !branchChanged;
      const nextUpstreamRef = keepUpstream
        ? this.upstreamRefValue
        : (baseDivergenceResult?.upstreamRef ?? undefined);
      const nextUpstreamHeadSha = keepUpstream
        ? this.upstreamHeadShaValue
        : (baseDivergenceResult?.upstreamHeadSha ?? undefined);
      // Follow the exact upstream ref file so a push to it wakes this pass
      // within the watcher debounce, wherever it nests (#13400).
      this.watcherController.setUpstreamRef(nextUpstreamRef ?? null);

      const currentHash = this.calculateStateHash(newChanges);
      const stateChanged = currentHash !== this.previousStateHash;
      const nextActivityTimestamp = deriveActivityTimestamp(newChanges, Date.now());
      const activityChanged = nextActivityTimestamp !== this.activityTimestamp;
      const noteChanged =
        noteData?.content !== this.noteContent || noteData?.timestamp !== this.noteTimestamp;
      const planChanged =
        nextHasPlanFile !== this.planFileDetected || nextPlanFilePath !== this.planFilePathValue;
      // The commit counts alone miss a force-push that leaves them unchanged.
      const upstreamChanged =
        nextAheadCount !== this.upstreamAheadCount ||
        nextBehindCount !== this.upstreamBehindCount ||
        nextUpstreamRef !== this.upstreamRefValue ||
        nextUpstreamHeadSha !== this.upstreamHeadShaValue;
      const baseDivergenceChanged =
        nextBaseBranchName !== this.baseBranchNameValue ||
        nextBaseAheadCount !== this.baseAheadCountValue ||
        nextBaseBehindCount !== this.baseBehindCountValue ||
        nextBaseMatchesUpstream !== this.baseMatchesUpstreamValue ||
        nextBaseCompareRef !== this.baseCompareRefValue;

      const gitStateChanged =
        this.host.isDetached !== this.host.prevEmittedIsDetached ||
        this.host.head !== this.host.prevEmittedHead ||
        this.host.repoState !== this.host.prevEmittedRepoState;

      const anythingChanged =
        stateChanged ||
        activityChanged ||
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

      // A placeholder snapshot (startWithoutGitStatus) seeds every comparison
      // above, so "unchanged" can't be trusted until a status has published.
      if (!anythingChanged && !forceRefresh && this.host.worktreeChanges !== null) {
        checkSucceeded = true;
        return;
      }

      const isInitialLoad = !this.host.hasInitialStatus;
      const isNowClean = newChanges.changedFileCount === 0;

      const nextSummary =
        isNowClean ||
        isInitialLoad ||
        (this.host.worktreeChanges && this.host.worktreeChanges.changedFileCount === 0)
          ? await this.fetchLastCommitMessage(newChanges, signal)
          : undefined;

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
      if (!this.isLive(claim)) {
        return;
      }

      this.activityTimestamp = nextActivityTimestamp;
      if (nextSummary !== undefined) {
        this.host.summary = nextSummary;
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
      this.upstreamRefValue = nextUpstreamRef;
      this.upstreamHeadShaValue = nextUpstreamHeadSha;
      this.baseBranchNameValue = nextBaseBranchName;
      this.baseAheadCountValue = nextBaseAheadCount;
      this.baseBehindCountValue = nextBaseBehindCount;
      this.baseMatchesUpstreamValue = nextBaseMatchesUpstream;
      this.baseCompareRefValue = nextBaseCompareRef;
      this.host.hasInitialStatus = true;

      this.host.emitUpdate();
      checkSucceeded = true;
    } catch (error) {
      // The monitor stopped mid-pass (its signal killed the git child) or the
      // watchdog gave up on it. Either way the failure says nothing about the
      // worktree, so no error mood.
      if (!this.isLive(claim)) {
        return;
      }

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
      // Rebuild the stat baseline only when a real git check finished
      // cleanly. On failure (anything that didn't set checkSucceeded — git
      // throw, WorktreeRemovedError, index.lock retry path) we drop the
      // baseline so the next non-forced poll falls through to a full check
      // rather than skipping against a snapshot that predates the failure.
      // The claim is held until the baseline lands, so a newer pass can't
      // start against the half-built one.
      if (this.isLive(claim)) {
        this.host.lastGitStatusCompletedAt = Date.now();
        if (checkSucceeded && gitDir) {
          await this.statPrecheck.recordFullPass(gitDir, () => this.isLive(claim));
        } else {
          this.statPrecheck.dropBaseline();
        }
      }
      const live = this.isLive(claim);
      this.release(claim);
      if (live) this.watcherController.flushPendingIfReady(true);
    }
  }

  private isLive(claim: PassClaim): boolean {
    return this.claim === claim && this.host.isRunning && !claim.lifecycleSignal.aborted;
  }

  private release(claim: PassClaim): void {
    if (this.claim !== claim) return;
    this.claim = null;
    this.host.isUpdating = false;
  }

  private invalidate(claim: PassClaim): void {
    if (this.claim !== claim) return;
    this.release(claim);
    this.statPrecheck.dropBaseline();
  }

  // Reads only: the caller applies the result once it knows the pass is live.
  private async readHead(lifecycleSignal: AbortSignal): Promise<HeadState | undefined> {
    const gitDir = await getGitDir(this.host.path, { cache: true, logErrors: false });
    if (!gitDir) {
      return NO_GIT_DIR_HEAD;
    }

    const { signal, dispose } = timeoutSignal(FS_OP_TIMEOUT_MS, lifecycleSignal);
    try {
      const headContent = await readFile(pathJoin(gitDir, "HEAD"), { encoding: "utf-8", signal });
      const trimmed = headContent.trim();
      const prefix = "ref: refs/heads/";
      if (trimmed.startsWith(prefix)) {
        return { branch: trimmed.slice(prefix.length), isDetached: false, head: undefined };
      }
      // Detached HEAD — the file contains a commit SHA
      // SHA-1 repos hold 40 hex chars, SHA-256 repos 64.
      if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(trimmed)) {
        return { branch: undefined, isDetached: true, head: trimmed };
      }
      return undefined;
    } catch {
      // Includes a timeout/abort (AbortError) on a stalled filesystem — keep the
      // last observed state rather than inventing an attached one.
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
    const fileState = changes.changes
      .map(
        (c) =>
          `${c.path}:${c.status}:${c.insertions ?? 0}:${c.deletions ?? 0}:${String(c.mtimeMs ?? c.mtime ?? "")}`
      )
      .sort();
    // Files past the untracked enrichment cap have no row above, so a count
    // that grows from 201 to 205 would otherwise publish nothing.
    if (changes.omittedUntrackedCount) {
      fileState.push(`omitted-untracked:${String(changes.omittedUntrackedCount)}`);
    }
    if (changes.changedFileCount > 0 && changes.latestFileMtime !== undefined) {
      fileState.push(`latest-file-mtime:${String(changes.latestFileMtime)}`);
    }
    if (changes.lastCommitTimestampMs !== undefined) {
      fileState.push(`last-commit-time:${String(changes.lastCommitTimestampMs)}`);
    }
    if (changes.lastCommitMessage !== undefined) {
      fileState.push(`last-commit-message:${changes.lastCommitMessage}`);
    }
    // Message and time alone miss a HEAD move between two commits that share
    // both, and plugins read a changed oid as "a commit landed".
    if (changes.headOid !== undefined) {
      fileState.push(`head-oid:${changes.headOid}`);
    }
    const hashInput = fileState.join("|");
    let hash = FNV_OFFSET_BASIS;
    for (let i = 0; i < hashInput.length; i++) {
      hash = Math.imul(hash ^ hashInput.charCodeAt(i), 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  private async fetchLastCommitMessage(
    changes: WorktreeChanges,
    signal: AbortSignal
  ): Promise<string> {
    if (changes.lastCommitMessage) {
      const firstLine = changes.lastCommitMessage.split("\n")[0].trim();
      return `✅ ${firstLine}`;
    }

    try {
      const wsl = this.host.wslInvocation;
      const git = wsl
        ? await createWslHardenedGit(wsl, signal)
        : await createHardenedGit(this.host.path, signal);
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
