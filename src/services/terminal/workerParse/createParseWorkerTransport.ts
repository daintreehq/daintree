import type { AuthorityRequest, AuthorityResponse, AuthorityTransport } from "./parseTransport";

// Real Web Worker transport for the renderer. Split from parseTransport so
// test/node consumers of the protocol never touch `new Worker`.
export function createParseWorkerTransport(): AuthorityTransport {
  const worker = new Worker(new URL("./parseWorker.ts", import.meta.url), {
    type: "module",
  });
  const listeners = new Set<(response: AuthorityResponse) => void>();
  worker.onmessage = (event: MessageEvent<AuthorityResponse>) => {
    listeners.forEach((listener) => listener(event.data));
  };
  return {
    send(request: AuthorityRequest) {
      worker.postMessage(request);
    },
    onResponse(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      worker.postMessage({ type: "dispose" } satisfies AuthorityRequest);
      listeners.clear();
      worker.terminate();
    },
  };
}
