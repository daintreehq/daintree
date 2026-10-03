import { logError } from "@/utils/logger";

// One fault policy for every plugin callback the kit runs: a throw is the
// plugin's bug, reported under one prefix and contained to the callback's own
// output. What stands in for that output is the caller's call, because a
// formatter can fall back to plain text while a validator must refuse.

/** Logs a plugin fault. Never pass a value the plugin handed in (a secret, a draft). */
export function reportPluginFault(what: string, error?: unknown): void {
  logError(`[plugin-ui] ${what}`, error);
}

/** A dev-build note to the plugin author about a prop the kit ignored or narrowed. */
export function warnPluginAuthor(message: string): void {
  if (import.meta.env.DEV) console.warn(`[plugin-ui] ${message}`);
}

/**
 * A runner for one component's plugin callbacks: a throw is reported in the
 * component's name and treated as having returned `fallback`.
 */
export function guardCallbacks(component: string) {
  return function attempt<T>(run: () => T, fallback: T): T {
    try {
      return run();
    } catch (error) {
      reportPluginFault(`${component} callback threw`, error);
      return fallback;
    }
  };
}

// A formatter runs per tick and per render, so a broken one is reported at
// most this often rather than once per call.
const FORMATTER_REPORT_INTERVAL_MS = 5000;
let lastFormatterReport = -Infinity;

/**
 * A plugin's display formatter, made safe: a throw or a non-string result
 * reads as `fallback(value)`. An empty string is kept (an axis may blank a
 * tick); a caller that needs words checks for it. For pure formatting only: a
 * validator or a mutation needs its own failure path.
 */
export function safeFormat<T>(
  format: ((value: T) => unknown) | undefined,
  value: T,
  fallback: (value: T) => string
): string {
  if (typeof format !== "function") return fallback(value);
  let out: unknown;
  try {
    out = format(value);
  } catch (error) {
    const now = Date.now();
    if (now - lastFormatterReport >= FORMATTER_REPORT_INTERVAL_MS) {
      lastFormatterReport = now;
      reportPluginFault("formatter threw", error);
    }
    return fallback(value);
  }
  return typeof out === "string" ? out : fallback(value);
}

/** What a failure says, for a person: its message, or `fallback`. */
export function faultMessage(error: unknown, fallback: string): string {
  try {
    if (error instanceof Error && error.message.trim() !== "") return error.message.trim();
  } catch {
    // A hostile error object; fall through.
  }
  if (typeof error === "string" && error.trim() !== "") return error.trim();
  return fallback;
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  try {
    return (
      (typeof value === "object" || typeof value === "function") &&
      value !== null &&
      typeof (value as { then?: unknown }).then === "function"
    );
  } catch {
    return false;
  }
}

/** A plugin's thenable as a real promise; a `then` that throws becomes a rejection. */
export function settleThenable(value: PromiseLike<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      value.then(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Runs a fire-and-forget plugin callback (a toast action, a confirmation, an
 * event notification): a throw, or a rejection of the promise it returns, is
 * reported once and never left unhandled. Nothing waits on it; a control that
 * holds pending state while a task runs tracks the promise itself.
 */
export function runPluginAction(what: string, run: () => unknown): void {
  let out: unknown;
  try {
    out = run();
  } catch (error) {
    reportPluginFault(`${what} threw`, error);
    return;
  }
  if (isThenable(out)) {
    settleThenable(out).catch((error: unknown) => reportPluginFault(`${what} rejected`, error));
  }
}
