import http from "node:http";
import type { AddressInfo } from "node:net";
import { KEEP_AWAKE_PATH } from "../cloud/agent37/agent37KeepAwake.js";
import type { KeepAwakeListener } from "./KeepAwakeKeeper.js";

const NONCE = /^[0-9a-f]{32}$/;
const MAX_OUTSTANDING = 4;

/**
 * The port Agent 37's edge forwards a keep-awake request to (#17918), on
 * every interface since the edge reaches the instance over its network. It
 * answers 204, once, to a request carrying a nonce it was told to expect and
 * 404 to anything else, and reads no body: it tells a caller nothing about
 * this machine.
 */
export function openKeepAwakeListener(): Promise<KeepAwakeListener> {
  const expected = new Set<string>();
  const received = new Set<string>();
  const server = http.createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    const nonce = path.startsWith(KEEP_AWAKE_PATH) ? path.slice(KEEP_AWAKE_PATH.length) : "";
    // Each nonce is answered once: a replay finds nothing.
    const known = request.method === "GET" && NONCE.test(nonce) && expected.delete(nonce);
    if (known) received.add(nonce);
    response.writeHead(known ? 204 : 404, { "cache-control": "no-store", connection: "close" });
    response.end();
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, () => {
      server.off("error", onError);
      // A listener that fails later answers nothing, and the keeper's next request finds out.
      server.on("error", () => {});
      server.unref();
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        expect(nonce) {
          expected.add(nonce);
          // Only the newest few: a request that never came back can't grow it.
          for (const old of expected) {
            if (expected.size <= MAX_OUTSTANDING) break;
            expected.delete(old);
          }
        },
        take(nonce) {
          expected.delete(nonce);
          return received.delete(nonce);
        },
        close() {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}
