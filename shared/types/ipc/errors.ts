/** Serialized error that survives Electron's structured clone algorithm */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
  context?: Record<string, unknown>;
  cause?: SerializedError;
  properties?: Record<string, unknown>;
}

export interface IpcSuccessEnvelope<T = unknown> {
  __canopyIpcEnvelope: true;
  ok: true;
  data: T;
}

export interface IpcErrorEnvelope {
  __canopyIpcEnvelope: true;
  ok: false;
  error: SerializedError;
}

export type IpcEnvelope<T = unknown> = IpcSuccessEnvelope<T> | IpcErrorEnvelope;

export function isIpcEnvelope(value: unknown): value is IpcEnvelope {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>).__canopyIpcEnvelope === true
  );
}

/** Error type */
export type ErrorType = "git" | "process" | "filesystem" | "network" | "config" | "unknown";

/** Action that can be retried after an error */
export type RetryAction = "terminal" | "git" | "worktree";

/** Payload sent from main to renderer to report retry progress */
export interface RetryProgressPayload {
  id: string;
  attempt: number;
  maxAttempts: number;
}

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
  /** Correlation ID linking this error across main process logs, error store, and notification history */
  correlationId?: string;
  /** Human-readable recovery suggestion based on error classification */
  recoveryHint?: string;
  /** Retry progress state (set during active retry loop) */
  retryProgress?: { attempt: number; maxAttempts: number };
}
