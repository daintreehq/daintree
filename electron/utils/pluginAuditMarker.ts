/**
 * Shared marker for plugin handler failures that have already been written to
 * the audit pipeline at the deepest boundary that owns the operation
 * (`PluginService.dispatchHandler`). The outer `plugin:invoke` IPC handler
 * inspects this marker so a single failure isn't recorded twice: the inner
 * dispatch boundary audits handler throws, while the IPC boundary stays
 * responsible for failures that never reach a handler (untrusted sender,
 * schema/permission/no-handler errors).
 *
 * Lives in its own module so both the service and the IPC handler can share it
 * without the handler reaching into the service's internals.
 */

const PLUGIN_HANDLER_FAILURE_AUDITED = Symbol("plugin-handler-failure-audited");

/**
 * Tag a rethrown handler error as already audited. No-op on primitives — a
 * handler that throws a string/number/null can't carry the marker, so the
 * outer handler will audit it (a rare, acceptable double-record rather than
 * mutating the thrown value).
 */
export function markAuditedHandlerFailure(err: unknown): void {
  if (typeof err === "object" && err !== null) {
    try {
      (err as Record<symbol, unknown>)[PLUGIN_HANDLER_FAILURE_AUDITED] = true;
    } catch {
      // A frozen/sealed error rejects the assignment in strict mode. The
      // marker is best-effort — never let it replace the handler error we're
      // about to rethrow. An unmarked error is simply re-audited by the outer
      // IPC boundary (a duplicate record, not a lost one).
    }
  }
}

/** Whether `err` was already audited at the dispatch boundary. */
export function isAuditedHandlerFailure(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<symbol, unknown>)[PLUGIN_HANDLER_FAILURE_AUDITED] === true
  );
}
