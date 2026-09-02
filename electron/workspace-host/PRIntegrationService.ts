import type { TypedEventBus } from "../services/events.js";
import type { PRServiceStatus, WorktreeSnapshot } from "../../shared/types/workspace-host.js";

interface PullRequestServiceLike {
  initialize(rootPath: string, projectId: string): void;
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
      prState: import("../../shared/types/forge.js").NormalizedPRState;
      prCiStatus?: import("../../shared/types/forge.js").CIStatusState;
      /** Phase-1 detection: CI status is still being fetched. The receiver preserves the prior rollup so the dot doesn't blink. */
      isCiStatusLoading?: boolean;
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

export interface PRIntegrationServiceOptions {
  /**
   * Worker instances never start the automatic PR polling loop — detection
   * wiring and on-demand `refresh()` stay fully functional, only the
   * background `start()` paths become no-ops (#10123).
   */
  isWorker?: boolean;
}

export class PRIntegrationService {
  private prEventUnsubscribers: (() => void)[] = [];
  private initializedForPath: string | null = null;
  private readonly isWorker: boolean;

  constructor(
    private readonly prService: PullRequestServiceLike,
    private readonly eventBus: TypedEventBus,
    private readonly callbacks: PRIntegrationCallbacks,
    options?: PRIntegrationServiceOptions
  ) {
    this.isWorker = options?.isWorker === true;
  }

  /**
   * Background polling entry point — every automatic `prService.start()` call
   * funnels through here so worker instances stay quiet. On-demand paths
   * (`refresh()`) bypass this intentionally.
   */
  private startPolling(startupDelayMs?: number): Promise<void> {
    if (this.isWorker) return Promise.resolve();
    return this.prService.start(startupDelayMs);
  }

  isInitializedFor(path: string): boolean {
    return this.initializedForPath === path;
  }

  async initialize(
    projectRootPath: string,
    projectId: string,
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

    this.prService.initialize(projectRootPath, projectId);
    this.initializedForPath = projectRootPath;

    this.prEventUnsubscribers.push(
      this.eventBus.on("sys:pr:detected", (data) => {
        this.callbacks.onPRDetected(data.worktreeId, {
          prNumber: data.prNumber,
          prUrl: data.prUrl,
          prState: data.prState,
          prCiStatus: data.prCiStatus,
          isCiStatusLoading: data.isCiStatusLoading,
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

    return this.startPolling();
  }

  getStatus(): PRServiceStatus {
    const status = this.prService.getStatus();
    return {
      isRunning: status.isPolling,
      candidateCount: status.candidateCount,
      resolvedPRCount: status.resolvedCount,
      // Use the dedicated breaker flag, NOT `!isEnabled`: a rate-limit pause
      // also disables polling but must not show the "detection paused" badge.
      ...(status.detectionStateTripped ? { circuitBreakerTripped: true } : {}),
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

  resetPRState(projectRootPath: string | null, projectId: string | null): void {
    this.prService.reset();
    if (projectRootPath && projectId) {
      this.prService.initialize(projectRootPath, projectId);
      void this.startPolling();
    }
  }

  pause(): void {
    this.prService.stop();
  }

  resume(): void {
    // Focus-restore, not a crash-recovery path — skip the startup jitter so
    // the user sees fresh PR state promptly. The 5s checkForPRs() floor still
    // prevents a double-check if a poll just ran.
    void this.startPolling(0);
  }

  updateForgeCredentials(
    _providerId: string,
    credentials: import("../../shared/types/forge.js").Credentials | null,
    projectRootPath: string | null,
    projectId: string | null
  ): void {
    // Credential VALUES are not applied in this process — every forge call
    // from the host goes through the RPC bridge to main, where the provider
    // impl reads its own auth (#8870). The relay only signals presence/absence
    // so detection can refresh or reset promptly on sign-in / sign-out.
    if (credentials) {
      void this.prService.refresh();
    } else {
      this.prService.reset();
      if (projectRootPath && projectId) {
        this.prService.initialize(projectRootPath, projectId);
        void this.startPolling();
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
