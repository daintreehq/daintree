/**
 * WorktreeMonitor - Per-worktree state machine for monitoring.
 *
 * Extracted from WorkspaceService to encapsulate per-worktree concerns:
 * - Polling timers and adaptive backoff
 * - Git status comparison and state hashing
 * - Note file reading
 * - Mood categorization
 */

import { simpleGit } from "simple-git";
import type { WorktreeChanges, FileChangeDetail, Worktree, WorktreeMood } from "../../shared/types/domain.js";
import type { WorktreeSnapshot } from "../../shared/types/workspace-host.js";
import { invalidateGitStatusCache, getWorktreeChangesWithStats } from "../utils/git.js";
import { WorktreeRemovedError } from "../utils/errorTypes.js";
import { categorizeWorktree } from "../services/worktree/mood.js";
import { AdaptivePollingStrategy, NoteFileReader } from "../services/worktree/index.js";

export interface WorktreeMonitorConfig {
  basePollingInterval: number;
  adaptiveBackoff: boolean;
  pollIntervalMax: number;
  circuitBreakerThreshold: number;
}

export interface WorktreeMonitorCallbacks {
  onUpdate: (snapshot: WorktreeSnapshot) => void;
  onRemoved?: (worktreeId: string) => void;
  onError?: (worktreeId: string, error: Error) => void;
}

export class WorktreeMonitor {
  readonly id: string;
  readonly path: string;
  readonly isMainWorktree: boolean;

  private _name: string;
  private _branch: string | undefined;
  private _gitDir: string | undefined;
  private _isCurrent: boolean;

  // State
  private worktreeChanges: WorktreeChanges | null = null;
  private changes: FileChangeDetail[] | undefined;
  private mood: WorktreeMood = "stable";
  private summary: string | undefined;
  private modifiedCount: number = 0;
  private lastActivityTimestamp: number | null = null;
  private previousStateHash: string = "";

  // Note state
  private aiNote: string | undefined;
  private aiNoteTimestamp: number | undefined;

  // Issue/PR state
  private issueNumber: number | undefined;
  private prNumber: number | undefined;
  private prUrl: string | undefined;
  private prState: "open" | "closed" | "merged" | undefined;

  // Polling state
  private pollingTimer: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private isUpdating: boolean = false;
  private pollingEnabled: boolean = true;

  // Components
  private pollingStrategy: AdaptivePollingStrategy;
  private noteReader: NoteFileReader;

  constructor(
    worktree: Worktree,
    private config: WorktreeMonitorConfig,
    private callbacks: WorktreeMonitorCallbacks,
    private mainBranch: string
  ) {
    this.id = worktree.id;
    this.path = worktree.path;
    this._name = worktree.name;
    this._branch = worktree.branch;
    this._gitDir = worktree.gitDir;
    this._isCurrent = worktree.isCurrent;
    this.isMainWorktree = Boolean(worktree.isMainWorktree);

    this.pollingStrategy = new AdaptivePollingStrategy({
      baseInterval: config.basePollingInterval,
    });
    this.pollingStrategy.updateConfig(
      config.adaptiveBackoff,
      config.pollIntervalMax,
      config.circuitBreakerThreshold
    );

    this.noteReader = new NoteFileReader(worktree.path);
  }

  get name(): string {
    return this._name;
  }

  set name(value: string) {
    this._name = value;
  }

  get branch(): string | undefined {
    return this._branch;
  }

  set branch(value: string | undefined) {
    this._branch = value;
  }

  get isCurrent(): boolean {
    return this._isCurrent;
  }

  set isCurrent(value: boolean) {
    this._isCurrent = value;
  }

  /**
   * Set the issue number for this worktree.
   */
  setIssueNumber(issueNumber: number | undefined): void {
    this.issueNumber = issueNumber;
  }

  /**
   * Set PR information for this worktree.
   */
  setPRInfo(info: { prNumber?: number; prUrl?: string; prState?: "open" | "closed" | "merged" }): void {
    this.prNumber = info.prNumber;
    this.prUrl = info.prUrl;
    this.prState = info.prState;
  }

  /**
   * Clear PR information for this worktree.
   */
  clearPRInfo(): void {
    this.prNumber = undefined;
    this.prUrl = undefined;
    this.prState = undefined;
  }

  /**
   * Update polling configuration.
   */
  updateConfig(config: Partial<WorktreeMonitorConfig>): void {
    if (config.basePollingInterval !== undefined) {
      this.pollingStrategy.setBaseInterval(config.basePollingInterval);
    }
    this.pollingStrategy.updateConfig(
      config.adaptiveBackoff ?? this.config.adaptiveBackoff,
      config.pollIntervalMax ?? this.config.pollIntervalMax,
      config.circuitBreakerThreshold ?? this.config.circuitBreakerThreshold
    );
    this.config = { ...this.config, ...config };
  }

  /**
   * Start monitoring this worktree.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.pollingEnabled = true;

    await this.updateGitStatus(true);

    if (this.isRunning && this.pollingEnabled) {
      this.scheduleNextPoll();
    }
  }

  /**
   * Stop monitoring this worktree.
   */
  stop(): void {
    this.isRunning = false;
    this.clearTimers();
  }

  /**
   * Force a refresh of git status.
   */
  async refresh(): Promise<void> {
    if (this.pollingStrategy.isCircuitBreakerTripped()) {
      this.pollingStrategy.reset();
    }
    await this.updateGitStatus(true);
  }

  /**
   * Pause polling (e.g., when app is backgrounded).
   */
  pausePolling(): void {
    this.pollingEnabled = false;
    this.clearTimers();
  }

  /**
   * Resume polling after a pause.
   */
  resumePolling(): void {
    if (!this.isRunning) return;

    this.pollingStrategy.reset();
    this.pollingEnabled = true;

    if (!this.pollingStrategy.isCircuitBreakerTripped()) {
      const jitter = Math.random() * 2000;
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = null;
        if (this.isRunning && this.pollingEnabled) {
          this.scheduleNextPoll();
        }
      }, jitter);
    }
  }

  /**
   * Get the current snapshot of this worktree.
   */
  getSnapshot(): WorktreeSnapshot {
    return {
      id: this.id,
      path: this.path,
      name: this._name,
      branch: this._branch,
      isCurrent: this._isCurrent,
      isMainWorktree: this.isMainWorktree,
      gitDir: this._gitDir,
      summary: this.summary,
      modifiedCount: this.modifiedCount,
      changes: this.changes,
      mood: this.mood,
      lastActivityTimestamp: this.lastActivityTimestamp,
      aiNote: this.aiNote,
      aiNoteTimestamp: this.aiNoteTimestamp,
      issueNumber: this.issueNumber,
      prNumber: this.prNumber,
      prUrl: this.prUrl,
      prState: this.prState,
      worktreeChanges: this.worktreeChanges,
      worktreeId: this.id,
      timestamp: Date.now(),
    };
  }

  /**
   * Check if the circuit breaker is tripped.
   */
  isCircuitBreakerTripped(): boolean {
    return this.pollingStrategy.isCircuitBreakerTripped();
  }

  private clearTimers(): void {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  private scheduleNextPoll(): void {
    if (!this.isRunning || !this.pollingEnabled) {
      return;
    }

    if (this.pollingStrategy.isCircuitBreakerTripped()) {
      return;
    }

    if (this.pollingTimer) {
      return;
    }

    const nextInterval = this.pollingStrategy.calculateNextInterval();

    this.pollingTimer = setTimeout(() => {
      this.pollingTimer = null;
      void this.poll();
    }, nextInterval);
  }

  private async poll(): Promise<void> {
    if (!this.isRunning || this.pollingStrategy.isCircuitBreakerTripped()) {
      return;
    }

    const startTime = Date.now();

    try {
      await this.updateGitStatus();
      this.pollingStrategy.recordSuccess(Date.now() - startTime);
    } catch (error) {
      const tripped = this.pollingStrategy.recordFailure(Date.now() - startTime);

      if (tripped) {
        this.mood = "error";
        this.summary = "⚠️ Polling stopped after consecutive failures";
        this.emitUpdate();
        return;
      }
    }

    if (this.isRunning && !this.pollingStrategy.isCircuitBreakerTripped()) {
      this.scheduleNextPoll();
    }
  }

  private async updateGitStatus(forceRefresh: boolean = false): Promise<void> {
    if (this.isUpdating) {
      return;
    }

    this.isUpdating = true;

    try {
      if (forceRefresh) {
        invalidateGitStatusCache(this.path);
      }

      const newChanges = await getWorktreeChangesWithStats(this.path, forceRefresh);

      if (!this.isRunning) {
        return;
      }

      const noteData = await this.noteReader.read();
      const currentHash = this.calculateStateHash(newChanges);
      const stateChanged = currentHash !== this.previousStateHash;
      const noteChanged =
        noteData?.content !== this.aiNote || noteData?.timestamp !== this.aiNoteTimestamp;

      if (!stateChanged && !noteChanged && !forceRefresh) {
        return;
      }

      const isInitialLoad = this.previousStateHash === "";
      const isNowClean = newChanges.changedFileCount === 0;
      const hasPendingChanges = newChanges.changedFileCount > 0;
      const shouldUpdateTimestamp =
        (stateChanged && !isInitialLoad) || (isInitialLoad && hasPendingChanges);

      if (shouldUpdateTimestamp) {
        this.lastActivityTimestamp = Date.now();
      }

      if (
        isNowClean ||
        isInitialLoad ||
        (this.worktreeChanges && this.worktreeChanges.changedFileCount === 0)
      ) {
        this.summary = await this.fetchLastCommitMessage(newChanges);
      }

      let nextMood = this.mood;
      try {
        nextMood = await categorizeWorktree(
          {
            id: this.id,
            path: this.path,
            name: this._name,
            branch: this._branch,
            isCurrent: this._isCurrent,
          },
          newChanges || undefined,
          this.mainBranch
        );
      } catch {
        nextMood = "error";
      }

      this.previousStateHash = currentHash;
      this.worktreeChanges = newChanges;
      this.changes = newChanges.changes;
      this.modifiedCount = newChanges.changedFileCount;
      this.mood = nextMood;
      this.aiNote = noteData?.content;
      this.aiNoteTimestamp = noteData?.timestamp;

      this.emitUpdate();
    } catch (error) {
      if (error instanceof WorktreeRemovedError) {
        this.mood = "error";
        this.summary = "⚠️ Directory not accessible";
        this.emitUpdate();
        return;
      }

      const errorMessage = (error as Error).message || "";
      if (errorMessage.includes("index.lock")) {
        return;
      }

      this.mood = "error";
      this.emitUpdate();
      throw error;
    } finally {
      this.isUpdating = false;
    }
  }

  private calculateStateHash(changes: WorktreeChanges): string {
    const hashInput = changes.changes
      .map((c) => `${c.path}:${c.status}:${c.insertions ?? 0}:${c.deletions ?? 0}`)
      .sort()
      .join("|");
    return hashInput;
  }

  private async fetchLastCommitMessage(changes: WorktreeChanges): Promise<string> {
    if (changes.lastCommitMessage) {
      const firstLine = changes.lastCommitMessage.split("\n")[0].trim();
      return `✅ ${firstLine}`;
    }

    try {
      const git = simpleGit(this.path);
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

  private emitUpdate(): void {
    this.callbacks.onUpdate(this.getSnapshot());
  }
}
