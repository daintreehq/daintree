import { Worker } from "node:worker_threads";

// inotify_init1(2) failures that mean no instance can be had right now:
// EMFILE is the user's fs.inotify.max_user_instances, ENFILE the system-wide
// file table, ENOMEM the kernel.
const NO_INSTANCE_CODES = new Set(["EMFILE", "ENFILE", "ENOMEM"]);

export type InotifyInstanceFailure = "EMFILE" | "ENFILE" | "ENOMEM";

const PROBE_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
try {
  fs.watch(workerData).close();
  parentPort.postMessage(null);
} catch (error) {
  parentPort.postMessage(error && error.code ? String(error.code) : null);
}
`;

/**
 * Why this user can't open an inotify instance right now, or null when one
 * can be opened, tried in a worker.
 *
 * A worker's event loop opens its own inotify instance for its first
 * `fs.watch`, so the attempt answers for the user's limit without touching
 * this thread. The answer comes only once the worker has exited: its loop
 * holds that instance until then, and a caller opening one straight after a
 * null must not find the probe still holding the last slot. Anything other
 * than a definite "no instance" (the directory vanished, the worker couldn't
 * start) answers null and leaves the outcome to the caller's own attempt.
 */
export function probeInotifyInstance(dir: string): Promise<InotifyInstanceFailure | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(PROBE_SOURCE, { eval: true, workerData: dir });
    } catch {
      resolve(null);
      return;
    }
    let failure: InotifyInstanceFailure | null = null;
    worker.once("message", (code: string | null) => {
      if (code && NO_INSTANCE_CODES.has(code)) failure = code as InotifyInstanceFailure;
      void worker.terminate();
    });
    // A worker that fails emits "error" and then exits; unheard, the error
    // would be thrown in this process.
    worker.once("error", () => {});
    worker.once("exit", () => resolve(failure));
  });
}
