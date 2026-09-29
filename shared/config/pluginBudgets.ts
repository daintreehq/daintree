/**
 * Transport limits and performance budgets for plugins.
 *
 * Plugin views share the app's main thread, and plugin workers share its IPC
 * channels, so one careless plugin makes the whole app slow. The limits below
 * are enforced (a violation fails the call with a named error); the budgets
 * are observational — the host records measurements against them and shows
 * them to authors and users, but never throttles or blocks a plugin for
 * exceeding one.
 */

const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * Deadline for one `plugin:invoke` round trip when the handler did not declare
 * its own. Deliberately generous: builds, clones and other long operations are
 * legitimate handler work. A handler that needs longer registers with an
 * explicit `timeoutMs`, and `0` opts out of the deadline entirely.
 */
export const PLUGIN_INVOKE_DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Serialized size ceiling for the arguments of one invoke. */
export const PLUGIN_INVOKE_MAX_ARGS_BYTES = 4 * MiB;

/** Serialized size ceiling for the result of one invoke. */
export const PLUGIN_INVOKE_MAX_RESULT_BYTES = 16 * MiB;

/** Serialized size ceiling for one `postToPanel` / `broadcastToRenderer` payload. */
export const PLUGIN_PUSH_MAX_PAYLOAD_BYTES = 1 * MiB;

/**
 * Pushes queued within one macrotask are delivered to a renderer as a single
 * batched IPC message, in order. Nothing is dropped; batching only collapses
 * the per-message IPC and deserialization overhead.
 */
export const PLUGIN_PUSH_MAX_BATCH_SIZE = 256;

/**
 * Default coalescing window for host subscriptions whose events arrive in
 * bursts (worktree lists, active worktree, agent state). A subscriber passes
 * `debounceMs: 0` to receive every event raw.
 */
export const PLUGIN_SUBSCRIPTION_DEFAULT_DEBOUNCE_MS = 100;

/** Observational budgets. Exceeding one is recorded and surfaced, never enforced. */
export const PLUGIN_PERF_BUDGETS = {
  /** `activate()` from call to settled, including worker boot for worker plugins. */
  activationMs: 500,
  /** Clicking open → view module imported and styles prepared. */
  viewLoadMs: 300,
  /** Clicking open → first committed frame of the view painted. */
  viewFirstPaintMs: 500,
  /** p95 React commit duration of a plugin view. */
  viewCommitP95Ms: 16,
  /** p95 invoke round trip. */
  invokeP95Ms: 250,
  /** Sustained host → renderer pushes per second, per plugin. */
  pushesPerSecond: 60,
  /** Sustained host → renderer push bytes per second, per plugin. */
  pushBytesPerSecond: 1 * MiB,
  /** Worker process resident memory. */
  workerRssBytes: 256 * MiB,
} as const;

export type PluginPerfBudgetKey = keyof typeof PLUGIN_PERF_BUDGETS;
