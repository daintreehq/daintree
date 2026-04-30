/** Serialized error that survives Electron's structured clone algorithm */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  /**
   * User-facing message carried by `AppError`. Promoted to a top-level field
   * (rather than living in `properties`) so it survives the packaged-build
   * strip in `electron/setup/security.ts`.
   */
  userMessage?: string;
  /**
   * Classified reason carried by `GitOperationError`. Promoted to a top-level
   * field so it survives the packaged-build strip and lets the renderer drive
   * recovery UI without relying on substring-matching the message.
   */
  gitReason?: GitOperationReason;
  errno?: number;
  syscall?: string;
  path?: string;
  context?: Record<string, unknown>;
  cause?: SerializedError;
  properties?: Record<string, unknown>;
}

export interface IpcSuccessEnvelope<T = unknown> {
  __daintreeIpcEnvelope: true;
  ok: true;
  data: T;
}

export interface IpcErrorEnvelope {
  __daintreeIpcEnvelope: true;
  ok: false;
  error: SerializedError;
}

export type IpcEnvelope<T = unknown> = IpcSuccessEnvelope<T> | IpcErrorEnvelope;

export function isIpcEnvelope(value: unknown): value is IpcEnvelope {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>).__daintreeIpcEnvelope === true
  );
}

/**
 * Keys that an IPC handler must never include in its return value. These
 * collide with the envelope discriminator that `security.ts` adds around
 * every handler return — when a handler returns `{ ok: false, ... }` the
 * outer wrapper still reports `ok: true` and the renderer's
 * `_unwrappingInvoke` silently swallows the inner failure.
 */
type ForbiddenEnvelopeKey = "ok" | "success";

/**
 * Branded shape produced when a handler's declared return type contains a
 * forbidden envelope discriminator key. The property name carries the
 * remediation hint, so TypeScript surfaces it in the compile error:
 *
 *   Property '"IPC handler must throw new AppError(...) instead of returning {ok|success: ...} — see #6020"' is missing
 */
export interface IpcHandlerEnvelopeViolation {
  readonly "IPC handler must throw new AppError(...) instead of returning {ok|success: ...} — see #6020": never;
}

/**
 * Distributive conditional: rejects any object type that carries `ok` or
 * `success` as a key (in any branch of a union). Pass-through for primitive
 * results, `void`, `null`, and objects without those keys.
 *
 * Used to constrain typed-handler return positions in
 * `electron/ipc/define.ts` (`PlainHandler` / `ContextHandler`) and
 * `electron/ipc/utils.ts` (`typedHandle` / `typedHandleWithContext`). The
 * constraint catches the antipattern at the registration site, directing
 * developers to throw an error instead of returning an inner-envelope shape.
 */
export type ForbidIpcEnvelopeKeys<T> = T extends object
  ? Extract<keyof T, ForbiddenEnvelopeKey> extends never
    ? T
    : IpcHandlerEnvelopeViolation
  : T;

/** Error type */
export type ErrorType =
  | "git"
  | "process"
  | "filesystem"
  | "network"
  | "config"
  | "validation"
  | "unknown";

/**
 * Discriminated reason for a failed git operation. The classifier in
 * `shared/utils/gitOperationErrors.ts` maps simple-git stderr output to one of
 * these reasons so UI code can branch without substring-matching raw stderr.
 */
export type GitOperationReason =
  | "auth-failed"
  | "network-unavailable"
  | "repository-not-found"
  | "not-a-repository"
  | "dubious-ownership"
  | "config-missing"
  | "worktree-dirty"
  | "conflict-unresolved"
  | "push-rejected-outdated"
  | "push-rejected-policy"
  | "pathspec-invalid"
  | "lfs-missing"
  | "lfs-quota-exceeded"
  | "hook-rejected"
  | "system-io-error"
  | "unknown";

/**
 * Structured contextual CTA for an error. `actionId` is dispatched via the
 * renderer's ActionService when the user clicks the recovery button. All
 * fields are plain primitives so the object survives structured clone.
 */
export interface RecoveryAction {
  label: string;
  actionId: string;
  args?: Record<string, unknown>;
}

/** Action that can be retried after an error */
export type RetryAction = "terminal" | "git" | "worktree";

/** Payload sent from main to renderer to report retry progress */
export interface RetryProgressPayload {
  id: string;
  attempt: number;
  maxAttempts: number;
}

/** Application error record stored for UI display (errorStore / banners). */
export interface ErrorRecord {
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
  /** Classified reason when this error originated from a git operation */
  gitReason?: GitOperationReason;
  /** Structured CTA the renderer can surface alongside the error */
  recoveryAction?: RecoveryAction;
}
