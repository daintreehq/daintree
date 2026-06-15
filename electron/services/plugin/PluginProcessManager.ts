import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  PLUGIN_PROCESS_KILL_GRACE_MS,
  PLUGIN_PROCESS_MAX_CONCURRENT,
  type PluginProcessInfo,
  type PluginProcessStatus,
  type PluginProcessStreamEvent,
} from "../../../shared/types/ipc/pluginProcess.js";

/**
 * Minimal surface of a spawned child the manager actually exercises. Declared
 * as an interface so unit tests can hand in a controllable fake without pulling
 * in `child_process`. Mirrors the runtime shape of `ChildProcessWithoutNullStreams`
 * (and the execa subprocess) for the fields used here.
 */
export interface ManagedChildProcess {
  pid: number | undefined;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  /** Send a termination signal. Returns false if the process is already gone. */
  kill(signal?: NodeJS.Signals): boolean;
  /** Subscribe to the child's terminal `exit` (code, signal). */
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  /** Surface async stream/stdio errors (e.g. EPIPE) so they don't crash the host. */
  on(event: "error", listener: (err: Error) => void): unknown;
}

/** Resolved spawn config the injectable spawner receives. */
export interface ResolvedProcessSpawn {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string>;
}

/**
 * Spawn shim, injected so unit tests substitute a controllable fake. Production
 * wiring uses `node:child_process.spawn` with the host env merged under the
 * plugin's `env`, `shell: false` (no shell interpolation — argv is passed
 * verbatim), and `windowsHide: true`.
 */
export type ProcessSpawner = (config: ResolvedProcessSpawn) => ManagedChildProcess;

/**
 * Fan-out sink for one process's stream events. The manager calls this for
 * stdout/stderr chunks and exit/crash — `PluginService` wires it to the
 * owning plugin's `postToPanel("process", …)` transport so events reach the
 * plugin's panels. Kept as a per-plugin closure so the manager never needs a
 * reference to the renderer broadcast layer.
 */
export type ProcessStreamSink = (pluginId: string, event: PluginProcessStreamEvent) => void;

/** Audit hook invoked once per spawn (and per restart). Best-effort — must not throw. */
export type ProcessSpawnAuditor = (input: {
  pluginId: string;
  command: string;
  args: string[];
  processId: string;
}) => void;

interface ExitInfo {
  exitCode: number | null;
  signal: string | null;
}

interface ManagedProcess {
  id: string;
  pluginId: string;
  command: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string>;
  status: PluginProcessStatus;
  child: ManagedChildProcess | null;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  spawnedAt: number;
  restartCount: number;
  /** True once `kill()`/unload signalled this process down — flips exit into the `killed` terminal state and suppresses `onCrash`. */
  killRequested: boolean;
  /** Pending SIGKILL escalation timer, cleared when the child exits inside the grace window. */
  killTimer: ReturnType<typeof setTimeout> | null;
  /** Recorded terminal outcome once the process has exited, so late `onExit`/`onCrash` subscribers still fire. */
  terminalOutcome: ExitInfo | null;
  exitCallbacks: Set<(info: ExitInfo) => void>;
  crashCallbacks: Set<(info: ExitInfo) => void>;
}

export class PluginProcessConcurrencyError extends Error {
  readonly code = "PROCESS_LIMIT_REACHED";
  constructor(pluginId: string, cap: number) {
    super(
      `PROCESS_LIMIT_REACHED: plugin "${pluginId}" already has ${cap} running processes (cap ${cap})`
    );
    this.name = "PluginProcessConcurrencyError";
  }
}

/**
 * Spawns and supervises child processes on behalf of plugins (#9234). One
 * singleton lives in the main process. `PluginService.createHost` exposes a
 * `host.process.spawn` gated on the declared `shell:exec` capability; the
 * spawned process is tied to the plugin lifecycle — `killAll(pluginId)` on
 * unload/disable/revoke SIGTERMs every outstanding process and escalates to
 * SIGKILL after {@link PLUGIN_PROCESS_KILL_GRACE_MS}.
 *
 * Invariants:
 *  - A per-plugin cap ({@link PLUGIN_PROCESS_MAX_CONCURRENT}) over RUNNING
 *    processes is enforced at spawn; an over-cap spawn rejects rather than
 *    queueing, so a misbehaving orchestrator can't fork-bomb the host.
 *  - stdout/stderr stream to the owning plugin's panels via the injected
 *    {@link ProcessStreamSink}; an exited handle frees its concurrency slot.
 *  - `restart()` reuses the same handle id and bumps `restartCount`.
 */
export class PluginProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly spawner: ProcessSpawner;
  private readonly streamSink: ProcessStreamSink;
  private readonly auditor: ProcessSpawnAuditor;
  private readonly killGraceMs: number;

  constructor(options: {
    streamSink: ProcessStreamSink;
    spawner?: ProcessSpawner;
    auditor?: ProcessSpawnAuditor;
    killGraceMs?: number;
  }) {
    this.streamSink = options.streamSink;
    this.spawner = options.spawner ?? defaultSpawner;
    this.auditor = options.auditor ?? (() => {});
    this.killGraceMs = options.killGraceMs ?? PLUGIN_PROCESS_KILL_GRACE_MS;
  }

  /** Count of RUNNING processes owned by `pluginId`. */
  runningCount(pluginId: string): number {
    let n = 0;
    for (const p of this.processes.values()) {
      if (p.pluginId === pluginId && p.status === "running") n++;
    }
    return n;
  }

  /**
   * Spawn a process for `pluginId`. The caller (`PluginService`) has already
   * checked the `shell:exec` capability gate. Throws
   * {@link PluginProcessConcurrencyError} when the per-plugin cap is reached.
   */
  spawn(
    pluginId: string,
    config: ResolvedProcessSpawn
  ): {
    id: string;
    kill: () => void;
    restart: () => Promise<void>;
    onExit: (cb: (info: ExitInfo) => void) => () => void;
    onCrash: (cb: (info: ExitInfo) => void) => () => void;
  } {
    if (this.runningCount(pluginId) >= PLUGIN_PROCESS_MAX_CONCURRENT) {
      throw new PluginProcessConcurrencyError(pluginId, PLUGIN_PROCESS_MAX_CONCURRENT);
    }

    const id = randomUUID();
    const managed: ManagedProcess = {
      id,
      pluginId,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      status: "running",
      child: null,
      pid: null,
      exitCode: null,
      signal: null,
      spawnedAt: Date.now(),
      restartCount: 0,
      killRequested: false,
      killTimer: null,
      terminalOutcome: null,
      exitCallbacks: new Set(),
      crashCallbacks: new Set(),
    };
    this.processes.set(id, managed);
    this.startChild(managed);

    return {
      id,
      kill: () => this.kill(id),
      restart: () => this.restart(id),
      onExit: (cb) => this.subscribe(managed, "exit", cb),
      onCrash: (cb) => this.subscribe(managed, "crash", cb),
    };
  }

  private subscribe(
    managed: ManagedProcess,
    kind: "exit" | "crash",
    cb: (info: ExitInfo) => void
  ): () => void {
    if (typeof cb !== "function") {
      throw new Error(`Plugin "${managed.pluginId}" process.${kind}: callback must be a function`);
    }
    const set = kind === "exit" ? managed.exitCallbacks : managed.crashCallbacks;
    // A subscriber attaching after the process already terminated still gets the
    // outcome — fire on the next microtask so the handler runs after the
    // synchronous spawn() return, matching live-subscription timing.
    if (managed.terminalOutcome) {
      const outcome = managed.terminalOutcome;
      if (kind === "exit" || this.wasCrash(managed)) {
        queueMicrotask(() => {
          try {
            cb(outcome);
          } catch (err) {
            console.error(
              `[PluginProcessManager] late ${kind} callback for "${managed.pluginId}" threw:`,
              err
            );
          }
        });
      }
      return () => {};
    }
    set.add(cb);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      set.delete(cb);
    };
  }

  private wasCrash(managed: ManagedProcess): boolean {
    if (managed.killRequested) return false;
    return managed.exitCode !== 0 || managed.signal !== null;
  }

  private startChild(managed: ManagedProcess): void {
    let child: ManagedChildProcess;
    try {
      child = this.spawner({
        command: managed.command,
        args: managed.args,
        cwd: managed.cwd,
        env: managed.env,
      });
    } catch (err) {
      // A synchronous spawn failure (e.g. ENOENT in some Node versions) is
      // recorded as a crash so the plugin's onCrash fires with a meaningful
      // outcome rather than the handle dangling forever in `running`.
      managed.status = "exited";
      managed.exitCode = null;
      managed.signal = null;
      managed.terminalOutcome = { exitCode: null, signal: null };
      console.error(
        `[PluginProcessManager] spawn for "${managed.pluginId}" threw:`,
        formatErrorMessage(err, "spawn failed")
      );
      queueMicrotask(() => this.emitTerminal(managed, { exitCode: null, signal: null }, true));
      return;
    }

    managed.child = child;
    managed.pid = child.pid ?? null;

    this.auditor({
      pluginId: managed.pluginId,
      command: managed.command,
      args: managed.args,
      processId: managed.id,
    });

    // Surface async stream/stdio errors (EPIPE after a crash, spawn ENOENT via
    // the async 'error' event) without letting them crash the main process.
    child.on("error", (err) => {
      console.warn(
        `[PluginProcessManager] process "${managed.id}" (${managed.pluginId}) error:`,
        formatErrorMessage(err, "process error")
      );
    });

    this.attachStream(managed, child, "stdout");
    this.attachStream(managed, child, "stderr");

    child.on("exit", (code, signal) => {
      // Ignore an exit from a stale child after a restart already replaced it.
      if (managed.child !== child) return;
      if (managed.killTimer) {
        clearTimeout(managed.killTimer);
        managed.killTimer = null;
      }
      managed.exitCode = code;
      managed.signal = signal;
      managed.child = null;
      managed.pid = null;
      const crashed = this.wasCrash(managed);
      managed.status = managed.killRequested ? "killed" : "exited";
      const outcome: ExitInfo = { exitCode: code, signal: signal ?? null };
      managed.terminalOutcome = outcome;
      this.emitTerminal(managed, outcome, crashed);
    });
  }

  private attachStream(
    managed: ManagedProcess,
    child: ManagedChildProcess,
    which: "stdout" | "stderr"
  ): void {
    const stream = child[which];
    if (!stream) return;
    stream.setEncoding("utf-8");
    stream.on("data", (chunk: string) => {
      // Drop late emits from a child a restart already replaced.
      if (managed.child !== child) return;
      this.streamSink(managed.pluginId, { kind: which, id: managed.id, chunk });
    });
  }

  private emitTerminal(managed: ManagedProcess, outcome: ExitInfo, crashed: boolean): void {
    // Stream the lifecycle event to the plugin's panels first, then fire the
    // plugin-code callbacks.
    this.streamSink(managed.pluginId, {
      kind: crashed ? "crash" : "exit",
      id: managed.id,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
    });
    for (const cb of [...managed.exitCallbacks]) {
      try {
        cb(outcome);
      } catch (err) {
        console.error(
          `[PluginProcessManager] onExit callback for "${managed.pluginId}" threw:`,
          err
        );
      }
    }
    if (crashed) {
      for (const cb of [...managed.crashCallbacks]) {
        try {
          cb(outcome);
        } catch (err) {
          console.error(
            `[PluginProcessManager] onCrash callback for "${managed.pluginId}" threw:`,
            err
          );
        }
      }
    }
    managed.exitCallbacks.clear();
    managed.crashCallbacks.clear();
  }

  /**
   * Terminate one process: clean SIGTERM, then SIGKILL after the grace window
   * if it hasn't exited. No-op if already terminated or unknown.
   */
  kill(id: string): void {
    const managed = this.processes.get(id);
    if (!managed) return;
    this.terminate(managed);
  }

  private terminate(managed: ManagedProcess): void {
    if (managed.status !== "running" || !managed.child) return;
    managed.killRequested = true;
    const child = managed.child;
    try {
      child.kill("SIGTERM");
    } catch {
      // already-exited — the exit handler does the bookkeeping
    }
    if (managed.killTimer) clearTimeout(managed.killTimer);
    managed.killTimer = setTimeout(() => {
      managed.killTimer = null;
      // Still the same live child? Escalate. The exit handler clears the timer
      // when the child exits inside the grace window, so reaching here means it
      // didn't.
      if (managed.child === child && managed.status === "running") {
        try {
          child.kill("SIGKILL");
        } catch {
          // best-effort
        }
      }
    }, this.killGraceMs);
    managed.killTimer.unref?.();
  }

  /**
   * Kill the current child (if any) and respawn with the same
   * command/args/cwd/env. Reuses the handle id and bumps `restartCount`.
   */
  async restart(id: string): Promise<void> {
    const managed = this.processes.get(id);
    if (!managed) return;
    if (managed.child) {
      // Synchronously detach the old child so its exit handler no-ops (identity
      // check) and doesn't flip the handle into a terminal state mid-restart.
      const old = managed.child;
      managed.child = null;
      if (managed.killTimer) {
        clearTimeout(managed.killTimer);
        managed.killTimer = null;
      }
      try {
        old.kill("SIGTERM");
      } catch {
        // best-effort
      }
      // Escalate the detached old child to SIGKILL if it ignores SIGTERM, so a
      // repeated restart can't strand a pile of live children outside the cap.
      const oldChild = old;
      const escalation = setTimeout(() => {
        try {
          oldChild.kill("SIGKILL");
        } catch {
          // best-effort
        }
      }, this.killGraceMs);
      escalation.unref?.();
    }
    managed.restartCount++;
    managed.killRequested = false;
    managed.status = "running";
    managed.exitCode = null;
    managed.signal = null;
    managed.terminalOutcome = null;
    managed.spawnedAt = Date.now();
    this.startChild(managed);
  }

  /**
   * Tear down every process owned by `pluginId`. Called from `unloadPlugin` /
   * disable / revoke. SIGTERMs each running child and escalates to SIGKILL
   * after the grace window. Drops the handle records so a reload starts clean.
   */
  killAll(pluginId: string): void {
    for (const managed of this.processes.values()) {
      if (managed.pluginId !== pluginId) continue;
      this.terminate(managed);
    }
    // Drop terminal-state records immediately; running ones are removed by their
    // exit handler. We keep running entries in the map so their SIGKILL
    // escalation timer can still find the live child.
    for (const [id, managed] of this.processes) {
      if (managed.pluginId === pluginId && managed.status !== "running") {
        this.processes.delete(id);
      }
    }
  }

  /** Read-only snapshot for the `plugin-process:list` IPC, optionally scoped to one plugin. */
  list(pluginId?: string): PluginProcessInfo[] {
    const out: PluginProcessInfo[] = [];
    for (const managed of this.processes.values()) {
      if (pluginId !== undefined && managed.pluginId !== pluginId) continue;
      out.push(this.toInfo(managed));
    }
    return out;
  }

  private toInfo(managed: ManagedProcess): PluginProcessInfo {
    return {
      id: managed.id,
      pluginId: managed.pluginId,
      command: managed.command,
      args: [...managed.args],
      cwd: managed.cwd ?? null,
      status: managed.status,
      pid: managed.pid,
      exitCode: managed.exitCode,
      signal: managed.signal,
      spawnedAt: managed.spawnedAt,
      restartCount: managed.restartCount,
    };
  }
}

// Env vars a child needs to function (PATH lookup, locale, temp, OS essentials)
// WITHOUT inheriting the main process's secrets (API tokens, auth keys). A
// plugin passes anything else it needs explicitly via options.env.
const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SHELL",
  "USER",
  "LOGNAME",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
];

export function minimalSpawnEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string") base[key] = value;
  }
  return { ...base, ...extra };
}

const defaultSpawner: ProcessSpawner = (config) => {
  const child = nodeSpawn(config.command, config.args, {
    cwd: config.cwd,
    // Do NOT inherit the full host env — that would leak the main process's
    // tokens to any shell:exec plugin. Allowlist essentials + plugin-provided.
    env: minimalSpawnEnv(config.env),
    stdio: ["ignore", "pipe", "pipe"],
    // No shell — argv is passed verbatim, closing the shell-injection vector a
    // process-orchestrator plugin would otherwise carry.
    shell: false,
    windowsHide: true,
  });
  return child as unknown as ManagedChildProcess;
};
