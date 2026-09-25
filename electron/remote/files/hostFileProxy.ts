import type { HostFileRequestProxy } from "../../setup/protocols.js";
import { buildDaintreeFileErrorHeaders } from "../../setup/protocols.js";
import { AppError } from "../../utils/errorTypes.js";
import type { ClientFileTransport } from "./ClientFileTransport.js";
import { PULL_MAX_BYTES } from "./linkMethods.js";

/**
 * The response headers a host's contained-file handler sets that are worth
 * relaying. Anything else it might send stays on the host; CORS is decided
 * here, by this machine's protocol handler, for this machine's requester.
 */
const RELAYED_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "content-security-policy",
  "cross-origin-resource-policy",
  "cross-origin-embedder-policy",
  "x-content-type-options",
  "cache-control",
  "referrer-policy",
]);

function relayedHeaders(headers: Record<string, string>): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (RELAYED_HEADERS.has(name.toLowerCase())) out.set(name, value);
  }
  return out;
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: buildDaintreeFileErrorHeaders() });
}

/**
 * Answer a remote window's `daintree-file|media|pdf://host/<hostId>/…`
 * request from that host. The host runs its own handler and the body arrives
 * in verified slices, pulled only as fast as the consumer reads, so a large
 * video costs a slice of memory here, never the file.
 */
export function createHostFileProxy(transport: ClientFileTransport): HostFileRequestProxy {
  return async (scheme, hostId, request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return plain(405, "Method Not Allowed");
    }
    const url = new URL(request.url);
    const filePath = url.searchParams.get("path");
    const rootPath = url.searchParams.get("root");
    if (!filePath || !rootPath) return plain(400, "Missing path or root parameter");

    let answer;
    try {
      answer = await transport.request(hostId, {
        scheme,
        path: filePath,
        root: rootPath,
        method: request.method,
        range: request.headers.get("range"),
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : null;
      return code === "HOST_DISCONNECTED" || code === "HOST_VERSION_MISMATCH"
        ? plain(503, "Host not connected")
        : plain(502, "Bad Gateway");
    }

    const headers = relayedHeaders(answer.headers);
    const streamId = answer.streamId;
    if (streamId === null) {
      const body = request.method === "HEAD" ? null : answer.text;
      return new Response(body, { status: answer.status, headers });
    }

    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const { bytes, done } = await transport.pull(hostId, streamId, PULL_MAX_BYTES);
            if (bytes.byteLength > 0) controller.enqueue(bytes);
            if (done) controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
        cancel() {
          void transport.cancelStream(hostId, streamId);
        },
      },
      { highWaterMark: 0 }
    );
    return new Response(body, { status: answer.status, headers });
  };
}
