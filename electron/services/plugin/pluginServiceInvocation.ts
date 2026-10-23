import { AsyncLocalStorage } from "node:async_hooks";

/** One service call that is waiting on the provider it reached (#14105). */
export interface PluginServiceFrame {
  /** Instance key of the provider running the call. */
  readonly providerId: string;
  readonly serviceName: string;
}

/**
 * The service calls the current work is running inside, outermost first, with
 * the innermost call's deadline and signal. Kept apart from the frontend
 * invocation scope, which needs a real endpoint a backend call doesn't have.
 *
 * Only the host writes it: the broker enters it around a provider's method,
 * and a worker's nested `services.call` gets it back from the invoke that
 * carried the call, never from anything the worker sends.
 */
export interface PluginServiceInvocation {
  readonly chain: readonly PluginServiceFrame[];
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

const invocationScope = new AsyncLocalStorage<PluginServiceInvocation>();

/** The service call the current async context runs inside, if any. */
export function currentServiceInvocation(): PluginServiceInvocation | null {
  return invocationScope.getStore() ?? null;
}

/** Run `fn` inside `invocation`, or outside any service call for `null`. */
export function runWithServiceInvocation<T>(
  invocation: PluginServiceInvocation | null,
  fn: () => T
): T {
  return invocation === null ? invocationScope.exit(fn) : invocationScope.run(invocation, fn);
}
