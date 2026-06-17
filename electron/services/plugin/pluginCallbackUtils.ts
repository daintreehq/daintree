/**
 * Consecutive-failure tracking for plugin-supplied event listeners (#10621).
 *
 * Plugin callbacks (`storage.onDidChange`, `settings.onDidChange`,
 * `onDidChangeAgentState`) run inside the host's event dispatch. Before this, a
 * callback that threw was caught and logged but never removed, so a plugin whose
 * listener throws on every event spammed the log indefinitely. These helpers add
 * a small consecutive-failure budget: after N back-to-back throws the listener is
 * quarantined (auto-unsubscribed). A single successful call resets the counter,
 * so a listener that errors only intermittently is never removed.
 */

/** Default consecutive-failure threshold before a throwing listener is quarantined. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/** Mutable per-listener failure counter. Reset to 0 on every successful invocation. */
export interface ListenerFailureState {
  consecutiveFailures: number;
}

export function createListenerFailureState(): ListenerFailureState {
  return { consecutiveFailures: 0 };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Invoke a plugin-supplied listener with consecutive-failure tracking. A throw is
 * caught and logged; after `maxConsecutive` consecutive throws the `remove`
 * disposer fires once to quarantine the listener so it can't spam logs forever. A
 * successful call resets the counter, so an intermittently-failing listener is
 * never quarantined. `remove` must be idempotent — it may already have run from an
 * unrelated unsubscribe — and any error it throws is swallowed so quarantine never
 * destabilizes the dispatch loop.
 *
 * `invoke` may return a Promise: plugins commonly pass `async () => {...}` as a
 * listener, and an async rejection is tracked exactly like a synchronous throw so
 * the quarantine works for both. The dispatch is fire-and-forget either way —
 * `invokeTrackedListener` never blocks the caller on the async result.
 */
export function invokeTrackedListener(
  state: ListenerFailureState,
  pluginId: string,
  label: string,
  invoke: () => unknown,
  remove: () => void,
  maxConsecutive: number = DEFAULT_MAX_CONSECUTIVE_FAILURES
): void {
  const onSuccess = (): void => {
    state.consecutiveFailures = 0;
  };
  const onFailure = (err: unknown): void => {
    state.consecutiveFailures += 1;
    console.error(
      `[PluginService] ${label} callback for "${pluginId}" failed (${state.consecutiveFailures}/${maxConsecutive}):`,
      err
    );
    if (state.consecutiveFailures >= maxConsecutive) {
      console.warn(
        `[PluginService] Auto-unsubscribing ${label} callback for "${pluginId}" after ${maxConsecutive} consecutive failures`
      );
      try {
        remove();
      } catch (removeErr) {
        console.error(
          `[PluginService] Failed to auto-unsubscribe ${label} callback for "${pluginId}":`,
          removeErr
        );
      }
    }
  };

  try {
    const result = invoke();
    if (isThenable(result)) {
      Promise.resolve(result).then(onSuccess, onFailure);
    } else {
      onSuccess();
    }
  } catch (err) {
    onFailure(err);
  }
}
