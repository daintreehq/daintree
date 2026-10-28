/**
 * `@daintreehq/plugin-sdk/operations` — durable, recoverable remote operations
 * for a plugin worker (#14109), journaled in a `host.db` database and shown as
 * `host.tasks` tasks.
 *
 * A zero-build worker can import this entry without installing anything: the
 * plugin worker serves it from a copy that ships with the app whenever the
 * plugin has no SDK of its own.
 */

export {
  createOperationManager,
  OperationError,
  OperationConflictError,
  OperationCapacityError,
  OPERATION_TERMINAL_STATES,
  OPERATION_INPUT_MAX_CHARS,
  OPERATION_CHECKPOINT_MAX_CHARS,
  OPERATION_RESULT_MAX_CHARS,
  OPERATION_IDEMPOTENCY_KEY_MAX,
  OPERATION_ERROR_MESSAGE_MAX,
  OPERATION_LIST_MAX,
} from "./operations/manager.js";

export type {
  OperationManagerHost,
  OperationJson,
  OperationState,
  OperationCallContext,
  OperationRef,
  OperationProgress,
  OperationPollResult,
  OperationReconcileResult,
  OperationProvider,
  OperationRetryPolicy,
  OperationKind,
  OperationManagerOptions,
  OperationSubmitOptions,
  OperationSnapshot,
  OperationListFilter,
  OperationManager,
} from "./operations/manager.js";
