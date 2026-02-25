import { events } from "./events.js";
import { batchCheckLinkedPRs, type PRCheckCandidate, type LinkedPR } from "./GitHubService.js";
import { logInfo, logWarn, logDebug } from "../utils/logger.js";
import type { WorktreeSnapshot as WorktreeState } from "../../shared/types/workspace-host.js";

const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;

const ERROR_BACKOFF_INTERVALS = [5 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000];

const MAX_CONSECUTIVE_ERRORS = 3;
const UPDATE_DEBOUNCE_MS = 100;

// Slow-cadence revalidation for resolved PRs to detect state changes (merged/closed)
const RESOLVED_REVALIDATION_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

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
  private revalidationTimer: NodeJS.Timeout | null = null;
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

    const shouldTrack = isCandidateBranch(newBranchName);

    // Build the next context first
    const nextContext: WorktreeContext = {
      branchName: newBranchName,
      issueNumber: newIssueNumber,
    };

    const wasCandidate = Boolean(currentContext);

    // Update candidates BEFORE emitting any events to prevent synchronous event loops.
    // The sys:pr:cleared event triggers emitUpdate which emits sys:worktree:update,
    // causing handleWorktreeUpdate to be called again synchronously. If we don't
    // update candidates first, we'll detect the same branch change repeatedly.
    if (shouldTrack) {
      this.candidates.set(state.worktreeId, nextContext);
    } else if (currentContext) {
      this.candidates.delete(state.worktreeId);
    }

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

    if (!shouldTrack) {
      return;
    }

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

  public start(intervalMs?: number): Promise<void> {
    if (this.isPolling) {
      logWarn("PullRequestService already polling");
      return Promise.resolve();
    }

    if (!this.cwd) {
      logWarn("PullRequestService not initialized - call initialize() first");
      return Promise.resolve();
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

    return this.checkForPRs().finally(() => {
      this.scheduleNextPoll();
      this.scheduleRevalidation();
    });
  }

  public stop(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.revalidationTimer) {
      clearTimeout(this.revalidationTimer);
      this.revalidationTimer = null;
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

  private scheduleRevalidation(): void {
    if (!this.isPolling || !this.isEnabled) {
      return;
    }

    if (this.revalidationTimer) {
      clearTimeout(this.revalidationTimer);
    }

    this.revalidationTimer = setTimeout(() => {
      this.revalidationTimer = null;
      void this.revalidateResolvedPRs().then(() => this.scheduleRevalidation());
    }, RESOLVED_REVALIDATION_INTERVAL_MS);
  }

  private async revalidateResolvedPRs(): Promise<void> {
    if (!this.isEnabled || this.resolvedWorktrees.size === 0) {
      return;
    }

    // Collect resolved worktrees that need revalidation
    const candidatesToRevalidate: PRCheckCandidate[] = [];
    for (const worktreeId of this.resolvedWorktrees) {
      const context = this.candidates.get(worktreeId);
      if (context) {
        candidatesToRevalidate.push({
          worktreeId,
          issueNumber: context.issueNumber,
          branchName: context.branchName,
        });
      }
    }

    if (candidatesToRevalidate.length === 0) {
      return;
    }

    logDebug("Revalidating resolved PRs", { count: candidatesToRevalidate.length });

    try {
      const result = await batchCheckLinkedPRs(this.cwd, candidatesToRevalidate);

      if (result.error) {
        logWarn("Revalidation check failed", { error: result.error });
        return;
      }

      for (const [worktreeId, checkResult] of result.results) {
        const existingPR = this.detectedPRs.get(worktreeId);
        const newPR = checkResult.pr;

        if (!newPR) {
          // PR no longer exists (deleted?) - clear state
          this.resolvedWorktrees.delete(worktreeId);
          this.detectedPRs.delete(worktreeId);

          logInfo("PR no longer found during revalidation - clearing state", { worktreeId });
          events.emit("sys:pr:cleared", { worktreeId, timestamp: Date.now() });
          continue;
        }

        // Check if PR metadata changed (state, number, title, or url)
        const prChanged =
          existingPR &&
          (existingPR.state !== newPR.state ||
            existingPR.number !== newPR.number ||
            existingPR.title !== newPR.title ||
            existingPR.url !== newPR.url);

        if (prChanged) {
          logInfo("PR metadata changed during revalidation", {
            worktreeId,
            prNumber: newPR.number,
            changes: {
              state:
                existingPR.state !== newPR.state
                  ? `${existingPR.state} → ${newPR.state}`
                  : undefined,
              number:
                existingPR.number !== newPR.number
                  ? `${existingPR.number} → ${newPR.number}`
                  : undefined,
              title: existingPR.title !== newPR.title ? true : undefined,
              url: existingPR.url !== newPR.url ? true : undefined,
            },
          });

          this.detectedPRs.set(worktreeId, newPR);

          const issueNumber =
            checkResult.issueNumber ?? this.candidates.get(worktreeId)?.issueNumber;
          events.emit("sys:pr:detected", {
            worktreeId,
            prNumber: newPR.number,
            prUrl: newPR.url,
            prState: newPR.state,
            prTitle: newPR.title,
            issueNumber,
            issueTitle: checkResult.issueTitle,
            timestamp: Date.now(),
          });
        }
      }
    } catch (error) {
      logWarn("Revalidation check error", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
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
        } else if (issueNumber && !checkResult.issueTitle) {
          events.emit("sys:issue:not-found", {
            worktreeId,
            issueNumber,
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
