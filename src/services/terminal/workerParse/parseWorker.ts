import { AuthorityEndpoint, IngestPortConsumer } from "./parseTransport";
import type { AuthorityRequest, AuthorityResponse } from "./parseTransport";

// Web Worker entry for the parse authority. Vite bundles this via
// `new Worker(new URL("./parseWorker.ts", import.meta.url), { type: "module" })`
// (see createParseWorkerTransport). Pure JS — @xterm/headless needs no DOM.

// The renderer tsconfig compiles against the DOM lib, where `self` is a
// Window; this module only ever runs inside a dedicated worker.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- DedicatedWorkerGlobalScope is unavailable under the DOM lib
const workerScope = self as unknown as {
  postMessage(message: AuthorityResponse): void;
  onmessage: ((event: MessageEvent<AuthorityRequest>) => void) | null;
};

const endpoint = new AuthorityEndpoint((response) => workerScope.postMessage(response));

// Requests are handled strictly in arrival order: snapshot requests must
// observe every write sent before them, and endpoint.handle is async (a
// snapshot awaits the parse drain), so a local FIFO chain serializes them.
// Dedicated-port chunks join the SAME chain (IngestPortConsumer.enqueue) —
// one queue, one parse order.
let queue: Promise<void> = Promise.resolve();
function enqueue(task: () => void | Promise<void>): void {
  queue = queue.then(task);
}

// Live ingest (issue #10960): the pty-host's dedicated per-terminal port is
// transferred in alongside an `attach-port` control message. Bytes then flow
// pty-host → worker directly; acks post back over the same port from the
// authority's write-completion callback.
let ingestPort: MessagePort | null = null;
let consumer: IngestPortConsumer | null = null;

function attachIngestPort(port: MessagePort): void {
  ingestPort?.close();
  const attached = new IngestPortConsumer({
    write: (data, onParsed) => endpoint.ingestWrite(data, onParsed),
    postAck: (ack) => port.postMessage(ack),
    postResponse: (response) => workerScope.postMessage(response),
    enqueue,
  });
  ingestPort = port;
  consumer = attached;
  port.onmessage = (event: MessageEvent) => attached.handlePortMessage(event.data);
  // Chromium fires `close` when the far end is torn down (host disconnect,
  // project switch) — surface it so the controller falls back cleanly.
  port.addEventListener("close", () => {
    if (ingestPort !== port) return;
    workerScope.postMessage({ type: "ingest-port-closed" });
  });
}

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request?.type === "attach-port") {
    const port = event.ports?.[0];
    if (port) attachIngestPort(port);
    return;
  }
  if (request?.type === "activate-port-ingest") {
    // Barrier: runs in the FIFO behind every relayed pre-engage write.
    enqueue(() => consumer?.activate());
    return;
  }
  enqueue(() => endpoint.handle(request));
};
