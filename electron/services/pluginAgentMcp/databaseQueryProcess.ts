import path from "node:path";
import { fileURLToPath } from "node:url";
import { utilityProcess } from "electron";
import { minimalSpawnEnv } from "../../utils/minimalSpawnEnv.js";
import type { DatabaseToolRequest, DatabaseToolResponse } from "./databaseTools.js";
import { noteTerminationIntent } from "../processTerminationIntent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Children alive at once, across every plugin and session. */
export const MAX_CONCURRENT_DATABASE_PROCESSES = 2;

/**
 * Calls that may wait for a slot at once. A waiting call gives up with its own
 * signal (the tool call's timeout), so this only bounds how many can pile up.
 */
export const MAX_QUEUED_DATABASE_CALLS = 8;

/** How long a child that already answered gets to exit before it is killed. */
const EXIT_GRACE_MS = 2_000;

/**
 * How long a launch may take to report `spawn`. A launch that fails before it
 * starts may never report `exit` either, and would otherwise hold its slot for
 * good; past this the slot is given back and a late spawn is killed.
 */
export const SPAWN_DEADLINE_MS = 10_000;

/**
 * Resolves the compiled worker on disk. esbuild may emit this module into a
 * shared chunk under `dist-electron/electron/chunks/`, so step up to the
 * electron root first. Mirrors `resolveVadWorkerPath()`.
 */
function resolveDatabaseWorkerPath(): string {
  const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;
  return path.join(electronDir, "services", "pluginAgentMcp", "databaseQueryWorker.js");
}

/** The slice of Electron's `UtilityProcess` this runner uses. */
export interface DatabaseChildProcess {
  readonly pid: number | undefined;
  postMessage(message: DatabaseToolRequest): void;
  on(event: "spawn", listener: () => void): unknown;
  on(event: "message", listener: (message: DatabaseToolResponse) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  on(event: "error", listener: (...args: unknown[]) => void): unknown;
}

export interface DatabaseProcessDeps {
  fork: () => DatabaseChildProcess;
  kill: (pid: number) => void;
}

const defaultDeps: DatabaseProcessDeps = {
  fork: () =>
    utilityProcess.fork(resolveDatabaseWorkerPath(), [], {
      serviceName: "daintree-plugin-database",
      env: minimalSpawnEnv(),
      // Not "inherit": main's fd 2 can be a dead pty on AppImage launches (#5588).
      stdio: "ignore",
    }) as unknown as DatabaseChildProcess,
  // Not `child.kill()`: Electron's UtilityProcess.kill() blocks main on macOS
  // until the child is gone (#11069). A raw SIGKILL does not.
  kill: (pid) => {
    noteTerminationIntent(
      { serviceName: "daintree-plugin-database" },
      "query finished or cancelled"
    );
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  },
};

let alive = 0;

interface QueuedCall {
  start: () => void;
}

const queued: QueuedCall[] = [];

/** Start the longest-waiting call if a slot is free. Same turn, so nothing jumps the queue. */
function admitNext(): void {
  if (alive >= MAX_CONCURRENT_DATABASE_PROCESSES) return;
  queued.shift()?.start();
}

function codedError(code: string | null, message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  if (code) error.code = code;
  return error;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Tool call was cancelled.");
}

/**
 * Run one database tool call in a fresh child and settle with its value. The
 * child is killed as soon as `signal` aborts, and its slot is held until it has
 * actually exited, so an aborted runaway query still counts against the limit.
 *
 * With every slot taken the call waits its turn, first come first served, for
 * as long as `signal` allows; only a full queue answers `DB_BUSY` straight away.
 */
export function runDatabaseToolInProcess(
  request: DatabaseToolRequest,
  signal: AbortSignal,
  deps: DatabaseProcessDeps = defaultDeps
): Promise<unknown> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  if (alive < MAX_CONCURRENT_DATABASE_PROCESSES && queued.length === 0) {
    return startInProcess(request, signal, deps);
  }
  if (queued.length >= MAX_QUEUED_DATABASE_CALLS) {
    return Promise.reject(
      codedError(
        "DB_BUSY",
        "DB_BUSY: too many database queries are already running or waiting. Wait for them to finish and retry."
      )
    );
  }
  return new Promise<unknown>((resolve, reject) => {
    const call: QueuedCall = {
      start: () => {
        signal.removeEventListener("abort", onAbort);
        startInProcess(request, signal, deps).then(resolve, reject);
      },
    };
    const onAbort = (): void => {
      const index = queued.indexOf(call);
      if (index !== -1) queued.splice(index, 1);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    queued.push(call);
  });
}

function startInProcess(
  request: DatabaseToolRequest,
  signal: AbortSignal,
  deps: DatabaseProcessDeps
): Promise<unknown> {
  // Either early exit leaves the slot this call was handed unused; pass it on.
  if (signal.aborted) {
    admitNext();
    return Promise.reject(abortReason(signal));
  }
  let child: DatabaseChildProcess;
  try {
    child = deps.fork();
  } catch (error) {
    admitNext();
    return Promise.reject(error);
  }
  alive += 1;

  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let exited = false;
    let released = false;
    let killDue = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const release = (): void => {
      if (released) return;
      released = true;
      alive -= 1;
      admitNext();
    };

    const kill = (): void => {
      if (exited) return;
      const pid = child.pid;
      if (pid === undefined) {
        killDue = true;
        return;
      }
      deps.kill(pid);
    };
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      outcome();
    };
    const onAbort = (): void => {
      settle(() => reject(abortReason(signal)));
      kill();
    };

    const spawnTimer = setTimeout(() => {
      settle(() =>
        reject(codedError("DB_PROCESS_START_FAILED", "The database query process did not start."))
      );
      kill();
      release();
    }, SPAWN_DEADLINE_MS);
    spawnTimer.unref?.();

    child.on("spawn", () => {
      clearTimeout(spawnTimer);
      if (killDue) kill();
    });
    child.on("message", (message) => {
      settle(() => {
        if (message.ok) resolve(message.value);
        else reject(codedError(message.error.code, message.error.message));
      });
      if (!exited) {
        graceTimer = setTimeout(kill, EXIT_GRACE_MS);
        graceTimer.unref?.();
      }
    });
    // UtilityProcess is an EventEmitter; an unheard "error" would throw in main.
    // The exit that follows settles the call.
    child.on("error", () => {});
    child.on("exit", (code) => {
      if (exited) return;
      exited = true;
      release();
      clearTimeout(spawnTimer);
      if (graceTimer) clearTimeout(graceTimer);
      settle(() =>
        reject(codedError("DB_PROCESS_EXITED", `The database query process exited (code ${code}).`))
      );
    });
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      child.postMessage(request);
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      kill();
    }
  });
}
