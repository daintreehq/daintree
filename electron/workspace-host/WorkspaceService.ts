import os from "os";
import { randomUUID } from "node:crypto";
import PQueue from "p-queue";
import { existsSync } from "fs";
import { stat, readFile, access, mkdir, realpath } from "fs/promises";
import { resolve as pathResolve, isAbsolute, dirname } from "path";
import { validateBranchName } from "../../shared/utils/pathPattern.js";
import { sliceUtf8Window } from "../../shared/utils/boundedOutput.js";
import {
  GIT_FILE_DIFF_MAX_BYTES,
  GIT_FILE_DIFF_MAX_SOURCE_BYTES,
} from "../../shared/config/gitReadLimits.js";
import { settingsFilePath } from "../services/projectStorePaths.js";
import { SimpleGit, BranchSummary } from "simple-git";
import { createHardenedGit, createAuthenticatedGit } from "../utils/hardenedGit.js";
import {
  classifyGitError,
  extractGitErrorMessage,
  getGitRecoveryAction,
  getGitRecoveryHint,
} from "../../shared/utils/gitOperationErrors.js";
import { logWarn } from "../utils/logger.js";
import { isBinaryDiffOutput } from "../../shared/utils/gitDiffParsing.js";
import type { Worktree, WslGitEligibility } from "../../shared/types/worktree.js";
import type {
  WorkspaceHostEvent,
  WorktreeSnapshot,
  MonitorConfig,
  CreateWorktreeOptions,
  BranchInfo,
} from "../../shared/types/workspace-host.js";
import type {
  PluginWorktreeLinked,
  PluginWorktreeLinkedIssue,
  PluginWorktreeLinkedPR,
} from "../../shared/types/plugin.js";
import type { GitOperationReason } from "../../shared/types/ipc/errors.js";
import type { CIStatus, NormalizedPRState } from "../../shared/types/forge.js";
import type { WorktreeChanges } from "../../shared/types/git.js";
import { invalidateGitStatusCache } from "../utils/git.js";
import { branchRefName, readBranchCommitterDates } from "../utils/branchCommitterDates.js";
import { withTimeout } from "../utils/withTimeout.js";
import { detectWslPath, getDefaultWslDistro } from "../utils/wsl.js";
import {
  getGitDir,
  getGitCommonDir,
  clearGitDirCache,
  clearGitCommonDirCache,
} from "../utils/gitUtils.js";
import { extractIssueNumberSync, extractIssueNumber } from "../services/issueExtractor.js";
import { pullRequestService } from "../services/PullRequestService.js";
import { events } from "../services/events.js";
import { WorktreeLifecycleService, type WorkspaceHostContext } from "./WorktreeLifecycleService.js";
import { WorktreeMonitor } from "./WorktreeMonitor.js";
import { WorktreeListService } from "./WorktreeListService.js";
import { PRIntegrationService, type PRIntegrationCallbacks } from "./PRIntegrationService.js";
import { RepoFetchCoordinator } from "./RepoFetchCoordinator.js";
import { planFetchRemotes } from "../../shared/utils/baseRemoteSelection.js";

/**
 * The remote a worktree's displayed counts depend on. Derived through the same
 * planner that chose what to fetch, so the "which remote did we fetch for this
 * card" and "which remote may update this card" answers cannot drift apart.
 */
function dependsOnRemote(monitor: WorktreeMonitor): string {
  return planFetchRemotes({
    baseRemote: monitor.baseRemote,
    availableRemotes: monitor.availableRemotes,
  }).primaryRemote;
}
import { waitForPathExists } from "../utils/fs.js";
import { markHostPerformance } from "../utils/hostPerformance.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import {
  parseCheckedOutBranches,
  nextAvailableBranchName,
  isBranchAlreadyExistsError,
  ensureNoteFile,
  assertWorktreePathContained,
} from "./worktreeUtils.js";
import {
  matchProviderForRemoteUrl,
  type ForgeProviderMatcher,
} from "../../shared/utils/forgeHostnames.js";
import { resolveForgeRemote } from "../../shared/utils/forgeRemoteSelection.js";
import { applyResourceConfigToMonitor } from "./resourceConfigHelpers.js";
import { ResourceActionExecutor } from "./ResourceActionExecutor.js";
import { TopologyWatcher, type TopologyWatcherHost } from "./TopologyWatcher.js";

function normalizePathKeyForPrefix(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "" && value.startsWith("/") ? "/" : normalized;
}

function pathParentForPrefix(value: string): string {
  const normalized = normalizePathKeyForPrefix(value);
  if (normalized === "/") return "/";
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex <= 0) return slashIndex === 0 ? "/" : normalized;
  return normalized.slice(0, slashIndex);
}

function isPathKeyAtOrUnder(candidate: string, parent: string): boolean {
  const normalizedCandidate = normalizePathKeyForPrefix(candidate);
  const normalizedParent = normalizePathKeyForPrefix(parent);
  const comparableCandidate =
    process.platform === "win32" ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  const comparableParent =
    process.platform === "win32" ? normalizedParent.toLowerCase() : normalizedParent;

  return (
    comparableCandidate === comparableParent ||
    comparableCandidate.startsWith(comparableParent === "/" ? "/" : `${comparableParent}/`)
  );
}

// Re-export so existing test imports (`probeGitLfsAvailable` from
// `../WorkspaceService.js`) continue to work without modification.
export { probeGitLfsAvailable } from "./worktreeUtils.js";

// Configuration
const DEFAULT_ACTIVE_WORKTREE_INTERVAL_MS = 2000;
const DEFAULT_BACKGROUND_WORKTREE_INTERVAL_MS = 10000;
// Default cap on concurrent background `git-only` file watchers per
// workspace-host. Matches the `balanced` profile's `backgroundGitWatcherCap`
// in `shared/types/resourceProfile.ts` — that profile must mirror the
// hardcoded defaults. Overridden per-profile via `updateMonitorConfig`.
const DEFAULT_BACKGROUND_GIT_WATCHER_CAP = 12;
const WORKTREE_REMOVE_LOCK_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 3000, 5000, 8000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientWorktreeRemoveLockError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException;
  const code = err.code;
  if (code === "EPERM" || code === "EACCES" || code === "EBUSY") return true;

  const message = err.message ?? "";
  return /permission denied|eperm|eacces|ebusy|being used by another process|resource busy/i.test(
    message
  );
}

// Ceiling for a single queued git-status pass holding a pollQueue slot. On
// expiry p-queue rejects that task's add() promise and frees the slot (its
// finally runs #next), so three slow/stuck worktrees can never permanently
// starve the shared queue and freeze every other worktree. Every pollQueue
// consumer tolerates the rejection (poll() catches, refreshAll uses
// allSettled, forceRefreshAfterGap catches). The underlying work isn't
// cancelled, but the individual fs/git awaits are independently bounded.
const POLL_QUEUE_TASK_TIMEOUT_MS = 60_000;

// Overall ceiling for a user-initiated full refresh. Guarantees the port
// request always replies so the sidebar's Refresh button can never hang or be
// a silent no-op, even when the underlying pipelines are degraded.
const HOST_REFRESH_TIMEOUT_MS = 45_000;

// Coalescing window for `.git/config` writes (#11155). Every worktree sharing
// the common dir reports the same write, and git itself writes config as
// lock-then-rename (two events), so a short trailing debounce collapses the
// burst into one `getRemotes()` spawn.
const FORGE_REMOTE_REPROBE_DEBOUNCE_MS = 250;
// Re-arm budget for a settings/matcher-driven reselect whose probe was
// superseded or failed. Bounded because a deleted repo fails enumeration
// forever and nothing else retries this path (`.git/config` never changed).
const FORGE_RESELECT_MAX_RETRIES = 3;

// Backstop cadence for the config fingerprint check when the git watcher is
// disabled or has silently degraded. A stat, not a subprocess.
const FORGE_CONFIG_POLL_INTERVAL_MS = 5 * 60 * 1000;

// FIFO cap on the acknowledged-mutation dedup set. Mutation ids are arbitrary
// UUIDs (not path-keyed), so size-capping is the only viable pruning strategy;
// a session sees well under 100 deletes, so 500 never evicts a live id.
export const MAX_ACKNOWLEDGED_MUTATIONS = 500;

/**
 * A repository probe that could not answer, as distinct from one that answered
 * "no".
 *
 * Carries user-facing copy only. simple-git's child-process error handler
 * pushes `String(err.stack)` into the stderr buffer, so the `GitError` it
 * rethrows has the whole Node stack trace as its `message` and no `code`,
 * `syscall` or `cause` to discriminate on. `loadProject` forwards its caught
 * message straight to the "Couldn't load worktrees" banner, so that stack would
 * be what the user reads. The original is kept as `cause` for diagnostics and
 * never reaches the renderer.
 */
class RepositoryProbeError extends Error {
  readonly gitReason: GitOperationReason;

  constructor(gitReason: GitOperationReason, cause?: unknown) {
    // Reuses the classifier's own recovery copy rather than a parallel set of
    // strings, so a new `GitOperationReason` gets a usable sentence here for
    // free and there is one place to review git-failure wording.
    const hint = getGitRecoveryHint(gitReason);
    super(
      `Couldn't check whether this folder is a git repository. ${
        hint ?? "Make sure the folder is available and git can run, then try again."
      }`,
      cause === undefined ? undefined : { cause }
    );
    this.name = "RepositoryProbeError";
    this.gitReason = gitReason;
  }
}

export class WorkspaceService {
  private monitors = new Map<string, WorktreeMonitor>();
  private pollQueue = new PQueue({
    concurrency: 3,
    timeout: POLL_QUEUE_TASK_TIMEOUT_MS,
  });
  private mainBranch: string = "main";
  private activeWorktreeId: string | null = null;
  private pollIntervalActive: number = DEFAULT_ACTIVE_WORKTREE_INTERVAL_MS;
  private pollIntervalBackground: number = DEFAULT_BACKGROUND_WORKTREE_INTERVAL_MS;
  private fetchIntervalActiveMs: number = 30_000;
  private fetchIntervalBackgroundMs: number = 5 * 60_000;
  // Last GitHub rate-limit cadence multiplier applied to monitor fetch
  // schedulers. Tracked so a recovery (multiplier back to 1) can be detected
  // and trigger an immediate re-arm. The user-configured base intervals above
  // are never overwritten by throttling — see applyFetchThrottle.
  private _lastAppliedThrottleMultiplier: number = 1;
  private adaptiveBackoff: boolean = true;
  private pollIntervalMax: number = 30000;
  private circuitBreakerThreshold: number = 3;
  private gitWatchEnabled: boolean = true;
  private gitWatchDebounceMs: number = 100;
  // Profile-aware ceiling on concurrent background `git-only` watchers (#9538).
  // The focused worktree always keeps its (recursive) watcher and is excluded
  // from this budget; background worktrees beyond the cap fall back to the
  // adaptive poll path. Bounds the O(N) inotify/FSEvents/fd growth long
  // sessions with many worktrees would otherwise hit. Per-instance (one
  // workspace-host per project view), never global.
  private backgroundGitWatcherCap: number = DEFAULT_BACKGROUND_GIT_WATCHER_CAP;
  // Recency-ordered set of background worktree IDs eligible for a git-only
  // watcher. ES Map preserves insertion order: head = least-recently-focused
  // (LRU, first evicted), tail = most-recently-focused (MRU). The active
  // worktree is never present here. Mutated via lruTouch/lruRemove; budget
  // enforced by applyWatcherBudget().
  private readonly backgroundGitWatcherLru = new Map<string, true>();
  // Worktree IDs the renderer reports as having an actively working agent
  // (via the `set-agent-activity` port action). Agent-active monitors are
  // elevated to the recursive watcher tier and exempted from the background
  // watcher budget, exactly like the focused worktree — the ENOSPC/EMFILE
  // degradation path bounds the worst case on constrained kernels. Kept as a
  // set (not per-monitor only) so worktrees discovered *after* the broadcast
  // (e.g. an agent's own `git worktree add`) inherit the flag on creation.
  private agentActiveWorktreeIds = new Set<string>();
  // Provider hostname-matcher table relayed from main's forge registry.
  // Empty until the first relay lands (after plugin load), so monitors start
  // unmatched and re-resolve when the table arrives or changes.
  private forgeProviderMatchers: ForgeProviderMatcher[] = [];
  // Repo-level forge-remote state (#11155). Remotes live in the shared
  // `.git/config`, so every worktree's watcher reports the same write — the
  // service coalesces them into ONE probe and fans the result out to all
  // monitors. `forgeRemoteSignature` is the last-seen remote table (names +
  // fetch URLs, host-local and never transmitted — remote URLs can embed
  // credentials). Events fire only when it genuinely changes, so the unrelated
  // config writes that already wake the watcher (`git push -u`,
  // `branch --set-upstream-to`) cost nothing and cannot churn the provider.
  private forgeRemoteSignature: string | null = null;
  // The project's selected forge remote *name* (#11408). Kept on the service
  // (not just handed to `pullRequestService`) because `readForgeRemotes` needs
  // it to pick the same remote the toolbar routes through — otherwise the
  // worktree cards probe `origin` while the toolbar talks to `upstream`.
  private forgeRemoteName: string | null = null;
  private forgeReselectSeq = 0;
  private forgeReselectTimer: NodeJS.Timeout | null = null;
  private forgeReselectRetries = 0;
  private forgeRemoteProbeSeq = 0;
  private forgeRemoteReprobeTimer: NodeJS.Timeout | null = null;
  // Bumped whenever a `.git/config` write is OBSERVED. A baseline read that
  // spans a bump may already contain the change it was meant to precede, so it
  // is discarded rather than seeded.
  private forgeConfigEpoch = 0;
  // Watcher-independent backstop: `GitFileWatcher` swallows `fs.watch` failures
  // (silent fallback to polling) and Linux inotify exhaustion is a live failure
  // mode, so a repo can miss the config event entirely. Costs one stat per
  // interval; the git subprocess runs only when the fingerprint actually moved.
  private forgeConfigPollTimer: NodeJS.Timeout | null = null;
  private forgeConfigFingerprint: string | null = null;
  private git: SimpleGit | null = null;
  /**
   * Whether the loaded folder is a git repository, as observed by `loadProject`.
   * `null` before the first load. `false` keeps every worktree monitor, the
   * topology watcher and forge detection permanently off for this host (#11405).
   */
  private gitBacked: boolean | null = null;
  private pollingEnabled: boolean = true;
  private projectRootPath: string | null = null;
  // Immutable project id threaded from main via load-project (#11282). The host
  // has no DB access, so it can never re-derive this from the path — hashing the
  // path would mint a stale id for any relocated project.
  private projectId: string | null = null;
  private projectEnvVars: Record<string, string> = {};
  private lifecycleService = new WorktreeLifecycleService();
  private listService = new WorktreeListService();
  private prService: PRIntegrationService;
  private fetchCoordinator: RepoFetchCoordinator;
  private _shutdownController = new AbortController();
  readonly resourceActionExecutor: ResourceActionExecutor;
  /** Session-scoped guard so we notify the user about Linux inotify limits
   *  only once, even if many worktrees hit ENOSPC concurrently. */
  private inotifyLimitNotified = false;
  /** Session-scoped guard so we notify the user about the macOS FSEvents file
   *  descriptor ceiling only once, even if many worktrees hit EMFILE concurrently. */
  private emfileLimitNotified = false;
  /** Per-commondir guard so a confirmed forge-auth failure raises its single
   *  escalation toast once, not once per sibling worktree. Cleared by
   *  `retryAuthFetch()` / credential rotation so a later re-confirmation can
   *  re-notify. */
  private readonly authFailureConfirmedNotified = new Set<string>();

  /** Per-worktree WSL git opt-in state forwarded from main on load and toggle. */
  private wslGitByWorktree: Record<string, { enabled: boolean; dismissed: boolean }> = {};
  /** Cached default WSL distro (populated lazily on first WSL-path detection). */
  private wslDefaultDistroPromise: Promise<string | null> | null = null;
  /**
   * Last default distro the poller observed. `undefined` until the first probe
   * seeds it (so the first poll tick can't spuriously diff against it). `null`
   * means the probe ran but found no default (WSL absent / probe failed).
   */
  private wslLastKnownDefaultDistro: string | null | undefined = undefined;
  /** Background poll handle that watches for WSL default-distro changes. */
  private wslDistroPoller: ReturnType<typeof setInterval> | null = null;
  /**
   * Monotonic guard so a slow probe (poll or reprobe) that resolves after a
   * newer probe — or after a project switch — discards its stale result instead
   * of overwriting fresher state or refreshing the next project's monitors.
   */
  private wslProbeSeq = 0;
  /** How often to re-check the WSL default distro (Windows only). */
  private static readonly WSL_DISTRO_POLL_INTERVAL_MS = 60_000;

  // Watches `.git/worktrees/` for external worktree create/delete and drives
  // serialized reconciliation, the dark/recovered signal, and the
  // watcher-independent periodic safety net. See TopologyWatcher.ts.
  private readonly topologyWatcher: TopologyWatcher;
  private readonly inFlightWorktreeCreates = new Map<string, Promise<string>>();
  // Per-repo create chain: distinct creates on the same root run strictly
  // one-at-a-time, back to back. This enforces the no-concurrent-`git worktree
  // add` property (#5098 git lock contention) at the actual git boundary, so
  // the IPC layer's rate limit can grant a burst allowance without wall-clock
  // pacing every create 1s apart.
  private readonly createWorktreeQueues = new Map<string, Promise<unknown>>();

  /**
   * Host-run identity, minted once per WorkspaceService instance — i.e. once
   * per workspace-host process lifetime. Stamped onto every worktree state
   * event so the renderer can detect a host restart (epoch change) and
   * re-hydrate instead of silently dropping events whose `seq` reset (#8403).
   */
  private readonly epoch: string = randomUUID();
  /** Monotonic event counter within `epoch`. */
  private seq = 0;

  /**
   * Epoch-scoped set of mutation IDs that have been successfully acknowledged
   * by this host run. The renderer mints a stable mutationId per delete intent
   * (#8405) and the host records each successful delete here so a replay of
   * the same mutationId after a transient port hiccup is short-circuited to a
   * success ack instead of re-running `git worktree remove` (which would throw
   * once the monitor is already gone). Cleared implicitly on host restart —
   * the new epoch starts with an empty set, which matches the renderer's
   * outbox semantics: a fresh epoch means the prior run's acks no longer apply
   * and the renderer's outbox replay flow takes over.
   */
  private readonly acknowledgedMutations = new Set<string>();

  /** Record an acked mutation id, evicting the oldest past the FIFO cap. */
  private recordAcknowledgedMutation(mutationId: string): void {
    this.acknowledgedMutations.add(mutationId);
    if (this.acknowledgedMutations.size > MAX_ACKNOWLEDGED_MUTATIONS) {
      const oldest = this.acknowledgedMutations.values().next().value;
      if (oldest !== undefined) this.acknowledgedMutations.delete(oldest);
    }
  }

  /** Advance and return the next monotonic seq for an outgoing event. */
  private nextSeq(): number {
    return ++this.seq;
  }

  /**
   * Current version stamp — used by the `get-all-states` response so the
   * renderer anchors its baseline to the host's high-water mark. `seq` is NOT
   * advanced here: a snapshot describes existing state, it is not a new event.
   */
  getVersion(): { epoch: string; seq: number } {
    return { epoch: this.epoch, seq: this.seq };
  }

  constructor(private readonly sendEvent: (event: WorkspaceHostEvent) => void) {
    this.fetchCoordinator = new RepoFetchCoordinator({
      onFetchSuccess: (worktreeId) => {
        // A successful fetch updated remote refs, so the next `rev-list` for
        // ahead/behind returns fresh counts for *every* worktree sharing this
        // repo's common dir — not just the one that triggered the fetch. Force
        // a status refresh across all siblings so a sibling-triggered fetch
        // still surfaces the main worktree's new behind-count promptly (drives
        // the forge-count recheck, #11151) instead of waiting for that
        // worktree's own next poll tick. Fire-and-forget; fetch success must
        // never block, and a commondir-resolution race during teardown must
        // not surface as an unhandled rejection.
        void this.refreshStatusForFetchSiblings(worktreeId).catch(() => {});
      },
      onAuthFailureConfirmed: (commonDir, _remote, reason) =>
        this.handleAuthFailureConfirmed(commonDir, reason),
    });
    const prCallbacks: PRIntegrationCallbacks = {
      onPRDetected: (worktreeId, data) => {
        const monitor = this.monitors.get(worktreeId);
        if (!monitor) return;
        if (
          data.branchName !== undefined &&
          monitor.branch !== undefined &&
          monitor.branch !== data.branchName
        ) {
          return;
        }

        // `linked` is the source of truth — built from the canonical
        // provider/owner/repo carried by the detection event. Flat fields are
        // derived compatibility values written alongside it.
        const prevSnapshot = monitor.getSnapshot();
        const existingIssue = prevSnapshot.linked?.issue;
        // Phase-1 detection carries no CI status yet (enrichment is a
        // fire-and-forget tail). For the same PR, keep the prior CI rollup so
        // neither the worktree-update snapshot nor the pr-detected overlay
        // blinks the dot to "no checks" before the phase-2 emit lands (#9551).
        // A genuine "checks disappeared" clear arrives with the flag absent and
        // full-replaces, preserving the prior design intent. The same-PR guard
        // avoids carrying a stale dot across a PR reassignment.
        const preserveCiStatus =
          data.isCiStatusLoading === true && prevSnapshot.prNumber === data.prNumber;
        const resolvedCiStatus = preserveCiStatus
          ? prevSnapshot.linked?.pr?.ciStatus
          : data.ciStatus;
        const resolvedPrCiStatus = preserveCiStatus ? prevSnapshot.prCiStatus : data.prCiStatus;
        const linked = this.composeLinked({
          providerId: data.providerId,
          owner: data.owner,
          repo: data.repo,
          pr: {
            number: data.prNumber,
            title: data.prTitle,
            url: data.prUrl,
            state: data.prState,
            ciStatus: resolvedCiStatus,
            baseRef: data.baseRef,
          },
          issue:
            data.issueNumber && data.issueTitle
              ? { number: data.issueNumber, title: data.issueTitle }
              : undefined,
        });
        // Preserve an earlier issue linkage this PR event didn't carry.
        const finalLinked: PluginWorktreeLinked =
          !linked.issue && existingIssue ? { ...linked, issue: existingIssue } : linked;

        monitor.setLinked(finalLinked);
        monitor.setPRInfo({
          prNumber: data.prNumber,
          prUrl: data.prUrl,
          prState: data.prState,
          prCiStatus: resolvedPrCiStatus,
          prTitle: data.prTitle,
          issueTitle: data.issueTitle,
          prLastUpdatedAt: data.prLastUpdatedAt,
          issueLastUpdatedAt: data.issueLastUpdatedAt,
        });

        if (monitor.hasInitialStatus) {
          this.emitUpdate(monitor);
        }

        this.sendEvent({
          type: "pr-detected",
          worktreeId,
          prNumber: data.prNumber,
          prUrl: data.prUrl,
          // Legacy flat field stays narrow; `linked.pr.state` carries the
          // full NormalizedPRState including "declined".
          prState: data.prState === "declined" ? "closed" : data.prState,
          prCiStatus: resolvedPrCiStatus,
          prTitle: data.prTitle,
          issueNumber: data.issueNumber,
          issueTitle: data.issueTitle,
          prLastUpdatedAt: data.prLastUpdatedAt,
          issueLastUpdatedAt: data.issueLastUpdatedAt,
          branchName: data.branchName,
          providerId: data.providerId,
          linked: finalLinked,
        });
      },
      onPRCleared: (worktreeId, data) => {
        const monitor = this.monitors.get(worktreeId);
        if (!monitor) return;
        if (
          data.branchName !== undefined &&
          monitor.branch !== undefined &&
          monitor.branch !== data.branchName
        ) {
          return;
        }

        monitor.clearPRInfo();
        // Preserve linked.issue when only the PR is being cleared
        const existingLinked = monitor.getSnapshot().linked;
        if (existingLinked?.issue) {
          monitor.setLinked({
            providerId: existingLinked.providerId,
            issue: existingLinked.issue,
          });
        } else {
          monitor.clearLinked();
        }
        if (monitor.hasInitialStatus) {
          this.emitUpdate(monitor);
        }

        this.sendEvent({
          type: "pr-cleared",
          worktreeId,
          branchName: data.branchName,
          providerId: data.providerId,
        });
      },
      onIssueDetected: (worktreeId, data) => {
        const monitor = this.monitors.get(worktreeId);
        if (!monitor) return;
        if (
          data.branchName !== undefined &&
          monitor.branch !== undefined &&
          monitor.branch !== data.branchName
        ) {
          return;
        }

        // Keep the private flat issue number in lockstep so the
        // onIssueNotFound guard (`monitor.issueNumber !== issueNumber`)
        // matches forge-resolved issues, not just branch-parsed ones.
        monitor.setIssueNumber(data.issueNumber);
        monitor.setIssueTitle(data.issueTitle);
        if (data.issueLastUpdatedAt !== undefined) {
          monitor.setIssueLastUpdatedAt(data.issueLastUpdatedAt);
        }

        // `linked` is the source of truth — built from the canonical
        // provider/owner/repo carried by the detection event.
        const existingPr = monitor.getSnapshot().linked?.pr;
        const linked = this.composeLinked({
          providerId: data.providerId,
          owner: data.owner,
          repo: data.repo,
          issue: { number: data.issueNumber, title: data.issueTitle },
        });
        // Preserve existing PR linkage if present.
        const finalLinked: PluginWorktreeLinked = existingPr
          ? { ...linked, pr: existingPr }
          : linked;

        monitor.setLinked(finalLinked);

        if (monitor.hasInitialStatus) {
          this.emitUpdate(monitor);
        }

        this.sendEvent({
          type: "issue-detected",
          worktreeId,
          issueNumber: data.issueNumber,
          issueTitle: data.issueTitle,
          issueLastUpdatedAt: data.issueLastUpdatedAt,
          branchName: data.branchName,
          providerId: data.providerId,
          linked: finalLinked,
        });
      },
      onIssueNotFound: (worktreeId, issueNumber) => {
        const monitor = this.monitors.get(worktreeId);
        if (!monitor) return;
        if (monitor.issueNumber !== issueNumber) return;

        // Don't clear monitor.issueNumber: it's the branch-parsed local fact
        // (e.g., `issue-123` in `bugfix/issue-123-foo`). A "not found" from
        // the forge means the issue may be private, deleted, or in another
        // org — none of which invalidates the local number. Keeping it lets
        // the offline branchDerivedTitle stay visible (#8851).
        monitor.setIssueTitle(undefined);

        // Clear the linked.issue projection but preserve any PR linkage
        const snapshot = monitor.getSnapshot();
        const existingLinked = snapshot.linked ?? null;
        if (existingLinked?.issue) {
          monitor.setLinked(
            existingLinked.pr
              ? { providerId: existingLinked.providerId, pr: existingLinked.pr }
              : null
          );
        }

        if (monitor.hasInitialStatus) {
          this.emitUpdate(monitor);
        }

        this.sendEvent({
          type: "issue-not-found",
          worktreeId,
          issueNumber,
        });
      },
      onDetectionStateChanged: (tripped) => {
        this.sendEvent({ type: "pr-detection-state", tripped });
      },
    };
    // Worker instances (DAINTREE_INSTANCE_ROLE=worker) never start the
    // automatic PR polling loop — the UtilityProcess inherits the launch env
    // from main, so the flag is readable here directly (#10123). On-demand
    // refresh and detection wiring stay fully functional.
    const rawInstanceRole = process.env.DAINTREE_INSTANCE_ROLE;
    if (rawInstanceRole && rawInstanceRole !== "worker" && rawInstanceRole !== "attended") {
      console.warn(
        `WorkspaceService: unrecognized DAINTREE_INSTANCE_ROLE "${rawInstanceRole}" — defaulting to attended`
      );
    }
    this.prService = new PRIntegrationService(pullRequestService, events, prCallbacks, {
      isWorker: rawInstanceRole === "worker",
    });

    this.resourceActionExecutor = new ResourceActionExecutor({
      getProjectRootPath: () => this.projectRootPath,
      getMonitor: (id) => this.monitors.get(id),
      getProjectEnvVars: () => this.projectEnvVars,
      emitUpdate: (monitor) => this.emitUpdate(monitor),
      sendEvent: (event) => this.sendEvent(event),
      lifecycleService: this.lifecycleService,
    });

    // The host is a thin live-getter view onto WorkspaceService state.
    // Aliasing `this` keeps the getter syntax compact (object-literal
    // getters can't be arrow functions, and we need a fresh read on each
    // access).
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const topologyHost: TopologyWatcherHost = {
      get pollingEnabled() {
        return self.pollingEnabled;
      },
      get projectRootPath() {
        return self.projectRootPath;
      },
      get activeWorktreeId() {
        return self.activeWorktreeId;
      },
      monitors: this.monitors,
      discoverAndSyncWorktrees: () => this.discoverAndSyncWorktrees(),
      setActiveWorktree: (requestId, worktreeId) => this.setActiveWorktree(requestId, worktreeId),
      sendEvent: (event) => this.sendEvent(event),
    };
    this.topologyWatcher = new TopologyWatcher(topologyHost);
  }

  async loadProject(
    requestId: string,
    projectRootPath: string,
    projectId: string,
    globalEnvVars?: Record<string, string>,
    wslGitByWorktree?: Record<string, { enabled: boolean; dismissed: boolean }>,
    forgeSettings?: {
      forgeProviderOverride: string | null;
      forgeDefaultProviderId: string | null;
      forgeRemote: string | null;
    }
  ): Promise<void> {
    try {
      // E2E-only: hold the load so renderer hydration's worktree prefetch
      // deterministically observes the pre-load window where `get-all-states`
      // answers [] — the boot race behind #11234, which real projects only hit
      // when git enumeration is slow enough to lose to hydration.
      const e2eLoadDelayMs = Number(process.env.DAINTREE_E2E_WORKSPACE_LOAD_DELAY_MS);
      if (process.env.DAINTREE_E2E_MODE === "1" && e2eLoadDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, e2eLoadDelayMs));
      }
      // #10663: bail before any state is set if the project root was deleted
      // or moved externally. Without this guard `createHardenedGit` throws a
      // GitConstructError on the dead path, but `this.projectRootPath` is
      // already set — so the renderer's stats/monitor polling loops keep
      // retrying the dead path and spam WARN logs every tick. Fail fast: the
      // caller emits a `load-project-result` failure that drives the existing
      // "Couldn't load worktrees" banner.
      if (!existsSync(projectRootPath)) {
        throw new Error(`Project directory does not exist: ${projectRootPath}`);
      }
      this.projectRootPath = projectRootPath;
      this.projectId = projectId;
      if (wslGitByWorktree && typeof wslGitByWorktree === "object") {
        // Merge instead of replacing: a `set-wsl-opt-in` message arriving
        // during this load-project's async work would otherwise be silently
        // overwritten. The most recent in-memory value wins on conflict.
        this.wslGitByWorktree = { ...wslGitByWorktree, ...this.wslGitByWorktree };
      }
      if (forgeSettings) {
        this.forgeRemoteName = forgeSettings.forgeRemote;
        pullRequestService.setForgeSettings(forgeSettings);
      }
      // Merge: global (lowest priority) < project-level < DAINTREE_* (set in buildEnv)
      const projectEnvVars = await this.loadProjectEnvVars(projectId);
      this.projectEnvVars = { ...(globalEnvVars ?? {}), ...projectEnvVars };
      this.git = await createHardenedGit(projectRootPath, this._shutdownController.signal);

      // A folder opened without git has no worktrees to enumerate and must never
      // be polled: `getWorktreeChangesWithStats` turns "not a git repository"
      // into a `WorktreeRemovedError`, which `GitStatusPass` reads as an external
      // deletion and answers by removing the workspace from the sidebar. So the
      // gate has to be here — ahead of prune, list, syncMonitors, the topology
      // watcher and forge detection — because the hazard is a monitor *existing*,
      // not a monitor misbehaving (#11405).
      //
      // Probed rather than passed in: the folder is the authority. A project
      // registered as a repository whose `.git` was since deleted reaches this
      // same branch and is spared the self-deletion too, which trusting a
      // persisted flag would not do.
      //
      // Only a *resolved* `false` takes this branch. A probe that could not run
      // throws out to the catch below and reports the load as failed, so an
      // environment fault can no longer masquerade as a folder without a
      // repository (#11922). For the same reason there is no persisted-row
      // sanity check here: a row saying "git-backed" must not override a live
      // `false`, which is exactly the deleted-`.git` case above.
      if (!(await this.isGitRepository())) {
        this.gitBacked = false;
        this.sendEvent({ type: "load-project-result", requestId, success: true });
        return;
      }
      this.gitBacked = true;

      // Backstop for a disabled or silently-degraded git watcher (#11155).
      this.startForgeRemoteDetection();
      this.listService.setGit(this.git, projectRootPath);

      // #6669: prune at startup so externally-deleted worktrees (kept in
      // `worktree list --porcelain` as `prunable` since Git 2.31+) don't
      // re-appear in the sidebar after restart. Best-effort — a prune
      // failure must not block project load.
      try {
        await this.git.raw(["worktree", "prune"]);
      } catch (pruneError) {
        console.warn(
          `[WorkspaceHost] worktree prune at load failed for ${projectRootPath}: ${(pruneError as Error).message}`
        );
      }

      const rawWorktrees = await this.listService.list();
      const worktrees = await this.listService.mapToWorktrees(rawWorktrees);

      await this.syncMonitors(worktrees, this.activeWorktreeId, this.mainBranch, undefined, true);

      await this.topologyWatcher.startWatcher();
      // Started independently of startWatcher() — that method no-ops when
      // `.git/worktrees/` is absent (the exact "all worktrees removed" case),
      // so gating the safety net on it would defeat its purpose (#8510).
      if (this.pollingEnabled) {
        this.topologyWatcher.startSafetyTimer();
      }

      // Bulk self-heal of `wslGitByWorktree` (#9926, review #1). Main ships
      // the *full global* persisted map on `load-project` and the host
      // merges it into its in-memory mirror at the top of this method —
      // by this point, the live worktree set is authoritative (set by
      // `syncMonitors` above). The persisted map is single-instance
      // (electron-store has no per-project key), so without project-scoping
      // this self-heal would erase valid opt-ins for every other project on
      // every load/prewarm/host-restart. The helper restricts the walk to
      // keys whose path is rooted at this project's parent directory;
      // foreign keys stay in the in-memory mirror for the duration of this
      // load and are sent through to main untouched. The next load of the
      // owning project picks them up.
      this.pruneStaleWslGitEntries(worktrees);

      this.sendEvent({ type: "load-project-result", requestId, success: true });

      void Promise.allSettled([this.initializePRService(), this.refreshAll()]).then((results) => {
        const [prResult, refreshResult] = results;
        if (prResult?.status === "rejected") {
          console.warn("[WorkspaceHost] PR service initialization failed:", prResult.reason);
        }
        if (refreshResult?.status === "rejected") {
          console.warn("[WorkspaceHost] Initial worktree refresh failed:", refreshResult.reason);
        }
      });
    } catch (error) {
      // `formatErrorMessage`, not `(error as Error).message`: a non-Error throw
      // put a literal `undefined` in the "Couldn't load worktrees" banner. A
      // `RepositoryProbeError` arrives here already carrying safe copy — its
      // `cause` (simple-git's stack-trace-as-message) stays out of the payload.
      this.sendEvent({
        type: "load-project-result",
        requestId,
        success: false,
        error: formatErrorMessage(error, "Failed to load worktrees"),
      });
    }
  }

  async syncMonitors(
    worktrees: Worktree[],
    activeWorktreeId: string | null,
    mainBranch: string,
    monitorConfig?: MonitorConfig,
    skipInitialGitStatus: boolean = false
  ): Promise<void> {
    // The only place a monitor is ever constructed, and therefore the only
    // place that can arm the self-deletion hazard for a folder with no
    // repository: a monitor's first `GitStatusPass` tick there raises
    // `WorktreeRemovedError`, which the pass answers by removing the workspace.
    // Guarding here rather than only at the callers covers the `sync` host
    // message, which arrives with a caller-supplied worktree list and is
    // fanned out to every live host by `WorkspaceClient.sync` (#11405).
    if (this.gitBacked === false) return;

    // Derive the repository's main/integration branch from the actual main
    // worktree rather than trusting the caller. The legacy `mainBranch`
    // argument is never populated with a real value — internal callers pass
    // the stale field straight back — so base-branch divergence was pinned to
    // "main" for every repo whose integration branch isn't named "main"
    // (e.g. gitflow repos on "develop"). The caller's value stays as the
    // last-resort fallback for a detached-HEAD main worktree.
    this.mainBranch = worktrees.find((wt) => wt.isMainWorktree)?.branch ?? mainBranch;
    this.activeWorktreeId = activeWorktreeId;

    if (monitorConfig?.pollIntervalActive !== undefined) {
      this.pollIntervalActive = monitorConfig.pollIntervalActive;
    }
    if (monitorConfig?.pollIntervalBackground !== undefined) {
      this.pollIntervalBackground = monitorConfig.pollIntervalBackground;
    }
    if (monitorConfig?.adaptiveBackoff !== undefined) {
      this.adaptiveBackoff = monitorConfig.adaptiveBackoff;
    }
    if (monitorConfig?.pollIntervalMax !== undefined) {
      this.pollIntervalMax = monitorConfig.pollIntervalMax;
    }
    if (monitorConfig?.circuitBreakerThreshold !== undefined) {
      this.circuitBreakerThreshold = monitorConfig.circuitBreakerThreshold;
    }
    if (monitorConfig?.gitWatchEnabled !== undefined) {
      this.gitWatchEnabled = monitorConfig.gitWatchEnabled;
    }
    if (monitorConfig?.gitWatchDebounceMs !== undefined) {
      this.gitWatchDebounceMs = monitorConfig.gitWatchDebounceMs;
    }
    if (monitorConfig?.fetchIntervalActiveMs !== undefined) {
      this.fetchIntervalActiveMs = monitorConfig.fetchIntervalActiveMs;
    }
    if (monitorConfig?.fetchIntervalBackgroundMs !== undefined) {
      this.fetchIntervalBackgroundMs = monitorConfig.fetchIntervalBackgroundMs;
    }
    if (monitorConfig?.backgroundGitWatcherCap !== undefined) {
      this.backgroundGitWatcherCap = this.normalizeWatcherCap(
        monitorConfig.backgroundGitWatcherCap
      );
    }

    const currentIds = new Set(worktrees.map((wt) => wt.id));

    // Remove stale monitors. Routed through the `removeMonitor` chokepoint
    // so the persisted WSL git opt-in entry is pruned in lockstep (#9926).
    for (const id of this.monitors.keys()) {
      if (!currentIds.has(id)) {
        this.removeMonitor(id);
      }
    }

    // Create or update monitors. The watcher-budget reconciliation runs in a
    // finally so a mid-loop throw (e.g. a failed stat/note-file write in
    // addNewWorktreeMonitor) still grants the deferred new monitors their
    // watcher and re-asserts the cap, rather than leaving them poll-only until
    // the next sync.
    try {
      for (const wt of worktrees) {
        const existingMonitor = this.monitors.get(wt.id);
        const isActive = wt.id === activeWorktreeId;

        if (existingMonitor) {
          const branchChanged = existingMonitor.branch !== wt.branch;
          const isCurrentChanged = existingMonitor.isCurrent !== isActive;
          existingMonitor.branch = wt.branch;
          existingMonitor.name = wt.name;
          existingMonitor.isCurrent = isActive;
          existingMonitor.isMainWorktree = wt.isMainWorktree ?? false;
          existingMonitor.isExternal = wt.isExternal;
          // Keep the base-branch divergence fallback fresh if the main worktree
          // switched branches since this monitor was created.
          existingMonitor.setMainBranch(this.mainBranch);

          const interval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;
          existingMonitor.updateConfig({
            basePollingInterval: interval,
            adaptiveBackoff: this.adaptiveBackoff,
            pollIntervalMax: this.pollIntervalMax,
            circuitBreakerThreshold: this.circuitBreakerThreshold,
            gitWatchEnabled: this.gitWatchEnabled,
            gitWatchDebounceMs: this.gitWatchDebounceMs,
            fetchIntervalActiveMs: this.throttledFetchActiveMs,
            fetchIntervalBackgroundMs: this.throttledFetchBackgroundMs,
          });

          existingMonitor.ensureWatcherState();

          if (branchChanged && existingMonitor.hasWatcher) {
            existingMonitor.restartWatcherIfRunning();
          }

          // Skip this emit when the branch also changed — the branch-change
          // block below emits the full snapshot (with updated isCurrent and
          // cleared PR) anyway. Emitting here first would surface an
          // intermediate frame carrying the new branch with the old PR (#8079).
          if (isCurrentChanged && !branchChanged && existingMonitor.hasInitialStatus) {
            this.emitUpdate(existingMonitor);
          }

          if (branchChanged && wt.branch) {
            const syncIssueNumber = extractIssueNumberSync(wt.branch, wt.name);
            if (syncIssueNumber) {
              existingMonitor.setIssueNumber(syncIssueNumber);
            } else {
              existingMonitor.setIssueNumber(undefined);
              void this.extractIssueNumberAsync(existingMonitor, wt.branch, wt.name);
            }
            existingMonitor.setIssueTitle(undefined);
            // Bundle the PR clear into this same branch-change emit so the
            // renderer never renders the new branch with the old PR (#8079).
            existingMonitor.clearPRInfo();
            existingMonitor.clearLinked();
            if (existingMonitor.hasInitialStatus) {
              this.emitUpdate(existingMonitor);
            }
          } else if (branchChanged && !wt.branch) {
            existingMonitor.setIssueNumber(undefined);
            existingMonitor.setIssueTitle(undefined);
            existingMonitor.clearPRInfo();
            existingMonitor.clearLinked();
            if (existingMonitor.hasInitialStatus) {
              this.emitUpdate(existingMonitor);
            }
          }
        } else {
          await this.addNewWorktreeMonitor(wt, isActive, skipInitialGitStatus, true);
        }
      }
    } finally {
      // Final reconciliation pass (#9538): enforce the watcher budget after the
      // whole create/update loop. This is the authoritative override of any
      // `ensureWatcherState()` call above that re-armed an evicted background
      // watcher, and the single budget application for the deferred new monitors.
      this.applyWatcherBudget();
    }
  }

  /**
   * Create, configure, and register a monitor for a single worktree.
   *
   * Used by syncMonitors' new-monitor branch AND by createWorktree to install
   * a monitor for a freshly created worktree. Unlike syncMonitors, this does
   * NOT touch any other monitor — which matters for createWorktree, where
   * syncMonitors' remove-stale loop would drop every other non-main monitor
   * because the one-element array is interpreted as the authoritative set.
   *
   * If a monitor already exists for `wt.id`, this is a no-op (race safety for
   * overlapping create/delete on the same path).
   */
  /**
   * Detect whether a worktree is mounted via WSL and, if so, attach the
   * detection metadata + persisted opt-in state. No-op on non-Windows. Bind
   * time only — the result is folded into the `Worktree` passed to
   * `WorktreeMonitor`.
   */
  private async enrichWorktreeWithWsl(wt: Worktree): Promise<Worktree> {
    if (process.platform !== "win32") return wt;
    const detected = detectWslPath(wt.path);
    if (!detected) return wt;

    if (!this.wslDefaultDistroPromise) {
      this.wslDefaultDistroPromise = getDefaultWslDistro().catch(() => null);
    }
    const defaultDistro = await this.wslDefaultDistroPromise;
    // Seed the poller's baseline from the first resolved probe so its first
    // tick compares against a real value (no spurious refresh on a stable box).
    this.wslLastKnownDefaultDistro = defaultDistro;
    // Now that we know a WSL worktree exists, arm the background distro watcher
    // (idempotent — only the first WSL worktree actually starts the interval).
    this.startWslDistroPoller();
    const eligibility = this.computeWslEligibility(detected.distro, defaultDistro);
    const persisted = this.wslGitByWorktree[wt.id];

    return {
      ...wt,
      isWslPath: true,
      wslDistro: detected.distro,
      wslPosixPath: detected.posixPath,
      wslGitEligible: eligibility,
      wslGitOptIn: Boolean(persisted?.enabled),
      wslGitDismissed: Boolean(persisted?.dismissed),
    };
  }

  /**
   * Compute three-state WSL git eligibility for a worktree distro against the
   * current default distro. `null` default (probe failed / WSL absent) maps to
   * `'unprobed'` rather than `'ineligible'` so the renderer can offer a
   * re-check instead of a wrong "git runs via Windows" note. UNC paths are
   * case-insensitive on Windows and `wsl --list --verbose` returns canonical
   * case (e.g. "Ubuntu"), so compare case-insensitively.
   */
  private computeWslEligibility(
    distro: string | undefined,
    defaultDistro: string | null
  ): WslGitEligibility {
    if (!distro || defaultDistro === null) return "unprobed";
    return defaultDistro.toLowerCase() === distro.toLowerCase() ? "eligible" : "ineligible";
  }

  /**
   * Arm the Windows-only background watcher that re-checks the WSL default
   * distro. The default distro can change mid-session (`wsl --set-default`,
   * install/uninstall) and the renderer has no OS event to subscribe to, so we
   * poll. Idempotent — a second call while already running is a no-op.
   */
  private startWslDistroPoller(): void {
    if (process.platform !== "win32") return;
    if (this.wslDistroPoller) return;
    this.wslDistroPoller = setInterval(() => {
      void this.pollWslDefaultDistro();
    }, WorkspaceService.WSL_DISTRO_POLL_INTERVAL_MS);
    // Don't keep the host process alive solely for this poll.
    this.wslDistroPoller.unref?.();
  }

  /** Stop the WSL distro watcher (project switch / dispose). */
  private stopWslDistroPoller(): void {
    // Bump the sequence so any in-flight probe (poll or reprobe) sees itself
    // superseded and bails before mutating state — otherwise a probe awaiting
    // across a project switch could refresh the next project's monitors with
    // this project's distro.
    this.wslProbeSeq++;
    if (this.wslDistroPoller) {
      clearInterval(this.wslDistroPoller);
      this.wslDistroPoller = null;
    }
  }

  /**
   * Probe the default distro under a sequence guard. Returns whether this probe
   * is still the most recent one — a later probe (concurrent reprobe, or a
   * project switch via `stopWslDistroPoller`) supersedes an earlier one so the
   * stale result is discarded rather than overwriting fresher state.
   */
  private async probeDefaultDistro(): Promise<{ distro: string | null; current: boolean }> {
    const seq = ++this.wslProbeSeq;
    const distro = await getDefaultWslDistro().catch(() => null);
    return { distro, current: seq === this.wslProbeSeq };
  }

  /** Commit a fresh probe result to the cache and fan it out to all monitors. */
  private applyDefaultDistro(distro: string | null): void {
    this.wslLastKnownDefaultDistro = distro;
    this.wslDefaultDistroPromise = Promise.resolve(distro);
    this.refreshWslEligibilityForAllMonitors(distro);
  }

  /**
   * One poll tick: re-probe the default distro and, when it changed, invalidate
   * the cache and refresh every WSL monitor's eligibility so existing worktrees
   * stop using a stale decision.
   */
  private async pollWslDefaultDistro(): Promise<void> {
    const { distro, current } = await this.probeDefaultDistro();
    if (!current) return;
    if (distro === this.wslLastKnownDefaultDistro) return;
    this.applyDefaultDistro(distro);
  }

  /**
   * Recompute and push WSL git eligibility to every active WSL monitor against
   * the given default distro. Non-WSL monitors are skipped.
   */
  private refreshWslEligibilityForAllMonitors(defaultDistro: string | null): void {
    for (const monitor of this.monitors.values()) {
      if (!monitor.isWslPath) continue;
      monitor.setWslEligible(this.computeWslEligibility(monitor.wslDistro, defaultDistro));
    }
  }

  /**
   * Re-probe the WSL default distro on demand (renderer "Re-check" button) and
   * refresh all WSL monitors. Sets the target monitor to `'unprobed'` first so
   * the banner shows a pending state while the probe runs. The probe is shared
   * across all worktrees, so we refresh every WSL monitor, not just the target.
   */
  async reprobeWslForWorktree(worktreeId: string): Promise<void> {
    if (process.platform !== "win32") return;
    const monitor = this.monitors.get(worktreeId);
    if (!monitor || !monitor.isWslPath) return;
    monitor.setWslEligible("unprobed");
    const { distro, current } = await this.probeDefaultDistro();
    if (!current) return;
    this.applyDefaultDistro(distro);
  }

  /**
   * Update WSL git routing state for a single worktree. Persists the new
   * preference into the in-memory map and forwards to the matching monitor
   * (which re-emits its snapshot). Called by the workspace-host message
   * handler in response to renderer-driven IPC.
   */
  setWslOptIn(worktreeId: string, enabled: boolean, dismissed: boolean): void {
    this.wslGitByWorktree[worktreeId] = { enabled, dismissed };
    const monitor = this.monitors.get(worktreeId);
    if (monitor) {
      monitor.setWslOptIn(enabled, dismissed);
    }
  }

  /**
   * Single chokepoint for monitor removal (#9926). Drops the monitor from the
   * in-memory map, the LRU, the active-worktree pointer, and the
   * WSL-git opt-in cache; tells main to drop the matching persistent entry;
   * emits `worktree-removed`. Replaces the three inline removal sites in
   * `syncMonitors`, the external-removal handler, and `deleteWorktree` so the
   * persisted map can never leak stale opt-in flags through a path-reuse
   * (`git worktree remove` + recreate at the same UNC path).
   *
   * Caller is responsible for any monitor-specific cleanup (cache
   * invalidation, `applyWatcherBudget`, `topologyWatcher.clearPending`) that
   * runs before/after this — see the three call sites for the exact ordering
   * they preserve.
   */
  private removeMonitor(id: string): void {
    const monitor = this.monitors.get(id);
    if (!monitor) return;
    if (monitor.isMainWorktree) {
      console.warn("[WorkspaceHost] Blocked removal of main worktree monitor");
      return;
    }

    if (this.activeWorktreeId === id) {
      this.activeWorktreeId = null;
    }

    this.resourceActionExecutor.cleanupResourceActionState(id);
    monitor.stop();
    this.monitors.delete(id);
    this.lruRemove(id);
    // Drop the agent-active flag with the monitor — a same-path worktree
    // recreated later must not inherit a stale elevation. The renderer's
    // next broadcast re-adds it if an agent really is working there.
    this.agentActiveWorktreeIds.delete(id);
    this.recoverWatcherIfNoMonitorsRemain();

    clearGitDirCache(monitor.path);
    clearGitCommonDirCache(monitor.path);
    invalidateGitStatusCache(monitor.path);

    // Drop the in-memory wsl-git opt-in entry (keyed by monitor.id, matching
    // the lookup shape used by `enrichWorktreeWithWsl`) and tell main to
    // drop the persistent one. Idempotent on the main side: `clearWslGitEntry`
    // is a no-op if the key is missing, and does a case-insensitive lookup
    // on win32 to handle legacy mixed-case persisted keys.
    if (Object.prototype.hasOwnProperty.call(this.wslGitByWorktree, monitor.id)) {
      delete this.wslGitByWorktree[monitor.id];
      this.sendEvent({
        type: "clear-wsl-git-opt-in",
        worktreeId: monitor.id,
      });
    }

    this.sendEvent({
      type: "worktree-removed",
      worktreeId: monitor.id,
      epoch: this.epoch,
      seq: this.nextSeq(),
    });
    events.emit("sys:worktree:remove", { worktreeId: monitor.id, timestamp: Date.now() });
  }

  /**
   * Bulk self-heal of `wslGitByWorktree` after `loadProject` lands the live
   * worktree set (#9926, review #1). Walks the in-memory mirror and emits
   * one `clear-wsl-git-opt-in` per key that (a) is not in the live set AND
   * (b) is rooted under this project's parent directory. Foreign-project
   * keys are left in the in-memory mirror for the duration of this load
   * and never reach main — otherwise loading project A would silently
   * erase project B's valid opt-ins from the global persisted map on every
   * load/prewarm/host-restart. The next load of the owning project picks
   * the foreign keys up and prunes them on that cycle.
   */
  private pruneStaleWslGitEntries(worktrees: Worktree[]): void {
    const projectParent = this.projectRootPath ? pathParentForPrefix(this.projectRootPath) : null;
    const projectRoot = this.projectRootPath
      ? normalizePathKeyForPrefix(this.projectRootPath)
      : null;
    const liveIds = new Set(worktrees.map((wt) => wt.id));
    for (const key of Object.keys(this.wslGitByWorktree)) {
      if (liveIds.has(key)) continue;
      if (
        projectParent &&
        normalizePathKeyForPrefix(key) !== projectRoot &&
        !isPathKeyAtOrUnder(key, projectParent)
      ) {
        continue;
      }
      delete this.wslGitByWorktree[key];
      this.sendEvent({
        type: "clear-wsl-git-opt-in",
        worktreeId: key,
      });
    }
  }

  // --- Background git-watcher budget (LRU) ---

  /** Clamp a requested cap to a non-negative integer, ignoring junk values. */
  private normalizeWatcherCap(value: number): number {
    if (!Number.isFinite(value)) return this.backgroundGitWatcherCap;
    return Math.max(0, Math.floor(value));
  }

  /** Move (or insert) a background worktree id to the MRU end of the LRU. */
  private lruTouch(worktreeId: string): void {
    this.backgroundGitWatcherLru.delete(worktreeId);
    this.backgroundGitWatcherLru.set(worktreeId, true);
  }

  /** Drop a worktree id from the LRU (active-focus, removal, dispose). */
  private lruRemove(worktreeId: string): void {
    this.backgroundGitWatcherLru.delete(worktreeId);
  }

  /**
   * Enforce the background watcher budget across every monitor. The focused
   * worktree always keeps its watcher (excluded from the cap). Background
   * monitors are granted a watcher for the `cap` most-recently-focused entries
   * (LRU tail) and evicted otherwise — evicted monitors stop their watcher and
   * fall back to adaptive polling.
   *
   * Revocations run before grants so freed inotify/fd handles are released
   * before any new watcher arms, keeping the live handle count bounded by the
   * cap even mid-reconcile. Idempotent: `setGitWatchBudgetAllowed` is a no-op
   * when the flag is unchanged, so repeated calls don't churn watchers.
   *
   * Also the single reconciliation point that overrides `ensureWatcherState()`
   * re-arming an evicted watcher during `syncMonitors` (#9538 pitfall): it must
   * run AFTER any sync/focus mutation that could re-arm watchers.
   */
  private applyWatcherBudget(): void {
    // Reconcile LRU membership against live monitors: the active worktree and
    // agent-active worktrees must never be in the pool; every other running
    // monitor must be present.
    for (const id of [...this.backgroundGitWatcherLru.keys()]) {
      if (
        !this.monitors.has(id) ||
        id === this.activeWorktreeId ||
        this.agentActiveWorktreeIds.has(id)
      ) {
        this.backgroundGitWatcherLru.delete(id);
      }
    }
    for (const id of this.monitors.keys()) {
      if (
        id !== this.activeWorktreeId &&
        !this.agentActiveWorktreeIds.has(id) &&
        !this.backgroundGitWatcherLru.has(id)
      ) {
        this.backgroundGitWatcherLru.set(id, true);
      }
    }

    const ids = [...this.backgroundGitWatcherLru.keys()]; // LRU → MRU
    const cap = this.backgroundGitWatcherCap;
    const cutoff = Math.max(0, ids.length - cap);

    // Evict the oldest (head) entries beyond the cap first to free handles.
    for (let i = 0; i < cutoff; i++) {
      this.monitors.get(ids[i])?.setGitWatchBudgetAllowed(false);
    }
    // The focused worktree always keeps its watcher.
    if (this.activeWorktreeId) {
      this.monitors.get(this.activeWorktreeId)?.setGitWatchBudgetAllowed(true);
    }
    // Worktrees with an actively working agent always keep theirs too —
    // streaming those changes is the product's core loop; the watcher-failure
    // degradation path (ENOSPC/EMFILE → git-only) bounds the worst case.
    for (const id of this.agentActiveWorktreeIds) {
      this.monitors.get(id)?.setGitWatchBudgetAllowed(true);
    }
    // Grant the surviving MRU tail.
    for (let i = cutoff; i < ids.length; i++) {
      this.monitors.get(ids[i])?.setGitWatchBudgetAllowed(true);
    }
  }

  /**
   * Applies the renderer's agent-activity broadcast: the set of worktree IDs
   * that currently have an agent producing work (working/directing). Elevates
   * matching monitors to the recursive watcher tier (see
   * `WorktreeMonitor.agentActive`) and re-runs the watcher budget so they are
   * exempted from background eviction. The set is retained so monitors
   * created later — including worktrees the agent itself just created —
   * inherit the flag before their watcher first arms.
   */
  setAgentActivity(worktreeIds: string[]): void {
    // Port payloads are typed but not runtime-validated; a malformed request
    // must not silently clear every elevation (`new Set(undefined)` is empty).
    if (!Array.isArray(worktreeIds)) return;
    const next = new Set(worktreeIds.filter((id): id is string => typeof id === "string"));
    const previous = this.agentActiveWorktreeIds;
    this.agentActiveWorktreeIds = next;

    let membershipChanged = false;
    for (const [id, monitor] of this.monitors) {
      const active = next.has(id);
      if (monitor.agentActive !== active) {
        monitor.agentActive = active;
        membershipChanged = true;
      }
    }
    // A worktree that left the set re-enters the LRU pool at the MRU tail
    // (freshest) via applyWatcherBudget's membership reconcile, and newly
    // active ones leave it — either way the budget must be re-enforced.
    if (membershipChanged || previous.size !== next.size) {
      this.applyWatcherBudget();
    }
  }

  private async addNewWorktreeMonitor(
    wt: Worktree,
    isActive: boolean,
    skipInitialGitStatus: boolean,
    deferWatcherBudget: boolean = false
  ): Promise<void> {
    if (this.monitors.has(wt.id)) {
      return;
    }

    const enrichedWt = await this.enrichWorktreeWithWsl(wt);
    wt = enrichedWt;

    await ensureNoteFile(wt.path);
    const issueNumber = wt.branch ? extractIssueNumberSync(wt.branch, wt.name) : null;
    const interval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;

    let createdAt: number | undefined;
    try {
      const stats = await stat(wt.path);
      createdAt = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.ctimeMs;
    } catch {
      // If stat fails, leave undefined
    }

    const monitor = new WorktreeMonitor(
      { ...wt, isCurrent: isActive },
      {
        basePollingInterval: interval,
        adaptiveBackoff: this.adaptiveBackoff,
        pollIntervalMax: this.pollIntervalMax,
        circuitBreakerThreshold: this.circuitBreakerThreshold,
        gitWatchEnabled: this.gitWatchEnabled,
        gitWatchDebounceMs: this.gitWatchDebounceMs,
        fetchIntervalActiveMs: this.throttledFetchActiveMs,
        fetchIntervalBackgroundMs: this.throttledFetchBackgroundMs,
      },
      {
        onUpdate: (snapshot) => {
          this.handleMonitorUpdate(monitor, snapshot);
        },
        onRemoved: (worktreeId) => {
          this.handleExternalWorktreeRemoval(worktreeId);
        },
        onExternalRemoval: (worktreeId) => {
          this.handleExternalWorktreeRemoval(worktreeId);
        },
        onResourceStatusPoll: (worktreeId) => {
          return this.runResourceAction(
            `auto-status-${worktreeId}`,
            worktreeId,
            "status",
            undefined,
            { origin: "auto-poll" }
          );
        },
        onInotifyLimitReached: () => this.handleInotifyLimitReached(),
        onEmfileLimitReached: () => this.handleEmfileLimitReached(),
        onWatcherRecovered: () => this.handleWatcherRecovered(),
        onGitConfigChanged: () => this.scheduleForgeRemoteReprobe({ observedConfigWrite: true }),
        onScheduleFetch: async (worktreeId, _isCurrent, force) => {
          const target = this.monitors.get(worktreeId);
          if (!target || !target.isRunning) return;
          const { remotes, primaryRemote } = planFetchRemotes({
            baseRemote: target.baseRemote,
            availableRemotes: target.availableRemotes,
          });
          const result = await this.fetchCoordinator.fetchForWorktree({
            worktreeId,
            worktreePath: target.path,
            force,
            remotes,
            primaryRemote,
          });
          // Skipped for "no-common-dir" (e.g. path was just removed) means we
          // have no commondir to fan out on — bail.
          if (
            result.lastFetchedAt === undefined &&
            result.authFailed === undefined &&
            result.networkFailed === undefined
          ) {
            return;
          }
          await this.applyFetchResultToSiblings(target, {
            lastFetchedAt: result.lastFetchedAt ?? null,
            authFailed: result.authFailed ?? false,
            networkFailed: result.networkFailed ?? false,
            remote: result.remote,
          });
        },
      },
      this.mainBranch,
      this.pollQueue
    );

    monitor.setIssueNumber(issueNumber ?? undefined);
    monitor.setCreatedAt(createdAt);

    // Withhold the watcher budget from a new *background* monitor before it
    // starts so start() never arms a watcher we may be about to evict — this
    // bounds the cold-start handle peak to the cap instead of O(N). The active
    // worktree keeps the default-granted budget (it's excluded from the cap).
    // applyWatcherBudget() below grants the surviving MRU tail (evicting the
    // oldest if this push spilled over the cap).
    if (!isActive) {
      monitor.setGitWatchBudgetAllowed(false);
    }

    // Inherit the agent-activity flag before start so a worktree the agent
    // just created (its monitor arriving via topology reconcile after the
    // renderer's broadcast) arms the recursive watcher and runs its initial
    // status immediately, instead of starting as a cold background monitor.
    if (this.agentActiveWorktreeIds.has(wt.id)) {
      monitor.agentActive = true;
      monitor.setGitWatchBudgetAllowed(true);
    }

    this.monitors.set(wt.id, monitor);

    if (isActive || this.agentActiveWorktreeIds.has(wt.id)) {
      this.lruRemove(wt.id);
    } else {
      this.lruTouch(wt.id);
    }
    // syncMonitors batches a single applyWatcherBudget() after its whole loop
    // (deferWatcherBudget) to avoid O(N²) reconciliation across a cold start.
    if (!deferWatcherBudget) {
      this.applyWatcherBudget();
    }

    if (skipInitialGitStatus) {
      monitor.startWithoutGitStatus();
    } else {
      await monitor.start();
    }

    if (wt.branch && !issueNumber) {
      void this.extractIssueNumberAsync(monitor, wt.branch, wt.name);
    }

    void (async () => {
      await this.initResourceConfigAsync(monitor, wt.path);
      // Emit a secondary update if config was loaded and monitor is running.
      // This ensures the renderer receives the resource config metadata even when
      // initResourceConfigAsync completes after the initial snapshot was emitted.
      if (monitor.isRunning && monitor.hasResourceConfig) {
        this.emitUpdate(monitor);
      }
    })();

    // Resolve origin → registered forge provider at monitor start. Setter
    // re-emits the snapshot only if the value differs from the initial `null`,
    // so this is a no-op for repos no registered provider matches.
    void this.probeForgeRemoteAsync(monitor);
  }

  private async initResourceConfigAsync(
    monitor: WorktreeMonitor,
    worktreePath: string
  ): Promise<void> {
    try {
      if (!this.projectRootPath) return;
      const config = await this.lifecycleService.loadConfig(worktreePath, this.projectRootPath);
      let resourceConfig = config?.resource;
      if (config?.resources) {
        const envKey = monitor.worktreeMode;
        if (envKey && config.resources[envKey]) {
          resourceConfig = config.resources[envKey];
        } else if (config.resources["default"]) {
          resourceConfig = config.resources["default"];
        } else {
          const keys = Object.keys(config.resources);
          if (keys.length > 0) resourceConfig = config.resources[keys[0]];
        }
      }
      if (!resourceConfig) {
        const envs = await this.lifecycleService.loadProjectResourceEnvironments(
          this.projectRootPath
        );
        if (envs) {
          const envKey = monitor.worktreeMode;
          if (envKey && envKey !== "local" && envs[envKey]) {
            resourceConfig = envs[envKey];
          } else {
            const keys = Object.keys(envs);
            if (keys.length > 0) resourceConfig = envs[keys[0]];
          }
        }
      }
      if (!resourceConfig) return;

      // Cache resource config metadata regardless of monitor.isRunning state.
      // This ensures the UI shows the Resource submenu even during cold start
      // before the monitor begins polling. Runtime behavior (emits, polling)
      // is still guarded by isRunning below.
      const vars = this.lifecycleService.buildVariables(
        worktreePath,
        this.projectRootPath,
        monitor.name,
        monitor.branch
      );
      const sub = (cmd: string) => this.lifecycleService.substituteVariables(cmd, vars);
      applyResourceConfigToMonitor(monitor, resourceConfig, sub);

      // Runtime behavior (emits, polling) requires monitor.isRunning
      if (!monitor.isRunning) return;

      if (monitor.hasInitialStatus) {
        this.emitUpdate(monitor);
      }
    } catch (error) {
      console.warn(
        "[WorkspaceHost] Resource config initialization failed (continuing without resources):",
        formatErrorMessage(error, "Resource config initialization failed")
      );
    }
  }

  private async extractIssueNumberAsync(
    monitor: WorktreeMonitor,
    branchName: string,
    folderName?: string
  ): Promise<void> {
    try {
      const issueNumber = await extractIssueNumber(branchName, folderName);
      if (issueNumber && monitor.isRunning && monitor.branch === branchName) {
        monitor.setIssueNumber(issueNumber);
        if (monitor.hasInitialStatus) {
          this.emitUpdate(monitor);
        }
      }
    } catch {
      // Silently ignore extraction errors
    }
  }

  private handleMonitorUpdate(_monitor: WorktreeMonitor, snapshot: WorktreeSnapshot): void {
    this.sendEvent({
      type: "worktree-update",
      worktree: snapshot,
      epoch: this.epoch,
      seq: this.nextSeq(),
    });
    events.emit("sys:worktree:update", snapshot);
  }

  /**
   * Build the provider-agnostic `linked` projection from canonical
   * provider/owner/repo carried by detection events. This is the single
   * construction point — callers must never synthesize a {@link ResourceRef}
   * with empty `owner`/`repo` (the #8452 anti-pattern).
   */
  private composeLinked(params: {
    providerId: string;
    owner: string;
    repo: string;
    pr?: {
      number: number;
      title?: string;
      url: string;
      state: NormalizedPRState;
      ciStatus?: CIStatus;
      baseRef?: string;
    };
    issue?: { number: number; title?: string };
  }): PluginWorktreeLinked {
    const { providerId, owner, repo } = params;
    const linked: {
      providerId: string;
      pr?: PluginWorktreeLinkedPR;
      issue?: PluginWorktreeLinkedIssue;
    } = { providerId };

    if (params.pr) {
      linked.pr = {
        ref: { providerId, owner, repo, number: params.pr.number, rawData: null },
        title: params.pr.title,
        url: params.pr.url,
        state: params.pr.state,
        ...(params.pr.ciStatus ? { ciStatus: params.pr.ciStatus } : {}),
        ...(params.pr.baseRef ? { baseRef: params.pr.baseRef } : {}),
      };
    }
    if (params.issue) {
      linked.issue = {
        ref: { providerId, owner, repo, number: params.issue.number, rawData: null },
        title: params.issue.title,
      };
    }
    return linked;
  }

  private emitUpdate(monitor: WorktreeMonitor): void {
    const snapshot = monitor.getSnapshot();
    this.sendEvent({
      type: "worktree-update",
      worktree: snapshot,
      epoch: this.epoch,
      seq: this.nextSeq(),
    });
    events.emit("sys:worktree:update", snapshot);
  }

  /**
   * Fan a coordinator-level fetch result out to every monitor sharing the same
   * `git common-dir`. Linked worktrees back the same `.git/objects`, so a
   * single `git fetch origin` updates upstream refs for all of them — and the
   * coordinator's per-commondir `lastSuccessfulFetch` and auth-failure state
   * apply uniformly. Without this fan-out, only the worktree that triggered
   * the fetch would surface "Last fetched X ago"; sibling cards would still
   * show stale (or absent) timestamps.
   *
   * `getGitCommonDir` resolutions are cached, so the O(n) scan is cheap
   * after the first call per worktree.
   *
   * Note: `isFetchInFlight` is intentionally excluded from this fan-out —
   * propagating per-monitor in-flight state to N sibling rows would produce
   * simultaneous pulse animations across the sidebar, recreating the visual
   * fatigue pattern that drove removal of the `panel-state-working` breathe
   * loop. Only the row that triggered the fetch shows the in-flight pulse.
   */
  private async applyFetchResultToSiblings(
    triggering: WorktreeMonitor,
    result: {
      lastFetchedAt: number | null;
      authFailed: boolean;
      networkFailed: boolean;
      /**
       * Remote the result describes. A sibling only adopts it when that is the
       * remote the sibling's own counts depend on — see the fan-out note below.
       */
      remote: string | undefined;
    }
  ): Promise<void> {
    const triggeringCommonDir = await getGitCommonDir(triggering.path, { logErrors: false });
    if (!triggeringCommonDir) {
      // Without a commondir we can't identify siblings. Apply to the
      // triggering monitor only — its own card still benefits.
      triggering.setFetchState(result.lastFetchedAt, result.authFailed, result.networkFailed);
      return;
    }
    for (const monitor of this.monitors.values()) {
      if (!monitor.isRunning) continue;
      const monitorCommonDir = await getGitCommonDir(monitor.path, { logErrors: false });
      if (monitorCommonDir !== triggeringCommonDir) continue;
      // Sharing a commondir no longer implies sharing a fetch outcome. Once a
      // repo refreshes more than one remote, a sibling measuring against
      // `upstream` must not be stamped fresh by an `origin` success, nor
      // marked failed by an `upstream` failure it doesn't read — whichever
      // remote finished last would otherwise win across every card, hiding the
      // stale behind-count this issue exists to fix.
      // The monitor that asked for this fetch always adopts the answer: the
      // fetch was planned from its own resolution, and a poll landing mid-fetch
      // could otherwise re-plan it into never accepting the result it asked for.
      const isTriggering = monitor.id === triggering.id;
      if (
        !isTriggering &&
        result.remote !== undefined &&
        dependsOnRemote(monitor) !== result.remote
      )
        continue;
      monitor.setFetchState(result.lastFetchedAt, result.authFailed, result.networkFailed);
    }
  }

  /**
   * Force a fresh git-status pass after a real fetch completes (#11151). One
   * `git fetch origin` advances upstream refs for every linked worktree sharing
   * the object store, but a fetch triggered by one worktree (e.g. the focused
   * feature worktree) would only re-poll that worktree — leaving the main
   * worktree, whose behind-count feeds the forge-count auto-recheck, on a stale
   * count until its own slower background tier.
   *
   * Refreshes the triggering worktree (as the prior single-monitor call did)
   * plus the main worktree — and *only* those two. Fanning out to every
   * common-dir sibling would turn one fetch on a many-worktree repo into an
   * N-way `git status` storm (these passes run outside the poll queue), so the
   * fan-out is deliberately bounded to the one sibling the toolbar reads from.
   *
   * Only invoked from `onFetchSuccess` (a genuine completed fetch), never from
   * the recency-cache/skip paths, so it can't fan status work out on a no-op.
   */
  private async refreshStatusForFetchSiblings(triggeringWorktreeId: string): Promise<void> {
    const triggering = this.monitors.get(triggeringWorktreeId);
    if (!triggering || !triggering.isRunning) return;
    // The triggering worktree's own counts are freshest to it — refresh it
    // first, matching the single-monitor behaviour this replaced.
    triggering.triggerRefreshIfUpdating();

    // Find the main worktree; skip when it's the trigger (already refreshed) or
    // not running.
    let mainWorktree: WorktreeMonitor | undefined;
    for (const monitor of this.monitors.values()) {
      if (monitor.isMainWorktree && monitor !== triggering) {
        mainWorktree = monitor;
        break;
      }
    }
    if (!mainWorktree || !mainWorktree.isRunning) return;

    // Only refresh the main worktree if it shares the fetched repo's common dir
    // (linked worktree of the same repo). Re-check `isRunning` after the awaits:
    // the monitor can be stopped/removed while the commondir resolutions are
    // pending.
    const [triggeringCommonDir, mainCommonDir] = await Promise.all([
      getGitCommonDir(triggering.path, { logErrors: false }),
      getGitCommonDir(mainWorktree.path, { logErrors: false }),
    ]);
    if (triggeringCommonDir && mainCommonDir === triggeringCommonDir && mainWorktree.isRunning) {
      mainWorktree.triggerRefreshIfUpdating();
    }
  }

  /**
   * Read the repo's remote table once. Returns the selected remote's fetch URL
   * plus a stable signature of every name→fetch-URL pair, used to tell
   * a real remote change from an unrelated `.git/config` write. The signature
   * stays in this process — remote URLs can carry embedded credentials.
   */
  private async readForgeRemotes(
    cwd: string
  ): Promise<{ fetchUrl: string | undefined; signature: string } | null> {
    try {
      const git = await createHardenedGit(cwd);
      const remotes = await git.getRemotes(true);
      const signature = remotes
        .map((remote) => `${remote.name} ${remote.refs?.fetch ?? ""}`)
        .sort()
        .join("");
      // Selection honours the project's `forgeRemote` setting (#11408). The
      // signature above deliberately still covers ALL remotes: it answers "did
      // the remote table change", independent of which entry we route through.
      // A configured-but-missing remote selects nothing, leaving the
      // affordance hidden rather than silently probing a different repo.
      const { remote: selected } = resolveForgeRemote({
        remotes: remotes.map((r) => ({ name: r.name, fetchUrl: r.refs?.fetch ?? "" })),
        forgeRemote: this.forgeRemoteName,
        // The host has no provider registry — it matches against the matcher
        // table main relays via `setForgeProviderMatchers`.
        isSupportedRemote: (url) =>
          matchProviderForRemoteUrl(url, this.forgeProviderMatchers) !== null,
      });
      return { fetchUrl: selected?.fetchUrl, signature };
    } catch {
      // Remote probe is best-effort; keep the affordance hidden on failure.
      return null;
    }
  }

  /**
   * Probe origin's fetch URL once at monitor start, remember it on the
   * monitor, and resolve it against the relayed provider-matcher table. Runs
   * off the critical path — failures are silent (the affordance simply stays
   * hidden, which matches the unmatched-remote behavior). The remembered URL
   * lets `setForgeProviderMatchers` re-match without re-probing git.
   */
  private async probeForgeRemoteAsync(monitor: WorktreeMonitor): Promise<void> {
    const probed = await this.readForgeRemotes(monitor.path);
    if (!probed) return;
    monitor.setRemoteFetchUrl(probed.fetchUrl);
    monitor.setMatchedForgeProviderId(
      probed.fetchUrl
        ? matchProviderForRemoteUrl(probed.fetchUrl, this.forgeProviderMatchers)
        : null
    );
    // Deliberately does NOT seed `forgeRemoteSignature`. A monitor start probe
    // races the user: it can complete AFTER a `git remote add` and would then
    // record the post-change remotes as the "before" baseline, leaving the
    // reprobe with an equal signature and nothing to emit — the toolbar would
    // stay stale for exactly the case this feature exists to catch. The
    // baseline is seeded once at load instead (`startForgeRemoteDetection`).
  }

  /**
   * A worktree's `.git/config` was written. Remotes are repo-level, so every
   * sibling worktree reports the same write (and git writes config as
   * lock-then-rename) — a trailing debounce collapses the burst into one probe.
   */
  private scheduleForgeRemoteReprobe(opts: { observedConfigWrite: boolean }): void {
    if (this._shutdownController.signal.aborted) return;
    // Bump on a real observed write even when a reprobe is already pending: it
    // marks an in-flight baseline seed as spanning the write, so it can't record
    // a snapshot that already absorbed the change. The backstop tick observes
    // nothing, so it must not invalidate the seed.
    if (opts.observedConfigWrite) this.forgeConfigEpoch++;
    if (this.forgeRemoteReprobeTimer) return;
    this.forgeRemoteReprobeTimer = setTimeout(() => {
      this.forgeRemoteReprobeTimer = null;
      void this.reprobeForgeRemoteAsync();
    }, FORGE_REMOTE_REPROBE_DEBOUNCE_MS);
  }

  /**
   * Re-read the repo's remotes after a `.git/config` write and, when the remote
   * table actually changed, re-resolve every monitor's forge affordance and
   * signal both the in-process PR poller and the renderer (#11155). An
   * unchanged signature emits nothing — that restraint is what keeps
   * `PullRequestService`'s no-match pause (#9997) meaningful, since the same
   * config file is written by `git push -u` on every first push.
   */
  private async reprobeForgeRemoteAsync(): Promise<void> {
    const cwd = this.forgeProbeCwd();
    if (!cwd) return;
    const seq = ++this.forgeRemoteProbeSeq;

    // Cheap gate in front of the subprocess. Two callers land here — the git
    // watcher and the 5-minute backstop — and neither proves the remotes moved:
    // `fs.watch` may report a change with NO filename (so we conservatively
    // assume config), and the backstop fires on a timer. Without this gate a
    // repo emitting unnamed `.git/` events would spawn `git remote` every
    // debounce window.
    //
    // Safe to gate on, because git writes `.git/config` lock-then-rename — a
    // real `git remote add/set-url/remove` ALWAYS lands a new inode, so it can
    // never be mistaken for "unchanged". Stat failure fails open (probe anyway).
    const fingerprint = await this.readForgeConfigFingerprint();
    if (seq !== this.forgeRemoteProbeSeq) return;
    if (fingerprint !== null && fingerprint === this.forgeConfigFingerprint) return;

    const probed = await this.readForgeRemotes(cwd);
    // A dispose (or a newer probe) landed while git ran: the monitors this one
    // would touch may already be stopped, and its read is no longer the truth.
    if (!probed || seq !== this.forgeRemoteProbeSeq) return;
    if (this._shutdownController.signal.aborted) return;

    // Consume the fingerprint only now that this probe has actually READ the
    // remotes that go with it. Recording it up front (before the git read) loses
    // changes two ways: a superseding probe would see the fingerprint already
    // consumed and bail while the superseded probe dies on the seq check, and a
    // transient git failure would leave the change permanently marked as seen.
    this.forgeConfigFingerprint = fingerprint;

    const matchedProviderId = probed.fetchUrl
      ? matchProviderForRemoteUrl(probed.fetchUrl, this.forgeProviderMatchers)
      : null;
    for (const monitor of this.monitors.values()) {
      if (!monitor.isRunning) continue;
      monitor.setRemoteFetchUrl(probed.fetchUrl);
      monitor.setMatchedForgeProviderId(matchedProviderId);
    }

    if (probed.signature === this.forgeRemoteSignature) return;
    this.forgeRemoteSignature = probed.signature;

    // In-process: releases PullRequestService's sticky "no-match" pause so the
    // per-worktree PR badges resolve against the new remote.
    events.emit("sys:forge:remote-changed", { timestamp: Date.now() });
    // Cross-process: main relays this to the renderer, which drops its cached
    // provider resolution and re-runs the full precedence chain (per-project
    // override → global default → hostname match).
    this.sendEvent({ type: "forge-remote-changed" });
  }

  /**
   * Any running monitor resolves the same remotes — they share one common dir.
   * Prefer the main worktree (longest-lived), then any running monitor, then
   * the project root for the window between load and the first monitor start.
   */
  private forgeProbeCwd(): string | null {
    for (const monitor of this.monitors.values()) {
      if (monitor.isRunning && monitor.isMainWorktree) return monitor.path;
    }
    for (const monitor of this.monitors.values()) {
      if (monitor.isRunning) return monitor.path;
    }
    return this.projectRootPath;
  }

  /**
   * Identity fingerprint of `<commonDir>/config`, or null when it can't be read.
   * Includes the inode: git writes config lock-then-rename, so every real
   * `git remote` mutation lands a NEW inode. That makes the fingerprint a
   * trustworthy "did this file actually change" gate even on filesystems whose
   * timestamp granularity is too coarse to catch a same-size rewrite.
   */
  private async readForgeConfigFingerprint(): Promise<string | null> {
    const rootPath = this.projectRootPath;
    if (!rootPath) return null;
    try {
      const commonDir = await getGitCommonDir(rootPath, { logErrors: false });
      if (!commonDir) return null;
      const stats = await stat(pathResolve(commonDir, "config"));
      return `${stats.ino}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
    } catch {
      return null;
    }
  }

  /**
   * Seed the change baseline and arm the watcher-independent backstop. Called
   * at project load, before any monitor (and therefore any git watcher) starts.
   *
   * The load-time read is the ONLY one allowed to establish the "before"
   * snapshot: it provably precedes the watcher, whereas a per-monitor start
   * probe races the user and can absorb the very `git remote add` we need to
   * detect. `??=` keeps a reprobe that already landed from being overwritten by
   * this slower read.
   */
  private startForgeRemoteDetection(): void {
    if (this.forgeConfigPollTimer) return;
    const rootPath = this.projectRootPath;
    if (!rootPath) return;

    const seq = this.forgeRemoteProbeSeq;
    const epoch = this.forgeConfigEpoch;
    void (async () => {
      // stat → read → stat. The remote table and the fingerprint must describe
      // the SAME config, or the pair is incoherent: pre-change remotes stamped
      // with a post-change fingerprint would make the backstop consider the
      // change already seen and never emit it. Reading them concurrently cannot
      // guarantee that; bracketing the git read with two stats can.
      const before = await this.readForgeConfigFingerprint();
      const probed = await this.readForgeRemotes(rootPath);
      const after = await this.readForgeConfigFingerprint();

      // Discard when: the project unloaded mid-read, a config write was observed
      // mid-read, or the config moved between the stats (so this read may
      // already contain the change it is supposed to precede). Leaving the
      // baseline null is the safe failure — the next reprobe then sees
      // `signature !== null` and emits.
      if (seq !== this.forgeRemoteProbeSeq || epoch !== this.forgeConfigEpoch) return;
      if (before !== after) return;
      if (probed) this.forgeRemoteSignature ??= probed.signature;
      this.forgeConfigFingerprint ??= after;
    })();

    // The backstop only has to WAKE the reprobe — the reprobe itself stats the
    // config and skips the git spawn when nothing moved, so an idle tick costs
    // one stat.
    this.forgeConfigPollTimer = setInterval(() => {
      this.scheduleForgeRemoteReprobe({ observedConfigWrite: false });
    }, FORGE_CONFIG_POLL_INTERVAL_MS);
    this.forgeConfigPollTimer.unref?.();
  }

  private stopForgeRemoteDetection(): void {
    if (this.forgeConfigPollTimer) {
      clearInterval(this.forgeConfigPollTimer);
      this.forgeConfigPollTimer = null;
    }
    if (this.forgeReselectTimer) {
      clearTimeout(this.forgeReselectTimer);
      this.forgeReselectTimer = null;
    }
    if (this.forgeRemoteReprobeTimer) {
      clearTimeout(this.forgeRemoteReprobeTimer);
      this.forgeRemoteReprobeTimer = null;
    }
    // Invalidate every in-flight read (baseline seed and reprobe alike) so a
    // late completion can't touch stopped monitors, seed the incoming project's
    // baseline, or signal on behalf of a project that is no longer loaded.
    this.forgeRemoteProbeSeq++;
    this.forgeRemoteSignature = null;
    this.forgeConfigFingerprint = null;
  }

  /**
   * Store the relayed provider-matcher table and re-resolve every running
   * monitor's matched provider id. The table arrives async after plugin load
   * (and again on registry changes), so monitors that started unmatched gain
   * their provider id here once the owning plugin registers.
   */
  setForgeProviderMatchers(matchers: ForgeProviderMatcher[]): void {
    this.forgeProviderMatchers = Array.isArray(matchers) ? matchers : [];
    for (const monitor of this.monitors.values()) {
      if (!monitor.isRunning) continue;
      const fetchUrl = monitor.remoteFetchUrl;
      monitor.setMatchedForgeProviderId(
        fetchUrl ? matchProviderForRemoteUrl(fetchUrl, this.forgeProviderMatchers) : null
      );
    }
    // Re-matching the REMEMBERED url is not enough (#11408): which remote is
    // selected depends on the matcher table too. At cold start the table is
    // empty, so auto-detect ranks by name alone and can settle on a remote no
    // provider ends up supporting — re-matching that URL would leave the
    // affordance hidden forever while a sibling remote was usable all along.
    // Same story when enabling or disabling a provider plugin at runtime.
    //
    // Coalesced: the relay pushes on EVERY registry change, so plugin init
    // arrives as a burst of calls that would otherwise be one `git remote -v`
    // each. Mirrors the reprobe debounce, minus its config-fingerprint gate —
    // nothing wrote `.git/config` here, only the matcher table moved.
    this.forgeReselectRetries = 0;
    this.scheduleForgeReselect();
  }

  private handleInotifyLimitReached(): void {
    if (process.platform !== "linux") return;
    if (this.inotifyLimitNotified) return;
    this.inotifyLimitNotified = true;
    this.sendEvent({ type: "inotify-limit-reached" });
  }

  private handleEmfileLimitReached(): void {
    if (process.platform !== "darwin") return;
    if (this.emfileLimitNotified) return;
    this.emfileLimitNotified = true;
    this.sendEvent({ type: "emfile-limit-reached" });
  }

  /**
   * A recursive watcher re-armed after a degradation. Clear the one-shot
   * notification guards so a later relapse can re-signal, and emit
   * `watcher-recovered` so the renderer hides the persistent degraded
   * indicator and the main-process router resets its toast guards. Idempotent
   * — firing when nothing was degraded is a harmless no-op downstream.
   */
  private handleWatcherRecovered(): void {
    this.inotifyLimitNotified = false;
    this.emfileLimitNotified = false;
    this.sendEvent({ type: "watcher-recovered" });
  }

  /**
   * A repo's background-fetch auth failure persisted past the coordinator's
   * confirmation threshold. Emit a single escalation event per commondir per
   * session (the renderer turns it into one toast). The per-commondir guard
   * dedups the fan-out across sibling worktrees; it's reset by
   * `retryAuthFetch()` / credential rotation so a re-confirmation re-notifies.
   * The raw commondir path never leaves the host — only the classified reason
   * crosses the IPC boundary.
   */
  private handleAuthFailureConfirmed(
    commonDir: string,
    reason: import("../../shared/types/ipc/errors.js").GitOperationReason
  ): void {
    if (this.authFailureConfirmedNotified.has(commonDir)) return;
    this.authFailureConfirmedNotified.add(commonDir);
    this.sendEvent({ type: "fetch-auth-failure-confirmed", reason });
  }

  /**
   * Whether any worktree's recursive watcher is currently degraded to the
   * polling/git-only fallback. Bundled into the `get-all-states` handshake so
   * a late-mounting view hydrates the persistent indicator without waiting
   * for a live event.
   */
  isWatcherDegraded(): boolean {
    return this.inotifyLimitNotified || this.emfileLimitNotified;
  }

  /**
   * Whether the topology watcher is currently dark. Bundled into the
   * `get-all-states` handshake so a late-mounting view hydrates the indicator
   * without waiting for a live event (mirrors `isWatcherDegraded`).
   */
  isTopologyWatcherDark(): boolean {
    return this.topologyWatcher.isDark();
  }

  /**
   * Schedules a serialized topology reconcile (full worktree re-discovery).
   * Public so the `reconcile-topology` port action (the "Reconcile now"
   * recovery for the dark state, #9908) can drive it.
   *
   * `force` is for user-initiated recovery (the Refresh / "Reconcile now"
   * buttons): it bypasses the `pollingEnabled` gate and the post-reconcile
   * cooldown so an explicit user action is never silently swallowed.
   */
  scheduleTopologyReconcile(force = false): void {
    this.topologyWatcher.scheduleReconcile(force);
  }

  /**
   * Called after a monitor is removed. If the last monitor is gone while the
   * degradation guards are still set, the degraded watcher was torn down
   * before it could recover — there is no longer anything degraded, so treat
   * it as recovered. Otherwise a stale `watcherDegraded: true` would ride the
   * next `get-all-states` handshake and pin the indicator on with no way to
   * clear it.
   */
  private recoverWatcherIfNoMonitorsRemain(): void {
    if (this.monitors.size === 0 && this.isWatcherDegraded()) {
      this.handleWatcherRecovered();
    }
  }

  private handleExternalWorktreeRemoval(worktreeId: string): void {
    const monitor = this.monitors.get(worktreeId);
    if (!monitor) {
      return;
    }

    if (monitor.isMainWorktree) {
      console.warn("[WorkspaceHost] Blocked removal of main worktree monitor");
      monitor.setMood("error");
      monitor.setSummary("⚠️ Directory not accessible");
      this.emitUpdate(monitor);
      return;
    }

    if (!this.monitors.has(worktreeId)) {
      return;
    }

    this.removeMonitor(worktreeId);
    // A freed slot lets the next most-recently-focused evicted worktree
    // reclaim a watcher. Called after `removeMonitor` (which only re-arms the
    // watcher if no monitors remain) so a sibling worktree can immediately
    // pick up the slot.
    this.applyWatcherBudget();

    const cacheKey = this.listService.getCacheKey();
    if (cacheKey) {
      this.listService.invalidateCache(cacheKey);
    }

    console.log(`[WorkspaceHost] Worktree deleted externally, removed monitor: ${worktreeId}`);
  }

  getAllStates(requestId: string): void {
    const states: WorktreeSnapshot[] = [];
    for (const monitor of this.monitors.values()) {
      states.push(monitor.getSnapshot());
    }
    this.sendEvent({
      type: "all-states",
      requestId,
      states,
      epoch: this.epoch,
      seq: this.seq,
      lastAcknowledgedMutationIds: [...this.acknowledgedMutations],
      // Rides along with the snapshot so a caller learns *why* the list is
      // empty in the same round trip (#11650). `loadProject` sets this from a
      // live `checkIsRepo` probe of the folder, so it stays correct for a
      // project registered as a repository whose `.git` was since deleted —
      // the case the persisted `gitBacked` column silently gets wrong.
      gitBacked: this.gitBacked,
    });
  }

  getSnapshotsSync(): WorktreeSnapshot[] {
    const states: WorktreeSnapshot[] = [];
    for (const monitor of this.monitors.values()) {
      states.push(monitor.getSnapshot());
    }
    return states;
  }

  /**
   * Snapshot of mutation IDs successfully acknowledged in the current epoch
   * (#8405). The renderer reads this on every `get-all-states` reply to prune
   * outbox entries whose result already landed before a host crash. Each id
   * stays in the set for the lifetime of the host process — replays of the
   * same id are cheap (a Set lookup) and the cardinality is bounded by the
   * delete activity within a single session.
   */
  getAcknowledgedMutationIds(): string[] {
    return [...this.acknowledgedMutations];
  }

  getMonitor(requestId: string, worktreeId: string): void {
    const monitor = this.monitors.get(worktreeId);
    if (!monitor) {
      this.sendEvent({ type: "monitor", requestId, state: null });
      return;
    }

    this.sendEvent({
      type: "monitor",
      requestId,
      state: monitor.getSnapshot(),
    });
  }

  setActiveWorktree(requestId: string, worktreeId: string, options?: { silent?: boolean }): void {
    // Reject unknown worktree ids with success:false. Pre-PR, an unknown id
    // would mutate `this.activeWorktreeId` to a value the renderer could not
    // resolve; the new `worktree-activated` emit would propagate that miss
    // to the per-view store via MessagePort, where the listener would call
    // `selectWorktree(unknown)` and leave the sidebar in a half-state until
    // the next event. The new contract: unknown id → no-op + reject the
    // IPC request so the caller can surface the error.
    if (!this.monitors.has(worktreeId)) {
      this.sendEvent({ type: "set-active-result", requestId, success: false });
      return;
    }

    const previousActiveId = this.activeWorktreeId;
    this.activeWorktreeId = worktreeId;

    for (const [id, monitor] of this.monitors) {
      const isActive = id === worktreeId;
      const wasCurrent = monitor.isCurrent;
      const interval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;

      monitor.updateConfig({ basePollingInterval: interval });
      monitor.isCurrent = isActive;

      if (wasCurrent !== isActive) {
        monitor.reschedulePolling();
      }

      if (isActive && monitor.isRunning) {
        monitor.triggerRefreshIfUpdating();
      }

      if (monitor.hasInitialStatus && wasCurrent !== isActive) {
        this.emitUpdate(monitor);
      }
    }

    // Watcher-budget LRU bookkeeping (#9538): the new active worktree leaves
    // the background pool (it keeps a watcher unconditionally); the worktree
    // that just lost focus enters as the most-recently-focused background
    // entry, so it's the last to be evicted. applyWatcherBudget() then enforces
    // the cap — evicting an over-budget background watcher overrides the 3s
    // focus-downgrade hysteresis (the deliberate-eviction path bypasses it).
    this.lruRemove(worktreeId);
    if (
      previousActiveId &&
      previousActiveId !== worktreeId &&
      this.monitors.has(previousActiveId)
    ) {
      this.lruTouch(previousActiveId);
    }
    this.applyWatcherBudget();

    // Host-originated activation. Fires on every `setActiveWorktree` call
    // (auto-switch in `TopologyWatcher`'s reconcile and `deleteWorktree` AND
    // Main-originated IPC round-trips). Main-originated activations are
    // idempotent on the renderer side — the listener at
    // `WorktreeStoreContext.tsx` calls `selectWorktree` which is a no-op
    // when the id is already the active one. The auto-switch case is the
    // bug fix for #9945: without this emit, the renderer learned of the
    // loss via `worktree-removed` (clearing `activeWorktreeId` to null) and
    // only recovered on the next render tick via `useActiveWorktreeSync`.
    //
    // Separate surface from the legacy `CHANNELS.WORKTREE_ACTIVATED` echo
    // path that PR #3603's `silent` flag suppresses for renderer-initiated
    // IPC. The legacy echo reaches `window.electron.worktree.onActivated`
    // (no per-view consumer since the #9327276d7 migration); this MessagePort
    // event is what the per-view `WorktreeStoreContext` actually listens to.
    // `silent` is propagated so the main-process router can mirror the
    // legacy `silent` contract on the plugin bus and avoid double-notifying
    // subscribers that the legacy path already suppressed.
    this.sendEvent({
      type: "worktree-activated",
      worktreeId,
      epoch: this.epoch,
      seq: this.nextSeq(),
      silent: options?.silent,
    });

    this.sendEvent({ type: "set-active-result", requestId, success: true });
  }

  async refresh(requestId: string, worktreeId?: string): Promise<{ ok: boolean; error?: string }> {
    try {
      if (worktreeId) {
        const monitor = this.monitors.get(worktreeId);
        if (monitor) {
          await withTimeout(
            monitor.refresh(),
            HOST_REFRESH_TIMEOUT_MS,
            `refresh watchdog: ${worktreeId}`
          );
        }
      } else {
        // The user-facing Refresh button lands here. It MUST always reply in
        // bounded time and never let one slow phase abort the others, so the
        // button is a real escape hatch rather than a silent no-op:
        //  - topology re-discovery runs first (it reconciles the monitor set),
        //    but its failure must not stop the status refresh of monitors we
        //    already have;
        //  - the per-monitor status refresh and the PR fetch then run under
        //    allSettled so a slow PR fetch can't sink the worktree refresh;
        //  - the whole pass is watchdogged so the port request always returns.
        await withTimeout(
          (async () => {
            try {
              await this.discoverAndSyncWorktrees();
            } catch (err) {
              console.warn(
                `[WorkspaceHost] refresh: topology re-discovery failed: ${(err as Error).message}`
              );
            }
            await Promise.allSettled([this.refreshAll(), pullRequestService.refresh()]);
          })(),
          HOST_REFRESH_TIMEOUT_MS,
          "refresh watchdog: all worktrees"
        );
      }
      this.sendEvent({ type: "refresh-result", requestId, success: true });
      return { ok: true };
    } catch (error) {
      // Reached only when the overall watchdog trips (the inner phases swallow
      // their own failures). Report it in the request RESULT — the legacy
      // refresh-result event has no renderer consumer, so without this the
      // Refresh button would resolve "ok" on a host-side timeout and look like
      // a silent no-op.
      const message = (error as Error).message;
      this.sendEvent({ type: "refresh-result", requestId, success: false, error: message });
      return { ok: false, error: message };
    }
  }

  /**
   * Force a fresh `git status` for one worktree and return its change set
   * directly (#11343).
   *
   * The delete-confirm surfaces (local dialog + MCP confirm) must derive the
   * D2/D3 tier and the changed-file preview from LIVE changes — a backgrounded
   * worktree's cached snapshot can be ~30s stale, which lets a force-delete
   * skip the typed-name gate and silently discard uncommitted work. This runs
   * `monitor.refresh()` (which bypasses the adaptive-poll cache) and reads the
   * resulting changes back off the same monitor, so the caller gets a value
   * that provably reflects the refresh — no dependency on the broadcast landing
   * on the (separate) worktree port first. Watchdogged like `refresh()` so a
   * degraded repo can't hang the port request. `null` when no monitor exists
   * for the id (already removed).
   */
  async getFreshWorktreeChanges(worktreeId: string): Promise<WorktreeChanges | null> {
    const monitor = this.monitors.get(worktreeId);
    if (!monitor) return null;
    // `getFreshChanges()` forces a real `git status` that bypasses the
    // single-flight status pass — a `refresh()` here would silently no-op (and
    // return the stale snapshot) whenever a background poll is mid-pass, which
    // is precisely the stale read #11343 must not make. Watchdogged so a
    // degraded repo can't hang the port request; a rejection propagates so the
    // caller fails closed rather than proceeding on stale data.
    return withTimeout(
      monitor.getFreshChanges(),
      HOST_REFRESH_TIMEOUT_MS,
      `get-worktree-changes watchdog: ${worktreeId}`
    );
  }

  /**
   * Refresh the workspace after the OS wakes from sleep.
   *
   * Resets each monitor's adaptive polling strategy synchronously before
   * enqueuing a serialized refresh, so pre-sleep operation durations and
   * circuit-breaker counters don't poison the post-wake polling cadence.
   * The wake refresh runs through a dedicated `concurrency: 1` queue rather
   * than the shared `pollQueue` so we don't burst N concurrent `git status`
   * processes against shared `packed-refs` / `gc.pid` immediately on wake.
   */
  async refreshOnWake(requestId: string): Promise<void> {
    try {
      // Drop network/transient fetch failures so the post-wake fetch attempt
      // is allowed to run even if the network was down before sleep. Auth
      // suspensions stay sticky — they require explicit re-auth.
      this.fetchCoordinator.clearNetworkFailures();
      for (const monitor of this.monitors.values()) {
        monitor.resetPollingStrategy();
      }
      const wakeQueue = new PQueue({ concurrency: 1 });
      const promises = Array.from(this.monitors.values()).map((monitor) =>
        wakeQueue.add(async () => {
          try {
            await monitor.refresh();
          } finally {
            if (monitor.isRunning && this.pollingEnabled) {
              monitor.reschedulePolling();
            }
          }
        })
      );
      await Promise.all(promises);
      // Kick off background fetches across all worktrees so ahead/behind
      // counts catch up against the network state we just reconnected to.
      // Fire-and-forget — the fetch coordinator serializes per-repo and
      // failures don't block the wake refresh result.
      for (const monitor of this.monitors.values()) {
        if (monitor.isRunning) {
          void monitor.triggerFetchNow();
        }
      }
      await pullRequestService.refresh();
      this.sendEvent({ type: "refresh-result", requestId, success: true });
    } catch (error) {
      this.sendEvent({
        type: "refresh-result",
        requestId,
        success: false,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Whether the loaded folder is a git repository.
   *
   * Three outcomes, not two. `checkIsRepo()` resolves `false` only when git ran
   * and answered no: simple-git's `checkIsRepoTask.onError` turns exit code 128
   * plus a "not a git repository" message into a resolved `false` and *throws*
   * everything else — a spawn failure against an unavailable cwd, the 30s
   * `GIT_BLOCK_TIMEOUT_MS` abort, a OneDrive placeholder stall, an antivirus
   * interposition. So a thrown probe means "couldn't answer", never "no
   * repository", and the bare `catch { return false }` that used to conflate
   * them was the sole route to reporting a healthy repo as unbacked (#11922).
   *
   * Failing here propagates to `loadProject`'s catch, which reports
   * `load-project-result: success: false`. That is load-bearing twice: it drives
   * the "Couldn't load worktrees" banner instead of an authoritative-looking
   * empty list, and it rejects the pool entry's ready promise so Retry disposes
   * the host and issues a genuine reload rather than re-foregrounding one whose
   * `monitors` map is empty (`WorkspaceHostPool.loadProject`).
   *
   * `gitBacked` is deliberately left untouched on the throw path: its `null`
   * default already means "not classified" to every consumer (#11650), and the
   * `syncMonitors` self-deletion guard keys on `=== false`, so an unknown
   * verdict can never arm the hazard #11405 closed.
   */
  private async isGitRepository(): Promise<boolean> {
    if (!this.git) {
      // Unreachable from `loadProject`, which assigns `this.git` immediately
      // above the call and throws out of `createHardenedGit` otherwise. A throw
      // rather than a `false` so an impossible state can never be the thing
      // that reports a repository as unbacked.
      throw new RepositoryProbeError("unknown");
    }
    try {
      return await this.git.checkIsRepo();
    } catch (error) {
      const reason = classifyGitError(error);
      // Defense in depth: simple-git's own `onError` should already have turned
      // a genuine "fatal: not a git repository" into a resolved `false` before
      // it could reach here. If it ever stops doing so, this is still a real
      // answer from git and has to stay on the non-repository path.
      if (reason === "not-a-repository") return false;
      // `logWarn`, not `console.warn`: production esbuild marks `console.warn`
      // pure (`scripts/build-main.mjs`), so a console call is stripped from the
      // packaged build — the only build this failure has ever been seen in. The
      // whole point of capturing it is that the next repro says which branch
      // fired and why.
      logWarn("Repository probe failed; folder left unclassified", {
        projectRootPath: this.projectRootPath,
        gitReason: reason,
        probeError: extractGitErrorMessage(error),
      });
      throw new RepositoryProbeError(reason, error);
    }
  }

  private async discoverAndSyncWorktrees(): Promise<void> {
    // Backstop for the `loadProject` gate: a topology reconcile or an explicit
    // refresh must not be the thing that mints the first monitor for a folder
    // with no repository (#11405).
    if (!this.git || this.gitBacked === false) {
      return;
    }

    // #6669: list first, then prune only when a prunable entry is present. Git
    // 2.31+ surfaces externally-deleted worktrees with a `prunable` marker in
    // `worktree list --porcelain`; without a prune pass `syncMonitors` would
    // re-create a monitor for the phantom path and the sidebar entry would
    // never clear. Listing first lets us skip the write-lock-taking prune
    // command on every steady-state cycle (where nothing is prunable), cutting
    // the per-90s topology reconcile from 2 spawns to 1. When prunable entries
    // are found we prune then re-list so the sync sees the cleaned topology.
    // Best-effort: if prune fails (e.g. EPERM on .git/worktrees/), fall through
    // with the original list — same recovery behaviour as before.
    let rawWorktrees = await this.listService.list({ forceRefresh: true });
    if (rawWorktrees.some((wt) => wt.isPrunable)) {
      try {
        await this.git.raw(["worktree", "prune"]);
        rawWorktrees = await this.listService.list({ forceRefresh: true });
      } catch (pruneError) {
        console.warn(
          `[WorkspaceHost] worktree prune during refresh failed: ${(pruneError as Error).message}`
        );
      }
    }

    const worktrees = await this.listService.mapToWorktrees(rawWorktrees);

    await this.syncMonitors(worktrees, this.activeWorktreeId, this.mainBranch, undefined, true);
  }

  private async refreshAll(): Promise<void> {
    const promises = Array.from(this.monitors.values()).map((monitor) =>
      this.pollQueue.add(async () => {
        try {
          await monitor.refresh();
        } finally {
          if (monitor.isRunning && this.pollingEnabled) {
            monitor.reschedulePolling();
          }
        }
      })
    );
    // allSettled, not all: a single worktree whose refresh rejects (or whose
    // queue slot is dropped by the pollQueue watchdog) must not abort the
    // refresh of every other worktree. The pollQueue's per-task timeout already
    // guarantees each slot frees, so this resolves in bounded time.
    await Promise.allSettled(promises);
  }

  async createWorktree(
    requestId: string,
    rootPath: string,
    options: CreateWorktreeOptions
  ): Promise<void> {
    const createKey = this.getCreateWorktreeInFlightKey(rootPath, options);
    const existingCreate = this.inFlightWorktreeCreates.get(createKey);
    if (existingCreate) {
      try {
        const worktreeId = await existingCreate;
        this.sendEvent({
          type: "create-worktree-result",
          requestId,
          success: true,
          worktreeId,
        });
      } catch (error) {
        this.sendEvent({
          type: "create-worktree-result",
          requestId,
          success: false,
          error: (error as Error).message,
        });
      }
      return;
    }

    const createPromise = this.enqueueCreateWorktree(rootPath, options);
    this.inFlightWorktreeCreates.set(createKey, createPromise);

    try {
      const worktreeId = await createPromise;
      this.sendEvent({
        type: "create-worktree-result",
        requestId,
        success: true,
        worktreeId,
      });
    } catch (error) {
      this.sendEvent({
        type: "create-worktree-result",
        requestId,
        success: false,
        error: (error as Error).message,
      });
    } finally {
      if (this.inFlightWorktreeCreates.get(createKey) === createPromise) {
        this.inFlightWorktreeCreates.delete(createKey);
      }
    }
  }

  private enqueueCreateWorktree(rootPath: string, options: CreateWorktreeOptions): Promise<string> {
    const queueKey = this.normalizeCreateWorktreeKeyPath(pathResolve(rootPath));
    const prev = this.createWorktreeQueues.get(queueKey) ?? Promise.resolve();
    const run = prev.then(() => this.performCreateWorktree(rootPath, options));
    // A failed create must not poison the chain for the next caller.
    const tail = run.catch(() => {});
    this.createWorktreeQueues.set(queueKey, tail);
    void tail.then(() => {
      if (this.createWorktreeQueues.get(queueKey) === tail) {
        this.createWorktreeQueues.delete(queueKey);
      }
    });
    return run;
  }

  private getCreateWorktreeInFlightKey(rootPath: string, options: CreateWorktreeOptions): string {
    const absoluteCreatePath = isAbsolute(options.path)
      ? pathResolve(options.path)
      : pathResolve(rootPath, options.path);
    const normalizedRootPath = this.normalizeCreateWorktreeKeyPath(pathResolve(rootPath));
    const normalizedCreatePath = this.normalizeCreateWorktreeKeyPath(absoluteCreatePath);
    const branchName =
      typeof options.newBranch === "string" ? options.newBranch.trim() : String(options.newBranch);

    return `${normalizedRootPath}\0${normalizedCreatePath}\0${branchName}`;
  }

  private normalizeCreateWorktreeKeyPath(pathValue: string): string {
    const resolvedPath = pathResolve(pathValue);
    return os.platform() === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  }

  private async performCreateWorktree(
    rootPath: string,
    options: CreateWorktreeOptions
  ): Promise<string> {
    // Hoisted so the catch can clear the pending entry even though
    // absoluteCreatePath is block-scoped to the try.
    let pendingCreateKey: string | null = null;
    try {
      markHostPerformance("wtcreate.host-start", { branch: options.newBranch });
      const git = await createHardenedGit(rootPath);
      const { baseBranch, path } = options;
      let { newBranch } = options;
      let { fromRemote = false, useExistingBranch = false } = options;

      // Authoritative validation gate. Every caller (IPC, MCP, recipes)
      // reaches this method, so any branch-name or parent-dir issue caught
      // here surfaces a clear error instead of bubbling up as a low-level
      // git fatal. #7033. Also rejects argv-shaped names (leading dash) and
      // git-special characters before any git call.
      if (typeof newBranch !== "string" || newBranch.trim().length === 0) {
        throw new Error("Branch name cannot be empty");
      }
      const newBranchValidation = validateBranchName(newBranch);
      if (!newBranchValidation.valid) {
        throw new Error(
          `Invalid branch name '${newBranch}': ${newBranchValidation.error ?? "invalid"}`
        );
      }
      const baseBranchValidation = validateBranchName(baseBranch);
      if (!baseBranchValidation.valid) {
        throw new Error(
          `Invalid base branch '${baseBranch}': ${baseBranchValidation.error ?? "invalid"}`
        );
      }
      // Resolve before taking dirname so a relative `path` (rare, but allowed
      // through programmatic callers) is checked against the right parent
      // rather than against process.cwd.
      const absoluteCreatePath = isAbsolute(path) ? pathResolve(path) : pathResolve(rootPath, path);
      // Containment gate (#9154): a renderer-supplied path must not escape the
      // repository's parent directory — the outermost location the worktree
      // path patterns can produce. Runs before any mkdir/git so an out-of-bounds
      // target never creates directories or invokes git.
      await assertWorktreePathContained(rootPath, absoluteCreatePath);
      const parentDir = dirname(absoluteCreatePath);
      if (!existsSync(parentDir)) {
        await mkdir(parentDir, { recursive: true });
      }

      // Mark the metadata-subdir basename pending so the watcher event our own
      // `git worktree add` produces is recognized and dropped — without
      // blanket-suppressing concurrent external `git worktree remove` events.
      pendingCreateKey = this.topologyWatcher.metadataKey(absoluteCreatePath);
      this.topologyWatcher.markPendingCreate(pendingCreateKey);

      // `--end-of-options` after the subcommand flags so any leading-dash ref
      // or path that slipped past validation is treated as positional.
      const addReusingBranch = () =>
        git.raw(["worktree", "add", "--end-of-options", path, newBranch]);
      // --no-track: local-base branches shouldn't auto-track a local ref even
      // when the user has branch.autoSetupMerge=always. Skipping tracking also
      // avoids a .git/config.lock acquisition, cutting contention under bulk
      // creation. PR-mode (fromRemote) keeps --track — ahead/behind badges
      // at WorktreeMonitor.ts:1092 depend on @{u} resolving.
      const addNewBranch = () =>
        git.raw([
          "worktree",
          "add",
          "-b",
          newBranch,
          fromRemote ? "--track" : "--no-track",
          "--end-of-options",
          path,
          baseBranch,
        ]);

      markHostPerformance("wtcreate.git-add:start", { branch: newBranch });
      if (useExistingBranch) {
        await addReusingBranch();
      } else {
        try {
          await addNewBranch();
        } catch (addError) {
          // #6463: a stale local branch with the same name makes `worktree add
          // -b` fail with "a branch named '...' already exists" whenever a
          // previous worktree was deleted but its branch was kept. That add
          // failure is atomic — git refuses before creating the directory or
          // registering any worktree metadata — so collision detection rides
          // the add itself instead of charging every create a pre-flight
          // `git branchLocal` spawn. Recovery outcomes are unchanged:
          // (a) branch exists but is not checked out anywhere → reuse it (drop
          //     -b, switch to the useExistingBranch arg form);
          // (b) branch is live in another worktree → suffix -2/-3/... and
          //     create a fresh branch.
          if (!isBranchAlreadyExistsError(addError)) throw addError;

          // The failed add produced no watcher event to suppress; release the
          // pending mark while the recovery probes run so an external create
          // of the same basename in this window isn't silently dropped, then
          // re-mark just before the retry add below.
          this.topologyWatcher.clearPending(pendingCreateKey);

          let localBranches: string[];
          try {
            localBranches = (await git.branchLocal()).all;
          } catch {
            // Can't inspect branches to recover; surface the original git
            // failure (same outcome as the old pre-flight, whose listing
            // failure fell through to this add error).
            throw addError;
          }

          let checkedOut = new Set<string>();
          let listFailed = false;
          try {
            const output = await git.raw(["worktree", "list", "--porcelain"]);
            checkedOut = parseCheckedOutBranches(output);
          } catch {
            // We can't tell if the branch is live elsewhere; fall through to
            // the suffix path rather than risk reusing a checked-out branch.
            listFailed = true;
          }

          // For fromRemote (PR mode) we never reuse a stale local branch:
          // the local ref is at the previous tip, and dropping --track would
          // strip @{u} that ahead/behind badges depend on. Suffix instead so
          // a fresh tracking branch is created.
          const canReuse = !listFailed && !fromRemote && !checkedOut.has(newBranch);

          this.topologyWatcher.markPendingCreate(pendingCreateKey);
          if (canReuse) {
            useExistingBranch = true;
            // The -b path tracks baseBranch; reuse drops that. Stale local
            // branches typically retain their original config, so this is
            // the right tradeoff vs. failing the user-visible create.
            fromRemote = false;
            await addReusingBranch();
          } else {
            newBranch = nextAvailableBranchName(newBranch, new Set(localBranches));
            await addNewBranch();
          }
        }
      }
      markHostPerformance("wtcreate.git-add:end", { branch: newBranch });

      const absolutePath = isAbsolute(path) ? pathResolve(path) : pathResolve(rootPath, path);
      // 500ms is ample: git returns after the directory exists; the polling
      // loop gives 4-5 attempts (50/100/200/150ms) across the budget, which
      // covers APFS/NTFS/ext4 metadata flush latency without blocking the
      // critical path for seconds on transient filesystem stalls.
      await waitForPathExists(absolutePath, {
        timeoutMs: 500,
        initialRetryDelayMs: 50,
        maxRetryDelayMs: 800,
      });
      markHostPerformance("wtcreate.path-verified", { branch: newBranch });
      const canonicalPath = await realpath(absolutePath).catch(() => absolutePath);

      // Build the Worktree object directly from known inputs instead of
      // shelling out to `git worktree list --porcelain` — the per-create list
      // was O(N²) across batches. Fields match WorktreeListService.mapToWorktrees
      // output for a freshly-created, attached, non-main worktree.
      const createdWorktree: Worktree = {
        id: canonicalPath,
        path: canonicalPath,
        name: newBranch,
        branch: newBranch,
        head: undefined,
        isDetached: false,
        isCurrent: false,
        isMainWorktree: false,
        // `assertWorktreePathContained` ran above, so this path is provably
        // inside the boundary — no need to re-derive it from the root here.
        isExternal: false,
        gitDir: (await getGitDir(canonicalPath)) || undefined,
      };
      const canonicalWorktreeId = createdWorktree.id;
      const isActive = canonicalWorktreeId === this.activeWorktreeId;

      // Register the monitor SYNCHRONOUSLY before emitting the success event.
      // Two invariants depend on this ordering:
      //   1. Any caller that queries this.monitors.get(worktreeId) immediately
      //      after receiving create-worktree-result finds a live monitor.
      //   2. startWithoutGitStatus (inside addNewWorktreeMonitor) emits the
      //      initial clean-state worktree-update, which is the signal the
      //      renderer's store uses to add the worktree to its list. Without
      //      this emission the worktree stays invisible in the UI until the
      //      next poll or watcher fire.
      // We bypass syncMonitors here because syncMonitors treats its array as
      // authoritative and would remove every other non-main monitor.
      await this.addNewWorktreeMonitor(createdWorktree, isActive, true);
      markHostPerformance("wtcreate.monitor-registered", { branch: newBranch });

      // Monitor is registered. Drop the pending entry now: any still-buffered
      // create event for this name will be matched by the next drain (the
      // safety valve is cancelled here so the happy path can't spuriously
      // reconcile 5s later).
      this.topologyWatcher.clearPending(pendingCreateKey);

      if (options.worktreeMode && options.worktreeMode !== "local") {
        const m = this.monitors.get(canonicalWorktreeId);
        if (m) {
          m.setWorktreeMode(options.worktreeMode);
          m.setWorktreeEnvironmentLabel(options.worktreeMode);
          // Re-emit so the UI picks up the mode on the same snapshot cycle
          // rather than waiting for the first real poll.
          m.emitUpdate();
        }
      }

      // #8888: when created from the GitHub PR dropdown, seed the source PR
      // eagerly so the card surfaces the PR (title, linked issue) immediately
      // instead of waiting for PullRequestService's branch-name polling. Must
      // run before `return canonicalWorktreeId` — the initial clean snapshot
      // already emitted from addNewWorktreeMonitor, so we mutate and emit once
      // more. Wrapped in try/catch: a seeding failure must never fail the
      // create (polling backfills `linked` regardless).
      if (options.sourcePrNumber !== undefined) {
        const m = this.monitors.get(canonicalWorktreeId);
        if (m) {
          try {
            m.setSourcePrNumber(options.sourcePrNumber);

            const providerCtx = this.prService.getProviderContext();
            if (providerCtx && options.sourcePrUrl && options.sourcePrState) {
              // Provider resolved — `linked` is the source of truth.
              const linked = this.composeLinked({
                providerId: providerCtx.providerId,
                owner: providerCtx.owner,
                repo: providerCtx.repo,
                pr: {
                  number: options.sourcePrNumber,
                  title: options.sourcePrTitle,
                  url: options.sourcePrUrl,
                  state: options.sourcePrState,
                },
                issue:
                  options.sourcePrLinkedIssueNumber !== undefined
                    ? { number: options.sourcePrLinkedIssueNumber }
                    : undefined,
              });
              m.setLinked(linked);
            } else {
              // No provider context yet (e.g. token not connected). Persist the
              // legacy flat fields so the PR still shows; PullRequestService
              // fills `linked` on its first poll.
              m.setPRInfo({
                prNumber: options.sourcePrNumber,
                prUrl: options.sourcePrUrl,
                prState: options.sourcePrState,
                prTitle: options.sourcePrTitle,
              });
            }

            // Keep the flat issue number in lockstep so the offline issue badge
            // shows and the onIssueNotFound guard matches.
            if (options.sourcePrLinkedIssueNumber !== undefined) {
              m.setIssueNumber(options.sourcePrLinkedIssueNumber);
            }

            m.emitUpdate();
          } catch (err) {
            console.warn("[WorkspaceHost] failed to seed source PR on create:", err);
          }
        }
      }

      // Fire-and-forget tail: cache invalidation, .daintree copy, and
      // lifecycle setup are non-blocking for callers of create-worktree-result.
      // Tail failures are logged but never re-emit a result event.
      void (async () => {
        // Invalidate first so any racing list() call after this emission
        // doesn't return a stale cached snapshot that excludes the new worktree.
        this.listService.invalidateCache(pathResolve(rootPath));

        await this.lifecycleService.copyDaintreeDir(rootPath, canonicalPath);

        void this.runLifecycleSetup(
          canonicalWorktreeId,
          canonicalPath,
          rootPath,
          options.provisionResource ?? options.worktreeMode === "remote-worker"
        );
      })().catch((err) => {
        const message = formatErrorMessage(err, "createWorktree async tail failed");
        const stack = err instanceof Error ? err.stack : undefined;
        console.warn("[WorkspaceHost] createWorktree async tail failed:", err);
        this.sendEvent({
          type: "lifecycle-setup-error",
          worktreeId: canonicalWorktreeId,
          message,
          details: stack,
        });
      });
      markHostPerformance("wtcreate.host-end", { branch: newBranch });
      return canonicalWorktreeId;
    } catch (error) {
      // Create failed — drop any pending entry so a real external change to
      // that name isn't masked, and cancel its safety valve.
      if (pendingCreateKey) this.topologyWatcher.clearPending(pendingCreateKey);
      throw error;
    }
  }

  private getLifecycleContext(): WorkspaceHostContext | null {
    if (!this.projectRootPath) return null;
    return {
      projectRootPath: this.projectRootPath,
      projectEnvVars: this.projectEnvVars,
      getMonitor: (id) => this.monitors.get(id),
      emitUpdate: (m) => this.emitUpdate(m),
    };
  }

  private async runLifecycleSetup(
    worktreeId: string,
    worktreePath: string,
    projectRootPath: string,
    provisionResource?: boolean,
    environmentId?: string
  ): Promise<void> {
    const ctx: WorkspaceHostContext = this.getLifecycleContext() ?? {
      projectRootPath,
      projectEnvVars: this.projectEnvVars,
      getMonitor: (id) => this.monitors.get(id),
      emitUpdate: (m) => this.emitUpdate(m),
    };

    const { shouldProvision } = await this.lifecycleService.runLifecycleSetup(
      worktreeId,
      worktreePath,
      ctx,
      provisionResource,
      environmentId
    );

    if (shouldProvision && this.projectRootPath) {
      await this.runResourceAction(`auto-provision-${worktreeId}`, worktreeId, "provision");
    }
  }

  /**
   * Re-run the lifecycle setup script for an existing worktree without
   * recreating it. Surfaced via the `run-lifecycle-setup` port action so the
   * worktree card can offer a "Retry setup" affordance after a failed/timed-out
   * setup. Same idempotence assumption as resource provisioning — the user
   * authors setup scripts knowing they may be re-run in place.
   */
  async retryLifecycleSetup(worktreeId: string): Promise<void> {
    const monitor = this.monitors.get(worktreeId);
    if (!monitor) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }
    if (!this.projectRootPath) {
      throw new Error("Cannot retry setup before a project is loaded");
    }
    if (monitor.lifecycleStatus?.state === "running") {
      throw new Error("Setup is already running");
    }

    // Set running synchronously *before* the first await so a second concurrent
    // request (rapid clicks, multi-window, retry-after-error) sees the in-flight
    // state and is rejected by the guard above. `runLifecycleSetup` re-sets the
    // same state with full command-progress metadata once config loads.
    monitor.setLifecycleStatus({
      phase: "setup",
      state: "running",
      startedAt: Date.now(),
    });
    this.emitUpdate(monitor);

    await this.runLifecycleSetup(worktreeId, monitor.path, this.projectRootPath, false);
  }

  private async runLifecycleTeardown(
    worktreeId: string,
    monitor: WorktreeMonitor,
    force: boolean
  ): Promise<void> {
    const ctx = this.getLifecycleContext();
    if (!ctx) {
      return;
    }
    await this.lifecycleService.runLifecycleTeardown(worktreeId, monitor, force, ctx);
  }

  async deleteWorktree(
    requestId: string,
    worktreeId: string,
    force: boolean = false,
    deleteBranch: boolean = false,
    mutationId?: string,
    /**
     * Whether to re-throw on failure after emitting `delete-worktree-result`.
     * Defaults to `false` to preserve the legacy callers' contract — they
     * resolve via the requestId-keyed event, not the promise return. The port
     * dispatcher passes `true` so semantic failures (uncommitted changes,
     * etc.) reject the renderer's `worktreePort.request("delete-worktree")`
     * instead of silently resolving to `{ ok: true }` (#8405 review #1).
     */
    throwOnError: boolean = false
  ): Promise<void> {
    // Mutation-outbox replay short-circuit (#8405): a replay of an already
    // acknowledged delete must not re-run `git worktree remove` (which would
    // fail with "not a working tree" or "worktree not found" depending on
    // whether the metadata was pruned). The original ack stuck — the renderer
    // just didn't observe the result before the port dropped. Re-emit the
    // success ack so the renderer can resolve and prune the outbox entry.
    if (mutationId && this.acknowledgedMutations.has(mutationId)) {
      this.sendEvent({ type: "delete-worktree-result", requestId, success: true });
      return;
    }
    // Hoisted so the catch can clear the pending entry even though `monitor`
    // is block-scoped to the try.
    let pendingDeleteKey: string | null = null;
    try {
      markHostPerformance("wtdelete.host-start", { worktreeId });
      const monitor = this.monitors.get(worktreeId);
      if (!monitor) {
        // Replay path: the monitor was cleaned up by the original successful
        // delete but the ack never reached the renderer (port dropped between
        // `worktree-removed` and the result ack). If we know this mutation
        // succeeded earlier we ack idempotently; otherwise this is a genuine
        // unknown id and we surface the error. The earlier `acknowledgedMutations`
        // check covers cleanly-acked replays, but a host that crashed AFTER
        // monitor cleanup but BEFORE recording the ack would land here — there's
        // no way to distinguish that from a never-existed delete without further
        // bookkeeping, so we keep the strict error and rely on the renderer to
        // surface it once the user dismisses or retries.
        throw new Error(`Worktree not found: ${worktreeId}`);
      }

      if (monitor.isMainWorktree) {
        throw new Error("Cannot delete the main worktree");
      }

      const wtChanges = monitor.getWorktreeChanges();
      if (!force && (wtChanges?.changedFileCount ?? 0) > 0) {
        const fileChanges = wtChanges?.changes ?? [];
        const hasTracked = fileChanges.some(
          (c) => c.status !== "untracked" && c.status !== "ignored"
        );
        const hasUntracked = fileChanges.some((c) => c.status === "untracked");
        const description =
          hasTracked && hasUntracked
            ? "uncommitted changes and untracked files"
            : hasTracked
              ? "uncommitted changes"
              : "untracked files";
        throw new Error(`Worktree has ${description}. Use force delete to proceed.`);
      }

      const branchToDelete = deleteBranch ? monitor.branch : undefined;

      if (deleteBranch && !monitor.branch) {
        throw new Error("Cannot delete branch: worktree has no associated branch (detached HEAD)");
      }

      if (monitor.isCurrent) {
        let mainWorktreeId: string | undefined;
        for (const [id, m] of this.monitors) {
          if (m.isMainWorktree) {
            mainWorktreeId = id;
            break;
          }
        }
        if (!mainWorktreeId) {
          throw new Error("Cannot delete active worktree: no main worktree found to switch to");
        }
        this.setActiveWorktree(`${requestId}-auto-switch`, mainWorktreeId);
      }

      await this.runLifecycleTeardown(worktreeId, monitor, force);

      // Mark the metadata-subdir basename pending so the watcher event our own
      // `git worktree remove` produces is recognized and dropped — without
      // blanket-suppressing concurrent external worktree changes.
      pendingDeleteKey = this.topologyWatcher.metadataKey(monitor.path);
      this.topologyWatcher.markPendingDelete(pendingDeleteKey);

      if (this.git) {
        // #6669: if the directory is already gone (deleted externally), skip
        // `git worktree remove` (which fails with `is not a working tree`)
        // and run `git worktree prune` instead to clean up the leftover
        // metadata. This is the only UI recovery path for a phantom entry.
        // Only ENOENT routes to prune — other access errors (EPERM, EACCES,
        // ENOTDIR) fall through so we don't skip the remove on transient
        // permission issues; the remove call's own errors will surface.
        let pathMissing = false;
        try {
          await access(monitor.path);
        } catch (accessError) {
          if ((accessError as NodeJS.ErrnoException).code === "ENOENT") {
            pathMissing = true;
          }
        }

        if (pathMissing) {
          try {
            await this.git.raw(["worktree", "prune"]);
          } catch (pruneError) {
            // Best-effort: the directory is already gone, so failing to clean
            // up the metadata shouldn't block the UI from removing the entry.
            console.warn(
              `[WorkspaceHost] worktree prune failed for missing path ${monitor.path}: ${(pruneError as Error).message}`
            );
          }
        } else {
          const args = ["worktree", "remove"];
          if (force) {
            args.push("--force");
          }
          // `--end-of-options` so a leading-dash worktree path is treated as
          // positional rather than parsed as a flag.
          args.push("--end-of-options", monitor.path);
          markHostPerformance("wtdelete.git-remove:start", { worktreeId });
          const removeResult = await this.removeGitWorktreeWithRetry(this.git, args, monitor.path);
          markHostPerformance("wtdelete.git-remove:end", { worktreeId });
          if (removeResult === "stale") {
            try {
              await this.git.raw(["worktree", "prune"]);
            } catch (pruneError) {
              console.warn(
                `[WorkspaceHost] worktree prune failed after stale remove for ${monitor.path}: ${(pruneError as Error).message}`
              );
            }
          }
        }

        clearGitDirCache(monitor.path);
        clearGitCommonDirCache(monitor.path);

        const cacheKey = this.listService.getCacheKey();
        if (cacheKey) {
          this.listService.invalidateCache(cacheKey);
        }
      }

      // Clean up the monitor immediately after worktree removal succeeds,
      // before attempting branch deletion — so the monitor doesn't linger
      // if branch deletion fails. Routed through the `removeMonitor`
      // chokepoint so the persisted WSL git opt-in entry is pruned in
      // lockstep (#9926).
      this.removeMonitor(worktreeId);
      // A freed slot lets the next most-recently-focused evicted worktree
      // reclaim a watcher. Called after `removeMonitor` (which only re-arms
      // the watcher if no monitors remain) so a sibling worktree can
      // immediately pick up the slot.
      this.applyWatcherBudget();

      // Monitor is cleaned up. Drop the pending entry now (cancelling its
      // safety valve): any still-buffered delete event for this name is
      // matched by the next drain.
      this.topologyWatcher.clearPending(pendingDeleteKey);

      if (branchToDelete && this.git) {
        try {
          await this.git.raw(["branch", force ? "-D" : "-d", branchToDelete]);
          console.log(
            `[WorkspaceHost] Deleted branch: ${branchToDelete} (${force ? "force" : "safe"})`
          );
        } catch (branchError) {
          const errorMsg = (branchError as Error).message || "";
          if (errorMsg.includes("not found")) {
            console.log(`[WorkspaceHost] Branch already deleted: ${branchToDelete}`);
          } else if (errorMsg.includes("not fully merged")) {
            throw new Error(
              `Branch '${branchToDelete}' has unmerged changes. Enable force delete to remove it.`,
              { cause: branchError }
            );
          } else if (errorMsg.includes("checked out at") || errorMsg.includes("Cannot delete")) {
            throw new Error(
              `Cannot delete branch '${branchToDelete}': ${errorMsg.split("\n")[0]}`,
              {
                cause: branchError,
              }
            );
          } else {
            throw new Error(`Failed to delete branch '${branchToDelete}': ${errorMsg}`, {
              cause: branchError,
            });
          }
        }
      }

      // Record the successful ack before sending the result so the next port
      // reconnect's `get-all-states` advertises it (#8405). If the port drops
      // between the record and the send, the renderer's outbox replay path
      // sees the id in `lastAcknowledgedMutationIds` and prunes without firing
      // a second delete — the operation completed once, the renderer just
      // missed the live ack.
      if (mutationId) this.recordAcknowledgedMutation(mutationId);
      markHostPerformance("wtdelete.host-end", { worktreeId });
      this.sendEvent({ type: "delete-worktree-result", requestId, success: true });
    } catch (error) {
      // Delete failed — drop any pending entry so a real external change to
      // that name isn't masked, and cancel its safety valve.
      if (pendingDeleteKey) this.topologyWatcher.clearPending(pendingDeleteKey);
      // sendEvent for the legacy `WorkspaceClient.sendWithResponse` path, which
      // resolves its requestId-keyed promise from `delete-worktree-result`.
      this.sendEvent({
        type: "delete-worktree-result",
        requestId,
        success: false,
        error: (error as Error).message,
      });
      // Re-throw so the port path (`handleWorktreePortRequest`) can reject the
      // port `request()` with the same error string — without the throw, the
      // port handler returns `{ ok: true }` and the renderer's outbox prunes
      // the entry as if the delete succeeded, silently masking the failure
      // (#8405 review finding #1). Legacy callers can opt out by omitting
      // `mutationId` and the `throwOnError` flag (`WorkspaceClient.sendWithResponse`
      // resolves via the delete-worktree-result event, not the promise return).
      if (throwOnError) throw error;
    }
  }

  private async removeGitWorktreeWithRetry(
    git: SimpleGit,
    args: string[],
    worktreePath: string
  ): Promise<"removed" | "stale"> {
    for (let attempt = 0; ; attempt++) {
      try {
        await git.raw(args);
        return "removed";
      } catch (removeError) {
        const message = (removeError as Error).message || "";
        if (message.includes("is not a working tree")) {
          return "stale";
        }

        const delayMs = WORKTREE_REMOVE_LOCK_RETRY_DELAYS_MS[attempt];
        if (delayMs !== undefined && isTransientWorktreeRemoveLockError(removeError)) {
          console.warn(
            `[WorkspaceHost] worktree remove hit a transient filesystem lock for ${worktreePath}; retrying in ${delayMs}ms`
          );
          await sleep(delayMs);
          continue;
        }

        throw removeError;
      }
    }
  }

  async listBranches(requestId: string, rootPath: string): Promise<void> {
    try {
      const git = await createHardenedGit(rootPath);
      // The date pass is optional enrichment, so it settles independently:
      // `readBranchCommitterDates` resolves to an empty map on failure rather
      // than rejecting, which keeps a metadata error from failing the list.
      const [summary, committerDates] = await Promise.all([
        git.branch(["-a"]) as Promise<BranchSummary>,
        readBranchCommitterDates(git),
      ]);
      const branches: BranchInfo[] = [];

      for (const [branchName, branchDetail] of Object.entries(summary.branches)) {
        if (
          branchName.includes("HEAD ->") ||
          branchName.endsWith("/HEAD") ||
          branchName.startsWith("(")
        ) {
          continue;
        }

        const isRemote = branchName.startsWith("remotes/");
        const displayName = isRemote ? branchName.replace("remotes/", "") : branchName;

        branches.push({
          name: displayName,
          current: branchDetail.current,
          commit: branchDetail.commit,
          remote: isRemote ? displayName.split("/")[0] : undefined,
          committerDate: committerDates.get(branchRefName(displayName, isRemote)),
        });
      }

      this.sendEvent({ type: "list-branches-result", requestId, branches });
    } catch (error) {
      this.sendEvent({
        type: "list-branches-result",
        requestId,
        branches: [],
        error: (error as Error).message,
      });
    }
  }

  /**
   * Fetch a PR's head into a local branch.
   *
   * `remoteName` is the forge remote resolved in main (#11747) — the PR ref
   * only exists on the repository the PR was opened against, so with GitHub
   * configured as `upstream` a fetch from `origin` fails outright with
   * "couldn't find remote ref". Defaults to `origin` when the caller can't
   * resolve one, which is the pre-fix behavior.
   *
   * The refspec itself stays GitHub-shaped (`pull/<n>/head`, also served by
   * Gitea and Forgejo). GitLab's `merge-requests/<n>/head` and Bitbucket's
   * variants would need per-provider refspec mapping — a separate gap this
   * doesn't claim to close.
   */
  async fetchPRBranch(
    requestId: string,
    rootPath: string,
    prNumber: number,
    headRefName: string,
    remoteName?: string
  ): Promise<void> {
    try {
      const git = await createAuthenticatedGit(rootPath);
      const remote = remoteName && remoteName.length > 0 ? remoteName : "origin";
      await git.raw(["fetch", remote, `pull/${prNumber}/head:${headRefName}`]);
      this.sendEvent({ type: "fetch-pr-branch-result", requestId, success: true });
    } catch (error) {
      const gitReason = classifyGitError(error);
      this.sendEvent({
        type: "fetch-pr-branch-result",
        requestId,
        success: false,
        error: (error as Error).message,
        gitReason,
        recoveryAction: getGitRecoveryAction(gitReason),
      });
    }
  }

  async getRecentBranches(requestId: string, rootPath: string): Promise<void> {
    try {
      const git = await createHardenedGit(rootPath);
      const rawReflog = await git.raw(["reflog", "--format=%gs"]);

      if (!rawReflog?.trim()) {
        this.sendEvent({ type: "get-recent-branches-result", requestId, branches: [] });
        return;
      }

      const seen = new Set<string>();
      const branches: string[] = [];
      const checkoutRegex = /^checkout: moving from \S+ to (\S+)$/;

      for (const line of rawReflog.split("\n")) {
        const m = line.match(checkoutRegex);
        if (!m) continue;
        const name = m[1].trim();
        if (/^[0-9a-f]{40}$/i.test(name)) continue;
        if (!seen.has(name)) {
          seen.add(name);
          branches.push(name);
        }
      }

      this.sendEvent({ type: "get-recent-branches-result", requestId, branches });
    } catch {
      this.sendEvent({ type: "get-recent-branches-result", requestId, branches: [] });
    }
  }

  async getFileDiff(
    requestId: string,
    cwd: string,
    filePath: string,
    status: string,
    ignoreWhitespace?: boolean,
    offset?: number,
    maxBytes?: number
  ): Promise<void> {
    // A sentinel is a marker, not diff content — it is never windowed, and
    // totalBytes 0 is what tells the caller to read `diff` as a marker.
    const sendSentinel = (diff: string): void => {
      this.sendEvent({
        type: "get-file-diff-result",
        requestId,
        diff,
        offset: 0,
        totalBytes: 0,
        truncated: false,
        nextOffset: null,
      });
    };

    const sendWindow = (diff: string): void => {
      const window = sliceUtf8Window(
        diff,
        offset ?? 0,
        Math.min(maxBytes ?? GIT_FILE_DIFF_MAX_BYTES, GIT_FILE_DIFF_MAX_BYTES)
      );
      this.sendEvent({
        type: "get-file-diff-result",
        requestId,
        diff: window.content,
        offset: window.offset,
        totalBytes: window.totalBytes,
        truncated: window.truncated,
        nextOffset: window.nextOffset,
      });
    };

    try {
      const { resolve, normalize, sep, isAbsolute } = await import("path");

      if (isAbsolute(filePath)) {
        throw new Error("Absolute paths are not allowed");
      }

      const normalizedPath = normalize(filePath);
      const pathSegments = normalizedPath.split(/[\\/]+/).filter(Boolean);
      if (pathSegments.includes("..") || normalizedPath.startsWith(sep)) {
        throw new Error("Path traversal detected");
      }

      // Git always uses forward slashes in diff output, even on Windows
      const gitPath = normalizedPath.replaceAll("\\", "/");

      const absolutePath = resolve(cwd, normalizedPath);

      // Bounds peak memory: both branches materialize a full result before
      // windowing — the untracked one inlines the file, and git buffers a
      // tracked file's entire diff. The ceiling is 16x the 1MB cliff it
      // replaced, so the "large file, small diff" case that the old gate
      // wrongly refused now succeeds (#11531).
      try {
        const { stat } = await import("fs/promises");
        const stats = await stat(absolutePath);
        if (stats.size > GIT_FILE_DIFF_MAX_SOURCE_BYTES) {
          sendSentinel("FILE_TOO_LARGE");
          return;
        }
      } catch {
        // Fail open: a deleted tracked file has no worktree entry to stat, and
        // git still owes us its deletion diff. Only the size of a file that IS
        // present can be gated here — a large HEAD blob is not covered.
      }

      const git = await createHardenedGit(cwd);

      if (status === "untracked" || status === "added") {
        const { readFile } = await import("fs/promises");
        const buffer = await readFile(absolutePath);

        let isBinary = false;
        const checkLength = Math.min(buffer.length, 8192);
        for (let i = 0; i < checkLength; i++) {
          if (buffer[i] === 0) {
            isBinary = true;
            break;
          }
        }

        if (isBinary) {
          sendSentinel("BINARY_FILE");
          return;
        }

        const content = buffer.toString("utf-8");
        const lines = content.split("\n");

        const diff = `diff --git a/${gitPath} b/${gitPath}
new file mode 100644
--- /dev/null
+++ b/${gitPath}
@@ -0,0 +1,${lines.length} @@
${lines.map((l) => "+" + l).join("\n")}`;

        sendWindow(diff);
        return;
      }

      // `--no-textconv` blocks user-defined diff drivers that would otherwise
      // execute arbitrary binaries via `.gitattributes` textconv mappings.
      const diff = await git.diff([
        "HEAD",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
        "--",
        normalizedPath,
      ]);

      if (isBinaryDiffOutput(diff)) {
        sendSentinel("BINARY_FILE");
        return;
      }

      if (!diff.trim()) {
        sendSentinel("NO_CHANGES");
        return;
      }

      sendWindow(diff);
    } catch (error) {
      this.sendEvent({
        type: "get-file-diff-result",
        requestId,
        diff: "",
        offset: 0,
        totalBytes: 0,
        truncated: false,
        nextOffset: null,
        error: (error as Error).message,
      });
    }
  }

  updateMonitorConfig(config: MonitorConfig): void {
    if (config.pollIntervalActive !== undefined) {
      this.pollIntervalActive = config.pollIntervalActive;
    }
    if (config.pollIntervalBackground !== undefined) {
      this.pollIntervalBackground = config.pollIntervalBackground;
    }
    if (config.adaptiveBackoff !== undefined) {
      this.adaptiveBackoff = config.adaptiveBackoff;
    }
    if (config.pollIntervalMax !== undefined) {
      this.pollIntervalMax = config.pollIntervalMax;
    }
    if (config.fetchIntervalActiveMs !== undefined) {
      this.fetchIntervalActiveMs = config.fetchIntervalActiveMs;
    }
    if (config.fetchIntervalBackgroundMs !== undefined) {
      this.fetchIntervalBackgroundMs = config.fetchIntervalBackgroundMs;
    }

    let watcherCapChanged = false;
    if (config.backgroundGitWatcherCap !== undefined) {
      const normalized = this.normalizeWatcherCap(config.backgroundGitWatcherCap);
      if (normalized !== this.backgroundGitWatcherCap) {
        this.backgroundGitWatcherCap = normalized;
        watcherCapChanged = true;
      }
    }

    for (const [worktreeId, monitor] of this.monitors) {
      const isActive = worktreeId === this.activeWorktreeId;
      const baseInterval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;
      monitor.updateConfig({
        basePollingInterval: baseInterval,
        fetchIntervalActiveMs: this.throttledFetchActiveMs,
        fetchIntervalBackgroundMs: this.throttledFetchBackgroundMs,
      });
    }

    // A shrunk cap (e.g. profile → efficiency) must immediately evict the
    // now-over-budget background watchers; a grown cap re-arms freed slots.
    if (watcherCapChanged) {
      this.applyWatcherBudget();
    }
  }

  /**
   * Focused-tier fetch interval with the active GitHub rate-limit throttle
   * folded in. Used everywhere a monitor's fetch cadence is (re)written —
   * syncMonitors, addNewWorktreeMonitor, updateMonitorConfig — so an unrelated
   * config push can't silently clobber an in-effect throttle back to baseline.
   */
  private get throttledFetchActiveMs(): number {
    return Math.round(this.fetchIntervalActiveMs * this._lastAppliedThrottleMultiplier);
  }

  /** Background-tier fetch interval with the active throttle folded in. */
  private get throttledFetchBackgroundMs(): number {
    return Math.round(this.fetchIntervalBackgroundMs * this._lastAppliedThrottleMultiplier);
  }

  /**
   * Apply a GitHub rate-limit cadence multiplier to every monitor's background
   * fetch scheduler.
   *
   * The multiplier always scales the user-configured base intervals
   * (`fetchIntervalActiveMs` / `fetchIntervalBackgroundMs`) — never an
   * already-throttled value — so repeated calls can't compound. When the
   * multiplier returns to `1` (budget recovered), each scheduler is re-armed at
   * the short startup-tier delay so fresh ahead/behind data lands promptly
   * instead of waiting out a previously-stretched window.
   *
   * Driven by `gitHubRateLimitService` budget notifications relayed through the
   * workspace-host `onStateChange` handler.
   */
  applyFetchThrottle(multiplier: number): void {
    const safeMultiplier = Number.isFinite(multiplier) && multiplier >= 1 ? multiplier : 1;
    const previous = this._lastAppliedThrottleMultiplier;
    const recovered = safeMultiplier === 1 && previous > 1;

    const activeMs = Math.round(this.fetchIntervalActiveMs * safeMultiplier);
    const backgroundMs = Math.round(this.fetchIntervalBackgroundMs * safeMultiplier);

    for (const monitor of this.monitors.values()) {
      monitor.updateConfig({
        fetchIntervalActiveMs: activeMs,
        fetchIntervalBackgroundMs: backgroundMs,
      });
      if (recovered) {
        monitor.rescheduleFetch(true);
      }
    }

    this._lastAppliedThrottleMultiplier = safeMultiplier;
  }

  setPollingEnabled(enabled: boolean): void {
    if (this.pollingEnabled === enabled) return;

    this.pollingEnabled = enabled;

    if (!enabled) {
      this.topologyWatcher.stop();
      for (const monitor of this.monitors.values()) {
        monitor.pausePolling();
      }
    } else if (this.gitBacked === false) {
      // Foregrounding must not start the topology watcher for a workspace with
      // no repository — `loadProject` deliberately never started it, and this is
      // the one path that would otherwise revive it (#11405).
    } else {
      for (const monitor of this.monitors.values()) {
        monitor.resumePolling();
      }
      void this.topologyWatcher.startWatcher();
      // stop() (run on the !enabled branch) cleared the safety timer, so
      // resume must restart it symmetrically (#8510).
      this.topologyWatcher.startSafetyTimer();
      this.topologyWatcher.scheduleReconcile();
    }
  }

  pause(): void {
    console.log("[WorkspaceService] Pausing (backgrounded)");
    this.setPollingEnabled(false);
    this.prService.pause();
    try {
      os.setPriority(process.pid, os.constants.priority.PRIORITY_LOW);
    } catch {
      // Sandboxed environments may deny setpriority — non-fatal
    }
  }

  resume(): void {
    console.log("[WorkspaceService] Resuming (foregrounded)");
    try {
      os.setPriority(process.pid, os.constants.priority.PRIORITY_NORMAL);
    } catch {
      // Sandboxed environments may deny setpriority — non-fatal
    }
    this.setPollingEnabled(true);
    this.prService.resume();
  }

  getPRStatus(requestId: string): void {
    const prStatus = this.prService.getStatus();
    this.sendEvent({ type: "get-pr-status-result", requestId, status: prStatus });
  }

  resetPRState(requestId: string): void {
    this.prService.resetPRState(this.projectRootPath, this.projectId);
    this.sendEvent({ type: "reset-pr-state-result", requestId, success: true });
  }

  updateForgeSettings(args: {
    forgeProviderOverride: string | null;
    forgeDefaultProviderId: string | null;
    forgeRemote: string | null;
  }): void {
    const remoteSelectionChanged = args.forgeRemote !== this.forgeRemoteName;
    this.forgeRemoteName = args.forgeRemote;
    pullRequestService.setForgeSettings(args);
    void pullRequestService.refresh();
    // The remote table on disk is unchanged, so the signature-gated reprobe
    // would never fire — but the remote we *select* from it just moved, which
    // changes the matched provider for every monitor (#11408).
    if (remoteSelectionChanged) {
      this.forgeReselectRetries = 0;
      void this.reselectForgeRemote();
    }
  }

  /**
   * Re-run remote selection after the `forgeRemote` setting changed. Unlike
   * `reprobeForgeRemotes` this deliberately skips the `.git/config`
   * fingerprint and signature gates: neither moved, only the choice did.
   */
  private scheduleForgeReselect(): void {
    // A folder with no repository has no remotes to reselect from, and
    // `forgeProbeCwd` falls back to the project root — so without this the
    // matcher relay would spawn `git remote -v` there and, on its bounded
    // re-arm, up to three more times per registry change (#11405 × #11408).
    if (this.gitBacked === false) return;
    if (this._shutdownController.signal.aborted) return;
    if (this.forgeReselectTimer) return;
    this.forgeReselectTimer = setTimeout(() => {
      this.forgeReselectTimer = null;
      void this.reselectForgeRemote();
    }, FORGE_REMOTE_REPROBE_DEBOUNCE_MS);
  }

  private async reselectForgeRemote(): Promise<void> {
    // Guarded here as well as in `scheduleForgeReselect`: `updateForgeSettings`
    // calls this one directly, so the debounced path is not the only way in.
    if (this.gitBacked === false) return;
    const cwd = this.forgeProbeCwd();
    if (!cwd) return;
    // Its OWN sequence — it only makes two rapid setting changes land in order.
    const seq = ++this.forgeReselectSeq;
    // Snapshot WITHOUT bumping: bumping `forgeRemoteProbeSeq` would cancel an
    // in-flight `reprobeForgeRemotes` before it consumed its fingerprint,
    // silently dropping a real `.git/config` change until the next watcher
    // event. Yielding to it instead is safe — a reprobe re-reads the table
    // with the current `forgeRemoteName`, so its result already reflects this
    // settings change. The same check covers teardown and project switch,
    // which bump the probe seq in `stopForgeRemoteDetection`.
    const probeSeq = this.forgeRemoteProbeSeq;
    const probed = await this.readForgeRemotes(cwd);
    // A newer reselect is already authoritative — drop this one outright.
    if (seq !== this.forgeReselectSeq) return;
    // The other two bail-outs are NOT terminal, so they re-arm the debounce
    // instead of returning. A config probe that superseded us may itself have
    // exited at its fingerprint gate without ever reading the remotes, and a
    // failed enumeration leaves monitors pointing at the previously selected
    // remote. Either way the new selection would otherwise never be applied,
    // and nothing else would retry: `.git/config` did not change, so the
    // fingerprint-gated backstop skips this repo entirely.
    if (!probed || probeSeq !== this.forgeRemoteProbeSeq) {
      // Bounded: a repo that was deleted under us fails enumeration forever,
      // and an unbounded re-arm would spawn a git process every debounce tick
      // for the life of the host.
      if (this.forgeReselectRetries < FORGE_RESELECT_MAX_RETRIES) {
        this.forgeReselectRetries++;
        this.scheduleForgeReselect();
      }
      return;
    }
    this.forgeReselectRetries = 0;
    if (this._shutdownController.signal.aborted) return;

    const matchedProviderId = probed.fetchUrl
      ? matchProviderForRemoteUrl(probed.fetchUrl, this.forgeProviderMatchers)
      : null;
    for (const monitor of this.monitors.values()) {
      if (!monitor.isRunning) continue;
      monitor.setRemoteFetchUrl(probed.fetchUrl);
      monitor.setMatchedForgeProviderId(matchedProviderId);
    }
  }

  /**
   * Main registered a new forge provider descriptor (startup scan or runtime
   * plugin install/enable). Wake the PR service if its polling paused on a
   * "no provider matches" resolution (#9997). Routed straight to the
   * singleton, mirroring `updateForgeSettings` above.
   */
  notifyForgeProviderRegistryUpdated(): void {
    pullRequestService.notifyForgeProviderRegistryUpdated();
  }

  updateForgeCredentials(
    providerId: string,
    credentials: import("../../shared/types/forge.js").Credentials | null
  ): void {
    this.prService.updateForgeCredentials(
      providerId,
      credentials,
      this.projectRootPath,
      this.projectId
    );
    if (credentials) {
      // A new credential may resolve previously-failing auth — drop suspensions so
      // the next scheduled fetch retries. Network/transient entries stay so we
      // don't immediately re-storm an offline remote.
      this.fetchCoordinator.clearAuthFailures();
      // Re-arm the escalation guard so a credential that's still broken can
      // surface its toast again after this attempt.
      this.authFailureConfirmedNotified.clear();
      // Trigger an opportunistic fetch on every worktree so the user sees
      // refreshed counts shortly after sign-in / token rotation.
      for (const monitor of this.monitors.values()) {
        if (monitor.isRunning) {
          void monitor.triggerFetchNow();
        }
      }
    }
  }

  /**
   * User-triggered retry of auth-suspended fetches. Auth failures back off on a
   * widening exponential schedule (RepoFetchCoordinator), so an explicit user
   * action — e.g. clicking the auth-failed sync badge — clears the suspension
   * and re-fetches immediately rather than waiting for the next backoff window.
   * Mirrors the credential branch of updateForgeCredentials but without a
   * credential update (the user may be retrying after fixing the token elsewhere).
   */
  retryAuthFetch(): void {
    this.fetchCoordinator.clearAuthFailures();
    // Re-arm the per-commondir escalation guard so a still-broken credential
    // can re-surface its toast after this retry confirms the failure again.
    this.authFailureConfirmedNotified.clear();
    for (const monitor of this.monitors.values()) {
      if (monitor.isRunning) {
        void monitor.triggerFetchNow();
      }
    }
  }

  private initializePRService(): Promise<void> {
    if (!this.projectRootPath || !this.projectId) {
      return Promise.resolve();
    }

    return this.prService.initialize(this.projectRootPath, this.projectId, () => {
      const candidates: Array<{
        worktreeId: string;
        branch?: string;
        issueNumber?: number;
        isMainWorktree?: boolean;
      }> = [];
      for (const monitor of this.monitors.values()) {
        candidates.push({
          worktreeId: monitor.id,
          branch: monitor.branch,
          issueNumber: monitor.issueNumber,
          isMainWorktree: monitor.isMainWorktree,
        });
      }
      return candidates;
    });
  }

  async onProjectSwitch(requestId: string): Promise<void> {
    this.topologyWatcher.stop();
    // Stop the WSL distro poller before clearing monitors so a poll tick can't
    // fire setWslEligible against a half-torn-down or next-project monitor map.
    this.stopWslDistroPoller();
    this.topologyWatcher.clearQueue();
    this.prService.cleanup();

    for (const id of this.monitors.keys()) {
      this.resourceActionExecutor.cleanupResourceActionState(id);
    }
    for (const monitor of this.monitors.values()) {
      monitor.stop();
    }
    this.monitors.clear();
    this.backgroundGitWatcherLru.clear();
    this.agentActiveWorktreeIds.clear();
    // Drop in-flight fetch chains and per-repo failure state — the next
    // project's monitors get a clean coordinator and stale completions are
    // discarded by the generation guard.
    this.fetchCoordinator.destroy();
    // Reset the escalation guard so the same broken repo re-opened later can
    // re-surface its toast instead of being silently suppressed.
    this.authFailureConfirmedNotified.clear();
    this.pollQueue.clear();
    // Drops the forge-remote baseline with the project: the next one's own
    // start probe re-seeds it, and an in-flight probe from this project must
    // not signal against the incoming one.
    this.stopForgeRemoteDetection();

    this.activeWorktreeId = null;
    this.mainBranch = "main";
    this.git = null;
    this.projectRootPath = null;
    this.projectId = null;
    this.projectEnvVars = {};
    this.wslDefaultDistroPromise = null;
    this.wslLastKnownDefaultDistro = undefined;

    clearGitDirCache();
    clearGitCommonDirCache();
    this.listService.invalidateCache();
    this.listService.setGit(null, null);

    this.sendEvent({ type: "project-switch-result", requestId, success: true });
  }

  async switchWorktreeEnvironment(
    requestId: string,
    worktreeId: string,
    envKey: string
  ): Promise<void> {
    const monitor = this.monitors.get(worktreeId);
    if (!monitor) {
      this.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: "Worktree not found",
      });
      return;
    }

    monitor.setWorktreeMode(envKey);
    monitor.setWorktreeEnvironmentLabel(envKey);

    try {
      if (this.projectRootPath) {
        await this.runLifecycleSetup(worktreeId, monitor.path, this.projectRootPath, false, envKey);
      }
    } catch (err) {
      const message = formatErrorMessage(err, "switchWorktreeEnvironment lifecycle setup failed");
      const stack = err instanceof Error ? err.stack : undefined;
      console.warn(
        `[WorkspaceService] switchWorktreeEnvironment config resolution failed (non-fatal):`,
        err
      );
      this.sendEvent({
        type: "lifecycle-setup-error",
        worktreeId,
        message,
        details: stack,
      });
    }

    this.emitUpdate(monitor);
    this.sendEvent({
      type: "resource-action-result",
      requestId,
      success: true,
    });
  }

  async runResourceAction(
    requestId: string,
    worktreeId: string,
    action: "provision" | "teardown" | "resume" | "pause" | "status",
    environmentId?: string,
    options?: { origin?: "auto-poll" }
  ): Promise<{ success: boolean; error?: string; output?: string }> {
    return this.resourceActionExecutor.runResourceAction(
      requestId,
      worktreeId,
      action,
      environmentId,
      options
    );
  }

  async hasResourceConfig(rootPath: string): Promise<boolean> {
    if (!this.projectRootPath) {
      return false;
    }
    const config = await this.lifecycleService.loadConfig(rootPath, this.projectRootPath);
    if (config?.resource || config?.resources) return true;
    const envs = await this.lifecycleService.loadProjectResourceEnvironments(this.projectRootPath);
    return envs !== null && Object.keys(envs).length > 0;
  }

  private async loadProjectEnvVars(projectId: string): Promise<Record<string, string>> {
    try {
      const userDataDir = process.env.DAINTREE_USER_DATA ?? "";
      if (!userDataDir) return {};
      // Settings live under `<userData>/projects/<id>/settings.json` (see
      // ProjectStore's `projectsConfigDir`). DAINTREE_USER_DATA is the bare
      // userData root, so the `projects` segment must be added here — without it
      // the read silently missed and env vars never reached the host (#11282).
      const filePath = settingsFilePath(pathResolve(userDataDir, "projects"), projectId);
      if (!filePath) return {};
      const raw = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const envVars = (parsed as Record<string, unknown>).environmentVariables;
      if (!envVars || typeof envVars !== "object" || Array.isArray(envVars)) return {};
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(envVars as Record<string, unknown>)) {
        if (typeof k === "string" && typeof v === "string") {
          result[k] = v;
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  dispose(): void {
    this._shutdownController.abort();
    // stop() clears the pending sets and their safety timers.
    this.topologyWatcher.stop();
    this.stopWslDistroPoller();
    this.topologyWatcher.clearQueue();
    this.prService.cleanup();
    this.resourceActionExecutor.dispose();
    for (const monitor of this.monitors.values()) {
      monitor.stop();
    }
    this.monitors.clear();
    this.backgroundGitWatcherLru.clear();
    this.agentActiveWorktreeIds.clear();
    this.fetchCoordinator.destroy();
    this.authFailureConfirmedNotified.clear();
    this.pollQueue.clear();
    this.stopForgeRemoteDetection();
    this.listService.invalidateCache();
  }
}
