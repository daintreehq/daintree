/** Log level */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Levels valid for per-logger overrides. `"off"` is a filter sentinel that
 * suppresses all output from a logger; it is never stored on `LogEntry.level`.
 */
export type LogOverrideLevel = LogLevel | "off";

/**
 * Per-logger level overrides. Keys are stable `"<process>:Module"` identifiers,
 * or the `"*"` wildcard which applies to every logger. A `"<process>:*"` key
 * applies to all loggers in that process (e.g. `"pty-host:*"`).
 */
export type LogLevelOverrides = Record<string, LogOverrideLevel>;

/** A log entry */
export interface LogEntry {
  /** Unique identifier */
  id: string;
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Log level */
  level: LogLevel;
  /** Log message */
  message: string;
  /** Additional context */
  context?: Record<string, unknown>;
  /** Source of the log (component/service name) */
  source?: string;
}

/** Options for filtering logs */
export interface LogFilterOptions {
  /** Filter by log levels */
  levels?: LogLevel[];
  /** Filter by sources */
  sources?: string[];
  /** Search string */
  search?: string;
  /** Start time filter */
  startTime?: number;
  /** End time filter */
  endTime?: number;
}
