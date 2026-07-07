import { Worker } from "node:worker_threads";
import type {
  AuthorityRequest,
  AuthorityResponse,
  AuthorityTransport,
} from "../../../src/services/terminal/workerParse/parseTransport";

// Real worker_threads transport for the perf harness (PERF-034's enabled
// mode): background-terminal parse runs on actual sibling threads, so the
// measured isolation is thread isolation, not an in-thread simulation. Child
// worker threads do not inherit tsx's loader registration, so it is
// re-registered explicitly via execArgv (tsx resolves from node_modules).
export function createNodeParseWorkerTransport(): AuthorityTransport {
  const worker = new Worker(new URL("./nodeParseWorker.ts", import.meta.url), {
    execArgv: ["--import", "tsx"],
  });
  const listeners = new Set<(response: AuthorityResponse) => void>();
  let disposed = false;
  worker.on("message", (response: AuthorityResponse) => {
    listeners.forEach((listener) => listener(response));
  });
  worker.on("error", (error: Error) => {
    listeners.forEach((listener) =>
      listener({ type: "error", message: error.message || "node parse worker error" })
    );
  });
  // An exit without an error event (loader failure, OOM kill) must still
  // settle pending snapshot waits, or a session awaiting tickNow hangs the
  // perf run forever.
  worker.on("exit", (code: number) => {
    if (disposed) return;
    listeners.forEach((listener) =>
      listener({ type: "error", message: `node parse worker exited (code ${code})` })
    );
  });
  return {
    send(request: AuthorityRequest) {
      worker.postMessage(request);
    },
    onResponse(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      worker.postMessage({ type: "dispose" } satisfies AuthorityRequest);
      listeners.clear();
      void worker.terminate();
    },
  };
}
