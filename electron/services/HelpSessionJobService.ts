/**
 * HelpSessionJobService - crash-safe reaping for help-session PTY trees
 * (#7526 Windows, #8769 macOS / Linux).
 *
 * Windows: holds a single global Job Object
 * (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) for Daintree's lifetime via the
 * `win-job-object` native addon. Help-session PTY PIDs are added on
 * `terminal-pid` events filtered through {@link HelpSessionService.isHelpTerminal}.
 * When the main Electron process dies for any reason the OS kernel closes the
 * Job HANDLE and reaps every assigned process and its descendants.
 *
 * macOS / Linux: spawns a single detached supervisor process (the compiled
 * `posix-pty-reaper` binary) and holds the write end of its stdin pipe for the
 * app's lifetime. Help-session PTY PIDs are streamed to it as `ADD <pid>`
 * lines. When the main process dies hard, the kernel closes the pipe, the
 * supervisor sees EOF and SIGKILLs the full descendant tree of every registered
 * PID. On a clean quit {@link HelpSessionJobService.dispose} sends `DISARM`
 * first so the supervisor stands down — the cooperative teardown paths
 * (`displacePriorSessions`, graceful kill) already handle those sessions.
 *
 * This is the one cleanup tier that survives a hard crash; cooperative paths
 * (`taskkill /T`, `displacePriorSessions`, renderer teardown) only run when the
 * main process is still executing. On unsupported platforms / when the native
 * binary is missing, every path degrades to a no-op with a single warning.
 */

import { spawn, type ChildProcess } from "node:child_process";

const ATTACH_LOG_TAG = "[HelpSessionJobService]";

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

function loadNativeAddon(): NativeAddon | null {
  if (process.platform !== "win32") return null;
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
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
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

export class HelpSessionJobService {
  private readonly attachedPids = new Set<number>();
  private readonly native: NativeAddon | null;
  private readonly posixReaper: PosixReaperModule | null;
  private readonly spawnFn: SpawnFn;
  private warnedUnavailable = false;
  private warnedAttachFailed = false;

  // POSIX supervisor state. Lazily started on the first attach so apps that
  // never open a help session never spawn it.
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
   * Attach a help-session PTY PID to the crash-safe reaping mechanism. No-op on
   * a duplicate PID, an invalid PID, an unsupported platform, or a native-side
   * failure. Failures are logged once each — subsequent failures are silent so a
   * stuck CI/MDM environment doesn't flood logs.
   */
  attachHelpSessionPid(pid: number): void {
    if (process.platform === "win32") {
      this.attachWindows(pid);
      return;
    }
    if (process.platform === "darwin" || process.platform === "linux") {
      this.attachPosix(pid);
      return;
    }
  }

  private attachWindows(pid: number): void {
    if (!isValidPid(pid)) return;

    if (this.attachedPids.has(pid)) return;
    // Insert eagerly so a transient native failure doesn't cause us to retry
    // every subsequent terminal-pid event for the same PID. Windows will at
    // most accept the PID once anyway — AssignProcessToJobObject on a
    // process already in this same job is undefined behavior to repeat.
    this.attachedPids.add(pid);

    if (!this.native) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        console.warn(
          `${ATTACH_LOG_TAG} Native addon unavailable — help-session PTYs will not be reaped on hard crash`
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
        `${ATTACH_LOG_TAG} Failed to attach pid ${pid} to help-session Job Object — process may have exited or parent is in a non-nesting job`
      );
    }
  }

  private attachPosix(pid: number): void {
    if (this.disposed || !isValidPid(pid)) return;

    if (this.attachedPids.has(pid)) return;
    // Insert eagerly so a transient write failure doesn't retry on every
    // subsequent terminal-pid event for the same PID.
    this.attachedPids.add(pid);

    this.ensureSupervisor();
    const stdin = this.supervisor?.stdin;
    if (!stdin) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        console.warn(
          `${ATTACH_LOG_TAG} Supervisor unavailable — help-session PTYs will not be reaped on hard crash`
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
      child.stdin?.unref?.();
      this.supervisor = child;
    } catch (err) {
      console.warn(`${ATTACH_LOG_TAG} Failed to spawn supervisor:`, err);
    }
  }

  /**
   * Disarm and shut down the supervisor on a clean quit. Sending `DISARM`
   * before closing the pipe tells the supervisor the shutdown was deliberate so
   * it stands down instead of SIGKILLing the still-registered help sessions
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

  /** Test-only: drop the attached-PID memo so a fresh test starts clean. */
  resetForTest(): void {
    this.attachedPids.clear();
    this.warnedUnavailable = false;
    this.warnedAttachFailed = false;
    this.supervisor = null;
    this.supervisorStartAttempted = false;
    this.disposed = false;
  }

  /** Test-only: inspect the attached-PID set. */
  getAttachedPidsForTest(): ReadonlySet<number> {
    return this.attachedPids;
  }
}

export const helpSessionJobService = new HelpSessionJobService();
