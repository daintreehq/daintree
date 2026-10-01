import type { PluginIpcContext } from "../../../shared/types/plugin.js";
import { PLUGIN_INVOKE_DEFAULT_TIMEOUT_MS } from "../../../shared/config/pluginBudgets.js";

export const PLUGIN_INVOKE_TIMEOUT = "PLUGIN_INVOKE_TIMEOUT";

/**
 * A `plugin:invoke` handler ran past its deadline. The code doubles as the
 * message prefix because only `message` crosses `ipcMain.handle`.
 */
export class PluginInvokeTimeoutError extends Error {
  readonly code = PLUGIN_INVOKE_TIMEOUT;

  constructor(
    readonly pluginId: string,
    readonly channel: string,
    readonly timeoutMs: number
  ) {
    super(
      `${PLUGIN_INVOKE_TIMEOUT}: plugin "${pluginId}" handler "${channel}" did not settle within ${timeoutMs} ms`
    );
    this.name = "PluginInvokeTimeoutError";
  }
}

export function isPluginInvokeTimeoutError(error: unknown): error is PluginInvokeTimeoutError {
  return error instanceof PluginInvokeTimeoutError;
}

// setTimeout fires immediately for delays past a signed 32-bit int.
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Normalize a registration's `timeoutMs`. Omitted means the default deadline;
 * `0` means none. Anything outside `0..MAX_TIMER_MS` is an
 * authoring mistake and throws at registration rather than at first dispatch.
 */
export function resolveInvokeTimeoutMs(pluginId: string, channel: string, raw: unknown): number {
  if (raw === undefined) return PLUGIN_INVOKE_DEFAULT_TIMEOUT_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > MAX_TIMER_MS) {
    throw new Error(
      `Plugin "${pluginId}" registerHandler("${channel}"): timeoutMs must be a number from 0 to ${MAX_TIMER_MS} (0 disables the deadline), got ${String(raw)}`
    );
  }
  return raw;
}

/**
 * The deadline's signal travels beside the context rather than inside it: the
 * context is structured-cloned into the plugin worker, and an AbortSignal
 * cannot be. Keyed by a per-invoke copy, so a context object is never shared
 * between two invokes' signals.
 */
const invokeSignals = new WeakMap<PluginIpcContext, AbortSignal>();

export function invokeSignalFor(ctx: PluginIpcContext): AbortSignal | undefined {
  return invokeSignals.get(ctx);
}

/**
 * Run one handler invocation under its deadline. On expiry the caller is
 * rejected with {@link PluginInvokeTimeoutError} and the signal handed to
 * `run` is aborted with the same error, which is how a worker invoke is told
 * to cancel. An in-process handler cannot be interrupted — it keeps running,
 * but nobody is waiting on it any more. With no deadline, `run` is called
 * directly and its result returned untouched.
 */
export function runWithInvokeDeadline(
  pluginId: string,
  channel: string,
  timeoutMs: number,
  ctx: PluginIpcContext,
  run: (ctx: PluginIpcContext) => unknown
): unknown {
  if (timeoutMs === 0) return run(ctx);
  const controller = new AbortController();
  const scopedCtx: PluginIpcContext = { ...ctx };
  invokeSignals.set(scopedCtx, controller.signal);
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new PluginInvokeTimeoutError(pluginId, channel, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    Promise.resolve()
      .then(() => run(scopedCtx))
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      );
  });
}
