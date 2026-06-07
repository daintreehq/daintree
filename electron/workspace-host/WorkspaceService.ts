import os from "os";
import { randomUUID } from "node:crypto";
import PQueue from "p-queue";
import { existsSync } from "fs";
import { stat, readFile, access, mkdir } from "fs/promises";
import { resolve as pathResolve, isAbsolute, dirname, basename } from "path";
import { validateBranchName } from "../../shared/utils/pathPattern.js";
import { generateProjectId, settingsFilePath } from "../services/projectStorePaths.js";
import { SimpleGit, BranchSummary } from "simple-git";
import { createHardenedGit, createAuthenticatedGit } from "../utils/hardenedGit.js";
import { classifyGitError, getGitRecoveryAction } from "../../shared/utils/gitOperationErrors.js";
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
import type { CIStatus, NormalizedPRState } from "../../shared/types/forge.js";
import { invalidateGitStatusCache } from "../utils/git.js";
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
import { waitForPathExists } from "../utils/fs.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import {
  probeGitLfsAvailable,
  isGitHubRemoteUrl,
  parseCheckedOutBranches,
  nextAvailableBranchName,
  ensureNoteFile,
  assertWorktreePathContained,
} from "./worktreeUtils.js";
import { applyResourceConfigToMonitor } from "./resourceConfigHelpers.js";
import { ResourceActionExecutor } from "./ResourceActionExecutor.js";
import parcelWatcher from "@parcel/watcher";
import { MutableDisposable } from "../utils/lifecycle.js";

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
// Periodic safety-net reconcile cadence. On macOS the FSEvents-backed topology
// watcher goes silent when `.git/worktrees/` is deleted (last worktree removed)
// and `startTopologyWatcher()` no-ops when that dir is absent — so a phantom row
// can persist until the 300s background poll happens to hit the fs.access check.
// This interval bounds that staleness independent of watcher liveness (#8510).
const TOPOLOGY_SAFETY_INTERVAL_MS = 90_000;

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

export class WorkspaceService {
  private monitors = new Map<string, WorktreeMonitor>();
  private pollQueue = new PQueue({ concurrency: 3 });
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
  private gitWatchDebounceMs: number = 300;
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
  private git: SimpleGit | null = null;
  private pollingEnabled: boolean = true;
  private projectRootPath: string | null = null;
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
  /** How often to re-check the WSL default distro (Windows only). */
  private static readonly WSL_DISTRO_POLL_INTERVAL_MS = 60_000;

  // Topology watcher — watches `.git/worktrees/` for external worktree
  // create/delete and triggers serialized reconciliation.
  private topologyWatcherSubscription = new MutableDisposable();
  private topologyReconcileQueue = new PQueue({ concurrency: 1 });
  private topologyReconcilePending = false;
  // App-owned worktree create/delete register the metadata-subdir basename
  // here so the watcher event their own `git worktree add/remove` produces is
  // recognized and dropped — instead of blanket-suppressing *all* watcher
  // events for a fixed window, which silently swallowed concurrent external
  // `git worktree remove` calls (#8412). External events whose basename isn't
  // pending still flow through to reconciliation.
  private topologyPendingCreate = new Set<string>();
  private topologyPendingDelete = new Set<string>();
  private topologyPendingSafetyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Events accumulate here across the 300ms debounce window and are filtered
  // against the pending sets at drain time, preserving burst coalescing.
  private topologyEventBuffer: Array<{ path: string; type?: string }> = [];
  private topologyWatchCooldownUntil = 0;
  private topologyWatchCooldownDirty = false;
  private topologyDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private topologyWatcherEnabled = true;
  private topologyWatcherGeneration = 0;
  // One-shot guard for the topology-watcher-dark signal (#9908). Set when the
  // subscribe() rejects at cold start or a 5s pending-event safety valve
  // expires — both mean the watcher is silently unreliable and the worktree
  // list may drift. Cleared only by a *successful* `runTopologyReconcile()`
  // (not by the watcher re-arming), because subscription success doesn't prove
  // the topology was re-verified (#8516/#8558).
  private topologyWatcherDarkNotified = false;
  // Watcher-independent safety net (#8510): the topology watcher can go
  // permanently silent (macOS FSEvents root deletion) or never start (metadata
  // dir absent), so a periodic reconcile bounds phantom-row staleness. Calls
  // are no-ops while paused/disabled via scheduleTopologyReconcile's guards.
  private periodicSafetyTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlightWorktreeCreates = new Map<string, Promise<string>>();

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
        const monitor = this.monitors.get(worktreeId);
        if (!monitor || !monitor.isRunning) return;
        // A successful fetch updated remote refs, so the next `rev-list` for
        // ahead/behind will return fresh counts. Trigger a status refresh
        // immediately rather than waiting for the next poll tick — but
        // fire-and-forget; fetch success must never block.
        monitor.triggerRefreshIfUpdating();
      },
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
  }

  async loadProject(
    requestId: string,
    projectRootPath: string,
    globalEnvVars?: Record<string, string>,
    wslGitByWorktree?: Record<string, { enabled: boolean; dismissed: boolean }>,
    forgeSettings?: {
      forgeProviderOverride: string | null;
      forgeDefaultProviderId: string | null;
      forgeRemote: string | null;
    }
  ): Promise<void> {
    try {
      this.projectRootPath = projectRootPath;
      if (wslGitByWorktree && typeof wslGitByWorktree === "object") {
        // Merge instead of replacing: a `set-wsl-opt-in` message arriving
        // during this load-project's async work would otherwise be silently
        // overwritten. The most recent in-memory value wins on conflict.
        this.wslGitByWorktree = { ...wslGitByWorktree, ...this.wslGitByWorktree };
      }
      if (forgeSettings) {
        pullRequestService.setForgeSettings(forgeSettings);
      }
      // Merge: global (lowest priority) < project-level < DAINTREE_* (set in buildEnv)
      const projectEnvVars = await this.loadProjectEnvVars(projectRootPath);
      this.projectEnvVars = { ...(globalEnvVars ?? {}), ...projectEnvVars };
      this.git = createHardenedGit(projectRootPath, this._shutdownController.signal);
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
      const worktrees = this.listService.mapToWorktrees(rawWorktrees);

      // Run the LFS probe concurrently with monitor sync so we don't add its
      // 3s worst case on top of sync latency. The probe is a read-only CLI
      // check (no PATH side-effects); its result travels on the load-project
      // event so the renderer can warn proactively when a repo uses LFS.
      const [, lfsAvailable] = await Promise.all([
        this.syncMonitors(worktrees, this.activeWorktreeId, this.mainBranch, undefined, true),
        probeGitLfsAvailable(),
      ]);

      this.startTopologyWatcher();
      // Started independently of startTopologyWatcher() — that method no-ops
      // when `.git/worktrees/` is absent (the exact "all worktrees removed"
      // case), so gating the safety net on it would defeat its purpose (#8510).
      if (this.pollingEnabled) {
        this.startPeriodicSafetyTimer();
      }

      this.sendEvent({ type: "load-project-result", requestId, success: true, lfsAvailable });

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
      this.sendEvent({
        type: "load-project-result",
        requestId,
        success: false,
        error: (error as Error).message,
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

    // Remove stale monitors
    for (const [id, monitor] of this.monitors) {
      if (!currentIds.has(id)) {
        if (monitor.isMainWorktree) {
          console.warn("[WorkspaceHost] Blocked removal of main worktree monitor");
          continue;
        }

        if (this.activeWorktreeId === id) {
          this.activeWorktreeId = null;
        }

        this.resourceActionExecutor.cleanupResourceActionState(id);
        monitor.stop();
        this.monitors.delete(id);
        this.lruRemove(id);
        this.recoverWatcherIfNoMonitorsRemain();
        clearGitDirCache(monitor.path);
        invalidateGitStatusCache(monitor.path);
        this.sendEvent({
          type: "worktree-removed",
          worktreeId: id,
          epoch: this.epoch,
          seq: this.nextSeq(),
        });
        events.emit("sys:worktree:remove", { worktreeId: id, timestamp: Date.now() });
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
    if (this.wslDistroPoller) {
      clearInterval(this.wslDistroPoller);
      this.wslDistroPoller = null;
    }
  }

  /**
   * One poll tick: re-probe the default distro and, when it changed, invalidate
   * the cache and refresh every WSL monitor's eligibility so existing worktrees
   * stop using a stale decision.
   */
  private async pollWslDefaultDistro(): Promise<void> {
    const current = await getDefaultWslDistro().catch(() => null);
    if (current === this.wslLastKnownDefaultDistro) return;
    this.wslLastKnownDefaultDistro = current;
    this.wslDefaultDistroPromise = Promise.resolve(current);
    this.refreshWslEligibilityForAllMonitors(current);
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
    const current = await getDefaultWslDistro().catch(() => null);
    this.wslLastKnownDefaultDistro = current;
    this.wslDefaultDistroPromise = Promise.resolve(current);
    this.refreshWslEligibilityForAllMonitors(current);
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
    // Reconcile LRU membership against live monitors: the active worktree must
    // never be in the pool; every other running monitor must be present.
    for (const id of [...this.backgroundGitWatcherLru.keys()]) {
      if (!this.monitors.has(id) || id === this.activeWorktreeId) {
        this.backgroundGitWatcherLru.delete(id);
      }
    }
    for (const id of this.monitors.keys()) {
      if (id !== this.activeWorktreeId && !this.backgroundGitWatcherLru.has(id)) {
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
    // Grant the surviving MRU tail.
    for (let i = cutoff; i < ids.length; i++) {
      this.monitors.get(ids[i])?.setGitWatchBudgetAllowed(true);
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
        onScheduleFetch: async (worktreeId, _isCurrent, force) => {
          const target = this.monitors.get(worktreeId);
          if (!target || !target.isRunning) return;
          const result = await this.fetchCoordinator.fetchForWorktree({
            worktreeId,
            worktreePath: target.path,
            force,
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
          this.applyFetchResultToSiblings(target, {
            lastFetchedAt: result.lastFetchedAt ?? null,
            authFailed: result.authFailed ?? false,
            networkFailed: result.networkFailed ?? false,
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

    this.monitors.set(wt.id, monitor);

    if (isActive) {
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

    // Resolve origin → github.com? once at monitor start. Setter re-emits the
    // snapshot only if the value differs from the initial `false`, so this is
    // a no-op for the (small) set of non-GitHub repos.
    void this.probeGitHubRemoteAsync(monitor);
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

  private handleMonitorUpdate(monitor: WorktreeMonitor, _snapshot: WorktreeSnapshot): void {
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
   * `getGitCommonDir` is synchronous and cached, so the O(n) scan is cheap
   * after the first call per worktree.
   *
   * Note: `isFetchInFlight` is intentionally excluded from this fan-out —
   * propagating per-monitor in-flight state to N sibling rows would produce
   * simultaneous pulse animations across the sidebar, recreating the visual
   * fatigue pattern that drove removal of the `panel-state-working` breathe
   * loop. Only the row that triggered the fetch shows the in-flight pulse.
   */
  private applyFetchResultToSiblings(
    triggering: WorktreeMonitor,
    result: { lastFetchedAt: number | null; authFailed: boolean; networkFailed: boolean }
  ): void {
    const triggeringCommonDir = getGitCommonDir(triggering.path, { logErrors: false });
    if (!triggeringCommonDir) {
      // Without a commondir we can't identify siblings. Apply to the
      // triggering monitor only — its own card still benefits.
      triggering.setFetchState(result.lastFetchedAt, result.authFailed, result.networkFailed);
      return;
    }
    for (const monitor of this.monitors.values()) {
      if (!monitor.isRunning) continue;
      const monitorCommonDir = getGitCommonDir(monitor.path, { logErrors: false });
      if (monitorCommonDir === triggeringCommonDir) {
        monitor.setFetchState(result.lastFetchedAt, result.authFailed, result.networkFailed);
      }
    }
  }

  /**
   * Probe origin's fetch URL once and tell the monitor whether it points at
   * github.com. Runs off the critical path — failures are silent (the
   * affordance simply stays hidden, which matches the non-GitHub behavior).
   */
  private async probeGitHubRemoteAsync(monitor: WorktreeMonitor): Promise<void> {
    try {
      const git = createHardenedGit(monitor.path);
      const remotes = await git.getRemotes(true);
      const origin = remotes.find((r) => r.name === "origin") ?? remotes[0];
      const fetchUrl = origin?.refs?.fetch;
      monitor.setIsGitHubRemote(isGitHubRemoteUrl(fetchUrl));
    } catch {
      // Remote probe is best-effort; keep the affordance hidden on failure.
    }
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
   * Whether any worktree's recursive watcher is currently degraded to the
   * polling/git-only fallback. Bundled into the `get-all-states` handshake so
   * a late-mounting view hydrates the persistent indicator without waiting
   * for a live event.
   */
  isWatcherDegraded(): boolean {
    return this.inotifyLimitNotified || this.emfileLimitNotified;
  }

  /**
   * The topology watcher went dark: its subscribe() failed at cold start, or a
   * pending-event safety valve expired without the matching watcher event
   * arriving. Either way the worktree list may silently drift out of date.
   * One-shot — a second dark trigger while already dark is a no-op so the
   * renderer indicator isn't re-asserted on every stale tick.
   */
  private handleTopologyWatcherDark(): void {
    if (this.topologyWatcherDarkNotified) return;
    this.topologyWatcherDarkNotified = true;
    this.sendEvent({ type: "topology-watcher-dark" });
  }

  /**
   * A topology reconcile completed successfully after a dark period, so the
   * worktree list is current again. Clears the one-shot guard and emits
   * `topology-watcher-recovered` so the renderer hides the indicator. No-op
   * when not dark, so calling it after every reconcile is harmless.
   */
  private handleTopologyWatcherRecovered(): void {
    if (!this.topologyWatcherDarkNotified) return;
    this.topologyWatcherDarkNotified = false;
    this.sendEvent({ type: "topology-watcher-recovered" });
  }

  /**
   * Whether the topology watcher is currently dark. Bundled into the
   * `get-all-states` handshake so a late-mounting view hydrates the indicator
   * without waiting for a live event (mirrors `isWatcherDegraded`).
   */
  isTopologyWatcherDark(): boolean {
    return this.topologyWatcherDarkNotified;
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

  private worktreeMetadataDirPath(): string | null {
    if (!this.projectRootPath) return null;
    const commonDir = getGitCommonDir(this.projectRootPath);
    if (!commonDir) return null;
    return `${commonDir}/worktrees`;
  }

  // Idempotent: a second call while the timer is live is a no-op, so the two
  // call sites (load-project path + setPollingEnabled resume) can both invoke
  // it unconditionally. Cleared in stopTopologyWatcher() (which dispose() and
  // the pause path both call), so the timer never outlives the service.
  private startPeriodicSafetyTimer(): void {
    if (this.periodicSafetyTimer !== null) return;
    const timer = setInterval(() => {
      this.scheduleTopologyReconcile();
    }, TOPOLOGY_SAFETY_INTERVAL_MS);
    timer.unref?.();
    this.periodicSafetyTimer = timer;
  }

  private startTopologyWatcher(): void {
    if (!this.topologyWatcherEnabled) return;
    if (this.topologyWatcherSubscription.value) return;

    const metadataDir = this.worktreeMetadataDirPath();
    if (!metadataDir) return;
    if (!existsSync(metadataDir)) return;

    const generation = ++this.topologyWatcherGeneration;
    const drain = () => this.drainTopologyEventBuffer();

    parcelWatcher
      .subscribe(metadataDir, (err, events) => {
        if (err) {
          // A runtime error on an established subscription means the watcher is
          // no longer reliably reporting changes — same consequence as a
          // subscribe-reject. Go dark; the periodic safety net reconciles.
          if (generation === this.topologyWatcherGeneration) {
            this.handleTopologyWatcherDark();
          }
        }
        if (Array.isArray(events)) {
          for (const ev of events) {
            const e = ev as { path?: unknown; type?: unknown } | null;
            if (typeof e?.path === "string") {
              this.topologyEventBuffer.push({
                path: e.path,
                type: typeof e.type === "string" ? e.type : undefined,
              });
            }
          }
        }
        if (this.topologyDebounceTimer) {
          clearTimeout(this.topologyDebounceTimer);
        }
        this.topologyDebounceTimer = setTimeout(drain, 300);
      })
      .then((subscription) => {
        if (generation !== this.topologyWatcherGeneration) {
          // stopTopologyWatcher incremented the generation — discard.
          subscription.unsubscribe();
          return;
        }
        if (this.topologyWatcherSubscription.value) {
          subscription.unsubscribe();
          return;
        }
        this.topologyWatcherSubscription.value = {
          dispose: () => subscription.unsubscribe(),
        };
      })
      .catch((err) => {
        if (generation !== this.topologyWatcherGeneration) {
          // A stop/restart superseded this attempt — the failure is moot.
          return;
        }
        console.warn(
          `[WorkspaceHost] topology watcher subscribe failed for ${metadataDir}: ${(err as Error).message}`
        );
        // No watcher events will ever arrive for this dir. Surface the dark
        // state so the renderer can offer a manual reconcile; the periodic
        // safety net (#8510) is the automatic recovery path.
        this.handleTopologyWatcherDark();
      });
  }

  private stopTopologyWatcher(): void {
    // Tearing the watcher down clears the dark state — there's no longer a
    // watcher whose silence matters. Emit recovery (only if dark) so a
    // pause/resume or project switch after a dark event doesn't pin the
    // renderer indicator on with nothing left to clear it (mirrors
    // recoverWatcherIfNoMonitorsRemain for the recursive watcher).
    this.handleTopologyWatcherRecovered();
    this.topologyWatcherGeneration++;
    this.topologyWatcherSubscription.value = undefined;
    if (this.topologyDebounceTimer) {
      clearTimeout(this.topologyDebounceTimer);
      this.topologyDebounceTimer = null;
    }
    this.topologyEventBuffer = [];
    // Drop pending entries: with no watcher running nothing will drain them,
    // and a stale entry surviving a pause/resume could suppress a real
    // external change for up to 5s after the watcher restarts.
    for (const timer of this.topologyPendingSafetyTimers.values()) {
      clearTimeout(timer);
    }
    this.topologyPendingSafetyTimers.clear();
    this.topologyPendingCreate.clear();
    this.topologyPendingDelete.clear();
    this.topologyReconcilePending = false;
    this.topologyWatchCooldownDirty = false;
    if (this.periodicSafetyTimer !== null) {
      clearInterval(this.periodicSafetyTimer);
      this.periodicSafetyTimer = null;
    }
  }

  // The basename of `.git/worktrees/<name>` is exactly what @parcel/watcher
  // reports for the create/delete of the metadata subdir, so it's the key we
  // match watcher events against. Resolve first so a trailing slash or a
  // relative path normalizes to the same leaf as the event path.
  private topologyMetadataKey(worktreePath: string): string {
    return basename(pathResolve(worktreePath));
  }

  private topologyMarkPending(key: string, set: Set<string>): void {
    set.add(key);
    const existing = this.topologyPendingSafetyTimers.get(key);
    if (existing) clearTimeout(existing);
    // Safety valve: if the watcher event never arrives (slow FS, missed
    // event), the entry must not suppress a later real external change
    // indefinitely. Clear-only — the cooldown/dirty path already reschedules
    // any reconcile genuinely needed.
    const timer = setTimeout(() => {
      this.topologyPendingCreate.delete(key);
      this.topologyPendingDelete.delete(key);
      this.topologyPendingSafetyTimers.delete(key);
      // The watcher never delivered the event our own op produced — it's
      // missing events, so it can't be trusted to catch external changes
      // either. Surface the dark state; the periodic safety net reconciles.
      this.handleTopologyWatcherDark();
    }, 5000);
    timer.unref?.();
    this.topologyPendingSafetyTimers.set(key, timer);
  }

  private topologyClearPending(key: string): void {
    this.topologyPendingCreate.delete(key);
    this.topologyPendingDelete.delete(key);
    const timer = this.topologyPendingSafetyTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.topologyPendingSafetyTimers.delete(key);
    }
  }

  private drainTopologyEventBuffer(): void {
    const events = this.topologyEventBuffer;
    this.topologyEventBuffer = [];

    let hasUnmatched = false;
    for (const ev of events) {
      const key = basename(ev.path);
      // Gate on event type so a pending *create* can't swallow an external
      // *delete* of a same-named worktree (and vice versa). An absent/unknown
      // type falls back to either set — better an idempotent reconcile than a
      // dropped external change.
      const matched =
        ev.type === "create"
          ? this.topologyPendingCreate.has(key)
          : ev.type === "delete"
            ? this.topologyPendingDelete.has(key)
            : this.topologyPendingCreate.has(key) || this.topologyPendingDelete.has(key);
      if (matched) {
        // App-owned op produced this event — drain the pending entry (and
        // cancel its safety valve) so a *subsequent* external change to the
        // same name is no longer treated as ours.
        this.topologyClearPending(key);
      } else {
        hasUnmatched = true;
      }
    }

    // Empty payloads can't be classified, so fall back to the pre-fix
    // behavior of always reconciling rather than risk dropping a real change.
    if (events.length === 0 || hasUnmatched) {
      this.scheduleTopologyReconcile();
    }
  }

  /**
   * Schedules a serialized topology reconcile (full worktree re-discovery).
   * Public so the `reconcile-topology` port action (the "Reconcile now"
   * recovery for the dark state, #9908) can drive it. Internal guards
   * (`topologyWatcherEnabled`, `pollingEnabled`, cooldown, in-flight) make it
   * safe to call from anywhere — concurrent requests coalesce.
   */
  scheduleTopologyReconcile(): void {
    if (!this.topologyWatcherEnabled) return;
    if (!this.pollingEnabled) return;
    if (Date.now() < this.topologyWatchCooldownUntil) {
      this.topologyWatchCooldownDirty = true;
      return;
    }
    if (this.topologyReconcilePending) {
      this.topologyWatchCooldownDirty = true;
      return;
    }

    this.topologyReconcilePending = true;
    this.topologyReconcileQueue.add(async () => {
      try {
        await this.runTopologyReconcile();
      } catch (err) {
        console.warn(`[WorkspaceHost] topology reconciliation failed: ${(err as Error).message}`);
      } finally {
        this.topologyReconcilePending = false;
        this.topologyWatchCooldownUntil = Date.now() + 2000;
        if (this.topologyWatchCooldownDirty) {
          this.topologyWatchCooldownDirty = false;
          const remaining = this.topologyWatchCooldownUntil - Date.now();
          setTimeout(() => this.scheduleTopologyReconcile(), Math.max(remaining, 0));
        }
      }
    });
  }

  private async runTopologyReconcile(): Promise<void> {
    const previousActiveId = this.activeWorktreeId;
    await this.discoverAndSyncWorktrees();

    // A successful reconcile re-verifies the worktree list, so any prior dark
    // state is resolved — recover here rather than on watcher re-arm, since
    // re-subscribing doesn't prove the topology is current (#8516/#8558).
    this.handleTopologyWatcherRecovered();

    // Auto-switch to main if the previously-active worktree was removed.
    // syncMonitors nulls activeWorktreeId when pruning the active monitor,
    // so we check: was there a previous active, is it gone from monitors,
    // and has the user NOT already switched to a *different* worktree.
    if (
      previousActiveId &&
      !this.monitors.has(previousActiveId) &&
      (this.activeWorktreeId === null || this.activeWorktreeId === previousActiveId)
    ) {
      let mainId: string | null = null;
      for (const [id, m] of this.monitors) {
        if (m.isMainWorktree) {
          mainId = id;
          break;
        }
      }
      if (mainId) {
        this.setActiveWorktree("topology-reconcile-auto-switch", mainId);
      }
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

    if (this.activeWorktreeId === worktreeId) {
      this.activeWorktreeId = null;
    }

    this.resourceActionExecutor.cleanupResourceActionState(worktreeId);
    monitor.stop();
    this.monitors.delete(worktreeId);
    this.lruRemove(worktreeId);
    this.recoverWatcherIfNoMonitorsRemain();
    // A freed slot lets the next most-recently-focused evicted worktree
    // reclaim a watcher.
    this.applyWatcherBudget();

    clearGitDirCache(monitor.path);
    invalidateGitStatusCache(monitor.path);
    const cacheKey = this.listService.getCacheKey();
    if (cacheKey) {
      this.listService.invalidateCache(cacheKey);
    }

    this.sendEvent({
      type: "worktree-removed",
      worktreeId,
      epoch: this.epoch,
      seq: this.nextSeq(),
    });
    events.emit("sys:worktree:remove", { worktreeId, timestamp: Date.now() });

    console.log(
      `[WorkspaceHost] Worktree deleted externally, removed monitor: ${monitor.name} (${worktreeId})`
    );
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
    // (auto-switch in `runTopologyReconcile` and `deleteWorktree` AND
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

  async refresh(requestId: string, worktreeId?: string): Promise<void> {
    try {
      if (worktreeId) {
        const monitor = this.monitors.get(worktreeId);
        if (monitor) {
          await monitor.refresh();
        }
      } else {
        await this.discoverAndSyncWorktrees();
        await this.refreshAll();
        await pullRequestService.refresh();
      }
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

  private async discoverAndSyncWorktrees(): Promise<void> {
    if (!this.git) {
      return;
    }

    // #6669: prune before listing so externally-deleted worktrees (which Git
    // 2.31+ keeps in `worktree list --porcelain` with a `prunable` marker)
    // are dropped from the list. Without this, `syncMonitors` re-creates a
    // monitor for the phantom path and the sidebar entry never clears.
    // `prune` skips locked worktrees, so this is safe to run on every refresh.
    // Best-effort: if prune fails (e.g. EPERM on .git/worktrees/), don't block
    // the rest of the refresh — that would recreate the original "refresh is a
    // no-op" symptom under a different trigger.
    try {
      await this.git.raw(["worktree", "prune"]);
    } catch (pruneError) {
      console.warn(
        `[WorkspaceHost] worktree prune during refresh failed: ${(pruneError as Error).message}`
      );
    }

    const rawWorktrees = await this.listService.list({ forceRefresh: true });
    const worktrees = this.listService.mapToWorktrees(rawWorktrees);

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
    await Promise.all(promises);
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

    const createPromise = this.performCreateWorktree(rootPath, options);
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
      const git = createHardenedGit(rootPath);
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

      // #6463: when not explicitly reusing a branch, guard against a stale
      // local branch with the same name. Without this, `git worktree add -b`
      // hits "fatal: a branch named '...' already exists" whenever a previous
      // worktree was deleted but its branch was kept. Two recoveries:
      // (a) branch exists but is not checked out anywhere → reuse it (drop
      //     -b, switch to the useExistingBranch arg form);
      // (b) branch is live in another worktree → suffix -2/-3/... and create
      //     a fresh branch.
      // Inlined (not behind a helper) so the happy-path microtask timing
      // matches the pre-fix behavior — the next await is still the worktree
      // add, not a wrapper-promise resolution.
      if (!useExistingBranch) {
        let localBranches: string[] = [];
        try {
          localBranches = (await git.branchLocal()).all;
        } catch {
          // Best-effort: if branch listing fails, fall through and let the
          // actual worktree command surface its own error.
        }

        if (localBranches.includes(newBranch)) {
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

          if (canReuse) {
            useExistingBranch = true;
            // The -b path tracks baseBranch; reuse drops that. Stale local
            // branches typically retain their original config, so this is
            // the right tradeoff vs. failing the user-visible create.
            fromRemote = false;
          } else {
            newBranch = nextAvailableBranchName(newBranch, new Set(localBranches));
          }
        }
      }

      // `--end-of-options` after the subcommand flags so any leading-dash ref
      // or path that slipped past validation is treated as positional.

      // Mark the metadata-subdir basename pending so the watcher event our own
      // `git worktree add` produces is recognized and dropped — without
      // blanket-suppressing concurrent external `git worktree remove` events.
      pendingCreateKey = this.topologyMetadataKey(absoluteCreatePath);
      this.topologyMarkPending(pendingCreateKey, this.topologyPendingCreate);

      if (useExistingBranch) {
        await git.raw(["worktree", "add", "--end-of-options", path, newBranch]);
      } else if (fromRemote) {
        await git.raw([
          "worktree",
          "add",
          "-b",
          newBranch,
          "--track",
          "--end-of-options",
          path,
          baseBranch,
        ]);
      } else {
        // --no-track: local-base branches shouldn't auto-track a local ref even
        // when the user has branch.autoSetupMerge=always. Skipping tracking also
        // avoids a .git/config.lock acquisition, cutting contention under bulk
        // creation. PR-mode (fromRemote) keeps --track — ahead/behind badges
        // at WorktreeMonitor.ts:1092 depend on @{u} resolving.
        await git.raw([
          "worktree",
          "add",
          "-b",
          newBranch,
          "--no-track",
          "--end-of-options",
          path,
          baseBranch,
        ]);
      }

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

      // Build the Worktree object directly from known inputs instead of
      // shelling out to `git worktree list --porcelain` — the per-create list
      // was O(N²) across batches. Fields match WorktreeListService.mapToWorktrees
      // output for a freshly-created, attached, non-main worktree.
      const createdWorktree: Worktree = {
        id: absolutePath,
        path: absolutePath,
        name: newBranch,
        branch: newBranch,
        head: undefined,
        isDetached: false,
        isCurrent: false,
        isMainWorktree: false,
        gitDir: getGitDir(absolutePath) || undefined,
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

      // Monitor is registered. Drop the pending entry now: any still-buffered
      // create event for this name will be matched by the next drain (the
      // safety valve is cancelled here so the happy path can't spuriously
      // reconcile 5s later).
      this.topologyClearPending(pendingCreateKey);

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

        await this.lifecycleService.copyDaintreeDir(rootPath, absolutePath);

        void this.runLifecycleSetup(
          canonicalWorktreeId,
          absolutePath,
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
      return canonicalWorktreeId;
    } catch (error) {
      // Create failed — drop any pending entry so a real external change to
      // that name isn't masked, and cancel its safety valve.
      if (pendingCreateKey) this.topologyClearPending(pendingCreateKey);
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
      pendingDeleteKey = this.topologyMetadataKey(monitor.path);
      this.topologyMarkPending(pendingDeleteKey, this.topologyPendingDelete);

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
          const removeResult = await this.removeGitWorktreeWithRetry(this.git, args, monitor.path);
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

        const cacheKey = this.listService.getCacheKey();
        if (cacheKey) {
          this.listService.invalidateCache(cacheKey);
        }
      }

      // Clean up the monitor immediately after worktree removal succeeds,
      // before attempting branch deletion — so the monitor doesn't linger
      // if branch deletion fails.
      this.resourceActionExecutor.cleanupResourceActionState(worktreeId);
      monitor.stop();
      this.monitors.delete(worktreeId);
      this.lruRemove(worktreeId);
      this.recoverWatcherIfNoMonitorsRemain();
      // A freed slot lets the next most-recently-focused evicted worktree
      // reclaim a watcher.
      this.applyWatcherBudget();

      // Monitor is cleaned up. Drop the pending entry now (cancelling its
      // safety valve): any still-buffered delete event for this name is
      // matched by the next drain.
      this.topologyClearPending(pendingDeleteKey);

      this.sendEvent({
        type: "worktree-removed",
        worktreeId,
        epoch: this.epoch,
        seq: this.nextSeq(),
      });

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
      if (mutationId) this.acknowledgedMutations.add(mutationId);
      this.sendEvent({ type: "delete-worktree-result", requestId, success: true });
    } catch (error) {
      // Delete failed — drop any pending entry so a real external change to
      // that name isn't masked, and cancel its safety valve.
      if (pendingDeleteKey) this.topologyClearPending(pendingDeleteKey);
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
      const git = createHardenedGit(rootPath);
      const summary: BranchSummary = await git.branch(["-a"]);
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

  async fetchPRBranch(
    requestId: string,
    rootPath: string,
    prNumber: number,
    headRefName: string
  ): Promise<void> {
    try {
      const git = createAuthenticatedGit(rootPath);
      await git.raw(["fetch", "origin", `pull/${prNumber}/head:${headRefName}`]);
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
      const git = createHardenedGit(rootPath);
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
    status: string
  ): Promise<void> {
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

      const git = createHardenedGit(cwd);

      if (status === "untracked" || status === "added") {
        const { readFile } = await import("fs/promises");
        const absolutePath = resolve(cwd, normalizedPath);
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
          this.sendEvent({ type: "get-file-diff-result", requestId, diff: "BINARY_FILE" });
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

        this.sendEvent({ type: "get-file-diff-result", requestId, diff });
        return;
      }

      // `--no-textconv` blocks user-defined diff drivers that would otherwise
      // execute arbitrary binaries via `.gitattributes` textconv mappings.
      const diff = await git.diff([
        "HEAD",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--",
        normalizedPath,
      ]);

      if (diff.includes("Binary files")) {
        this.sendEvent({ type: "get-file-diff-result", requestId, diff: "BINARY_FILE" });
        return;
      }

      if (!diff.trim()) {
        this.sendEvent({ type: "get-file-diff-result", requestId, diff: "NO_CHANGES" });
        return;
      }

      this.sendEvent({ type: "get-file-diff-result", requestId, diff });
    } catch (error) {
      this.sendEvent({
        type: "get-file-diff-result",
        requestId,
        diff: "",
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
      this.stopTopologyWatcher();
      for (const monitor of this.monitors.values()) {
        monitor.pausePolling();
      }
    } else {
      for (const monitor of this.monitors.values()) {
        monitor.resumePolling();
      }
      this.startTopologyWatcher();
      // stopTopologyWatcher() (run on the !enabled branch) cleared the safety
      // timer, so resume must restart it symmetrically (#8510).
      this.startPeriodicSafetyTimer();
      this.scheduleTopologyReconcile();
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
    this.prService.resetPRState(this.projectRootPath);
    this.sendEvent({ type: "reset-pr-state-result", requestId, success: true });
  }

  updateForgeSettings(args: {
    forgeProviderOverride: string | null;
    forgeDefaultProviderId: string | null;
    forgeRemote: string | null;
  }): void {
    pullRequestService.setForgeSettings(args);
    void pullRequestService.refresh();
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
    this.prService.updateForgeCredentials(providerId, credentials, this.projectRootPath);
    if (credentials) {
      // A new credential may resolve previously-failing auth — drop suspensions so
      // the next scheduled fetch retries. Network/transient entries stay so we
      // don't immediately re-storm an offline remote.
      this.fetchCoordinator.clearAuthFailures();
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
   * User-triggered retry of auth-suspended fetches. Auth failures suspend a
   * repo's fetch cache indefinitely (AUTH_FAILURE_TTL_MS = POSITIVE_INFINITY) to
   * avoid storming GitHub's secondary rate limits with repeated bad-token
   * attempts. The only safe way out is an explicit user action — e.g. clicking
   * the auth-failed sync badge — which clears the suspension and re-fetches.
   * Mirrors the credential branch of updateForgeCredentials but without a
   * credential update (the user may be retrying after fixing the token elsewhere).
   */
  retryAuthFetch(): void {
    this.fetchCoordinator.clearAuthFailures();
    for (const monitor of this.monitors.values()) {
      if (monitor.isRunning) {
        void monitor.triggerFetchNow();
      }
    }
  }

  private initializePRService(): Promise<void> {
    if (!this.projectRootPath) {
      return Promise.resolve();
    }

    return this.prService.initialize(this.projectRootPath, () => {
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
    this.stopTopologyWatcher();
    // Stop the WSL distro poller before clearing monitors so a poll tick can't
    // fire setWslEligible against a half-torn-down or next-project monitor map.
    this.stopWslDistroPoller();
    this.topologyReconcileQueue.clear();
    this.prService.cleanup();

    for (const id of this.monitors.keys()) {
      this.resourceActionExecutor.cleanupResourceActionState(id);
    }
    for (const monitor of this.monitors.values()) {
      monitor.stop();
    }
    this.monitors.clear();
    this.backgroundGitWatcherLru.clear();
    // Drop in-flight fetch chains and per-repo failure state — the next
    // project's monitors get a clean coordinator and stale completions are
    // discarded by the generation guard.
    this.fetchCoordinator.destroy();
    this.pollQueue.clear();

    this.activeWorktreeId = null;
    this.mainBranch = "main";
    this.git = null;
    this.projectRootPath = null;
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

  private async loadProjectEnvVars(projectRootPath: string): Promise<Record<string, string>> {
    try {
      const userDataDir = process.env.DAINTREE_USER_DATA ?? "";
      const projectId = generateProjectId(projectRootPath);
      const filePath = settingsFilePath(userDataDir, projectId);
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
    // stopTopologyWatcher clears the pending sets and their safety timers.
    this.stopTopologyWatcher();
    this.stopWslDistroPoller();
    this.topologyReconcileQueue.clear();
    this.prService.cleanup();
    this.resourceActionExecutor.dispose();
    for (const monitor of this.monitors.values()) {
      monitor.stop();
    }
    this.monitors.clear();
    this.backgroundGitWatcherLru.clear();
    this.fetchCoordinator.destroy();
    this.pollQueue.clear();
    this.listService.invalidateCache();
  }
}
