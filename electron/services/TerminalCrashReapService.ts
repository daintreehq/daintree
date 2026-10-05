/**
 * TerminalCrashReapService - crash-safe reaping for every terminal's PTY tree
 * (#7526 Windows, #8769 macOS / Linux, #13176 all terminals).
 *
 * Windows: holds a single global Job Object
 * (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) for Daintree's lifetime via the
 * `win-job-object` native addon. Each terminal's PTY PID is assigned on its
 * `terminal-pid` event. When the main Electron process dies for any reason the
 * OS kernel closes the Job HANDLE and reaps every assigned process and its
 * descendants. A process that exits leaves the job on its own, so detaching
 * only drops the memo.
 *
 * macOS / Linux: spawns a single detached supervisor process (the compiled
 * `posix-pty-reaper` binary) and holds the write end of its stdin pipe for the
 * app's lifetime. PTY PIDs are streamed to it as `ADD <pid>` lines and dropped
 * with `REMOVE <pid>` when the terminal exits, so a recycled PID is never left
 * registered. The supervisor tracks each root's descendants (including those
 * that reparent away) by start time; when the main process dies hard, the
 * kernel closes the pipe and the supervisor SIGKILLs every tracked process. On
 * a clean quit {@link TerminalCrashReapService.dispose} sends `DISARM` first so
 * the supervisor stands down — the pty-hosts' own teardown handles those trees.
 *
 * This is the one cleanup tier that survives a hard crash; cooperative paths
 * (`taskkill /T`, graceful kill, renderer teardown) only run when the main
 * process is still executing. On unsupported platforms / when the native
 * binary is missing, every path degrades to a no-op with a single warning.
 */

import { spawn, type ChildProcess } from "node:child_process";

const ATTACH_LOG_TAG = "[TerminalCrashReapService]";

interface NativeAddon {
  assignProcessToHelpJob(pid: number): boolean;
  isAvailable(): boolean;
  getLoadError(): unknown;
}

interface PosixReaperModule {
  getSupervisorPath(): string | null;
  isAvailable(): boolean;
}

type SpawnFn = typeof spawn;

interface PosixDeps {
  reaper: PosixReaperModule | null;
  spawn: SpawnFn;
}

// Every terminal now registers, so a suite that drives PtyClient with made-up
// PIDs would hand them to a real reaper — one that SIGKILLs whatever live
// process holds that PID when the test worker exits. Tests inject fakes.
function underTest(): boolean {
  return process.env.VITEST !== undefined;
}

function loadNativeAddon(): NativeAddon | null {
  if (process.platform !== "win32" || underTest()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("win-job-object") as NativeAddon;
    if (typeof mod.assignProcessToHelpJob !== "function") return null;
    return mod;
  } catch (err) {
    console.warn(
      `${ATTACH_LOG_TAG} Failed to load win-job-object addon — crash-safe reaping disabled:`,
      err
    );
    return null;
  }
}

function loadPosixReaper(): PosixReaperModule | null {
  if ((process.platform !== "darwin" && process.platform !== "linux") || underTest()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("posix-pty-reaper") as PosixReaperModule;
    if (typeof mod.getSupervisorPath !== "function") return null;
    return mod;
  } catch (err) {
    console.warn(
      `${ATTACH_LOG_TAG} Failed to load posix-pty-reaper — crash-safe reaping disabled:`,
      err
    );
    return null;
  }
}

function isValidPid(pid: number): boolean {
  return typeof pid === "number" && Number.isFinite(pid) && Number.isInteger(pid) && pid > 0;
}

interface TrackedTerminal {
  pid: number;
  generation: number | undefined;
}

export class TerminalCrashReapService {
  private readonly terminals = new Map<string, TrackedTerminal>();
  // Windows only: PIDs already handed to the Job Object, so a repeated
  // terminal-pid for a live process never re-assigns it.
  private readonly assignedPids = new Set<number>();
  private readonly native: NativeAddon | null;
  private readonly posixReaper: PosixReaperModule | null;
  private readonly spawnFn: SpawnFn;
  private warnedUnavailable = false;
  private warnedAttachFailed = false;

  // POSIX supervisor state. Lazily started on the first attach so a session
  // that never opens a terminal never spawns it.
  private supervisor: ChildProcess | null = null;
  private supervisorStartAttempted = false;
  private disposed = false;

  constructor(nativeOverride?: NativeAddon | null, posixOverride?: PosixDeps | null) {
    this.native = nativeOverride === undefined ? loadNativeAddon() : nativeOverride;
    if (posixOverride === undefined) {
      this.posixReaper = loadPosixReaper();
      this.spawnFn = spawn;
    } else if (posixOverride === null) {
      this.posixReaper = null;
      this.spawnFn = spawn;
    } else {
      this.posixReaper = posixOverride.reaper;
      this.spawnFn = posixOverride.spawn;
    }
  }

  /**
   * Register a terminal's PTY PID with the crash-safe reaper. A new PID for an
   * id already tracked (a same-id respawn) replaces the old one. `generation`
   * is the terminal's launch generation, so a stale exit from the predecessor
   * can't detach the successor. No-op on an invalid PID, an unsupported
   * platform, or a native-side failure; failures are logged once each so a
   * stuck CI/MDM environment doesn't flood logs.
   */
  attachTerminal(id: string, pid: number, generation?: number): void {
    if (!isValidPid(pid)) return;
    if (
      process.platform !== "win32" &&
      process.platform !== "darwin" &&
      process.platform !== "linux"
    ) {
      return;
    }

    const existing = this.terminals.get(id);
    const existingGeneration = existing?.generation;
    const comparable = existingGeneration !== undefined && generation !== undefined;
    // A predecessor's PID that arrives after its successor registered must not
    // displace it (or rewind its generation) — generations only grow per id.
    if (comparable && generation < existingGeneration) return;
    // Same incarnation reporting again. A newer incarnation that landed on the
    // same (recycled) PID still re-registers below so the reaper captures the
    // new process's identity.
    if (existing?.pid === pid && (!comparable || generation === existingGeneration)) {
      if (generation !== undefined) existing.generation = generation;
      return;
    }
    if (existing) this.releasePid(existing.pid);
    this.terminals.set(id, { pid, generation });

    if (process.platform === "win32") {
      this.attachWindows(pid);
    } else {
      this.attachPosix(pid);
    }
  }

  /**
   * Stop reaping a terminal whose PTY exited. Ignored when `generation` names
   * an incarnation other than the one tracked — an exit that crossed a same-id
   * respawn belongs to the predecessor, which the respawn already replaced.
   */
  detachTerminal(id: string, generation?: number): void {
    const existing = this.terminals.get(id);
    if (!existing) return;
    if (
      generation !== undefined &&
      existing.generation !== undefined &&
      generation !== existing.generation
    ) {
      return;
    }
    this.terminals.delete(id);
    this.releasePid(existing.pid);
  }

  private releasePid(pid: number): void {
    if (process.platform === "win32") {
      this.assignedPids.delete(pid);
      return;
    }
    if (this.disposed) return;
    const stdin = this.supervisor?.stdin;
    if (!stdin) return;
    try {
      stdin.write(`REMOVE ${pid}\n`);
    } catch (err) {
      if (!this.warnedAttachFailed) {
        this.warnedAttachFailed = true;
        console.warn(`${ATTACH_LOG_TAG} Failed to unregister pid ${pid} with supervisor:`, err);
      }
    }
  }

  private attachWindows(pid: number): void {
    if (this.assignedPids.has(pid)) return;
    // Insert eagerly so a transient native failure isn't retried on every
    // subsequent terminal-pid event for the same PID. AssignProcessToJobObject
    // on a process already in this same job is undefined behavior to repeat.
    this.assignedPids.add(pid);

    if (!this.native) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        console.warn(
          `${ATTACH_LOG_TAG} Native addon unavailable — terminal PTYs will not be reaped on hard crash`
        );
      }
      return;
    }

    let ok: boolean;
    try {
      ok = this.native.assignProcessToHelpJob(pid);
    } catch (err) {
      ok = false;
      console.warn(`${ATTACH_LOG_TAG} Native attach threw for pid ${pid}:`, err);
    }
    if (!ok && !this.warnedAttachFailed) {
      this.warnedAttachFailed = true;
      console.warn(
        `${ATTACH_LOG_TAG} Failed to attach pid ${pid} to the terminal Job Object — process may have exited or parent is in a non-nesting job`
      );
    }
  }

  private attachPosix(pid: number): void {
    if (this.disposed) return;

    this.ensureSupervisor();
    const stdin = this.supervisor?.stdin;
    if (!stdin) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        console.warn(
          `${ATTACH_LOG_TAG} Supervisor unavailable — terminal PTYs will not be reaped on hard crash`
        );
      }
      return;
    }

    try {
      stdin.write(`ADD ${pid}\n`);
    } catch (err) {
      if (!this.warnedAttachFailed) {
        this.warnedAttachFailed = true;
        console.warn(`${ATTACH_LOG_TAG} Failed to register pid ${pid} with supervisor:`, err);
      }
    }
  }

  private ensureSupervisor(): void {
    if (this.supervisorStartAttempted) return;
    this.supervisorStartAttempted = true;

    if (!this.posixReaper || !this.posixReaper.isAvailable()) return;
    const binPath = this.posixReaper.getSupervisorPath();
    if (!binPath) return;

    try {
      const child = this.spawnFn(binPath, [], {
        detached: true,
        // stdin is the death-pipe: main holds the write end, the supervisor
        // reads it. libuv sets CLOEXEC on the parent's end, so node-pty PTY
        // children never inherit it and can't hold the pipe open.
        stdio: ["pipe", "ignore", "ignore"],
      });
      // Detached + unref'd so it can't keep the event loop (or the supervisor's
      // own death channel) from letting main exit. The pipe EOF is the signal.
      child.unref();
      child.on("error", (err) => {
        if (!this.warnedUnavailable) {
          this.warnedUnavailable = true;
          console.warn(`${ATTACH_LOG_TAG} Supervisor process error:`, err);
        }
      });
      // Swallow EPIPE if the supervisor dies unexpectedly — must never crash
      // the main process (Electron 41 makes unhandled stream errors fatal).
      child.stdin?.on("error", (err) => {
        if (!this.warnedAttachFailed) {
          this.warnedAttachFailed = true;
          console.warn(`${ATTACH_LOG_TAG} Supervisor stdin error:`, err);
        }
      });
      this.supervisor = child;
    } catch (err) {
      console.warn(`${ATTACH_LOG_TAG} Failed to spawn supervisor:`, err);
    }
  }

  /**
   * Disarm and shut down the supervisor on a clean quit. Sending `DISARM`
   * before closing the pipe tells the supervisor the shutdown was deliberate so
   * it stands down instead of SIGKILLing the still-registered terminals
   * (cooperative teardown already handles those). Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const stdin = this.supervisor?.stdin;
    if (!stdin) return;
    try {
      stdin.write("DISARM\n");
      stdin.end();
    } catch {
      // Supervisor already gone — closing the pipe is enough to release it.
    }
  }

  /** Test-only: drop all tracking state so a fresh test starts clean. */
  resetForTest(): void {
    this.terminals.clear();
    this.assignedPids.clear();
    this.warnedUnavailable = false;
    this.warnedAttachFailed = false;
    this.supervisor = null;
    this.supervisorStartAttempted = false;
    this.disposed = false;
  }

  /** Test-only: the PID currently tracked for each terminal id. */
  getTrackedPidsForTest(): ReadonlyMap<string, number> {
    return new Map([...this.terminals].map(([id, t]) => [id, t.pid]));
  }
}

export const terminalCrashReapService = new TerminalCrashReapService();
