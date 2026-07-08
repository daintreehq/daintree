import { parentPort } from "node:worker_threads";
import { AuthorityEndpoint } from "../../../src/services/terminal/workerParse/parseTransport";
import type { AuthorityRequest } from "../../../src/services/terminal/workerParse/parseTransport";

// node:worker_threads entry for the parse authority — the perf-harness leg of
// the transport-agnostic design (parseAuthority.ts runs in a Web Worker, a
// node worker_thread, or in-thread behind one protocol). Spawned by
// createNodeParseWorkerTransport with tsx registered via execArgv so this
// TypeScript entry loads inside the child thread.

if (!parentPort) {
  throw new Error("nodeParseWorker must run inside a worker_thread");
}

const port = parentPort;
const endpoint = new AuthorityEndpoint((response) => port.postMessage(response));

// Same FIFO discipline as the renderer's parseWorker: snapshot requests must
// observe every write sent before them.
let queue: Promise<void> = Promise.resolve();
port.on("message", (request: AuthorityRequest) => {
  queue = queue.then(() => endpoint.handle(request));
});
