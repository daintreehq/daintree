/**
 * One structured logger entry travelling from a utility host to Main.
 *
 * The host already wrote this entry to `daintree.log` itself — synchronously
 * for errors, so it survives a crash. Main receives this event purely to
 * mirror the entry into its own in-memory buffer and the renderer's live log
 * view, and must never write it to file again (#12544).
 *
 * Every field is a primitive: `contextJson` carries the context as the same
 * scrubbed JSON string the host wrote to disk rather than the raw object, so
 * the envelope is always structured-clone safe. A context holding a function
 * or symbol value would otherwise throw on `postMessage` (#1232), and the
 * string has already survived `safeStringify`.
 */
export interface HostLogEvent {
  type: "log";
  /** When the host emitted the entry, not when Main received it. */
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  /** The host's logger name, e.g. `"workspace-host:TopologyWatcher"`. */
  source: string;
  /** Already scrubbed by the host — Main must not scrub or clamp it again. */
  message: string;
  /** Scrubbed `safeStringify` output; absent when the entry had no context. */
  contextJson?: string;
}
