import path from "node:path";
import { fileURLToPath } from "node:url";
import { utilityProcess, type UtilityProcess } from "electron";
import { logError, logInfo, logWarn } from "../../utils/logger.js";
import { minimalSpawnEnv } from "../../utils/minimalSpawnEnv.js";
import { noteTerminationIntent } from "../processTerminationIntent.js";
import type {
  LocalSpeechWorkerInbound,
  LocalSpeechWorkerOutbound,
} from "./localSpeechWorkerProtocol.js";

const P = "[VoiceTranscription:local]";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SPEECH_SERVICE_NAME = "daintree-voice-local";
/** Loading reads ~790 MB; a cold disk can take a while, a hung load never ends. */
const LOAD_TIMEOUT_MS = 60_000;
/** How long a retired process gets to release the model before it is killed. */
const RETIRE_KILL_MS = 5_000;
/**
 * How long the model stays loaded after a dictation ends. Loading takes
 * seconds from a cold disk and the loaded model holds about a gigabyte, so
 * the next prompt reuses it and an idle app gives the memory back.
 */
export const LOCAL_SPEECH_IDLE_MS = 60_000;
/**
 * Two threads, like Canopy's reader: measured at about 70 ms per 560 ms chunk
 * on Apple silicon, an eighth of real time, without competing with the
 * user's agents for cores.
 */
const INFERENCE_THREADS = 2;

type SessionMessage = Extract<LocalSpeechWorkerOutbound, { session: number }>;

/** The compiled worker on disk, found as `resolveVadWorkerPath()` finds the VAD's. */
function resolveWorkerPath(): string {
  const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;
  return path.join(electronDir, "services", "voice", "localSpeechWorker.js");
}

class SpeechProcess {
  private readonly child: UtilityProcess;
  private readonly forkedAt = performance.now();
  private retiredAt: number | null = null;
  private exited = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private killDue = false;
  private resolveExit!: () => void;
  readonly whenExited: Promise<void>;
  readonly ready: Promise<void>;

  constructor(
    readonly modelDir: string,
    private readonly onSessionMessage: (message: SessionMessage) => void,
    private readonly onExit: (process: SpeechProcess, expected: boolean) => void
  ) {
    this.whenExited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    this.ready.catch(() => {});
    const loadTimer = setTimeout(() => {
      readyReject(new Error("The on-device model took too long to load."));
      this.retire();
    }, LOAD_TIMEOUT_MS);
    loadTimer.unref?.();
    this.child = utilityProcess.fork(resolveWorkerPath(), [], {
      serviceName: SPEECH_SERVICE_NAME,
      env: minimalSpawnEnv(),
      stdio: "ignore",
    });
    this.child.on("spawn", () => {
      logInfo(`${P} Speech process spawned`, { pid: this.child.pid });
      if (this.killDue) this.killUndrained();
    });
    this.child.on("message", (message: LocalSpeechWorkerOutbound) => {
      switch (message.type) {
        case "ready":
          clearTimeout(loadTimer);
          logInfo(`${P} Model loaded`, {
            loadMs: message.loadMs,
            msSinceFork: Math.round(performance.now() - this.forkedAt),
          });
          readyResolve();
          return;
        case "load-failed":
        case "error":
          clearTimeout(loadTimer);
          logWarn(`${P} Speech process reported an error`, { type: message.type });
          readyReject(new Error("The on-device model couldn't be loaded."));
          this.retire();
          return;
        case "drained":
          return;
        default:
          if (this.retiredAt === null) this.onSessionMessage(message);
      }
    });
    this.child.on("error", (type, location) => {
      logWarn(`${P} Speech process fatal error`, { pid: this.child.pid, type, location });
    });
    this.child.on("exit", (code) => {
      this.exited = true;
      clearTimeout(loadTimer);
      if (this.killTimer !== null) clearTimeout(this.killTimer);
      readyReject(new Error("The on-device model stopped."));
      this.resolveExit();
      const expected = this.retiredAt !== null;
      if (expected) logInfo(`${P} Speech process exited`, { code });
      else logError(`${P} Speech process exited unexpectedly`, undefined, { code });
      this.onExit(this, expected);
    });
    this.child.postMessage({
      type: "load",
      dir: modelDir,
      threads: INFERENCE_THREADS,
    } satisfies LocalSpeechWorkerInbound);
  }

  get live(): boolean {
    return this.retiredAt === null && !this.exited;
  }

  post(message: LocalSpeechWorkerInbound): boolean {
    if (!this.live) return false;
    try {
      this.child.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  retire(): void {
    if (this.retiredAt !== null) return;
    this.retiredAt = performance.now();
    if (this.exited) return;
    try {
      this.child.postMessage({ type: "destroy" } satisfies LocalSpeechWorkerInbound);
    } catch {
      // Already gone; the exit event settles it.
    }
    this.killTimer = setTimeout(() => this.killUndrained(), RETIRE_KILL_MS);
    this.killTimer.unref?.();
  }

  private killUndrained(): void {
    this.killTimer = null;
    if (this.exited) return;
    const pid = this.child.pid;
    if (pid === undefined) {
      this.killDue = true;
      return;
    }
    this.killDue = false;
    // Not `child.kill()`: it blocks main on macOS until the child is gone (#11069).
    noteTerminationIntent({ serviceName: SPEECH_SERVICE_NAME }, "stop");
    try {
      process.kill(pid, "SIGKILL");
      logWarn(`${P} Speech process did not exit after destroy; sent SIGKILL`, { pid });
    } catch {
      // Gone already.
    }
  }
}

export interface LocalSpeechLeaseHandlers {
  /** A message for this lease's session. */
  onMessage: (message: SessionMessage) => void;
  /** The process went while the lease held it. Nothing more will arrive. */
  onLost: () => void;
}

/** One dictation's hold on the speech process. */
export interface LocalSpeechLease {
  readonly session: number;
  /** False once the lease no longer holds a live process. */
  post(message: LocalSpeechWorkerInbound): boolean;
  /** Ends the hold; the model stays loaded for the next dictation until it idles out. */
  release(): void;
}

/**
 * The one speech process, shared by successive dictations. A lease holds it
 * for one session; a newer lease takes it from an older one, whose messages
 * stop at once. With no lease the process idles out after
 * {@link LOCAL_SPEECH_IDLE_MS}. Logs carry ids, codes and timings only.
 */
export class LocalSpeechHost {
  private process: SpeechProcess | null = null;
  private retiring = new Set<SpeechProcess>();
  private lease: { session: number; handlers: LocalSpeechLeaseHandlers } | null = null;
  private nextSession = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly idleMs = LOCAL_SPEECH_IDLE_MS) {}

  /** Whether a dictation holds the process now. */
  get leased(): boolean {
    return this.lease !== null;
  }

  /**
   * Loads the model from `modelDir` (or reuses the loaded one) and leases the
   * process to a new session. Rejects when the model can't be loaded.
   */
  async acquire(modelDir: string, handlers: LocalSpeechLeaseHandlers): Promise<LocalSpeechLease> {
    this.clearIdle();
    const session = this.nextSession++;
    this.lease = { session, handlers };
    let current = this.process;
    if (current && (!current.live || current.modelDir !== modelDir)) {
      this.retire(current);
      current = null;
    }
    if (!current) {
      // A process still releasing the same files would double the memory held.
      await this.waitForRetiring(RETIRE_KILL_MS + 1_000);
      current = new SpeechProcess(
        modelDir,
        (message) => this.route(message),
        (process, expected) => this.handleExit(process, expected)
      );
      this.process = current;
    }
    try {
      await current.ready;
    } catch (error) {
      if (this.lease?.session === session) this.lease = null;
      if (this.process === current) this.retire(current);
      this.armIdleIfFree();
      throw error;
    }
    if (this.lease?.session !== session) throw new Error("Superseded by a newer dictation");
    const owner = current;
    return {
      session,
      post: (message) =>
        this.lease?.session === session && this.process === owner && owner.post(message),
      release: () => {
        if (this.lease?.session !== session) return;
        this.lease = null;
        owner.post({ type: "end", session });
        this.armIdleIfFree();
      },
    };
  }

  /**
   * Stops the process so its files can be deleted. Refused while a dictation
   * holds it; resolves once every process has exited.
   */
  async releaseModel(): Promise<void> {
    if (this.lease) throw new Error("Dictation is using the on-device model");
    this.clearIdle();
    if (this.process) this.retire(this.process);
    await this.waitForRetiring(RETIRE_KILL_MS + 1_000);
  }

  /** On quit: stop every process and wait up to `timeoutMs` for them to exit. */
  async shutdown(timeoutMs: number): Promise<void> {
    this.clearIdle();
    this.lease = null;
    if (this.process) this.retire(this.process);
    await this.waitForRetiring(timeoutMs);
  }

  private route(message: SessionMessage): void {
    const lease = this.lease;
    if (!lease || message.session !== lease.session) return;
    lease.handlers.onMessage(message);
  }

  private handleExit(process: SpeechProcess, expected: boolean): void {
    this.retiring.delete(process);
    if (this.process !== process) return;
    this.process = null;
    const lease = this.lease;
    if (!expected && lease) {
      this.lease = null;
      lease.handlers.onLost();
    }
  }

  private retire(process: SpeechProcess): void {
    if (this.process === process) this.process = null;
    this.retiring.add(process);
    process.retire();
    void process.whenExited.then(() => this.retiring.delete(process));
  }

  private armIdleIfFree(): void {
    if (this.lease || !this.process || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.lease && this.process) {
        logInfo(`${P} Unloading the idle model`);
        this.retire(this.process);
      }
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async waitForRetiring(timeoutMs: number): Promise<void> {
    const pending = [...this.retiring];
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pending.map((p) => p.whenExited)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }
}
