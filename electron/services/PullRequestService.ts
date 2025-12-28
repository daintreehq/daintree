import { events } from "./events.js";
import { batchCheckLinkedPRs, type PRCheckCandidate, type LinkedPR } from "./GitHubService.js";
import { logInfo, logWarn, logDebug } from "../utils/logger.js";
import type { WorktreeSnapshot as WorktreeState } from "../../shared/types/workspace-host.js";

const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;

const ERROR_BACKOFF_INTERVALS = [5 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000];

const MAX_CONSECUTIVE_ERRORS = 3;
const UPDATE_DEBOUNCE_MS = 100;

interface WorktreeContext {
  issueNumber?: number;
  branchName?: string;
}

export interface PRDetectionResult {
  worktreeId: string;
  prNumber: number;
  prUrl: string;
  prState: "open" | "merged" | "closed";
}

function isCandidateBranch(branchName: string | undefined): boolean {
  if (!branchName) return false;
  const normalized = branchName.trim();
  if (!normalized) return false;

  const lower = normalized.toLowerCase();
  if (lower === "head") return false;
  if (lower === "main" || lower === "master") return false;
  return true;
}

class PullRequestService {
  private pollTimer: NodeJS.Timeout | null = null;
  private pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS;
  private cwd: string = "";
  private isPolling: boolean = false;
  private consecutiveErrors: number = 0;
  private isEnabled: boolean = true;

  private candidates = new Map<string, WorktreeContext>();
  private resolvedWorktrees = new Set<string>();
  private detectedPRs = new Map<string, LinkedPR>();
  private updateDebounceTimer: NodeJS.Timeout | null = null;
  private unsubscribers: (() => void)[] = [];

  constructor() {
    this.unsubscribers.push(events.on("sys:worktree:update", this.handleWorktreeUpdate.bind(this)));
    this.unsubscribers.push(events.on("sys:worktree:remove", this.handleWorktreeRemove.bind(this)));
  }

  private handleWorktreeUpdate(state: WorktreeState): void {
    const currentContext = this.candidates.get(state.worktreeId);
    const newIssueNumber = state.issueNumber;
    const newBranchName = state.branch;

    const branchChanged = currentContext?.branchName !== newBranchName;
    const issueChanged = currentContext?.issueNumber !== newIssueNumber;

    if (branchChanged && currentContext) {
      logDebug("Worktree branch changed - clearing PR state", {
        worktreeId: state.worktreeId,
        oldIssue: currentContext.issueNumber,
        newIssue: newIssueNumber,
        oldBranch: currentContext.branchName,
        newBranch: newBranchName,
      });

      this.resolvedWorktrees.delete(state.worktreeId);
      this.detectedPRs.delete(state.worktreeId);

      events.emit("sys:pr:cleared", { worktreeId: state.worktreeId, timestamp: Date.now() });
    }

    const shouldTrack = isCandidateBranch(newBranchName);

    if (!shouldTrack) {
      if (currentContext) {
        this.candidates.delete(state.worktreeId);
      }
      return;
    }

    const nextContext: WorktreeContext = {
      branchName: newBranchName,
      issueNumber: newIssueNumber,
    };

    const wasCandidate = Boolean(currentContext);
    this.candidates.set(state.worktreeId, nextContext);

    const shouldRecheck =
      this.isPolling &&
      (branchChanged ||
        !wasCandidate ||
        (issueChanged && !this.resolvedWorktrees.has(state.worktreeId)));

    if (shouldRecheck) {
      this.scheduleDebounceCheck();
    }
  }

  private handleWorktreeRemove({ worktreeId }: { worktreeId: string }): void {
    if (this.candidates.has(worktreeId) || this.detectedPRs.has(worktreeId)) {
      this.candidates.delete(worktreeId);
      this.resolvedWorktrees.delete(worktreeId);
      this.detectedPRs.delete(worktreeId);

      events.emit("sys:pr:cleared", { worktreeId, timestamp: Date.now() });

      logDebug("Worktree removed - cleared PR state", { worktreeId });
    }
  }

  private scheduleDebounceCheck(): void {
    if (this.updateDebounceTimer) {
      clearTimeout(this.updateDebounceTimer);
    }

    this.updateDebounceTimer = setTimeout(() => {
      this.updateDebounceTimer = null;

      if (this.hasUnresolvedCandidates()) {
        logDebug("Running debounced PR check", { candidateCount: this.candidates.size });
        void this.checkForPRs();

        if (!this.pollTimer) {
          this.scheduleNextPoll();
        }
      }
    }, UPDATE_DEBOUNCE_MS);
  }

  public initialize(cwd: string): void {
    this.cwd = cwd;
    logInfo("PullRequestService initialized", { cwd });
  }

  public start(intervalMs?: number): void {
    if (this.isPolling) {
      logWarn("PullRequestService already polling");
      return;
    }

    if (!this.cwd) {
      logWarn("PullRequestService not initialized - call initialize() first");
      return;
    }

    if (intervalMs) {
      if (intervalMs < DEFAULT_POLL_INTERVAL_MS) {
        logWarn("PR polling interval too short - clamping to minimum 60s", {
          requested: intervalMs,
          clamped: DEFAULT_POLL_INTERVAL_MS,
        });
        this.pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
      } else {
        this.pollIntervalMs = intervalMs;
      }
    }

    this.isPolling = true;
    this.isEnabled = true;
    this.consecutiveErrors = 0;

    logInfo("PullRequestService started", { intervalMs: this.pollIntervalMs });

    void this.checkForPRs().finally(() => {
      this.scheduleNextPoll();
    });
  }

  public stop(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.updateDebounceTimer) {
      clearTimeout(this.updateDebounceTimer);
      this.updateDebounceTimer = null;
    }
    this.isPolling = false;
    logInfo("PullRequestService stopped");
  }

  public async refresh(): Promise<void> {
    if (!this.cwd) {
      return;
    }
    this.isEnabled = true;
    this.consecutiveErrors = 0;
    await this.checkForPRs();

    if (this.isPolling && !this.pollTimer && this.hasUnresolvedCandidates()) {
      this.scheduleNextPoll();
    }
  }

  public reset(): void {
    this.stop();
    this.candidates.clear();
    this.resolvedWorktrees.clear();
    this.detectedPRs.clear();
    this.consecutiveErrors = 0;
    this.isEnabled = true;
  }

  public destroy(): void {
    this.reset();
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  private scheduleNextPoll(): void {
    if (!this.isPolling || !this.isEnabled) {
      return;
    }

    if (!this.hasUnresolvedCandidates()) {
      logDebug("All candidates resolved - pausing polling");
      return;
    }

    let interval = this.pollIntervalMs;
    if (this.consecutiveErrors > 0) {
      const backoffIndex = Math.min(this.consecutiveErrors - 1, ERROR_BACKOFF_INTERVALS.length - 1);
      interval = ERROR_BACKOFF_INTERVALS[backoffIndex];
      logDebug("Using backoff interval", { errors: this.consecutiveErrors, intervalMs: interval });
    }

    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.checkForPRs().then(() => this.scheduleNextPoll());
    }, interval);
  }

  private hasUnresolvedCandidates(): boolean {
    for (const worktreeId of this.candidates.keys()) {
      if (!this.resolvedWorktrees.has(worktreeId)) {
        return true;
      }
    }
    return false;
  }

  private async checkForPRs(): Promise<void> {
    const activeCandidates: PRCheckCandidate[] = [];
    for (const [worktreeId, context] of this.candidates) {
      if (!this.resolvedWorktrees.has(worktreeId)) {
        activeCandidates.push({
          worktreeId,
          issueNumber: context.issueNumber,
          branchName: context.branchName,
        });
      }
    }

    if (activeCandidates.length === 0) {
      logDebug("No candidates to check for PRs");
      return;
    }

    logDebug("Checking PRs for candidates", { count: activeCandidates.length });

    try {
      const result = await batchCheckLinkedPRs(this.cwd, activeCandidates);

      if (result.error) {
        this.handleError(result.error);
        return;
      }

      this.consecutiveErrors = 0;

      for (const [worktreeId, checkResult] of result.results) {
        // Emit issue metadata if we have a title (regardless of PR)
        const issueNumber = checkResult.issueNumber ?? this.candidates.get(worktreeId)?.issueNumber;
        if (issueNumber && checkResult.issueTitle) {
          events.emit("sys:issue:detected", {
            worktreeId,
            issueNumber,
            issueTitle: checkResult.issueTitle,
            timestamp: Date.now(),
          });
        }

        if (checkResult.pr) {
          this.resolvedWorktrees.add(worktreeId);
          this.detectedPRs.set(worktreeId, checkResult.pr);

          logInfo("PR detected for worktree", {
            worktreeId,
            prNumber: checkResult.pr.number,
            prState: checkResult.pr.state,
          });

          events.emit("sys:pr:detected", {
            worktreeId,
            prNumber: checkResult.pr.number,
            prUrl: checkResult.pr.url,
            prState: checkResult.pr.state,
            prTitle: checkResult.pr.title,
            issueNumber,
            issueTitle: checkResult.issueTitle,
            timestamp: Date.now(),
          });
        }
      }
    } catch (error) {
      this.handleError(error instanceof Error ? error.message : "Unknown error");
    }
  }

  private handleError(errorMsg: string): void {
    this.consecutiveErrors++;
    logWarn("PR check failed", { error: errorMsg, consecutiveErrors: this.consecutiveErrors });

    if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      logWarn("Too many consecutive errors - disabling PR polling");
      this.isEnabled = false;
      events.emit("ui:notify", {
        type: "warning",
        message: "PR detection paused due to errors. Refresh to retry.",
        id: "pr-service-circuit-breaker",
      });
    }
  }

  public getStatus(): {
    isPolling: boolean;
    isEnabled: boolean;
    candidateCount: number;
    resolvedCount: number;
    consecutiveErrors: number;
  } {
    return {
      isPolling: this.isPolling,
      isEnabled: this.isEnabled,
      candidateCount: this.candidates.size,
      resolvedCount: this.resolvedWorktrees.size,
      consecutiveErrors: this.consecutiveErrors,
    };
  }
}

export const pullRequestService = new PullRequestService();
