/** Error type */
export type ErrorType = "git" | "process" | "filesystem" | "network" | "config" | "unknown";

/** Action that can be retried after an error */
export type RetryAction = "terminal" | "git" | "worktree";

/** Application error for UI display */
export interface AppError {
  /** Unique identifier */
  id: string;
  /** Timestamp when error occurred */
  timestamp: number;
  /** Error type category */
  type: ErrorType;
  /** User-friendly error message */
  message: string;
  /** Technical details */
  details?: string;
  /** Source of the error */
  source?: string;
  /** Context for debugging */
  context?: {
    worktreeId?: string;
    terminalId?: string;
    filePath?: string;
    command?: string;
  };
  /** Whether this error will auto-dismiss */
  isTransient: boolean;
  /** Whether user has dismissed this error */
  dismissed: boolean;
  /** Action that can be retried */
  retryAction?: RetryAction;
  /** Arguments for retry action */
  retryArgs?: Record<string, unknown>;
  /** Whether this error originated from a previous session (crash recovery) */
  fromPreviousSession?: boolean;
}
