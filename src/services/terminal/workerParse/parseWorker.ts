import { AuthorityEndpoint } from "./parseTransport";
import type { AuthorityRequest, AuthorityResponse } from "./parseTransport";

// Web Worker entry for the parse authority. Vite bundles this via
// `new Worker(new URL("./parseWorker.ts", import.meta.url), { type: "module" })`
// (see createParseWorkerTransport). Pure JS — @xterm/headless needs no DOM.

const workerScope = self as unknown as {
  postMessage(message: AuthorityResponse): void;
  onmessage: ((event: MessageEvent<AuthorityRequest>) => void) | null;
};

const endpoint = new AuthorityEndpoint((response) => workerScope.postMessage(response));

// Requests are handled strictly in arrival order: snapshot requests must
// observe every write sent before them, and endpoint.handle is async (a
// snapshot awaits the parse drain), so a local FIFO chain serializes them.
let queue: Promise<void> = Promise.resolve();
workerScope.onmessage = (event) => {
  queue = queue.then(() => endpoint.handle(event.data));
};
