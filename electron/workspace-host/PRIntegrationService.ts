import type { TypedEventBus } from "../services/events.js";

interface PullRequestServiceLike {
  initialize(rootPath: string): void;
  start(): Promise<void>;
  reset(): void;
  refresh(): void;
  getStatus(): {
    isPolling: boolean;
    candidateCount: number;
    resolvedCount: number;
    isEnabled: boolean;
  };
}

export interface PRIntegrationCallbacks {
  onPRDetected(
    worktreeId: string,
    data: {
      prNumber: number;
      prUrl: string;
      prState: "open" | "closed" | "merged";
      prTitle?: string;
      issueNumber?: number;
      issueTitle?: string;
    }
  ): void;
  onPRCleared(worktreeId: string): void;
  onIssueDetected(
    worktreeId: string,
    data: {
      issueNumber: number;
      issueTitle: string;
    }
  ): void;
  onIssueNotFound(worktreeId: string, issueNumber: number): void;
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
          prTitle: data.prTitle,
          issueNumber: data.issueNumber,
          issueTitle: data.issueTitle,
        });
      })
    );

    this.prEventUnsubscribers.push(
      this.eventBus.on("sys:issue:detected", (data) => {
        this.callbacks.onIssueDetected(data.worktreeId, {
          issueNumber: data.issueNumber,
          issueTitle: data.issueTitle,
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
        this.callbacks.onPRCleared(data.worktreeId);
      })
    );

    // Seed PR service with existing monitors as candidates.
    // The partial object doesn't match the full WorktreeSnapshot type expected
    // by sys:worktree:update, but PullRequestService only reads these fields.
    for (const candidate of getMonitorCandidates()) {
      if (candidate.branch && candidate.branch !== "main" && candidate.branch !== "master") {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        this.eventBus.emit("sys:worktree:update", {
          worktreeId: candidate.worktreeId,
          branch: candidate.branch,
          issueNumber: candidate.issueNumber,
          isMainWorktree: candidate.isMainWorktree,
        } as any);
        /* eslint-enable @typescript-eslint/no-explicit-any */
      }
    }

    return this.prService.start();
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
