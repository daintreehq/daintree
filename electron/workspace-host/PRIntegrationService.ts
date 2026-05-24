import type { TypedEventBus } from "../services/events.js";
import type { GitHubPRCIStatus } from "../../shared/types/github.js";
import type { PRServiceStatus, WorktreeSnapshot } from "../../shared/types/workspace-host.js";
import { GitHubAuth } from "../services/github/GitHubAuth.js";
import {
  BUILTIN_GITHUB_PROVIDER_ID,
  normalizeProviderId,
} from "../../shared/utils/forgeProviderIds.js";

interface PullRequestServiceLike {
  initialize(rootPath: string): void;
  start(startupDelayMs?: number): Promise<void>;
  stop(): void;
  reset(): void;
  refresh(): Promise<void>;
  getStatus(): {
    isPolling: boolean;
    candidateCount: number;
    resolvedCount: number;
    isEnabled: boolean;
    detectionStateTripped: boolean;
  };
  getProviderContext(): { providerId: string; owner: string; repo: string } | null;
}

export interface PRIntegrationCallbacks {
  onPRDetected(
    worktreeId: string,
    data: {
      prNumber: number;
      prUrl: string;
      prState: "open" | "closed" | "merged";
      prCiStatus?: GitHubPRCIStatus;
      prTitle?: string;
      issueNumber?: number;
      issueTitle?: string;
      prLastUpdatedAt?: number;
      issueLastUpdatedAt?: number;
      /** Branch the lookup was initiated against — used by the renderer to drop stale overlays. */
      branchName?: string;
      /** Provider that resolved the PR (e.g. `"daintree.github.github"`). */
      providerId: string;
      /** Canonical repository owner the PR/issue belongs to. */
      owner: string;
      /** Canonical repository name the PR/issue belongs to. */
      repo: string;
      /** Provider-agnostic CI status (forge format). */
      ciStatus?: import("../../shared/types/forge.js").CIStatus;
      /** Branch the PR merges into (e.g. "develop"); drives base-branch divergence display. */
      baseRef?: string;
    }
  ): void;
  onPRCleared(worktreeId: string, data: { branchName?: string; providerId?: string }): void;
  onIssueDetected(
    worktreeId: string,
    data: {
      issueNumber: number;
      issueTitle: string;
      issueLastUpdatedAt?: number;
      /** Branch the lookup was initiated against — used by the renderer to drop stale overlays. */
      branchName?: string;
      /** Provider that resolved the issue (e.g. `"daintree.github.github"`). */
      providerId: string;
      /** Canonical repository owner the issue belongs to. */
      owner: string;
      /** Canonical repository name the issue belongs to. */
      repo: string;
    }
  ): void;
  onIssueNotFound(worktreeId: string, issueNumber: number): void;
  /** Circuit breaker tripped (detection paused) or recovered. Service-wide, not per-worktree. */
  onDetectionStateChanged?(tripped: boolean): void;
}

export class PRIntegrationService {
  private prEventUnsubscribers: (() => void)[] = [];
  private initializedForPath: string | null = null;

  constructor(
    private readonly prService: PullRequestServiceLike,
    private readonly eventBus: TypedEventBus,
    private readonly callbacks: PRIntegrationCallbacks
  ) {}

  isInitializedFor(path: string): boolean {
    return this.initializedForPath === path;
  }

  async initialize(
    projectRootPath: string,
    getMonitorCandidates: () => Array<{
      worktreeId: string;
      branch?: string;
      issueNumber?: number;
      isMainWorktree?: boolean;
    }>
  ): Promise<void> {
    if (this.initializedForPath === projectRootPath) {
      return;
    }

    this.cleanup();

    this.prService.initialize(projectRootPath);
    this.initializedForPath = projectRootPath;

    this.prEventUnsubscribers.push(
      this.eventBus.on("sys:pr:detected", (data) => {
        this.callbacks.onPRDetected(data.worktreeId, {
          prNumber: data.prNumber,
          prUrl: data.prUrl,
          prState: data.prState,
          prCiStatus: data.prCiStatus,
          prTitle: data.prTitle,
          issueNumber: data.issueNumber,
          issueTitle: data.issueTitle,
          prLastUpdatedAt: Date.now(),
          issueLastUpdatedAt: data.issueTitle !== undefined ? Date.now() : undefined,
          branchName: data.branchName,
          providerId: data.providerId,
          owner: data.owner,
          repo: data.repo,
          ciStatus: data.ciStatus,
          baseRef: data.baseRef,
        });
      })
    );

    this.prEventUnsubscribers.push(
      this.eventBus.on("sys:issue:detected", (data) => {
        this.callbacks.onIssueDetected(data.worktreeId, {
          issueNumber: data.issueNumber,
          issueTitle: data.issueTitle,
          issueLastUpdatedAt: Date.now(),
          branchName: data.branchName,
          providerId: data.providerId,
          owner: data.owner,
          repo: data.repo,
        });
      })
    );

    this.prEventUnsubscribers.push(
      this.eventBus.on("sys:issue:not-found", (data) => {
        this.callbacks.onIssueNotFound(data.worktreeId, data.issueNumber);
      })
    );

    this.prEventUnsubscribers.push(
      this.eventBus.on("sys:pr:cleared", (data) => {
        this.callbacks.onPRCleared(data.worktreeId, {
          branchName: data.branchName,
          providerId: data.providerId,
        });
      })
    );

    this.prEventUnsubscribers.push(
      this.eventBus.on("sys:pr:detection-state", (data) => {
        this.callbacks.onDetectionStateChanged?.(data.tripped);
      })
    );

    // Seed PR service with existing monitors as candidates.
    // The partial object doesn't match the full WorktreeSnapshot type expected
    // by sys:worktree:update, but PullRequestService only reads these fields.
    for (const candidate of getMonitorCandidates()) {
      if (candidate.branch && candidate.branch !== "main" && candidate.branch !== "master") {
        this.eventBus.emit("sys:worktree:update", {
          worktreeId: candidate.worktreeId,
          branch: candidate.branch,
          issueNumber: candidate.issueNumber,
          isMainWorktree: candidate.isMainWorktree,
        } as unknown as WorktreeSnapshot);
      }
    }

    return this.prService.start();
  }

  getStatus(): PRServiceStatus {
    const status = this.prService.getStatus();
    return {
      isRunning: status.isPolling,
      candidateCount: status.candidateCount,
      resolvedPRCount: status.resolvedCount,
      lastCheckTime: undefined,
      // Use the dedicated breaker flag, NOT `!isEnabled`: a rate-limit pause
      // also disables polling but must not show the "detection paused" badge.
      circuitBreakerTripped: status.detectionStateTripped,
    };
  }

  /**
   * Currently-resolved forge provider context, or null when no provider has
   * resolved yet. Used to eagerly compose a `linked` projection at
   * worktree-create time (#8888).
   */
  getProviderContext(): { providerId: string; owner: string; repo: string } | null {
    return this.prService.getProviderContext();
  }

  resetPRState(projectRootPath: string | null): void {
    this.prService.reset();
    if (projectRootPath) {
      this.prService.initialize(projectRootPath);
      void this.prService.start();
    }
  }

  pause(): void {
    this.prService.stop();
  }

  resume(): void {
    // Focus-restore, not a crash-recovery path — skip the startup jitter so
    // the user sees fresh PR state promptly. The 5s checkForPRs() floor still
    // prevents a double-check if a poll just ran.
    void this.prService.start(0);
  }

  updateForgeCredentials(
    providerId: string,
    credentials: import("../../shared/types/forge.js").Credentials | null,
    projectRootPath: string | null
  ): void {
    if (normalizeProviderId(providerId) === BUILTIN_GITHUB_PROVIDER_ID) {
      if (credentials === null) {
        GitHubAuth.setMemoryToken(null);
      } else if (credentials.kind === "bearer") {
        GitHubAuth.setMemoryToken(credentials.value);
      }
      // Non-bearer credentials are silently ignored — GitHub only supports bearer tokens.
    }
    // Additional providers dispatch through their own auth modules.

    if (credentials) {
      void this.prService.refresh();
    } else {
      this.prService.reset();
      if (projectRootPath) {
        this.prService.initialize(projectRootPath);
        void this.prService.start();
      }
    }
  }

  cleanup(): void {
    this.prService.reset();
    for (const unsubscribe of this.prEventUnsubscribers) {
      unsubscribe();
    }
    this.prEventUnsubscribers = [];
    this.initializedForPath = null;
  }
}
