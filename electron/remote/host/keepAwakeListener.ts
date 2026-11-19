import http from "node:http";
import type { AddressInfo } from "node:net";
import { KEEP_AWAKE_PATH } from "../cloud/agent37/agent37KeepAwake.js";
import type { KeepAwakeListener } from "./KeepAwakeKeeper.js";

const NONCE = /^[0-9a-f]{32}$/;

/**
 * The port Agent 37's edge forwards a keep-awake request to (#17918), on
 * every interface since the edge reaches the instance over its network. It
 * answers 204 to a request carrying the one nonce it was told to expect and
 * 404 to anything else, and reads no body: it tells a caller nothing about
 * this machine.
 */
export function openKeepAwakeListener(): Promise<KeepAwakeListener> {
  let expected: string | null = null;
  let received: string | null = null;
  const server = http.createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    const nonce = path.startsWith(KEEP_AWAKE_PATH) ? path.slice(KEEP_AWAKE_PATH.length) : "";
    const known = request.method === "GET" && NONCE.test(nonce) && nonce === expected;
    if (known) {
      expected = null;
      received = nonce;
    }
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
          expected = nonce;
          received = null;
        },
        take(nonce) {
          const arrived = received === nonce;
          if (arrived || expected === nonce) {
            received = null;
            expected = null;
          }
          return arrived;
        },
        close() {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}
