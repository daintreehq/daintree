import path from "node:path";
import { fileURLToPath } from "node:url";
import { utilityProcess, type UtilityProcess } from "electron";
import { logError, logInfo, logWarn } from "../../utils/logger.js";
import { minimalSpawnEnv } from "../../utils/minimalSpawnEnv.js";
import { noteTerminationIntent } from "../processTerminationIntent.js";
import type { Reading, ReaderState } from "./canopyReader.js";
import type { ReaderWorkerInbound, ReaderWorkerOutbound } from "./canopyReaderWorkerProtocol.js";

const P = "[Canopy:reader]";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const READER_SERVICE_NAME = "daintree-canopy-reader";

/** How long a retired reader gets to finish its read and release the model before it is killed. */
export const READER_RETIRE_KILL_MS = 3_000;
/** Longest a model load may take before the reader is given up on. */
const LOAD_TIMEOUT_MS = 60_000;
/** Longest one read may take: far past any screen on a slow CPU. */
const READ_TIMEOUT_MS = 30_000;

/**
 * The compiled worker on disk. esbuild may emit this module into a shared
 * chunk under `dist-electron/electron/chunks/`, so step up from there to the
 * electron root first, as `resolveVadWorkerPath()` does.
 */
function resolveReaderWorkerPath(): string {
  const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;
  return path.join(electronDir, "services", "canopy", "canopyReaderWorker.js");
}

const retiring = new Set<CanopyReaderProcess>();

export class CanopyReaderError extends Error {
  constructor(
    message: string,
    /** The process went, or never loaded: a new one may do better. */
    readonly processLost = false
  ) {
    super(message);
    this.name = "CanopyReaderError";
  }
}

interface PendingRead {
  resolve: (value: { reading: Reading; ms: number }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One reader process with one model loaded. Reads queue inside it and run one
 * at a time. Retiring drains the read under way, releases the ONNX session and
 * exits, with SIGKILL as the backstop: only this child can die of it.
 */
export class CanopyReaderProcess {
  private readonly child: UtilityProcess;
  private readonly forkedAt = performance.now();
  private retiredAt: number | null = null;
  private exited = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private killDue = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRead>();
  private resolveExit!: () => void;
  readonly whenExited: Promise<void>;
  /** Settles once the model is loaded; rejects when it can't be. */
  readonly ready: Promise<void>;

  constructor(
    readonly modelDir: string,
    private readonly onExit: () => void
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
    // A load nobody awaited yet must not surface as unhandled.
    this.ready.catch(() => {});
    // A model that can't load leaves nothing worth keeping: the process goes,
    // and the next read starts a new one.
    const loadTimer = setTimeout(() => {
      readyReject(new CanopyReaderError("Model took too long to load", true));
      this.retire();
    }, LOAD_TIMEOUT_MS);
    loadTimer.unref?.();
    this.child = utilityProcess.fork(resolveReaderWorkerPath(), [], {
      serviceName: READER_SERVICE_NAME,
      env: minimalSpawnEnv(),
      stdio: "ignore",
    });
    this.child.on("spawn", () => {
      logInfo(`${P} Reader process spawned`, { pid: this.child.pid });
      if (this.killDue) this.killUndrained();
    });
    this.child.on("message", (message: ReaderWorkerOutbound) => {
      if (message.type === "ready") {
        clearTimeout(loadTimer);
        logInfo(`${P} Model loaded`, {
          msSinceFork: Math.round(performance.now() - this.forkedAt),
        });
        readyResolve();
      } else if (message.type === "error") {
        clearTimeout(loadTimer);
        logWarn(`${P} Reader reported an error`, { message: message.message });
        readyReject(new CanopyReaderError(message.message, true));
        this.retire();
      } else if (message.type === "reading" || message.type === "read-failed") {
        const read = this.pending.get(message.id);
        if (!read) return;
        this.pending.delete(message.id);
        clearTimeout(read.timer);
        if (message.type === "reading") read.resolve({ reading: message.reading, ms: message.ms });
        else read.reject(new CanopyReaderError(message.message));
      }
    });
    this.child.on("error", (type, location) => {
      logWarn(`${P} Reader process fatal error`, { pid: this.child.pid, type, location });
    });
    this.child.on("exit", (code) => {
      this.exited = true;
      clearTimeout(loadTimer);
      if (this.killTimer !== null) clearTimeout(this.killTimer);
      retiring.delete(this);
      readyReject(new CanopyReaderError("Reader process exited", true));
      this.failPending(new CanopyReaderError("Reader process exited", true));
      this.resolveExit();
      if (this.retiredAt === null) {
        logError(`${P} Reader process exited unexpectedly`, undefined, { code });
      } else {
        logInfo(`${P} Reader process exited`, { code });
      }
      this.onExit();
    });
    this.child.postMessage({ type: "load", dir: modelDir } satisfies ReaderWorkerInbound);
  }

  get live(): boolean {
    return this.retiredAt === null && !this.exited;
  }

  read(state: ReaderState, lines: string[]): Promise<{ reading: Reading; ms: number }> {
    if (!this.live) return Promise.reject(new CanopyReaderError("Reader stopped", true));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CanopyReaderError("Read timed out", true));
        // A read this late means the process is wedged: let a new one take over.
        this.retire();
      }, READ_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.postMessage({ type: "read", id, state, lines } satisfies ReaderWorkerInbound);
    });
  }

  /** Drains and exits; idempotent. Reads not yet answered fail. */
  retire(): void {
    if (this.retiredAt !== null) return;
    this.retiredAt = performance.now();
    if (this.exited) return;
    retiring.add(this);
    try {
      this.child.postMessage({ type: "destroy" } satisfies ReaderWorkerInbound);
    } catch {
      // Already gone; the exit event settles it.
    }
    this.killTimer = setTimeout(() => this.killUndrained(), READER_RETIRE_KILL_MS);
    this.killTimer.unref?.();
  }

  private failPending(error: Error): void {
    for (const read of this.pending.values()) {
      clearTimeout(read.timer);
      read.reject(error);
    }
    this.pending.clear();
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
    noteTerminationIntent({ serviceName: READER_SERVICE_NAME }, "stop");
    try {
      process.kill(pid, "SIGKILL");
      logWarn(`${P} Reader did not exit after destroy; sent SIGKILL`, { pid });
    } catch {
      // Gone already.
    }
  }
}

/** Waits, up to `timeoutMs`, for retiring readers to exit, on the quit path. */
export async function waitForRetiringReaders(timeoutMs: number): Promise<number> {
  const pending = [...retiring];
  if (pending.length === 0) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(pending.map((r) => r.whenExited)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return pending.filter((r) => retiring.has(r)).length;
}
