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

/**
 * How long a plugin has to answer a worktree delete confirmation's note check
 * (#13805), activating the plugin included. Short on purpose: the confirmation
 * is already open, and a check that misses it is shown as "didn't answer".
 */
export const PLUGIN_WORKTREE_DELETE_NOTES_TIMEOUT_MS = 3000;

/** Serialized size ceiling for the arguments of one invoke. */
export const PLUGIN_INVOKE_MAX_ARGS_BYTES = 4 * MiB;

/** Serialized size ceiling for the result of one invoke. */
export const PLUGIN_INVOKE_MAX_RESULT_BYTES = 16 * MiB;

/** Serialized size ceiling for one `postToPanel` / `broadcastToRenderer` payload. */
export const PLUGIN_PUSH_MAX_PAYLOAD_BYTES = 1 * MiB;

/**
 * Deadline for one `host.services.call` (#14105) when the caller set none,
 * starting the provider included. Services are backend calls between plugins,
 * not long-running work, so this is far shorter than an invoke's default.
 */
export const PLUGIN_SERVICE_DEFAULT_TIMEOUT_MS = 30_000;

/** Longest deadline a service call may ask for. */
export const PLUGIN_SERVICE_MAX_TIMEOUT_MS = 120_000;

/**
 * Extra time a worker's own wait on `services.call` allows past the call's
 * deadline, so the host's verdict (a typed `timeout`) arrives before the
 * worker gives up on the round trip.
 */
export const PLUGIN_SERVICE_RPC_GRACE_MS = 5_000;

/** Serialized size ceiling for the arguments of one service call. */
export const PLUGIN_SERVICE_MAX_ARGS_BYTES = 256 * KiB;

/** Serialized size ceiling for the result of one service call. */
export const PLUGIN_SERVICE_MAX_RESULT_BYTES = 1 * MiB;

/** Service calls one provider instance runs at once; a call past it is `unavailable`. */
export const PLUGIN_SERVICE_MAX_CONCURRENT_CALLS = 32;

/** Service calls that may be nested inside one another before the next is refused as a `cycle`. */
export const PLUGIN_SERVICE_MAX_CALL_DEPTH = 8;

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

/**
 * Default window for `host.onDidChangeFocusedPanel` (#13221). Longer than the
 * general default: focus flips through several panels on one click-through or
 * tab cycle, and only where it settles says where attention went.
 */
export const PLUGIN_FOCUSED_PANEL_DEFAULT_DEBOUNCE_MS = 250;

/**
 * How long a manifest event route (#13816) collects a burst before its first
 * wake, measured from the first event: a stream of events cannot postpone it.
 */
export const PLUGIN_EVENT_ROUTE_COALESCE_MS = 100;

/**
 * Least time between two routed command runs for one plugin instance. Wakes
 * that arrive faster wait, coalesced, rather than queue.
 */
export const PLUGIN_EVENT_ROUTE_MIN_INTERVAL_MS = 1_000;

/**
 * Distinct wakes (terminals, projects, worktree routes) one instance may have
 * waiting. Past it the oldest is dropped: routes are best effort, never a log.
 */
export const PLUGIN_EVENT_ROUTE_MAX_PENDING = 32;

/**
 * Projects whose worktree set a worktree route remembers. An installed
 * plugin's worktrees follow the focused project, so each project keeps its own
 * baseline; the least recently seen is forgotten past the cap.
 */
export const PLUGIN_EVENT_ROUTE_MAX_WORKTREE_PROJECTS = 8;

/** Lines `host.terminals.readScreen` returns when the caller names none. */
export const PLUGIN_TERMINAL_SCREEN_DEFAULT_LINES = 20;

/** Most lines one `host.terminals.readScreen` call may ask for. */
export const PLUGIN_TERMINAL_SCREEN_MAX_LINES = 100;

/** UTF-8 size ceiling for the text one `host.terminals.readScreen` call returns. */
export const PLUGIN_TERMINAL_SCREEN_MAX_BYTES = 16 * KiB;

/**
 * Calls one loaded plugin may make to `host.terminals.readScreen` in any
 * rolling second. A grid of twenty cards polling once a second uses a third of
 * it; past it a call fails fast with `RATE_LIMITED:` rather than queueing.
 */
export const PLUGIN_TERMINAL_SCREEN_RATE_PER_SECOND = 60;

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
