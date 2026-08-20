import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { minimalSpawnEnv } from "../../utils/minimalSpawnEnv.js";
import {
  PLUGIN_PROCESS_KILL_GRACE_MS,
  PLUGIN_PROCESS_MAX_CONCURRENT,
  type PluginProcessInfo,
  type PluginProcessStatus,
  type PluginProcessStreamEvent,
} from "../../../shared/types/ipc/pluginProcess.js";
import type { PluginProcessDataChunk, PluginProcessMode } from "../../../shared/types/plugin.js";
import type { ManagedPtyBackend, PluginPtyExit } from "./PluginPtyTransport.js";

export { minimalSpawnEnv };

/**
 * Cap on output buffered for a process whose plugin has not yet attached an
 * `onData` subscriber (#11300). A `--machine`-mode daemon greets the instant it
 * starts — often before the worker's subscription RPC has round-tripped — so
 * dropping those bytes would strand a plugin waiting for a handshake it already
 * missed. Bounded because a chatty process with no subscriber must not grow
 * unbounded; oldest chunks are dropped first.
 */
export const PLUGIN_PROCESS_EARLY_DATA_CAP_BYTES = 64 * 1024;

/**
 * How long a terminated process keeps its unreplayed output. Covers the worker's
 * `onData` subscription round-trip (milliseconds) with room to spare, while
 * bounding what a plugin running many short jobs can accumulate — exited records
 * live until the plugin unloads, so without an expiry each one would hold up to
 * {@link PLUGIN_PROCESS_EARLY_DATA_CAP_BYTES} forever.
 */
export const PLUGIN_PROCESS_EARLY_DATA_RETENTION_MS = 30_000;

/** Default PTY geometry when a plugin does not pin one. */
export const PLUGIN_PTY_DEFAULT_COLS = 80;
export const PLUGIN_PTY_DEFAULT_ROWS = 24;

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
  /**
   * Writable input, present only in `duplex` mode (#11871) — `pipe` mode spawns
   * with stdin `"ignore"`, so Node hands back `null` there and every write is a
   * no-op. Mirrors `ChildProcessWithoutNullStreams["stdin"]`.
   */
  stdin: NodeJS.WritableStream | null;
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

/** Fields every resolved spawn carries, regardless of execution backend. */
export interface ResolvedProcessSpawnBase {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string>;
  /**
   * Panel to route this process's stream events to, or `null` to broadcast to
   * every panel the plugin owns (#11300 — the historical behavior).
   */
  panelId: string | null;
}

/** Resolved spawn config, discriminated by execution backend. */
export type ResolvedProcessSpawn =
  | (ResolvedProcessSpawnBase & { mode: "pipe" })
  | (ResolvedProcessSpawnBase & { mode: "duplex" })
  | (ResolvedProcessSpawnBase & { mode: "pty"; cols: number; rows: number });

/** The pipe-mode arm of {@link ResolvedProcessSpawn}. */
export type ResolvedPipeSpawn = Extract<ResolvedProcessSpawn, { mode: "pipe" }>;
/** The duplex arm of {@link ResolvedProcessSpawn} (#11871). */
export type ResolvedDuplexSpawn = Extract<ResolvedProcessSpawn, { mode: "duplex" }>;
/** The PTY arm of {@link ResolvedProcessSpawn}. */
export type ResolvedPtySpawn = Extract<ResolvedProcessSpawn, { mode: "pty" }>;
/**
 * The plain-child arms, as the spawner sees them — everything that runs through
 * `node:child_process` rather than the pty-host. Both share one lifecycle; they
 * differ only in whether fd 0 is piped.
 */
export type ResolvedChildSpawn = ResolvedPipeSpawn | ResolvedDuplexSpawn;
/** The plain-child modes, for narrowing at a `startChild` call boundary. */
export type ChildProcessMode = ResolvedChildSpawn["mode"];

/**
 * Spawn shim, injected so unit tests substitute a controllable fake. Production
 * wiring uses `node:child_process.spawn` with the plugin's `env` applied over
 * the safe-key allowlist, `shell: false` (no shell interpolation — argv is
 * passed verbatim), and `windowsHide: true`. `config.mode` selects fd 0:
 * `duplex` pipes it, `pipe` leaves it closed.
 */
export type ProcessSpawner = (config: ResolvedChildSpawn) => ManagedChildProcess;

/**
 * Allocator for the interactive backend (#11300). Injected for the same reason
 * as {@link ProcessSpawner}: production wiring routes to the crash-isolated
 * pty-host via `PluginPtyTransport`, while unit tests hand in a controllable
 * fake so the manager's lifecycle is testable without node-pty.
 *
 * `generation` distinguishes incarnations of one handle id across `restart()`.
 */
export type PtyProcessSpawner = (
  config: ResolvedPtySpawn,
  context: { id: string; generation: number }
) => Promise<ManagedPtyBackend>;

/**
 * Fan-out sink for one process's stream events. The manager calls this for
 * output chunks and exit/crash — `PluginService` wires it to the owning
 * plugin's `postToPanel("process", …)` transport so events reach the plugin's
 * panels. Kept as a per-plugin closure so the manager never needs a reference to
 * the renderer broadcast layer.
 *
 * `panelId` is the spawn-time routing target: a non-null value delivers to that
 * one panel, `null` broadcasts to all of the plugin's panels.
 */
export type ProcessStreamSink = (
  pluginId: string,
  event: PluginProcessStreamEvent,
  panelId: string | null
) => void;

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
  mode: PluginProcessMode;
  command: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string>;
  /** Spawn-time stream routing target; `null` broadcasts to all the plugin's panels. */
  panelId: string | null;
  status: PluginProcessStatus;
  child: ManagedChildProcess | null;
  /** The interactive backend in PTY mode; `null` in pipe mode or once exited. */
  ptyBackend: ManagedPtyBackend | null;
  /** Listener disposers for the current PTY incarnation. */
  ptyDisposers: (() => void)[];
  /** Incarnation counter — bumped by `restart()` so stale backend events are dropped. */
  generation: number;
  /** Current PTY geometry, preserved across `restart()`. Unused in pipe mode. */
  cols: number;
  rows: number;
  /**
   * A `resize()` that arrived while no PTY was live (during the async spawn or
   * a restart). Last write wins, and it is folded into the NEXT PTY's initial
   * size rather than replayed as a late SIGWINCH against a PTY that was already
   * created at the wrong size.
   */
  pendingResize: { cols: number; rows: number } | null;
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
  dataCallbacks: Set<(chunk: PluginProcessDataChunk) => void>;
  /** Output produced before the first `onData` subscriber attached; replayed once, then dropped. */
  earlyData: PluginProcessDataChunk[];
  earlyDataBytes: number;
  /** Bounds how long a terminated process holds unreplayed output. */
  earlyDataExpiry: ReturnType<typeof setTimeout> | null;
  /** Latches true on the first `onData` subscription — after that, delivery is live-only. */
  hadDataSubscriber: boolean;
}

/**
 * Host-side handle {@link PluginProcessManager.spawn} returns. `PluginHostFactory`
 * wraps it with the plugin-liveness gates and narrows it to the mode-appropriate
 * public shape — `write`/`resize` are inert on a pipe-mode process.
 */
export interface ManagedProcessHandle {
  id: string;
  mode: PluginProcessMode;
  kill: () => void;
  restart: () => Promise<void>;
  onExit: (cb: (info: ExitInfo) => void) => () => void;
  onCrash: (cb: (info: ExitInfo) => void) => () => void;
  onData: (cb: (chunk: PluginProcessDataChunk) => void) => () => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
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
 *  - Output streams to the owning plugin's panels via the injected
 *    {@link ProcessStreamSink} — targeted at the spawn's `panelId` when given,
 *    broadcast otherwise — and to the plugin's own code via `onData`. An exited
 *    handle frees its concurrency slot.
 *  - `restart()` reuses the same handle id and bumps `restartCount`.
 *
 * Two execution backends (#11300), sharing all of the above:
 *  - `pipe` (default, unchanged): `child_process.spawn` in main, stdin closed,
 *    stdout/stderr piped and reported separately.
 *  - `pty`: a real pseudo-terminal allocated in the crash-isolated pty-host, so
 *    the child sees a TTY and accepts `write()`/`resize()`. A PTY has one
 *    combined output stream, so it emits `data` rather than `stdout`/`stderr`.
 *    Every incarnation carries a generation, so a `restart()`'s outgoing PTY
 *    cannot deliver output or an exit against its successor.
 */
export class PluginProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly spawner: ProcessSpawner;
  private readonly ptySpawner: PtyProcessSpawner | null;
  private readonly streamSink: ProcessStreamSink;
  private readonly auditor: ProcessSpawnAuditor;
  private readonly killGraceMs: number;

  constructor(options: {
    streamSink: ProcessStreamSink;
    spawner?: ProcessSpawner;
    /** Omitted (or null) disables interactive mode — `mode: "pty"` then rejects. */
    ptySpawner?: PtyProcessSpawner | null;
    auditor?: ProcessSpawnAuditor;
    killGraceMs?: number;
  }) {
    this.streamSink = options.streamSink;
    this.spawner = options.spawner ?? defaultSpawner;
    this.ptySpawner = options.ptySpawner ?? null;
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
  async spawn(pluginId: string, config: ResolvedProcessSpawn): Promise<ManagedProcessHandle> {
    if (this.runningCount(pluginId) >= PLUGIN_PROCESS_MAX_CONCURRENT) {
      throw new PluginProcessConcurrencyError(pluginId, PLUGIN_PROCESS_MAX_CONCURRENT);
    }
    if (config.mode === "pty" && !this.ptySpawner) {
      throw new Error(
        `Plugin "${pluginId}" process.spawn: interactive (pty) mode is unavailable on this host`
      );
    }

    const id = randomUUID();
    const managed: ManagedProcess = {
      id,
      pluginId,
      mode: config.mode,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      panelId: config.panelId,
      status: "running",
      child: null,
      ptyBackend: null,
      ptyDisposers: [],
      generation: 0,
      cols: config.mode === "pty" ? config.cols : PLUGIN_PTY_DEFAULT_COLS,
      rows: config.mode === "pty" ? config.rows : PLUGIN_PTY_DEFAULT_ROWS,
      pendingResize: null,
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
      dataCallbacks: new Set(),
      earlyData: [],
      earlyDataBytes: 0,
      earlyDataExpiry: null,
      hadDataSubscriber: false,
    };
    // Registered before any await so the concurrency cap counts this process
    // immediately — a burst of interactive spawns must not all sail past the cap
    // while their PTYs are still allocating.
    this.processes.set(id, managed);
    await this.startBackend(managed);

    return {
      id,
      mode: managed.mode,
      kill: () => this.kill(id),
      restart: () => this.restart(id),
      onExit: (cb) => this.subscribe(managed, "exit", cb),
      onCrash: (cb) => this.subscribe(managed, "crash", cb),
      onData: (cb) => this.subscribeData(managed, cb),
      write: (data) => this.write(id, data),
      resize: (cols, rows) => this.resize(id, cols, rows),
    };
  }

  /**
   * Write to a writable process's input — a PTY's terminal input, or a duplex
   * child's stdin (#11871). No-op for pipe mode (stdin was never opened) and
   * after exit, matching the handle's fire-and-forget `void` contract.
   */
  write(id: string, data: string): void {
    const managed = this.processes.get(id);
    if (!managed || typeof data !== "string") return;
    if (managed.mode === "pty") {
      managed.ptyBackend?.write(data);
      return;
    }
    if (managed.mode !== "duplex" || managed.status !== "running") return;
    const stdin = managed.child?.stdin;
    if (!stdin) return;
    // Same closed-stream predicate as PluginMcpSupervisor.writeFrame — these
    // properties exist on every Node writable but not on the structural
    // NodeJS.WritableStream. Unlike writeFrame this NO-OPS rather than throwing:
    // `write()` is `void` in the plugin contract, so a write racing the child's
    // exit must behave like `kill()` on a dead process, not blow up in a timer.
    const writable = stdin as NodeJS.WritableStream & {
      writable?: boolean;
      writableEnded?: boolean;
      destroyed?: boolean;
    };
    if (writable.writableEnded || writable.destroyed || writable.writable === false) return;
    // Deliberately fire-and-forget: the boolean backpressure signal is dropped
    // rather than surfaced, because `write()` is synchronous `void` across the
    // dev-worker bridge too and this is a low-volume control-plane channel. The
    // once-per-child 'error' listener installed in startChild absorbs an EPIPE
    // landing in the gap between the guard above and this call.
    stdin.write(data);
  }

  /**
   * Resize an interactive process's terminal. While no PTY is live (mid-spawn or
   * mid-restart) the dimensions are retained last-write-wins and folded into the
   * next PTY's INITIAL size — never replayed as a post-start SIGWINCH against a
   * PTY that was already constructed at the wrong geometry.
   */
  resize(id: string, cols: number, rows: number): void {
    const managed = this.processes.get(id);
    if (!managed || managed.mode !== "pty") return;
    if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) return;
    managed.cols = cols;
    managed.rows = rows;
    if (managed.ptyBackend && managed.status === "running") {
      managed.ptyBackend.resize(cols, rows);
      return;
    }
    if (managed.status === "running") {
      managed.pendingResize = { cols, rows };
    }
  }

  private subscribeData(
    managed: ManagedProcess,
    cb: (chunk: PluginProcessDataChunk) => void
  ): () => void {
    if (typeof cb !== "function") {
      throw new Error(`Plugin "${managed.pluginId}" process.onData: callback must be a function`);
    }
    let disposed = false;
    const first = !managed.hadDataSubscriber;
    managed.hadDataSubscriber = true;
    // Not added to the live set once the process has terminated — there is
    // nothing further to deliver, and holding the closure would pin plugin scope
    // past unload. The buffered replay below still runs, which is the whole
    // point for a process that finished before its subscriber attached.
    if (!managed.terminalOutcome) managed.dataCallbacks.add(cb);
    if (first && managed.earlyData.length > 0) {
      const replay = managed.earlyData;
      managed.earlyData = [];
      managed.earlyDataBytes = 0;
      if (managed.earlyDataExpiry) {
        clearTimeout(managed.earlyDataExpiry);
        managed.earlyDataExpiry = null;
      }
      // Replay on the next microtask so the handler runs after `spawn()`
      // resolves, matching live-subscription timing.
      queueMicrotask(() => {
        // The disposer can run before this microtask does (`const off =
        // onData(cb); off();`), and delivering afterwards would be a
        // use-after-dispose. Gate on the closure's own flag rather than set
        // membership — a terminated process never entered the set at all.
        if (disposed) return;
        for (const chunk of replay) {
          this.invokeDataCallback(managed, cb, chunk);
        }
      });
    }
    return () => {
      if (disposed) return;
      disposed = true;
      managed.dataCallbacks.delete(cb);
    };
  }

  private invokeDataCallback(
    managed: ManagedProcess,
    cb: (chunk: PluginProcessDataChunk) => void,
    chunk: PluginProcessDataChunk
  ): void {
    try {
      cb(chunk);
    } catch (err) {
      console.error(`[PluginProcessManager] onData callback for "${managed.pluginId}" threw:`, err);
    }
  }

  /**
   * Deliver one output chunk: to the plugin's panels (routed by `panelId`) and
   * to the plugin's own `onData` subscribers. Before the first subscriber
   * attaches, chunks are buffered up to {@link PLUGIN_PROCESS_EARLY_DATA_CAP_BYTES}
   * so an eagerly-greeting daemon isn't missed; panel streaming is never delayed.
   */
  private emitData(
    managed: ManagedProcess,
    stream: PluginProcessDataChunk["stream"],
    chunk: string
  ): void {
    this.streamSink(managed.pluginId, { kind: stream, id: managed.id, chunk }, managed.panelId);
    const payload: PluginProcessDataChunk = { stream, chunk };
    if (!managed.hadDataSubscriber) {
      // Measured in BYTES, not `chunk.length`: a PTY streaming UTF-8 (box
      // drawing, CJK, emoji) is 2-4x its code-unit count, so a code-unit budget
      // would let the buffer grow several times past the cap it advertises.
      managed.earlyData.push(payload);
      managed.earlyDataBytes += Buffer.byteLength(chunk, "utf-8");
      while (
        managed.earlyDataBytes > PLUGIN_PROCESS_EARLY_DATA_CAP_BYTES &&
        managed.earlyData.length > 0
      ) {
        const dropped = managed.earlyData.shift();
        managed.earlyDataBytes -= dropped ? Buffer.byteLength(dropped.chunk, "utf-8") : 0;
      }
      return;
    }
    for (const cb of [...managed.dataCallbacks]) {
      this.invokeDataCallback(managed, cb, payload);
    }
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

  /** Dispatch to the mode's allocator. Both routes end in a live backend or a recorded crash. */
  private async startBackend(managed: ManagedProcess): Promise<void> {
    if (managed.mode === "pty") {
      await this.startPty(managed);
      return;
    }
    // Pass the narrowed mode explicitly: `ManagedProcess.mode` is the full
    // PluginProcessMode, so the control-flow narrowing above would be lost at
    // the call boundary and a new backend could silently spawn as `pipe`.
    this.startChild(managed, managed.mode);
  }

  private async startPty(managed: ManagedProcess): Promise<void> {
    const spawner = this.ptySpawner;
    if (!spawner) {
      this.recordStartFailure(managed, new Error("interactive (pty) mode is unavailable"));
      return;
    }
    const generation = managed.generation;
    // A resize that arrived before this PTY existed becomes its INITIAL size —
    // the child is born at the right geometry instead of being told to change.
    if (managed.pendingResize) {
      managed.cols = managed.pendingResize.cols;
      managed.rows = managed.pendingResize.rows;
      managed.pendingResize = null;
    }

    let backend: ManagedPtyBackend;
    try {
      backend = await spawner(
        {
          mode: "pty",
          command: managed.command,
          args: managed.args,
          cwd: managed.cwd,
          env: managed.env,
          panelId: managed.panelId,
          cols: managed.cols,
          rows: managed.rows,
        },
        { id: managed.id, generation }
      );
    } catch (err) {
      // A stale allocation for an incarnation `restart()` already replaced, or
      // for a process torn down mid-flight — its failure is not this one's.
      if (managed.generation !== generation) return;
      this.recordStartFailure(managed, err);
      return;
    }

    // Superseded or torn down while the PTY was allocating: the caller is gone,
    // so kill the orphan rather than adopting it. `killRequested` is the
    // load-bearing half — an unload that lands mid-allocation leaves the record
    // in `running` (there is no live child to report an exit yet), so a status
    // check alone would happily adopt a process the teardown already walked past.
    if (
      managed.generation !== generation ||
      managed.status !== "running" ||
      managed.killRequested
    ) {
      backend.kill("SIGKILL");
      backend.dispose();
      // Nothing will ever report an exit for a PTY nobody adopted, so settle the
      // record here — otherwise it sits in `running` forever, pinning a slot.
      if (
        managed.generation === generation &&
        managed.status === "running" &&
        managed.killRequested
      ) {
        this.handlePtyExit(managed, { exitCode: null, signal: "SIGKILL" });
      }
      return;
    }

    managed.ptyBackend = backend;
    managed.pid = backend.pid;

    this.auditor({
      pluginId: managed.pluginId,
      command: managed.command,
      args: managed.args,
      processId: managed.id,
    });

    managed.ptyDisposers.push(
      backend.onData((data) => {
        if (managed.generation !== generation) return;
        this.emitData(managed, "data", data);
      })
    );
    managed.ptyDisposers.push(
      backend.onExit((info) => {
        if (managed.generation !== generation) return;
        this.handlePtyExit(managed, info);
      })
    );

    // A resize racing the allocation lands here — the PTY is live now, so it is
    // a real SIGWINCH rather than a buffered initial size.
    if (managed.pendingResize) {
      const { cols, rows } = managed.pendingResize;
      managed.pendingResize = null;
      managed.cols = cols;
      managed.rows = rows;
      backend.resize(cols, rows);
    }
  }

  private handlePtyExit(managed: ManagedProcess, info: PluginPtyExit): void {
    // Two routes can reach here for one incarnation — a real backend exit and
    // `startPty`'s orphan-adoption guard — so settle at most once.
    if (managed.terminalOutcome) return;
    if (managed.killTimer) {
      clearTimeout(managed.killTimer);
      managed.killTimer = null;
    }
    this.releasePty(managed);
    managed.exitCode = info.exitCode;
    managed.signal = info.signal;
    managed.pid = null;
    const crashed = this.wasCrash(managed);
    managed.status = managed.killRequested ? "killed" : "exited";
    const outcome: ExitInfo = { exitCode: info.exitCode, signal: info.signal };
    managed.terminalOutcome = outcome;
    this.emitTerminal(managed, outcome, crashed);
  }

  /**
   * The single place a PTY backend is let go of. Disposing the listeners before
   * dropping the reference keeps a late event from a torn-down incarnation from
   * reaching callbacks, and the transport's `dispose()` releases the host-side
   * entry so its native handle goes through the pty-host teardown chokepoint.
   */
  private releasePty(managed: ManagedProcess): void {
    for (const dispose of managed.ptyDisposers) {
      try {
        dispose();
      } catch {
        // best-effort
      }
    }
    managed.ptyDisposers.length = 0;
    const backend = managed.ptyBackend;
    managed.ptyBackend = null;
    backend?.dispose();
  }

  /**
   * Record a backend that never came up as a crash, so the plugin's `onCrash`
   * fires with a meaningful outcome rather than the handle dangling in
   * `running` forever. Mirrors the pipe path's synchronous-spawn-failure branch.
   */
  private recordStartFailure(managed: ManagedProcess, err: unknown): void {
    if (managed.terminalOutcome) return;
    // An allocation that fails AFTER the host asked this process down is not a
    // crash — the plugin requested the teardown, so reporting `onCrash` would
    // misattribute an unload to the command.
    const crashed = !managed.killRequested;
    managed.status = managed.killRequested ? "killed" : "exited";
    managed.exitCode = null;
    managed.signal = null;
    managed.pid = null;
    managed.pendingResize = null;
    managed.terminalOutcome = { exitCode: null, signal: null };
    console.error(
      `[PluginProcessManager] spawn for "${managed.pluginId}" threw:`,
      formatErrorMessage(err, "spawn failed")
    );
    queueMicrotask(() => this.emitTerminal(managed, { exitCode: null, signal: null }, crashed));
  }

  private startChild(managed: ManagedProcess, mode: ChildProcessMode): void {
    let child: ManagedChildProcess;
    try {
      child = this.spawner({
        mode,
        command: managed.command,
        args: managed.args,
        cwd: managed.cwd,
        env: managed.env,
        panelId: managed.panelId,
      });
    } catch (err) {
      // A synchronous spawn failure (e.g. ENOENT in some Node versions) is
      // recorded as a crash so the plugin's onCrash fires with a meaningful
      // outcome rather than the handle dangling forever in `running`.
      this.recordStartFailure(managed, err);
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

    // Swallow async 'error' events on stdin (EPIPE when the child dies between
    // `write()`'s guard and the write itself). Installed once per incarnation —
    // never inside `write()`, which would pile up listeners on a chatty plugin —
    // and deliberately never removed: stdio can still emit between the child's
    // 'exit' and the stream's close. The closure captures nothing, so it pins no
    // plugin state. Without it the unhandled stream error would take the main
    // process down under Electron's strict rejection handling.
    child.stdin?.on("error", () => {});

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
      this.emitData(managed, which, chunk);
    });
  }

  private emitTerminal(managed: ManagedProcess, outcome: ExitInfo, crashed: boolean): void {
    // Stream the lifecycle event to the plugin's panels first, then fire the
    // plugin-code callbacks.
    this.streamSink(
      managed.pluginId,
      {
        kind: crashed ? "crash" : "exit",
        id: managed.id,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
      },
      managed.panelId
    );
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
    // Output subscribers die with the process — an exited handle produces no
    // further chunks, and holding the closures would pin plugin scope after unload.
    managed.dataCallbacks.clear();
    // `earlyData` deliberately outlives the exit for a short grace: a fast
    // process can produce its whole output and exit before the worker's
    // `onData` subscription has round-tripped, and clearing on exit would break
    // the replay contract for exactly those processes. The grace is bounded
    // because exited records are not removed until the plugin unloads — a
    // long-lived plugin running many short jobs would otherwise retain up to
    // the cap per completed job, without limit.
    if (managed.earlyData.length > 0 && !managed.earlyDataExpiry) {
      managed.earlyDataExpiry = setTimeout(() => {
        managed.earlyDataExpiry = null;
        managed.earlyData = [];
        managed.earlyDataBytes = 0;
      }, PLUGIN_PROCESS_EARLY_DATA_RETENTION_MS);
      managed.earlyDataExpiry.unref?.();
    }
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
    if (managed.status !== "running") return;
    if (managed.mode === "pty") {
      this.terminatePty(managed);
      return;
    }
    if (!managed.child) return;
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
   * PTY teardown mirrors the pipe grace window: SIGTERM, then SIGKILL if the
   * child outlives it. `killRequested` is set even when the PTY is still
   * allocating, so an in-flight `startPty` adopts nothing and kills the orphan
   * it eventually receives.
   */
  private terminatePty(managed: ManagedProcess): void {
    managed.killRequested = true;
    managed.pendingResize = null;
    const backend = managed.ptyBackend;
    const generation = managed.generation;
    if (!backend) {
      // Still allocating. `startPty`'s post-await status check disposes whatever
      // arrives; there is no live handle to signal yet.
      return;
    }
    backend.kill("SIGTERM");
    if (managed.killTimer) clearTimeout(managed.killTimer);
    managed.killTimer = setTimeout(() => {
      managed.killTimer = null;
      if (
        managed.ptyBackend === backend &&
        managed.generation === generation &&
        managed.status === "running"
      ) {
        backend.kill("SIGKILL");
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
    if (managed.mode === "pty") {
      await this.restartPty(managed);
      return;
    }
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
    // Respawn in the SAME plain-child mode: a duplex restart must come back with
    // a writable stdin, not silently demote to pipe. Narrowed by the
    // `mode === "pty"` early return at the top of `restart`.
    this.startChild(managed, managed.mode);
  }

  /**
   * Interactive restart. Bumping the generation FIRST is what makes this safe:
   * every listener and transport event carries the generation it was created
   * under, so the outgoing PTY's data and exit are dropped instead of flipping
   * the handle into a terminal state mid-restart. Geometry survives the swap and
   * becomes the replacement's initial size.
   */
  private async restartPty(managed: ManagedProcess): Promise<void> {
    if (managed.killTimer) {
      clearTimeout(managed.killTimer);
      managed.killTimer = null;
    }
    managed.generation++;
    const previous = managed.ptyBackend;
    // Kill BEFORE releasing: the backend's own guards go false once `dispose()`
    // drops its transport entry, so a kill issued afterwards is silently swallowed
    // and the predecessor survives unowned. Force-kill rather than
    // SIGTERM-then-escalate — the successor is allocating right now, and a
    // detached predecessor lingering past the grace window would sit outside the
    // concurrency cap with nothing tracking it.
    previous?.kill("SIGKILL");
    this.releasePty(managed);

    managed.restartCount++;
    managed.killRequested = false;
    managed.status = "running";
    managed.exitCode = null;
    managed.signal = null;
    managed.pid = null;
    managed.terminalOutcome = null;
    managed.spawnedAt = Date.now();
    await this.startPty(managed);
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

const defaultSpawner: ProcessSpawner = (config) => {
  const child = nodeSpawn(config.command, config.args, {
    cwd: config.cwd,
    // Do NOT inherit the full host env — that would leak the main process's
    // tokens to any shell:exec plugin. Allowlist essentials + plugin-provided.
    env: minimalSpawnEnv(config.env),
    // fd 0 is the only difference between the two plain-child modes: duplex
    // pipes stdin so the plugin can drive the child (#11871), pipe leaves it
    // closed. fd 1 and fd 2 stay separate in BOTH — that separation is the
    // whole reason a stdio JSON-RPC peer can't use `mode: "pty"`.
    stdio: [config.mode === "duplex" ? "pipe" : "ignore", "pipe", "pipe"],
    // No shell — argv is passed verbatim, closing the shell-injection vector a
    // process-orchestrator plugin would otherwise carry.
    shell: false,
    windowsHide: true,
  });
  return child as unknown as ManagedChildProcess;
};
