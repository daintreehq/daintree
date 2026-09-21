import path from "node:path";
import { fileURLToPath } from "node:url";
import { utilityProcess, type UtilityProcess } from "electron";
import { logError, logInfo, logWarn } from "../../utils/logger.js";
import { minimalSpawnEnv } from "../../utils/minimalSpawnEnv.js";
import type { VadWorkerInbound, VadWorkerOutbound } from "./openaiVadWorkerProtocol.js";

const P = "[VoiceTranscription:openai]";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VAD_SERVICE_NAME = "daintree-voice-vad";

/**
 * How long a retired VAD process gets to drain before it is killed. Model load
 * is the slowest thing it can be waiting on; this is several times that.
 */
export const VAD_RETIRE_KILL_MS = 3_000;

export type VadRetireReason = "stop" | "session-end" | "connection-closed" | "respawn" | "degraded";

/**
 * Resolves the compiled VAD entry on disk. esbuild emits this module into a
 * shared chunk under `dist-electron/electron/chunks/`, so `__dirname` may point
 * at that chunks dir — step up to the electron root, then to the entry's own
 * output path. Mirrors the host-process path resolution in
 * `WorkspaceHostProcess.ts`.
 */
function resolveVadWorkerPath(): string {
  const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;
  return path.join(electronDir, "services", "voice", "openaiVadWorker.js");
}

const retiring = new Set<OpenAIVadProcess>();

export interface OpenAIVadProcessHandlers {
  /** Messages from the process while it is live. Nothing is forwarded after `retire()`. */
  onMessage: (message: VadWorkerOutbound) => void;
  /** The process exited without being retired — a crash or native abort. */
  onUnexpectedExit: (code: number) => void;
}

/**
 * One Silero VAD `utilityProcess` for one voice session. ONNX Runtime can abort
 * in native code (#12577), so it runs out of process: an abort ends this child,
 * never main.
 *
 * Retiring posts `destroy` so the child drains its in-flight model load and
 * inference and releases the ONNX session itself, then exits. A child that
 * has not exited after {@link VAD_RETIRE_KILL_MS} is sent SIGKILL — safe here
 * because only that process dies.
 *
 * Every lifecycle transition is logged at info so the next crash report can be
 * lined up against it. Entries carry ids, codes and timings only, never audio
 * or transcript content.
 */
export class OpenAIVadProcess {
  private readonly child: UtilityProcess;
  private readonly forkedAt = performance.now();
  private retiredAt: number | null = null;
  private drained = false;
  private exited = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  /** The drain window closed before the child had a pid to signal. */
  private killDue = false;
  private resolveExit!: () => void;
  /** Settles when the child exits, however it goes. */
  readonly whenExited: Promise<void>;

  /** Throws when the process cannot be forked. */
  constructor(
    private readonly sessionId: number,
    private readonly handlers: OpenAIVadProcessHandlers
  ) {
    this.whenExited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.child = utilityProcess.fork(resolveVadWorkerPath(), [], {
      serviceName: VAD_SERVICE_NAME,
      // The VAD needs no secrets; keep main's environment out of the child.
      env: minimalSpawnEnv(),
      // Not "inherit": main's fd 2 can be a dead pty on AppImage launches,
      // where a write fails with EIO (#5588). Nothing the child prints is needed;
      // lifecycle travels over the message protocol.
      stdio: "ignore",
    });

    this.child.on("spawn", () => {
      logInfo(`${P} VAD process spawned`, { sessionId, pid: this.child.pid });
      if (this.killDue) this.killUndrained();
    });
    this.child.on("message", (message: VadWorkerOutbound) => this.handleMessage(message));
    this.child.on("exit", (code) => this.handleExit(code));
  }

  post(message: VadWorkerInbound): boolean {
    if (this.retiredAt !== null || this.exited) return false;
    this.child.postMessage(message);
    return true;
  }

  /** Asks the process to drain and exit, and arms the kill backstop. Idempotent. */
  retire(reason: VadRetireReason): void {
    if (this.retiredAt !== null) return;
    this.retiredAt = performance.now();
    // A process that already died (the degraded path after a crash) has
    // nothing left to drain.
    if (this.exited) return;
    logInfo(`${P} VAD destroy requested`, {
      sessionId: this.sessionId,
      pid: this.child.pid,
      reason,
    });
    retiring.add(this);
    try {
      this.child.postMessage({ type: "destroy" } satisfies VadWorkerInbound);
    } catch {
      // The child is already gone; its exit event settles the retirement.
    }
    this.killTimer = setTimeout(() => this.killUndrained(), VAD_RETIRE_KILL_MS);
    // Never hold the app open for a retiring VAD.
    this.killTimer.unref?.();
  }

  private handleMessage(message: VadWorkerOutbound): void {
    if (message.type === "drained") {
      this.drained = true;
      logInfo(`${P} VAD drained`, {
        sessionId: this.sessionId,
        pid: this.child.pid,
        msSinceDestroy: this.msSince(this.retiredAt),
      });
      return;
    }
    if (this.retiredAt !== null) {
      if (message.type === "error") {
        logWarn(`${P} Retired VAD process reported an error`, {
          sessionId: this.sessionId,
          pid: this.child.pid,
          message: message.message,
        });
      }
      return;
    }
    if (message.type === "ready") {
      logInfo(`${P} VAD session ready`, {
        sessionId: this.sessionId,
        pid: this.child.pid,
        msSinceFork: this.msSince(this.forkedAt),
      });
    }
    this.handlers.onMessage(message);
  }

  private handleExit(code: number): void {
    this.exited = true;
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    retiring.delete(this);
    this.resolveExit();

    const context = {
      sessionId: this.sessionId,
      code,
      drained: this.drained,
      msSinceFork: this.msSince(this.forkedAt),
      msSinceDestroy: this.msSince(this.retiredAt),
    };
    if (this.retiredAt === null) {
      logError(`${P} VAD process exited unexpectedly`, undefined, context);
      this.handlers.onUnexpectedExit(code);
      return;
    }
    // The child exits 0 only after a successful drain, so a zero code stands
    // even if the `drained` message itself was lost to the exit.
    if (code === 0) {
      logInfo(`${P} VAD process exited`, context);
    } else {
      logWarn(`${P} VAD process exited without a clean drain`, context);
    }
  }

  private killUndrained(): void {
    this.killTimer = null;
    if (this.exited) return;
    const pid = this.child.pid;
    if (pid === undefined) {
      // Not spawned yet; the spawn handler finishes the job.
      this.killDue = true;
      return;
    }
    this.killDue = false;
    // Not `child.kill()`: Electron's UtilityProcess.kill() blocks main on
    // macOS until the child is gone (#11069). A raw SIGKILL does not.
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code !== "ESRCH") {
        logWarn(`${P} Failed to kill undrained VAD process`, { sessionId: this.sessionId, pid });
      }
      return;
    }
    logWarn(`${P} VAD process did not exit ${VAD_RETIRE_KILL_MS}ms after destroy; sent SIGKILL`, {
      sessionId: this.sessionId,
      pid,
      drained: this.drained,
    });
  }

  private msSince(start: number | null): number | undefined {
    return start === null ? undefined : Math.round(performance.now() - start);
  }
}

/**
 * Waits, up to `timeoutMs`, for every retired VAD process to exit. Called on
 * the quit path so app exit does not cut a drain short. Resolves with the
 * number still running when it gave up.
 */
export async function waitForRetiringVadProcesses(timeoutMs: number): Promise<number> {
  const pending = [...retiring];
  if (pending.length === 0) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(pending.map((vad) => vad.whenExited)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return pending.filter((vad) => retiring.has(vad)).length;
}
