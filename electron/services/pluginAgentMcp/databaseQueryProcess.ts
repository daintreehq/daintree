import path from "node:path";
import { fileURLToPath } from "node:url";
import { utilityProcess } from "electron";
import { minimalSpawnEnv } from "../../utils/minimalSpawnEnv.js";
import type { DatabaseToolRequest, DatabaseToolResponse } from "./databaseTools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Children alive at once, across every plugin and session. */
export const MAX_CONCURRENT_DATABASE_PROCESSES = 2;

/** How long a child that already answered gets to exit before it is killed. */
const EXIT_GRACE_MS = 2_000;

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
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  },
};

let alive = 0;

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
 */
export function runDatabaseToolInProcess(
  request: DatabaseToolRequest,
  signal: AbortSignal,
  deps: DatabaseProcessDeps = defaultDeps
): Promise<unknown> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  if (alive >= MAX_CONCURRENT_DATABASE_PROCESSES) {
    return Promise.reject(
      codedError(
        "DB_BUSY",
        "DB_BUSY: other database queries are still running. Wait for them to finish and retry."
      )
    );
  }
  let child: DatabaseChildProcess;
  try {
    child = deps.fork();
  } catch (error) {
    return Promise.reject(error);
  }
  alive += 1;

  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let exited = false;
    let killDue = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

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

    child.on("spawn", () => {
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
      alive -= 1;
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
