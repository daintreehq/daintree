/**
 * Renderer-facing projection of a plugin-managed child process (#9234). A
 * plugin holding `shell:exec` spawns processes through `host.process.spawn`;
 * the {@link PluginProcessManager} streams their output to the plugin's panels
 * over the `postToPanel` transport and exposes this read-only snapshot to the
 * renderer (e.g. a process/task dashboard) via `plugin-process:list`.
 *
 * The observability types here (`PluginProcessInfo`, `PluginProcessStatus`,
 * `PLUGIN_PROCESS_MAX_CONCURRENT`, `PLUGIN_PROCESS_KILL_GRACE_MS`) are
 * renderer-IPC internals, NOT the plugin-author surface — that lives in
 * `PluginProcessApi` / `PluginProcessHandle` in `shared/types/plugin.ts`. The
 * two exceptions are `PluginProcessStreamEvent` and `PLUGIN_PROCESS_STREAM_CHANNEL`:
 * panel authors subscribe to the process stream via the documented
 * `plugin.on(pluginId, PLUGIN_PROCESS_STREAM_CHANNEL)` pattern, so those two ARE
 * re-exported from the public `@daintreehq/plugin-sdk` barrel (#10515).
 */

/**
 * Lifecycle phase of a managed child process.
 *
 * - `running`: spawned and live.
 * - `exited`: the child exited (any code, including 0) of its own accord or
 *   after a `kill()` — terminal.
 * - `killed`: the host signalled the process down (plugin `kill()`, unload,
 *   disable, or revoke) — terminal.
 */
export type PluginProcessStatus = "running" | "exited" | "killed";

/** Read-only snapshot of one managed process for the `plugin-process:list` IPC. */
export interface PluginProcessInfo {
  /** Host-assigned opaque handle id, unique per app session. */
  readonly id: string;
  /** Owning plugin id (`manifest.name`). */
  readonly pluginId: string;
  /** The resolved command (post-spawn), for display. */
  readonly command: string;
  /** Argument vector the process was spawned with. */
  readonly args: readonly string[];
  /** Working directory the process was anchored to, or `null` when inherited. */
  readonly cwd: string | null;
  readonly status: PluginProcessStatus;
  /** OS pid while running; `null` once the process has exited. */
  readonly pid: number | null;
  /** Exit code, or `null` if still running or terminated by signal. */
  readonly exitCode: number | null;
  /** Terminating signal (e.g. `"SIGTERM"`), or `null`. */
  readonly signal: string | null;
  /** Epoch millis the process was spawned. */
  readonly spawnedAt: number;
  /** Monotonic restart counter — incremented each time `restart()` respawns it. */
  readonly restartCount: number;
}

/**
 * Per-plugin cap on concurrently-running managed processes. A `spawn` past the
 * cap rejects rather than queueing — a misbehaving process-orchestrator plugin
 * must not be able to fork-bomb the host. Tracked over `running` processes
 * only; an exited/killed handle frees a slot.
 */
export const PLUGIN_PROCESS_MAX_CONCURRENT = 8;

/**
 * Grace period between the clean `SIGTERM` and the escalated `SIGKILL` when the
 * host tears a process down (plugin `kill()`, unload, disable, revoke). A
 * well-behaved child exits on `SIGTERM` well inside this window; a hung child
 * is force-killed after it.
 */
export const PLUGIN_PROCESS_KILL_GRACE_MS = 3_000;

/**
 * Channel name (under the plugin's `postToPanel` namespace) carrying process
 * stream events. `as const` pins the literal `"process"` type through
 * declaration emit — without it, the re-exported constant widens to `string`
 * in the composite build's emitted `.d.ts`, which plugin authors depend on for
 * `plugin.on(pluginId, PLUGIN_PROCESS_STREAM_CHANNEL)` channel-key narrowing.
 */
export const PLUGIN_PROCESS_STREAM_CHANNEL = "process" as const;

/**
 * Event payloads streamed to a plugin's panels over
 * `postToPanel(PLUGIN_PROCESS_STREAM_CHANNEL, …)`. The renderer subscribes via
 * `plugin.on(pluginId, "process")` and discriminates on `kind`.
 */
export type PluginProcessStreamEvent =
  | { kind: "stdout"; id: string; chunk: string }
  | { kind: "stderr"; id: string; chunk: string }
  /**
   * PTY-mode output (#11300). A pseudo-terminal merges stdout and stderr into a
   * single stream, so an interactive process emits `data` instead of the
   * `stdout`/`stderr` pair — a panel rendering process output should handle all
   * three. Pipe-mode processes never emit this kind.
   */
  | { kind: "data"; id: string; chunk: string }
  | { kind: "exit"; id: string; exitCode: number | null; signal: string | null }
  | { kind: "crash"; id: string; exitCode: number | null; signal: string | null };
