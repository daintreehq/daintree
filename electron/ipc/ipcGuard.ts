// Module-level guard ensuring enforceIpcSenderValidation() runs before any
// IPC handler registration. Converts a silent ordering regression into a
// hard startup crash that names the offending channel.
//
// State lives on globalThis so it survives `vi.resetModules()` in tests —
// otherwise a reset would wipe the flag and every subsequent registration
// would fault, even though production has long since called the marker.

declare global {
  var __daintreeIpcSecurityReady: boolean | undefined;
}

/**
 * Mark the IPC sender validation wrapper as installed. Called as the final
 * statement of `enforceIpcSenderValidation()`. Idempotent.
 */
export function markIpcSecurityReady(): void {
  globalThis.__daintreeIpcSecurityReady = true;
}

/**
 * Throw if `enforceIpcSenderValidation()` has not yet run. Call this at every
 * IPC handler registration site so an out-of-order bootstrap fails loudly
 * with the offending channel named.
 */
export function assertIpcSecurityReady(channel: string): void {
  if (!globalThis.__daintreeIpcSecurityReady) {
    throw new Error(
      `IPC handler for '${channel}' registered before enforceIpcSenderValidation() was called. Fix bootstrap order.`
    );
  }
}

/** @internal Reset the guard for testing only. */
export function _resetIpcGuardForTesting(): void {
  globalThis.__daintreeIpcSecurityReady = false;
}
