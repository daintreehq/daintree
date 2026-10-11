import type { HostId } from "../../../shared/types/remoteHosts.js";
import path from "node:path";
import type { HostFileRequestProxy } from "../../setup/protocols.js";
import {
  buildDaintreeFileErrorHeaders,
  buildPdfContentDisposition,
  isMediaMimeType,
  previewByteCeiling,
} from "../../setup/protocols.js";
import { AppError } from "../../utils/errorTypes.js";
import type { ClientFileTransport } from "./ClientFileTransport.js";
import { getMimeType } from "../../utils/appProtocol.js";
import { PULL_MAX_BYTES, type FileRequestPayload } from "./linkMethods.js";

const DIGITS = /^\d{1,15}$/;
const RANGE = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15}|\*)$/;
const UNSATISFIED_RANGE = /^bytes \*\/(\d{1,15})$/;

const CONFLICT = Symbol("conflicting header");

/**
 * One header from a host's answer, by name in any case: its value, null when
 * absent or empty, or {@link CONFLICT} when two spellings disagree.
 */
function headerValue(
  headers: Record<string, string>,
  name: string
): string | null | typeof CONFLICT {
  let found: string | null = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const trimmed = String(value).trim();
    if (found !== null && found !== trimmed) return CONFLICT;
    found = trimmed;
  }
  return found ? found : null;
}

/** A `content-range` that names real bytes: start ≤ end, and end inside the total when one is given. */
function validRange(value: string | null): { start: number; end: number } | null {
  const match = value ? RANGE.exec(value) : null;
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (start > end || (total !== null && end >= total)) return null;
  return { start, end };
}

/** The `content-range` a 416 carries (the file's size, with no range), or null. */
export function unsatisfiedRange(headers: Record<string, string>): string | null {
  const value = headerValue(headers, "content-range");
  return typeof value === "string" && UNSATISFIED_RANGE.test(value) ? value : null;
}

/**
 * This machine's response headers for a file the host served under `scheme`
 * with `status` (200 or 206), or null when the host's length or range
 * headers don't add up. Only the length and which bytes the body carries are
 * taken from the host; the type, CSP and the rest are this machine's, the
 * same a local preview gets, so a host can't turn a "PDF" or an image into a
 * page that runs script.
 */
export function shellFileHeaders(
  scheme: FileRequestPayload["scheme"],
  filePath: string,
  status: number,
  hostHeaders: Record<string, string>
): Headers | null {
  const out = new Headers({
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  if (scheme === "daintree-pdf") {
    out.set("Content-Type", "application/pdf");
    out.set("Content-Disposition", buildPdfContentDisposition(path.posix.basename(filePath)));
    out.set("Referrer-Policy", "no-referrer");
  } else {
    out.set("Content-Type", getMimeType(filePath));
    out.set("Content-Security-Policy", "sandbox; default-src 'none'");
  }
  const length = headerValue(hostHeaders, "content-length");
  const rangeHeader = headerValue(hostHeaders, "content-range");
  if (length === CONFLICT || rangeHeader === CONFLICT) return null;
  if (length !== null) {
    if (!DIGITS.test(length)) return null;
    out.set("Content-Length", length);
  }
  if (status === 206) {
    const range = validRange(rangeHeader);
    if (range === null) return null;
    const rangeLength = range.end - range.start + 1;
    if (length !== null && Number(length) !== rangeLength) return null;
    // The range says how many bytes come; held to that even when the host gives no length.
    out.set("Content-Length", String(rangeLength));
    out.set("Content-Range", rangeHeader!);
  } else if (rangeHeader !== null) {
    return null;
  }
  const acceptRanges = headerValue(hostHeaders, "accept-ranges");
  if (acceptRanges === "bytes" || acceptRanges === "none") out.set("Accept-Ranges", acceptRanges);
  return out;
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: buildDaintreeFileErrorHeaders() });
}

export interface HostFileProxyViews {
  /** The view a preview capability was minted for, while that view lives. */
  viewForCapability(capability: string): number | null;
  /** The host a view is bound to, or null for a local view. */
  hostForView(webContentsId: number): HostId | null;
}

/**
 * Answer a remote window's `daintree-file|media|pdf://host/<hostId>/<cap>/…`
 * request from that host, under the authority of the one view whose capability
 * the URL carries (a protocol request names no sender of its own). The host
 * runs its own handler and the body arrives in verified slices, pulled only as
 * fast as the consumer reads, so a large video costs a slice of memory here,
 * never the file.
 */
export function createHostFileProxy(
  transport: ClientFileTransport,
  views: HostFileProxyViews
): HostFileRequestProxy {
  return async (scheme, { hostId, viewCapability }, request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return plain(405, "Method Not Allowed");
    }
    const webContentsId = viewCapability === null ? null : views.viewForCapability(viewCapability);
    if (webContentsId === null || views.hostForView(webContentsId) !== hostId) {
      return plain(403, "Forbidden");
    }
    const url = new URL(request.url);
    const filePath = url.searchParams.get("path");
    const rootPath = url.searchParams.get("root");
    if (!filePath || !rootPath) return plain(400, "Missing path or root parameter");
    // The same refusals a local preview makes, from the requested path, before asking the host.
    if (scheme === "daintree-media" && !isMediaMimeType(getMimeType(filePath))) {
      return plain(404, "Not Found");
    }
    if (scheme === "daintree-pdf" && !/\.pdf$/i.test(filePath)) {
      return plain(415, "Unsupported Media Type");
    }

    let answer;
    try {
      answer = await transport.request(
        hostId,
        {
          scheme,
          path: filePath,
          root: rootPath,
          method: request.method,
          range: request.headers.get("range"),
        },
        webContentsId
      );
    } catch (error) {
      const code = error instanceof AppError ? error.code : null;
      return code === "HOST_DISCONNECTED" || code === "HOST_VERSION_MISMATCH"
        ? plain(503, "Host not connected")
        : plain(502, "Bad Gateway");
    }

    const streamId = answer.streamId;
    const refuse = (status: number, text: string) => {
      if (streamId !== null) void transport.cancelStream(hostId, streamId);
      return plain(status, request.method === "HEAD" ? "" : text);
    };

    if (answer.status >= 400) {
      const failed = refuse(answer.status, answer.text ?? "Error");
      // A 416 says how long the file is, so a player can ask again.
      const range = answer.status === 416 ? unsatisfiedRange(answer.headers) : null;
      if (range) failed.headers.set("Content-Range", range);
      return failed;
    }
    // A preview is the file or a range of it: nothing else a host answers is passed on.
    if (answer.status !== 200 && answer.status !== 206) return refuse(502, "Bad Gateway");
    const headers = shellFileHeaders(scheme, filePath, answer.status, answer.headers);
    if (headers === null) return refuse(502, "Bad Gateway");
    const declared = headers.has("Content-Length") ? Number(headers.get("Content-Length")) : null;
    const ceiling = previewByteCeiling(scheme, filePath);
    if (ceiling !== null && declared !== null && declared > ceiling) {
      return refuse(413, "Payload Too Large");
    }
    if (request.method === "HEAD") {
      if (streamId !== null) void transport.cancelStream(hostId, streamId);
      return new Response(null, { status: answer.status, headers });
    }
    // File bytes only ever arrive as a stream: a successful GET without one is
    // refused, except an empty file, which a local preview answers with no body too.
    if (streamId === null) {
      if (answer.status === 200 && declared === 0) {
        return new Response(null, { status: 200, headers });
      }
      return plain(502, "Bad Gateway");
    }

    // Never more than the host said it would send, nor than a local preview may be.
    const limit = Math.min(declared ?? Infinity, ceiling ?? Infinity);
    let received = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const { bytes, done } = await transport.pull(hostId, streamId, PULL_MAX_BYTES);
            received += bytes.byteLength;
            if (received > limit) throw new Error("The host sent more than the preview allows");
            if (bytes.byteLength > 0) controller.enqueue(bytes);
            if (done) {
              if (declared !== null && received !== declared) {
                throw new Error("The host sent less than it said it would");
              }
              controller.close();
            }
          } catch (error) {
            void transport.cancelStream(hostId, streamId);
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
