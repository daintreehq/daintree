import { events } from "./events.js";
import {
  batchCheckLinkedPRs,
  clearPRCaches,
  type PRCheckCandidate,
  type LinkedPR,
} from "./GitHubService.js";
import { gitHubRateLimitService } from "./github/index.js";
import { logInfo, logWarn, logDebug } from "../utils/logger.js";
import type { WorktreeSnapshot as WorktreeState } from "../../shared/types/workspace-host.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

// Focus-aware polling cadence: faster when any Daintree window is focused so
// users see PR transitions promptly, slower when fully blurred to conserve the
// GitHub API quota during background sessions.
const FOCUSED_POLL_INTERVAL_MS = 30 * 1000;
const BLURRED_POLL_INTERVAL_MS = 2 * 60 * 1000;
// Minimum gap between blur→focus catch-up polls. Matches SWR's 5s
// `focusThrottleInterval` convention so rapid alt-tabbing doesn't burst the API.
const FOCUS_CATCHUP_THROTTLE_MS = 5 * 1000;

const ERROR_BACKOFF_INTERVALS = [1 * 60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000];

const MAX_CONSECUTIVE_ERRORS = 3;
const UPDATE_DEBOUNCE_MS = 100;

// Slow-cadence revalidation for resolved PRs to detect state changes (merged/closed)
const RESOLVED_REVALIDATION_INTERVAL_MS = 90 * 1000; // 90 seconds

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
  private pollIntervalMs: number = FOCUSED_POLL_INTERVAL_MS;
  private cwd: string = "";
  private isPolling: boolean = false;
  private consecutiveErrors: number = 0;
  private nextRetryAt: number = 0;
  private lastFocusCatchupAt: number = Number.NEGATIVE_INFINITY;

  get isEnabled(): boolean {
    return this.nextRetryAt === 0 || Date.now() >= this.nextRetryAt;
  }

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

    const shouldTrack = !state.isMainWorktree && isCandidateBranch(newBranchName);

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

      if (this.hasUnresolvedCandidates() && this.isEnabled) {
        logDebug("Running debounced PR check", { candidateCount: this.candidates.size });
        void this.checkForPRs().catch((err) =>
          logWarn("Debounced PR check failed", {
            error: formatErrorMessage(err, "Debounced PR check failed"),
          })
        );

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
      this.pollIntervalMs = intervalMs;
    }

    this.isPolling = true;
    this.nextRetryAt = 0;
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
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.nextRetryAt = 0;
    this.consecutiveErrors = 0;
    clearPRCaches();
    await this.checkForPRs();

    if (this.isPolling && this.hasUnresolvedCandidates()) {
      this.scheduleNextPoll();
    }
  }

  public reset(): void {
    this.stop();
    this.candidates.clear();
    this.resolvedWorktrees.clear();
    this.detectedPRs.clear();
    this.consecutiveErrors = 0;
    this.nextRetryAt = 0;
    this.lastFocusCatchupAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * Switch poll cadence based on global window-focus state. Focused = ~30s
   * (snappy enough that PR transitions surface promptly), blurred = ~120s
   * (conserves GitHub API quota during long background sessions). Called
   * from main via the workspace-host IPC pipe; powerMonitor.ts is the focus
   * aggregator and idempotency guard, so this method is only invoked on a
   * real focus-state transition.
   *
   * On focus regain, also fires an immediate catch-up poll throttled to
   * FOCUS_CATCHUP_THROTTLE_MS (5s) — protects against rapid alt-tabbing
   * causing API bursts. The throttle is co-located with the rate-limited
   * resource (this service) rather than the IPC layer to avoid a second
   * round-trip just to decide whether to skip.
   */
  public setFocusCadence(focused: boolean): void {
    const targetInterval = focused ? FOCUSED_POLL_INTERVAL_MS : BLURRED_POLL_INTERVAL_MS;
    this.updatePollInterval(targetInterval);

    if (!focused || !this.isPolling) {
      return;
    }

    const now = Date.now();
    if (now - this.lastFocusCatchupAt < FOCUS_CATCHUP_THROTTLE_MS) {
      logDebug("Skipping PR focus catch-up — within throttle window", {
        sinceLastMs: now - this.lastFocusCatchupAt,
      });
      return;
    }

    if (!this.hasUnresolvedCandidates() || !this.isEnabled) {
      return;
    }

    this.lastFocusCatchupAt = now;

    // Cancel the scheduled poll and run an immediate check; the .finally
    // re-arms the timer at the new (focused) cadence. Avoids waiting up to
    // 30s after focus regain for the next normal tick.
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    void this.checkForPRs()
      .catch((err) => this.handleError(formatErrorMessage(err, "PR focus catch-up failed")))
      .finally(() => this.scheduleNextPoll());
  }

  private updatePollInterval(ms: number): void {
    if (this.pollIntervalMs === ms) {
      return;
    }
    this.pollIntervalMs = ms;
    logDebug("PR poll cadence updated", { intervalMs: ms });

    if (!this.isPolling) {
      return;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.scheduleNextPoll();
  }

  public destroy(): void {
    this.reset();
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  private scheduleNextPoll(): void {
    if (!this.isPolling) {
      return;
    }

    // Defensive clear: setFocusCadence and updatePollInterval can interleave
    // such that a `pollTimer` is already armed when the catch-up's `.finally`
    // re-enters this method. Without this clear we'd orphan the prior timer
    // and double the polling rate until `stop()`.
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (!this.isEnabled) {
      const delay = this.nextRetryAt - Date.now();
      if (delay > 0) {
        logDebug("Circuit breaker tripped - scheduling retry", { delayMs: delay });
        this.pollTimer = setTimeout(() => {
          this.pollTimer = null;
          if (!this.isPolling) return;
          logDebug("Circuit breaker recovery - running immediate check");
          this.consecutiveErrors = 0;
          this.nextRetryAt = 0;
          void this.checkForPRs()
            .catch((err) => this.handleError(formatErrorMessage(err, "PR check failed")))
            .finally(() => this.scheduleNextPoll());
        }, delay);
      }
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
      void this.checkForPRs()
        .catch((err) => this.handleError(formatErrorMessage(err, "PR check failed")))
        .finally(() => this.scheduleNextPoll());
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
    if (!this.isPolling) {
      return;
    }

    if (this.revalidationTimer) {
      clearTimeout(this.revalidationTimer);
    }

    if (!this.isEnabled) {
      const delay = this.nextRetryAt - Date.now();
      if (delay > 0) {
        this.revalidationTimer = setTimeout(() => {
          this.revalidationTimer = null;
          this.scheduleRevalidation();
        }, delay);
      }
      return;
    }

    this.revalidationTimer = setTimeout(() => {
      this.revalidationTimer = null;
      void this.revalidateResolvedPRs()
        .catch((err) =>
          logWarn("Revalidation unexpected error", {
            error: formatErrorMessage(err, "PR revalidation failed"),
          })
        )
        .finally(() => this.scheduleRevalidation());
    }, RESOLVED_REVALIDATION_INTERVAL_MS);
  }

  private async revalidateResolvedPRs(): Promise<void> {
    if (!this.isEnabled || this.resolvedWorktrees.size === 0) {
      return;
    }

    const rateLimitBlock = gitHubRateLimitService.shouldBlockRequest();
    if (rateLimitBlock.blocked && rateLimitBlock.resumeAt) {
      this.nextRetryAt = rateLimitBlock.resumeAt;
      logDebug("Skipping PR revalidation — GitHub rate limit active", {
        reason: rateLimitBlock.reason,
        resumeAt: rateLimitBlock.resumeAt,
      });
      return;
    }

    // Collect resolved worktrees that need revalidation. Always include the
    // detected PR number so GitHubService can use ETag conditional requests
    // to skip GraphQL when nothing has changed.
    const candidatesToRevalidate: PRCheckCandidate[] = [];
    for (const worktreeId of this.resolvedWorktrees) {
      const context = this.candidates.get(worktreeId);
      const detectedPR = this.detectedPRs.get(worktreeId);
      if (context && detectedPR) {
        candidatesToRevalidate.push({
          worktreeId,
          issueNumber: context.issueNumber,
          branchName: context.branchName,
          knownPRNumber: detectedPR.number,
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
        error: formatErrorMessage(error, "PR revalidation failed"),
      });
    }
  }

  private async checkForPRs(): Promise<void> {
    const rateLimitBlock = gitHubRateLimitService.shouldBlockRequest();
    if (rateLimitBlock.blocked && rateLimitBlock.resumeAt) {
      // Park polling at the known resume time without incrementing the
      // circuit breaker. GitHub docs explicitly warn that retrying through a
      // secondary rate limit can escalate to a permanent ban, so even for
      // secondary limits we use the same one-shot resume pattern rather than
      // touching `consecutiveErrors`.
      this.nextRetryAt = rateLimitBlock.resumeAt;
      logDebug("Skipping PR check — GitHub rate limit active", {
        reason: rateLimitBlock.reason,
        resumeAt: rateLimitBlock.resumeAt,
        waitMs: rateLimitBlock.resumeAt - Date.now(),
      });
      return;
    }

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
        this.handleError(result.error, result.rateLimit);
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
      this.handleError(formatErrorMessage(error, "PR check failed"));
    }
  }

  private handleError(
    errorMsg: string,
    rateLimit?: { kind: "primary" | "secondary"; resumeAt: number }
  ): void {
    // Prefer a rate-limit marker captured synchronously alongside the
    // failing request — checking the mutable singleton here would race
    // with a concurrent 2xx clearing state between the 429 and this
    // handler. Treat a rate-limit pause distinctly from a circuit-breaker
    // trip: GitHub's docs warn that blind retry through secondary limits
    // can escalate to a permanent ban.
    if (rateLimit) {
      this.nextRetryAt = rateLimit.resumeAt;
      logWarn("PR check hit a GitHub rate limit — pausing without tripping circuit breaker", {
        reason: rateLimit.kind,
        resumeAt: rateLimit.resumeAt,
      });
      return;
    }

    this.consecutiveErrors++;
    logWarn("PR check failed", { error: errorMsg, consecutiveErrors: this.consecutiveErrors });

    if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      const backoffIndex = Math.min(this.consecutiveErrors - 1, ERROR_BACKOFF_INTERVALS.length - 1);
      const backoffMs = ERROR_BACKOFF_INTERVALS[backoffIndex];
      this.nextRetryAt = Date.now() + backoffMs;
      logWarn("Too many consecutive errors - pausing PR polling", { retryInMs: backoffMs });
      events.emit("ui:notify", {
        type: "warning",
        message: "PR detection paused due to errors. Will retry automatically.",
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
