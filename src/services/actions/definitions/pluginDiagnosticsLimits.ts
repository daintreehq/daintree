// Read by plugin.diagnostics' schema in pluginActionArgs.ts and its run in
// pluginActions.impl.ts, kept apart so the run's chunk needs no schema at runtime.

/** Bounds the log tail so one call can't ship a whole 500-line ring buffer. */
export const DIAGNOSTICS_LOG_LIMIT_DEFAULT = 50;
export const DIAGNOSTICS_LOG_LIMIT_MAX = 500;
